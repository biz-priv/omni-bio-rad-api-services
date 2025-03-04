'use strict';

const { get } = require('lodash');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const { sendSESEmail, getLbnToken, sendToLbn } = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

let dynamoData = {};

module.exports.handler = async (event, context) => {
  console.info(
    '🚀 -> file: index.js:27 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  try {
    dynamoData = {};
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
    console.info(
      '🚀 -> file: index.js:48 -> module.exports.handler= -> Log Id:',
      get(dynamoData, 'Id', '')
    );
    dynamoData.Process = get(CONSTANTS, 'shipmentProcess.create', '');
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
          ':status': get(CONSTANTS, 'statusVal.success', ''),
          ':process': get(CONSTANTS, 'shipmentProcess.create', ''),
        },
      };

      const logDataResult = await getData(logDataParams);
      console.info(
        '🚀 -> file: index.js:98 -> module.exports.handler= -> logDataResult:',
        logDataResult
      );
      if (logDataResult.length > 0) {
        throw new Error(
          `Error, Shipments already created for the provided freight order Id: ${get(dynamoData, 'FreightOrderId', '')}`
        );
      }
    }

    let mode;
    if (get(CONSTANTS, `mode.${get(eventBody, 'shippingTypeCode', '')}`, '') !== '') {
      mode = get(CONSTANTS, `mode.${get(eventBody, 'shippingTypeCode', '')}`, '');
    }

    if (mode === 'Domestic') {
      dynamoData.ShipmentType = 'LTL';
    } else {
      dynamoData.ShipmentType = 'FTL';
    }

    const payload = {
      carrierPartyLbnId: get(dynamoData, 'CarrierPartyLbnId', ''),
      confirmationStatus: 'CN',
    };
    console.info('🚀 -> file: index.js:113 -> records.map -> payload:', JSON.stringify(payload));

    const token = await getLbnToken();
    await sendToLbn(token, payload, dynamoData);

    dynamoData.Status = 'SUCCESS';
    console.info('🚀 -> module.exports.handler= -> dynamoData:', dynamoData);
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
    console.info(
      '🚀 -> file: index.js:285 -> module.exports.handler= -> Main handler error:',
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
        console.info(
          '🚀 -> file: index.js:335 -> module.exports.handler= -> Error while sending error notification:',
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
