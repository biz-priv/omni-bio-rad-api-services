'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const { putLogItem, getData } = require('../Shared/dynamo');
const {
  xmlJsonConverter,
  sendToWT,
  getLbnToken,
  sendToLbn,
  querySourceDb,
  getDocsFromWebsli,
  cancelShipmentApiCall,
} = require('../Shared/dataHelper');
const moment = require('moment-timezone');

const cstDate = moment().tz('America/Chicago');
const sns = new AWS.SNS();
let dynamoData;

module.exports.handler = async (event, context) => {
  console.info(JSON.stringify(event));

  console.info(context);

  try {
    const records = get(event, 'Records', []);
    await Promise.all(
      records.map(async (record) => {
        console.info(record);
        dynamoData = AWS.DynamoDB.Converter.unmarshall(get(record, 'dynamodb.NewImage'));
        dynamoData.ShipmentDetails = {};
        const Params = {
          TableName: process.env.LOGS_TABLE,
          IndexName: 'FreightOrderId-Index',
          KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
          ExpressionAttributeValues: {
            ':FreightOrderId': get(dynamoData, 'FreightOrderId', ''),
          },
        };

        const Result = await getData(Params);
        const CreateDynamoData = Result.filter(
          (obj) => obj.Process === 'CREATE' && obj.Status === 'SUCCESS'
        )[0];
        console.info(CreateDynamoData);

        const shipmentUpdates = get(dynamoData, 'ShipmentUpdates', []);
        CreateDynamoData.ShipmentDetails = [];
        for (const data of shipmentUpdates) {
          console.info(data);
          if (get(data, 'updateFlag', false) === false) {
            dynamoData.ShipmentDetails[get(data, 'stopId')] = data;
            CreateDynamoData.ShipmentDetails[get(data, 'stopId')] = data;
            console.info('Skip the shipment as there is no update in the payload.', data);
            continue;
          }

          if (get(data, 'intialHousebill', '') !== '') {
            console.info(
              'This is an update for existing shipment, so cancelling the old shipment.'
            );
            console.info(get(data, 'intialHousebill', ''));
            await cancelShipmentApiCall(get(data, 'intialHousebill', ''));
          }

          const xmlResponse = await sendToWT(get(data, 'xmlPayload', ''));

          const xmlObjResponse = await xmlJsonConverter(xmlResponse);

          if (
            get(
              xmlObjResponse,
              'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ErrorMessage',
              ''
            ) !== '' ||
            get(
              xmlObjResponse,
              'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
              ''
            ) === ''
          ) {
            throw new Error(
              `WORLD TRAK API call failed: ${get(
                xmlObjResponse,
                'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ErrorMessage',
                ''
              )}`
            );
          }

          const housebill = get(
            xmlObjResponse,
            'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.Housebill',
            ''
          );
          const fileNumber = get(
            xmlObjResponse,
            'soap:Envelope.soap:Body.AddNewShipmentV3Response.AddNewShipmentV3Result.ShipQuoteNo',
            ''
          );

          CreateDynamoData.ShipmentDetails[get(data, 'stopId')] = data;
          CreateDynamoData.ShipmentDetails[get(data, 'stopId')].housebill = housebill;
          CreateDynamoData.ShipmentDetails[get(data, 'stopId')].fileNumber = fileNumber;
          CreateDynamoData.ShipmentDetails[get(data, 'stopId')].xmlResponse = xmlResponse;
          dynamoData.ShipmentDetails[get(data, 'stopId')] = data;
          dynamoData.ShipmentDetails[get(data, 'stopId')].housebill = housebill;
          dynamoData.ShipmentDetails[get(data, 'stopId')].fileNumber = fileNumber;
          dynamoData.ShipmentDetails[get(data, 'stopId')].xmlResponse = xmlResponse;
          dynamoData.Housebill.push(housebill);
          dynamoData.FileNumber.push(fileNumber);
        }

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

        const token = await getLbnToken();
        await sendToLbn(token, payload, dynamoData);

        CreateDynamoData.LastUpdated = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
        CreateDynamoData.LastUpdateEvent.push({
          id: get(dynamoData, 'Id', ''),
          time: cstDate.format('YYYY-MM-DD HH:mm:ss SSS'),
        });
        dynamoData.LastUpdated = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');

        dynamoData.Status = 'SUCCESS';
        console.info(dynamoData);
        console.info('SUCCESS');
        await putLogItem(dynamoData);
        await putLogItem(CreateDynamoData);
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
    console.info(dynamoData);
    console.info('FAILED');
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
