'use strict';

const { get } = require('lodash');

module.exports.handler = async (event, context) => {
  console.info(event);

  console.info(context);

  const shipperAndConsignee = await prepareShipperAndConsigneeData(event);
  console.info(shipperAndConsignee);

  const shipmentLineList = await prepareShipmentLineListDate(get(event, 'array', []));
  console.info(shipmentLineList);

  return JSON.stringify({
    status: 400,
    Message: 'Success',
  });
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
  };
}

async function prepareShipmentLineListDate(data) {
  await Promise.all(
    data.map(async (item) => {
      return {
        PieceType: get(item, 'packageTypeCode', ''),
        Description: get(item, 'description', ''),
        Hazmat: get(item, 'dangerousGoods', ''),
        Weigth: get(item, 'grossWeight.value', ''),
        WeightUOMV3: get(item, 'grossWeight.unit', ''),
        Pieces: get(item, 'pieces.value', ''),
        Length: get(),
        DimUOMV3: get(),
        Width: get(),
        Height: get(),
      };
    })
  );
}
