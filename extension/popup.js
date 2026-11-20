'use strict';
const APP = 'http://127.0.0.1:39800';
const HEAD = { 'Content-Type': 'application/json', 'X-VidGrab': '1' };
const id = new URLSearchParams(location.search).get('id') || '';
const $ = (s) => document.querySelector(s);

/* ---------- helpers ---------- */
function bytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const speed = (n) => (n ? `${bytes(n)}/s` : '-');
function clock(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
const qLabel = (q) => (q === 'best' ? 'Best quality' : q === 'audio' ? 'Audio only (MP3)' : `${q}p`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE = {
  fetching: ['Reading video', 'live'],
  ready: ['Ready', 'ok'],
  downloading: ['Downloading', 'live'],
  merging: ['Finishing', 'live'],
  paused: ['Paused', 'warn'],
  waiting: ['Reconnecting', 'warn'],
  done: ['Completed', 'ok'],
  error: ['Failed', 'bad'],
};

/* ---------- talking to the app ---------- */
async function getJob() {
  const r = await fetch(`${APP}/job?id=${encodeURIComponent(id)}`, { headers: HEAD });
  if (r.status === 404) return { gone: true };
  const j = await r.json();
  return j && j.ok ? { job: j.job } : { gone: true };
}
async function post(action, extra = {}) {
  try {
    await fetch(`${APP}/job/${action}`, { method: 'POST', headers: HEAD, body: JSON.stringify({ id, ...extra }) });
  } catch {}
}

/* ---------- rendering ---------- */
const actions = $('#actions');
let shown = '';

function buildActions(j) {
  switch (j.state) {
    case 'fetching':
      return '<span class="grow"></span><button class="danger" data-a="remove">Cancel</button>';
    case 'ready':
      return `<select data-a="quality" aria-label="Quality">${(j.qualities || ['best'])
        .map((q) => `<option value="${esc(q)}" ${q === j.quality ? 'selected' : ''}>${esc(qLabel(q))}</option>`).join('')}</select>
        <span class="grow"></span>
        <button class="danger" data-a="remove">Cancel</button>
        <button class="primary" data-a="start">Start</button>`;
    case 'downloading':
    case 'merging':
    case 'waiting':
      return `<span class="grow"></span>
        <button class="secondary" data-a="pause">Stop</button>
        <button class="danger" data-a="cancel">Cancel</button>`;
    case 'paused':
      return `<span class="grow"></span>
        <button class="danger" data-a="cancel">Cancel</button>
        <button class="primary" data-a="start">Resume</button>`;
    case 'done':
      return `<span class="grow"></span>
        <button class="secondary" data-a="reveal">Show in folder</button>
        <button class="secondary" data-a="open">Play</button>
        <button class="ghost" data-a="close">Close</button>`;
    case 'error':
      return `<span class="grow"></span>
        <button class="danger" data-a="remove">Remove</button>
        <button class="primary" data-a="start">Try again</button>`;
    default:
      return '';
  }
}

function render(j) {
  const [label, tone] = STATE[j.state] || ['', ''];
  const card = $('#card');
  card.className = `card ${j.state}`;

  $('#title').textContent = j.title || 'Video';
  document.title = `VidGrab - ${j.title || 'Video'}`;
  $('#thumb').style.backgroundImage = j.thumbnail ? `url("${String(j.thumbnail).replace(/"/g, '%22')}")` : '';
  const dur = $('#dur');
  dur.hidden = !j.duration;
  dur.textContent = j.duration ? clock(j.duration) : '';

  const chip = $('#chip');
  chip.textContent = label;
  chip.className = `chip ${tone}`;
  const phase = j.phase && j.phase !== label && ['downloading', 'merging', 'waiting'].includes(j.state) ? j.phase : '';
  $('#sub').textContent = phase || j.uploader || '';

  $('#indet').hidden = j.state !== 'fetching';

  const showBar = ['downloading', 'merging', 'waiting', 'paused', 'done'].includes(j.state) || j.percent > 0;
  $('#prog').hidden = !showBar;
  if (showBar) {
    const pct = j.state === 'done' ? 100 : (j.percent || 0);
    $('#fill').style.width = `${pct.toFixed(1)}%`;
    $('#bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    $('#pct').textContent = pct.toFixed(1);
    $('#spd').textContent = j.state === 'downloading' ? speed(j.speed) : '-';
    $('#eta').textContent = j.state === 'done' ? '-' : clock(j.eta);
    $('#size').textContent = `${bytes(j.downloaded)}${j.total ? ' / ' + bytes(j.total) : ''}`;
  }

  const err = $('#err');
  err.hidden = j.state !== 'error';
  err.textContent = j.state === 'error' ? j.error : '';

  // Rebuild the buttons only when the state changes, so an open quality dropdown is not reset
  if (j.state !== shown) {
    actions.innerHTML = buildActions(j);
    shown = j.state;
  }
}

function showMessage(text, tone) {
  $('#card').className = `card ${tone || 'error'}`;
  $('#chip').textContent = tone === 'warn' ? 'Waiting' : 'Problem';
  $('#chip').className = `chip ${tone || 'bad'}`;
  $('#title').textContent = text;
  $('#sub').textContent = '';
  $('#indet').hidden = true;
  $('#prog').hidden = true;
  $('#err').hidden = true;
  actions.innerHTML = '<span class="grow"></span><button class="ghost" data-a="close">Close</button>';
  shown = 'message';
}

/* ---------- polling ---------- */
let misses = 0;
let closing = false;
async function tick() {
  if (closing) return;
  try {
    const r = await getJob();
    misses = 0;
    if (r.gone) {
      closing = true;
      showMessage('This download was removed.', 'warn');
      setTimeout(() => window.close(), 1200);
      return;
    }
    render(r.job);
  } catch {
    if (++misses >= 3) showMessage('VidGrab is not running. Open it from the Start menu or the tray.');
  }
}

/* ---------- buttons ---------- */
actions.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  const a = btn.dataset.a;
  if (a === 'close') return window.close();
  if (a === 'remove' || a === 'cancel') {
    closing = true;
    await post(a);
    return window.close();
  }
  btn.disabled = true;
  await post(a);
  await tick();
  btn.disabled = false;
});
actions.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-a="quality"]');
  if (sel) post('quality', { quality: sel.value });
});

if (!id) showMessage('No video was given to this window.');
else {
  tick();
  setInterval(tick, 600);
}
