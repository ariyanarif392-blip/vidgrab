'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

const PORT = 39800;
let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => showWindow());

/* ------------------------------------------------------------------ */
/* Settings + persistence                                              */
/* ------------------------------------------------------------------ */
let settings = {};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const jobsFile = () => path.join(app.getPath('userData'), 'jobs.json');

function loadSettings() {
  const defaults = {
    downloadDir: app.getPath('downloads'),
    threads: 8,
    cookiesBrowser: '',
    autostart: true,
  };
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = defaults;
  }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

const jobs = new Map(); // id -> job (plain object, JSON-safe)
const procs = new Map(); // id -> child process
const timers = new Map(); // id -> retry timer
let persistTimer = null;

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const list = [...jobs.values()].slice(-100);
      fs.writeFileSync(jobsFile(), JSON.stringify(list));
    } catch {}
  }, 800);
}
function loadJobs() {
  try {
    const list = JSON.parse(fs.readFileSync(jobsFile(), 'utf8'));
    for (const j of list) {
      // anything that was running when the app closed is resumable
      if (['downloading', 'waiting', 'fetching', 'merging'].includes(j.state)) {
        j.state = j.title ? 'paused' : 'ready';
      }
      j.speed = 0; j.eta = 0;
      jobs.set(j.id, j);
    }
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Tools (yt-dlp / ffmpeg / winget)                                    */
/* ------------------------------------------------------------------ */
function toolEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const links = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links');
  env[key] = (env[key] || '') + path.delimiter + links;
  return env;
}
function run(cmd, args, timeout = 0) {
  return new Promise((resolve) => {
    execFile(
      cmd, args,
      { env: toolEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}
const ytdlp = () => 'yt-dlp';

async function checkDeps() {
  const [y, f, w] = await Promise.all([
    run(ytdlp(), ['--version'], 15000),
    run('ffmpeg', ['-version'], 15000),
    run('winget', ['--version'], 15000),
  ]);
  return {
    ytdlp: y.err ? null : y.stdout.trim(),
    ffmpeg: f.err ? null : (f.stdout.split('\n')[0] || '').slice(0, 60),
    winget: !w.err,
  };
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */
const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};
const lastEmit = new Map();
function emit(job, force = false) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(job.id) || 0) < 250) return;
  lastEmit.set(job.id, now);
  send('job:update', job);
  persistSoon();
}

function addJob(url, title) {
  // re-use an unfinished job for the same URL
  for (const j of jobs.values()) {
    if (j.url === url && j.state !== 'done') {
      showWindow();
      send('job:focus', j.id);
      return j;
    }
  }
  const job = {
    id: crypto.randomUUID(),
    url,
    title: title || url,
    thumbnail: '',
    duration: 0,
    uploader: '',
    vid: '',
    qualities: ['best'],
    quality: 'best',
    state: 'fetching',
    phase: '',
    percent: 0, speed: 0, eta: 0, downloaded: 0, total: 0,
    part: 0, retries: 0, filepath: '', error: '',
    created: Date.now(),
  };
  jobs.set(job.id, job);
  showWindow();
  emit(job, true);
  send('job:focus', job.id);
  fetchInfo(job);
  return job;
}

async function fetchInfo(job) {
  const args = ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), '--', job.url];
  const r = await run(ytdlp(), args, 60000);
  if (r.err || !r.stdout.trim()) {
    job.state = 'error';
    job.error = r.err && r.err.code === 'ENOENT'
      ? 'yt-dlp was not found. Open Settings and choose Install tools.'
      : lastLine(r.stderr) || 'Could not read this video.';
    return emit(job, true);
  }
  try {
    const info = JSON.parse(r.stdout);
    job.title = info.title || job.title;
    job.thumbnail = info.thumbnail || '';
    job.duration = info.duration || 0;
    job.uploader = info.uploader || info.channel || '';
    job.vid = info.id || '';
    const heights = new Set();
    for (const f of info.formats || []) if (f.height && f.vcodec !== 'none') heights.add(f.height);
    const ladder = [2160, 1440, 1080, 720, 480, 360].filter((h) => [...heights].some((x) => x >= h));
    job.qualities = ['best', ...ladder.map(String), 'audio'];
    job.quality = 'best';
    job.state = 'ready';
  } catch {
    job.state = 'error';
    job.error = 'Could not read video details.';
  }
  emit(job, true);
}

