'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');

const ddb = new AWS.DynamoDB.DocumentClient();

async function getData(params) {
  try {
    let queryResults = [];
    let items;
    try {
      do {
        console.info('dbRead > params ', params);
        items = await ddb.query(params).promise();
        queryResults = queryResults.concat(get(items, 'Items', []));
        params.ExclusiveStartKey = get(items, 'LastEvaluatedKey');
      } while (typeof items.LastEvaluatedKey !== 'undefined');
    } catch (e) {
      console.error('DynamoDb query error. ', ' Params: ', params, ' Error: ', e);
      throw e;
    }
    return queryResults;
  } catch (err) {
    console.info('getData:', err);
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
