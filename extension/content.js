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
  function ytClean(href) {
    try {
      const u = new URL(href, location.href);
      if (u.pathname === '/watch' && u.searchParams.get('v')) return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
      if (u.pathname.startsWith('/shorts/')) return `https://www.youtube.com${u.pathname}`;
    } catch {}
    return null;
  }

  function resolve(video) {
    const big = video.getBoundingClientRect().width > 500;
    if (isYT) {
      if (big && /^\/(watch|shorts)/.test(location.pathname)) {
        const u = ytClean(location.href);
        if (u) return { url: u, title: document.title.replace(/\s*-\s*YouTube$/, '') };
      }
      const a = video.closest('a[href*="/watch?v="], a[href*="/shorts/"]') ||
        video.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer')?.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
      const u = a && ytClean(a.href);
      return u ? { url: u, title: a.getAttribute('title') || a.textContent.trim().slice(0, 120) } : null;
    }
    // Facebook: look for a permalink near the video, else fall back to the page address
    const sel = 'a[href*="/videos/"], a[href*="/watch/?v="], a[href*="/reel/"], a[href*="fb.watch/"]';
    let el = video;
    for (let i = 0; i < 12 && el; i++) {
      el = el.parentElement;
      const a = el && el.querySelector(sel);
      if (a) return { url: a.href, title: document.title };
    }
    if (/\/(watch|reel|videos)\b/.test(location.pathname) || location.hostname === 'fb.watch') {
      return { url: location.href, title: document.title };
    }
    return null;
  }

  /* ---------- follow the mouse: show the button on the hovered video ---------- */
  let current = null;
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

  let ticking = false;
  document.addEventListener('mousemove', (e) => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (e.target === btn || btn.contains(e.target)) { clearTimeout(hideTimer); return; }
      const v = videoAt(e.clientX, e.clientY);
      if (v) {
        clearTimeout(hideTimer);
        current = v;
        place(v);
        btn.style.display = 'flex';
      } else if (btn.style.display !== 'none') {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { btn.style.display = 'none'; current = null; }, 600);
      }
    });
  }, { passive: true });

  window.addEventListener('scroll', () => { if (current && btn.style.display !== 'none') place(current); }, { passive: true, capture: true });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const found = current && resolve(current);
    if (!found) return say('Could not find the link for this video. Open it on its own page and try again.', false);
    chrome.runtime.sendMessage({ type: 'add', url: found.url, title: found.title }, (res) => {
      if (chrome.runtime.lastError) return say('Extension was reloaded. Refresh this page.', false);
      if (res && res.ok && !res.old) return; // the VidGrab popup window opens on its own
      if (res && res.old) return say('Sent to VidGrab. The app is out of date: install the latest VidGrab to get this popup window.', true);
      say((res && res.error) || 'VidGrab is not running.', false);
    });
  }, true);
})();
