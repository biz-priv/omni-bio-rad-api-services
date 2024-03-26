'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const axios = require('axios');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem } = require('../shared/dynamo');
const { xmlJsonConverter, connectToSQLServer } = require('../shared/dataHelper');
const {
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
} = require('./dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(event);

  try {
    const eventBody = get(event, 'body', {});

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = event;
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'CANCEL';
    dynamoData.XmlPayload = {};
    dynamoData.FreightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'orderingPartyLbnId', '');
    dynamoData.OriginatorId = get(eventBody, 'originatorId', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrierPartyLbnId', '');
    dynamoData.CallInPhone = `${get(eventBody, 'orderingParty.address.phoneNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.phoneNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.phoneNumber.subscriberId', '')}`;
    dynamoData.CallInFax = `${get(eventBody, 'orderingParty.address.faxNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.faxNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.faxNumber.subscriberId', '')}`;
    dynamoData.QuoteContactEmail = get(eventBody, 'orderingParty.address.emailAddress', '');

    console.info(dynamoData.CSTDateTime);

    const headerData = await prepareHeaderData(eventBody);
    console.info(headerData);

    const transportationStages = get(eventBody, 'transportationStages', []);
    const items = get(eventBody, 'items', []);

    // Prepare payload and create shipments in world trak.
    const apiResponses = await Promise.all(
      transportationStages.map(async (stage) => {
        try {
          const shipperAndConsignee = await prepareShipperAndConsigneeData(stage);
          console.info(shipperAndConsignee);

          const referenceList = await prepareReferenceList(stage, eventBody);
          console.info(JSON.stringify(referenceList));

          const shipmentLineList = await prepareShipmentLineListDate(
            items,
            get(stage, 'assignedItems', [])
          );
          console.info(JSON.stringify(shipmentLineList));

          const dateValues = await prepareDateValues(stage);
          console.info(dateValues);

          const xmlPayload = await prepareWTPayload(
            headerData,
            shipperAndConsignee,
            referenceList,
            shipmentLineList,
            dateValues
          );
          console.info(xmlPayload);

          const xmlResponse = await sendToWT(xmlPayload);

          const xmlObjResponse = await xmlJsonConverter(xmlResponse);

          if (
            get(
              xmlObjResponse,
              'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ErrorMessage',
              ''
            ) !== '' ||
            get(
              xmlObjResponse,
              'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
              ''
            ) === ''
          ) {
            throw new Error(
              `WORLD TRAK API call failed: ${get(
                xmlObjResponse,
                'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ErrorMessage',
                ''
              )}`
            );
          }

          const housebill = get(
            xmlObjResponse,
            'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
            ''
          );
          const fileNumber = get(
            xmlObjResponse,
            'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ShipQuoteNo',
            ''
          );
          return { housebill, fileNumber };
        } catch (error) {
          console.info('Error in transportation Stage');
          return [stage, 'Failed'];
        }
      })
    );
    console.info(apiResponses);

    const eventArray = ['sendToLbn'];
    await Promise.all(
      eventArray.map(async (eventType) => {
        await sendToLbnAndUpdateInSourceDb(eventType, apiResponses);
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          Message: 'Success',
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error('Main handler error: ', error);

    let errorMsgVal = '';
    if (get(error, 'message', null) !== null) {
      errorMsgVal = get(error, 'message', '');
    } else {
      errorMsgVal = error;
    }
    const flag = errorMsgVal.split(',')[0];
    if (flag !== 'Error') {
      const params = {
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${'log table'} for understanding the complete data.`,
        Subject: `Bio Rad Cancel Shipment ERROR ${context.functionName}`,
        TopicArn: process.env.NOTIFICATION_ARN,
      };
      try {
        await sns.publish(params).promise();
        console.info('SNS notification has sent');
      } catch (err) {
        console.error('Error while sending sns notification: ', err);
      }
    } else {
      errorMsgVal = errorMsgVal.split(',').slice(1);
    }
    dynamoData.ErrorMsg = errorMsgVal;
    dynamoData.Status = 'FAILED';
    await putLogItem(dynamoData);
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
          message: error,
        },
        null,
        2
      ),
    };
  }
};

async function sendToWT(postData) {
  try {
    const config = {
      url: process.env.WT_URL,
      method: 'post',
      headers: {
        'Content-Type': 'text/xml',
        'soapAction': 'http://tempuri.org/AddNewShipmentV3',
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`WORLD TRAK API Request Failed: ${res}`);
  } catch (error) {
    console.error('WORLD TRAK API Request Failed: ', error);
    throw error;
  }
}

async function sendToLbnAndUpdateInSourceDb(eventType, responses) {
  try {
    if (eventType === 'updateDb') {
      const fileNumberArray = responses.map((obj) => obj.fileNumber);
      console.info('fileNumberArray: ', fileNumberArray);

      const updateQuery = `update tbl_shipmentheader set
      CallInPhone=${get(dynamoData, 'CallInPhone', '')},
      CallInFax=${get(dynamoData, 'CallInFax', '')},
      QuoteContactEmail=${get(dynamoData, 'QuoteContactEmail', '')}
      where fk_orderno in (${fileNumberArray.join(',')});`;

      console.info('getQuery: ', updateQuery);
      const request = await connectToSQLServer();
      const result = await request.query(updateQuery);
      console.info(result);
    } else {
      const token = await getLbnToken();
      const businessDocumentReferences = responses.map((response) => {
        return {
          documentId: get(response, 'housebill', ''),
          documentTypeCode: 'T51',
        };
      });
      const payload = {
        carrierPartyLbnId: get(dynamoData, 'CarrierPartyLbnId', ''),
        confirmationStatus: 'CN',
        businessDocumentReferences,
      };

      console.info('lbn send Payload: ', JSON.stringify(payload));
      await sendToLbn(token, payload);
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function getLbnToken() {
  try {
    const config = {
      maxBodyLength: Infinity,
      url: process.env.LBN_TOKEN_URL,
      method: 'post',
      headers: {
        Username: process.env.LBN_TOKEN_USERNAME,
        Password: process.env.LBN_TOKEN_PASSWORD,
        Authorization: process.env.LBN_TOKEN_AUTHORIZATION,
      },
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data.access_token', '');
    }
    throw new Error(`Lbn token API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn token API Request Failed: ', error);
    throw error;
  }
}

async function sendToLbn(token, payload) {
  try {
    const config = {
      url: `${process.env.LBN_SEND_URL}/${get(dynamoData, 'OrderingPartyLbnId')}/${get(dynamoData, 'OriginatorId')}/${get(dynamoData, 'FreightOrderId')}/carrierResponse`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      data: payload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Lbn main API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn main API Request Failed: ', error);
    throw error;
  }
}
