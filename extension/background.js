const APP = 'http://127.0.0.1:39800';

async function sendToApp(url, title) {
  try {
    const r = await fetch(`${APP}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidGrab': '1' },
      // popup:true = "I open my own popup, keep the app window closed"
      body: JSON.stringify({ url, title, popup: true }),
    });
    const j = await r.json();
    // An old app answers ok but without a job id: it cannot drive the popup, and it opens its own window
    return { ok: !!j.ok, id: j.id, old: !!j.ok && !j.id, error: j.error };
  } catch {
    return { ok: false, error: 'VidGrab is not running. Open it from the Start menu or the tray.' };
  }
}

// Open (or focus) the download popup, centred over the browser window the user is in
const POP_W = 500;
const POP_H = 400;
async function openPopup(jobId) {
  const url = chrome.runtime.getURL(`popup.html?id=${encodeURIComponent(jobId)}`);
  try {
    const open = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    for (const w of open) {
      if (w.tabs && w.tabs.some((t) => (t.url || '').startsWith(url))) {
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
  } catch {}
  const opts = { url, type: 'popup', width: POP_W, height: POP_H, focused: true };
  try {
    const b = await chrome.windows.getLastFocused();
    if (b && b.width && b.height) {
      opts.left = Math.round(b.left + (b.width - POP_W) / 2);
      opts.top = Math.round(b.top + (b.height - POP_H) / 2);
    }
  } catch {}
  chrome.windows.create(opts);
}

// Heartbeat: lets the app show "Connected", and tells it which extension version this is
// (POST with the same headers as /add, so an older app still understands it)
async function hello() {
  try {
    await fetch(`${APP}/hello`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidGrab': '1' },
      body: JSON.stringify({ ext: chrome.runtime.getManifest().version }),
    });
  } catch {}
}
hello();
chrome.runtime.onInstalled.addListener(() => { hello(); });
chrome.runtime.onStartup.addListener(() => { hello(); });
chrome.alarms.create('vidgrab-hello', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vidgrab-hello') hello(); });

// Early look: the pointer is resting on a video, so the app can start reading it already
async function prefetchToApp(url) {
  try {
    await fetch(`${APP}/prefetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidGrab': '1' },
      body: JSON.stringify({ url }),
    });
  } catch {}
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'prefetch' && typeof msg.url === 'string') {
    prefetchToApp(msg.url);
    return; // no reply needed
  }
  if (msg && msg.type === 'add') {
    sendToApp(msg.url, msg.title).then((res) => {
      if (res.ok && res.id) openPopup(res.id);
      reply(res);
    });
    return true; // async reply
  }
});

// Toolbar icon: send the current tab's address
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  const res = await sendToApp(tab.url, tab.title || '');
  if (res.ok && res.id) openPopup(res.id);
  chrome.action.setBadgeBackgroundColor({ color: res.ok ? '#34d399' : '#fb7185' });
  chrome.action.setBadgeText({ text: res.ok ? 'OK' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
});
