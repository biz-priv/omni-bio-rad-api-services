'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { sendSESEmail, getDocsFromWebsli, getLbnToken, sendToLbn } = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');

const bioRadCustomerIds = process.env.BIO_RAD_BILL_TO_NUMBERS.split(',');
let dynamoData = {};
let createShipmentData = {};

module.exports.handler = async (event, context) => {
  console.info(
    '🚀 -> file: index.js:13 -> module.exports.handler= -> event:',
    JSON.stringify(event)
  );
  try {
    dynamoData = {};
    const NewImage = get(event, 'Records.[0].dynamodb.NewImage', {});
    console.info('🚀 -> file: index.js:16 -> module.exports.handler= -> NewImage:', NewImage);

    const data = AWS.DynamoDB.Converter.unmarshall(NewImage);
    console.info(data);

    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': get(data, 'FK_OrderNo'),
      },
    };
    const headerResult = await getData(headerParams);
    console.info('🚀 -> module.exports.handler= -> headerResult:', headerResult);
    if (!bioRadCustomerIds.includes(get(headerResult, '[0].BillNo'))) {
      console.info('SKIPPING, This event is not related to bio rad.');
      return;
    }
    if (get(data, 'CustomerType') === 'B' && get(data, 'FK_RefTypeId') === 'SID') {
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
          ':FreightOrderId': get(data, 'ReferenceNo'),
          ':status': get(CONSTANTS, 'statusVal.success', ''),
          ':process': get(CONSTANTS, 'shipmentProcess.create', ''),
        },
      };

      const logDataResult = await getData(logDataParams);
      console.info(
        '🚀 -> file: index.js:230 -> updateFreightOrder -> logDataResult:',
        logDataResult
      );
      if (logDataResult.length === 0) {
        console.info(
          `SKIPPING, This event is not related to bio rad as the bill to reference SID is ${get(data, 'ReferenceNo')}`
        );
        return;
      }
      createShipmentData = logDataResult[0];
      const cstDate = moment().tz('America/Chicago');
      dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
      dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
      dynamoData.Event = JSON.stringify(data);
      dynamoData.FreightOrderId = get(data, 'ReferenceNo');
      dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
      dynamoData.Process = get(CONSTANTS, 'shipmentProcess.sendAWBConfirmation', '');
      dynamoData.OrderNo = get(data, 'FK_OrderNo');
      if (get(createShipmentData, 'FileNumber', '').length > 0 && get(createShipmentData, 'FileNumber', '').includes(get(data, 'FK_OrderNo'))) {
        console.info('Filenumber already added and also sent the confirmation to bio rad')
        return
      }else if (get(createShipmentData, 'FileNumber', '').length > 0 && !get(createShipmentData, 'FileNumber', '').includes(get(data, 'FK_OrderNo'))) {
        createShipmentData.FileNumber = `${get(createShipmentData, 'FileNumber')},${get(data, 'FK_OrderNo')}`;
        createShipmentData.Housebill = `${get(createShipmentData, 'Housebill')},${get(headerResult, '[0].Housebill')}`;
      } else {
        createShipmentData.FileNumber = get(data, 'FK_OrderNo');
        createShipmentData.Housebill = get(headerResult, '[0].Housebill');
      }

      const docData = await getDocsFromWebsli({
        housebill: get(headerResult, '[0].Housebill'),
        doctype: 'doctype=HOUSEBILL|doctype=LABEL',
      });
      console.info('🚀 -> module.exports.handler= -> docData:', docData);

      const businessDocumentReferences = [];
      const attachments = [];

      businessDocumentReferences.push({
        documentId: get(headerResult, '[0].Housebill'),
        documentTypeCode: 'T51',
      });

      docData.map(async (doc) => {
        attachments.push({
          name: doc.filename,
          mimeCode: 'application/pdf',
          fileContentBinaryObject: doc.b64str,
        });
      });

      const payload = {
        carrierPartyLbnId: get(createShipmentData, 'CarrierPartyLbnId', ''),
        confirmationStatus: 'CN',
        businessDocumentReferences,
        attachments,
      };
      console.info('🚀 -> file: index.js:73 -> records.map -> payload:', JSON.stringify(payload));

      const token = await getLbnToken();
      await sendToLbn(token, payload, createShipmentData);
      dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
      await putLogItem(createShipmentData);
      await putLogItem(dynamoData);
    }
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
              <p>We have an error while sending the AWB confirmation to bio rad:</p>
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
        subject: `Bio Rad Send AWB Confirmation ${process.env.STAGE} ERROR`,
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
  }
};
