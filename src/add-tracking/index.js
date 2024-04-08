'use strict';

module.exports.handler = async (event, context) => {
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
};