function cookieArgs() {
  return settings.cookiesBrowser ? ['--cookies-from-browser', settings.cookiesBrowser] : [];
}

function buildArgs(job) {
  const a = [
    '--no-playlist', '--newline', '--no-warnings', '--windows-filenames',
    '-c', '--retries', 'infinite', '--fragment-retries', 'infinite', '--retry-sleep', '3',
    '-N', String(settings.threads || 8),
    '-o', path.join(settings.downloadDir, '%(title).150B [%(id)s].%(ext)s'),
    '--progress-template',
    'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    ...cookieArgs(),
  ];
  const q = job.quality;
  if (q === 'audio') {
    a.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (q === 'best') {
    a.push('-f', 'bv*+ba/b', '-S', 'res,ext', '--merge-output-format', 'mp4');
  } else {
    a.push('-f', `bv*[height<=${Number(q)}]+ba/b[height<=${Number(q)}]`, '-S', 'res,ext', '--merge-output-format', 'mp4');
  }
  a.push('--', job.url); // '--' stops option injection from untrusted URLs
  return a;
}

const num = (v) => {
  const n = Number(v);
  return v && v !== 'NA' && v !== 'None' && Number.isFinite(n) ? n : 0;
};

function parseLine(job, line) {
  if (line.startsWith('PROG|')) {
    const [, d, t, te, sp, eta] = line.split('|');
    const total = num(t) || num(te);
    job.downloaded = num(d);
    job.total = total;
    job.percent = total ? Math.min(100, (job.downloaded / total) * 100) : 0;
    job.speed = num(sp);
    job.eta = num(eta);
    job.phase = job.part > 1 ? `Downloading (stream ${job.part})` : 'Downloading';
    if (job.speed > 0) job.retries = 0;
    job.state = 'downloading';
    emit(job);
    return;
  }
  let m;
  if ((m = line.match(/\[download\] Destination: (.+)$/))) {
    job.part += 1;
    job.filepath = m[1].trim();
  } else if ((m = line.match(/\[Merger\] Merging formats into "(.+)"/))) {
    job.filepath = m[1];
    job.state = 'merging'; job.phase = 'Merging video and audio'; job.speed = 0; job.eta = 0;
    emit(job, true);
  } else if ((m = line.match(/\[ExtractAudio\] Destination: (.+)$/))) {
    job.filepath = m[1].trim();
    job.state = 'merging'; job.phase = 'Converting to MP3'; job.speed = 0; job.eta = 0;
    emit(job, true);
  } else if ((m = line.match(/\[download\] (.+) has already been downloaded/))) {
    job.filepath = m[1].trim();
  }
}

const lastLine = (s) => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
const isNetworkError = (s) =>
  /(timed out|timeout|connection|network|getaddrinfo|reset by peer|unreachable|HTTP Error 5\d\d|Temporary failure|Read error|incomplete)/i.test(s);

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {});
  else p.kill('SIGTERM');
}

