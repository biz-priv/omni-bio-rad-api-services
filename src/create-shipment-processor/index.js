'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const { querySourceDb, getLbnToken, sendToLbn, getDocsFromWebsli } = require('../Shared/dataHelper');
const { putLogItem } = require('../Shared/dynamo');

const sns = new AWS.SNS();
let dynamoData;

module.exports.handler = async (event, context) => {
  try {
    console.info(JSON.stringify(event));

    const records = get(event, 'Records', []);

    await Promise.all(
      records.map(async (record) => {
        console.info(record);
        dynamoData = AWS.DynamoDB.Converter.unmarshall(get(record, 'dynamodb.NewImage'));

        console.info(dynamoData);

        const fileNumberArray = get(dynamoData, 'FileNumber');
        console.info('fileNumberArray: ', fileNumberArray);

        const updateQuery = `update tbl_shipmentheader set
            CallInPhone='${get(dynamoData, 'CallInPhone', '')}',
            CallInFax='${get(dynamoData, 'CallInFax', '')}',
            QuoteContactEmail='${get(dynamoData, 'QuoteContactEmail', '')}'
            where pk_orderno in (${fileNumberArray.join(',')});`;

        console.info(updateQuery);
        await querySourceDb(updateQuery);

        const documentPromises = get(dynamoData, 'Housebill', []).map(async (housebill) => {
          const data = await getDocsFromWebsli({ housebill });
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

        console.info('LbnPayload: ', payload);
        // // dynamoData.LbnPayload = payload;

        const token = await getLbnToken();
        await sendToLbn(token, payload, dynamoData);
      })
    );

    dynamoData.Status = 'SUCCESS';
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
        Subject: `Bio Rad Create Shipment Processor ERROR ${context.functionName}`,
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
