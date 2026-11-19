'use strict';
const $ = (s) => document.querySelector(s);
const list = $('#list');
const jobs = new Map();

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/* ---------- card rendering ---------- */
function cardHTML(j) {
  const [label, tone] = STATE[j.state] || ['', ''];
  const dur = j.duration ? `<small>${clock(j.duration)}</small>` : '';
  const thumb = j.thumbnail ? `style="background-image:url('${esc(j.thumbnail)}')"` : '';
  const who = j.uploader ? ` ${esc(j.uploader)}` : '';
  const phase = j.phase && ['downloading', 'merging', 'waiting'].includes(j.state) ? j.phase : '';

  let body = '';
  const showBar = ['downloading', 'merging', 'waiting', 'paused', 'done'].includes(j.state) || j.percent > 0;
  if (showBar) {
    const pct = j.state === 'done' ? 100 : j.percent;
    const left = j.state === 'done' ? '-' : clock(j.eta);
    body += `<div class="bar" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="stats">
        <div class="pct">${pct.toFixed(1)}<small>%</small></div>
        <div class="stat"><b>${j.state === 'downloading' ? speed(j.speed) : '-'}</b><span>Speed</span></div>
        <div class="stat"><b>${left}</b><span>Time left</span></div>
        <div class="stat"><b>${bytes(j.downloaded)}${j.total ? ' / ' + bytes(j.total) : ''}</b><span>Downloaded</span></div>
      </div>`;
  }
  if (j.state === 'error') body += `<div class="err">${esc(j.error)}</div>`;

  let actions = '';
  switch (j.state) {
    case 'fetching':
      actions = `<span class="grow"></span><button class="danger" data-a="remove">Remove</button>`;
      break;
    case 'ready':
      actions = `<select data-a="quality" aria-label="Quality">${(j.qualities || ['best'])
        .map((q) => `<option value="${q}" ${q === j.quality ? 'selected' : ''}>${qLabel(q)}</option>`).join('')}</select>
        <span class="grow"></span>
        <button class="danger" data-a="remove">Remove</button>
        <button class="primary" data-a="start">Start</button>`;
      break;
    case 'downloading':
    case 'merging':
    case 'waiting':
      actions = `<span class="grow"></span>
        <button class="secondary" data-a="pause">Stop</button>
        <button class="danger" data-a="cancel">Cancel</button>`;
      break;
    case 'paused':
      actions = `<span class="grow"></span>
        <button class="danger" data-a="cancel">Cancel</button>
        <button class="primary" data-a="start">Resume</button>`;
      break;
    case 'done':
      actions = `<span class="grow"></span>
        <button class="secondary" data-a="reveal">Show in folder</button>
        <button class="secondary" data-a="open">Play</button>
        <button class="ghost" data-a="remove">Clear</button>`;
      break;
    case 'error':
      actions = `<span class="grow"></span>
        <button class="danger" data-a="remove">Remove</button>
        <button class="primary" data-a="start">Try again</button>`;
      break;
  }

  return `<div class="head">
      <div class="thumb" ${thumb}>${dur}</div>
      <div class="meta">
        <p class="title">${esc(j.title)}</p>
        <div class="sub"><span class="chip ${tone}">${label}</span>${phase ? esc(phase) : who}</div>
      </div>
    </div>${body}<div class="actions">${actions}</div>`;
}

function upsert(j) {
  jobs.set(j.id, j);
  let el = list.querySelector(`[data-id="${j.id}"]`);
  if (!el) {
    el = document.createElement('article');
    el.dataset.id = j.id;
    list.prepend(el);
  }
  // keep an open dropdown from being rebuilt while the user is choosing
  if (j.state === 'ready' && el.dataset.state === 'ready' && el.contains(document.activeElement)) return;
  el.className = `card ${j.state}`;
  el.dataset.state = j.state;
  el.innerHTML = cardHTML(j);
}

function drop(id) {
  jobs.delete(id);
  const el = list.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
}

/* ---------- events ---------- */
list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const a = btn.dataset.a;
  if (a === 'start') window.api.start(id);
  else if (a === 'pause') window.api.pause(id);
  else if (a === 'cancel') window.api.cancel(id);
  else if (a === 'remove') window.api.remove(id);
  else if (a === 'reveal') window.api.reveal(id);
  else if (a === 'open') window.api.openFile(id);
});
list.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-a="quality"]');
  if (sel) window.api.setQuality(sel.closest('.card').dataset.id, sel.value);
});

window.api.on('job:update', upsert);
window.api.on('job:remove', drop);
window.api.on('job:focus', (id) => {
  const el = list.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  list.prepend(el);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  list.scrollTop = 0;
});

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addInput');
  const v = input.value.trim();
  if (!v) return;
  if (await window.api.add(v)) input.value = '';
  else { input.setCustomValidity('Enter a full link starting with https://'); input.reportValidity(); input.setCustomValidity(''); }
});

