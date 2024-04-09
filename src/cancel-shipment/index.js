'use strict';

const AWS = require('aws-sdk');
const { get } = require('lodash');
const axios = require('axios');
const uuid = require('uuid');
const moment = require('moment-timezone');
const { putLogItem, getData } = require('../Shared/dynamo');
const { xmlJsonConverter } = require('../Shared/dataHelper');

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
    dynamoData.XmlPayload = {};

    const eventBody = get(event, 'body', {});

    const freightOrderId = get(eventBody, 'freightOrderId', '');
    dynamoData.FreightOrderId = freightOrderId;
    if (freightOrderId === '' || freightOrderId === null) {
      throw new Error('Error, Please provide freightOrderId');
    }
    const housebillArray = await getHousebills(freightOrderId);
    if (housebillArray.length === 0) {
      throw new Error(`Error, housebill not found for the given freightOrderId: ${freightOrderId}`);
    }
    dynamoData.HousebillArray = housebillArray;

    const skippedHousebills = [];
    const responses = {};
    await Promise.all(
      housebillArray.map(async (housebill) => {
        if (skippedHousebills.includes(housebill)) {
          return;
        }
        skippedHousebills.push(housebill);
        const result = await addMilestoneApiCall(housebill);
        responses[housebill] = result;
      })
    );
    dynamoData.Responses = responses;

    console.info(dynamoData);

    await putLogItem(dynamoData);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: dynamoData.Id,
          message: 'Success',
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

async function getHousebills(referenceNo) {
  try {
    // get all the order no for provided reference no
    const referenceParams = {
      TableName: process.env.REFERENCE_TABLE,
      IndexName: 'ReferenceNo-FK_RefTypeId-index',
      KeyConditionExpression: 'ReferenceNo = :ReferenceNo and FK_RefTypeId = :FK_RefTypeId',
      ExpressionAttributeValues: {
        ':ReferenceNo': referenceNo,
        ':FK_RefTypeId': 'SID',
      },
    };

    const referenceResult = await getData(referenceParams);
    if (referenceResult.length === 0) {
      throw new Error(`Error, Order number not found for the given freightOrderId: ${referenceNo}`);
    }

    // get all the housebill from the above order nos
    let housebillArray = [];
    await Promise.all(
      referenceResult.map(async (orderData) => {
        const headerParams = {
          TableName: process.env.SHIPMENT_HEADER_TABLE,
          KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
          ExpressionAttributeValues: {
            ':PK_OrderNo': get(orderData, 'FK_OrderNo', ''),
          },
        };
        const headerResult = await getData(headerParams);

        const unwantedArray = headerResult
        .filter((obj) => !['WEB', 'CAN'].includes(obj.FK_OrderStatusId));
        if(unwantedArray > 0){
          throw new Error(`This Freight order id cannot be cancelled ${referenceNo}`)
        }

        const filteredArray = headerResult
          .filter((obj) => ['WEB'].includes(obj.FK_OrderStatusId) && obj.Housebill)
          .map((obj) => obj.Housebill);

        housebillArray = [...housebillArray, ...filteredArray];
      })
    );

    return housebillArray;
  } catch (error) {
    console.error('Error while fetching housebill', error);
    throw error;
  }
}

async function addMilestoneApiCall(housebill) {
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
    dynamoData.XmlPayload[housebill] = xmlString;

    const config = {
      url: process.env.ADD_MILESTONE_URL,
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
      throw new Error(`API Request Failed: ${res}`);
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
    return { message: error, housebill };
  }
}
