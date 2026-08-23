/* =========================================================================
   youtube-playlist-folder-service.js
   -------------------------------------------------------------------------
   A local-folder sync target for the 🎵 YouTube window's "My Playlists"
   feature, sitting ALONGSIDE the existing localStorage-backed persistence
   in youtube-window.js (loadPlaylistsFromStorage/savePlaylistsToStorage)
   rather than replacing it outright — localStorage stays the default for
   anyone who never connects a folder, and the automatic fallback if a
   folder write ever fails mid-session. See the "PLAYLIST FOLDER SYNC"
   block in youtube-window.js for how the two are wired together.

   Same File System Access API approach wallpaper-folder-service.js
   already uses for wallpapers, trimmed down for a single JSON file
   instead of a folder of images:
     - showDirectoryPicker({ mode: "readwrite" }) gives a real, reusable
       FileSystemDirectoryHandle, stored in IndexedDB (structured-
       cloneable, unlike localStorage) so the SAME folder can be silently
       re-attached next visit. The browser still requires a fresh
       permission grant each session (spec requirement, not a bug) — the
       person just clicks "Allow", never re-browses to the folder.
     - Playlists are written as one plain JSON file
       (YOUTUBE_PLAYLISTS_FILENAME) inside that folder — human-readable,
       diffable, and trivially the same shape as this app's own
       Export-to-JSON download, so a person can point Export/Import and a
       synced folder at the exact same file if they want to.
     - No fallback backend for browsers without the File System Access
       API (Firefox/Safari): unlike the wallpaper picker, a folder of
       PLAYLISTS needs to be WRITTEN to, not just read from, and the
       plain <input webkitdirectory> fallback only ever yields read-only
       File objects with no write access at all. Those browsers simply
       don't get live folder sync — supportsFileSystemAccess tells the
       caller so it can grey out the UI with an explanatory tooltip
       rather than offering a feature that can't actually save anything.
   ========================================================================= */

(function () {
"use strict";

const YPF_DB_NAME = "litVocabYoutubePlaylistFS";
const YPF_DB_VERSION = 1;
const YPF_STORE = "handles";
const YPF_HANDLE_KEY = "playlistFolder";

// localStorage: folder label ONLY (for display) — never the handle
// itself (not JSON-serializable) and never playlist data (that's the
// whole point of this file — playlist data goes to disk, not here).
const YPF_META_STORAGE = "litVocabYoutubePlaylistFolderMeta";

const YOUTUBE_PLAYLISTS_FILENAME = "youtube-playlists.json";

const supportsFileSystemAccess = "showDirectoryPicker" in window;

// ---- tiny IndexedDB helper (same shape as wallpaper-folder-service.js;
// only ever stores the ONE FileSystemDirectoryHandle under YPF_HANDLE_KEY) ---
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(YPF_DB_NAME, YPF_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(YPF_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(YPF_STORE, "readonly").objectStore(YPF_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(YPF_STORE, "readwrite");
    tx.objectStore(YPF_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(key) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(YPF_STORE, "readwrite");
    tx.objectStore(YPF_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(YPF_META_STORAGE)) || { folderLabel: null };
  } catch {
    return { folderLabel: null };
  }
}
function writeMeta(meta) {
  try { localStorage.setItem(YPF_META_STORAGE, JSON.stringify(meta)); } catch { /* non-fatal */ }
}

let dirHandle = null; // FileSystemDirectoryHandle | null — the live in-memory handle for this tab

// Serializes writes so two rapid saves can never race and interleave
// partial writes to the same file — each write waits for the previous
// one (success or failure) to finish before starting.
let writeQueue = Promise.resolve();

async function ensureReadWritePermission(handle) {
  try {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" });
    return perm === "granted";
  } catch {
    return false; // handle can throw if the folder was moved/deleted since
  }
}

// Opens the native folder picker and grants this app read/write access.
// Returns the folder's display name, or null if the person cancelled the
// picker (an AbortError, which callers treat as "not an error").
async function connect() {
  if (!supportsFileSystemAccess) return null;
  const handle = await window.showDirectoryPicker({ id: "youtubePlaylists", mode: "readwrite" });
  const granted = await ensureReadWritePermission(handle);
  if (!granted) return null;
  dirHandle = handle;
  await idbSet(YPF_HANDLE_KEY, handle);
  writeMeta({ folderLabel: handle.name });
  return handle.name;
}

// Re-attaches to the last-used folder on page load. Always re-requests
// permission — browsers never silently trust a stored grant across
// sessions, even though the handle itself persists fine in IndexedDB.
// Returns the folder name, or null (never throws) if there's nothing to
// restore, the folder's gone, or permission wasn't re-granted — callers
// treat null as "just stay on localStorage, no error needed".
async function restoreConnection() {
  if (!supportsFileSystemAccess) return null;
  const handle = await idbGet(YPF_HANDLE_KEY);
  if (!handle) return null;
  const granted = await ensureReadWritePermission(handle);
  if (!granted) return null;
  dirHandle = handle;
  writeMeta({ folderLabel: handle.name });
  return handle.name;
}

async function disconnect() {
  dirHandle = null;
  writeMeta({ folderLabel: null });
  try {
    await idbDelete(YPF_HANDLE_KEY);
  } catch {
    /* non-fatal — worst case a stale handle sits in IndexedDB and the
       next restoreConnection() attempt just fails its permission check */
  }
}

function isConnected() {
  return !!dirHandle;
}

function getFolderLabel() {
  return readMeta().folderLabel;
}

// Reads YOUTUBE_PLAYLISTS_FILENAME back out of the connected folder.
// Returns null (never throws) if nothing's connected, the file doesn't
// exist yet (a freshly-chosen empty folder), or it can't be parsed —
// every case the caller should treat as "nothing to load from here".
async function readPlaylists() {
  if (!dirHandle) return null;
  try {
    const fileHandle = await dirHandle.getFileHandle(YOUTUBE_PLAYLISTS_FILENAME, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null; // NotFoundError (no file yet) or malformed JSON — either way, nothing usable
  }
}

// Writes the given playlists array to YOUTUBE_PLAYLISTS_FILENAME in the
// connected folder, in this app's own export shape (see
// buildPlaylistExportPayload() in youtube-window.js) so the same file
// also opens cleanly via Import if someone ever wants to do that
// instead. Returns true/false rather than throwing — the caller (see
// savePlaylistsToStorage() in youtube-window.js) decides how to surface
// a failure, same convention as the rest of this app's storage writes.
async function writePlaylists(playlistsArray) {
  if (!dirHandle) return false;
  const payload = {
    app: "vocabRegister-youtube-playlists",
    syncedAt: Date.now(),
    playlists: Array.isArray(playlistsArray) ? playlistsArray : [],
  };
  const run = async () => {
    try {
      const fileHandle = await dirHandle.getFileHandle(YOUTUBE_PLAYLISTS_FILENAME, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
      return true;
    } catch {
      // Permission revoked mid-session, folder moved/deleted, disk full,
      // etc. — non-fatal, the caller falls back to localStorage for this
      // save and the person keeps working either way.
      return false;
    }
  };
  // Chain onto the queue so overlapping calls (e.g. a burst of playlist
  // edits, each debounced-but-still-close-together) write in order
  // instead of two createWritable() streams fighting over the same file.
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

window.YouTubePlaylistFolder = {
  supportsFileSystemAccess,
  connect,
  restoreConnection,
  disconnect,
  isConnected,
  getFolderLabel,
  readPlaylists,
  writePlaylists,
};

})();
