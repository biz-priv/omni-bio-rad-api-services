'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const axios = require('axios');
const uuid = require('uuid');
const moment = require('moment-timezone');
const xml2js = require('xml2js');
const sql = require('mssql');
const { putLogItem } = require('../Shared/dynamo');
const { xmlJsonConverter } = require('../Shared/dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  // console.info(event);

  try {
    const eventBody = get(event, 'body', {});

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = event;
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'CANCEL';
    dynamoData.XmlPayload = {};
    dynamoData.FreightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrierPartyLbnId', '');
    dynamoData.CallInPhone = `${get(eventBody, 'orderingParty.address.phoneNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.phoneNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.phoneNumber.subscriberId', '')}`;
    dynamoData.CallInFax = `${get(eventBody, 'orderingParty.address.faxNumber.countryDialingCode', '1')} ${get(eventBody, 'orderingParty.address.faxNumber.areaId', '')} ${get(eventBody, 'orderingParty.address.faxNumber.subscriberId', '')}`;
    dynamoData.QuoteContactEmail = get(eventBody, 'orderingParty.address.emailAddress', '');

    console.info(dynamoData.CSTDateTime);

    const headerData = await prepareHeaderData(eventBody);
    console.info(headerData);

    const transportationStages = get(eventBody, 'transportationStages', []);
    const items = get(eventBody, 'items', []);

    // Prepare payload and create shipments in world trak.
    const apiResponses = await Promise.all(
      transportationStages.map(async (stage) => {
        try {
          const shipperAndConsignee = await prepareShipperAndConsigneeData(stage);
          console.info(shipperAndConsignee);

          const referenceList = await prepareReferenceList(stage, eventBody);
          console.info(JSON.stringify(referenceList));

          const shipmentLineList = await prepareShipmentLineListDate(
            items,
            get(stage, 'assignedItems', [])
          );
          console.info(JSON.stringify(shipmentLineList));

          const dateValues = await prepareDateValues(stage);
          console.info(dateValues);

          const xmlPayload = await prepareWTPayload(
            headerData,
            shipperAndConsignee,
            referenceList,
            shipmentLineList,
            dateValues
          );
          console.info(xmlPayload);

          const xmlResponse = await sendToWT(xmlPayload);

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
          console.info(housebill, fileNumber);
          return { housebill, fileNumber };
        } catch (error) {
          console.info('Error in transportation Stage');
          return [stage, 'Failed'];
        }
      })
    );
    console.info(apiResponses);

    const eventArray = ['sendToLbn', 'updateDb'];
    const finalResponses = await Promise.all(
      eventArray.map(async (eventType) => {
        await sendToLbnAndUpdateInSourceDb(eventType, apiResponses);
      })
    );

    console.info(finalResponses);

    // Set the time zone to CST
    const cstDate1 = moment().tz('America/Chicago');

    console.info(cstDate1.format('YYYY-MM-DD HH:mm:ss SSS'));

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
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(event)}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${'log table'} for understanding the complete data.`,
        Subject: `Bio Rad Cancel Shipment ERROR ${context.functionName}`,
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
          message: error,
        },
        null,
        2
      ),
    };
  }
};

async function prepareShipperAndConsigneeData(data) {
  return {
    ShipperName: get(data, 'loadingLocation.address.name', ''),
    ShipperAddress1: `${get(data, 'loadingLocation.address.street', '')} ${get(data, 'loadingLocation.address.house', '')}`,
    ShipperCity: get(data, 'loadingLocation.address.city', ''),
    ShipperState: get(data, 'loadingLocation.address.region', ''),
    ShipperCountry: get(data, 'loadingLocation.address.country', ''),
    ShipperZip: get(data, 'loadingLocation.address.postalCode', ''),
    ShipperPhone: `+${get(data, 'loadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(data, 'loadingLocation.address.phoneNumber.areaId', '')} ${get(data, 'loadingLocation.address.phoneNumber.subscriberId', '')}`,
    ShipperFax: get(data, 'loadingLocation.address.faxNumber.subscriberId', ''),
    ShipperEmail: get(data, 'loadingLocation.address.emailAddress', ''),
    ConsigneeName: get(data, 'unloadingLocation.address.name', ''),
    ConsigneeAddress1: `${get(data, 'unloadingLocation.address.street', '')} ${get(data, 'unloadingLocation.address.house', '')}`,
    ConsigneeCity: get(data, 'unloadingLocation.address.city', ''),
    ConsigneeState: get(data, 'unloadingLocation.address.region', ''),
    ConsigneeCountry: get(data, 'unloadingLocation.address.country', ''),
    ConsigneeZip: get(data, 'unloadingLocation.address.postalCode', ''),
    ConsigneePhone: `+${get(data, 'unloadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(data, 'unloadingLocation.address.phoneNumber.areaId', '')} ${get(data, 'unloadingLocation.address.phoneNumber.subscriberId', '')}`,
    ConsigneeFax: get(data, 'unloadingLocation.address.faxNumber.subscriberId', ''),
    ConsigneeEmail: get(data, 'unloadingLocation.address.emailAddress', ''),
    BillNo: get(CONSTANTS, `billNo.${get(data, 'unloadingLocation.address.country', '')}`, '8061'),
    Station: get(CONSTANTS, `station.${get(data, 'loadingLocation.address.country', '')}`, 'SFO'),
  };
}

async function prepareReferenceList(data, eventBody) {
  const referenceList = {
    ReferenceList: {
      NewShipmentRefsV3: [
        {
          ReferenceNo: get(data, 'loadingLocation.id', ''),
          CustomerTypeV3: 'Shipper',
          RefTypeId: 'STP',
        },
        {
          ReferenceNo: get(data, 'unloadingLocation.id', ''),
          CustomerTypeV3: 'Consignee',
          RefTypeId: 'STP',
        },
        {
          ReferenceNo: get(eventBody, 'freightOrderId', ''),
          CustomerTypeV3: 'BillTo',
          RefTypeId: 'SID',
        },
      ],
    },
  };
  return referenceList;
}

async function prepareShipmentLineListDate(data, id) {
  const items = data.filter((item) => id.includes(item.id));

  const shipmentList = await Promise.all(
    items.map(async (item) => {
      return {
        PieceType: get(item, 'packageTypeCode', ''),
        Description: get(item, 'description', '').slice(0, 35),
        Hazmat: 0,
        Weigth: get(item, 'grossWeight.value', 0),
        WeightUOMV3: 'lb',
        Pieces: get(item, 'pieces.value', 0),
        Length: 15,
        DimUOMV3: 'in',
        Width: 16,
        Height: 17,
      };
    })
  );
  return {
    ShipmentLineList: {
      NewShipmentDimLineV3: shipmentList,
    },
  };
}

const CONSTANTS = {
  mode: { 17: 'Domestic', 18: 'Truckload' },
  timeAway: {
    MST: -1,
    MDT: -2,
    HST: -5,
    HDT: -5,
    CST: 0,
    CDT: 0,
    AST: -3,
    ADT: -3,
    EST: 1,
    EDT: 1,
    PST: -2,
    PDT: -2,
  },
  station: {
    CA: 'YYZ',
    US: 'SFO',
  },
  billNo: {
    CA: '8061',
    US: '8062',
  },
};

async function prepareHeaderData(eventBody) {
  return {
    DeclaredType: 'LL',
    CustomerNo: 1848,
    PayType: 3,
    ShipmentType: 'Shipment',
    Mode: get(CONSTANTS, `mode.${get(eventBody, 'shippingTypeCode', '')}`, ''),
    IncoTermsCode: get(eventBody, 'incoterm', ''),
  };
}

async function prepareWTPayload(
  headerData,
  shipperAndConsignee,
  referenceList,
  shipmentLineList,
  dateValues
) {
  try {
    const finalData = {
      ...headerData,
      ...shipperAndConsignee,
      ...referenceList,
      ...shipmentLineList,
      ...dateValues,
    };

    const xmlBuilder = new xml2js.Builder({
      render: {
        pretty: true,
        indent: '    ',
        newline: '\n',
      },
    });

    const xmlPayload = xmlBuilder.buildObject({
      'soap12:Envelope': {
        '$': {
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
          'xmlns:soap12': 'http://schemas.xmlsoap.org/soap/envelope/',
        },
        'soap12:Header': {
          AuthHeader: {
            $: {
              xmlns: 'http://tempuri.org/',
            },
            UserName: 'saplbn',
            Password: 'saplbn',
          },
        },
        'soap12:Body': {
          AddNewShipmentV3: {
            $: {
              xmlns: 'http://tempuri.org/',
            },
            oShipData: finalData,
          },
        },
      },
    });
    return xmlPayload;
  } catch (error) {
    console.error('Error while preparing payload ', error);
    throw error;
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
      return get(res, 'data', '');
    }
    throw new Error(`WORLD TRAK API Request Failed: ${res}`);
  } catch (error) {
    console.error('WORLD TRAK API Request Failed: ', error);
    throw error;
  }
}

