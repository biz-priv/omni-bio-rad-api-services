'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const uuid = require('uuid');
const axios = require('axios');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const {
  xmlJsonConverter,
  sendToWT,
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
  groupItems,
  getServiceLevel,
} = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(event);

  try {
    const eventBody = JSON.parse(get(event, 'body', {}));

    // const eventBody = get(event, 'body', {});

    const attachments = JSON.parse(JSON.stringify(get(eventBody, 'attachments', [])));
    console.info('attachments: ', get(eventBody, 'attachments', []));

    if (attachments.length > 0) {
      await Promise.all(
        get(eventBody, 'attachments', []).map(async (attachment) => {
          attachment.fileContentBinaryObject = 'B64String';
        })
      );
    }

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = JSON.stringify(eventBody);
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'CREATE';
    dynamoData.FreightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'orderingPartyLbnId', '');
    dynamoData.OriginatorId = get(eventBody, 'originatorId', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrierPartyLbnId', '');
    dynamoData.CallInPhone = `${get(eventBody, 'orderingParty.address.phoneNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.phoneNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.phoneNumber.subscriberId', '')}`;
    dynamoData.CallInFax = `${get(eventBody, 'orderingParty.address.faxNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.faxNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.faxNumber.subscriberId', '')}`;
    dynamoData.QuoteContactEmail = get(eventBody, 'orderingParty.address.emailAddress', '');
    dynamoData.CarrierSourceSystemBusinessPartnerID = get(
      eventBody,
      'carrier.sourceSystemBusinessPartnerID',
      ''
    );
    dynamoData.OrderingPartySourceSystemBusinessPartnerID = get(
      eventBody,
      'orderingParty.sourceSystemBusinessPartnerID',
      ''
    );
    dynamoData.ShipmentDetails = {};
    dynamoData.FileNumber = [];
    dynamoData.Housebill = [];
    dynamoData.LastUpdateEvent = [];

    if (
      get(dynamoData, 'FreightOrderId', '') === '' ||
      get(dynamoData, 'OrderingPartyLbnId', '') === '' ||
      get(dynamoData, 'CarrierPartyLbnId', '') === ''
    ) {
      throw new Error(
        'Error, FreightOrderId or OrderingPartyLbnId or CarrierPartyLbnId is missing in the request, please add the details in the request.'
      );
    } else {
      const Params = {
        TableName: process.env.LOGS_TABLE,
        IndexName: 'FreightOrderId-Index',
        KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
        FilterExpression: '#status = :status AND #process = :process',
        ExpressionAttributeNames: {
          '#status': 'Status',
          '#process': 'Process',
        },
        ExpressionAttributeValues: {
          ':FreightOrderId': get(dynamoData, 'FreightOrderId', ''),
          ':status': 'SUCCESS',
          ':process': 'CREATE',
        },
      };

      const Result = await getData(Params);
      console.info(Result);
      if (Result.length > 0) {
        throw new Error(
          `Error, Shipments already created for the provided freight order Id: ${get(dynamoData, 'FreightOrderId', '')}`
        );
      }
    }
    console.info(dynamoData.CSTDateTime);

    const headerData = await prepareHeaderData(eventBody);
    console.info(headerData);
    if (get(headerData, 'Mode', '') === 'Domestic') {
      dynamoData.ShipmentType = 'LTL';
    } else {
      dynamoData.ShipmentType = 'FTL';
    }

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
            `Error, Cannot get the total duration from the connecting stages, please provide the total duration for this shipment from ${get(loadingStage, 'loadingLocation.id', '')} to ${get(unloadingStage, 'unloadingLocation.id', '')}`
          );
        }
        const shipperAndConsignee = await prepareShipperAndConsigneeData(
          loadingStage,
          unloadingStage
        );
        console.info(shipperAndConsignee);

        const referenceList = await prepareReferenceList(loadingStage, unloadingStage, dynamoData);
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
        return { ...payloads, stopId: key };
      })
    );
    console.info(wtPayloadsData);

    // Send the payloads to world trak for shipment creation one by one as it doesn't allow conurrent executions.
    for (const data of wtPayloadsData) {
      const xmlResponse = await sendToWT(get(data, 'xmlPayload', ''));

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

      dynamoData.ShipmentDetails[get(data, 'stopId')] = data;
      dynamoData.ShipmentDetails[get(data, 'stopId')].housebill = housebill;
      dynamoData.ShipmentDetails[get(data, 'stopId')].fileNumber = fileNumber;
      dynamoData.ShipmentDetails[get(data, 'stopId')].XmlResponse = xmlResponse;
      dynamoData.FileNumber.push(fileNumber);
      dynamoData.Housebill.push(housebill);
    }

    const filteredAttachments = await attachments.filter((obj) => obj.typeCode === 'ATCMT');
    await Promise.all(
      filteredAttachments.map(async (attachment) => {
        await Promise.all(
          get(dynamoData, 'Housebill', []).map(async (housebill) => {
            const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <AttachFileToShipment xmlns="http://tempuri.org/">
              <Filename>${get(attachment, 'description', '')}</Filename>
              <FileDataBase64>${get(attachment, 'fileContentBinaryObject', '')}</FileDataBase64>
              <Housebill>${housebill}</Housebill>
              <CustomerAccess>Yes</CustomerAccess>
              <DocType>WORK INS</DocType>
              <PrintWithInvoice>No</PrintWithInvoice>
            </AttachFileToShipment>
          </soap:Body>
        </soap:Envelope>`;
            await sendAddDocument(xmlPayload);
          })
        );
      })
    );

    dynamoData.Status = 'PENDING';
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

async function sendAddDocument(xmlString) {
  try {
    console.info(xmlString);
    const config = {
      url: process.env.UPLOAD_DOCUMENT_API,
      method: 'post',
      headers: {
        'Accept': 'text/xml',
        'Content-Type': 'text/xml; charset=utf-8',
        'soapAction': 'http://tempuri.org/AttachFileToShipment',
      },
      data: xmlString,
    };
    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') !== 200) {
      console.info(get(res, 'data', ''));
      throw new Error(`ADD DOCUMENT API Request Failed: ${res}`);
    }
  } catch (error) {
    console.info(error);
    throw error;
  }
}