function startDownload(job) {
  clearTimeout(timers.get(job.id));
  if (procs.has(job.id)) return;
  job.state = 'downloading';
  job.phase = 'Starting';
  job.error = '';
  job.part = 0;
  job.stop = null;
  emit(job, true);

  const p = spawn(ytdlp(), buildArgs(job), { env: toolEnv(), windowsHide: true });
  procs.set(job.id, p);
  const errTail = [];
  let spawnFailed = false;

  readline.createInterface({ input: p.stdout }).on('line', (l) => parseLine(job, l));
  p.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
      errTail.push(l);
      if (errTail.length > 12) errTail.shift();
    });
  });
  p.on('error', (e) => {
    spawnFailed = true;
    procs.delete(job.id);
    job.state = 'error';
    job.error = e.code === 'ENOENT' ? 'yt-dlp was not found. Open Settings and choose Install tools.' : e.message;
    emit(job, true);
  });
  p.on('close', (code) => {
    if (spawnFailed) return;
    procs.delete(job.id);
    job.speed = 0; job.eta = 0;
    if (job.stop === 'pause') {
      job.state = 'paused'; job.phase = '';
    } else if (job.stop === 'cancel') {
      return; // job already removed
    } else if (code === 0) {
      job.state = 'done'; job.percent = 100; job.phase = '';
    } else {
      const msg = errTail.join('\n');
      if (isNetworkError(msg) && job.retries < 80) {
        job.retries += 1;
        job.state = 'waiting';
        job.phase = 'Connection lost, retrying';
        const delay = Math.min(30, 2 + job.retries * 3) * 1000;
        timers.set(job.id, setTimeout(() => { if (job.state === 'waiting') startDownload(job); }, delay));
      } else {
        job.state = 'error';
        job.error = lastLine(msg) || 'Download failed.';
      }
    }
    job.stop = null;
    emit(job, true);
  });
}

function pauseJob(job) {
  clearTimeout(timers.get(job.id));
  const p = procs.get(job.id);
  if (p) { job.stop = 'pause'; killTree(p); }
  else if (job.state === 'waiting') { job.state = 'paused'; job.phase = ''; emit(job, true); }
}

function removeJob(job, cleanPartial) {
  clearTimeout(timers.get(job.id));
  const p = procs.get(job.id);
  if (p) { job.stop = 'cancel'; killTree(p); }
  jobs.delete(job.id);
  send('job:remove', job.id);
  persistSoon();
  if (cleanPartial && job.vid) {
    setTimeout(() => {
      try {
        for (const f of fs.readdirSync(settings.downloadDir)) {
          if (f.includes(`[${job.vid}]`) && /(\.part|\.ytdl|\.temp|\.f\d+\.\w+|\.part-Frag\d+)$/.test(f)) {
            fs.rmSync(path.join(settings.downloadDir, f), { force: true });
          }
        }
      } catch {}
    }, 1200);
  }
}

/* ------------------------------------------------------------------ */
/* Local server used by the browser extension                          */
/* ------------------------------------------------------------------ */
function startServer() {
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const origin = req.headers.origin || '';
    const originOk = !origin || /^(chrome|moz)-extension:\/\//.test(origin);
    const hostOk = /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '');
    if (origin && originOk) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VidGrab');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (!originOk || !hostOk) return json(403, { ok: false });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.headers['x-vidgrab'] !== '1') return json(403, { ok: false });

    if (req.method === 'GET' && req.url === '/ping') return json(200, { ok: true, app: 'VidGrab' });

    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { url, title } = JSON.parse(body);
          const u = new URL(url);
          if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
          addJob(u.href, String(title || '').slice(0, 200));
          json(200, { ok: true });
        } catch {
          json(400, { ok: false, error: 'Bad request' });
        }
      });
      return;
    }
    json(404, { ok: false });
  });
  server.on('error', (e) => console.error('Local server error:', e.message));
  server.listen(PORT, '127.0.0.1');
}

/* ------------------------------------------------------------------ */
/* Window + tray                                                       */
/* ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 600, height: 780, minWidth: 460, minHeight: 520,
    backgroundColor: '#14112B',
    title: 'VidGrab',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  const reveal = () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true); // pop in front of the browser...
    win.focus();
    win.setAlwaysOnTop(false); // ...but don't stay there
  };
  if (win.webContents.isLoading()) win.once('ready-to-show', reveal);
  else reveal();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('VidGrab');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open VidGrab', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

/* ------------------------------------------------------------------ */
/* Auto-update from GitHub Releases                                    */
/* ------------------------------------------------------------------ */
function updateStatus(s) { send('update:status', s); }

