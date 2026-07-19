# Vocab Register — Gemini Bridge (Chrome Extension)

## What each file does
- `manifest.json` — MV3 config. Declares two content scripts (Gemini side,
  app side) and the background service worker.
- `background.js` — relays messages between the two content scripts;
  also owns tab-finding/creating logic for "Search Gemini".
- `content-gemini.js` — runs on gemini.google.com. Types the strict
  literary lookup prompt into the chat box on request, then watches
  each response with a `MutationObserver` and — as soon as it detects
  the reply has finished streaming — automatically parses and scrapes
  it. **Fully automated: no "Save to Register" button, no click.**
- `bridge-app.js` — runs on your app's page. Pure relay: turns
  `chrome.runtime` messages into `window.postMessage` and back, so your
  app's own `script.js` never has to touch the `chrome.*` API.

## The automated flow
1. You click **"Search Gemini"** in your app (or it opens a new tab).
2. `content-gemini.js` types this exact prompt into Gemini's chat box
   and submits it:
   > Context: Literary book. Provide ONLY: 1. A 2-line definition of
   > `[word]` in this context. 2. A direct URL to a representative
   > image. No conversational filler or formatting. Format:
   > `[Definition]|[ImageURL]`.
3. A `MutationObserver` watches the new response bubble. Once the DOM
   inside it stops changing for ~1.5s (and no "Stop generating" control
   is still visible), the reply is treated as finished.
4. The bubble's text is scraped and split on `|` into `definition` and
   `imageUrl`, then sent instantly to `background.js`, which relays it
   to your app tab — no click, no popup, no manual copy/paste.
5. Your app's existing bridge listener (in `script.js`) auto-populates
   the pending definition + image fields, ready for you to review and
   hit **Add Entry**.

## Setup
1. **Edit `manifest.json`.** The second `content_scripts` entry (`bridge-app.js`)
   must match your app's real deployed URL (already set to
   `https://alizsultan917-lab.github.io/VocabBuilderPLUS/*` — update this
   if you redeploy elsewhere, or add `file:///*` / `http://localhost/*`
   back in for local testing).
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
   click "Search Gemini" — it'll open one for you). Definitions/images
   should now auto-populate with zero further clicks.

## Known fragility
Google's Gemini DOM uses obfuscated, frequently-changing class names.
Two things can break as a result, and both are controlled by the same
`SELECTORS` object at the top of `content-gemini.js`:
- **Responses aren't detected at all** — `SELECTORS.RESPONSE` no
  longer matches Gemini's response container. Open DevTools on a live
  Gemini page, inspect an actual response bubble, and add/update a
  selector.
- **"Search Gemini" stops typing into the box** — `SELECTORS.CHAT_INPUT`
  (or `SEND_BUTTON`) is stale; same fix.

The "has this response finished generating?" check itself is
selector-independent (it just waits for the DOM to go quiet), so it's
the most resilient part of the pipeline and shouldn't need updating
even when Google reshuffles class names.

If Gemini's reply doesn't contain a `|`, the extension logs a warning
to the Gemini tab's console and skips relaying it (rather than sending
garbage into your form) — check there first if entries stop arriving.

## Data flow
```
Gemini page                          Your app's page
┌─────────────────────┐              ┌─────────────────────┐
│ content-gemini.js    │              │ script.js            │
│  - MutationObserver   │              │  - "Search Gemini" btn│
│    (settle-detect)    │              │  - window.postMessage │
│  - auto-scrape+parse  │              │    listener + handshake│
└──────────┬────────────┘              └──────────┬────────────┘
           │ chrome.runtime                        │ window.postMessage
           ▼                                        ▼
       background.js  ◄────────────────────►  bridge-app.js
        (service worker, relays + tab control)  (content script)
```
