'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  rows: [],            // leaderboard rows
  projects: null,      // userId -> validated project count (null while loading)
  cursusKinds: {},     // cursusId -> kind ('piscine', ...)
  sortKey: 'level',
  sortDir: -1,         // -1 desc, 1 asc
  pollTimer: null,
  loadSeq: 0,          // guards against out-of-order polls after a selector change
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const DEFAULT_CURSUS_ID = 21; // 42cursus

async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    const el = $('login-error');
    el.textContent = 'Login failed: ' + params.get('error');
    el.classList.remove('hidden');
    history.replaceState(null, '', '/');
  }

  try {
    state.me = await api('/api/me');
  } catch {
    $('login-view').classList.remove('hidden');
    return;
  }

  $('user-avatar').src = state.me.image || '';
  $('user-login').textContent = state.me.login;
  $('user-box').classList.remove('hidden');
  $('board-view').classList.remove('hidden');

  await Promise.all([loadCampuses(), loadCursuses()]);
  buildTimeFilters();
  // Nothing is fetched until the user picks their filters and hits "Load
  // leaderboard" — building a big campus's board scans its whole roster and
  // can take minutes, so we don't kick that off before a cohort is chosen.
}

async function waitForRef(path) {
  for (;;) {
    const res = await api(path);
    if (res.status === 'ready') return res.data;
    if (res.status === 'error') throw new Error(res.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function loadCampuses() {
  const campuses = await waitForRef('/api/campuses');
  const sel = $('campus-select');
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = '🌍 All campuses (top worldwide)';
  sel.appendChild(all);
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
  // Most useful first: main cursus, then piscines, then the rest.
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

// --- leaderboard loading ----------------------------------------------------

function setStatus(text, progress) {
  const bar = $('status-bar');
  if (text === null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('status-text').textContent = text;
  const pct = progress && progress.total ? Math.min(100, (progress.fetched / progress.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
}

async function loadBoard() {
  const seq = ++state.loadSeq;
  const campusId = $('campus-select').value;
  const cursusId = $('cursus-select').value;
  if (!campusId || !cursusId) return;
  $('board').classList.toggle('global', campusId === 'all');

  // The year/month filter is sent to the API (range[begin_at]) instead of
  // being applied after the fact, so an unwanted cohort is never fetched.
  let cohort = `campus_id=${campusId}&cursus_id=${cursusId}`;
  const year = $('year-select').value;
  const month = $('month-select').value;
  if (year) {
    cohort += `&year=${year}`;
    if (month) cohort += `&month=${MONTHS.indexOf(month) + 1}`;
  }
  const url = `/api/leaderboard?${cohort}`;

  state.rows = [];
  state.projects = null;
  $('board-hint').classList.add('hidden');
  $('board-error').classList.add('hidden');
  $('board-meta').classList.add('hidden');
  $('load-board').disabled = true;
  render();

  try {
    for (;;) {
      const res = await api(url);
      if (seq !== state.loadSeq) return;
      if (res.status === 'ready') {
        state.rows = res.data;
        setStatus(null);
        break;
      }
      if (res.status === 'error') throw new Error(res.error);
      const p = res.progress || {};
      setStatus(`Building leaderboard… ${p.fetched || 0}${p.total ? ' / ' + p.total : ''} records`, p);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setStatus(null);
    $('load-board').disabled = false;
    const el = $('board-error');
    el.textContent = 'Failed to load leaderboard: ' + err.message;
    el.classList.remove('hidden');
    return;
  }

  $('load-board').disabled = false;
  render();
  // Projects are fetched only for the users on this board; there is no
  // workable equivalent across every campus at once.
  if (campusId !== 'all') pollProjects(cohort, seq);
}

// Project data is batch-fetched for the board's users right after the board
// loads — it streams in shortly after.
async function pollProjects(cohort, seq) {
  try {
    for (;;) {
      const res = await api(`/api/projects?${cohort}`);
      if (seq !== state.loadSeq) return;
      if (res.status === 'ready') {
        state.projects = res.data.counts;
        const lastC = res.data.last_c || {};
        for (const row of state.rows) {
          row.projects = state.projects[row.id] || 0;
          const lc = lastC[row.id];
          row.last_c = lc ? lc.last_c : null;
          row.last_c_ok = lc ? lc.last_c_ok : null;
          row.best_c = lc ? lc.best_c : null;
        }
        if (state.sortKey === 'projects' || state.sortKey === 'cproj') sortRows();
        render();
        return;
      }
      if (res.status === 'error') {
        $('board-meta').textContent = 'Project counts unavailable: ' + res.error;
        $('board-meta').classList.remove('hidden');
        return;
      }
      const p = res.progress || {};
      $('board-meta').textContent =
        `Loading projects… ${p.fetched || 0}${p.total ? ' / ' + p.total : ''} students`;
      $('board-meta').classList.remove('hidden');
      await new Promise((r) => setTimeout(r, 2500));
    }
  } catch {
    /* non-fatal: board still works without project counts */
  }
}

// --- year / month filters ----------------------------------------------------

function isPiscine() {
  return state.cursusKinds[Number($('cursus-select').value)] === 'piscine';
}

function isGlobal() {
  return $('campus-select').value === 'all';
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

// Filters must be pickable before anything is fetched, so the year/month
// options can't be derived from loaded rows — offer every year since 42
// opened instead, same as the worldwide view always did.
function buildTimeFilters() {
  const piscine = isPiscine();
  $('year-label-text').textContent = piscine ? 'Pool year' : 'Started in';

  const years = [];
  for (let y = new Date().getFullYear(); y >= 2013; y--) years.push(String(y));
  fillSelect($('year-select'), years, 'All years');
  $('year-label').classList.remove('hidden');

  if (piscine) {
    fillSelect($('month-select'), MONTHS, 'All months', (m) => m.charAt(0).toUpperCase() + m.slice(1));
    $('month-label').classList.remove('hidden');
    updateMonthAvailability();
  } else {
    $('month-label').classList.add('hidden');
    $('month-select').innerHTML = '';
  }

  // The "last C project" column only exists for piscine boards, and the data
  // comes from the per-campus projects scan — no equivalent worldwide.
  $('cproj-label').classList.toggle('hidden', !piscine || isGlobal());
}

// The C-module entry the current toggle asks to display for a row.
function lastCOf(r) {
  const mode = $('cproj-select').value;
  if (mode === 'validated') return r.last_c_ok;
  if (mode === 'best') return r.best_c;
  return r.last_c;
}

// A month filter needs a year picked first — the API range is begin_at
// between dates, and the server ignores month without a year.
function updateMonthAvailability() {
  if (!isPiscine()) return;
  const sel = $('month-select');
  const year = $('year-select').value;
  sel.disabled = !year;
  sel.title = year ? '' : 'Pick a year first';
  if (!year) sel.value = '';
}

// --- sorting & rendering ----------------------------------------------------

function sortRows() {
  const { sortKey, sortDir } = state;
  const val = (r) => {
    if (sortKey === 'pool') return `${r.pool_year || ''}-${String(r.pool_month || '')}`;
    if (sortKey === 'login') return r.login;
    if (sortKey === 'campus') return r.campus || '';
    if (sortKey === 'cproj') {
      // Module number first ("C 09" beats "C 07"), grade breaks ties.
      const p = lastCOf(r);
      return p ? (p.num ?? parseInt(p.name.slice(2), 10)) * 1000 + Math.min(p.mark, 999) : -Infinity;
    }
    const v = r[sortKey];
    return v === null || v === undefined ? -Infinity : v;
  };
  state.rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * sortDir;
    }
    return (va - vb) * sortDir || b.level - a.level;
  });
}

function render() {
  const tbody = $('board-body');
  const query = $('search-input').value.trim().toLowerCase();
  const hideStaff = $('hide-staff').checked;

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
  });

  const global = isGlobal();
  $('board').classList.toggle('piscine', isPiscine() && !global);
  const cprojMode = $('cproj-select').value;
  $('cproj-th').textContent =
    cprojMode === 'validated' ? 'Last C validated' : cprojMode === 'best' ? 'Best C pushed' : 'Last C pushed';
  // Rows are already restricted server-side (range[begin_at]) to whichever
  // year/month was picked before loading — only search/staff filter here.
  const visible = state.rows.filter((r) => {
    if (hideStaff && r.staff) return false;
    if (query && !r.login.toLowerCase().includes(query) &&
        !(r.displayname || '').toLowerCase().includes(query)) return false;
    return true;
  });

  if (state.rows.length) {
    let meta;
    if (global) {
      const year = $('year-select').value;
      const month = $('month-select').value;
      const period = year ? ` — ${month ? month.charAt(0).toUpperCase() + month.slice(1) + ' ' : ''}${year}` : '';
      meta = `Top ${visible.length} students worldwide by level${period}`;
    } else {
      meta = `${visible.length} students` +
        (state.projects === null ? ' — counting completed projects in the background…' : '');
    }
    $('board-meta').textContent = meta;
    $('board-meta').classList.remove('hidden');
  }

  const frag = document.createDocumentFragment();
  visible.forEach((r, i) => {
    const tr = document.createElement('tr');
    const rankCls = i < 3 ? ` rank-${i + 1}` : '';
    const levelPct = ((r.level % 1) * 100).toFixed(0);
    const badges =
      (r.staff ? '<span class="badge staff">staff</span>' : '') +
      (r.alumni ? '<span class="badge alumni">alumni</span>' : '');
    tr.innerHTML = `
      <td class="num rank${rankCls}">${i + 1}</td>
      <td>
        <div class="student">
          <img class="avatar" loading="lazy" src="${r.image || ''}" alt="" onerror="this.style.visibility='hidden'">
          <div>
            <a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.login)}</a>${badges}
            <div class="name">${escapeHtml(r.displayname || '')}</div>
          </div>
        </div>
      </td>
      <td class="campus-col dim">${escapeHtml(r.campus || '—')}</td>
      <td class="num">
        <div class="level-cell">
          <strong>${r.level.toFixed(2)}</strong>
          <div class="level-bar"><div class="level-bar-fill" style="width:${levelPct}%"></div></div>
        </div>
      </td>
      <td class="num">${r.projects === null ? `<span class="dim">${global ? '—' : '…'}</span>` : r.projects}</td>
      <td class="c-col">${cprojCell(r)}</td>
      <td class="num">${r.correction_point ?? '<span class="dim">—</span>'}</td>
      <td class="num">${r.wallet ?? '<span class="dim">—</span>'}</td>
      <td class="dim">${r.pool_month ? escapeHtml(`${r.pool_month} ${r.pool_year}`) : '—'}</td>`;
    frag.appendChild(tr);
  });
  tbody.replaceChildren(frag);
}

function cprojCell(r) {
  if (state.projects === null) return '<span class="dim">…</span>';
  const p = lastCOf(r);
  if (!p) return '<span class="dim">none</span>';
  return `${escapeHtml(p.name)} <span class="cgrade ${p.validated ? 'ok' : 'fail'}">${p.mark}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- PDF export ---------------------------------------------------------------

// The PDF is produced by the browser's print-to-PDF; the @media print styles
// in style.css turn the current (filtered, sorted) table into a bare list.
// Avatars below the viewport are lazy-loaded and would come out blank in the
// PDF, so force them all to load before opening the print dialog.
async function exportPdf() {
  const imgs = [...document.querySelectorAll('#board-body img.avatar')];
  for (const img of imgs) img.loading = 'eager';
  await Promise.allSettled(imgs.map((img) => img.decode()));
  window.print();
}

// --- events -----------------------------------------------------------------

$('export-pdf').addEventListener('click', exportPdf);

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir *= -1;
    } else {
      state.sortKey = key;
      state.sortDir = key === 'login' || key === 'pool' ? 1 : -1;
    }
    sortRows();
    render();
  });
});

// Changing a filter never triggers a fetch by itself — the previously loaded
// board is cleared and the user has to hit "Load leaderboard" again, so a
// campus scan never kicks off for a cohort they didn't ask to see.
function invalidate() {
  state.rows = [];
  state.projects = null;
  $('board-meta').classList.add('hidden');
  $('board-error').classList.add('hidden');
  $('board-hint').classList.remove('hidden');
  render();
}

$('campus-select').addEventListener('change', () => { buildTimeFilters(); invalidate(); });
$('cursus-select').addEventListener('change', () => { buildTimeFilters(); invalidate(); });
$('year-select').addEventListener('change', () => { updateMonthAvailability(); invalidate(); });
$('month-select').addEventListener('change', invalidate);
$('load-board').addEventListener('click', loadBoard);
$('search-input').addEventListener('input', render);
$('hide-staff').addEventListener('change', render);
$('cproj-select').addEventListener('change', () => {
  if (state.sortKey === 'cproj') sortRows();
  render();
});

boot();
