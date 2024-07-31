'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const axios = require('axios');
const moment = require('moment-timezone');
const {
  getLbnToken,
  modifyTime,
  getShipmentData,
  getDocsFromWebsli,
  sendSESEmail,
} = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

const bioRadCustomerIds = process.env.BIO_RAD_BILL_TO_NUMBERS.split(',');
const dynamoData = {};

module.exports.handler = async (event, context) => {
  try {
    console.info('Event: ', event);

    const record = get(event, 'Records[0]', []);
    let headerData;
    let referencesData;
    let freightOrderId;
    let orderNo;
    let invoiceSeqNo;
    try {
      console.info('record: ', record);

      const cstDate = moment().tz('America/Chicago');
      dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
      dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
      dynamoData.Event = record;
      dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
      console.info('🚀 -> file: index.js:38 -> get -> Log Id:', get(dynamoData, 'Id', ''));
      dynamoData.Process = get(CONSTANTS, 'shipmentProcess.sendBillingInvoice', '');

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
      invoiceSeqNo = get(newImage, 'InvoiceSeqNo', '');
      dynamoData.OrderNo = orderNo;
      dynamoData.InvoiceSeqNo = invoiceSeqNo;
      const verifyShipmentData = await verifyShipment(orderNo, invoiceSeqNo);
      freightOrderId = get(verifyShipmentData, 'freightOrderId', '');
      headerData = get(verifyShipmentData, 'headerData', []);
      referencesData = get(verifyShipmentData, 'referencesData', []);

      dynamoData.FreightOrderId = freightOrderId;

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
        freightOrderId,
        invoiceSeqNo
      );
      console.info('payload: ', JSON.stringify(payload));
      if (get(payload, 'attachments[0].fileContentBinaryObject', '') === '') {
        throw new Error(
          `Invoice document not found for housebill: ${get(payload, 'carrierInvoiceID', '')}.`
        );
      }
      const token = await getLbnToken();
      dynamoData.Payload = await sendBillingInvoiceLbn(token, payload);
      dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
      await putLogItem(dynamoData);
    } catch (error) {
      console.error('Error for orderNo: ', orderNo, error);

      let errorMsgVal = '';
      if (get(error, 'message', null) !== null) {
        errorMsgVal = get(error, 'message', '');
      } else {
        errorMsgVal = error;
      }
      let flag = get(errorMsgVal.split(','), '[0]', '');
      if (flag !== 'SKIPPING') {
        flag = get(CONSTANTS, 'statusVal.failed', '');
        try {
          await sendSESEmail({
            message: `
                  <!DOCTYPE html>
                  <html>
                  <head>
                    <style>
                      body {
                        font-family: Arial, sans-serif;
                      }
                      .container {
                        padding: 20px;
                        border: 1px solid #ddd;
                        border-radius: 5px;
                        background-color: #f9f9f9;
                      }
                      .highlight {
                        font-weight: bold;
                      }
                    </style>
                  </head>
                  <body>
                    <div class="container">
                      <p>Dear Team,</p>
                      <p>We have an error while sending the billing invoice:</p>
                      <p><span class="highlight">Error details:</span> <strong>${errorMsgVal}</strong><br>
                         <span class="highlight">ID:</span> <strong>${get(dynamoData, 'Id', '')}</strong><br>
                         <span class="highlight">Freight Order Id:</span> <strong>${get(dynamoData, 'FreightOrderId', '')}</strong><br>
                      <p><span class="highlight">Function:</span>${context.functionName}</p>
                      <p><span class="highlight">Note:</span>Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.</p>
                      <p>Thank you,<br>
                      Omni Automation System</p>
                      <p style="font-size: 0.9em; color: #888;">Note: This is a system generated email, Please do not reply to this email.</p>
                    </div>
                  </body>
                  </html>
                `,
            subject: `Bio Rad Send Billing Invoice ${process.env.STAGE} ERROR`,
          });
          console.info('Notification has been sent');
        } catch (err) {
          console.info(
            '🚀 -> file: index.js:133 -> get -> Error while sending error notification:',
            err
          );
        }
      } else {
        errorMsgVal = get(errorMsgVal.split(','), '[1]', '');
      }
      dynamoData.ErrorMsg = errorMsgVal;
      dynamoData.Status = flag;
      await putLogItem(dynamoData);
    }
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: get(CONSTANTS, 'statusVal.success', ''),
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
          message: 'Failed',
        },
        null,
        2
      ),
    };
  }
};

