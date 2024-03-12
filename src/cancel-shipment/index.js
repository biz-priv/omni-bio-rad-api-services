'use strict';

module.exports.handler = async (event, context) => {
  try {
    console.info(event);

    console.info(context);

    return JSON.stringify({
      status: 400,
      Message: 'Success',
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
};
