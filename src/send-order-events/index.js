'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const axios = require('axios');
const uuid = require('uuid');
const { getData, putLogItem } = require('../Shared/dynamo');
const moment = require('moment-timezone');
const {
  fetchTackingData,
  fetchRefernceNo,
  getDocsFromWebsli,
  modifyTime,
  getOffset,
  getLbnToken,
  getShipmentData,
  sendSESEmail,
} = require('../Shared/dataHelper');
const { CONSTANTS } = require('../Shared/constants');
const PDFKIT = require('pdfkit');
const sizeOf = require('buffer-image-size');

const bioRadCustomerIds = process.env.BIO_RAD_BILL_TO_NUMBERS.split(',');
let eventType;
let orderStatus;

module.exports.handler = async (event, context) => {
  try {
    console.info('Event: ', JSON.stringify(event));

    const record = get(event, 'Records[0]', []);
    orderStatus = '';
    eventType = '';
    const dynamoData = {};
    let fileNumber;
    console.info('record: ', record);
    try {
      const cstDate = moment().tz('America/Chicago');
      dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
      dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
      dynamoData.Event = JSON.stringify(record);
      dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
      console.info('🚀 -> file: index.js:42 -> get -> Log Id:', get(dynamoData, 'Id', ''));
      dynamoData.Process = get(CONSTANTS, 'shipmentProcess.sendOrderEvents', '');

      const recordBody = JSON.parse(get(record, 'body', {}));
      const message = JSON.parse(get(recordBody, 'Message', ''));
      console.info('🚀 -> file: index.js:47 -> get -> message:', message);
      let housebill;
      let location;
      let data;
      const dynamoTableName = get(message, 'dynamoTableName', '');
      if (
        dynamoTableName === process.env.APAR_FAILURE_TABLE ||
        dynamoTableName === process.env.SHIPMENT_MILESTONE_TABLE ||
        dynamoTableName === process.env.SHIPMENT_FILE_DATA_TABLE
      ) {
        data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
        fileNumber = get(data, 'FK_OrderNo', '');
        const headerParams = {
          TableName: process.env.SHIPMENT_HEADER_TABLE,
          KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
          ExpressionAttributeValues: {
            ':PK_OrderNo': fileNumber,
          },
        };
        const res = await getData(headerParams);
        if (!bioRadCustomerIds.includes(get(res, '[0].BillNo'))) {
          console.info('SKIPPING, This event is not related to bio rad.');
          return;
        }

        housebill = get(res, '[0].Housebill');

        if (dynamoTableName === process.env.APAR_FAILURE_TABLE) {
          eventType = 'exceptions';
          orderStatus = get(data, 'FDCode', '');
        } else if (dynamoTableName === process.env.SHIPMENT_FILE_DATA_TABLE) {
          if (get(data, 'CustomerAccess', '') !== 'Y') {
            console.info('SKIPPING, There is no customer access for this document.');
            throw new Error('SKIPPING, There is no customer access for this document.');
          }
          eventType = 'documents';
          orderStatus = get(data, 'FK_DocType', '');
        } else {
          eventType = 'milestones';
          orderStatus = get(data, 'FK_OrderStatusId', '');
        }
      } else {
        orderStatus = 'geolocation';
        eventType = 'geolocation';

        data = AWS.DynamoDB.Converter.unmarshall(get(message, 'dynamodb.NewImage', {}), eventType);
        housebill = get(data, 'HouseBillNo', get(message, 'housebill'));
        if (housebill) {
          const headerParams = {
            TableName: process.env.SHIPMENT_HEADER_TABLE,
            IndexName: 'Housebill-index',
            KeyConditionExpression: 'Housebill = :Housebill',
            ExpressionAttributeValues: {
              ':Housebill': housebill,
            },
          };
          const headerData = await getData(headerParams);
          console.info(headerData);
          fileNumber = get(headerData, '[0].PK_OrderNo');
          location = {
            latitude: get(data, 'latitude', get(message, 'latitude')),
            longitude: get(data, 'longitude', get(message, 'longitude')),
          };
        } else {
          console.info(`No housebill found for geo location event: ${record}`);
          throw new Error(`SKIPPING, No housebill found for geo location event: ${record}`);
        }
      }

      dynamoData.OrderStatus = orderStatus;
      const referenceData = await fetchRefernceNo(fileNumber);

      const orderId = get(
        referenceData.find(
          (obj) => get(obj, 'CustomerType') === 'B' && get(obj, 'FK_RefTypeId') === 'SID'
        ),
        'ReferenceNo',
        ''
      );
      if (orderId === '') {
        console.info('There is no frieght order Id for this shipment.');
        throw new Error('SKIPPING, There is no frieght order Id for this shipment.');
      }
      dynamoData.FreightOrderId = orderId;

      if (eventType !== 'geolocation') {
        await verifyIfEventAlreadySent(orderId);
      }

      console.info(
        'fileNumber, housebill, eventType, orderStatus ',
        fileNumber,
        housebill,
        eventType,
        orderStatus
      );
      const payload = await getPayloadData(
        fileNumber,
        housebill,
        location,
        data,
        dynamoData,
        referenceData,
        orderId
      );
      console.info(JSON.stringify(payload));

      if (get(payload, 'events[0].stopId', '') === '') {
        console.info('stopId is doesnt exit');
        throw new Error('SKIPPING, There is no stop Id exist for this shipment.');
      }
      console.info('payload: ', JSON.stringify(payload));
      const token = await getLbnToken();
      await sendOrderEventsLbn(token, payload);
      dynamoData.Status = get(CONSTANTS, 'statusVal.success', '');
      await putLogItem(dynamoData);
    } catch (error) {
      console.error('Error for orderNo: ', fileNumber);

      let errorMsgVal = '';
      if (get(error, 'message', null) !== null) {
        errorMsgVal = get(error, 'message', '');
      } else {
        errorMsgVal = error;
      }
      let flag = errorMsgVal.split(',')[0];
      if (flag !== 'SKIPPING') {
        flag = 'ERROR';
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
                      <p>We have an error while sending the order events(Milestones):</p>
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
            subject: `Bio Rad Send Order Events ${process.env.STAGE} ERROR`,
          });
          console.info('Notification has been sent');
        } catch (err) {
          console.info(
            '🚀 -> file: index.js:210 -> get -> Error while sending error notification:',
            err
          );
        }
      } else {
        errorMsgVal = errorMsgVal.split(',').slice(1);
      }
      dynamoData.ErrorMsg = errorMsgVal;
      dynamoData.Status = flag;
      await putLogItem(dynamoData);
    }
  } catch (error) {
    console.error('Error in handler catch block: ', error);
  }
};

