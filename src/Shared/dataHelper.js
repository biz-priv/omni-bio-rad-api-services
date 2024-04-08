'use strict';

const xml2js = require('xml2js');
const { get } = require('lodash');
const axios = require('axios');

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

async function querySourceDb(query) {
  try {
    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: process.env.UPDATE_SOURCE_DB_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.UPDATE_SOURCE_DB_API_KEY,
      },
      data: { query },
    };

    console.info('config: ', config);
    const res = await axios.request(config);
    if (get(res, 'status', '') === 200) {
      return get(res, 'data', '');
    }
    throw new Error(`Update source db API Request Failed: ${res}`);
  } catch (error) {
    console.error('Update source db API Request Failed: ', error);
    throw new Error(`Update source db API Request Failed: ${error}`);
  }
}

module.exports = {
  xmlJsonConverter,
  querySourceDb,
};
