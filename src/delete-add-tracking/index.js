'use strict';

const { get } = require('lodash');
const { putLogItem } = require('../Shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { sendSESEmail } = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

const dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info('🚀 -> file: index.js:13 -> module.exports.handler= -> event:', event);
  try {
    const eventBody = JSON.parse(get(event, 'body', {}));
    console.info('🚀 -> file: index.js:16 -> module.exports.handler= -> eventBody:', eventBody);

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = get(event, 'body', '');
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    console.info(
      '🚀 -> file: index.js:24 -> module.exports.handler= -> Log Id:',
      get(dynamoData, 'Id', '')
    );
    dynamoData.Process = get(CONSTANTS, 'shipmentProcess.deleteAddTracking', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'shipper.shipperLBNID', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrier.carrierLBNID', '');
    dynamoData.TechnicalId = get(eventBody, 'technicalId', '');

    dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
    await putLogItem(dynamoData);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: get(dynamoData, 'Id', ''),
          Message: 'Success',
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.info(
      '🚀 -> file: index.js:44 -> module.exports.handler= -> Main handler error:',
      error
    );
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
              <p>We have an error while deleting the tracking details:</p>
              <p><span class="highlight">Error details:</span> <strong>${error}</strong><br>
                 <span class="highlight">ID:</span> <strong>${get(dynamoData, 'Id', '')}</strong><br>
              <p><span class="highlight">Function:</span>${context.functionName}</p>
              <p><span class="highlight">Note:</span>Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.</p>
              <p>Thank you,<br>
              Omni Automation System</p>
              <p style="font-size: 0.9em; color: #888;">Note: This is a system generated email, Please do not reply to this email.</p>
            </div>
          </body>
          </html>
        `,
        subject: `Bio Rad Delete Add Tracking ${process.env.STAGE} ERROR`,
      });
      console.info('Notification has been sent');
    } catch (err) {
      console.info(
        '🚀 -> file: index.js:167 -> module.exports.handler= -> Error while sending error notification:',
        err
      );
    }
    dynamoData.ErrorMsg = error;
    dynamoData.Status = get(CONSTANTS, 'statusVal.failed', '');
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
