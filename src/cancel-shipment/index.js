'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const xml2js = require('xml2js');
const axios = require('axios');
const uuid = require('uuid');
const moment = require('moment-timezone');

const ddb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();

const dynamoData = {};

module.exports.handler = async (event, context) => {
  try {
    console.info(event);

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss');
    dynamoData.Event = event;
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.Process = 'CANCEL';

    const eventBody = get(event, 'body', {});

    const freightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.FreightOrderId = freightOrderId;
    if (freightOrderId === '' || freightOrderId === null) {
      throw new Error('Error, Please provide freightOrderId');
    }
    const housebill = await getHousebill(freightOrderId);
    if (housebill !== '') {
      throw new Error(`Error, housebill not found for the given freightOrderId: ${freightOrderId}`);
    }
    dynamoData.Housebill = housebill;

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

    const xmlPayload = await xmlJsonConverter(xmlString);
    dynamoData.XmlPayload = xmlPayload;

    const config = {
      url: process.env.ADD_MILESTONE_URL,
      method: 'post',
      headers: {
        'Accept': 'text/xml',
        'Content-Type': 'text/xml',
      },
      data: xmlPayload,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    dynamoData.Response = get(res, 'data', '');
    if (get(res, 'status', '') !== 200) {
      console.info(get(res, 'data', ''));
      throw new Error(`API Request Failed: ${res}`);
    }

    // Verify if the WT api request is success or failed
    const response = await xmlJsonConverter(dynamoData.Response)
    let message = response['soap:Envelope']['soap:Body'].UpdateStatusResponse.UpdateStatusResult;
    if(message === 'true'){
      message = 'Success'
    } else {
      message = 'Failed'
    }

    await putItem(dynamoData);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
          message,
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error('Main lambda error: ', error);

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
    await putItem(dynamoData);
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

async function getHousebill(referenceNo) {
  try {
    const referenceParams = {
      TableName: process.env.REFERENCE_TABLE,
      IndexName: 'referenceNo-refTypeId-index',
      KeyConditionExpression: 'ReferenceNo = :ReferenceNo and FK_RefTypeId = :FK_RefTypeId',
      ExpressionAttributeValues: {
        ':ReferenceNo': referenceNo,
        ':FK_RefTypeId': 'SID',
      },
    };

    const referenceResult = await getData(referenceParams);
    const orderNo = get(referenceResult, '[0].FK_OrderNo', '');
    if (orderNo === '') {
      throw new Error(`Error, Order number not found for the given freightOrderId: ${referenceNo}`);
    }

    const headerParams = {
      TableName: process.env.SHIPMENT_HEADER_TABLE,
      KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
      ExpressionAttributeValues: {
        ':PK_OrderNo': orderNo,
      },
    };

    const headerResult = await getData(headerParams);
    const housebillArray = get(headerResult, 'Items', []).filter((obj) =>
      ['NEW', 'WEB'].includes(obj.FK_OrderStatusId)
    );

    return get(housebillArray, '[0].Housebill', '');
  } catch (error) {
    console.error('Error while fetching housebill');
    throw error;
  }
}

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

async function getData(params) {
  try {
    const data = await ddb.query(params).promise();
    console.info('Query succeeded:', data);
    return get(data, 'Items', []);
  } catch (err) {
    console.info('getStationId:', err);
    throw err;
  }
}

async function putItem(item) {
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