let installAfterDownload = false;
function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => updateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => updateStatus({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => updateStatus({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => updateStatus({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => {
    updateStatus({ state: 'ready', version: i.version });
    if (installAfterDownload) { quitting = true; autoUpdater.quitAndInstall(); } // one tap: download, then restart
  });
  autoUpdater.on('error', (e) => updateStatus({ state: 'error', message: String(e && e.message || e).split('\n')[0] }));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function setupIpc() {
  ipcMain.handle('jobs:list', () => [...jobs.values()]);
  ipcMain.handle('jobs:add', (_e, url) => {
    try {
      const u = new URL(String(url).trim());
      if (!/^https?:$/.test(u.protocol)) return false;
      addJob(u.href, '');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('job:quality', (_e, id, q) => { const j = jobs.get(id); if (j) { j.quality = String(q); persistSoon(); } });
  ipcMain.handle('job:start', (_e, id) => { const j = jobs.get(id); if (j) { j.retries = 0; startDownload(j); } });
  ipcMain.handle('job:pause', (_e, id) => { const j = jobs.get(id); if (j) pauseJob(j); });
  ipcMain.handle('job:cancel', (_e, id) => { const j = jobs.get(id); if (j) removeJob(j, true); });
  ipcMain.handle('job:remove', (_e, id) => { const j = jobs.get(id); if (j) removeJob(j, false); });
  ipcMain.handle('job:reveal', (_e, id) => {
    const j = jobs.get(id);
    if (j && j.filepath && fs.existsSync(j.filepath)) shell.showItemInFolder(j.filepath);
    else shell.openPath(settings.downloadDir);
  });
  ipcMain.handle('job:open', (_e, id) => {
    const j = jobs.get(id);
    if (j && j.filepath && fs.existsSync(j.filepath)) shell.openPath(j.filepath);
  });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, s) => {
    settings = {
      ...settings,
      threads: Math.min(16, Math.max(1, Number(s.threads) || 8)),
      cookiesBrowser: ['', 'chrome', 'edge', 'firefox', 'brave'].includes(s.cookiesBrowser) ? s.cookiesBrowser : '',
      autostart: !!s.autostart,
      downloadDir: s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : settings.downloadDir,
    };
    saveSettings();
    applyAutostart();
    return settings;
  });
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.downloadDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('tools:check', checkDeps);
  ipcMain.handle('tools:install', async () => {
    const flags = ['-e', '--accept-source-agreements', '--accept-package-agreements'];
    const a = await run('winget', ['install', ...flags, '--id', 'yt-dlp.yt-dlp'], 600000);
    const b = await run('winget', ['install', ...flags, '--id', 'Gyan.FFmpeg'], 900000);
    return { log: [lastLine(a.stdout), lastLine(b.stdout)].filter(Boolean).join('\n'), deps: await checkDeps() };
  });
  ipcMain.handle('tools:updateYtdlp', async () => {
    let r = await run(ytdlp(), ['-U'], 120000);
    let out = (r.stdout + '\n' + r.stderr).trim();
    if (r.err || /package manager|pip|winget/i.test(out)) {
      r = await run('winget', ['upgrade', '-e', '--id', 'yt-dlp.yt-dlp', '--accept-source-agreements', '--accept-package-agreements'], 300000);
      out = lastLine(r.stdout) || lastLine(r.stderr) || out;
    }
    return { log: lastLine(out), deps: await checkDeps() };
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return updateStatus({ state: 'dev' });
    try { await autoUpdater.checkForUpdates(); } catch (e) { updateStatus({ state: 'error', message: String(e.message).split('\n')[0] }); }
  });
  ipcMain.handle('update:download', () => { installAfterDownload = true; return autoUpdater.downloadUpdate().catch(() => {}); });
  ipcMain.handle('update:install', () => { quitting = true; autoUpdater.quitAndInstall(); });
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.autostart, args: ['--hidden'] });
}

/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  loadSettings();
  loadJobs();
  setupIpc();
  setupUpdater();
  startServer();
  createTray();
  createWindow();
  applyAutostart();
  if (!process.argv.includes('--hidden')) showWindow();
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }
});

app.on('before-quit', () => {
  quitting = true;
  for (const p of procs.values()) killTree(p);
  try { fs.writeFileSync(jobsFile(), JSON.stringify([...jobs.values()].slice(-100))); } catch {}
});
app.on('window-all-closed', () => { /* keep running in the tray */ });
