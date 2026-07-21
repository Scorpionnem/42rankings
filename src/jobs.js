'use strict';

const { ftGetAll } = require('./ft');

const CACHE_TTL = (Number(process.env.CACHE_TTL) || 900) * 1000;

// key -> { status: 'loading'|'ready'|'error', progress, data, error, builtAt }
const jobs = new Map();

function getJob(key, builder, force = false) {
  const existing = jobs.get(key);
  if (existing && !force) {
    const expired = existing.status === 'ready' && Date.now() - existing.builtAt > CACHE_TTL;
    const failed = existing.status === 'error';
    if (!expired && !failed) return existing;
  }

  const job = { status: 'loading', progress: { fetched: 0, total: null }, data: null, error: null, builtAt: null };
  jobs.set(key, job);

  builder(job)
    .then((data) => {
      job.data = data;
      job.status = 'ready';
      job.builtAt = Date.now();
    })
    .catch((err) => {
      console.error(`job ${key} failed:`, err.message);
      job.status = 'error';
      job.error = err.message;
    });

  return job;
}

function publicState(job, extra = {}) {
  if (job.status === 'ready') return { status: 'ready', builtAt: job.builtAt, ...extra, data: job.data };
  if (job.status === 'error') return { status: 'error', error: job.error };
  return { status: 'loading', progress: job.progress };
}

// --- Leaderboard: one entry per student of the campus/cursus pair ---------

function isAnonymized(user) {
  return typeof user.login === 'string' && user.login.startsWith('3b3-');
}

// Size of the worldwide ranking ("all campuses" view).
const GLOBAL_TOP = Number(process.env.GLOBAL_TOP) || 1000;

function mapRow(cu) {
  const u = cu.user;
  return {
    id: u.id,
    login: u.login,
    displayname: u.displayname,
    image: u.image && u.image.versions ? u.image.versions.small : null,
    url: `https://profile.intra.42.fr/users/${u.login}`,
    level: cu.level,
    grade: cu.grade,
    wallet: u.wallet ?? null,
    correction_point: u.correction_point ?? null,
    pool_month: u.pool_month,
    pool_year: u.pool_year,
    staff: u['staff?'] === true,
    alumni: u['alumni?'] === true,
    active: u['active?'] !== false,
    begin_at: cu.begin_at,
    blackholed_at: cu.blackholed_at || null,
    campus: null,
    projects: null,
  };
}

async function buildCampusBoard(campusId, cursusId, j, range) {
  const params = { 'filter[campus_id]': campusId, 'filter[cursus_id]': cursusId };
  if (range) params['range[begin_at]'] = `${range.from},${range.to}`;
  const rows = await ftGetAll(
    '/v2/cursus_users',
    params,
    (fetched, total) => { j.progress = { fetched, total }; }
  );

  const byUser = new Map();
  for (const cu of rows) {
    const u = cu.user;
    if (!u || isAnonymized(u)) continue;
    // Keep the highest-level entry if a user somehow appears twice.
    const prev = byUser.get(u.id);
    if (prev && prev.level >= cu.level) continue;
    byUser.set(u.id, mapRow(cu));
  }
  return [...byUser.values()].sort((a, b) => b.level - a.level);
}

// Worldwide ranking: fetching every cursus_user on Earth would take hours at
// 2 req/s, so we let the API sort by level and only take the top GLOBAL_TOP,
// then resolve each user's primary campus in batches of 100 ids.
async function buildGlobalBoard(cursusId, j, range) {
  const params = { 'filter[cursus_id]': cursusId, sort: '-level' };
  if (range) params['range[begin_at]'] = `${range.from},${range.to}`;
  const rows = await ftGetAll(
    '/v2/cursus_users',
    params,
    (fetched, total) => {
      j.progress = { fetched, total: Math.min(total || GLOBAL_TOP, GLOBAL_TOP) };
    },
    Math.ceil(GLOBAL_TOP / 100)
  );

  const byUser = new Map();
  for (const cu of rows) {
    const u = cu.user;
    if (!u || isAnonymized(u) || byUser.has(u.id)) continue;
    byUser.set(u.id, mapRow(cu));
  }
  const board = [...byUser.values()].sort((a, b) => b.level - a.level);

  const campusName = new Map((await campusesData()).map((c) => [c.id, c.name]));
  const ids = board.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const memberships = await ftGetAll('/v2/campus_users', {
      'filter[user_id]': chunk.join(','),
    });
    for (const m of memberships) {
      const row = byUser.get(m.user_id);
      if (row && (m.is_primary || row.campus === null)) {
        row.campus = campusName.get(m.campus_id) || `campus #${m.campus_id}`;
      }
    }
  }
  return board;
}

