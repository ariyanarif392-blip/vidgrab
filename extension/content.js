(() => {
  'use strict';
  const isYT = /(^|\.)youtube\.com$/.test(location.hostname);
  const MIN_W = 220;

  /* ---------- floating button ---------- */
  const btn = document.createElement('button');
  btn.className = 'vidgrab-btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M11 3h2v9h3l-4 5-4-5h3z M6 19h12v2H6z" fill="currentColor"/></svg><span>Download</span>';
  btn.style.display = 'none';
  document.documentElement.appendChild(btn);

  const toast = document.createElement('div');
  toast.className = 'vidgrab-toast';
  toast.style.display = 'none';
  document.documentElement.appendChild(toast);
  let toastTimer;
  function say(msg, ok) {
    toast.textContent = msg;
    toast.dataset.ok = ok ? '1' : '0';
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.display = 'none'), 3200);
  }

  /* ---------- which link belongs to this video? ---------- */
  const YT_LINK = 'a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/live/"]';
  const YT_ITEM = 'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
    'ytd-reel-item-renderer, ytd-playlist-video-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-media-item';

  function ytClean(href) {
    try {
      const u = new URL(href, location.href);
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      if (u.pathname === '/watch' && u.searchParams.get('v')) return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
      if (/^\/(shorts|live)\/[\w-]+/.test(u.pathname)) return `https://www.youtube.com${u.pathname}`;
    } catch {}
    return null;
  }

  function ytTitle(a, item) {
    const own = (a.getAttribute('title') || '').trim();
    if (own) return own.slice(0, 150);
    const el = item && item.querySelector('#video-title, #video-title-link, h3, .yt-lockup-metadata-view-model-wiz__title');
    const text = ((el && (el.getAttribute('title') || el.textContent)) || '').trim();
    if (text) return text.slice(0, 150);
    return (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 150);
  }

  // A hover preview's own link has no text. The video's title is in its tile underneath,
  // so find another link to the same video that does have one.
  function ytTitleById(url) {
    const id = (url.match(/(?:v=|\/shorts\/|\/live\/)([\w-]+)/) || [])[1];
    if (!id) return '';
    for (const a of [...document.querySelectorAll(`a[href*="${id}"]`)].slice(0, 30)) {
      const t = ytTitle(a, a.closest(YT_ITEM));
      if (t) return t;
    }
    return '';
  }

  // The video link at or around one element: the link itself, or the one in the same video tile
  function ytLinkFrom(el) {
    if (!el || !el.closest) return null;
    const item = el.closest(YT_ITEM);
    const a = el.closest(YT_LINK) || (item && item.querySelector(YT_LINK));
    const url = a && ytClean(a.href);
    if (!url) return null;
    return { url, title: ytTitle(a, item || a.closest(YT_ITEM)) || ytTitleById(url) };
  }

  // m = where the pointer is: { x, y, path } (path = elements under it, from the event)
  function ytResolve(video, m) {
    if (video.getBoundingClientRect().width > 500 && /^\/(watch|shorts)/.test(location.pathname)) {
      const url = ytClean(location.href);
      if (url) return { url, title: document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '') };
    }
    // Hover previews on the home and search pages are drawn in their own layer on top of the
    // tile, so the <video> is not inside the tile or its link. Look at what is under the pointer.
    if (m) {
      for (const el of m.path) { const f = ytLinkFrom(el); if (f) return f; }
      for (const el of document.elementsFromPoint(m.x, m.y)) { const f = ytLinkFrom(el); if (f) return f; }
    }
    return ytLinkFrom(video);
  }

  const FB_LINK = 'a[href*="/videos/"], a[href*="/watch/?v="], a[href*="/reel/"], a[href*="fb.watch/"]';
  function fbResolve(video) {
    // Facebook: look for a permalink near the video, else fall back to the page address
    let el = video;
    for (let i = 0; i < 12 && el; i++) {
      el = el.parentElement;
      const a = el && el.querySelector(FB_LINK);
      if (a) return { url: a.href, title: document.title };
    }
    if (/\/(watch|reel|videos)\b/.test(location.pathname) || location.hostname === 'fb.watch') {
      return { url: location.href, title: document.title };
    }
    return null;
  }

  const resolve = (video, m) => (isYT ? ytResolve(video, m) : fbResolve(video));

  /* ---------- follow the mouse: show the button on the hovered video ---------- */
  let current = null; // the video under the pointer
  let found = null;   // its link, worked out while the pointer was on the video
  let hideTimer;

  function videoAt(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width >= MIN_W && r.height >= 100 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  }

  function place(v) {
    const r = v.getBoundingClientRect();
    btn.style.left = `${Math.max(8, r.left + 12)}px`;
    btn.style.top = `${Math.max(8, r.top + 12)}px`;
  }

  let last = null;
  let ticking = false;
  document.addEventListener('mousemove', (e) => {
    // The path has to be read now: it is empty once the event has finished
    last = { x: e.clientX, y: e.clientY, target: e.target, path: e.composedPath ? e.composedPath() : [] };
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const m = last;
      if (m.target === btn || btn.contains(m.target)) { clearTimeout(hideTimer); return; }
      const v = videoAt(m.x, m.y);
      if (v) {
        clearTimeout(hideTimer);
        // Remember the link now. Sites drop their hover preview (and its <video>) as soon as the
        // pointer leaves it for the button, so it cannot be looked up again at click time.
        const f = resolve(v, m);
        if (v !== current) found = f; else if (f) found = f;
        current = v;
        place(v);
        btn.style.display = 'flex';
      } else if (btn.style.display !== 'none') {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { btn.style.display = 'none'; current = null; found = null; }, 600);
      }
    });
  }, { passive: true });

  window.addEventListener('scroll', () => { if (current && current.isConnected && btn.style.display !== 'none') place(current); }, { passive: true, capture: true });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const link = found || (current && current.isConnected ? resolve(current, null) : null);
    if (!link) return say('Could not find the link for this video. Open it on its own page and try again.', false);
    chrome.runtime.sendMessage({ type: 'add', url: link.url, title: link.title }, (res) => {
      if (chrome.runtime.lastError) return say('Extension was reloaded. Refresh this page.', false);
      if (res && res.ok && !res.old) return; // the VidGrab popup window opens on its own
      if (res && res.old) return say('Sent to VidGrab. The app is out of date: install the latest VidGrab to get this popup window.', true);
      say((res && res.error) || 'VidGrab is not running.', false);
    });
  }, true);
})();
