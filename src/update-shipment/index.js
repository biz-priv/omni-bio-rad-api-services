'use strict';

const { get, isEqual } = require('lodash');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const {
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
  console.info(
    '🚀 -> file: index.js:22 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  try {
    const eventBody = JSON.parse(get(event, 'body', {}));

    const attachments = JSON.parse(JSON.stringify(get(eventBody, 'attachments', [])));
    console.info('🚀 -> file: index.js:27 -> module.exports.handler= -> attachments:', attachments);

    if (attachments.length > 0) {
      await Promise.all(
        get(eventBody, 'attachments', []).map(async (attachment) => {
          console.info(attachment.description);
          console.info(typeof attachment.fileContentBinaryObject);
          attachment.fileContentBinaryObject = 'B64String';
        })
      );
    }

    let initialRecord;
    if (get(event, 'pathParameters.freightOrderId', '') !== '') {
      const Params = {
        TableName: process.env.LOGS_TABLE,
        IndexName: 'FreightOrderId-Index',
        KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
        ExpressionAttributeValues: {
          ':FreightOrderId': get(event, 'pathParameters.freightOrderId', ''),
        },
      };

      const Result = await getData(Params);
      initialRecord = Result.filter(
        (obj) =>
          obj.Process === get(CONSTANTS, 'shipmentProcess.create', '') &&
          obj.Status === get(CONSTANTS, 'statusVal.success', '')
      );
      console.info(
        '🚀 -> file: index.js:52 -> module.exports.handler= -> initialRecord:',
        initialRecord
      );
    } else {
      throw new Error(
        'Error, FreightOrderId is missing in the request, please add the details in the request.'
      );
    }
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = JSON.stringify(eventBody);
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    console.info(
      '🚀 -> file: index.js:63 -> module.exports.handler= -> Log Id:',
      get(dynamoData, 'Id', '')
    );
    dynamoData.Process = get(CONSTANTS, 'shipmentProcess.update', '');
    dynamoData.FreightOrderId = get(event, 'pathParameters.freightOrderId', '');
    dynamoData.OrderingPartyLbnId = get(event, 'pathParameters.orderingPartyLbnId', '');
    dynamoData.OriginatorId = get(event, 'pathParameters.originatorId', '');
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
    dynamoData.Housebill = [];
    dynamoData.FileNumber = [];
    if (initialRecord.length < 1) {
      throw new Error(
        `Error, There are no shipments for the given freight order Id: ${get(dynamoData, 'FreightOrderId')}, please create a shipment before updating.`
      );
    }

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
    console.info(groupedItemKeys);

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
        console.info(payloads);
        return { ...payloads, stopId: key };
      })
    );
    console.info('wtPayloadsData: ', wtPayloadsData);
    console.info('results: ', get(initialRecord, '[0].ShipmentDetails', ''));
    const updateResponses = [];
    let updateShipmentsFlag = false;
    dynamoData.HousebillsToDelete = [];
    await Promise.all(
      wtPayloadsData.map(async (data) => {
        console.info(get(data, 'stopId', ''));
        const initialPayload = get(
          initialRecord,
          `[0].ShipmentDetails[${get(data, 'stopId', '')}]`,
          ''
        );

        const updateFlag = compareJson(
          get(initialPayload, 'jsonPayload', ''),
          get(data, 'jsonPayload', '')
        );

        console.info(updateFlag);
        if (!updateFlag) {
          dynamoData.Housebill.push(get(initialPayload, 'housebill', ''));
          dynamoData.FileNumber.push(get(initialPayload, 'fileNumber', ''));
          updateResponses.push({
            ...initialPayload,
            updateFlag,
          });
        } else {
          dynamoData.HousebillsToDelete.push(get(initialPayload, 'housebill', ''));
          updateShipmentsFlag = true;
          updateResponses.push({
            initialXmlPayload: get(initialPayload, 'xmlPayload', ''),
            intialFileNumber: get(initialPayload, 'fileNumber', ''),
            intialHousebill: get(initialPayload, 'housebill', ''),
            jsonPayload: JSON.stringify(get(data, 'jsonPayload', '')),
            xmlPayload: get(data, 'xmlPayload', ''),
            stopId: get(data, 'stopId', ''),
            updateFlag,
          });
        }
        console.info(dynamoData.Housebill);
      })
    );
    console.info(updateResponses);
    dynamoData.ShipmentUpdates = updateResponses;
    if (updateShipmentsFlag) {
      dynamoData.Status = 'PENDING';
    } else {
      initialRecord[0].LastUpdateEvent = [];
      initialRecord[0].LastUpdateEvent.push({
        id: get(dynamoData, 'Id', ''),
        time: cstDate.format('YYYY-MM-DD HH:mm:ss SSS'),
      });
      await putLogItem(initialRecord);
      dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
    }

    console.info(dynamoData);
    await putLogItem(dynamoData);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
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
                <p>We have an error while updating the shipment:</p>
                <p><span class="highlight">Error details:</span> <strong>${error}</strong><br>
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
          subject: `Bio Rad Update Shipment ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.info(
          '🚀 -> file: index.js:312 -> module.exports.handler= -> Error while sending error notification:',
          err
        );
      }
    } else {
      errorMsgVal = errorMsgVal.split(',').slice(1);
    }
    dynamoData.ErrorMsg = errorMsgVal;
    dynamoData.Status = get(CONSTANTS, 'statusVal.failed', '');
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

function compareJson(initialPayload, newPayload) {
  return !isEqual(initialPayload, newPayload);
}
