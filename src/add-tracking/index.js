'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { querySourceDb } = require('../Shared/dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  try {
    const eventBody = JSON.parse(get(event, 'body', {}));

    // const eventBody = get(event, 'body', {});

    console.info(eventBody);

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = get(event, 'body', '');
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'ADD_TRACKING';
    dynamoData.FreightOrderId = get(eventBody, 'shipment.orderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'shipper.shipperLBNID', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrier.carrierLBNID', '');
    dynamoData.TechnicalId = get(eventBody, 'technicalId', '');
    dynamoData.Housebill = [];

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
        ':process': 'ADD_TRACKING',
      },
    };

    const Result = await getData(Params);
    console.info(Result);
    if (Result.length > 0) {
      dynamoData.Status = 'SKIPPING';
      dynamoData.ErrorMsg =
        'Duplicate tracking request. We alread received the tracking for this freight order id';
      await putLogItem(dynamoData);
      return {
        statusCode: 400,
        body: JSON.stringify(
          {
            responseId: dynamoData.Id,
            message:
              'Duplicate tracking request. We alread received the tracking for this freight order id',
          },
          null,
          2
        ),
      };
    }

    const stops = get(eventBody, 'shipment.stops', '');

    const stopsUpdateResults = await Promise.all(
      stops.map(async (stop) => {
        let locId;
        try {
          locId = get(get(stop, 'location.Id', '').split(':'), '[6]', '');
          const query = `insert into tbl_references (FK_OrderNo,CustomerType,ReferenceNo,FK_RefTypeId) (select fk_orderno,customertype,'${get(stop, 'stopId', '')}','STO' from tbl_references where referenceno='${locId}' and customertype in ('S','C') and fk_reftypeid='STP' and fk_orderno in (select fk_orderno from tbl_references where customertype='B' and fk_reftypeid='SID' and referenceno='${get(dynamoData, 'FreightOrderId', '')}') and fk_orderno not in (select fk_orderno from tbl_references where referenceno='${get(stop, 'stopId', '')}' and customertype in ('S','C') and fk_reftypeid='STO'))`;
          console.info(query);
          await querySourceDb(query);
          return true;
        } catch (error) {
          console.error(`Error for ${locId}`);
          return { locId };
        }
      })
    );
    console.info(stopsUpdateResults);

    try {
      const trackingNotesQuery = `insert into tbl_trackingnotes (FK_OrderNo,datetimeentered,publicnote,FK_UserId,eventdatetime,Note) (select fk_orderno,CURRENT_TIMESTAMP,'N','saplbn',CURRENT_TIMESTAMP,'technicalId ${get(dynamoData, 'TechnicalId', '')}' from tbl_references where customertype='B' and fk_reftypeid='SID' and referenceno='${get(dynamoData, 'FreightOrderId', '')}')`;

      await querySourceDb(trackingNotesQuery);
    } catch (trackingNotesError) {
      console.info('Error while adding the tracking notes', trackingNotesError);
      throw trackingNotesError;
    }

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
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(get(dynamoData, 'Event', {}))}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
        Subject: `Bio Rad Add Tracking ERROR ${context.functionName}`,
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
