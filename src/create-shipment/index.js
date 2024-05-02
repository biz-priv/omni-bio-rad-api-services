'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const axios = require('axios');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem } = require('../Shared/dynamo');
const { xmlJsonConverter, querySourceDb } = require('../Shared/dataHelper');
const {
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
  groupItems,
  getServiceLevel,
  CONSTANTS,
} = require('./dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(event);

  try {
    const eventBody = JSON.parse(get(event, 'body', {}));

    // const eventBody = get(event, 'body', {});

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = get(event, 'body', '');
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'CREATE';
    dynamoData.FreightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'orderingPartyLbnId', '');
    dynamoData.OriginatorId = get(eventBody, 'originatorId', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrierPartyLbnId', '');
    dynamoData.CallInPhone = `${get(eventBody, 'orderingParty.address.phoneNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.phoneNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.phoneNumber.subscriberId', '')}`;
    dynamoData.CallInFax = `${get(eventBody, 'orderingParty.address.faxNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.faxNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.faxNumber.subscriberId', '')}`;
    dynamoData.QuoteContactEmail = get(eventBody, 'orderingParty.address.emailAddress', '');
    dynamoData.XmlPayload = {};

    if (
      get(dynamoData, 'FreightOrderId', '') === '' ||
      get(dynamoData, 'OrderingPartyLbnId', '') === '' ||
      get(dynamoData, 'CarrierPartyLbnId', '') === ''
    ) {
      throw new Error(
        'Error, FreightOrderId or OrderingPartyLbnId or CarrierPartyLbnId is missing in the request, please add the details in the request.'
      );
    }
    console.info(dynamoData.CSTDateTime);

    const headerData = await prepareHeaderData(eventBody);
    console.info(headerData);

    const transportationStages = get(eventBody, 'transportationStages', []);
    const items = get(eventBody, 'items', []);

    // group the items to understand how many shipments were exist in the request.
    const groupedItems = await groupItems(items);
    console.info(groupedItems);
    const groupedItemKeys = Object.keys(groupedItems);

    // Prepare all the payloads at once(which helps in multi shipment scenario)
    const wtPayloadsData = await Promise.all(
      groupedItemKeys.map(async (key) => {
        const loadingStage = transportationStages.find(
          (obj) => get(obj, 'loadingLocation.id', '') === key.split('-')[0]
        );
        const unloadingStage = transportationStages.find(
          (obj) => get(obj, 'unloadingLocation.id', '') === key.split('-')[1]
        );
        const stage = transportationStages.find(
          (obj) =>
            get(obj, 'loadingLocation.id', '') === key.split('-')[0] &&
            get(obj, 'unloadingLocation.id', '') === key.split('-')[1]
        );
        console.info(loadingStage.loadingLocation.id);
        console.info(unloadingStage.unloadingLocation.id);
        console.info(stage);
        let serviceLevel = '';
        if (Number(get(eventBody, 'shippingTypeCode', 0)) === 18) {
          serviceLevel = 'HS';
        } else if (!stage) {
          serviceLevel = await getServiceLevel(
            transportationStages,
            get(loadingStage, 'loadingLocation.id', ''),
            get(unloadingStage, 'unloadingLocation.id', ''),
            'multiple'
          );
        } else if (get(stage, 'totalDuration.value', '') !== '') {
          const totalDuration = moment.duration(get(stage, 'totalDuration.value', '')).asHours();
          if (totalDuration === 0) {
            serviceLevel = 'ND';
          } else if (totalDuration > 120) {
            serviceLevel = 'E7';
          } else {
            const serviceLevelValue = get(CONSTANTS, 'serviceLevel', []).find(
              (obj) => totalDuration > obj.min && totalDuration <= obj.max
            );
            serviceLevel = get(serviceLevelValue, 'value', '');
          }
        } else {
          throw new Error(
            `Cannot get the total duration from the connecting stages, please provide the total duration for this shipment from ${get(loadingStage, 'loadingLocation.id', '')} to ${get(unloadingStage, 'unloadingLocation.id', '')}`
          );
        }
        const shipperAndConsignee = await prepareShipperAndConsigneeData(
          loadingStage,
          unloadingStage
        );
        console.info(shipperAndConsignee);

        const referenceList = await prepareReferenceList(loadingStage, unloadingStage, eventBody);
        console.info(JSON.stringify(referenceList));

        const shipmentLineList = await prepareShipmentLineListDate(get(groupedItems, key, []));
        console.info(JSON.stringify(shipmentLineList));

        const dateValues = await prepareDateValues(
          loadingStage,
          unloadingStage,
          transportationStages
        );
        console.info(dateValues);

        const payloads = await prepareWTPayload(
          headerData,
          shipperAndConsignee,
          referenceList,
          shipmentLineList,
          dateValues,
          serviceLevel
        );
        console.info(payloads);
        dynamoData[key] = payloads;
        return { ...payloads, stopId: key };
      })
    );
    console.info(wtPayloadsData);
    const apiResponses = [];

    // Send the payloads to world trak for shipment creation one by one as it doesn't allow conurrent executions.
    for (const data of wtPayloadsData) {
      const xmlResponse = await sendToWT(get(data, 'xmlPayload'));

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

      dynamoData.XmlPayload[get(data, 'stopId')] = data;
      dynamoData.XmlPayload[get(data, 'stopId')].housebill = housebill;
      dynamoData.XmlPayload[get(data, 'stopId')].fileNumber = fileNumber;
      dynamoData.XmlPayload[get(data, 'stopId')].XmlResponse = xmlResponse;
      apiResponses.push({ housebill, fileNumber });
    }
    console.info(apiResponses);
    dynamoData.ShipmentData = apiResponses;
    dynamoData.FileNumber = apiResponses.map((obj) => obj.fileNumber);
    dynamoData.Housebill = apiResponses.map((obj) => obj.fileNumber);

    // send back the created shipment to LBN(which is customers endpoint) and update couple of fields in source Db.
    const eventArray = ['sendToLbn', 'updateDb'];
    await Promise.all(
      eventArray.map(async (eventType) => {
        await sendToLbnAndUpdateInSourceDb(eventType, apiResponses);
      })
    );

    dynamoData.Status = 'SUCCESS';
    await putLogItem(dynamoData);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
          message: 'Success',
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
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
        Subject: `Bio Rad Create Shipment ERROR ${context.functionName}`,
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
          message: errorMsgVal,
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
    throw new Error(`WORLD TRAK API Request Failed: ${error}`);
  }
}

