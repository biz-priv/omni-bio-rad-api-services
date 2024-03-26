'use strict';

const { get } = require('lodash');
const moment = require('moment-timezone');
const xml2js = require('xml2js');

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

module.exports = {
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
};
