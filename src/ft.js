'use strict';

const API_BASE = 'https://api.intra.42.fr';

// The 42 API allows 2 requests/second per application. All requests made
// with the app token go through a single queue spaced at MIN_INTERVAL ms.
const MIN_INTERVAL = 550;
const MAX_RETRIES = 5;

let appToken = null; // { access_token, expiresAt }

async function fetchAppToken() {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FT_CLIENT_ID,
      client_secret: process.env.FT_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`app token request failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  appToken = {
    access_token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return appToken.access_token;
}

async function getAppToken() {
  if (appToken && Date.now() < appToken.expiresAt) return appToken.access_token;
  return fetchAppToken();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queueTail = Promise.resolve();
let lastRequestAt = 0;

// GET an API path with the app token, rate limited and retried on 429/5xx.
// Returns { data, headers }.
function ftGet(path, params = {}) {
  const run = async () => {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_INTERVAL - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      const token = await getAppToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

      if (res.status === 401 && attempt < MAX_RETRIES) {
        appToken = null; // token revoked or expired early
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 1 + attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
      }
      return { data: await res.json(), headers: res.headers };
    }
  };

  const result = queueTail.then(run, run);
  queueTail = result.then(() => {}, () => {});
  return result;
}

// Fetch every page of a paginated index endpoint. onProgress(fetched, total)
// is called after each page; total comes from the X-Total header.
async function ftGetAll(path, params = {}, onProgress = null, maxPages = 3000) {
  const all = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await ftGet(path, {
      ...params,
      'page[size]': 100,
      'page[number]': page,
    });
    if (total === null) total = Number(headers.get('x-total')) || null;
    all.push(...data);
    if (onProgress) onProgress(all.length, total);
    if (data.length < 100) break;
    if (total !== null && all.length >= total) break;
  }
  return all;
}

module.exports = { API_BASE, ftGet, ftGetAll };
