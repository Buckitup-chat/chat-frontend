exports.handler = async (event) => {
  const path = event.path.replace('/.netlify/functions/proxy', '');
  const url = `https://buckitup.xyz/electric/v1${path}${event.queryStringParameters ? '?' + new URLSearchParams(event.queryStringParameters).toString() : ''}`;
  
  try {
    const response = await fetch(url, {
      method: event.httpMethod,
      headers: {
        'Content-Type': 'application/json',
        ...event.headers,
      },
      body: event.body,
    });

    const data = await response.arrayBuffer();
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'electric-offset, electric-handle, electric-schema',
      'Content-Type': response.headers.get('content-type') || 'application/json',
    };

    return {
      statusCode: response.status,
      headers,
      body: Buffer.from(data).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
