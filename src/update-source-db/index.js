'use strict';

const sql = require('mssql');
const { get } = require('lodash');

module.exports.handler = async (event) => {
  try {
    console.info(event);

    const eventBody = JSON.parse(get(event, 'body', {}));
    const query = eventBody.query;
    console.info('getQuery: ', query);
    await connectToSQLServer(query);
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

async function connectToSQLServer(query) {
  const pool = new sql.ConnectionPool({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    options: {
      trustServerCertificate: true,
    },
})


  // const config = {
  //   user: process.env.DB_USERNAME,
  //   password: process.env.DB_PASSWORD,
  //   server: process.env.DB_SERVER,
  //   port: Number(process.env.DB_PORT),
  //   database: process.env.DB_DATABASE,
  //   options: {
  //     trustServerCertificate: true,
  //   },
  // };

  try {
    await pool.connect()
    // await sql.connect(config);
    console.info('Connected to SQL Server');
    const request = new sql.Request();
    await request.query(query);
    await pool.close()
  } catch (err) {
    console.error('Error: ', err);
    throw err;
  }
}
