/* =========================================================================
   wallpaper-folder-service.js
   -------------------------------------------------------------------------
   A dedicated local-folder wallpaper source for Literary Vocabulary
   Register, sitting ALONGSIDE the existing upload-and-compress-to-
   localStorage path in script.js (getWallpaperImage/setWallpaperImage/
   resizeAndSaveWallpaper) rather than replacing it. Nothing here writes
   image binaries to localStorage — see WFS_META_STORAGE below, which only
   ever holds a filename and a folder label string.

   Two backends, chosen automatically:
     1. File System Access API (Chromium/Edge) — showDirectoryPicker()
        gives a real, reusable FileSystemDirectoryHandle. That handle is
        stored in IndexedDB (structured-cloneable, unlike localStorage) so
        the SAME folder can be silently re-attached on the next visit —
        the browser still requires a fresh permission grant each session
        (spec requirement, not a bug), but the person never has to browse
        to the folder again, just click "Allow".
     2. Fallback (Firefox/Safari, or any browser without the API) — a
        hidden <input type="file" webkitdirectory> element. This yields
        plain File objects with no reusable handle, so the folder can't be
        silently re-attached next session; the person re-picks it, and we
        auto-reselect their last-used filename by name (see
        getSelectedWallpaperName) so the actual wallpaper choice still
        feels persistent even though the *folder grant* isn't.

   Decoded images are cached as short-lived blob: object URLs in an
   in-memory Map (LRU-capped) — never in localStorage/IndexedDB. Object
   URLs are cheap, GC'd on revoke, and have no size limit the way a
   base64 string in localStorage does.
   ========================================================================= */

