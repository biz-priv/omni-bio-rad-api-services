'use strict';

const xml2js = require('xml2js');

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

module.exports = {
  xmlJsonConverter,
};
