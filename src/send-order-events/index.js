'use strict';


module.exports.handler = async (event) => {
  try {
    console.info(event);
    return {
        statusCode: 400,
        body: JSON.stringify(
          {
            Message: 'SUCCESS',
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