# Vocab Register — Gemini Bridge (Chrome Extension)

## What each file does
- `manifest.json` — MV3 config. Declares two content scripts (Gemini side,
  app side) and the background service worker.
- `background.js` — relays messages between the two content scripts;
  also owns tab-finding/creating logic for "Search Gemini".
- `content-gemini.js` — runs on gemini.google.com. Injects "Save to
  Register" buttons into responses (auto re-injects on refresh via
  `MutationObserver`), scrapes text + images (canvas → base64) on click,
  and types a word into the chat box on request.
- `bridge-app.js` — runs on your app's page. Pure relay: turns
  `chrome.runtime` messages into `window.postMessage` and back, so your
  app's own `script.js` never has to touch the `chrome.*` API.

## Setup
1. **Edit `manifest.json`.** The second `content_scripts` entry (`bridge-app.js`)
   currently matches `file:///*`, `http://localhost/*`, and
   `http://127.0.0.1/*` for local development. Replace these with your
   app's real deployed URL before you rely on this outside local testing
   (e.g. `"https://your-username.github.io/*"`).
   - If you're testing over `file://`, you must also turn on **"Allow
     access to file URLs"** for this extension in `chrome://extensions`
     after loading it (see step 3) — Chrome disables file:// access for
     extensions by default.
2. Make sure your app's `index.html`/`script.js` already have the
   "Search Gemini" button and the bridge listener block (already added
   to your project).
3. Go to `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, and select this folder.
4. Open your app, then open gemini.google.com in another tab (or just
   click "Search Gemini" — it'll open one for you). Save buttons should
   appear under every Gemini response automatically, including after a
   refresh.

## Known fragility
Google's Gemini DOM uses obfuscated, frequently-changing class names.
If "Save to Register" buttons stop appearing, or "Search Gemini" stops
typing into the box, open DevTools on a live Gemini page, inspect the
actual elements, and update the `SELECTORS` object at the top of
`content-gemini.js` to match.

## Data flow
```
Gemini page                          Your app's page
┌─────────────────────┐              ┌─────────────────────┐
│ content-gemini.js    │              │ script.js            │
│  - MutationObserver   │              │  - "Search Gemini" btn│
│  - Save button        │              │  - window.postMessage │
│  - canvas→base64      │              │    listener + handshake│
└──────────┬────────────┘              └──────────┬────────────┘
           │ chrome.runtime                        │ window.postMessage
           ▼                                        ▼
       background.js  ◄────────────────────►  bridge-app.js
        (service worker, relays + tab control)  (content script)
```
