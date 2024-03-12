'use strict';

module.exports.handler = async (event, context) => {
  console.info(event);

  console.info(context);

  return JSON.stringify({
    status: 400,
    Message: 'Success',
  });
};
