'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, clipboard } = require('electron');
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

const gotLock = app.requestSingleInstanceLock();
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
      j.speed = 0; j.eta = 0; j.loading = false;
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
function run(cmd, args, timeout = 0, onSpawn = null) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd, args,
      { env: toolEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
    if (onSpawn) onSpawn(child);
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

// What can be known about a link without asking anyone: for YouTube the video id, and from it
// the thumbnail address. This lets the card show a picture the moment it opens.
function quickMeta(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = '';
    if (host === 'youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else { const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/); if (m) id = m[1]; }
    } else if (host === 'youtu.be') {
      id = u.pathname.slice(1, 12);
    }
    if (/^[\w-]{11}$/.test(id)) return { vid: id, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
  } catch {}
  return { vid: '', thumbnail: '' };
}

// silent = the request came from the browser extension, which shows its own popup,
// so the app window must stay where it is.
function addJob(url, title, silent = false) {
  // re-use an unfinished job for the same URL
  for (const j of jobs.values()) {
    if (j.url === url && j.state !== 'done') {
      if (!silent) {
        showWindow();
        send('job:focus', j.id);
      }
      return j;
    }
  }
  const quick = quickMeta(url);
  // The job is "ready" at once, so Start works straight away. The full details (duration,
  // quality list) are read by yt-dlp in the background and filled in when they arrive.
  const job = {
    id: crypto.randomUUID(),
    url,
    title: title || url,
    thumbnail: quick.thumbnail,
    duration: 0,
    uploader: '',
    vid: quick.vid,
    qualities: ['best', 'audio'],
    quality: 'best',
    loading: true,
    state: 'ready',
    phase: '',
    percent: 0, speed: 0, eta: 0, downloaded: 0, total: 0,
    part: 0, retries: 0, filepath: '', error: '',
    created: Date.now(),
  };
  jobs.set(job.id, job);
  if (!silent) showWindow();
  emit(job, true);
  if (!silent) send('job:focus', job.id);
  fetchInfo(job);
  return job;
}

/* Reading a video with yt-dlp takes seconds (start-up plus asking the site). It is done once per
   link, the answer is kept, and the download later starts from that saved answer instead of asking
   the site again. The same read is shared by the extension's early look (/prefetch) and the job. */
const INFO_MS = 20 * 60 * 1000; // how long a saved read stays usable; video addresses expire after hours
const infoCache = new Map(); // key -> { at, promise, res, file }
const infoKey = (url) => `${settings.cookiesBrowser || ''}|${url}`;
const infoDir = () => path.join(app.getPath('userData'), 'info');
let prefetching = 0;

function dropInfo(key) {
  const e = infoCache.get(key);
  if (e && e.file) { try { fs.rmSync(e.file, { force: true }); } catch {} }
  infoCache.delete(key);
}

function readInfo(url) {
  const key = infoKey(url);
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_MS) return hit.promise;
  if (hit) dropInfo(key);
  const e = { at: Date.now(), res: null, file: '' };
  e.promise = (async () => {
    // skip=translated_subs: the long list of auto-translated captions is not needed here
    const args = ['-J', '--no-playlist', '--no-warnings', '--extractor-args', 'youtube:skip=translated_subs', ...cookieArgs(), '--', url];
    const r = await run(ytdlp(), args, 60000);
    let res;
    if (r.err || !r.stdout.trim()) res = { ok: false, err: r.err, stderr: r.stderr };
    else {
      try { res = { ok: true, info: JSON.parse(r.stdout), raw: r.stdout }; } catch { res = { ok: false, bad: true }; }
    }
    e.res = res;
    if (!res.ok && infoCache.get(key) === e) infoCache.delete(key); // a failed read is not kept
    return res;
  })();
  infoCache.set(key, e);
  while (infoCache.size > 12) dropInfo(infoCache.keys().next().value);
  return e.promise;
}

