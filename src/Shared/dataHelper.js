'use strict';

const AWS = require('aws-sdk');
const ses = new AWS.SES();
const xml2js = require('xml2js');
const { get } = require('lodash');
const axios = require('axios');
const moment = require('moment-timezone');
const xmlJs = require('xml-js');
const { getData } = require('./dynamo');
const { CONSTANTS } = require('./constants');

async function xmlJsonConverter(xmlData) {
  try {
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
    });
    return await parser.parseStringPromise(xmlData);
  } catch (error) {
    console.error('Error in xmlToJson: ', error);
    throw error;
  }
}

async function querySourceDb(query) {
  try {
    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: process.env.UPDATE_SOURCE_DB_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.UPDATE_SOURCE_DB_API_KEY,
      },
      data: { query },
    };
    console.info('🚀 -> file: dataHelper.js:38 -> querySourceDb -> config:', config);

    const res = await axios.request(config);
    console.info('🚀 -> file: dataHelper.js:41 -> querySourceDb -> res:', res);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Update source db API Request Failed: ${res}`);
  } catch (error) {
    console.error('Update source db API Request Failed: ', error);
    throw new Error(`Update source db API Request Failed: ${error}`);
  }
}

async function sendToWT(postData) {
  try {
    const config = {
      url: process.env.WT_URL,
      method: 'post',
      headers: {
        'Content-Type': 'text/xml',
        'soapAction': 'http://tempuri.org/AddNewShipmentV3',
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      console.info('WT result: ', res);
      return get(res, 'data', '');
    }
    throw new Error(`WORLD TRAK API Request Failed: ${res}`);
  } catch (error) {
    console.error('WORLD TRAK API Request Failed: ', error);
    throw new Error(`WORLD TRAK API Request Failed: ${error}`);
  }
}

async function prepareHeaderData(eventBody) {
  const headerData = {
    DelBy: 'Between',
    DeclaredType: 'LL',
    CustomerNo: 1848,
    PayType: 3,
    ShipmentType: 'Shipment',
    IncoTermsCode: get(eventBody, 'incoterm', ''),
  };
  let specialInstructions = '';
  await Promise.all(
    get(eventBody, 'notes', []).map(async (note) => {
      specialInstructions += get(note, 'text', '')
        .replace(/\n/g, '&#10;')
        .replace(/<br>/g, '&#10;');
    })
  );
  headerData.SpecialInstructions = specialInstructions;
  if (get(CONSTANTS, `mode.${get(eventBody, 'shippingTypeCode', '')}`, '') !== '') {
    headerData.Mode = get(CONSTANTS, `mode.${get(eventBody, 'shippingTypeCode', '')}`, '');
  }
  return headerData;
}

async function prepareShipperAndConsigneeData(loadingStage, unloadingStage) {
  return {
    Station: get(
      CONSTANTS,
      `station.${get(loadingStage, 'loadingLocation.address.country', '')}`,
      'SFO'
    ),
    ShipperName: get(loadingStage, 'loadingLocation.address.name', ''),
    ShipperAddress1: `${get(loadingStage, 'loadingLocation.address.house', '')} ${get(loadingStage, 'loadingLocation.address.street', '')}`,
    ShipperCity: get(loadingStage, 'loadingLocation.address.city', ''),
    ShipperState: get(loadingStage, 'loadingLocation.address.region', ''),
    ShipperCountry: get(loadingStage, 'loadingLocation.address.country', ''),
    ShipperZip: get(loadingStage, 'loadingLocation.address.postalCode', ''),
    ShipperPhone: `${get(loadingStage, 'loadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(loadingStage, 'loadingLocation.address.phoneNumber.areaId', '')} ${get(loadingStage, 'loadingLocation.address.phoneNumber.subscriberId', '')}`,
    ShipperFax: get(loadingStage, 'loadingLocation.address.faxNumber.subscriberId', ''),
    ShipperEmail: get(loadingStage, 'loadingLocation.address.emailAddress', ''),
    ConsigneeName: get(unloadingStage, 'unloadingLocation.address.name', ''),
    ConsigneeAddress1: `${get(unloadingStage, 'unloadingLocation.address.house', '')} ${get(unloadingStage, 'unloadingLocation.address.street', '')}`,
    ConsigneeCity: get(unloadingStage, 'unloadingLocation.address.city', ''),
    ConsigneeState: get(unloadingStage, 'unloadingLocation.address.region', ''),
    ConsigneeCountry: get(unloadingStage, 'unloadingLocation.address.country', ''),
    ConsigneeZip: get(unloadingStage, 'unloadingLocation.address.postalCode', ''),
    ConsigneePhone: `${get(unloadingStage, 'unloadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(unloadingStage, 'unloadingLocation.address.phoneNumber.areaId', '')} ${get(unloadingStage, 'unloadingLocation.address.phoneNumber.subscriberId', '')}`,
    ConsigneeFax: get(unloadingStage, 'unloadingLocation.address.faxNumber.subscriberId', ''),
    ConsigneeEmail: get(unloadingStage, 'unloadingLocation.address.emailAddress', ''),
    BillToAcct: get(
      CONSTANTS,
      `billNo.${get(unloadingStage, 'unloadingLocation.address.country', '')}`,
      '8061'
    ),
  };
}