async function prepareDateValues(data) {
  try {
    const serviceLevel = moment.duration(get(data, 'totalDuration.value', 'PT0S')).asHours();
    const readyDate = moment
      .utc(get(data, 'requestedLoadingTimeStart'))
      .add(get(CONSTANTS, `timeAway.${get(data, 'loadingLocationTimezone', 'CST')}`, 0), 'hours')
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const closeTime = moment
      .utc(get(data, 'requestedLoadingTimeEnd'))
      .add(get(CONSTANTS, `timeAway.${get(data, 'loadingLocationTimezone', 'CST')}`, 0), 'hours')
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const deliveryDate = moment
      .utc(get(data, 'requestedUnloadingTimeStart'))
      .add(get(CONSTANTS, `timeAway.${get(data, 'unloadingLocationTimezone', 'CST')}`, 0), 'hours')
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    const deliveryTime = moment
      .utc(get(data, 'requestedUnloadingTimeEnd'))
      .add(get(CONSTANTS, `timeAway.${get(data, 'unloadingLocationTimezone', 'CST')}`, 0), 'hours')
      .format('YYYY-MM-DDTHH:mm:ss-00:00');
    return {
      ServiceLevel: serviceLevel,
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

async function sendToLbnAndUpdateInSourceDb(eventType, responses) {
  try {
    const fileNumberArray = responses.map((obj) => obj.fileNumber);
    console.info('fileNumberArray: ', fileNumberArray);
    if (eventType === 'updateDb') {
      const updateQuery = `update tbl_shipmentheader set
      CallInPhone=${get(dynamoData, 'CallInPhone', '')},
      CallInFax=${get(dynamoData, 'CallInFax', '')},
      QuoteContactEmail=${get(dynamoData, 'QuoteContactEmail', '')}
      where fk_orderno in (${fileNumberArray.join(',')});`;

      console.info('getQuery: ', updateQuery);
      const request = await connectToSQLServer();
      const result = await request.query(updateQuery);
      console.info(result);
    } else {
      const businessDocumentReferences = responses.map(async (response) => {
        return {
          documentId: get(response, 'housebill', ''),
          documentTypeCode: 'T51',
        };
      });
      const payload = {
        carrierPartyLbnId: get(dynamoData, 'CarrierPartyLbnId', ''),
        confirmationStatus: 'CAN',
        businessDocumentReferences,
      };

      await sendToLbn(payload);
    }
  } catch (error) {
    console.error(error);
  }
}

async function connectToSQLServer() {
  const config = {
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    options: {
      trustServerCertificate: true, // For self-signed certificates (optional)
    },
  };

  try {
    await sql.connect(config);
    console.info('Connected to SQL Server');
    const request = new sql.Request();
    return request;
  } catch (err) {
    console.error('Error: ', err);
    throw err;
  }
}

async function sendToLbn(payload) {
  try {
    const config = {
      url: process.env.WT_URL,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
      },
      data: payload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`WORLD TRAK API Request Failed: ${res}`);
  } catch (error) {
    console.error('WORLD TRAK API Request Failed: ', error);
    throw error;
  }
}