// The saved read as a file yt-dlp can start from (--load-info-json), or null when there is none
// that can be trusted: not read yet, failed, too old, or already shown not to work for this job.
function infoFileFor(job) {
  const key = infoKey(job.url);
  const e = infoCache.get(key);
  if (job.noInfo || !e || !e.res || !e.res.ok || Date.now() - e.at > INFO_MS) return null;
  if (!e.file) {
    try {
      fs.mkdirSync(infoDir(), { recursive: true });
      const f = path.join(infoDir(), crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
      fs.writeFileSync(f, e.res.raw);
      e.file = f;
    } catch { return null; }
  }
  return e.file;
}

async function fetchInfo(job) {
  const res = await readInfo(job.url);
  if (!jobs.has(job.id)) return; // removed while it was being read
  job.loading = false;
  // Only change the state if the user has not pressed Start in the meantime
  const idle = job.state === 'ready';

  if (!res.ok) {
    if (idle) {
      job.state = 'error';
      job.error = res.err && res.err.code === 'ENOENT'
        ? 'yt-dlp was not found. Open Settings and choose Install tools.'
        : res.bad ? 'Could not read video details.' : lastLine(res.stderr) || 'Could not read this video.';
    } else if (job.wantStart) {
      job.noInfo = true; // no saved read: the download below finds the video by itself
    }
    startWaiting(job);
    return emit(job, true);
  }
  try {
    const info = res.info;
    job.title = info.title || job.title;
    job.thumbnail = info.thumbnail || job.thumbnail;
    job.duration = info.duration || 0;
    job.uploader = info.uploader || info.channel || '';
    job.vid = info.id || job.vid;
    const heights = new Set();
    for (const f of info.formats || []) if (f.height && f.vcodec !== 'none') heights.add(f.height);
    const ladder = [2160, 1440, 1080, 720, 480, 360].filter((h) => [...heights].some((x) => x >= h));
    job.qualities = ['best', ...ladder.map(String), 'audio'];
    if (idle && !job.qualities.includes(job.quality)) job.quality = 'best';
  } catch {
    if (idle) {
      job.state = 'error';
      job.error = 'Could not read video details.';
    }
  }
  startWaiting(job);
  emit(job, true);
}

// Start was pressed while the details were still being read: carry on now
function startWaiting(job) {
  if (!job.wantStart) return;
  job.wantStart = false;
  if (job.state === 'downloading' && !procs.has(job.id)) launchDownload(job);
}

function cookieArgs() {
  return settings.cookiesBrowser ? ['--cookies-from-browser', settings.cookiesBrowser] : [];
}

function buildArgs(job, infoFile) {
  const a = [
    '--no-playlist', '--newline', '--no-warnings', '--windows-filenames',
    '-c', '--retries', 'infinite', '--fragment-retries', 'infinite', '--retry-sleep', '3',
    '-N', String(settings.threads || 8),
    '-o', path.join(settings.downloadDir, '%(title).150B [%(id)s].%(ext)s'),
    '--progress-template',
    'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    ...cookieArgs(),
  ];
  // Picture and sound that play in every player (Windows Movies & TV, phones, TVs).
  // yt-dlp's own order prefers AV1, then VP9, then H.264 for the picture, and Opus before AAC for the
  // sound. In an .mp4 the first ones give a black picture or no sound in players without those codecs.
  // So: H.264 first, then the usual order (resolution, frame rate...), AAC for the sound.
  const COMPAT = 'vcodec:h264,lang,quality,res,fps,hdr:12,acodec:aac';
  // Above 1080p YouTube only has VP9 and AV1: take the highest resolution, VP9 before AV1
  const HIGH = 'lang,quality,res,fps,hdr:12,vcodec:vp9,acodec:aac';
  const q = job.quality;
  if (q === 'audio') {
    a.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (q === 'best') {
    a.push('-f', 'bv*+ba/b', '-S', COMPAT, '--merge-output-format', 'mp4');
  } else {
    const h = Number(q);
    a.push('-f', `bv*[height<=${h}]+ba/b[height<=${h}]`, '-S', h > 1080 ? HIGH : COMPAT, '--merge-output-format', 'mp4');
  }
  // With a saved read yt-dlp starts straight away instead of asking the site again
  if (infoFile) a.push('--load-info-json', infoFile);
  else a.push('--', job.url); // '--' stops option injection from untrusted URLs
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
  job.note = '';
  job.part = 0;
  job.stop = null;
  emit(job, true);

  // The details are still being read (a few seconds): start from them the moment they arrive,
  // which is quicker than asking the site a second time.
  if (job.loading) {
    job.wantStart = true;
    job.phase = 'Getting ready';
    return emit(job, true);
  }
  launchDownload(job);
}

function launchDownload(job) {
  job.part = 0;
  const infoFile = infoFileFor(job);
  job.fromInfo = !!infoFile;
  const p = spawn(ytdlp(), buildArgs(job, infoFile), { env: toolEnv(), windowsHide: true });
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
      checkCodec(job);
    } else {
      const msg = errTail.join('\n');
      if (isNetworkError(msg) && job.retries < 80) {
        job.retries += 1;
        job.state = 'waiting';
        job.phase = 'Connection lost, retrying';
        const delay = Math.min(30, 2 + job.retries * 3) * 1000;
        timers.set(job.id, setTimeout(() => { if (job.state === 'waiting') startDownload(job); }, delay));
      } else if (job.fromInfo) {
        // The saved read could not be used (the address expired, or yt-dlp refused it).
        // Do it the normal way, once, and do not use the saved read for this job again.
        job.noInfo = true;
        job.stop = null;
        job.phase = 'Starting';
        emit(job, true);
        return launchDownload(job);
      } else {
        job.state = 'error';
        job.error = lastLine(msg) || 'Download failed.';
      }
    }
    job.stop = null;
    emit(job, true);
  });
}

