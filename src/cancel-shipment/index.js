'use strict';

module.exports.handler = async (event, context) => {
  try {
    console.info(event);

    console.info(context);

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
    console.error(error);
    throw error;
  }
};
