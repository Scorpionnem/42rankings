'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { API_BASE } = require('./src/ft');
const { getLeaderboard, getProjectCounts, getCampuses, getCursuses } = require('./src/jobs');

for (const name of ['FT_CLIENT_ID', 'FT_CLIENT_SECRET', 'SESSION_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const app = express();
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  maxAge: 7 * 24 * 3600 * 1000,
  sameSite: 'lax',
  secure: BASE_URL.startsWith('https://'),
  httpOnly: true,
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/trombinoscope', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trombinoscope.html'));
});

// --- OAuth with the 42 intra -----------------------------------------------

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = new URL(`${API_BASE}/oauth/authorize`);
  url.searchParams.set('client_id', process.env.FT_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'public');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?error=invalid_state');
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(`${API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.FT_CLIENT_ID,
        client_secret: process.env.FT_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const token = await tokenRes.json();

    const meRes = await fetch(`${API_BASE}/v2/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) throw new Error(`/v2/me failed (${meRes.status})`);
    const me = await meRes.json();

    const primaryCampusUser = (me.campus_users || []).find((cu) => cu.is_primary);
    req.session.user = {
      id: me.id,
      login: me.login,
      displayname: me.displayname,
      image: me.image && me.image.versions ? me.image.versions.small : null,
      campus_id: primaryCampusUser ? primaryCampusUser.campus_id : null,
    };
    res.redirect('/');
  } catch (err) {
    console.error('oauth callback error:', err.message);
    res.redirect('/?error=login_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// --- API (login required) ---------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  next();
}

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

app.get('/api/campuses', requireAuth, (req, res) => res.json(getCampuses()));

app.get('/api/cursuses', requireAuth, (req, res) => res.json(getCursuses()));

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const campusId = req.query.campus_id === 'all' ? 'all' : Number(req.query.campus_id);
  const cursusId = Number(req.query.cursus_id);
  const validCampus = campusId === 'all' || (Number.isInteger(campusId) && campusId > 0);
  if (!validCampus || !Number.isInteger(cursusId) || cursusId <= 0) {
    return res.status(400).json({ error: 'campus_id and cursus_id are required' });
  }

  // Applied API-side (begin_at range) so a chosen cohort is fetched directly
  // instead of pulling every student first and discarding most of them.
  let range = null;
  if (req.query.year) {
    const year = Number(req.query.year);
    const month = req.query.month ? Number(req.query.month) : null;
    const validMonth = month === null || (Number.isInteger(month) && month >= 1 && month <= 12);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !validMonth) {
      return res.status(400).json({ error: 'invalid year/month' });
    }
    const pad = (n) => String(n).padStart(2, '0');
    range = month
      ? {
          from: `${year}-${pad(month)}-01`,
          to: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
        }
      : { from: `${year}-01-01`, to: `${year + 1}-01-01` };
  }

  res.json(getLeaderboard(campusId, cursusId, range));
});

app.get('/api/projects', requireAuth, (req, res) => {
  const campusId = Number(req.query.campus_id);
  if (!Number.isInteger(campusId) || campusId <= 0) {
    return res.status(400).json({ error: 'campus_id is required' });
  }
  res.json(getProjectCounts(campusId));
});

app.listen(PORT, () => {
  console.log(`42rankings running on ${BASE_URL}`);
  console.log(`OAuth redirect URI (set this on your intra app): ${REDIRECT_URI}`);
});