// After a download: say so when the picture uses a codec that many players cannot show (some
// videos have no H.264 version at all). ffprobe comes with ffmpeg; without it nothing is said.
async function checkCodec(job) {
  if (job.quality === 'audio' || !job.filepath) return;
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', job.filepath], 20000);
  if (r.err) return;
  const name = { av1: 'AV1', vp9: 'VP9', hevc: 'H.265' }[r.stdout.trim().split(/\r?\n/)[0].toLowerCase()];
  if (name && jobs.has(job.id)) {
    job.note = `This video uses ${name}. If the picture is black in your player, open it with VLC.`;
    emit(job, true);
  }
}

function pauseJob(job) {
  clearTimeout(timers.get(job.id));
  if (job.wantStart) { // still waiting for the details: nothing is running yet
    job.wantStart = false;
    job.state = 'paused'; job.phase = '';
    return emit(job, true);
  }
  const p = procs.get(job.id);
  if (p) { job.stop = 'pause'; killTree(p); }
  else if (job.state === 'waiting') { job.state = 'paused'; job.phase = ''; emit(job, true); }
}

function removeJob(job, cleanPartial) {
  clearTimeout(timers.get(job.id));
  const p = procs.get(job.id);
  if (p) { job.stop = 'cancel'; killTree(p); }
  job.wantStart = false;
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
function revealJob(j) {
  if (j && j.filepath && fs.existsSync(j.filepath)) shell.showItemInFolder(j.filepath);
  else shell.openPath(settings.downloadDir);
}
function openJob(j) {
  if (j && j.filepath && fs.existsSync(j.filepath)) shell.openPath(j.filepath);
}

// POST routes: /add and /job/<action>. The extension popup drives a download through these.
function handlePost(route, data, origin, json) {
  // The extension says hello with its own version, so the app can tell when it is out of date
  if (route === '/hello') {
    if (origin) markExtension(String(data.ext || ''));
    return json(200, { ok: true, app: 'VidGrab', version: app.getVersion() });
  }

  // The extension saw the pointer rest on a video: start reading it now, so the answer is
  // usually ready by the time the Download button is pressed. At most two at once.
  if (route === '/prefetch') {
    try {
      const u = new URL(data.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      if (origin) markExtension();
      const hit = infoCache.get(infoKey(u.href));
      if (!(hit && Date.now() - hit.at < INFO_MS) && prefetching < 2) {
        prefetching += 1;
        readInfo(u.href).finally(() => { prefetching -= 1; });
      }
      return json(200, { ok: true });
    } catch {
      return json(400, { ok: false, error: 'Bad request' });
    }
  }

  if (route === '/add') {
    try {
      const u = new URL(data.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      if (origin) markExtension();
      // A link that comes from the browser never opens the app window: the extension shows its own
      // popup. (Links typed into the app itself go through IPC and do show the window.)
      const job = addJob(u.href, String(data.title || '').slice(0, 200), true);
      return json(200, { ok: true, id: job.id });
    } catch {
      return json(400, { ok: false, error: 'Bad request' });
    }
  }

  const m = route.match(/^\/job\/(start|pause|cancel|remove|quality|reveal|open)$/);
  if (!m) return json(404, { ok: false });
  const j = jobs.get(String(data.id || ''));
  if (!j) return json(404, { ok: false, error: 'Job not found' });

  switch (m[1]) {
    case 'start': j.retries = 0; startDownload(j); break;
    case 'pause': pauseJob(j); break;
    case 'cancel': removeJob(j, true); return json(200, { ok: true });
    case 'remove': removeJob(j, false); return json(200, { ok: true });
    case 'quality':
      if (typeof data.quality === 'string' && (j.qualities || []).includes(data.quality)) {
        j.quality = data.quality;
        persistSoon();
      }
      break;
    case 'reveal': revealJob(j); break;
    case 'open': openJob(j); break;
  }
  json(200, { ok: true, job: j });
}

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

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'GET' && route === '/ping') return json(200, { ok: true, app: 'VidGrab', version: app.getVersion() });
    if (route === '/hello' && req.method === 'GET') {
      // An older extension says hello this way and sends no version: it is out of date
      if (origin) markExtension(''); // only a real extension sends an Origin header
      return json(200, { ok: true, app: 'VidGrab', version: app.getVersion() });
    }

    // Live status of one job, polled by the extension popup
    if (req.method === 'GET' && route === '/job') {
      if (origin) markExtension();
      const j = jobs.get(url.searchParams.get('id') || '');
      return j ? json(200, { ok: true, job: j }) : json(404, { ok: false, error: 'Job not found' });
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }
        if (!data || typeof data !== 'object') return json(400, { ok: false, error: 'Bad request' });
        handlePost(route, data, origin, json);
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
/* Browser extension: find browsers, install the extension, connection */
/* ------------------------------------------------------------------ */
const EXT_ALIVE_MS = 100 * 1000; // extension pings every 30 s
let extSeen = 0;
let extVersion = ''; // version the connected extension reported ('' = unknown, an old one)
const extConnected = () => Date.now() - extSeen < EXT_ALIVE_MS;

const bundledExtVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(extSource(), 'manifest.json'), 'utf8')).version || ''; } catch { return ''; }
};
function verLess(a, b) {
  const x = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
// connected, but older than the extension that ships with this app
const extStale = () => { const b = bundledExtVersion(); return !!b && (!extVersion || verLess(extVersion, b)); };
const extState = () => ({ connected: extConnected(), stale: extConnected() && extStale() });

// version: the extension's version when it is known from this request, otherwise leave it as is
function markExtension(version) {
  const was = extConnected();
  const changed = version !== undefined && version !== extVersion;
  if (version !== undefined) extVersion = version;
  extSeen = Date.now();
  if (!was || changed) send('ext:status', extState());
}
setInterval(() => { if (extSeen && !extConnected()) send('ext:status', extState()); }, 15000);

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', exe: ['Google', 'Chrome', 'Application', 'chrome.exe'], page: 'chrome://extensions' },
  { id: 'edge', name: 'Microsoft Edge', exe: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], page: 'edge://extensions' },
  { id: 'brave', name: 'Brave', exe: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'], page: 'brave://extensions' },
];
function findBrowsers() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const found = [];
  for (const b of BROWSERS) {
    for (const r of roots) {
      const exe = path.join(r, ...b.exe);
      if (fs.existsSync(exe)) { found.push({ ...b, path: exe }); break; }
    }
  }
  return found;
}
const extSource = () => (app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, 'extension'));
const extTarget = () => path.join(app.getPath('appData'), 'vidgrab', 'extension');