async function preparePayload(newImage, headerData, referencesData, freightOrderId, invoiceSeqNo) {
  try {
    const aparParams = {
      TableName: process.env.SHIPMENT_APAR_TABLE,
      KeyConditionExpression: 'FK_OrderNo = :PK_OrderNo',
      FilterExpression: 'APARCode = :APARCode AND InvoiceSeqNo = :InvoiceSeqNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': get(newImage, 'FK_OrderNo', ''),
        ':APARCode': 'C',
        ':InvoiceSeqNo': invoiceSeqNo,
      },
    };
    const aparData = await getData(aparParams);
    console.info('apar data: ', aparData);
    const grossAmount = aparData
      .filter((obj) => obj.InvoiceSeqNo === get(newImage, 'InvoiceSeqNo', ''))
      .reduce((sum, item) => sum + Number(get(item, 'Total', 0)), 0);
    dynamoData.GrossAmount = grossAmount;
    if (grossAmount <= 0) {
      throw new Error(
        `SKIPPING, This bill doesn't have any charges or charges are in negative: ${freightOrderId}`
      );
    }

    console.info('reference data: ', referencesData);
    const purchasingParty = get(
      referencesData.find(
        (obj) => get(obj, 'CustomerType') === 'B' && get(obj, 'FK_RefTypeId') === 'STP'
      ),
      'ReferenceNo',
      ''
    );

    const shipmentData = await getShipmentData(freightOrderId);
    console.info('orderingPartyLbnId: ', get(shipmentData, '[0].OrderingPartyLbnId', ''));
    console.info('carrierLbnId: ', get(shipmentData, '[0].CarrierPartyLbnId', ''));
    console.info(
      'billFromParty: ',
      get(shipmentData, '[0].CarrierSourceSystemBusinessPartnerID', '')
    );
    console.info('senderSystemId: ', get(shipmentData, '[0].OriginatorId', ''));

    const pricingElementsArray = aparData.filter((obj) => obj.Finalize === 'Y');
    const pricingElements = [];
    await Promise.all(
      pricingElementsArray.map(async (element) => {
        let lbnChargeCode;
        if (get(element, 'ChargeCode', '') === 'FRT') {
          if (get(element, 'FK_ServiceLevelId', '') === 'HS') {
            lbnChargeCode = get(CONSTANTS, 'billingInvoiceCodes.FTL', '');
          } else {
            lbnChargeCode = get(CONSTANTS, 'billingInvoiceCodes.LTL', '');
          }
        } else {
          lbnChargeCode = get(
            CONSTANTS,
            `billingInvoiceCodes.${get(element, 'ChargeCode', '')}`,
            ''
          );
        }
        if (Number(get(element, 'Total', 0)) !== 0) {
          pricingElements.push({
            lbnChargeCode,
            rateAmount: Number(get(element, 'Total', 0)),
            rateAmountCurrency: 'USD',
            finalAmount: Number(get(element, 'Total', 0)),
            finalAmountCurrency: 'USD',
          });
        }
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
      billFromParty: get(shipmentData, '[0].CarrierSourceSystemBusinessPartnerID', ''),
      senderSystemId: get(shipmentData, '[0].OriginatorId', ''),
      items: [
        {
          grossAmount,
          grossAmountCurrency: 'USD',
          freightDocumentID: freightOrderId,
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

async function verifyShipment(orderNo, invoiceSeqNo) {
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
      return {
        validShipmentFlag: false,
        headerData,
        referencesData,
        freightOrderId,
        shipmentData: {},
      };
    }

    const Params = {
      TableName: process.env.LOGS_TABLE,
      IndexName: 'FreightOrderId-Index',
      KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
      FilterExpression:
        '#status = :status AND #process = :process AND InvoiceSeqNo = :InvoiceSeqNo',
      ExpressionAttributeNames: {
        '#status': 'Status',
        '#process': 'Process',
      },
      ExpressionAttributeValues: {
        ':FreightOrderId': freightOrderId,
        ':status': get(CONSTANTS, 'statusVal.success', ''),
        ':process': get(CONSTANTS, 'shipmentProcess.sendBillingInvoice', ''),
        ':InvoiceSeqNo': invoiceSeqNo,
      },
    };

    const Result = await getData(Params);
    console.info(Result);
    if (Result.length > 0) {
      throw new Error(
        `SKIPPING, Invoice already sent for this freight order Id: ${freightOrderId}`
      );
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
