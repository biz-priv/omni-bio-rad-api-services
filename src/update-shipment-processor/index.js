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
  sendSESEmail,
} = require('../Shared/dataHelper');
const moment = require('moment-timezone');

const cstDate = moment().tz('America/Chicago');
let dynamoData;

module.exports.handler = async (event, context) => {
  console.info('🚀 -> file: index.js:21 -> module.exports.handler= -> event:', JSON.stringify(event));

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
        console.info('🚀 -> file: index.js:43 -> records.map -> CreateDynamoData:', CreateDynamoData);

        const shipmentUpdates = get(dynamoData, 'ShipmentUpdates', []);
        CreateDynamoData.ShipmentDetails = {};
        CreateDynamoData.Housebill = [];
        CreateDynamoData.FileNumber = [];

        for (const housebillToDelete of get(dynamoData, 'HousebillsToDelete', [])) {
          const data = await cancelShipmentApiCall(housebillToDelete);
          console.info('🚀 -> file: index.js:52 -> records.map -> data after cancelling shipment:', data);
        }

        for (const data of shipmentUpdates) {
          console.info('🚀 -> file: index.js:56 -> records.map -> data:', data);
          if (get(data, 'updateFlag', false) === false) {
            dynamoData.ShipmentDetails[get(data, 'stopId')] = data;
            CreateDynamoData.ShipmentDetails[get(data, 'stopId')] = data;
            CreateDynamoData.Housebill.push(get(data, 'housebill', ''));
            CreateDynamoData.FileNumber.push(get(data, 'fileNumber', ''));
            console.info('Skip the shipment as there is no update in the payload.', data);
            continue;
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
          CreateDynamoData.Housebill.push(housebill);
          CreateDynamoData.FileNumber.push(fileNumber);
          dynamoData.ShipmentDetails[get(data, 'stopId')] = data;
          dynamoData.ShipmentDetails[get(data, 'stopId')].housebill = housebill;
          dynamoData.ShipmentDetails[get(data, 'stopId')].fileNumber = fileNumber;
          dynamoData.ShipmentDetails[get(data, 'stopId')].xmlResponse = xmlResponse;
          dynamoData.Housebill.push(housebill);
          dynamoData.FileNumber.push(fileNumber);

          if (get(data, 'intialFileNumber', '') !== '') {
            const refernecesUpdateQuery = `insert into tbl_references (FK_OrderNo,CustomerType,ReferenceNo,FK_RefTypeId)
                                      (select ${fileNumber},customertype,ReferenceNo,'STO' from tbl_references where
                                      fk_orderno=${get(data, 'intialFileNumber', '')} and customertype in ('S','C') and fk_reftypeid='STO');`;
            await querySourceDb(refernecesUpdateQuery);

            const trackingNotesUpdateQuery = `insert into tbl_trackingnotes (FK_OrderNo,DateTimeEntered,PublicNote,FK_UserId,EventDateTime,EventTimeZone,ConsolNo,Priority,Note)
                                        (select ${fileNumber},DateTimeEntered,PublicNote,FK_UserId,EventDateTime,EventTimeZone,ConsolNo,Priority,Note from tbl_trackingnotes where
                                        fk_orderno=${get(data, 'intialFileNumber', '')} and note like 'technicalId %');`;
            await querySourceDb(trackingNotesUpdateQuery);
          }
        }

        const fileNumberArray = get(dynamoData, 'FileNumber');
        console.info('🚀 -> file: index.js:129 -> records.map -> fileNumberArray:', fileNumberArray);

        const updateQuery = `update tbl_shipmentheader set
            CallInPhone='${get(dynamoData, 'CallInPhone', '')}',
            CallInFax='${get(dynamoData, 'CallInFax', '')}',
            QuoteContactEmail='${get(dynamoData, 'QuoteContactEmail', '')}'
            where pk_orderno in (${fileNumberArray.join(',')});`;
        console.info('🚀 -> file: index.js:136 -> records.map -> updateQuery:', updateQuery);

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
        console.info('🚀 -> file: index.js:173 -> records.map -> payload:', payload);

        const token = await getLbnToken();
        await sendToLbn(token, payload, dynamoData);

        CreateDynamoData.LastUpdated = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
        CreateDynamoData.LastUpdateEvent.push({
          id: get(dynamoData, 'Id', ''),
          time: cstDate.format('YYYY-MM-DD HH:mm:ss SSS'),
        });
        dynamoData.LastUpdated = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');

        dynamoData.Status = 'SUCCESS';
        console.info('🚀 -> file: index.js:186 -> records.map -> dynamoData:', dynamoData);
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
    console.info('🚀 -> file: index.js:204 -> module.exports.handler= -> Main handler error:', error);

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
                <p>We have an error while updating the shipment:</p>
                <p><span class="highlight">Error details:</span> <strong>${error}</strong><br>
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
          subject: `Bio Rad Update Shipment Processor ${process.env.STAGE} ERROR`,
        });
        console.info('Notification has been sent');
      } catch (err) {
        console.error('Error while sending error notification: ', err);
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