async function prepareReferenceList(loadingStage, unloadingStage, dynamoData) {
  const referenceList = {
    ReferenceList: {
      NewShipmentRefsV3: [
        {
          ReferenceNo: get(loadingStage, 'senderSystemStageID', ''),
          CustomerTypeV3: 'Shipper',
          RefTypeId: 'DL#',
        },
        {
          ReferenceNo: get(loadingStage, 'loadingLocation.id', ''),
          CustomerTypeV3: 'Shipper',
          RefTypeId: 'STP',
        },
        {
          ReferenceNo: get(unloadingStage, 'unloadingLocation.id', ''),
          CustomerTypeV3: 'Consignee',
          RefTypeId: 'STP',
        },
        {
          ReferenceNo: get(dynamoData, 'FreightOrderId', ''),
          CustomerTypeV3: 'BillTo',
          RefTypeId: 'SID',
        },
        {
          ReferenceNo: get(dynamoData, 'OrderingPartySourceSystemBusinessPartnerID', ''),
          CustomerTypeV3: 'BillTo',
          RefTypeId: 'STP',
        },
      ],
    },
  };
  return referenceList;
}

async function prepareShipmentLineListDate(items) {
  const shipmentList = await Promise.all(
    items.map(async (item) => {
      let hazmatValue;
      if (get(item, 'dangerousGoods', '') === false) {
        hazmatValue = 0;
      } else {
        hazmatValue = 1;
      }
      return {
        PieceType: get(item, 'packageTypeCode', ''),
        Description: get(item, 'description', '').slice(0, 35),
        Hazmat: hazmatValue,
        Weigth: get(item, 'grossWeight.value', 0),
        WeightUOMV3: get(CONSTANTS, `grossWeight.${get(item, 'grossWeight.unit', '')}`, 'lb'),
        Pieces: get(item, 'pieces.value', 0),
        Length: get(item, 'length.value', 0),
        DimUOMV3: get(CONSTANTS, `DimUOMV3.${get(item, 'length.unit', '')}`, 'in'),
        Width: get(item, 'width.value', 0),
        Height: get(item, 'height.value', 0),
      };
    })
  );
  return {
    ShipmentLineList: {
      NewShipmentDimLineV3: shipmentList,
    },
  };
}

