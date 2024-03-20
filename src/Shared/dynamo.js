'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient();

async function getData(params) {
  try {
    const data = await ddb.query(params).promise();
    return get(data, 'Items', []);
  } catch (err) {
    console.info('getStationId:', err);
    throw err;
  }
}

async function putLogItem(item) {
  let params;
  try {
    params = {
      TableName: process.env.LOGS_TABLE,
      Item: item,
    };
    console.info('Insert Params: ', params);
    const dynamoInsert = await ddb.put(params).promise();
    return dynamoInsert;
  } catch (error) {
    console.error('Put Item Error: ', error, '\nPut params: ', params);
    throw error;
  }
}

module.exports = {
  getData,
  putLogItem,
};
