'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const { getData } = require('../Shared/dynamo');
const { fetchTackingData } = require('../Shared/dataHelper');

module.exports.handler = async (event) => {
  try {
    console.info(event);
    const record = get(event, 'Records[0]', {});
    console.info(record);
    const recordBody = JSON.parse(get(record, 'body', ''));
    console.info(recordBody.Message);
    const message = JSON.parse(get(recordBody, 'Message', ''));
    console.info(message.dynamoTableName);
    const oldImage = get(message, 'OldImage', '');
    if (oldImage !== '') {
      console.info('Skipped as this is an update or delete shipment.');
    }
    if (get(message, 'dynamoTableName', '') === `omni-wt-rt-apar-failure-${process.env.STAGE}`) {
      console.info(message);
      const data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
      await exceptionEvent(get(data, 'FK_OrderNo'));
      console.info(data);
    } else if (
      get(message, 'dynamoTableName', '') === `omni-wt-rt-shipment-milestone-${process.env.STAGE}`
    ) {
      console.info(message);
      const data = AWS.DynamoDB.Converter.unmarshall(get(message, 'NewImage', {}));
      console.info(data);
    } else if (
      get(recordBody, 'eventSourceARN', '').split('/')[1] ===
      `omni-p44-shipment-location-updates-${process.env.STAGE}`
    ) {
      const data = AWS.DynamoDB.Converter.unmarshall(get(recordBody, 'dynamodb.NewImage', {}));
      console.info(data);
      const referenceParams = {
        TableName: process.env.SHIPMENT_HEADER_TABLE,
        IndexName: 'Housebill-index',
        KeyConditionExpression: 'Housebill = :Housebill',
        ExpressionAttributeValues: {
          ':Housebill': get(data, 'HouseBillNo'),
        },
      };
      const res = await getData(referenceParams);
      console.info(res);
      await locationsEvent(get(res, 'PK_OrderNo'));
    } else {
      console.info('skipper the events as not matching the requirement');
    }
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

async function exceptionEvent(orderNo) {
  console.info(orderNo);
}

async function locationsEvent(orderNo) {
  console.info(orderNo);
  const trackingData = await fetchTackingData(orderNo);
  console.info(trackingData);
}