async function prepareDateValues(loadingStage, unloadingStage) {
  try {
    const readyDate = moment
      .utc(get(loadingStage, 'requestedLoadingTimeStart'))
      .add(
        get(CONSTANTS, `timeAway.${get(loadingStage, 'loadingLocationTimezone', 'CST')}`, 0),
        'hours'
      )
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const closeTime = moment
      .utc(get(loadingStage, 'requestedLoadingTimeEnd'))
      .add(
        get(CONSTANTS, `timeAway.${get(loadingStage, 'loadingLocationTimezone', 'CST')}`, 0),
        'hours'
      )
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const deliveryDate = moment
      .utc(get(unloadingStage, 'requestedUnloadingTimeStart'))
      .add(
        get(CONSTANTS, `timeAway.${get(unloadingStage, 'unloadingLocationTimezone', 'CST')}`, 0),
        'hours'
      )
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const deliveryTime = moment
      .utc(get(unloadingStage, 'requestedUnloadingTimeEnd'))
      .add(
        get(CONSTANTS, `timeAway.${get(unloadingStage, 'unloadingLocationTimezone', 'CST')}`, 0),
        'hours'
      )
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    return {
      ReadyDate: readyDate,
      ReadyTime: readyDate,
      CloseTime: closeTime,
      DeliveryDate: deliveryDate,
      DeliveryTime: deliveryTime,
      DeliveryTime2: deliveryTime,
    };
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function prepareWTPayload(
  headerData,
  shipperAndConsignee,
  referenceList,
  shipmentLineList,
  dateValues,
  serviceLevel
) {
  try {
    const finalData = {
      '_declaration': {
        _attributes: {
          version: '1.0',
          encoding: 'UTF-8',
          standalone: 'yes',
        },
      },
      'soap12:Envelope': {
        '_attributes': {
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
          'xmlns:soap12': 'http://schemas.xmlsoap.org/soap/envelope/',
        },
        'soap12:Header': {
          AuthHeader: {
            _attributes: {
              xmlns: 'http://tempuri.org/',
            },
            UserName: {
              _text: 'saplbn',
            },
            Password: {
              _text: 'saplbn',
            },
          },
        },
        'soap12:Body': {
          AddNewShipmentV3: {
            _attributes: {
              xmlns: 'http://tempuri.org/',
            },
            oShipData: {
              ...headerData,
              ...shipperAndConsignee,
              ...referenceList,
              ...shipmentLineList,
              ...dateValues,
              ServiceLevel: serviceLevel,
            },
          },
        },
      },
    };

    const xmlPayload = xmlJs.json2xml(finalData, { compact: true, spaces: 2, sanitize: false });

    return { xmlPayload, jsonPayload: finalData };
  } catch (error) {
    console.error('Error while preparing payload ', error);
    throw error;
  }
}

async function groupItems(items) {
  const grouped = items.reduce((result, obj) => {
    const key = `${obj.shipFromLocationId}-${obj.shipToLocationId}`;
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(obj);
    return result;
  }, {});

  return grouped;
}

async function getServiceLevel(stages, source, destination) {
  let currentLocation = source;
  let totalDuration = 0;
  function getNextShipment() {
    return stages.find((obj) => get(obj, 'loadingLocation.id', '') === currentLocation);
  }
  function getServiceLevelValue() {
    return get(CONSTANTS, 'serviceLevel', []).find(
      (obj) => totalDuration > obj.min && totalDuration <= obj.max
    );
  }
  while (currentLocation !== destination) {
    const nextStage = getNextShipment();
    if (!nextStage || get(nextStage, 'totalDuration.value', '') === '') {
      throw new Error(
        `Cannot get the total duration from the connecting stages, please provide the total duration for this shipment from ${source} to ${destination}`
      );
    }
    const duration = moment.duration(get(nextStage, 'totalDuration.value', 'PT0S')).asHours();
    totalDuration += Number(duration);
    currentLocation = get(nextStage, 'unloadingLocation.id', '');

    if (currentLocation === destination) {
      if (totalDuration > 120) {
        return 'E7';
      }
      const result = getServiceLevelValue();
      return get(result, 'value', '');
    }
  }
  throw new Error(
    `Cannot get the total duration from the connecting stages, please provide the total duration for this shipment from ${source} to ${destination}`
  );
}

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

async function getDocsFromWebsli({ housebill, doctype }) {
  try {
    const url = `${process.env.GET_DOCUMENT_URL}/housebill=${housebill}/${doctype}`;
    console.info(url);
    const queryType = await axios.get(url);
    const docs = get(queryType, 'data.wtDocs.wtDoc', []);
    return docs.map((doc) => ({
      filename: doc.filename,
      b64str: doc.b64str,
    }));
  } catch (error) {
    const message = get(error, 'response.data', '');
    console.error(
      'error while calling websli endpoint: ',
      message === '' ? error.message : message
    );
    if (message === 'not found') {
      return [];
    }
    throw error;
  }
}

async function sendToLbn(token, payload, dynamoData) {
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

async function cancelShipmentApiCall(housebill) {
  try {
    const xmlString = `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body>
        <UpdateStatus xmlns="http://tempuri.org/">
        <HandlingStation></HandlingStation>
        <HAWB>${housebill}</HAWB>
        <UserName>saplbn</UserName>
        <StatusCode>CAN</StatusCode>
        </UpdateStatus>
      </soap:Body>
    </soap:Envelope>`;

    const config = {
      url: process.env.CANCEL_SHIPMENT_URL,
      method: 'post',
      headers: {
        'Accept': 'text/xml',
        'Content-Type': 'text/xml',
      },
      data: xmlString,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    let message = '';
    if (get(res, 'status', '') !== 200) {
      console.info(get(res, 'data', ''));
      throw new Error(`CANCEL API Request Failed: ${res}`);
    } else {
      // Verify if the WT api request is success or failed
      const response = await xmlJsonConverter(get(res, 'data', ''));
      message = get(
        response,
        'soap:Envelope.soap:Body.UpdateStatusResponse.UpdateStatusResult',
        ''
      );
      console.info('message: ', message);
      if (message === 'true') {
        message = 'Success';
      } else {
        message = 'Failed';
      }
    }
    return { message, housebill };
  } catch (error) {
    console.error(`For ${housebill} API request failed: `, error);
    return { message: 'Failed', housebill };
  }
}

async function fetchTackingData(orderNo) {
  try {
    const params = {
      TableName: 'omni-wt-rt-tracking-notes-dev',
      IndexName: `omni-tracking-notes-orderNo-index-${process.env.STAGE}`,
      KeyConditionExpression: 'FK_OrderNo = :FK_OrderNo',
      ExpressionAttributeValues: {
        ':FK_OrderNo': orderNo,
      },
    };
    const res = await getData(params);
    const trackingData = res.find((obj) => get(obj, 'Note', '').includes('technicalId'));
    return trackingData;
  } catch (error) {
    console.info('Error while fetching tracking data: ', error);
    throw error;
  }
}

async function fetchRefernceNo(orderNo) {
  try {
    const params = {
      TableName: process.env.REFERENCE_TABLE,
      IndexName: `omni-wt-rt-ref-orderNo-index-${process.env.STAGE}`,
      KeyConditionExpression: 'FK_OrderNo = :FK_OrderNo',
      ExpressionAttributeValues: {
        ':FK_OrderNo': orderNo,
      },
    };
    const res = await getData(params);
    return res;
  } catch (error) {
    console.info('Error while fetching reference data: ', error);
    throw error;
  }
}

async function modifyTime(dateTime) {
  try {
    const dateTimeUTC = moment.tz(dateTime, 'UTC');
    const weekNumber = moment.tz(dateTimeUTC, 'UTC').week();
    let hoursToAdd;
    if (weekNumber >= 11 && weekNumber <= 44) {
      hoursToAdd = 5;
    } else {
      hoursToAdd = 6;
    }

    dateTimeUTC.add(hoursToAdd, 'hours');

    return dateTimeUTC.format('YYYY-MM-DDTHH:mm:ss[Z]');
  } catch (error) {
    console.info('Modify time: ', error);
    throw error;
  }
}

async function getOffset(dateTime) {
  try {
    const params = {
      TableName: 'omni-wt-rt-timezone-master-dev',
      KeyConditionExpression: 'PK_TimeZoneCode = :PK_TimeZoneCode',
      ExpressionAttributeValues: {
        ':PK_TimeZoneCode': dateTime,
      },
    };
    const res = await getData(params);
    return get(res, '[0].HoursAway', 0);
  } catch (error) {
    console.info('Modify time: ', error);
    throw error;
  }
}

async function getShipmentData(orderId) {
  try {
    const Params = {
      TableName: process.env.LOGS_TABLE,
      IndexName: 'FreightOrderId-Index',
      KeyConditionExpression: 'FreightOrderId = :FreightOrderId',
      FilterExpression: '#status = :status AND #process = :process',
      ExpressionAttributeNames: {
        '#status': 'Status',
        '#process': 'Process',
      },
      ExpressionAttributeValues: {
        ':FreightOrderId': orderId,
        ':status': 'SUCCESS',
        ':process': 'CREATE',
      },
    };

    // console.info(Params);
    const Result = await getData(Params);
    // console.info('bio rad data: ', Result);
    return Result;
  } catch (error) {
    console.info('error while reading shipment data from logs table: ', orderId);
    throw error;
  }
}

async function sendSESEmail({ message, subject }) {
  try {
    const emailArray = process.env.NOTIFICATION_EMAILS.split(',');
    const params = {
      Destination: {
        ToAddresses: emailArray,
      },
      Message: {
        Body: {
          Html: {
            Data: message,
            Charset: 'UTF-8',
          },
        },
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
      },
      Source: 'no-reply@omnilogistics.com',
    };
    console.info('🚀 ~ file: helper.js:1747 ~ sendSESEmail ~ params:', params);

    await ses.sendEmail(params).promise();
  } catch (error) {
    console.error('Error sending email with SES:', error);
    throw error;
  }
}

module.exports = {
  sendSESEmail,
  xmlJsonConverter,
  querySourceDb,
  sendToWT,
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
  getServiceLevel,
  groupItems,
  sendToLbn,
  getDocsFromWebsli,
  getLbnToken,
  cancelShipmentApiCall,
  fetchTackingData,
  fetchRefernceNo,
  modifyTime,
  getOffset,
  getShipmentData,
};
