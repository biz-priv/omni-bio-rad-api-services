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
  let pool;
  try {
    pool = new sql.ConnectionPool(config);

    await pool.connect();
    console.log('Connected to the database successfully');

    const result = await pool.request().query(query);

    console.log('Query result:', result.recordset);
  } catch (err) {
    console.error('Error: ', err);
    throw err;
  } finally {
    // Close the connection pool if it was successfully created
    if (pool) {
      pool.close();
    }
  }
}
