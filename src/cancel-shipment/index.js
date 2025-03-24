'use strict';

const { get } = require('lodash');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const { sendSESEmail } = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

let dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(
    '🚀 -> file: index.js:15 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  try {
    dynamoData = {};
    const eventBody = JSON.parse(get(event, 'body', {}));

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss');
    dynamoData.Event = JSON.stringify(event);
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    console.info(
      '🚀 -> file: index.js:25 -> module.exports.handler= -> Log Id:',
      get(dynamoData, 'Id', '')
    );
    dynamoData.Process = get(CONSTANTS, 'shipmentProcess.cancel', '');

    let freightOrderId = '';
    if (get(eventBody, 'freightOrderId', '') === '') {
      if (get(event, 'pathParameters.freightOrderId', '') === '') {
        throw new Error('Error, FreightOrderId is missing in the request.');
      } else {
        freightOrderId = get(event, 'pathParameters.freightOrderId', '');
      }
    } else {
      freightOrderId = get(eventBody, 'freightOrderId', '');
    }
    dynamoData.FreightOrderId = freightOrderId;

    await updateFreightOrder(freightOrderId);

    dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
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
    console.info('🚀 -> file: index.js:74 -> module.exports.handler= -> Main lambda error:', error);

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
                <p>We have an error while cancelling the shipment:</p>
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
          subject: `Bio Rad Cancel Shipment ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.info(
          '🚀 -> file: index.js:121 -> module.exports.handler= -> Error while sending error notification:',
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

async function updateFreightOrder(freightOrderId) {
  try {
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
        ':FreightOrderId': freightOrderId,
        ':status': get(CONSTANTS, 'statusVal.success', ''),
        ':process': get(CONSTANTS, 'shipmentProcess.create', ''),
      },
    };

    const logDataResult = await getData(logDataParams);
    console.info('🚀 -> file: index.js:230 -> updateFreightOrder -> logDataResult:', logDataResult);
    logDataResult[0].Status = 'CANCELLED';
    await putLogItem(logDataResult[0]);
  } catch (error) {
    console.error(
      `Error while updating the previous created shipment record in logs table: ${error}`
    );
    throw new Error(
      `Error while updating the previous created shipment record in logs table: ${error}`
    );
  }
}