async function getPayloadData(
  fileNumber,
  housebill,
  location,
  data,
  dynamoData,
  referenceData,
  orderId
) {
  try {
    const trackingData = await fetchTackingData(fileNumber);

    const slocid = get(
      referenceData.find(
        (obj) => get(obj, 'CustomerType') === 'S' && get(obj, 'FK_RefTypeId') === 'STO'
      ),
      'ReferenceNo',
      ''
    );
    const clocid = get(
      referenceData.find(
        (obj) => get(obj, 'CustomerType') === 'C' && get(obj, 'FK_RefTypeId') === 'STO'
      ),
      'ReferenceNo',
      ''
    );

    console.info('orderId, slocid, clocid', orderId, slocid, clocid);

    const stopIdValue = {
      slocid,
      clocid,
    };

    let events;
    let creationDateTimeUTC;
    if (eventType === 'milestones') {
      const eventObj = get(CONSTANTS, eventType, []).find((obj) =>
        get(obj, 'statusType', []).includes(orderStatus)
      );
      console.info('eventObj: ', eventObj);
      creationDateTimeUTC = moment.tz(get(data, 'CreateDateTime', ''), 'UTC');
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ss');
      console.info(creationDateTimeUTC);
      const weekNumber = moment.tz(creationDateTimeUTC, 'UTC').week();
      // const weekNumber = creationDateTimeUTC.isoWeek();
      let hoursToAdd;
      if (weekNumber >= 11 && weekNumber <= 44) {
        hoursToAdd = 5;
      } else {
        hoursToAdd = 6;
      }

      console.info('weekNumber: ', weekNumber);
      console.info('hours to add: ', hoursToAdd);
      creationDateTimeUTC = moment.utc(creationDateTimeUTC).utcOffset(5);
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ss[Z]');
      console.info('creationDateTimeUTC: ', creationDateTimeUTC);
      const substractTime = await getOffset(get(data, 'EventTimeZone', ''));
      console.info('substractTime: ', substractTime);
      let eventDateTimeUTC = await modifyTime(get(data, 'EventDateTime', ''));
      console.info('eventDateTimeUTC: ', eventDateTimeUTC);
      eventDateTimeUTC = moment.utc(eventDateTimeUTC).subtract(Number(substractTime), 'hours');
      eventDateTimeUTC = eventDateTimeUTC.format('YYYY-MM-DDTHH:mm:ss[Z]');
      console.info('eventDateTimeUTC: ', eventDateTimeUTC);

      events = [
        {
          natureOfEvent: '01',
          eventType: get(eventObj, 'eventType', ''),
          eventDateTimeUTC,
          stopId: get(stopIdValue, `${get(eventObj, 'stopId', '')}`, ''),
        },
      ];
    } else if (eventType === 'exceptions') {
      const eventObj = get(CONSTANTS, eventType, []).find((obj) =>
        get(obj, 'statusType', []).includes(orderStatus)
      );
      creationDateTimeUTC = await modifyTime(get(trackingData, 'DateTimeEntered', ''));
      events = [
        {
          natureOfEvent: '01',
          eventType: 'DELAYED',
          eventDateTimeUTC: creationDateTimeUTC,
          eventReasonCode: get(eventObj, 'eventType', ''),
          stopId: get(stopIdValue, `${get(eventObj, 'stopId', '')}`, ''),
        },
      ];
    } else if (eventType === 'geolocation') {
      creationDateTimeUTC = moment.tz(get(data, 'UTCTimeStamp', ''), 'UTC');
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ss[Z]');
      events = [
        {
          natureOfEvent: '01',
          eventType: 'GEOLOC',
          eventDateTimeUTC: creationDateTimeUTC,
          location,
          stopId: get(stopIdValue, 'slocid', ''),
        },
      ];
    } else {
      const docType = orderStatus.toUpperCase();
      console.info('document type: ', docType);
      const docData = await getDocsFromWebsli({ housebill, doctype: `doctype=${docType}` });

      creationDateTimeUTC = await modifyTime(get(data, 'UploadDateTime', ''));
      let stopId;
      if (get(CONSTANTS, `${eventType}.${orderStatus}`, '') === 'POPU') {
        stopId = 'slocid';
      } else {
        stopId = 'clocid';
      }
      console.info(
        'eventtype, orderStatus,  lbn eventType',
        eventType,
        orderStatus,
        get(CONSTANTS, `${eventType}.${orderStatus}`, '')
      );
      events = [
        {
          natureOfEvent: '01',
          eventType: get(CONSTANTS, `${eventType}.${orderStatus}`, ''),
          eventDateTimeUTC: creationDateTimeUTC,
          attachments: [],
          stopId: get(stopIdValue, stopId, ''),
        },
      ];
      console.info('document data: ', docData);
      if (docData.length > 0) {
        const fileName = get(docData, '[0].filename', '');
        let mimeType;
        let base64Str;
        if (fileName.includes('.pdf')) {
          base64Str = get(docData, '[0].b64str', '');
          mimeType = 'application/pdf';
        } else if (fileName.includes('.jpg')) {
          base64Str = await convertToPdf(Buffer.from(get(docData, '[0].b64str', ''), 'base64'));
          mimeType = 'application/pdf';
        } else if (fileName.includes('.jpeg')) {
          base64Str = get(docData, '[0].b64str', '');
          mimeType = 'image/jpeg';
        } else if (fileName.includes('.png')) {
          base64Str = get(docData, '[0].b64str', '');
          mimeType = 'image/png';
        }

        events[0].attachments.push({
          fileName,
          mimeType,
          fileContentBinaryObject: base64Str,
        });
      }
    }

    const shipmentData = await getShipmentData(orderId);

    dynamoData.FreightOrderId = orderId;
    return {
      shipper: {
        shipperLBNID: get(shipmentData, '[0].OrderingPartyLbnId', ''),
      },
      carrier: {
        carrierLBNID: get(shipmentData, '[0].CarrierPartyLbnId', ''),
      },
      technicalId: get(trackingData, 'Note', '').replace(/^technicalId /, ''),
      orderId,
      trackId: housebill,
      creationDateTimeUTC,
      events,
    };
  } catch (error) {
    console.info(error);
    throw error;
  }
}