(function () {
"use strict";

const WFS_DB_NAME = "litVocabWallpaperFS";
const WFS_DB_VERSION = 1;
const WFS_STORE = "handles";
const WFS_HANDLE_KEY = "wallpaperFolder";

// localStorage: filename + folder label ONLY — never binary image data.
const WFS_META_STORAGE = "litVocabWallpaperFolderMeta";

const WFS_THUMB_MAX = 320;   // px, long edge of grid-preview thumbnails
const WFS_CACHE_LIMIT = 6;   // max decoded object URLs held at once (thumbs + full mixed)
const WFS_IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

const supportsFileSystemAccess = "showDirectoryPicker" in window;

// ---- tiny IndexedDB helper ----------------------------------------------
// Only ever stores the ONE FileSystemDirectoryHandle under WFS_HANDLE_KEY.
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WFS_DB_NAME, WFS_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(WFS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(WFS_STORE, "readonly").objectStore(WFS_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WFS_STORE, "readwrite");
    tx.objectStore(WFS_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WFS_STORE, "readwrite");
    tx.objectStore(WFS_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- metadata: paths/names only ------------------------------------------
function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(WFS_META_STORAGE)) || { selectedName: null, folderLabel: null };
  } catch {
    return { selectedName: null, folderLabel: null };
  }
}
function writeMeta(meta) {
  try { localStorage.setItem(WFS_META_STORAGE, JSON.stringify(meta)); } catch { /* non-fatal */ }
}
function getSelectedWallpaperName() { return readMeta().selectedName; }
function setSelectedWallpaperName(name) {
  const meta = readMeta();
  meta.selectedName = name;
  writeMeta(meta);
}
function getFolderLabel() { return readMeta().folderLabel; }
function setFolderLabel(label) {
  const meta = readMeta();
  meta.folderLabel = label;
  writeMeta(meta);
}

// ---- in-memory decode cache (object URLs, LRU) ---------------------------
const urlCache = new Map(); // key -> objectURL
function cachePut(key, url) {
  if (urlCache.has(key)) URL.revokeObjectURL(urlCache.get(key));
  urlCache.delete(key);        // re-insert at the end so it counts as freshly used
  urlCache.set(key, url);
  while (urlCache.size > WFS_CACHE_LIMIT) {
    const oldestKey = urlCache.keys().next().value;
    URL.revokeObjectURL(urlCache.get(oldestKey));
    urlCache.delete(oldestKey);
  }
}
function clearWallpaperFolderCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

class WallpaperFolderService {
  constructor() {
    this.dirHandle = null;      // FileSystemDirectoryHandle | null (FS Access mode)
    this.entries = [];          // [{ name, handle }] or [{ name, file }] (fallback mode)
  }

  // Opens the native folder picker, or — on browsers without the API —
  // triggers the caller-supplied fallback <input type="file" webkitdirectory>.
  async chooseFolder(fallbackInput) {
    if (supportsFileSystemAccess) {
      this.dirHandle = await window.showDirectoryPicker({ id: "wallpapers", mode: "read" });
      await idbSet(WFS_HANDLE_KEY, this.dirHandle);
      setFolderLabel(this.dirHandle.name);
      return this.scan();
    }
    if (!fallbackInput) {
      throw new Error("This browser has no File System Access API — pass a fallback <input webkitdirectory> element.");
    }
    return new Promise((resolve, reject) => {
      fallbackInput.value = "";
      fallbackInput.onchange = () => {
        const files = Array.from(fallbackInput.files || []).filter((f) => WFS_IMAGE_EXT.test(f.name));
        if (!files.length) { reject(new Error("No images found in that folder.")); return; }
        const folderName = files[0].webkitRelativePath?.split("/")[0] || "Selected folder";
        setFolderLabel(folderName);
        this.entries = files.map((f) => ({ name: f.name, file: f }));
        resolve(this.entries);
      };
      fallbackInput.click();
    });
  }

  // Re-attaches to the last-used folder on page load. Always re-requests
  // permission — browsers never silently trust a stored grant across
  // sessions, even though the handle itself persists fine in IndexedDB.
  // Returns null (rather than throwing) if there's nothing to restore or
  // permission is denied, so callers can treat it as "just show the
  // normal empty-state UI" without a try/catch.
  async restoreFolder() {
    if (!supportsFileSystemAccess) return null; // fallback mode has no reusable handle
    const handle = await idbGet(WFS_HANDLE_KEY);
    if (!handle) return null;
    try {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") return null;
    } catch {
      return null; // handle can throw if the folder was moved/deleted since
    }
    this.dirHandle = handle;
    return this.scan();
  }

  async forgetFolder() {
    this.dirHandle = null;
    this.entries = [];
    clearWallpaperFolderCache();
    await idbDelete(WFS_HANDLE_KEY);
    writeMeta({ selectedName: null, folderLabel: null });
  }

  // Non-recursive listing (wallpaper folders are flat by convention).
  async scan() {
    if (this.dirHandle) {
      const entries = [];
      for await (const [name, handle] of this.dirHandle.entries()) {
        if (handle.kind === "file" && WFS_IMAGE_EXT.test(name)) entries.push({ name, handle });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      this.entries = entries;
      return entries;
    }
    return this.entries; // fallback mode: populated already by chooseFolder()
  }

  async _getFile(entry) {
    return entry.file ? entry.file : entry.handle.getFile();
  }

  // Downscaled preview for the picker grid.
  async loadThumbnail(entry) {
    const cacheKey = `thumb:${entry.name}`;
    if (urlCache.has(cacheKey)) return urlCache.get(cacheKey);
    const file = await this._getFile(entry);
    const url = await this._decodeToObjectUrl(file, WFS_THUMB_MAX);
    cachePut(cacheKey, url);
    return url;
  }

  // Full-resolution decode for actually setting the wallpaper. No
  // aggressive downscale here (unlike resizeImageForWallpaper in
  // script.js) — that compression exists to fit localStorage's quota,
  // which doesn't apply to a blob URL pointing at a file on disk.
  async loadFull(entry) {
    const cacheKey = `full:${entry.name}`;
    if (urlCache.has(cacheKey)) return urlCache.get(cacheKey);
    const file = await this._getFile(entry);
    const url = URL.createObjectURL(file);
    cachePut(cacheKey, url);
    return url;
  }

  async _decodeToObjectUrl(file, maxDim) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return URL.createObjectURL(blob);
  }

  findByName(name) {
    return this.entries.find((e) => e.name === name) || null;
  }
}

// ---- Public surface, attached to window (this file is a plain classic
// script, matching script.js — not an ES module) -------------------------
window.WallpaperFolder = {
  WallpaperFolderService,
  supportsFileSystemAccess,
  getSelectedWallpaperName,
  setSelectedWallpaperName,
  getFolderLabel,
  clearWallpaperFolderCache,
};

})();