/* ---------- tools banner ---------- */
async function refreshTools() {
  const d = await window.api.checkTools();
  const missing = [];
  if (!d.ytdlp) missing.push('yt-dlp');
  if (!d.ffmpeg) missing.push('ffmpeg');
  const banner = $('#banner');
  if (missing.length) {
    $('#bannerText').textContent = d.winget
      ? `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed to download. Install takes about a minute.`
      : `${missing.join(' and ')} missing, and winget was not found. Install them manually.`;
    $('#bannerBtn').hidden = !d.winget;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  $('#toolsInfo').textContent = `yt-dlp: ${d.ytdlp || 'not installed'}  |  ffmpeg: ${d.ffmpeg ? 'installed' : 'not installed'}`;
  return d;
}
async function installTools(btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Installing...';
  $('#toolsLog').textContent = 'Running winget. Keep this window open.';
  const r = await window.api.installTools();
  $('#toolsLog').textContent = r.log || 'Done.';
  btn.disabled = false; btn.textContent = old;
  refreshTools();
}
$('#bannerBtn').addEventListener('click', (e) => installTools(e.target));
$('#toolsInstall').addEventListener('click', (e) => installTools(e.target));
$('#toolsUpdate').addEventListener('click', async (e) => {
  const b = e.target; const old = b.textContent;
  b.disabled = true; b.textContent = 'Updating...';
  const r = await window.api.updateYtdlp();
  $('#toolsLog').textContent = r.log || 'Done.';
  b.disabled = false; b.textContent = old;
  refreshTools();
});

/* ---------- settings ---------- */
const dlg = $('#settings');
$('#btnSettings').addEventListener('click', async () => {
  const s = await window.api.getSettings();
  $('#setDir').value = s.downloadDir;
  $('#setThreads').value = s.threads;
  $('#setThreadsOut').textContent = s.threads;
  $('#setCookies').value = s.cookiesBrowser || '';
  $('#setAuto').checked = !!s.autostart;
  $('#appVer').textContent = 'v' + (await window.api.version());
  refreshTools();
  dlg.showModal();
});
$('#setThreads').addEventListener('input', (e) => { $('#setThreadsOut').textContent = e.target.value; });
$('#setPick').addEventListener('click', async () => {
  const d = await window.api.pickDir();
  if (d) $('#setDir').value = d;
});
$('#setForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'save') {
    await window.api.saveSettings({
      downloadDir: $('#setDir').value,
      threads: $('#setThreads').value,
      cookiesBrowser: $('#setCookies').value,
      autostart: $('#setAuto').checked,
    });
  }
});

/* ---------- app updates (GitHub releases) ---------- */
const updInfo = $('#updInfo');
function setUpd(s) {
  const get = $('#updGet'), inst = $('#updInstall'), dot = $('#updDot');
  get.hidden = inst.hidden = true;
  dot.hidden = !['available', 'ready'].includes(s.state);
  switch (s.state) {
    case 'checking': updInfo.textContent = 'Checking GitHub for a new version...'; break;
    case 'latest': updInfo.textContent = 'You have the latest version.'; break;
    case 'available': updInfo.textContent = `Version ${s.version} is available. One tap installs it and restarts the app.`; get.hidden = false; break;
    case 'downloading': updInfo.textContent = `Downloading update... ${Math.round(s.percent || 0)}%. The app restarts when done.`; break;
    case 'ready': updInfo.textContent = `Version ${s.version} is ready to install.`; inst.hidden = false; break;
    case 'dev': updInfo.textContent = 'Updates only work in the installed app, not in dev mode.'; break;
    case 'error': updInfo.textContent = `Update check failed: ${s.message || 'unknown error'}`; break;
  }
}
window.api.on('update:status', setUpd);
$('#updCheck').addEventListener('click', () => window.api.checkUpdate());
$('#updGet').addEventListener('click', () => window.api.downloadUpdate());
$('#updInstall').addEventListener('click', () => window.api.installUpdate());
$('#btnUpdate').addEventListener('click', () => {
  $('#btnSettings').click();
  window.api.checkUpdate();
});

/* ---------- browser extension ---------- */
function setExt(connected) {
  const p = $('#extPill');
  p.textContent = connected ? 'Connected' : 'Not connected';
  p.classList.toggle('on', !!connected);
  p.classList.toggle('off', !connected);
}
window.api.on('ext:status', (s) => setExt(s.connected));
const browserDlg = $('#browserDlg');
$('#btnBrowser').addEventListener('click', async () => {
  $('#browserMsg').textContent = '';
  $('#browserSteps').hidden = true;
  const list = await window.api.browsers();
  const box = $('#browserList');
  box.textContent = '';
  $('#browserNone').hidden = list.length > 0;
  for (const b of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = b.name;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      $('#browserMsg').textContent = 'Working...';
      const r = await window.api.setupBrowser(b.id);
      btn.disabled = false;
      if (r.ok) {
        $('#browserSteps').hidden = false;
        $('#browserMsg').textContent = `Folder copied to ${r.path} and the path is on your clipboard. ${r.name} opened its extensions page.`;
      } else {
        $('#browserMsg').textContent = r.error || 'Failed.';
      }
    });
    box.appendChild(btn);
  }
  browserDlg.showModal();
});
setInterval(async () => { try { setExt((await window.api.extStatus()).connected); } catch {} }, 5000);

/* ---------- boot ---------- */
(async () => {
  const all = await window.api.jobs();
  all.sort((a, b) => a.created - b.created).forEach(upsert);
  refreshTools();
  try { setExt((await window.api.extStatus()).connected); } catch {}
})();
