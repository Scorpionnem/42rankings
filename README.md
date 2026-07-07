# 42 Rankings

A web app that ranks the students (pisciners included) of any 42 campus, using the
[42 intra API](https://api.intra.42.fr/apidoc). Users sign in with their 42 account,
pick a campus and a cursus, and can sort the leaderboard by level, completed
projects, evaluation points, wallet, or pool.

## Features

- **Sign in with 42** (OAuth2, `intra v2`)
- **Any campus, any cursus** — the main `42cursus`, C Piscine, Discovery piscines, …
- **Worldwide ranking** — an "All campuses" option shows the top students across every
  campus (top 1000 by level, configurable via `GLOBAL_TOP`), with a campus column
- **Sortable columns**: level (XP), validated projects, evaluation (correction) points, wallet, pool
- **Time filters**: pick the pool year & month for piscines, or the starting year for
  regular cursuses. In the worldwide view these re-query the API (`range[begin_at]`),
  so you get the full top list for that cohort, not just its members of the overall top
- **Search** by login or display name, staff filter, links to intra profiles
- **Server-side caching** — leaderboards are built once and cached (default 15 min),
  respecting the API's 2 requests/second rate limit, with live build progress in the UI

## Setup

### 1. Create a 42 API application

Go to <https://profile.intra.42.fr/oauth/applications/new> and create an app with:

- **Redirect URI**: `http://localhost:3000/auth/callback` (adjust host/port for production)
- **Scopes**: `public` (the default)

### 2. Configure

```sh
cp .env.example .env
```

Fill in `FT_CLIENT_ID` (the app's UID), `FT_CLIENT_SECRET`, and set `SESSION_SECRET`
to a random string (`openssl rand -hex 32`).

### 3. Run

```sh
npm install
npm start          # or: npm run dev (auto-restart on change)
```

Open <http://localhost:3000>.

## How it works

- **Auth**: the OAuth *authorization code* flow identifies the user; their identity is
  kept in a signed cookie session. No user token is stored beyond login.
- **Data**: the server uses its own *client credentials* token to fetch data, through a
  queue that spaces requests to stay under the API rate limit (2/s).
- **Leaderboard**: built from `GET /v2/cursus_users?filter[campus_id]&filter[cursus_id]`
  (level, grade, wallet, correction points per user). Anonymized accounts are skipped.
- **Projects completed**: counted from `GET /v2/projects_users?filter[campus]`
  (`validated? == true`), streamed into the table once ready. On large campuses this
  scan can take several minutes the first time; it is cached afterwards.

## Notes

- The first leaderboard for a big campus (e.g. Paris) takes a while to build — the API
  allows ~2 requests/second and each request returns 100 records. Progress is shown live.
- Raise `CACHE_TTL` in `.env` if you want to hit the API less often.
