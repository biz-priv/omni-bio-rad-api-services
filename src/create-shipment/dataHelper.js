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
  grossWeight: {
    LBR: 'lb',
  },
  DimUOMV3: {
    INH: 'in',
    CMT: 'cm',
  },
  serviceLevel: [
    { min: 0, max: 24, value: 'ND' },
    { min: 24, max: 48, value: '2D' },
    { min: 28, max: 60, value: '3A' },
    { min: 60, max: 72, value: '3D' },
    { min: 72, max: 96, value: '4D' },
    { min: 96, max: 120, value: 'EC' },
  ],
};

async function prepareHeaderData(eventBody) {
  const headerData = {
    DelBy: 'Between',
    DeclaredType: 'LL',
    CustomerNo: 1848,
    PayType: 3,
    ShipmentType: 'Shipment',
    IncoTermsCode: get(eventBody, 'incoterm', ''),
  };
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
    ShipperPhone: `+${get(loadingStage, 'loadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(loadingStage, 'loadingLocation.address.phoneNumber.areaId', '')} ${get(loadingStage, 'loadingLocation.address.phoneNumber.subscriberId', '')}`,
    ShipperFax: get(loadingStage, 'loadingLocation.address.faxNumber.subscriberId', ''),
    ShipperEmail: get(loadingStage, 'loadingLocation.address.emailAddress', ''),
    ConsigneeName: get(unloadingStage, 'unloadingLocation.address.name', ''),
    ConsigneeAddress1: `${get(unloadingStage, 'unloadingLocation.address.house', '')} ${get(unloadingStage, 'unloadingLocation.address.street', '')}`,
    ConsigneeCity: get(unloadingStage, 'unloadingLocation.address.city', ''),
    ConsigneeState: get(unloadingStage, 'unloadingLocation.address.region', ''),
    ConsigneeCountry: get(unloadingStage, 'unloadingLocation.address.country', ''),
    ConsigneeZip: get(unloadingStage, 'unloadingLocation.address.postalCode', ''),
    ConsigneePhone: `+${get(unloadingStage, 'unloadingLocation.address.phoneNumber.countryDialingCode', '')} ${get(unloadingStage, 'unloadingLocation.address.phoneNumber.areaId', '')} ${get(unloadingStage, 'unloadingLocation.address.phoneNumber.subscriberId', '')}`,
    ConsigneeFax: get(unloadingStage, 'unloadingLocation.address.faxNumber.subscriberId', ''),
    ConsigneeEmail: get(unloadingStage, 'unloadingLocation.address.emailAddress', ''),
    BillToAcct: get(
      CONSTANTS,
      `billNo.${get(unloadingStage, 'unloadingLocation.address.country', '')}`,
      '8061'
    ),
  };
}

async function prepareReferenceList(loadingStage, unloadingStage, eventBody) {
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
          ReferenceNo: get(eventBody, 'freightOrderId', ''),
          CustomerTypeV3: 'BillTo',
          RefTypeId: 'SID',
        },
      ],
    },
  };
  return referenceList;
}

async function prepareShipmentLineListDate(items) {
  const shipmentList = await Promise.all(
    items.map(async (item) => {
      let hazmatValue = 0;
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
      ...headerData,
      ...shipperAndConsignee,
      ...referenceList,
      ...shipmentLineList,
      ...dateValues,
      ServiceLevel: serviceLevel,
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

module.exports = {
  CONSTANTS,
  prepareHeaderData,
  prepareShipperAndConsigneeData,
  prepareReferenceList,
  prepareShipmentLineListDate,
  prepareDateValues,
  prepareWTPayload,
  getServiceLevel,
  groupItems,
};
