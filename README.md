# VidGrab

Personal download manager for Windows. A button appears on videos in your browser, one click opens a popup window in the middle of your browser, you pick the quality, press **Start**, and watch the download there. The app window stays closed.

```
Browser button  ->  popup window in the browser  ->  Start  ->  local app (127.0.0.1:39800)  ->  yt-dlp downloads
```

The popup only shows progress and sends your clicks to the app. The download itself keeps running in the app even if you close the popup.

Features: speed / time left / progress bar, parallel connections, Stop and Resume, automatic retry after internet loss (continues from the same byte), quality picker, tray icon, start with Windows, in-app update from GitHub.

## 1. Run it (development)

Install Node.js 20+, then:

```
npm install
npm start
```

In the app, open **Settings, Install tools**. This runs:

```
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
```

## 2. Add the browser extension (Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose the `extension` folder

The button now shows when you hover a video on YouTube or Facebook. Clicking it opens the VidGrab popup window for that video.
You can also click the toolbar icon to open the popup for the current tab.

After updating VidGrab, use **Browser** in the app again (it copies the new extension files), then press the reload icon on the VidGrab card in `chrome://extensions`.

Browsers only enable an extension after you confirm it yourself; that confirmation is the Load unpacked step above. Firefox needs a small manifest change and is not included yet.

## 3. Build the installer

```
npm run dist
```

The installer appears in `dist/`. Install it once; the app then runs in the tray and starts with Windows (so the browser button always has an app to talk to).

## 4. Update from GitHub

1. Create a GitHub repo and set `owner` and `repo` in `package.json` under `build.publish`. Keep the repo public so the app can read releases without a token.
2. Push your code, then bump the version and tag it:

```
npm version patch
git push --follow-tags
```

3. GitHub Actions (`.github/workflows/release.yml`) builds the installer and publishes a release.
4. In the app: **Updates** (or Settings, Check for update), then **Download update**, then **Restart and install**.

The installer is unsigned, so Windows SmartScreen may warn on first install. That is normal for personal builds.

yt-dlp is updated separately with **Settings, Update yt-dlp**. Do this whenever a download starts failing, because sites change often.

## Notes

- Only the page link is sent from the browser. All downloading is done by yt-dlp.
- The local server accepts requests only from browser extensions and requires a custom header, so ordinary websites cannot talk to it.
- Facebook feed videos: the link is found on a best-effort basis. If it fails, open the video on its own page and click the button there.
- Private Facebook videos need login cookies: set the browser in Settings. Close that browser first, since it can lock its cookie file.
- Downloading may break a site's terms of service. Use it for your own personal copies.
