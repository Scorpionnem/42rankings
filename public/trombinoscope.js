'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULT_CURSUS_ID = 21; // 42cursus

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const state = {
  me: null,
  rows: [],
  cursusKinds: {}, // cursusId -> kind ('piscine', ...)
  loadSeq: 0, // guards against out-of-order polls after a selector change
};

async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function waitForRef(path) {
  for (;;) {
    const res = await api(path);
    if (res.status === 'ready') return res.data;
    if (res.status === 'error') throw new Error(res.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- boot -------------------------------------------------------------------

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    $('login-view').classList.remove('hidden');
    return;
  }

  $('user-avatar').src = state.me.image || '';
  $('user-login').textContent = state.me.login;
  $('user-box').classList.remove('hidden');
  $('trombi-view').classList.remove('hidden');

  await Promise.all([loadCampuses(), loadCursuses()]);
  buildTimeFilters();
  // Nothing is fetched until the user picks their filters and hits "Load
  // photos" — a campus can have thousands of students, no point pulling
  // (and loading the images for) all of them just to throw most away.
}

async function loadCampuses() {
  const campuses = await waitForRef('/api/campuses');
  const sel = $('campus-select');
  sel.innerHTML = '';
  for (const c of campuses) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.country})`;
    sel.appendChild(opt);
  }
  if (state.me.campus_id) sel.value = String(state.me.campus_id);
}

async function loadCursuses() {
  const cursuses = await waitForRef('/api/cursuses');
  const sel = $('cursus-select');
  sel.innerHTML = '';
  const rank = (c) => (c.id === DEFAULT_CURSUS_ID ? 0 : c.kind === 'piscine' ? 1 : 2);
  cursuses.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const c of cursuses) state.cursusKinds[c.id] = c.kind;
  for (const c of cursuses) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.kind === 'piscine' ? ' 🏊' : '');
    sel.appendChild(opt);
  }
  sel.value = String(DEFAULT_CURSUS_ID);
  if (!sel.value) sel.selectedIndex = 0;
}

// --- photo loading ------------------------------------------------------------

function setStatus(text, progress) {
  const bar = $('status-bar');
  if (text === null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('status-text').textContent = text;
  const pct = progress && progress.total ? Math.min(100, (progress.fetched / progress.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
}

async function loadPhotos() {
  const seq = ++state.loadSeq;
  const campusId = $('campus-select').value;
  const cursusId = $('cursus-select').value;
  if (!campusId || !cursusId) return;

  // The year/month filter is sent to the API (range[begin_at]) instead of
  // being applied after the fact, so an unwanted cohort is never fetched.
  let url = `/api/leaderboard?campus_id=${campusId}&cursus_id=${cursusId}`;
  const year = $('year-select').value;
  const month = $('month-select').value;
  if (year) {
    url += `&year=${year}`;
    if (month) url += `&month=${MONTHS.indexOf(month) + 1}`;
  }

  state.rows = [];
  $('trombi-hint').classList.add('hidden');
  $('trombi-error').classList.add('hidden');
  $('trombi-count').classList.add('hidden');
  $('load-photos').disabled = true;
  render();

  try {
    for (;;) {
      const res = await api(url);
      if (seq !== state.loadSeq) return;
      if (res.status === 'ready') {
        state.rows = res.data.slice().sort((a, b) =>
          (a.displayname || a.login).localeCompare(b.displayname || b.login));
        setStatus(null);
        break;
      }
      if (res.status === 'error') throw new Error(res.error);
      const p = res.progress || {};
      setStatus(`Loading students… ${p.fetched || 0}${p.total ? ' / ' + p.total : ''} records`, p);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setStatus(null);
    $('load-photos').disabled = false;
    const el = $('trombi-error');
    el.textContent = 'Failed to load students: ' + err.message;
    el.classList.remove('hidden');
    return;
  }

  $('load-photos').disabled = false;
  render();
}

// --- year / month filters ----------------------------------------------------

function isPiscine() {
  return state.cursusKinds[Number($('cursus-select').value)] === 'piscine';
}

function fillSelect(sel, values, allLabel, format = (v) => v) {
  const previous = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  sel.appendChild(all);
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = format(v);
    sel.appendChild(opt);
  }
  if (values.includes(previous)) sel.value = previous;
}

// Filters must be pickable before any student is fetched, so — unlike the
// rankings page — the year/month options can't be derived from loaded rows;
// they're a fixed range, same as the "all campuses" picker on the rankings page.
function buildTimeFilters() {
  const piscine = isPiscine();
  $('year-label-text').textContent = piscine ? 'Pool year' : 'Started in';

  const years = [];
  for (let y = new Date().getFullYear(); y >= 2013; y--) years.push(String(y));
  fillSelect($('year-select'), years, 'All years');
  $('year-label').classList.remove('hidden');

  if (piscine) {
    const capitalize = (m) => m.charAt(0).toUpperCase() + m.slice(1);
    fillSelect($('month-select'), MONTHS, 'All months', capitalize);
    $('month-label').classList.remove('hidden');
  } else {
    $('month-label').classList.add('hidden');
    $('month-select').innerHTML = '';
  }
}

// --- rendering ----------------------------------------------------------------

function render() {
  const grid = $('trombi-grid');
  const query = $('search-input').value.trim().toLowerCase();
  const hideStaff = $('hide-staff').checked;

  const visible = state.rows.filter((r) => {
    if (hideStaff && r.staff) return false;
    if (query && !r.login.toLowerCase().includes(query) &&
        !(r.displayname || '').toLowerCase().includes(query)) return false;
    return true;
  });

  if (state.rows.length) {
    $('trombi-count').textContent = `${visible.length} students`;
    $('trombi-count').classList.remove('hidden');
  }

  const frag = document.createDocumentFragment();
  visible.forEach((r) => {
    const a = document.createElement('a');
    a.className = 'trombi-card';
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = `${r.displayname || ''} (${r.login})`;
    const badges =
      (r.staff ? '<span class="badge staff">staff</span>' : '') +
      (r.alumni ? '<span class="badge alumni">alumni</span>' : '');
    a.innerHTML = `
      <img class="trombi-photo" loading="lazy" src="${r.image || ''}" alt="" onerror="this.style.visibility='hidden'">
      ${badges ? `<div class="trombi-badges">${badges}</div>` : ''}
      <div class="trombi-overlay">
        <div class="trombi-name">${escapeHtml(r.displayname || r.login)}</div>
        <div class="trombi-login">${escapeHtml(r.login)}</div>
      </div>`;
    frag.appendChild(a);
  });
  grid.replaceChildren(frag);
}

// --- events -----------------------------------------------------------------

// Changing a filter never triggers a fetch by itself — the previously loaded
// photos are cleared and the user has to hit "Load photos" again, so we never
// pull (and load the images of) a cohort they didn't ask to see.
function invalidate() {
  state.rows = [];
  $('trombi-grid').innerHTML = '';
  $('trombi-count').classList.add('hidden');
  $('trombi-error').classList.add('hidden');
  $('trombi-hint').classList.remove('hidden');
}

$('campus-select').addEventListener('change', invalidate);
$('cursus-select').addEventListener('change', () => { buildTimeFilters(); invalidate(); });
$('year-select').addEventListener('change', invalidate);
$('month-select').addEventListener('change', invalidate);
$('load-photos').addEventListener('click', loadPhotos);
$('search-input').addEventListener('input', render);
$('hide-staff').addEventListener('change', render);

boot();
