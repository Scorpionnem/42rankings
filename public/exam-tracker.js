'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  rows: [],
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
  $('exam-view').classList.remove('hidden');

  await loadCampuses();
  loadExamTracker();
}

async function loadCampuses() {
  const campuses = await waitForRef('/api/campuses');
  const sel = $('campus-select');
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = '🌍 All campuses';
  sel.appendChild(all);
  for (const c of campuses) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.country})`;
    sel.appendChild(opt);
  }
  if (state.me.campus_id) sel.value = String(state.me.campus_id);
}

// --- exam tracker loading -----------------------------------------------------

function setStatus(text, progress) {
  const bar = $('status-bar');
  if (text === null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('status-text').textContent = text;
  const pct = progress && progress.total ? Math.min(100, (progress.fetched / progress.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
}

async function loadExamTracker(force = false) {
  const seq = ++state.loadSeq;
  const campusId = $('campus-select').value;
  if (!campusId) return;
  $('exam-table').classList.toggle('global', campusId === 'all');

  const url = `/api/exam-tracker?campus_id=${campusId}`;

  state.rows = [];
  $('exam-error').classList.add('hidden');
  $('exam-meta').classList.add('hidden');
  $('exam-empty').classList.add('hidden');
  $('refresh-exam').disabled = true;
  render();

  try {
    // The refresh flag is only sent on the kick-off request — resending it on
    // every poll would blow away the in-progress job and restart it forever.
    let first = true;
    for (;;) {
      const res = await api(first && force ? `${url}&refresh=1` : url);
      first = false;
      if (seq !== state.loadSeq) return;
      if (res.status === 'ready') {
        state.rows = res.data.slice().sort((a, b) => (b.final_mark ?? -1) - (a.final_mark ?? -1));
        setStatus(null);
        break;
      }
      if (res.status === 'error') throw new Error(res.error);
      const p = res.progress || {};
      setStatus(`Scanning ongoing exams… ${p.fetched || 0}${p.total ? ' / ' + p.total : ''} requests`, p);
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    setStatus(null);
    $('refresh-exam').disabled = false;
    const el = $('exam-error');
    el.textContent = 'Failed to load exam tracker: ' + err.message;
    el.classList.remove('hidden');
    return;
  }

  $('refresh-exam').disabled = false;
  render();
}

// --- rendering ----------------------------------------------------------------

function render() {
  const tbody = $('exam-body');
  const query = $('search-input').value.trim().toLowerCase();

  const kind = $('kind-select').value;
  const visible = state.rows.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (query && !r.login.toLowerCase().includes(query) &&
        !(r.displayname || '').toLowerCase().includes(query)) return false;
    return true;
  });

  if (state.rows.length) {
    const noun = kind === 'piscine' ? 'pisciner' : 'student';
    $('exam-meta').textContent = `${visible.length} ${noun}${visible.length === 1 ? '' : 's'} currently in an exam`;
    $('exam-meta').classList.remove('hidden');
    $('exam-empty').classList.add('hidden');
  } else {
    $('exam-meta').classList.add('hidden');
    $('exam-empty').classList.remove('hidden');
  }

  const frag = document.createDocumentFragment();
  visible.forEach((r, i) => {
    const tr = document.createElement('tr');
    const rankCls = i < 3 && r.final_mark !== null ? ` rank-${i + 1}` : '';
    const badges = r.staff ? '<span class="badge staff">staff</span>' : '';
    const gradePct = Math.max(0, Math.min(100, r.final_mark ?? 0));
    const gradeLabel = r.final_mark === null ? '<span class="dim">starting…</span>' : `<strong>${r.final_mark}</strong>`;
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
      <td class="dim">${escapeHtml(r.exam_name || '—')}</td>
      <td class="dim">${escapeHtml(r.project_name || '—')}</td>
      <td class="num">
        <div class="level-cell">
          ${gradeLabel}
          <div class="level-bar"><div class="level-bar-fill" style="width:${gradePct}%"></div></div>
        </div>
      </td>
      <td class="dim">${escapeHtml(r.status || '—')}</td>`;
    frag.appendChild(tr);
  });
  tbody.replaceChildren(frag);
}

// --- events -----------------------------------------------------------------

$('campus-select').addEventListener('change', () => loadExamTracker());
$('kind-select').addEventListener('change', render);
$('refresh-exam').addEventListener('click', () => loadExamTracker(true));
$('search-input').addEventListener('input', render);

boot();