function boardKey(campusId, cursusId, range = null) {
  return `lb:${campusId}:${cursusId}` + (range ? `:${range.from}:${range.to}` : '');
}

function getLeaderboard(campusId, cursusId, range = null) {
  const key = boardKey(campusId, cursusId, range);
  const job = getJob(key, (j) =>
    campusId === 'all'
      ? buildGlobalBoard(cursusId, j, range)
      : buildCampusBoard(campusId, cursusId, j, range)
  );
  return publicState(job);
}

// --- Projects completed: validated projects_users, per board --------------

// Piscine C day modules ("C Piscine C 04"), excluding Shell/Rush/Exam.
const PISCINE_C_RE = /^C Piscine (C \d+)$/i;

// Fetches projects only for the users of an already-loaded board (batched by
// user id) instead of scanning the campus's entire projects_users — a piscine
// cohort is a handful of requests instead of hundreds of pages.
function getProjectCounts(campusId, cursusId, range = null) {
  const board = jobs.get(boardKey(campusId, cursusId, range));
  if (!board || board.status !== 'ready') {
    return { status: 'error', error: 'board_not_loaded' };
  }
  const ids = board.data.map((r) => r.id);

  const key = `pj:${boardKey(campusId, cursusId, range)}`;
  const job = getJob(key, async (j) => {
    const counts = {};
    // Piscine progress per user: last_c is the most recently marked C-module
    // attempt (validated or failed), last_c_ok the most recently validated,
    // best_c the highest-numbered module ever pushed (validated or not —
    // pushing C 09 and failing it still ranks above only ever reaching C 07).
    const lastC = {};
    j.progress = { fetched: 0, total: ids.length };
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const pus = await ftGetAll('/v2/projects_users', { 'filter[user_id]': chunk.join(',') });
      for (const pu of pus) {
        if (!pu.user) continue;
        if (pu['validated?'] === true) counts[pu.user.id] = (counts[pu.user.id] || 0) + 1;
        const m = pu.project && PISCINE_C_RE.exec(pu.project.name);
        if (!m || pu.final_mark === null) continue;
        const entry = {
          name: m[1].toUpperCase(),
          num: parseInt(m[1].slice(2), 10),
          mark: pu.final_mark,
          validated: pu['validated?'] === true,
          at: pu.marked_at || pu.created_at,
        };
        const slot = lastC[pu.user.id] ||
          (lastC[pu.user.id] = { last_c: null, last_c_ok: null, best_c: null });
        if (!slot.last_c || new Date(entry.at) > new Date(slot.last_c.at)) slot.last_c = entry;
        if (entry.validated && (!slot.last_c_ok || new Date(entry.at) > new Date(slot.last_c_ok.at))) {
          slot.last_c_ok = entry;
        }
        if (!slot.best_c || entry.num > slot.best_c.num ||
            (entry.num === slot.best_c.num && entry.mark > slot.best_c.mark)) {
          slot.best_c = entry;
        }
      }
      j.progress = { fetched: Math.min(i + 100, ids.length), total: ids.length };
    }
    return { counts, last_c: lastC };
  });
  return publicState(job);
}

// --- Exam tracker: students currently sitting an exam, live-ranked ---------

// An exam project's "team" is created the moment a student starts an
// attempt; its final_mark is filled in progressively by the automated
// corrector while the student is still at the machine. Scoping teams to the
// exam's own time window (and campus) is what turns "every attempt ever" into
// "who is in the room right now".
const EXAM_LOOKBACK_MS = 8 * 3600 * 1000; // covers the longest exam slot + buffer

// Exam teams get created when the student enters examshell, which happens up
// to ~half an hour BEFORE the exam's official begin_at (observed live: teams
// at 10:26 UTC for an 11:00 UTC exam). Open the created_at window early or
// those students are invisible for the whole exam.
const EXAM_EARLY_TEAM_MS = 3600 * 1000;

