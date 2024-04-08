'use strict';

const { get } = require('lodash');
const AWS = require('aws-sdk');
const { putLogItem, getData } = require('../Shared/dynamo');
const uuid = require('uuid');
const moment = require('moment-timezone');
const axios = require('axios');
const { querySourceDb } = require('../Shared/dataHelper');

const sns = new AWS.SNS();
const dynamoData = {};

module.exports.handler = async (event, context) => {
  try {
    // const eventBody = JSON.parse(get(event, 'body', {}));

    const eventBody = get(event, 'body', {});

    console.info(eventBody);

    // Set the time zone to CST
    const cstDate = moment().tz('America/Chicago');
    dynamoData.CSTDate = cstDate.format('YYYY-MM-DD');
    dynamoData.CSTDateTime = cstDate.format('YYYY-MM-DD HH:mm:ss SSS');
    dynamoData.Event = get(event, 'body', '');
    dynamoData.Id = uuid.v4().replace(/[^a-zA-Z0-9]/g, '');
    dynamoData.FreightOrderId = get(eventBody, 'shipment.orderId', '');
    dynamoData.OrderingPartyLbnId = get(eventBody, 'shipper.shipperLBNID', '');
    dynamoData.CarrierPartyLbnId = get(eventBody, 'carrier.carrierLBNID', '');
    dynamoData.TechnicalId = get(eventBody, 'technicalId', '');

    const stops = get(eventBody, 'shipment.stops', '');

    const stopsUpdateResults = await Promise.all(
      stops.map(async (stop) => {
        let locId;
        try {
          locId = get(stop, 'location.Id', '').split(':')[6];
          const query = `insert into tbl_references (FK_OrderNo,CustomerType,ReferenceNo,FK_RefTypeId) (select fk_orderno,customertype,'${get(stop, 'stopId', '')}','STO' from tbl_references where referenceno='${locId}' and customertype in ('S','C') and fk_reftypeid='STP' and fk_orderno in (select fk_orderno from tbl_references where customertype='B' and fk_reftypeid='SID' and referenceno='${get(dynamoData, 'FreightOrderId', '')}') and fk_orderno not in (select fk_orderno from tbl_references where customertype in ('S','C') and fk_reftypeid='SID'))`;
          console.info(query);
          await querySourceDb(query);
          return true;
        } catch (error) {
          console.error(`Error for ${locId}`);
          return { locId };
        }
      })
    );
    console.info(stopsUpdateResults);

    const fileNumbers = await getFileNumbers(get(dynamoData, 'FreightOrderId', ''));

    await Promise.all(fileNumbers.map(async (fileNumber)=>{
        console.info(fileNumber)
        const payload = await preparePayload(fileNumber);
        console.info(payload)
        await sendToWT(payload);
    }))

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          responseId: get(dynamoData, 'Id', ''),
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
        Message: `An error occurred in function ${context.functionName}.\n\nERROR DETAILS: ${error}.\n\nId: ${get(dynamoData, 'Id', '')}.\n\nEVENT: ${JSON.stringify(get(dynamoData, 'Event', {}))}.\n\nNote: Use the id: ${get(dynamoData, 'Id', '')} for better search in the logs and also check in dynamodb: ${process.env.LOGS_TABLE} for understanding the complete data.`,
        Subject: `Bio Rad Add Tracking ERROR ${context.functionName}`,
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
          message: errorMsgVal,
        },
        null,
        2
      ),
    };
  }
};

async function getFileNumbers(referenceNo) {
  try {
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
    if(referenceResult.length === 0){
        throw new Error(`There is no data for the given freigth order Id: ${referenceNo}`)
    }
    const fileNumbers = referenceResult.map(item => get(item, 'FK_OrderNo', ''))
    return fileNumbers

  } catch (error) {
    console.info('Error while fetching file numbers based on referenceNo', error);
    throw new Error(`Error while fetching file numbers based on referenceNo: ${error}`);
  }
}

async function preparePayload(fileNumber){
    try{
        const shipmentHeaderParams = {
            TableName: process.env.SHIPMENT_HEADER_TABLE,
            KeyConditionExpression: 'PK_OrderNo = :PK_OrderNo',
            ExpressionAttributeValues: {
              ':PK_OrderNo': fileNumber,
            },
          };
          const shipmentHeaderResult = await getData(shipmentHeaderParams);
          const housebill = get(shipmentHeaderResult, '[0].Housebill', '');

          const payload = `<?xml version="1.0"?>
          <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Header>
              <AuthHeader xmlns="http://tempuri.org/">
                <UserName>saplbn</UserName>
                <Password>saplbn</Password>
              </AuthHeader>
            </soap:Header>
            <soap:Body>
              <WriteTrackingNote xmlns="http://tempuri.org/">
                <HandlingStation/>
                <HouseBill>${housebill}</HouseBill>
                <TrackingNotes>
                  <TrackingNotes>
                    <TrackingNoteMessage>technicalId ${get(dynamoData, 'TechnicalId', '')}</TrackingNoteMessage>
                  </TrackingNotes>
                </TrackingNotes>
              </WriteTrackingNote>
            </soap:Body>
          </soap:Envelope>`;
          return payload;
    }catch(error){
        console.error(error)
        throw new Error(`Error while preparing payload for fileNumber: ${fileNumber}, Error: ${error}`)
    }
}

async function sendToWT(postData) {
  try {
    const config = {
      url: process.env.LOC_URL,
      method: 'post',
      headers: {
        'Accept': 'text/xml',
        'Content-Type': 'text/xml',
      },
      data: postData,
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    console.info(get(res, 'data', ''));
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    dynamoData.XmlResponsePayload = get(res, 'data');
    throw new Error(`World trak API Request Failed: ${res}`);
  } catch (error) {
    console.error('send to WT', error);
    throw new Error(`World trak API Request Failed: ${error}`);
  }
}
