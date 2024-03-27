'use strict';

const sql = require('mssql');
const { get } = require('lodash');

module.exports.handler = async (event) => {
  console.info(event);

  const eventBody = JSON.parse(get(event, 'body', {}))
  const query = eventBody.query;
  console.info('getQuery: ', query);
  const request = await connectToSQLServer();
  const result = await request.query(query);

  console.info(result);
  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        Message: 'Success',
      },
      null,
      2
    ),
  };
};

async function connectToSQLServer() {
  const config = {
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    options: {
      trustServerCertificate: true,
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
