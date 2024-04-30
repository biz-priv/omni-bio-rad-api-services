'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const {
  prepareHeaderData,
  groupItems,
  getServiceLevel,
  CONSTANTS,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
} = require('../create-shipment/dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};
let dynamoDataFlag;

module.exports.handler = async (event, context) => {
  console.info(event);

  try {
    // const eventBody = JSON.parse(get(event, 'body', {}));

    const eventBody = get(event, 'body', {});

    const Params = {
      TableName: process.env.LOGS_TABLE,
      IndexName: 'FreightOrderId-Index',
      KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
      ExpressionAttributeValues: {
        ':FreightOrderId': '6100001369',
      },
    };

    const referenceResult = await getData(Params);
    const initialRecord = referenceResult.filter(
      (obj) => obj.Process === 'CREATE' && obj.Status === 'SUCCESS'
    );
    console.info(initialRecord);
    if (initialRecord.length > 1) {
      dynamoDataFlag = true;
    } else {
      dynamoDataFlag = false;
      const cstDate = moment().tz('America/Chicago');
      dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
      dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
      dynamoData.Event = get(event, 'body', '');
      dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
      dynamoData.Process = 'UPDATE';
      dynamoData.FreightOrderId = get(event, 'pathParameters.freightOrderId', '');
      dynamoData.OrderingPartyLbnId = get(event, 'pathParameters.orderingPartyLbnId', '');
      dynamoData.OriginatorId = get(event, 'pathParameters.originatorId', '');
      dynamoData.CarrierPartyLbnId = get(eventBody, 'carrierPartyLbnId', '');
      dynamoData.CallInPhone = `${get(eventBody, 'orderingParty.address.phoneNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.phoneNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.phoneNumber.subscriberId', '')}`;
      dynamoData.CallInFax = `${get(eventBody, 'orderingParty.address.faxNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.faxNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.faxNumber.subscriberId', '')}`;
      dynamoData.QuoteContactEmail = get(eventBody, 'orderingParty.address.emailAddress', '');
      dynamoData.XmlPayload = {};
    }
    console.info(dynamoDataFlag);

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
        return { ...payloads, stopId: key };
      })
    );
    console.info('wtPayloadsData: ', wtPayloadsData);
    console.info('results: ', initialRecord[0].XmlPayload);
    const updateResponses = [];
    await Promise.all(
      wtPayloadsData.map(async (data) => {
        console.info(data.stopId);
        const initialPayload = initialRecord[0].XmlPayload[data.stopId];
        const updateFlag = compareJson(initialPayload.jsonPayload, data.jsonPayload);
        console.info(JSON.stringify(data.jsonPayload));
        console.info(updateFlag);
        if (!updateFlag) {
          updateResponses.push({
            initialPayload,
            updatedPayload: data.jsonPayload,
            status: 'PENDING',
          });
        }
      })
    );
    console.info(updateResponses);
    dynamoData.ShipmentUpdates = updateResponses
    if (updateResponses.length > 0) {
      dynamoData.Status = 'PENDING';
    } else {
      dynamoData.Status = 'SUCCESS';
    }

    console.info(dynamoData)
    await putLogItem(dynamoData);
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
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
        Subject: `Bio Rad Update Shipment ERROR ${context.functionName}`,
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
    // await putLogItem(dynamoData);
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
  return JSON.stringify(initialPayload) === JSON.stringify(newPayload);
}
