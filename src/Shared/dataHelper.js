'use strict';

const xml2js = require('xml2js');
const sql = require('mssql');

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

async function connectToSQLServer() {
  const config = {
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    options: {
      trustServerCertificate: true, // For self-signed certificates (optional)
    },
  };

  try {
    await sql.connect(config);
    console.info('Connected to SQL Server');
    const request = new sql.Request();
    return request;
  } catch (err) {
    console.error('Error: ', err);
    throw err;
  }
}

module.exports = {
  xmlJsonConverter,
  connectToSQLServer,
};
