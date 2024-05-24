'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const axios = require('axios');
const { getData } = require('../Shared/dynamo');
const moment = require('moment-timezone');
const {
  fetchTackingData,
  fetchRefernceNo,
  getDocsFromWebsli,
  fetchShipmentFile,
  modifyTime,
  getOffset,
  getLbnToken,
} = require('../Shared/dataHelper');

const bioRadCustomerIds = process.env.BIO_RAD_BILL_TO_NUMBERS.split(',');
let eventType;
let orderStatus;

module.exports.handler = async (event) => {
  try {
    console.info(event);
    const record = get(event, 'Records[2]', {});

    console.info('record: ', record);
    const recordBody = JSON.parse(get(record, 'body', {}));
    console.info('recordBody: ', recordBody);
    console.info(recordBody.Message);
    const message = JSON.parse(get(recordBody, 'Message', ''));
    console.info(message);
    const oldImage = get(message, 'OldImage', '');
    let fileNumber;
    let housebill;
    let location;
    let data;
    if (oldImage !== '') {
      console.info('Skipped as this is an update or delete shipment.');
    }
    if (
      get(message, 'dynamoTableName', '') === `omni-wt-rt-apar-failure-${process.env.STAGE}` ||
      get(message, 'dynamoTableName', '') === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`
    ) {
      console.info(message);
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
        console.info('This event is not related to bio rad. So, skipping the process.');
      }
      housebill = get(res, '[0].Housebill');

      if (get(message, 'dynamoTableName', '') === `omni-wt-rt-apar-failure-${process.env.STAGE}`) {
        eventType = 'exceptions';
        orderStatus = get(data, 'FDCode', '');
      } else if (['HAWB', 'HCPOD', 'POD'].includes(get(data, 'FK_OrderStatusId', ''))) {
        eventType = 'documents';
        orderStatus = get(data, 'FK_OrderStatusId', '');
      } else {
        eventType = 'milestones';
        orderStatus = get(data, 'FK_OrderStatusId', '');
      }

      console.info(data);
    } else if (
      get(message, 'eventSourceARN', '').split('/')[1] ===
      `omni-p44-shipment-location-updates-${process.env.STAGE}`
    ) {
      eventType = 'geolocation';

      data = AWS.DynamoDB.Converter.unmarshall(get(message, 'dynamodb.NewImage', {}), eventType);
      housebill = get(data, 'HouseBillNo');
      console.info(data);
      const headerParams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE,
        IndexName: 'Housebill-index',
        KeyConditionExpression: 'Housebill = :Housebill',
        ExpressionAttributeValues: {
          ':Housebill': get(data, 'HouseBillNo'),
        },
      };
      const res = await getData(headerParams);
      console.info(res);
      fileNumber = get(res, '[0].PK_OrderNo');
      location = {
        latitude: get(data, 'latitude'),
        longitute: get(data, 'longitude'),
      };
      console.info(location);
    } else {
      console.info('skipper the events as not matching the requirement');
    }

    console.info(fileNumber, housebill, eventType);
    const payload = await getPayloadData(fileNumber, housebill, location, data);
    console.info(payload);

    // const token = await getLbnToken();
    // await sendOrderEventsLbn(token, payload);

    console.info(eventType);
    // const dynamodBody =
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          Message: 'SUCCESS',
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error('Error in handler: ', error);
    return {
      statusCode: 400,
      body: JSON.stringify(
        {
          Message: 'Failed',
        },
        null,
        2
      ),
    };
  }
};

async function getPayloadData(orderNo, housebill, location, data) {
  try {
    console.info(orderNo);
    const trackingData = await fetchTackingData(orderNo);
    const referenceData = await fetchRefernceNo(orderNo);
    const orderId = get(referenceData.find(
      (obj) => get(obj, 'CustomerType') === 'B' && get(obj, 'FK_RefTypeId') === 'SID'
    ), 'ReferenceNo', '');
    const slocid = get(referenceData.find(
      (obj) => get(obj, 'CustomerType') === 'S' && get(obj, 'FK_RefTypeId') === 'STO'
    ), 'ReferenceNo', '');
    const clocid = get(referenceData.find(
      (obj) => get(obj, 'CustomerType') === 'C' && get(obj, 'FK_RefTypeId') === 'STO'
    ), 'ReferenceNo', '');

    console.info('orderId, slocid, clocid',orderId, slocid, clocid)

    const stopIdValue = {
      slocid,
      clocid
    };

    let events;
    let creationDateTimeUTC;
    if (eventType === 'milestones') {
      console.info(orderStatus)
      const eventObj = get(CONSTANTS, eventType, []).find((obj) =>
        get(obj, 'statusType', []).includes(orderStatus)
      );
      console.info('eventObj: ', eventObj)
      creationDateTimeUTC = moment.tz(get(data, 'CreateDateTime', ''), 'UTC');
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ss');
      console.info(creationDateTimeUTC)
      const weekNumber = moment.tz(creationDateTimeUTC, 'UTC').week();
      // const weekNumber = creationDateTimeUTC.isoWeek();
      let hoursToAdd;
      if (weekNumber >= 11 && weekNumber <= 44) {
        hoursToAdd = 5;
      } else {
        hoursToAdd = 6;
      }

      // creationDateTimeUTC = creationDateTimeUTC.utcOffset(`0${hoursToAdd}:00`);
      creationDateTimeUTC = moment.utc(creationDateTimeUTC).utcOffset(5);
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ssZ');
      creationDateTimeUTC = moment.utc(creationDateTimeUTC).add(hoursToAdd, 'hours');
      creationDateTimeUTC = creationDateTimeUTC.format('YYYY-MM-DDTHH:mm:ssZ');
      console.info('creationDateTimeUTC: ', creationDateTimeUTC);
      const substractTime = await getOffset(get(data, 'EventTimeZone', ''));
      console.info('substractTime: ', substractTime)
      let eventDateTimeUTC = await modifyTime(get(data, 'EventDateTime', ''));
      console.info('eventDateTimeUTC: ', eventDateTimeUTC)
      eventDateTimeUTC = moment.utc(eventDateTimeUTC).subtract(substractTime, 'hours');
      eventDateTimeUTC = eventDateTimeUTC.format('YYYY-MM-DDTHH:mm:ssZ')
      console.info('eventDateTimeUTC: ', eventDateTimeUTC)
      // eventDateTimeUTC = eventDateTimeUTC.subtract(Number(substractTime), 'hours');

      events = [
        {
          natureOfEvent: '01',
          eventType: get(eventObj, 'eventType', ''),
          eventDateTimeUTC,
          stopId: get(stopIdValue, `${get(eventObj, 'stopId', '')}`, ''),
        },
      ];
    } else if (eventType === 'exceptions') {
      console.info('orderStatus: ', orderStatus)
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
      creationDateTimeUTC = get(data, 'UTCTimeStamp', '');
      events = [
        {
          natureOfEvent: '01',
          eventType: 'GEOLOC',
          eventDateTimeUTC: get(data, 'UTCTimeStamp', ''),
          location,
          stopId: get(stopIdValue, 'slocid', ''),
        },
      ];
    } else {
      const docData = await getDocsFromWebsli({ housebill, doctype: 'doctype=fk_doctype' });

      const shipmentFileData = await fetchShipmentFile(orderNo);
      creationDateTimeUTC = await modifyTime(get(shipmentFileData, '[0].UploadDateTime', ''));
      let stopId;
      if (get(CONSTANTS, `${eventType}.${orderStatus}`, '') === 'POPU') {
        stopId = 'slocid';
      } else {
        stopId = 'clocid';
      }
      events = [
        {
          natureOfEvent: '01',
          eventType: get(CONSTANTS, `${eventType}.${orderStatus}`, ''),
          eventDateTimeUTC: creationDateTimeUTC,
          attachments: [
            {
              fileName: docData.filename,
              mimeType: 'application/pdf',
              fileContentBinaryObject: docData.b64str,
            },
          ],
          stopId: get(stopIdValue, stopId, ''),
        },
      ];
    }

    const Params = {
        TableName: process.env.LOGS_TABLE,
        IndexName: 'FreightOrderId-Index',
        KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
        FilterExpression: '#status = :status AND #process = :process',
        ExpressionAttributeNames: {
          '#status': 'Status',
          '#process': 'Process'
        },      
        ExpressionAttributeValues: {
          ':FreightOrderId': orderId,
          ':status': 'SUCCESS',
          ':process': 'CREATE'
        },
      };

console.info((Params))
      const Result = await getData(Params);
      console.info('bio rad data: ', Result)

    return {
      shipper: {
        shipperLBNID: '10020002328',
      },
      carrier: {
        carrierLBNID: '10020002561',
      },
      technicalId: get(trackingData, 'Note', ''),
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

const CONSTANTS = {
  milestones: [
    {
      statusType: ['PUP', 'TTC'],
      eventType: 'DEPARTURE',
      stopId: 'slocid',
    },
    {
      statusType: ['DEL'],
      eventType: 'ARRIV_DEST',
      stopId: 'clocid',
    },
    {
      statusType: ['HAWB'],
      eventType: 'POPU',
      stopId: 'slocid',
    },
    {
      statusType: ['HCPOD', 'POD'],
      eventType: 'POD',
      stopId: 'clocid',
    },
    {
      statusType: ['SRS'],
      eventType: 'RETURN',
      stopId: 'slocid',
    },
    {
      statusType: ['OFD'],
      eventType: 'OUT_FOR_DELIVERY',
      stopId: 'clocid',
    },
  ],
  exceptions: [
    {
      statusType: ['APP', 'DLE', 'SHORT', 'REFU', 'LAD', 'CON'],
      eventType: 'DELIVERY_MISSED',
      stopId: 'clocid',
    },
    {
      statusType: ['FTUSP', 'INMIL', 'BADDA', 'FAOUT', 'NTDT', 'OMNII'],
      eventType: 'TRACKING_ERROR',
      stopId: 'clocid',
    },
    {
      statusType: ['MTT', 'HUB'],
      eventType: 'MISSED_CONNECTION',
      stopId: 'clocid',
    },
    {
      statusType: ['SOS'],
      eventType: 'FORCEOFNATURE',
      stopId: 'clocid',
    },
    {
      statusType: ['COS'],
      eventType: 'PACKAGINDAMAGED',
      stopId: 'slocid',
    },
    {
      statusType: ['CUP', 'PUE', 'LATEB', 'MISCU', 'SHI'],
      eventType: 'PICKUP_MISSED',
      stopId: 'slocid',
    },
    {
      statusType: ['DAM'],
      eventType: 'DAMAGED',
      stopId: 'slocid',
    },
    {
      statusType: ['LPU', 'DEL'],
      eventType: 'LATE_DEPARTURE',
      stopId: 'slocid',
    },
  ],
  geolocation: {
    HAWB: 'POPU',
    HCPOD: 'POD',
    POD: 'POD',
  },
};

async function sendOrderEventsLbn(token, payload) {
  try {
    const config = {
      url: process.env.LBN_SEND_ORDER_EVENTS_URL,
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
