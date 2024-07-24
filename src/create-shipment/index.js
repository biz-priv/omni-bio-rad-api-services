'use strict';

const { get } = require('lodash');
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
  sendSESEmail,
} = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

const dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info('🚀 -> file: index.js:27 -> module.exports.handler= -> event:', event);
  try {
    const eventBody = JSON.parse(get(event, 'body', {}));

    const attachments = JSON.parse(JSON.stringify(get(eventBody, 'attachments', [])));
    console.info('🚀 -> file: index.js:32 -> module.exports.handler= -> attachments:', attachments);

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
    console.info('🚀 -> file: index.js:48 -> module.exports.handler= -> Log Id:', get(dynamoData, 'Id', ''));
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
      const logDataParams = {
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

      const logDataResult = await getData(logDataParams);
      console.info('🚀 -> file: index.js:98 -> module.exports.handler= -> logDataResult:', logDataResult);
      if (logDataResult.length > 0) {
        throw new Error(
          `Error, Shipments already created for the provided freight order Id: ${get(dynamoData, 'FreightOrderId', '')}`
        );
      }
    }

    const headerData = await prepareHeaderData(eventBody);
    console.info('🚀 -> file: index.js:108 -> module.exports.handler= -> headerData:', headerData);
    if (get(headerData, 'Mode', '') === 'Domestic') {
      dynamoData.ShipmentType = 'LTL';
    } else {
      dynamoData.ShipmentType = 'FTL';
    }

    const transportationStages = get(eventBody, 'transportationStages', []);
    const items = get(eventBody, 'items', []);

    // group the items to understand how many shipments were exist in the request.
    const groupedItems = await groupItems(items);
    console.info(
      '🚀 -> file: index.js:120 -> module.exports.handler= -> groupedItems:',
      groupedItems
    );
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
        console.info('🚀 -> file: index.js:208 -> groupedItemKeys.map -> shipperAndConsignee:', shipperAndConsignee);

        const referenceList = await prepareReferenceList(loadingStage, unloadingStage, dynamoData);
        console.info('🚀 -> file: index.js:176 -> groupedItemKeys.map -> referenceList:', JSON.stringify(referenceList));

        const shipmentLineList = await prepareShipmentLineListDate(get(groupedItems, key, []));
        console.info('🚀 -> file: index.js:179 -> groupedItemKeys.map -> shipmentLineList:', JSON.stringify(shipmentLineList));

        const dateValues = await prepareDateValues(
          loadingStage,
          unloadingStage,
          transportationStages
        );
        console.info('🚀 -> file: index.js:209 -> groupedItemKeys.map -> dateValues:', dateValues);

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
    console.info('🚀 -> file: index.js:199 -> module.exports.handler= -> wtPayloadsData:', wtPayloadsData);

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
    console.info('🚀 -> file: index.js:285 -> module.exports.handler= -> Main handler error:', error);

    let errorMsgVal = '';
    if (get(error, 'message', null) !== null) {
      errorMsgVal = get(error, 'message', '');
    } else {
      errorMsgVal = error;
    }
    const flag = errorMsgVal.split(',')[0];
    if (flag !== 'Error') {
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
                <p>We have an error while creating the shipment:</p>
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
          subject: `Bio Rad Create Shipment ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.info('🚀 -> file: index.js:335 -> module.exports.handler= -> Error while sending error notification:', err);
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
    console.info('🚀 -> file: index.js:370 -> sendAddDocument -> config:', config);
    const res = await axios.request(config);
    console.info('🚀 -> file: index.js:372 -> sendAddDocument -> res:', res);
    if (get(res, 'status', '') !== 200) {
      console.info(get(res, 'data', ''));
      throw new Error(`ADD DOCUMENT API Request Failed: ${res}`);
    }
  } catch (error) {
    console.info(error);
    throw error;
  }
}
