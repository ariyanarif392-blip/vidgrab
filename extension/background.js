const APP = 'http://127.0.0.1:39800';

async function sendToApp(url, title) {
  try {
    const r = await fetch(`${APP}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidGrab': '1' },
      body: JSON.stringify({ url, title }),
    });
    const j = await r.json();
    return { ok: !!j.ok, error: j.error };
  } catch {
    return { ok: false, error: 'VidGrab is not running. Open it from the Start menu or the tray.' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'add') {
    sendToApp(msg.url, msg.title).then(reply);
    return true; // async reply
  }
});

// Toolbar icon: send the current tab's address
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  const res = await sendToApp(tab.url, tab.title || '');
  chrome.action.setBadgeBackgroundColor({ color: res.ok ? '#34d399' : '#fb7185' });
  chrome.action.setBadgeText({ text: res.ok ? 'OK' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
});
