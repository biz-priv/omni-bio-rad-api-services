'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const axios = require('axios');
const moment = require('moment-timezone');
const {
  getLbnToken,
  fetchTackingData,
  modifyTime,
  getShipmentData,
  getDocsFromWebsli,
} = require('../Shared/dataHelper');

const sns = new AWS.SNS();
const bioRadCustomerIds = process.env.BIO_RAD_BILL_TO_NUMBERS.split(',');

module.exports.handler = async (event, context) => {
  try {
    console.info('Event: ', event);

    await Promise.all(
      get(event, 'Records', []).map(async (record) => {
        let headerData;
        let referencesData;
        let freightOrderId;
        let orderNo;
        const dynamoData = {};
        try {
          console.info('record: ', record);

          const cstDate = moment().tz('America/Chicago');
          dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
          dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
          dynamoData.Event = record;
          dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
          dynamoData.Process = 'SEND_BILLING_INVOICE';

          const recordBody = JSON.parse(get(record, 'body', {}));
          const message = JSON.parse(get(recordBody, 'Message', ''));

          const newImage = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
          if (
            get(newImage, 'PostedDateTime', '').includes('1900') ||
            get(newImage, 'PostedDateTime', '') === '' ||
            get(newImage, 'PostedDateTime', '') === null
          ) {
            console.info('SKIPPING, This shipment is not yet posted');
            throw new Error('SKIPPING, This shipment is not yet posted');
          }
          orderNo = get(newImage, 'FK_OrderNo', '');
          const verifyShipmentData = await verifyShipment(get(newImage, 'FK_OrderNo', ''));
          freightOrderId = get(verifyShipmentData, 'freightOrderId', '');
          headerData = get(verifyShipmentData, 'headerData', []);
          referencesData = get(verifyShipmentData, 'referencesData', []);

          dynamoData.FreightOrderId = freightOrderId;
          dynamoData.OrderNo = orderNo;

          if (!get(verifyShipmentData, 'validShipmentFlag', false)) {
            console.info(
              'SKIPPING, This shipment is not valid to process the shipment(either this is not belong to bio rad or freight order id is missing).'
            );
            throw new Error(
              'SKIPPING, This shipment is not valid to process the shipment(either this is not belong to bio rad or freight order id is missing).'
            );
          }
          const payload = await preparePayload(
            newImage,
            headerData,
            referencesData,
            freightOrderId
          );
          console.info('payload: ', JSON.stringify(payload));
          const token = await getLbnToken();
          dynamoData.Payload = await sendBillingInvoiceLbn(token, payload);
          dynamoData.Status = 'SUCCESS';
          await putLogItem(dynamoData);
        } catch (error) {
          console.error('Error for orderNo: ', orderNo);

          let errorMsgVal = '';
          if (get(error, 'message', null) !== null) {
            errorMsgVal = get(error, 'message', '');
          } else {
            errorMsgVal = error;
          }
          let flag = get(errorMsgVal.split(','), '[0]', '');
          if (flag !== 'SKIPPING') {
            flag = 'ERROR';
            const params = {
              Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nFileNumber: ${orderNo}. \n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
              Subject: `Bio Rad Send Billing Invoice ERROR ${context.functionName}`,
              TopicArn: process.env.NOTIFICATION_ARN,
            };
            try {
              await sns.publish(params).promise();
              console.info('SNS notification has sent');
            } catch (err) {
              console.error('Error while sending sns notification: ', err);
            }
          } else {
            errorMsgVal = get(errorMsgVal.split(','), '[1]', '');
          }
          dynamoData.ErrorMsg = errorMsgVal;
          dynamoData.Status = flag;
          await putLogItem(dynamoData);
        }
      })
    );
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: 'SUCCESS',
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error('Main handler error: ', error);

    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          message: 'FAILED',
        },
        null,
        2
      ),
    };
  }
};

