const { GoogleAuth } = require('google-auth-library');

/**
 * Perform an authenticated POST to the given endpoint with exponential retry on 429.
 * @param {string} endpoint - Full URL to POST to
 * @param {object} payload - Request body
 */
async function doRequest(endpoint, payload) {
  const MAX_RETRIES = parseInt(process.env.EMBEDDINGS_MAX_RETRIES || '5', 10);
  const BASE_DELAY_MS = parseInt(process.env.EMBEDDINGS_BASE_DELAY_MS || '500', 10);

  const auth = new GoogleAuth();
  const client = await auth.getClient();

  let attempt = 0;
  let delay = BASE_DELAY_MS;

  while (true) {
    try {
      const res = await client.request({
        url: endpoint,
        method: 'POST',
        data: payload,
        timeout: 30000,
      });
      return res.data;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        attempt += 1;
        const jitter = Math.floor(Math.random() * delay);
        const sleepMs = delay + jitter;
        console.warn(`Request received 429; retry ${attempt}/${MAX_RETRIES} in ${sleepMs}ms`);
        await new Promise((r) => setTimeout(r, sleepMs));
        delay = delay * 2;
        continue;
      }
      console.error('HTTP request failed:', error.message);
      throw error;
    }
  }
}

module.exports = { doRequest };