async function sendOrderEventsLbn(token, payload) {
  try {
    const config = {
      url: process.env.LBN_SEND_ORDER_EVENTS_URL,
      method: 'post',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': token,
      },
      data: payload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    console.info('res: ', res);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Lbn main API Request Failed: ${res}`);
  } catch (error) {
    console.error('Lbn main API Request Failed: ', error);
    throw new Error(`Lbn main API Request Failed: ${error}`);
  }
}

async function verifyIfEventAlreadySent(orderId) {
  try {
    const Params = {
      TableName: process.env.LOGS_TABLE,
      IndexName: 'FreightOrderId-Index',
      KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
      FilterExpression: '#status = :status AND #process = :process AND #OrderStatus = :OrderStatus',
      ExpressionAttributeNames: {
        '#status': 'Status',
        '#process': 'Process',
        '#OrderStatus': 'OrderStatus',
      },
      ExpressionAttributeValues: {
        ':FreightOrderId': orderId,
        ':status': get(CONSTANTS, 'statusVal.success', ''),
        ':process': get(CONSTANTS, 'shipmentProcess.sendOrderEvents', ''),
        ':OrderStatus': orderStatus,
      },
    };

    const Result = await getData(Params);
    console.info(Result);
    if (Result.length > 0) {
      throw new Error(
        `SKIPPING, Milestone event already sent for this freight order Id: ${orderId}, Event: ${orderStatus}`
      );
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function convertToPdf(base64) {
  try {
    return new Promise((resolve) => {
      const pdfBuffer = [];
      const dimensions = sizeOf(base64);
      const doc = new PDFKIT({
        size: [get(dimensions, 'width'), get(dimensions, 'height')],
      });
      doc.on('data', (chunk) => pdfBuffer.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(pdfBuffer).toString('base64')));

      doc.image(base64, 0, 0, {
        width: get(dimensions, 'width'),
        height: get(dimensions, 'height'),
      });

      doc.end();
    });
  } catch (error) {
    console.error('Error while converting jpg to pdf', error);
    throw error;
  }
}