async function preparePayload(newImage, headerData, referencesData, freightOrderId) {
  try {
    const aparParams = {
      TableName: process.env.SHIPMENT_APAR_TABLE,
      KeyConditionExpression: 'FK_OrderNo = :PK_OrderNo',
      FilterExpression: 'APARCode = :APARCode',
      ExpressionAttributeValues: {
        ':PK_OrderNo': get(newImage, 'FK_OrderNo', ''),
        ':APARCode': 'C',
      },
    };
    const aparData = await getData(aparParams);
    console.info('apar data: ', aparData);
    const grossAmount = aparData
      .filter((obj) => obj.InvoiceSeqNo === get(newImage, 'InvoiceSeqNo', ''))
      .reduce((sum, item) => sum + Number(get(item, 'Total', 0)), 0);

    const trackingData = await fetchTackingData(get(newImage, 'FK_OrderNo', ''));
    console.info('tracking data: ', trackingData);

    console.info('reference data: ', referencesData);
    const purchasingParty = get(
      referencesData.find(
        (obj) => get(obj, 'CustomerType') === 'B' && get(obj, 'FK_RefTypeId') === 'STP'
      ),
      'ReferenceNo',
      ''
    );

    const transportationStageID = get(
      referencesData.find(
        (obj) => get(obj, 'CustomerType') === 'S' && get(obj, 'FK_RefTypeId') === 'DL#'
      ),
      'ReferenceNo',
      ''
    );

    const shipmentData = await getShipmentData(freightOrderId);

    const pricingElementsArray = aparData.filter((obj) => obj.Finalize === 'Y');
    const pricingElements = await Promise.all(
      pricingElementsArray.map(async (element) => {
        return {
          lbnChargeCode: 'BASE_LTL_FLAT',
          rateAmount: get(element, 'Total', 0),
          rateAmountCurrency: 'USD',
          finalAmount: get(element, 'Total', 0),
          finalAmountCurrency: 'USD',
        };
      })
    );

    const carrierInvoiceID = `${get(headerData, '[0].ControllingStation', '') + get(headerData, '[0].Housebill', '')}-${get(newImage, 'InvoiceSeqNo', '').padStart(2, '0')}`;

    const docData = await getDocsFromWebsli({
      housebill: carrierInvoiceID,
      doctype: 'doctype=BI',
    });

    const attachments = [
      {
        fileName: get(docData, '[0].filename', ''),
        mimeType: 'application/pdf',
        fileContentBinaryObject: get(docData, '[0].b64str', ''),
      },
    ];
    const payload = {
      carrierInvoiceID,
      invoiceDate: await modifyTime(get(newImage, 'InvPrintedDate', '')),
      grossAmount,
      grossAmountCurrency: 'USD',
      orderingPartyLbnId: get(shipmentData, '[0].OrderingPartyLbnId', ''),
      carrierLbnId: get(shipmentData, '[0].CarrierPartyLbnId', ''),
      baseDocumentType: '1122',
      purchasingParty,
      billFromParty: get(shipmentData, '[0].SourceSystemBusinessPartnerID', ''),
      senderSystemId: get(trackingData, 'Note', '').substring(46, 56),
      items: [
        {
          grossAmount,
          grossAmountCurrency: 'USD',
          freightDocumentID: freightOrderId,
          transportationStageID,
          pricingElements,
        },
      ],
      attachments,
    };

    return payload;
  } catch (error) {
    console.info(error);
    throw error;
  }
}

async function verifyShipment(orderNo) {
  try {
    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': orderNo,
      },
    };
    const headerData = await getData(headerParams);
    console.info('header data: ', headerData);
    if (!bioRadCustomerIds.includes(get(headerData, '[0].BillNo'))) {
      console.info('This event is not related to bio rad. So, skipping the process.');
      return false;
    }

    const referencesParams = {
      TableName: process.env.REFERENCE_TABLE,
      IndexName: `omni-wt-rt-ref-orderNo-index-${process.env.STAGE}`,
      KeyConditionExpression: 'FK_OrderNo = :FK_OrderNo',
      ExpressionAttributeValues: {
        ':FK_OrderNo': orderNo,
      },
    };
    const referencesData = await getData(referencesParams);
    console.info('references data: ', referencesData);
    const freightOrderId = get(
      referencesData.find(
        (obj) => get(obj, 'CustomerType') === 'B' && get(obj, 'FK_RefTypeId') === 'SID'
      ),
      'ReferenceNo',
      ''
    );
    if (freightOrderId === '') {
      return { validShipmentFlag: false, headerData, referencesData, freightOrderId };
    }

    return { validShipmentFlag: true, headerData, referencesData, freightOrderId };
  } catch (error) {
    console.info(error);
    throw error;
  }
}

async function sendBillingInvoiceLbn(token, payload) {
  try {
    const config = {
      url: process.env.LBN_BILLING_INVOICE_URL,
      method: 'post',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': token,
      },
      data: payload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    console.info('res: ', res);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Lbn main API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn main API Request Failed: ', error);
    throw new Error(`Lbn main API Request Failed: ${error}`);
  }
}
