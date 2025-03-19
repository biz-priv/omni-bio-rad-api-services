'use strict';

const { get } = require('lodash');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { querySourceDb, sendSESEmail } = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

let dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(
    '🚀 -> file: index.js:12 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  try {
    dynamoData = {};
    const eventBody = JSON.parse(get(event, 'body', {}));

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = JSON.stringify(get(event, 'body', ''));
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    console.info(
      '🚀 -> file: index.js:25 -> module.exports.handler= -> Log Id:',
      get(dynamoData, 'Id', '')
    );
    dynamoData.Process = get(CONSTANTS, 'shipmentProcess.addTracking', '');
    dynamoData.FreightOrderId = get(eventBody, 'shipment.orderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'shipper.shipperLBNID', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrier.carrierLBNID', '');
    dynamoData.TechnicalId = get(eventBody, 'technicalId', '');
    dynamoData.Housebill = [];

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
        ':FreightOrderId': get(eventBody, 'shipment.orderId', ''),
        ':status': get(CONSTANTS, 'statusVal.success', ''),
        ':process': get(CONSTANTS, 'shipmentProcess.create', ''),
      },
    };

    const logDataResult = await getData(logDataParams);
    console.info('🚀 -> file: index.js:230 -> updateFreightOrder -> logDataResult:', logDataResult);
    if (logDataResult.length === 0) {
      console.info(
        `SKIPPING, There is no shipment creation request for this FO: ${get(eventBody, 'shipment.orderId', '')}`
      );
      return;
    }
    const createShipmentData = logDataResult[0];

    const stops = get(eventBody, 'shipment.stops', '');

    const stopsUpdateResults = await Promise.all(
      stops.map(async (stop) => {
        let locId;
        try {
          locId = get(get(stop, 'location.Id', '').split(':'), '[6]', '');
          if (get(createShipmentData, 'LoadingLocationIds', []).includes(locId)) {
            createShipmentData.Slocid = get(stop, 'stopId', '');
          } else {
            createShipmentData.Clocid = get(stop, 'stopId', '');
          }

          // const query = `insert into tbl_references (FK_OrderNo,CustomerType,ReferenceNo,FK_RefTypeId) (select fk_orderno,customertype,'${get(stop, 'stopId', '')}','STO' from tbl_references where referenceno='${locId}' and customertype in ('S','C') and fk_reftypeid='STP' and fk_orderno in (select fk_orderno from tbl_references where customertype='B' and fk_reftypeid='SID' and referenceno='${get(dynamoData, 'FreightOrderId', '')}') and fk_orderno not in (select fk_orderno from tbl_references where referenceno='${get(stop, 'stopId', '')}' and customertype in ('S','C') and fk_reftypeid='STO'))`;
          // await querySourceDb(query);
          // console.info('🚀 -> file: index.js:78 -> stops.map -> query:', query);
          return true;
        } catch (error) {
          console.error(`Error for ${locId}`);
          return { locId };
        }
      })
    );
    console.info(
      '🚀 -> file: index.js:86 -> module.exports.handler= -> stopsUpdateResults:',
      stopsUpdateResults
    );

    try {
      const trackingNotesQuery = `insert into tbl_trackingnotes (FK_OrderNo,datetimeentered,publicnote,FK_UserId,eventdatetime,Note) (select fk_orderno,CURRENT_TIMESTAMP,'N','saplbn',CURRENT_TIMESTAMP,'technicalId ${get(dynamoData, 'TechnicalId', '')}' from tbl_references where customertype='B' and fk_reftypeid='SID' and referenceno='${get(dynamoData, 'FreightOrderId', '')}')`;

      await querySourceDb(trackingNotesQuery);
    } catch (trackingNotesError) {
      console.error('Error while adding the tracking notes', trackingNotesError);
      throw trackingNotesError;
    }

    dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
    await putLogItem(createShipmentData);
    await putLogItem(dynamoData);
    // eslint-disable-next-line consistent-return
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
    console.error(
      '🚀 -> file: index.js:111 -> module.exports.handler= -> Main handler error:',
      error
    );

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
                <p>We have an error while adding the tracking details:</p>
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
          subject: `Bio Rad Add Tracking ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.info(
          '🚀 -> file: index.js:167 -> module.exports.handler= -> Error while sending error notification:',
          err
        );
      }
    } else {
      errorMsgVal = errorMsgVal.split(',').slice(1);
    }
    dynamoData.ErrorMsg = errorMsgVal;
    dynamoData.Status = get(CONSTANTS, 'statusVal.failed', '');
    await putLogItem(dynamoData);
    // eslint-disable-next-line consistent-return
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