async function sendToLbnAndUpdateInSourceDb(eventType, responses) {
  try {
    if (eventType === 'updateDb') {
      const fileNumberArray = responses.map((obj) => obj.fileNumber);
      console.info('fileNumberArray: ', fileNumberArray);

      const updateQuery = `update tbl_shipmentheader set
      CallInPhone='${get(dynamoData, 'CallInPhone', '')}',
      CallInFax='${get(dynamoData, 'CallInFax', '')}',
      QuoteContactEmail='${get(dynamoData, 'QuoteContactEmail', '')}'
      where pk_orderno in (${fileNumberArray.join(',')});`;

      console.info(updateQuery);
      const apiResult = await querySourceDb(updateQuery);
      console.info(apiResult);
    } else {
      const token = await getLbnToken();
      const businessDocumentReferences = [];

      for (const response of responses) {
        const housebill = get(response, 'housebill', '');
        const { filename, b64str } = await getDocFromWebsli({ housebill });

        businessDocumentReferences.push({
          documentId: housebill,
          documentTypeCode: 'T51',
          attachments: [
            {
              name: filename,
              mimeCode: 'application/pdf',
              fileContentBinaryObject: b64str
            }
          ]
        });
      }

      const payload = {
        carrierPartyLbnId: get(dynamoData, 'CarrierPartyLbnId', ''),
        confirmationStatus: 'CN',
        businessDocumentReferences,
      };

      dynamoData.LbnPayload = payload

      console.info('lbn send Payload: ', JSON.stringify(payload));
      await sendToLbn(token, payload);
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function getDocFromWebsli({ housebill }) {
  try {
    const url = `https://websli.omnilogistics.com/wtTest/getwtdoc/v1/json/8495facb3355d4aab0197eadf1f484/housebill=${housebill}/doctype=HOUSEBILL|doctype=LABEL`;
    const queryType = await axios.get(url);
    console.info('🚀 ~ file: index.js:327 ~ getDocFromWebsli ~ url:', url)
    const { filename, b64str } = get(queryType, 'data.wtDocs.wtDoc[0]', {});
    return { filename, b64str };
  } catch (error) {
    console.info('🙂 -> file: pod-doc-sender.js:207 -> getDocFromWebsli -> error:', error);
    const message = get(error, 'response.data', '');
    console.error('error while calling websli endpoint: ', message === '' ? error.message : message);
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
    throw new Error(`Lbn token API Request Failed: ${error}`);
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
    throw new Error(`Lbn main API Request Failed: ${error}`);
  }
}
