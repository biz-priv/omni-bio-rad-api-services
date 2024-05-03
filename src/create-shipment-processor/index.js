'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const { querySourceDb } = require('../Shared/dataHelper');
const axios = require('axios');
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
        await sendToLbn(token, payload);
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

async function getLbnToken() {
  try {
    const config = {
      maxBodyLength: Infinity,
      url: process.env.LBN_TOKEN_URL,
      method: 'post',
      headers: {
        Username: process.env.LBN_TOKEN_USERNAME,
        Password: process.env.LBN_TOKEN_PASSWORD,
        Authorization: process.env.LBN_TOKEN_AUTHORIZATION,
      },
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data.access_token', '');
    }
    throw new Error(`Lbn token API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn token API Request Failed: ', error);
    throw new Error(`Lbn token API Request Failed: ${error}`);
  }
}

async function getDocsFromWebsli({ housebill }) {
  try {
    const url = `https://websli.omnilogistics.com/wtTest/getwtdoc/v1/json/9980f7b9eaffb71ce2f86734dae062/housebill=${housebill}/doctype=HOUSEBILL|doctype=LABEL`;
    const queryType = await axios.get(url);
    //   console.info('🚀 ~ file: index.js:327 ~ getDocsFromWebsli ~ url:', url);
    const docs = get(queryType, 'data.wtDocs.wtDoc', []);
    return docs.map((doc) => ({
      filename: doc.filename,
      b64str: doc.b64str,
    }));
  } catch (error) {
    //   console.info('🙂 -> file: pod-doc-sender.js:207 -> getDocsFromWebsli -> error:', error);
    const message = get(error, 'response.data', '');
    console.error(
      'error while calling websli endpoint: ',
      message === '' ? error.message : message
    );
    throw error;
  }
}

async function sendToLbn(token, payload) {
  try {
    const config = {
      url: `${process.env.LBN_SEND_URL}/${get(dynamoData, 'OrderingPartyLbnId')}/${get(dynamoData, 'OriginatorId')}/${get(dynamoData, 'FreightOrderId')}/carrierResponse`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      data: payload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Lbn main API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn main API Request Failed: ', error);
    throw new Error(`Lbn main API Request Failed: ${error}`);
  }
}
