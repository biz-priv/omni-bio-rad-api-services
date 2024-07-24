'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const {
  querySourceDb,
  getLbnToken,
  sendToLbn,
  getDocsFromWebsli,
  sendSESEmail,
} = require('../Shared/dataHelper');
const { putLogItem } = require('../Shared/dynamo');

let dynamoData;

module.exports.handler = async (event, context) => {
  console.info('🚀 -> file: index.js:17 -> module.exports.handler= -> event:', JSON.stringify(event));
  try {

    const records = get(event, 'Records', []);

    await Promise.all(
      records.map(async (record) => {
        console.info('🚀 -> file: index.js:24 -> records.map -> record:', record);
        dynamoData = AWS.DynamoDB.Converter.unmarshall(get(record, 'dynamodb.NewImage'));
        console.info('🚀 -> file: index.js:26 -> records.map -> dynamoData:', dynamoData);

        const fileNumberArray = get(dynamoData, 'FileNumber');
        console.info('🚀 -> file: index.js:29 -> records.map -> fileNumberArray:', fileNumberArray);

        const updateQuery = `update tbl_shipmentheader set
            CallInPhone='${get(dynamoData, 'CallInPhone', '')}',
            CallInFax='${get(dynamoData, 'CallInFax', '')}',
            QuoteContactEmail='${get(dynamoData, 'QuoteContactEmail', '')}'
            where pk_orderno in (${fileNumberArray.join(',')});`;
        console.info('🚀 -> file: index.js:36 -> records.map -> updateQuery:', updateQuery);

        await querySourceDb(updateQuery);

        const documentPromises = get(dynamoData, 'Housebill', []).map(async (housebill) => {
          const data = await getDocsFromWebsli({
            housebill,
            doctype: 'doctype=HOUSEBILL|doctype=LABEL',
          });
          return { data, housebill };
        });

        const documentResults = await Promise.all(documentPromises);

        const businessDocumentReferences = [];
        const attachments = [];

        documentResults.map(async (data) => {
          businessDocumentReferences.push({
            documentId: get(data, 'housebill', ''),
            documentTypeCode: 'T51',
          });
          get(data, 'data', []).map(async (doc) => {
            attachments.push({
              name: doc.filename,
              mimeCode: 'application/pdf',
              fileContentBinaryObject: doc.b64str,
            });
          });
        });

        const payload = {
          carrierPartyLbnId: get(dynamoData, 'CarrierPartyLbnId', ''),
          confirmationStatus: 'CN',
          businessDocumentReferences,
          attachments,
        };
        console.info('🚀 -> file: index.js:73 -> records.map -> payload:', payload);

        dynamoData.LbnPayload = payload;

        const token = await getLbnToken();
        await sendToLbn(token, payload, dynamoData);
        dynamoData.Status = 'SUCCESS';
        await putLogItem(dynamoData);
      })
    );

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
    console.info('🚀 -> file: index.js:95 -> module.exports.handler= -> Main handler error:', error);

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
          subject: `Bio Rad Create Shipment processor ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.info('🚀 -> file: index.js:145 -> module.exports.handler= -> Error while sending error notification:', err);
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