async function buildExamTracker(campusId, j) {
  const now = new Date();
  const from = new Date(now.getTime() - EXAM_LOOKBACK_MS).toISOString();
  const params = { 'range[begin_at]': `${from},${now.toISOString()}` };
  if (campusId !== 'all') params['filter[campus_id]'] = campusId;

  const exams = await ftGetAll('/v2/exams', params);
  const ongoing = exams.filter((e) => new Date(e.begin_at) <= now && new Date(e.end_at) >= now);

  const calls = ongoing.flatMap((exam) => (exam.projects || []).map((project) => ({ exam, project })));
  j.progress = { fetched: 0, total: calls.length };

  const byUser = new Map(); // user id -> row, keeping their most recent attempt
  for (const { exam, project } of calls) {
    // Two ways a team belongs to this exam sitting:
    //  - created in the window: cursus students, whose team appears when they
    //    enter examshell (up to ~30 min before the official start);
    //  - updated in the window: pisciners, whose team is created at
    //    registration days earlier and only touched again when the automated
    //    corrector grades them during the exam.
    const teamsFrom = new Date(new Date(exam.begin_at).getTime() - EXAM_EARLY_TEAM_MS).toISOString();
    const scope = { 'filter[campus]': exam.campus.id };
    const created = await ftGetAll('/v2/projects/' + project.id + '/teams', {
      ...scope, 'range[created_at]': `${teamsFrom},${exam.end_at}`,
    });
    const updated = await ftGetAll('/v2/projects/' + project.id + '/teams', {
      ...scope, 'range[updated_at]': `${teamsFrom},${exam.end_at}`,
    });
    // The updated_at window also catches a cleanup cron that closes stale
    // teams from previous sittings mid-exam — those come back as
    // status "finished" with a fresh closed_at, so keep in_progress only.
    const live = updated.filter((t) => t.status === 'in_progress');
    const teams = [...new Map([...created, ...live].map((t) => [t.id, t])).values()];
    const isPiscine = (exam.cursus || []).some((c) => c.kind === 'piscine')
      || /piscine/i.test(exam.name) || /piscine/i.test(project.name);
    for (const team of teams) {
      for (const u of team.users || []) {
        const prev = byUser.get(u.id);
        if (prev && new Date(prev.created_at) >= new Date(team.created_at)) continue;
        byUser.set(u.id, {
          id: u.id,
          login: u.login,
          kind: isPiscine ? 'piscine' : 'cursus',
          exam_name: exam.name,
          campus: exam.campus.name,
          project_name: project.name,
          final_mark: team.final_mark,
          status: team.status,
          begin_at: exam.begin_at,
          end_at: exam.end_at,
          created_at: team.created_at,
        });
      }
    }
    j.progress = { fetched: j.progress.fetched + 1, total: calls.length };
  }

  const ids = [...byUser.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const users = await ftGetAll('/v2/users', { 'filter[id]': chunk.join(',') });
    for (const u of users) {
      const row = byUser.get(u.id);
      if (!row) continue;
      row.displayname = u.displayname;
      row.image = u.image && u.image.versions ? u.image.versions.small : null;
      row.url = `https://profile.intra.42.fr/users/${u.login}`;
      row.staff = u['staff?'] === true;
    }
  }

  return [...byUser.values()].sort((a, b) => (b.final_mark ?? -1) - (a.final_mark ?? -1));
}

function getExamTracker(campusId, force = false) {
  const key = `exam:${campusId}`;
  const job = getJob(key, (j) => buildExamTracker(campusId, j), force);
  return publicState(job);
}

// --- Reference data (campuses, cursuses), cached once ---------------------

let campusesPromise = null;
function campusesData() {
  if (!campusesPromise) {
    campusesPromise = ftGetAll('/v2/campus').catch((err) => {
      campusesPromise = null;
      throw err;
    });
  }
  return campusesPromise;
}

function getCampuses() {
  const job = getJob('campuses', async () => {
    const rows = await campusesData();
    return rows
      .filter((c) => c.public !== false)
      .map((c) => ({ id: c.id, name: c.name, country: c.country, users_count: c.users_count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  return publicState(job);
}

function getCursuses() {
  const job = getJob('cursuses', async (j) => {
    const rows = await ftGetAll('/v2/cursus', {}, (f, t) => { j.progress = { fetched: f, total: t }; });
    return rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  });
  return publicState(job);
}

module.exports = { getLeaderboard, getProjectCounts, getCampuses, getCursuses, getExamTracker };