function setupBrowser(id) {
  const b = findBrowsers().find((x) => x.id === id);
  if (!b) return { ok: false, error: 'Browser not found.' };
  const src = extSource();
  const dst = extTarget();
  try {
    if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('Extension files are missing from the app.');
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch {} // drop files from older versions
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: 'Could not copy the extension: ' + (e && e.message || e) };
  }
  clipboard.writeText(dst);
  try {
    const child = spawn(b.path, [b.page], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    return { ok: false, error: 'Copied, but could not open ' + b.name + '.', path: dst };
  }
  return { ok: true, path: dst, name: b.name };
}

/* ------------------------------------------------------------------ */
/* Auto-update from GitHub Releases                                    */
/* ------------------------------------------------------------------ */
function updateStatus(s) { send('update:status', s); }

let installAfterDownload = false;
function installNow() {
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // silent install, then start the app again
}
function setupUpdater() {
  // Builds that were not made by the installer (for example dist/win-unpacked) have no
  // resources/app-update.yml, and electron-updater then fails with ENOENT. Give it the
  // GitHub repo from package.json directly so update checks work in every build.
  try {
    const pub = [].concat((require('./package.json').build || {}).publish || [])[0];
    if (pub && pub.provider === 'github') {
      autoUpdater.setFeedURL({ provider: 'github', owner: pub.owner, repo: pub.repo, releaseType: pub.releaseType || 'release' });
    }
  } catch {}
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => updateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => updateStatus({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => updateStatus({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => updateStatus({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => {
    updateStatus({ state: 'ready', version: i.version });
    if (installAfterDownload) installNow(); // one tap: download, then restart
  });
  autoUpdater.on('error', (e) => updateStatus({ state: 'error', message: String(e && e.message || e).split('\n')[0] }));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function setupIpc() {
  ipcMain.handle('jobs:list', () => [...jobs.values()]);
  ipcMain.handle('browser:list', () => findBrowsers().map(({ id, name }) => ({ id, name })));
  ipcMain.handle('browser:setup', (_e, id) => setupBrowser(String(id)));
  ipcMain.handle('browser:status', () => extState());
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
  ipcMain.handle('job:reveal', (_e, id) => revealJob(jobs.get(id)));
  ipcMain.handle('job:open', (_e, id) => openJob(jobs.get(id)));

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
  ipcMain.handle('update:install', () => installNow());
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.autostart, args: ['--hidden'] });
}

/* ------------------------------------------------------------------ */
// Which VidGrab already holds the port? Resolves to its version, '' if it is an older build
// that does not report one, or null if nothing that looks like VidGrab answers.
function runningVersion() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/ping', headers: { 'X-VidGrab': '1' }, timeout: 2500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { const j = JSON.parse(body); resolve(j && j.app === 'VidGrab' ? String(j.version || '') : null); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

if (!gotLock) {
  // Another VidGrab is already running (usually hidden in the tray) and has just been told to
  // show its window. When that one is a different version from this one, it is not obvious why
  // the old screen appears, so say it. (app.exit, not quit: leaves the running copy's files alone.)
  app.whenReady().then(async () => {
    const other = await runningVersion();
    if (other !== null && other !== app.getVersion()) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'VidGrab',
        message: other
          ? `Another copy of VidGrab (version ${other}) is already running, so this one (version ${app.getVersion()}) did not start.`
          : `An older copy of VidGrab is already running, so this one (version ${app.getVersion()}) did not start.`,
        detail: 'Right-click the VidGrab icon in the tray (near the clock), choose Quit, then open VidGrab again.',
        buttons: ['OK'],
      });
    }
    app.exit(0);
  });
} else {
  app.whenReady().then(() => {
    try { fs.rmSync(infoDir(), { recursive: true, force: true }); } catch {} // saved reads from an earlier run
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
}

app.on('before-quit', () => {
  quitting = true;
  for (const p of procs.values()) killTree(p);
  try { fs.writeFileSync(jobsFile(), JSON.stringify([...jobs.values()].slice(-100))); } catch {}
});
app.on('window-all-closed', () => { /* keep running in the tray */ });
