/* =========================================================================
   LITERARY VOCABULARY REGISTER — script.js
   =========================================================================
   NO AUTHENTICATION REQUIRED for the automatic lookups:
   - Definitions & phonetic spellings: Free Dictionary API
     (https://dictionaryapi.dev) — public, key-free REST API.
   - Related images: Openverse API (https://api.openverse.org) — public,
     key-free search over openly-licensed images.

   BOOK-AWARE AI ENHANCEMENT ("Fetch with AI") talks to a user-configured AI
   server via the OpenAI-compatible /v1/chat/completions endpoint — by
   default a local Ollama server (http://localhost:11434, model
   llama3.2:3b), but any local (LM Studio, etc.) or hosted/cloud endpoint
   works if it speaks the same API shape. Settings (apiUrl, modelName, and
   an optional apiKey for cloud providers) are configured via the "AI
   Settings" button and persisted in this browser's localStorage — nothing
   is hardcoded and nothing is sent anywhere except the server the person
   configured. The AI's job is to read the word in its book context and
   return both book-specific definitions and concrete image-search queries;
   the queries are then used to search Openverse for actual photos.

   If any lookup fails (word not found, network error, timeout, server
   unreachable, malformed reply) the app never blocks — it just falls back
   gracefully.
   ========================================================================= */

const DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const IMAGE_API_URL = "https://api.openverse.org/v1/images/";
const DEFAULT_IMAGE_RESULTS_COUNT = 4;
const DEFAULT_MAX_DEFINITIONS = 4;
// 0 is a valid, intentional value here — it means "don't keep any of
// these" (e.g. AI image limit 0 = never fetch AI images at all).
const FETCH_LIMIT_MIN = 0;
const FETCH_LIMIT_MAX = 10;

// TRIPLE-STREAM LIMITS — results are tracked (and capped) in three
// completely independent streams, both for definitions and for images,
// each configurable via the ⚙️ header widget:
//   1. SYSTEM — automatic dictionary lookups / auto image search
//   2. AI     — the "Fetch with AI" book-aware results
//   3. MANUAL — items the person types/pastes in themselves
const SYSTEM_DEF_LIMIT_STORAGE = "litVocabSystemDefLimit";
const AI_DEF_LIMIT_STORAGE = "litVocabAiDefLimit";
const MANUAL_DEF_LIMIT_STORAGE = "litVocabManualDefLimit";
const SYSTEM_IMG_LIMIT_STORAGE = "litVocabSystemImgLimit";
const AI_IMG_LIMIT_STORAGE = "litVocabAiImgLimit";
const MANUAL_IMG_LIMIT_STORAGE = "litVocabManualImgLimit";
const DEFAULT_SYSTEM_DEF_LIMIT = 2;
const DEFAULT_AI_DEF_LIMIT = 2;
const DEFAULT_MANUAL_DEF_LIMIT = 5;
const DEFAULT_SYSTEM_IMG_LIMIT = 1;
const DEFAULT_AI_IMG_LIMIT = 2;
const DEFAULT_MANUAL_IMG_LIMIT = 5;

// Which stream a given item's `source` belongs to.
function bucketOf(source) {
  if (source === "ai" || (source && source.startsWith("context"))) return "ai";
  if (source === "manual") return "manual";
  return "system"; // dictionary | auto
}

// Customizable display sizes (search bar width, definition text size,
// image-picker thumbnail size) — set via the 🔍 Display panel.
const SEARCH_WIDTH_STORAGE = "litVocabSearchWidth";
const DEF_TEXT_SCALE_STORAGE = "litVocabDefTextScale";
const IMG_THUMB_SIZE_STORAGE = "litVocabImgThumbSize";
const BUBBLY_MODE_STORAGE = "litVocabBubblyMode";
const BUBBLE_MODE_STORAGE = "litVocabBubbleMode";
const GLASS_TRANSPARENCY_STORAGE = "litVocabGlassTransparency";
const GLASS_BLUR_STORAGE = "litVocabGlassBlur";
const GLASS_TINT_STORAGE = "litVocabGlassTint";
const FISH_MODE_STORAGE = "litVocabFishMode";
const FISH_SPECIES_STORAGE = "litVocabFishSpecies";
const DEFAULT_SEARCH_WIDTH = 220;   // px
const DEFAULT_DEF_TEXT_SCALE = 100; // % (stored as whole percent, applied as a ratio)
const DEFAULT_IMG_THUMB_SIZE = 150; // px
const DEFAULT_BUBBLY_MODE = false;
// Defaults true so existing users see no change until they actively turn
// it off — mirrors DEFAULT_FISH_MODE's same "on unless you opt out" pattern.
const DEFAULT_BUBBLE_MODE = true;
const DEFAULT_GLASS_TRANSPARENCY = 30; // % — how see-through the glass is (0 = opaque, 100 = fully transparent)
const DEFAULT_GLASS_BLUR = 20;         // px — backdrop blur radius
const DEFAULT_GLASS_TINT = 50;         // % — strength of the color tint / glossy highlight
const DEFAULT_FISH_MODE = true;
const FISH_SPECIES_IDS = ["clownfish", "betta", "angelfish", "guppy", "pufferfish"];
const DEFAULT_FISH_SPECIES_PREFS = { clownfish: true, betta: true, angelfish: true, guppy: true, pufferfish: true };
// Shark COLOR VARIANTS (Part 4) — distinct palettes selectable/toggleable
// independently of shark *count* (see fish-shark-controls). Each spawned
// shark picks one variant at random from whichever are enabled; see
// SHARK_VARIANTS below for the actual color + pattern configuration.
const SHARK_VARIANT_STORAGE = "litVocabSharkVariantPrefs";
const SHARK_VARIANT_IDS = ["reef", "tiger", "shadow"];
const DEFAULT_SHARK_VARIANT_PREFS = { reef: true, tiger: true, shadow: true };
const SEARCH_WIDTH_MIN = 140;
const SEARCH_WIDTH_MAX = 640;
const DEF_TEXT_SCALE_MIN = 75;
const DEF_TEXT_SCALE_MAX = 160;
const IMG_THUMB_SIZE_MIN = 80;
const IMG_THUMB_SIZE_MAX = 320;
const GLASS_TRANSPARENCY_MIN = 0;
const GLASS_TRANSPARENCY_MAX = 100;
const GLASS_BLUR_MIN = 0;
const GLASS_BLUR_MAX = 40;
const GLASS_TINT_MIN = 0;
const GLASS_TINT_MAX = 100;

const LOOKUP_TIMEOUT_MS = 8000;

// Local AI models (e.g. Ollama on modest hardware) can take far longer
// than a normal API call, especially on first load while the model is
// still being loaded into memory. This gets its own, much longer budget
// than dictionary/image lookups so enhanceVocabulary() doesn't abort
// while the model is still legitimately working.
const AI_TIMEOUT_MS = 90000;

const STORAGE_KEY = "litVocabEntries";
const LAST_BOOK_PAGE_KEY = "litVocabLastBookPage";

// User-configured AI integration (local by default, cloud-compatible).
// Settings are stored as a single JSON object under AI_SETTINGS_STORAGE;
// AI_CONFIG below supplies the defaults used whenever a given field hasn't
// been set (or storage is empty/corrupt).
const AI_SETTINGS_STORAGE = "litVocabAiSettings";
const AI_CONFIG = {
  apiUrl: "http://localhost:11434",
  modelName: "llama3.2:3b",
  apiKey: "",
};

// On-disk folder storage (File System Access API). When connected, entries
// are written straight to a JSON file inside a folder the user picked on
// their own computer — capped only by real disk space, unlike localStorage's
// ~5-10MB browser quota. Only Chrome/Edge (desktop) support this API; other
// browsers automatically keep using localStorage (see supportsFileSystemAccess).
const ENTRIES_FILE_NAME = "vocabulary-entries.json";
const HANDLE_DB_NAME = "litVocabFSHandles";
const HANDLE_DB_STORE = "handles";
const HANDLE_DB_KEY = "vocabFolder";
const supportsFileSystemAccess = "showDirectoryPicker" in window;

let vocabDirHandle = null;    // FileSystemDirectoryHandle, once a folder has been picked
let usingDiskStorage = false; // true once that folder's permission is actually confirmed

/* ----- Google Drive cloud storage (optional, works alongside local folder) -----
   Uses Google Identity Services (loaded in index.html) for an implicit-flow
   OAuth token, scoped to drive.file only (the app can only see files it
   creates — never the rest of the person's Drive). Like the AI settings,
   this requires the person to supply their own OAuth Client ID (created
   free at https://console.cloud.google.com/apis/credentials) since this is
   a static, keyless client-side app with no server of its own. Entries are
   written to a single JSON file the app creates in the person's Drive. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_CLIENT_ID_STORAGE = "litVocabDriveClientId";
// Pre-filled default so the person doesn't have to paste their Client ID
// in every time. This value is a public identifier, not a secret — safe
// to ship in client-side code (Google's client secrets are never used in
// this browser-only OAuth flow). It still needs the app's exact origin
// added under "Authorized JavaScript origins" for this ID in Google Cloud
// Console, or every connection attempt will keep failing regardless.
const DEFAULT_DRIVE_CLIENT_ID = "49962736437-2f722m8oj7v34ddcm79vh9asu3bpasiu.apps.googleusercontent.com";
const DRIVE_FILE_ID_STORAGE = "litVocabDriveFileId";
const DRIVE_SYNC_LOCAL_STORAGE = "litVocabSyncLocal";
const DRIVE_SYNC_CLOUD_STORAGE = "litVocabSyncCloud";
// Set once a connection succeeds (manually or silently restored), cleared
// only on an explicit "Disconnect". Its presence on page load is what
// tells init() to attempt a *silent* (no popup) reconnect, so Drive
// behaves like the local-folder option: still connected after a refresh
// instead of falling back to browser storage until you click Connect again.
const DRIVE_AUTOCONNECT_STORAGE = "litVocabDriveAutoConnect";

let driveTokenClient = null;
let driveAccessToken = null;   // short-lived OAuth token, kept only in memory
let driveFileId = localStorage.getItem(DRIVE_FILE_ID_STORAGE) || null;
let usingCloudStorage = false; // true once Drive is connected and a token has been granted

/* ---------------------------------------------------------------------
   STATE
   entry = {
     id, word, bookTitle, pageStart, pageEnd, timestamp,
     // pageStart === pageEnd for a plain single-page entry; pageEnd > pageStart
     // for a real page range (e.g. "450-470"). Legacy entries saved under the
     // old single `pageNo` field are migrated to this shape on load.
     seq,                                    // monotonic "order first entered" index
     definitions: [{ id, text, source }],    // source: dictionary | context:<book> | ai | manual
     images: [{ id, url, source }],          // source: auto | ai | manual
     phonetics: { us: {text,audio}|null, uk: {text,audio}|null }
   }
--------------------------------------------------------------------- */
let entries = [];
let editingId = null;
let availableVoices = [];
let nextSeq = 0; // assigned to each new/imported entry, guarantees stable "first entered" order

// Pending state for the "Add New Word" form, before submit.
// Each item also carries `selected` — the user ticks which auto-fetched
// (or manually added) definitions/images actually get saved. Nothing is
// pre-selected for the user; they choose what to keep.
let pendingDefinitions = []; // { id, text, source, selected }
let pendingImages = [];      // { id, url, source, selected }
let pendingPhonetics = { us: null, uk: null };

// Pending state for the edit modal (separate from the add form).
let editPendingDefinitions = [];
let editPendingImages = [];

// Tracks what the last automatic lookup was for, so we don't re-fetch
// the same thing repeatedly, and so we know what to clear when the word
// changes.
let lookupState = { word: "", dictDone: false };

/* ---------------------------------------------------------------------
   DOM REFERENCES
--------------------------------------------------------------------- */
const form = document.getElementById("entry-form");
const wordInput = document.getElementById("word-input");
const bookInput = document.getElementById("book-input");
const pageInput = document.getElementById("page-input");
const definitionInput = document.getElementById("definition-input");
const addDefinitionBtn = document.getElementById("add-definition-btn");
const bookSuggestions = document.getElementById("book-suggestions");

const manualModeTag = document.getElementById("manual-mode-tag");
const aiLoadingTag = document.getElementById("ai-loading-tag");
const contextLoadingTag = document.getElementById("context-loading-tag");

const aiFetchBtn = document.getElementById("ai-fetch-btn");
const aiFetchBtnLabel = document.getElementById("ai-fetch-btn-label");
const aiFetchStatus = document.getElementById("ai-fetch-status");
const aiSettingsBtn = document.getElementById("ai-settings-btn");

const aiSettingsModal = document.getElementById("ai-settings-modal");
const aiSettingsUrlInput = document.getElementById("ai-settings-url");
const aiSettingsModelInput = document.getElementById("ai-settings-model");
const aiSettingsKeyInput = document.getElementById("ai-settings-key");
const aiSettingsSaveBtn = document.getElementById("ai-settings-save-btn");
const aiSettingsCancelBtn = document.getElementById("ai-settings-cancel-btn");
const aiSettingsResetBtn = document.getElementById("ai-settings-reset-btn");

const pronUsText = document.getElementById("pron-us-text");
const pronUkText = document.getElementById("pron-uk-text");
const pronUsBtn = document.getElementById("pron-us-btn");
const pronUkBtn = document.getElementById("pron-uk-btn");
const definitionsList = document.getElementById("definitions-list");

const imageLoadingTag = document.getElementById("image-loading-tag");
const imagesGallery = document.getElementById("images-gallery");
const imageUrlInput = document.getElementById("image-url-input");
const addImageBtn = document.getElementById("add-image-btn");

const defSelectAllBtn = document.getElementById("def-select-all-btn");
const defSelectNoneBtn = document.getElementById("def-select-none-btn");
const imgSelectAllBtn = document.getElementById("img-select-all-btn");
const imgSelectNoneBtn = document.getElementById("img-select-none-btn");

const bookFilter = document.getElementById("book-filter");
const pageFilter = document.getElementById("page-filter");
const searchInput = document.getElementById("search-input");
const entryCount = document.getElementById("entry-count");
const tableContainer = document.getElementById("table-container");
const footerTotal = document.getElementById("footer-total");

const exportJsonBtn = document.getElementById("export-json-btn");
const exportPdfBtn = document.getElementById("export-pdf-btn");
const importBtn = document.getElementById("import-btn");
const importFileInput = document.getElementById("import-file-input");
const deleteAllBtn = document.getElementById("delete-all-btn");

const storageStatus = document.getElementById("storage-status");
const storageToggleBtn = document.getElementById("storage-toggle-btn");
const storageIcon = document.getElementById("storage-icon");
const storagePanel = document.getElementById("storage-panel");
const chooseFolderBtn = document.getElementById("choose-folder-btn");
const reconnectFolderBtn = document.getElementById("reconnect-folder-btn");

const cloudStatus = document.getElementById("cloud-status");
const connectDriveBtn = document.getElementById("connect-drive-btn");
const disconnectDriveBtn = document.getElementById("disconnect-drive-btn");
const changeClientIdBtn = document.getElementById("change-client-id-btn");
const originValue = document.getElementById("origin-value");
const copyOriginBtn = document.getElementById("copy-origin-btn");
const syncBothRow = document.getElementById("sync-both-row");
const syncLocalCheckbox = document.getElementById("sync-local-checkbox");
const syncCloudCheckbox = document.getElementById("sync-cloud-checkbox");

const customizeToggleBtn = document.getElementById("customize-toggle-btn");
const customizePanel = document.getElementById("customize-panel");
const customizeModeBtn = document.getElementById("customize-mode-btn");
const resetLayoutBtn = document.getElementById("reset-layout-btn");

const limitsToggleBtn = document.getElementById("limits-toggle-btn");
const limitsPanel = document.getElementById("limits-panel");
const systemDefLimitInput = document.getElementById("system-def-limit-input");
const aiDefLimitInput = document.getElementById("ai-def-limit-input");
const manualDefLimitInput = document.getElementById("manual-def-limit-input");
const systemImgLimitInput = document.getElementById("system-img-limit-input");
const aiImgLimitInput = document.getElementById("ai-img-limit-input");
const manualImgLimitInput = document.getElementById("manual-img-limit-input");

const displayToggleBtn = document.getElementById("display-toggle-btn");
const displayPanel = document.getElementById("display-panel");
const bubblyModeToggle = document.getElementById("bubbly-mode-toggle");
const bubbleModeToggle = document.getElementById("bubble-mode-toggle");
const searchWidthInput = document.getElementById("search-width-input");
const searchWidthValue = document.getElementById("search-width-value");
const defTextSizeInput = document.getElementById("def-text-size-input");
const defTextSizeValue = document.getElementById("def-text-size-value");
const imgThumbSizeInput = document.getElementById("img-thumb-size-input");
const imgThumbSizeValue = document.getElementById("img-thumb-size-value");
const resetDisplayBtn = document.getElementById("reset-display-btn");
const glassControls = document.getElementById("glass-controls");
const glassTransparencyInput = document.getElementById("glass-transparency-input");
const glassTransparencyValue = document.getElementById("glass-transparency-value");
const glassBlurInput = document.getElementById("glass-blur-input");
const glassBlurValue = document.getElementById("glass-blur-value");
const glassTintInput = document.getElementById("glass-tint-input");
const glassTintValue = document.getElementById("glass-tint-value");
const fishModeToggle = document.getElementById("fish-mode-toggle");
const fishSpeciesControls = document.getElementById("fish-species-controls");
const fishSpeciesCheckboxes = Array.from(
  document.querySelectorAll("#fish-species-controls input[data-species]")
);
const sharkVariantControls = document.getElementById("shark-variant-controls");
const sharkVariantCheckboxes = Array.from(
  document.querySelectorAll("#shark-variant-controls input[data-variant]")
);
const addSharkBtn = document.getElementById("add-shark-btn");
const removeSharkBtn = document.getElementById("remove-shark-btn");
const sharkCountLabel = document.getElementById("shark-count-label");

const exportLocalCheckbox = document.getElementById("export-local-checkbox");
const exportDriveCheckbox = document.getElementById("export-drive-checkbox");
const exportDriveCheckWrap = document.getElementById("export-drive-check-wrap");

const editModal = document.getElementById("edit-modal");
const editWord = document.getElementById("edit-word");
const editBook = document.getElementById("edit-book");
const editPage = document.getElementById("edit-page");
const editDefinitionsList = document.getElementById("edit-definitions-list");
const editDefinitionInput = document.getElementById("edit-definition-input");
const editAddDefinitionBtn = document.getElementById("edit-add-definition-btn");
const editImagesGallery = document.getElementById("edit-images-gallery");
const editImageUrlInput = document.getElementById("edit-image-url-input");
const editAddImageBtn = document.getElementById("edit-add-image-btn");
const editDefSelectAllBtn = document.getElementById("edit-def-select-all-btn");
const editDefSelectNoneBtn = document.getElementById("edit-def-select-none-btn");
const editImgSelectAllBtn = document.getElementById("edit-img-select-all-btn");
const editImgSelectNoneBtn = document.getElementById("edit-img-select-none-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const saveEditBtn = document.getElementById("save-edit-btn");

/* ---------------------------------------------------------------------
   PERSISTENCE
--------------------------------------------------------------------- */
function loadEntriesFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    entries = raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Failed to parse stored entries, resetting.", err);
    entries = [];
  }
}

function saveEntriesToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    console.error("Failed to save entries to localStorage.", err);
    alert("Could not save your entry — your browser storage may be full or disabled.");
  }
}

// This device's local copy (browser storage, or your chosen folder) is
// always the source of truth for Drive. Connecting/reconnecting never
// pulls remote-only entries in and never lets a stale remote copy
// resurrect something you deleted locally — instead, Drive is made to
// mirror local exactly: entries missing locally are dropped from Drive,
// entries present locally but missing on Drive are added, and entries
// present on both sides are left as they are locally. This function only
// computes a summary of that diff (for the confirmation message); the
// actual sync is a plain overwrite via saveEntries()/writeEntriesToDrive().
function summarizeDriveSync(local, remote) {
  const localIds = new Set((Array.isArray(local) ? local : []).map((e) => e && e.id));
  const remoteIds = new Set((Array.isArray(remote) ? remote : []).map((e) => e && e.id));
  let added = 0;
  let kept = 0;
  localIds.forEach((id) => {
    if (remoteIds.has(id)) kept += 1;
    else added += 1;
  });
  let removed = 0;
  remoteIds.forEach((id) => {
    if (!localIds.has(id)) removed += 1;
  });
  return { added, removed, kept };
}

/* ----- IndexedDB: remembers the chosen folder handle across sessions -----
   localStorage can only hold strings, but a FileSystemDirectoryHandle is a
   live object reference — IndexedDB is the browser API that can store it. */
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_DB_STORE, "readonly");
      const req = tx.objectStore(HANDLE_DB_STORE).get(HANDLE_DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error("Failed to read stored folder handle:", err);
    return null;
  }
}

async function idbSetHandle(handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_DB_STORE, "readwrite");
      tx.objectStore(HANDLE_DB_STORE).put(handle, HANDLE_DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error("Failed to remember chosen folder:", err);
  }
}

/* ----- Folder permission & file I/O ----- */
async function verifyFolderPermission(handle, requestIfNeeded) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

async function readEntriesFromDisk() {
  try {
    const fileHandle = await vocabDirHandle.getFileHandle(ENTRIES_FILE_NAME, { create: true });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return text.trim() ? JSON.parse(text) : [];
  } catch (err) {
    console.error("Failed to read entries from the chosen folder:", err);
    return [];
  }
}

async function writeEntriesToDisk(list) {
  try {
    const fileHandle = await vocabDirHandle.getFileHandle(ENTRIES_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(list));
    await writable.close();
  } catch (err) {
    console.error("Failed to save entries to the chosen folder:", err);
    alert(
      "Couldn't save to your chosen folder — permission may have been revoked. " +
        "Saving to browser storage instead for now; use \"Reconnect Folder\" to fix this."
    );
    usingDiskStorage = false;
    saveEntriesToLocalStorage();
    updateStorageStatusUI();
  }
}

// On page load: silently reconnect to a previously chosen folder if the
// browser still has permission. If permission needs re-confirming, the
// handle is kept around so the "Reconnect Folder" button works in one
// click, rather than making the user pick the folder all over again.
async function tryRestoreFolderConnection() {
  if (!supportsFileSystemAccess) return false;
  const handle = await idbGetHandle();
  if (!handle) return false;

  vocabDirHandle = handle;
  const granted = await verifyFolderPermission(handle, false);
  usingDiskStorage = granted;
  return granted;
}

async function chooseStorageFolder() {
  if (!supportsFileSystemAccess) {
    alert(
      "Your browser doesn't support choosing a local folder (try Chrome or Edge on desktop). " +
        "Your words will keep being saved in browser storage instead."
    );
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const granted = await verifyFolderPermission(handle, true);
    if (!granted) {
      alert("Permission to that folder was denied, so nothing changed.");
      return;
    }

    // Carry over whatever is currently loaded (browser storage, or a
    // previous folder) into the newly chosen folder so nothing is lost.
    const currentEntries = entries.slice();

    vocabDirHandle = handle;
    usingDiskStorage = true;
    await idbSetHandle(handle);
    await writeEntriesToDisk(currentEntries);

    updateStorageStatusUI();
    storagePanel.classList.add("hidden");
    alert(`Connected! Your words will now be saved to the "${handle.name}" folder on your computer.`);
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.error("Folder selection failed:", err);
      alert("Couldn't connect to that folder. Nothing was changed.");
    }
  }
}

async function reconnectStorageFolder() {
  if (!vocabDirHandle) return chooseStorageFolder();

  const granted = await verifyFolderPermission(vocabDirHandle, true);
  if (!granted) {
    alert("Permission wasn't granted, so nothing changed.");
    return;
  }

  usingDiskStorage = true;
  entries = await readEntriesFromDisk();
  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
  updateStorageStatusUI();
  storagePanel.classList.add("hidden");
}

function updateStorageStatusUI() {
  updateCloudStatusUI();
  if (!supportsFileSystemAccess) {
    storageStatus.textContent =
      "Your browser doesn't support local folder storage — using browser storage (~10MB limit). Try Chrome or Edge on desktop for unlimited folder storage.";
    storageIcon.textContent = "💾";
    storageToggleBtn.classList.remove("needs-attention");
    chooseFolderBtn.classList.add("hidden");
    reconnectFolderBtn.classList.add("hidden");
    return;
  }

  if (usingDiskStorage && vocabDirHandle) {
    storageStatus.textContent = `Saving to folder "${vocabDirHandle.name}" — limited only by your free disk space.`;
    storageIcon.textContent = "📁";
    storageToggleBtn.classList.remove("needs-attention");
    chooseFolderBtn.textContent = "Change Folder";
    chooseFolderBtn.classList.remove("hidden");
    reconnectFolderBtn.classList.add("hidden");
  } else if (vocabDirHandle) {
    storageStatus.textContent = `Folder "${vocabDirHandle.name}" was chosen before — click to reconnect this session.`;
    storageIcon.textContent = "⚠️";
    storageToggleBtn.classList.add("needs-attention");
    chooseFolderBtn.classList.add("hidden");
    reconnectFolderBtn.classList.remove("hidden");
  } else {
    storageStatus.textContent = "Not connected to a folder — currently using browser storage (~10MB limit).";
    storageIcon.textContent = "💾";
    storageToggleBtn.classList.remove("needs-attention");
    chooseFolderBtn.textContent = "Choose Folder";
    chooseFolderBtn.classList.remove("hidden");
    reconnectFolderBtn.classList.add("hidden");
  }
}

storageToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  storagePanel.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!storagePanel.classList.contains("hidden") && !e.target.closest("#storage-widget")) {
    storagePanel.classList.add("hidden");
  }
  if (!customizePanel.classList.contains("hidden") && !e.target.closest("#customize-widget")) {
    customizePanel.classList.add("hidden");
  }
  if (!limitsPanel.classList.contains("hidden") && !e.target.closest("#limits-widget")) {
    limitsPanel.classList.add("hidden");
  }
  if (!displayPanel.classList.contains("hidden") && !e.target.closest("#display-widget")) {
    displayPanel.classList.add("hidden");
  }
});

chooseFolderBtn.addEventListener("click", chooseStorageFolder);
reconnectFolderBtn.addEventListener("click", reconnectStorageFolder);

/* ---------------------------------------------------------------------
   CUSTOMIZE LAYOUT — lets the person drag AND resize key controls
   anywhere on the page. Position is stored as a pixel offset from each
   element's normal spot (applied via CSS transform); size is stored as
   an explicit width/height override. Nothing else about the page's
   flow has to change.
--------------------------------------------------------------------- */
const LAYOUT_STORAGE_KEY = "litVocabLayoutOffsets";
const CUSTOMIZE_MODE_KEY = "litVocabCustomizeMode";
const CUSTOMIZABLE_IDS = [
  "limits-widget",
  "display-widget",
  "customize-widget",
  "storage-widget",
  "word-input",
  "book-input",
  "search-input",
  "book-filter",
  "page-filter",
  "entry-form-submit-btn",
  "ai-fetch-btn",
  "ai-settings-btn",
  "search-gemini-btn",
  "add-definition-btn",
  "add-image-btn",
  "export-json-btn",
  "export-pdf-btn",
  "import-btn",
  "delete-all-btn",
  // Panels a person selects things in (definitions/images) or reads often
  // (pronunciation, the header bar itself), plus the two toolbar "bars"
  // (filter bar, export/import bar) — same drag/resize treatment as every
  // other control above.
  "site-header-bar",
  "pronunciation-panel",
  "definitions-list",
  "images-gallery",
  "filter-row",
  "export-import-row",
  // Whole panels — lets the whole "Add a Word" card, filter/toolbar card,
  // and register table card each be resized/repositioned as one block.
  "form-card",
  "filter-card",
  "table-card",
];

// These particular targets are internally-scrolling panels capped by
// `.scroll-panel`'s CSS max-height (see style.css) — a plain inline
// `height` alone can't grow them past that cap, so resizing needs to lift
// the cap too. Everything else in CUSTOMIZABLE_IDS is unaffected by this.
const SCROLL_CAPPED_IDS = new Set(["definitions-list", "images-gallery"]);
const MIN_ELEMENT_WIDTH = 32;
const MIN_ELEMENT_HEIGHT = 24;

// Native <input>/<select>/<textarea> elements can't render child nodes
// (browsers never draw content inside a form control), so a drag/resize
// handle appended directly to one would be invisible. For those, we wrap
// the control in a plain <span> at the same spot in the DOM and make the
// *wrapper* draggable/resizable instead — the control itself is set to
// fill the wrapper, so resizing the wrapper visibly resizes the control.
// customizableTargets maps each id to the actual element being dragged/
// resized (the wrapper for form controls, the element itself otherwise).
const customizableTargets = {};

function getCustomizableTarget(id) {
  return customizableTargets[id] || document.getElementById(id);
}

// For definitions-list / images-gallery, the *frame* (customizableTargets[id])
// is what gets dragged/resized, but the actual scrolling panel is the
// original element (same id, now just nested one level deeper) — its own
// CSS max-height cap has to move in lockstep or the frame and its content
// fall out of sync the moment either one is resized.
function getScrollCappedInner(id) {
  return SCROLL_CAPPED_IDS.has(id) ? document.getElementById(id) : null;
}

function getLayoutOffsets() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "{}");
  } catch (err) {
    return {};
  }
}

function saveLayoutEntry(id, patch) {
  const offsets = getLayoutOffsets();
  offsets[id] = { x: 0, y: 0, ...offsets[id], ...patch };
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(offsets));
  } catch (err) {
    // non-fatal
  }
}

function applySavedLayout() {
  const offsets = getLayoutOffsets();
  CUSTOMIZABLE_IDS.forEach((id) => {
    const el = getCustomizableTarget(id);
    const pos = offsets[id];
    if (!el || !pos) return;
    el.style.transform = `translate(${pos.x || 0}px, ${pos.y || 0}px)`;
    if (pos.w) el.style.width = `${pos.w}px`;
    if (pos.h) {
      el.style.height = `${pos.h}px`;
      const inner = getScrollCappedInner(id);
      if (inner) inner.style.maxHeight = `${pos.h}px`;
    }
  });
}

function resetLayout() {
  try {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch (err) {
    // non-fatal
  }
  CUSTOMIZABLE_IDS.forEach((id) => {
    const el = getCustomizableTarget(id);
    if (!el) return;
    // Briefly opt this element into a springy transition so it glides back
    // to its default spot/size instead of snapping instantly.
    el.classList.add("layout-settling");
    el.style.transform = "";
    el.style.width = "";
    el.style.height = "";
    const inner = getScrollCappedInner(id);
    if (inner) {
      inner.classList.add("layout-settling");
      inner.style.maxHeight = "";
      window.setTimeout(() => inner.classList.remove("layout-settling"), 420);
    }
    window.setTimeout(() => el.classList.remove("layout-settling"), 420);
  });
}

let customizeModeOn = localStorage.getItem(CUSTOMIZE_MODE_KEY) === "true";

function setCustomizeMode(on) {
  customizeModeOn = on;
  document.body.classList.toggle("customize-mode", on);
  customizeModeBtn.textContent = on ? "🔒 Lock Layout" : "✥ Enable Free Placement";
  try {
    localStorage.setItem(CUSTOMIZE_MODE_KEY, String(on));
  } catch (err) {
    // non-fatal
  }
}

// Dragging is initiated ONLY from the small "⠿ drag" handle badge that
// appears on each customizable element in Free Placement mode — never from
// the element itself. That's what keeps every button (including the
// Customize toggle button) fully clickable at all times, so Free
// Placement can always be switched back off through the UI.
function makeDraggable(el, handle, id) {
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    if (!customizeModeOn) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const offsets = getLayoutOffsets();
    const pos = offsets[id] || { x: 0, y: 0 };
    baseX = pos.x || 0;
    baseY = pos.y || 0;
    handle.setPointerCapture?.(e.pointerId);
    el.classList.add("is-lifted");

    function onMove(ev) {
      if (!dragging) return;
      const x = baseX + (ev.clientX - startX);
      const y = baseY + (ev.clientY - startY);
      el.style.transform = `translate(${x}px, ${y}px)`;
    }

    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      const x = baseX + (ev.clientX - startX);
      const y = baseY + (ev.clientY - startY);
      saveLayoutEntry(id, { x, y });
      el.classList.remove("is-lifted");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// Resizing is initiated ONLY from the small "⤡ resize" handle badge in the
// bottom-right corner — same isolation principle as the drag handle, so
// the element's own interactions (typing, clicking) are never hijacked.
function makeResizable(el, handle, id) {
  let startX = 0;
  let startY = 0;
  let baseW = 0;
  let baseH = 0;
  let resizing = false;

  handle.addEventListener("pointerdown", (e) => {
    if (!customizeModeOn) return;
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    baseW = rect.width;
    baseH = rect.height;
    const inner = getScrollCappedInner(id);
    handle.setPointerCapture?.(e.pointerId);
    el.classList.add("is-lifted");

    function onMove(ev) {
      if (!resizing) return;
      const w = Math.max(MIN_ELEMENT_WIDTH, baseW + (ev.clientX - startX));
      const h = Math.max(MIN_ELEMENT_HEIGHT, baseH + (ev.clientY - startY));
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      if (inner) inner.style.maxHeight = `${h}px`;
    }

    function onUp(ev) {
      if (!resizing) return;
      resizing = false;
      const w = Math.max(MIN_ELEMENT_WIDTH, baseW + (ev.clientX - startX));
      const h = Math.max(MIN_ELEMENT_HEIGHT, baseH + (ev.clientY - startY));
      saveLayoutEntry(id, { w, h });
      el.classList.remove("is-lifted");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

customizeToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  customizePanel.classList.toggle("hidden");
});

customizeModeBtn.addEventListener("click", () => setCustomizeMode(!customizeModeOn));
resetLayoutBtn.addEventListener("click", resetLayout);

// Safety net: Escape always exits Free Placement immediately, even in the
// unlikely event a handle or panel becomes hard to reach.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && customizeModeOn) setCustomizeMode(false);
});

const WRAPPABLE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

// A control's caption almost always lives as the immediately preceding
// sibling — either a plain <label> (Word, Page, Pronunciation, Book,
// Search, etc.) or, for the definitions/images panels, the ".def-label-row"
// that holds the section title plus its "All / None" links. Either way,
// that's the piece that needs to travel and resize together with its
// control, so we detect it generically rather than hardcoding it per id.
function findAssociatedLabel(el) {
  const prev = el.previousElementSibling;
  if (!prev) return null;
  if (prev.tagName === "LABEL" || prev.classList.contains("def-label-row")) return prev;
  return null;
}

// The definitions/images panels scroll internally (`.scroll-panel` sets
// overflow-y: auto, which implicitly clips the x-axis too), so a handle
// positioned just outside their own box — like every other handle in this
// UI — gets silently clipped and never appears. Fix: wrap the caption +
// control together in a plain, non-scrolling flex frame and put the
// handles on the *frame* instead. The frame lays its children out in a
// column — caption at its natural height, control filling whatever's
// left — so everything behaves exactly as before until the frame is
// actually resized, at which point the control (not the caption) is what
// grows or shrinks.
function wrapForCustomize(original, labelEl, useGroupLayout) {
  const wrap = document.createElement(useGroupLayout ? "div" : "span");
  wrap.className = useGroupLayout ? "customizable-group-wrap" : "resize-drag-wrap";
  const anchor = labelEl || original;
  anchor.parentNode.insertBefore(wrap, anchor);
  if (labelEl) wrap.appendChild(labelEl);
  wrap.appendChild(original);
  return wrap;
}

function initCustomizeLayout() {
  CUSTOMIZABLE_IDS.forEach((id) => {
    const original = document.getElementById(id);
    if (!original) return;

    const labelEl = findAssociatedLabel(original);
    const needsWrap = WRAPPABLE_TAGS.has(original.tagName) || SCROLL_CAPPED_IDS.has(id) || !!labelEl;

    let target = original;
    if (needsWrap) {
      target = wrapForCustomize(original, labelEl, !!labelEl);
    }
    customizableTargets[id] = target;

    target.classList.add("customizable");

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.innerHTML = "<span class=\"drag-handle-icon\">⠿</span>Drag";
    dragHandle.title = "Drag to reposition";
    target.appendChild(dragHandle);
    makeDraggable(target, dragHandle, id);

    const resizeHandle = document.createElement("span");
    resizeHandle.className = "resize-handle";
    resizeHandle.title = "Drag to resize";
    target.appendChild(resizeHandle);
    makeResizable(target, resizeHandle, id);
  });
  applySavedLayout();
  setCustomizeMode(customizeModeOn);
}

/* ---------------------------------------------------------------------
   GOOGLE DRIVE (optional cloud storage, can run alongside local folder)
--------------------------------------------------------------------- */
function getDriveClientId() {
  try {
    return localStorage.getItem(DRIVE_CLIENT_ID_STORAGE) || DEFAULT_DRIVE_CLIENT_ID;
  } catch (err) {
    return DEFAULT_DRIVE_CLIENT_ID;
  }
}

function setDriveClientId(id) {
  try {
    if (id) localStorage.setItem(DRIVE_CLIENT_ID_STORAGE, id);
    else localStorage.removeItem(DRIVE_CLIENT_ID_STORAGE);
  } catch (err) {
    // non-fatal
  }
}

function getSyncPrefs() {
  const readBool = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw === "true";
    } catch (err) {
      return fallback;
    }
  };
  return {
    local: readBool(DRIVE_SYNC_LOCAL_STORAGE, true),
    cloud: readBool(DRIVE_SYNC_CLOUD_STORAGE, true),
  };
}

function setSyncPref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (err) {
    // non-fatal
  }
}

// Google's OAuth/Identity Services flatly refuses to authorize pages
// opened directly from disk (file:///...) — it requires a real http(s)
// origin. Opening this file by double-clicking it, or via "File > Open",
// will always hit "Access blocked: Authorisation error / Error 400:
// invalid_request" no matter how the Client ID is configured. We detect
// that case up front so the app can explain it plainly instead of
// bouncing the person to Google's confusing error page.
function isRunningFromFile() {
  return window.location.protocol === "file:";
}

// Hosts like Hugging Face Spaces often show a "landing page" URL
// (e.g. huggingface.co/spaces/you/app) while the app itself actually runs
// inside an <iframe> on a different subdomain (e.g. your-app.hf.space).
// window.location.origin always reflects the real, currently-executing
// frame, which is exactly what Google needs registered — the browser's
// address bar can be misleading here, so we surface the real value.
function isEmbeddedInIframe() {
  try {
    return window.self !== window.top;
  } catch (err) {
    return true; // cross-origin access throws, which itself implies an iframe
  }
}

function updateOriginDisplay() {
  if (!originValue) return;
  originValue.textContent = window.location.origin;
}

copyOriginBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.origin);
    copyOriginBtn.textContent = "Copied!";
    setTimeout(() => (copyOriginBtn.textContent = "Copy"), 1500);
  } catch (err) {
    window.prompt("Copy this origin:", window.location.origin);
  }
});

function promptForDriveClientId() {
  const existing = getDriveClientId();
  const id = window.prompt(
    "Paste your Google OAuth Client ID to connect Google Drive.\n\n" +
      "Don't have one? Create a free \"OAuth client ID\" (type: Web application) at " +
      "https://console.cloud.google.com/apis/credentials, add this page's exact URL " +
      `(currently: ${window.location.origin}) under "Authorized JavaScript origins", and ` +
      "enable the Google Drive API for the project. The app only ever accesses files it " +
      "creates itself (drive.file scope) — never the rest of your Drive.",
    existing
  );
  if (id === null) return null; // cancelled
  const trimmed = id.trim();
  setDriveClientId(trimmed);
  return trimmed;
}

function driveApiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${driveAccessToken}`,
    },
  });
}

async function findDriveFileId() {
  const q = encodeURIComponent(`name = '${ENTRIES_FILE_NAME}' and trashed = false`);
  const res = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
  );
  if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function createDriveFile(list) {
  const metadata = { name: ENTRIES_FILE_NAME, mimeType: "application/json" };
  const boundary = "vocabRegisterBoundary";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(list)}\r\n--${boundary}--`;

  const res = await driveApiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
  );
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
  const data = await res.json();
  return data.id;
}

async function readEntriesFromDrive() {
  driveFileId = driveFileId || (await findDriveFileId());
  if (!driveFileId) return [];
  const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive read failed (${res.status})`);
  const text = await res.text();
  localStorage.setItem(DRIVE_FILE_ID_STORAGE, driveFileId);
  return text.trim() ? JSON.parse(text) : [];
}

async function writeEntriesToDrive(list) {
  try {
    if (!driveFileId) driveFileId = await findDriveFileId();
    if (!driveFileId) {
      driveFileId = await createDriveFile(list);
    } else {
      const res = await driveApiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) }
      );
      if (!res.ok) throw new Error(`Drive update failed (${res.status})`);
    }
    localStorage.setItem(DRIVE_FILE_ID_STORAGE, driveFileId);
  } catch (err) {
    console.error("Failed to save entries to Google Drive:", err);
    usingCloudStorage = false;
    updateStorageStatusUI();
    alert("Couldn't save to Google Drive — you may need to reconnect. Your words are still safe elsewhere.");
  }
}

// Turns whatever requestDriveToken rejected with into a message a
// non-developer can actually act on.
function driveErrorMessage(err) {
  const code = err && err.message;
  switch (code) {
    case "file-protocol":
      return (
        "Google Drive sign-in can't work while this page is opened directly from a file " +
        "on your computer (a \"file://\" address) — Google blocks that for every app, not " +
        "just this one. To use Drive sync, serve this folder over http(s) instead: the " +
        "simplest options are running a tiny local server (e.g. \"npx serve\" or Python's " +
        "\"python -m http.server\" in this folder, then opening the localhost link it gives " +
        "you) or hosting the files somewhere like GitHub Pages. Then add that page's URL to " +
        "\"Authorized JavaScript origins\" for your OAuth Client ID. Your local folder or " +
        "browser storage will keep working fine in the meantime."
      );
    case "no-client-id":
      return null; // user cancelled the prompt — nothing to say
    case "popup_closed":
      return "The Google sign-in window was closed before finishing. Click Connect Google Drive to try again.";
    case "access_denied":
      return "Google Drive access wasn't granted. Click Connect Google Drive again and approve the permission request to continue.";
    case "idpiframe_initialization_failed":
    case "popup_failed_to_open":
      return "Google's sign-in popup couldn't open — check that your browser isn't blocking popups for this page, then try again.";
    case "invalid_client":
      return (
        "Google rejected the Client ID (invalid_client — \"no registered origin\"). This means " +
        `the exact origin ${window.location.origin} isn't listed under "Authorized JavaScript ` +
        "origins\" for this Client ID in Google Cloud Console (APIs & Services > Credentials). " +
        (isEmbeddedInIframe()
          ? "This page appears to be embedded in an iframe (common on hosts like Hugging Face " +
            "Spaces) — make sure you registered the origin shown in this panel, not the URL in " +
            "your browser's address bar, since those can differ. "
          : "") +
        "Use the Copy button next to \"Authorized origin needed\" above to copy the exact value, " +
        "paste it into the origins list, save, and wait a few minutes for Google to pick it up " +
        "before trying again."
      );
    case "invalid_request":
      return (
        "Google rejected the sign-in request (invalid_request). This almost always means this " +
        "page's URL isn't listed under \"Authorized JavaScript origins\" for your OAuth Client " +
        `ID — copy the exact origin shown above (${window.location.origin}) into Google Cloud ` +
        "Console and try again."
      );
    case "timeout":
      return (
        "Google's sign-in window didn't complete. If it showed an error page instead of the " +
        "usual consent screen, that almost always means this exact origin isn't registered for " +
        "your Client ID yet — see \"Authorized origin needed\" above."
      );
    default:
      return "Couldn't connect to Google Drive. Double-check your Client ID and try again.";
  }
}

function requestDriveToken(interactive) {
  const attempt = new Promise((resolve, reject) => {
    if (isRunningFromFile()) {
      reject(new Error("file-protocol"));
      return;
    }
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google Identity Services didn't load — check your internet connection."));
      return;
    }
    const clientId = getDriveClientId();
    if (!clientId) {
      reject(new Error("no-client-id"));
      return;
    }
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else {
          driveAccessToken = resp.access_token;
          resolve(resp.access_token);
        }
      },
      error_callback: (err) => {
        reject(new Error(err?.type || "popup_failed_to_open"));
      },
    });
    try {
      driveTokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (err) {
      reject(err);
    }
  });

  // If Google's popup gets stuck showing its own error page (as happens
  // for an unregistered origin), neither callback above ever fires and
  // the promise would otherwise hang forever with no feedback.
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), 45000);
  });

  return Promise.race([attempt, timeout]);
}

// The GIS script tag is loaded async/defer, so it can still be mid-flight
// when init() runs. Poll briefly for it rather than giving up immediately.
function waitForGoogleIdentity(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (window.google?.accounts?.oauth2) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(poll, 100);
      }
    })();
  });
}

// On page load: if a previous session successfully connected to Drive,
// try to silently re-acquire an access token (prompt: "", no popup) so
// Drive reconnects on its own the way the local-folder option already
// does — instead of quietly falling back to localStorage until the
// person notices and clicks "Connect Google Drive" again. If Google
// can't grant a token without interaction (session expired, consent
// revoked, third-party cookies blocked, etc.) this fails silently and
// the person just sees "Connect Google Drive" as before.
async function tryRestoreDriveConnection() {
  if (isRunningFromFile()) return false;
  if (localStorage.getItem(DRIVE_AUTOCONNECT_STORAGE) !== "1") return false;
  const clientId = getDriveClientId();
  if (!clientId) return false;

  const ready = await waitForGoogleIdentity(6000);
  if (!ready) return false;

  try {
    const silentTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
    await Promise.race([requestDriveToken(false), silentTimeout]);
    usingCloudStorage = true;
    return true;
  } catch (err) {
    console.warn("Silent Google Drive reconnect failed; staying on local storage until reconnected manually:", err);
    usingCloudStorage = false;
    return false;
  }
}

async function connectGoogleDrive() {
  if (isRunningFromFile()) {
    alert(driveErrorMessage(new Error("file-protocol")));
    updateCloudStatusUI();
    return;
  }

  // Embedding hosts like Hugging Face Spaces sometimes set cross-origin
  // isolation headers that sever the popup's connection back to this page,
  // making Google's sign-in library report "closed" the instant it opens —
  // even though nothing was actually dismissed. Opening the app in its own
  // tab (not inside the Space's iframe) sidesteps that entirely, so offer
  // it up front rather than letting the person hit a confusing failure.
  if (isEmbeddedInIframe()) {
    const openDirect = window.confirm(
      "This app is currently embedded in an iframe (as it is on Hugging Face's Space page), " +
        "which often causes Google's sign-in popup to close instantly even though nothing was " +
        "actually dismissed.\n\nFor a reliable connection, open the app in its own tab instead.\n\n" +
        "Open it now in a new tab? (Choose Cancel to try connecting here anyway.)"
    );
    if (openDirect) {
      window.open(window.location.href, "_blank", "noopener");
      return;
    }
  }

  let clientId = getDriveClientId();
  if (!clientId) {
    clientId = promptForDriveClientId();
    if (!clientId) return; // cancelled
  }
  try {
    await requestDriveToken(true);
    usingCloudStorage = true;
    localStorage.setItem(DRIVE_AUTOCONNECT_STORAGE, "1");

    // Your local copy (this browser, or your chosen folder) is the source
    // of truth. Rather than merging in whatever's already on Drive —
    // which could silently mix in stale or unwanted remote-only entries —
    // Drive gets overwritten to match local exactly: anything missing
    // locally is dropped from Drive, anything local-only gets added, and
    // anything already matching is left alone. Nothing local is ever
    // deleted or replaced by this.
    let summary = null;
    try {
      const remote = await readEntriesFromDrive();
      summary = summarizeDriveSync(entries, remote);
    } catch (err) {
      console.warn("Couldn't read existing Drive contents before syncing (will still overwrite):", err);
    }
    saveEntries(); // overwrites Drive with local entries (and disk, per sync prefs) + localStorage mirror

    updateStorageStatusUI();
    alert(
      summary
        ? `Connected! Google Drive now matches this device: ${summary.kept} kept, ${summary.added} added, ${summary.removed} removed.`
        : "Connected! Your words can now be saved to Google Drive."
    );
  } catch (err) {
    console.error("Google Drive connection failed:", err);
    const message = driveErrorMessage(err);
    if (message) alert(message);
    updateCloudStatusUI();
  }
}

function disconnectGoogleDrive() {
  usingCloudStorage = false;
  driveAccessToken = null;
  localStorage.removeItem(DRIVE_AUTOCONNECT_STORAGE);
  updateStorageStatusUI();
}

connectDriveBtn.addEventListener("click", connectGoogleDrive);
disconnectDriveBtn.addEventListener("click", disconnectGoogleDrive);

// Lets the person swap in a corrected Client ID without having to dig
// through localStorage — disconnects any existing (possibly broken)
// connection first, re-prompts (pre-filled with whatever was saved
// before, so it's easy to edit rather than retype from scratch), then
// immediately tries connecting with whatever they entered.
async function changeDriveClientId() {
  if (usingCloudStorage) disconnectGoogleDrive();
  const newId = promptForDriveClientId();
  if (newId === null) return; // cancelled
  updateCloudStatusUI();
  if (newId) connectGoogleDrive();
}

changeClientIdBtn.addEventListener("click", changeDriveClientId);

syncLocalCheckbox.addEventListener("change", () => setSyncPref(DRIVE_SYNC_LOCAL_STORAGE, syncLocalCheckbox.checked));
syncCloudCheckbox.addEventListener("change", () => setSyncPref(DRIVE_SYNC_CLOUD_STORAGE, syncCloudCheckbox.checked));

function updateCloudStatusUI() {
  if (usingCloudStorage) {
    cloudStatus.textContent = "Connected — your words can be saved to Google Drive.";
    cloudStatus.classList.remove("storage-status-warning");
    connectDriveBtn.classList.add("hidden");
    disconnectDriveBtn.classList.remove("hidden");
  } else if (isRunningFromFile()) {
    cloudStatus.textContent =
      "Google Drive can't connect while this page is opened as a local file (file://). " +
      "Serve it over http(s) — e.g. a local server or GitHub Pages — to enable Drive sync. " +
      "Local folder and browser storage still work normally.";
    cloudStatus.classList.add("storage-status-warning");
    connectDriveBtn.classList.remove("hidden");
    connectDriveBtn.textContent = "Why can't I connect?";
    disconnectDriveBtn.classList.add("hidden");
  } else {
    cloudStatus.textContent = "Not connected to Google Drive.";
    cloudStatus.classList.remove("storage-status-warning");
    connectDriveBtn.classList.remove("hidden");
    connectDriveBtn.textContent = localStorage.getItem(DRIVE_CLIENT_ID_STORAGE) ? "Reconnect Google Drive" : "Connect Google Drive";
    disconnectDriveBtn.classList.add("hidden");
  }

  const bothAvailable = usingDiskStorage && usingCloudStorage;
  syncBothRow.classList.toggle("hidden", !bothAvailable);
  if (bothAvailable) {
    const prefs = getSyncPrefs();
    syncLocalCheckbox.checked = prefs.local;
    syncCloudCheckbox.checked = prefs.cloud;
  }

  exportDriveCheckWrap.classList.toggle("hidden", !usingCloudStorage);
  if (!usingCloudStorage) exportDriveCheckbox.checked = false;
}

async function loadEntries() {
  const restored = await tryRestoreFolderConnection();

  if (restored) {
    entries = await readEntriesFromDisk();
    // First time this folder is used, it'll be empty — bring over
    // anything already sitting in browser storage so nothing is lost.
    if (entries.length === 0) {
      loadEntriesFromLocalStorage();
      if (entries.length > 0) await writeEntriesToDisk(entries);
    }
  } else {
    loadEntriesFromLocalStorage();
  }

  // MIGRATION 1: entries saved before the dual-stream (manual/AI bucket)
  // data architecture only have flat `definitions`/`images` arrays.
  let needsMigration = false;
  entries.forEach((e) => {
    if (!e.manualDefinitions && !e.aiDefinitions && !e.systemDefinitions) {
      const defs = Array.isArray(e.definitions) ? e.definitions : [];
      const imgs = Array.isArray(e.images) ? e.images : [];
      e.systemDefinitions = defs.filter((d) => bucketOf(d.source) === "system");
      e.aiDefinitions = defs.filter((d) => bucketOf(d.source) === "ai");
      e.manualDefinitions = defs.filter((d) => bucketOf(d.source) === "manual");
      e.systemImages = imgs.filter((img) => bucketOf(img.source) === "system");
      e.aiImages = imgs.filter((img) => bucketOf(img.source) === "ai");
      e.manualImages = imgs.filter((img) => bucketOf(img.source) === "manual");
      delete e.definitions;
      delete e.images;
      needsMigration = true;
    }
  });

  // MIGRATION 2: entries saved under the old dual-stream architecture
  // have `manualDefinitions`/`manualImages`, but that bucket used to mix
  // together automatic dictionary/auto-search results AND the person's
  // own typed/pasted items. Now that those are three separate streams,
  // split that old combined bucket back apart using each item's own
  // preserved `source` field (dictionary/auto vs. a real manual entry).
  entries.forEach((e) => {
    if (!e.systemDefinitions) {
      const oldManualDefs = Array.isArray(e.manualDefinitions) ? e.manualDefinitions : [];
      e.systemDefinitions = oldManualDefs.filter((d) => bucketOf(d.source) === "system");
      e.manualDefinitions = oldManualDefs.filter((d) => bucketOf(d.source) !== "system");
      needsMigration = true;
    }
    if (!e.systemImages) {
      const oldManualImgs = Array.isArray(e.manualImages) ? e.manualImages : [];
      e.systemImages = oldManualImgs.filter((img) => bucketOf(img.source) === "system");
      e.manualImages = oldManualImgs.filter((img) => bucketOf(img.source) !== "system");
      needsMigration = true;
    }
  });

  // MIGRATION 3: entries saved before page ranges existed have a single
  // `pageNo` field. Convert those to pageStart === pageEnd === pageNo so
  // every downstream consumer only ever has to deal with a range.
  entries.forEach((e) => {
    if (typeof e.pageStart !== "number" && typeof e.pageNo === "number") {
      e.pageStart = e.pageNo;
      e.pageEnd = e.pageNo;
      delete e.pageNo;
      needsMigration = true;
    }
  });

  // Backfill `seq` for entries saved before this field existed, so
  // "order first entered" stays stable even across same-millisecond
  // timestamp collisions or future re-imports. Order is derived from
  // the existing timestamp so nothing already saved gets reshuffled.
  let needsResave = needsMigration;
  if (entries.some((e) => typeof e.seq !== "number")) {
    entries
      .slice()
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .forEach((e, i) => {
        if (typeof e.seq !== "number") {
          e.seq = i;
          needsResave = true;
        }
      });
  }
  nextSeq = entries.reduce((max, e) => Math.max(max, (e.seq || 0) + 1), 0);
  if (needsResave) saveEntries();

  // Try to silently pick back up a Drive connection from a previous
  // session (no popup — see tryRestoreDriveConnection) and push this
  // device's local entries back up to Drive so it stays a mirror of
  // local, without pulling remote-only entries into local. This runs in
  // the background rather than being awaited here, so the app can render
  // immediately from local/disk data instead of waiting on Google's
  // sign-in round trip on every page load.
  syncDriveOnLoad();
}

async function syncDriveOnLoad() {
  const driveRestored = await tryRestoreDriveConnection();
  if (!driveRestored) return;
  try {
    saveEntries(); // overwrites Drive with local entries (and disk, per sync prefs) + localStorage mirror
    updateStorageStatusUI();
  } catch (err) {
    console.error("Failed to sync with Google Drive on load:", err);
  }
}

// Serialize writes to disk/Drive so two saves fired in quick succession
// (e.g. a delete immediately followed by adding a new word) can never
// finish out of order and clobber each other with a stale snapshot —
// each queued write waits for the previous one to fully settle first.
let diskSaveQueue = Promise.resolve();
function queueDiskSave(list) {
  diskSaveQueue = diskSaveQueue.then(() => writeEntriesToDisk(list));
  return diskSaveQueue;
}

let driveSaveQueue = Promise.resolve();
function queueDriveSave(list) {
  driveSaveQueue = driveSaveQueue.then(() => writeEntriesToDrive(list));
  return driveSaveQueue;
}

function saveEntries() {
  const bothAvailable = usingDiskStorage && vocabDirHandle && usingCloudStorage;
  const prefs = bothAvailable ? getSyncPrefs() : { local: true, cloud: true };

  const saveLocal = usingDiskStorage && vocabDirHandle && prefs.local;
  const saveCloud = usingCloudStorage && prefs.cloud;

  if (saveLocal) queueDiskSave(entries); // fire-and-forget; errors handled inside
  if (saveCloud) queueDriveSave(entries); // fire-and-forget; errors handled inside

  // ALWAYS keep a fresh browser-storage mirror in sync, even while a
  // folder or Drive is the primary store. This used to be skipped
  // whenever disk/cloud saving was active, which meant localStorage sat
  // frozen at whatever state existed before that folder/Drive connection
  // was made. If a page refresh then failed to silently reacquire folder
  // permission (which Chrome does not always persist across a full
  // browser restart) or a Drive token (never persisted across reloads at
  // all), loadEntries() fell back to that frozen copy — resurrecting
  // long-deleted entries and losing anything added since. Keeping this
  // mirror current at all times closes that gap for good.
  saveEntriesToLocalStorage();
}

function loadLastBookPage() {
  try {
    const raw = localStorage.getItem(LAST_BOOK_PAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveLastBookPage(book, page) {
  try {
    localStorage.setItem(LAST_BOOK_PAGE_KEY, JSON.stringify({ book, page }));
  } catch (err) {
    // non-fatal
  }
}

/* ---------------------------------------------------------------------
   SETTINGS MANAGER — reads/writes the user-configured AI connection
   (apiUrl, modelName, apiKey) as a single JSON object in localStorage.
   Any field missing/blank/corrupt falls back to AI_CONFIG's defaults, so
   the app always has a usable configuration even before the person has
   opened "AI Settings" for the first time.
--------------------------------------------------------------------- */
const SettingsManager = {
  getSettings() {
    try {
      const raw = localStorage.getItem(AI_SETTINGS_STORAGE);
      if (!raw) return { ...AI_CONFIG };
      const parsed = JSON.parse(raw);
      return {
        apiUrl: (parsed.apiUrl && parsed.apiUrl.trim()) || AI_CONFIG.apiUrl,
        modelName: (parsed.modelName && parsed.modelName.trim()) || AI_CONFIG.modelName,
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : AI_CONFIG.apiKey,
      };
    } catch (err) {
      // Corrupt/blocked storage — fall back to defaults rather than crash.
      console.warn("AI settings couldn't be read, using defaults:", err);
      return { ...AI_CONFIG };
    }
  },

  saveSettings(settings) {
    try {
      const toSave = {
        apiUrl: (settings.apiUrl && settings.apiUrl.trim()) || AI_CONFIG.apiUrl,
        modelName: (settings.modelName && settings.modelName.trim()) || AI_CONFIG.modelName,
        apiKey: (settings.apiKey || "").trim(),
      };
      localStorage.setItem(AI_SETTINGS_STORAGE, JSON.stringify(toSave));
      return true;
    } catch (err) {
      console.warn("AI settings couldn't be saved:", err);
      return false;
    }
  },

  resetSettings() {
    try {
      localStorage.removeItem(AI_SETTINGS_STORAGE);
    } catch (err) {
      // non-fatal
    }
  },
};

// Convenience wrapper used at call time throughout the AI-fetch flow —
// getSettings() always returns a complete, usable config object.
function getSettings() {
  return SettingsManager.getSettings();
}

/* ---------------------------------------------------------------------
   FETCH LIMITS — how many definitions/images a lookup returns at most,
   configurable via the ⚙️ header widget so results stay as brief or as
   generous as the person wants.
--------------------------------------------------------------------- */
function clampFetchLimit(n, fallback) {
  const num = parseInt(n, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(FETCH_LIMIT_MAX, Math.max(FETCH_LIMIT_MIN, num));
}

function getSystemDefLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(SYSTEM_DEF_LIMIT_STORAGE), DEFAULT_SYSTEM_DEF_LIMIT);
  } catch (err) {
    return DEFAULT_SYSTEM_DEF_LIMIT;
  }
}
function setSystemDefLimit(n) {
  try {
    localStorage.setItem(SYSTEM_DEF_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_SYSTEM_DEF_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

function getManualDefLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(MANUAL_DEF_LIMIT_STORAGE), DEFAULT_MANUAL_DEF_LIMIT);
  } catch (err) {
    return DEFAULT_MANUAL_DEF_LIMIT;
  }
}
function setManualDefLimit(n) {
  try {
    localStorage.setItem(MANUAL_DEF_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_MANUAL_DEF_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

function getAiDefLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(AI_DEF_LIMIT_STORAGE), DEFAULT_AI_DEF_LIMIT);
  } catch (err) {
    return DEFAULT_AI_DEF_LIMIT;
  }
}
function setAiDefLimit(n) {
  try {
    localStorage.setItem(AI_DEF_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_AI_DEF_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

function getSystemImgLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(SYSTEM_IMG_LIMIT_STORAGE), DEFAULT_SYSTEM_IMG_LIMIT);
  } catch (err) {
    return DEFAULT_SYSTEM_IMG_LIMIT;
  }
}
function setSystemImgLimit(n) {
  try {
    localStorage.setItem(SYSTEM_IMG_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_SYSTEM_IMG_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

function getManualImgLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(MANUAL_IMG_LIMIT_STORAGE), DEFAULT_MANUAL_IMG_LIMIT);
  } catch (err) {
    return DEFAULT_MANUAL_IMG_LIMIT;
  }
}
function setManualImgLimit(n) {
  try {
    localStorage.setItem(MANUAL_IMG_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_MANUAL_IMG_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

function getAiImgLimit() {
  try {
    return clampFetchLimit(localStorage.getItem(AI_IMG_LIMIT_STORAGE), DEFAULT_AI_IMG_LIMIT);
  } catch (err) {
    return DEFAULT_AI_IMG_LIMIT;
  }
}
function setAiImgLimit(n) {
  try {
    localStorage.setItem(AI_IMG_LIMIT_STORAGE, String(clampFetchLimit(n, DEFAULT_AI_IMG_LIMIT)));
  } catch (err) {
    // non-fatal
  }
}

// getFilteredData(wordEntry) — the single source of truth for how many
// system/AI/manual definitions/images a saved entry actually shows,
// applied wherever an entry is rendered or exported. wordEntry.system-
// Definitions, .aiDefinitions and .manualDefinitions (same pattern for
// images) hold ALL saved items; this slices each stream down to its
// current limit and concatenates them (system, then AI, then manual)
// for display.
function getFilteredData(wordEntry) {
  const systemDefinitions = (wordEntry.systemDefinitions || []).slice(0, getSystemDefLimit());
  const aiDefinitions = (wordEntry.aiDefinitions || []).slice(0, getAiDefLimit());
  const manualDefinitions = (wordEntry.manualDefinitions || []).slice(0, getManualDefLimit());
  const systemImages = (wordEntry.systemImages || []).slice(0, getSystemImgLimit());
  const aiImages = (wordEntry.aiImages || []).slice(0, getAiImgLimit());
  const manualImages = (wordEntry.manualImages || []).slice(0, getManualImgLimit());
  return {
    definitions: [...systemDefinitions, ...aiDefinitions, ...manualDefinitions],
    images: [...systemImages, ...aiImages, ...manualImages],
    systemDefinitions,
    aiDefinitions,
    manualDefinitions,
    systemImages,
    aiImages,
    manualImages,
  };
}

// Re-fetch the saved values fresh every time the panel opens (not just on
// first load) so it never shows stale numbers, then toggle visibility.
limitsToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (limitsPanel.classList.contains("hidden")) initFetchLimitsUI();
  limitsPanel.classList.toggle("hidden");
});

function onFetchLimitChange(input, setter, getter) {
  input.addEventListener("change", () => {
    setter(input.value);
    input.value = getter();
    // Requirement: changing a limit instantly re-renders the active
    // register below, so the person sees the item count change live.
    renderTable();
  });
}
onFetchLimitChange(systemDefLimitInput, setSystemDefLimit, getSystemDefLimit);
onFetchLimitChange(aiDefLimitInput, setAiDefLimit, getAiDefLimit);
onFetchLimitChange(manualDefLimitInput, setManualDefLimit, getManualDefLimit);
onFetchLimitChange(systemImgLimitInput, setSystemImgLimit, getSystemImgLimit);
onFetchLimitChange(aiImgLimitInput, setAiImgLimit, getAiImgLimit);
onFetchLimitChange(manualImgLimitInput, setManualImgLimit, getManualImgLimit);

function initFetchLimitsUI() {
  systemDefLimitInput.value = getSystemDefLimit();
  aiDefLimitInput.value = getAiDefLimit();
  manualDefLimitInput.value = getManualDefLimit();
  systemImgLimitInput.value = getSystemImgLimit();
  aiImgLimitInput.value = getAiImgLimit();
  manualImgLimitInput.value = getManualImgLimit();
}

/* ---------------------------------------------------------------------
   DISPLAY SIZES — search bar width, definition text size, and the size
   of fetched-image thumbnails shown for selection, configurable via the
   🔍 header widget. Applied as CSS custom properties on the root element
   so every relevant rule in style.css picks them up automatically.
--------------------------------------------------------------------- */
function clampRange(n, min, max, fallback) {
  const num = parseInt(n, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function getSearchWidth() {
  try {
    return clampRange(localStorage.getItem(SEARCH_WIDTH_STORAGE), SEARCH_WIDTH_MIN, SEARCH_WIDTH_MAX, DEFAULT_SEARCH_WIDTH);
  } catch (err) {
    return DEFAULT_SEARCH_WIDTH;
  }
}

function setSearchWidth(n) {
  try {
    localStorage.setItem(SEARCH_WIDTH_STORAGE, String(clampRange(n, SEARCH_WIDTH_MIN, SEARCH_WIDTH_MAX, DEFAULT_SEARCH_WIDTH)));
  } catch (err) {
    // non-fatal
  }
}

function getDefTextScale() {
  try {
    return clampRange(localStorage.getItem(DEF_TEXT_SCALE_STORAGE), DEF_TEXT_SCALE_MIN, DEF_TEXT_SCALE_MAX, DEFAULT_DEF_TEXT_SCALE);
  } catch (err) {
    return DEFAULT_DEF_TEXT_SCALE;
  }
}

function setDefTextScale(n) {
  try {
    localStorage.setItem(DEF_TEXT_SCALE_STORAGE, String(clampRange(n, DEF_TEXT_SCALE_MIN, DEF_TEXT_SCALE_MAX, DEFAULT_DEF_TEXT_SCALE)));
  } catch (err) {
    // non-fatal
  }
}

function getImgThumbSize() {
  try {
    return clampRange(localStorage.getItem(IMG_THUMB_SIZE_STORAGE), IMG_THUMB_SIZE_MIN, IMG_THUMB_SIZE_MAX, DEFAULT_IMG_THUMB_SIZE);
  } catch (err) {
    return DEFAULT_IMG_THUMB_SIZE;
  }
}

function setImgThumbSize(n) {
  try {
    localStorage.setItem(IMG_THUMB_SIZE_STORAGE, String(clampRange(n, IMG_THUMB_SIZE_MIN, IMG_THUMB_SIZE_MAX, DEFAULT_IMG_THUMB_SIZE)));
  } catch (err) {
    // non-fatal
  }
}

// 🫧 Liquid / Bubbly Interface — a purely cosmetic, opt-in theme layer
// (see the "body.bubbly-mode" rules in style.css) that gives buttons,
// cards, and panels a glossy, rounded, Apple-style "liquid glass" look.
// Toggled via the switch at the top of the 🔍 Display panel; persisted
// so it stays on/off across visits like every other display preference.
function getBubblyMode() {
  try {
    return localStorage.getItem(BUBBLY_MODE_STORAGE) === "true";
  } catch (err) {
    return DEFAULT_BUBBLY_MODE;
  }
}

function setBubblyMode(on) {
  try {
    localStorage.setItem(BUBBLY_MODE_STORAGE, String(!!on));
  } catch (err) {
    // non-fatal
  }
}

// 🫧 Moving bubbles — independent of the Liquid Interface master switch
// above, same relationship fish-mode has to it (see applyFishPrefs).
// Turning Liquid Interface on/off still controls the glossy button/card
// look; this only controls whether the ambient rising-bubble animation
// itself is shown, for anyone who likes the glass look but finds the
// drifting bubbles distracting (or wants the extra frame budget back).
function getBubbleMode() {
  try {
    const v = localStorage.getItem(BUBBLE_MODE_STORAGE);
    return v === null ? DEFAULT_BUBBLE_MODE : v === "true";
  } catch (err) {
    return DEFAULT_BUBBLE_MODE;
  }
}

function setBubbleMode(on) {
  try {
    localStorage.setItem(BUBBLE_MODE_STORAGE, String(!!on));
  } catch (err) {
    // non-fatal
  }
}

function applyBubbleMode() {
  const on = getBubbleMode();
  document.body.classList.toggle("bubble-mode-on", on);
  if (bubbleModeToggle) bubbleModeToggle.checked = on;
}

function applyBubblyMode() {
  const on = getBubblyMode();
  document.body.classList.toggle("bubbly-mode", on);
  if (on) {
    // All three are lazy/guarded internally — cheap to call on every
    // toggle, they only actually do work the first time this fires.
    initBubbleTilt();
    initBubbleField();
    initFishField();
  }
  applyBubbleMode();
}

// ---------- 3D pointer tilt ("pop out of the screen") ----------
// Delegated on document (rather than bound per-button) so it keeps
// working on buttons/cards created after page load without any extra
// rebinding. Only does anything while body.bubbly-mode is active and
// the pointer is over a .btn / .icon-btn / .storage-toggle-btn — see
// the matching --tilt-rx/--tilt-ry/--tilt-tz consumers in style.css.
const BUBBLE_TILT_SELECTOR = ".btn, .icon-btn, .storage-toggle-btn";
const BUBBLE_TILT_MAX_DEG = 10;
const BUBBLE_TILT_MAX_TZ = 16;
const PREFERS_REDUCED_MOTION =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let bubbleTiltInitDone = false;
let bubbleTiltActiveEl = null;

function clearBubbleTilt(el) {
  if (!el) return;
  el.style.removeProperty("--tilt-rx");
  el.style.removeProperty("--tilt-ry");
  el.style.removeProperty("--tilt-tz");
}

function initBubbleTilt() {
  if (bubbleTiltInitDone || PREFERS_REDUCED_MOTION) return;
  bubbleTiltInitDone = true;

  document.addEventListener(
    "pointermove",
    (e) => {
      if (!document.body.classList.contains("bubbly-mode")) return;
      const el = e.target.closest ? e.target.closest(BUBBLE_TILT_SELECTOR) : null;

      if (el !== bubbleTiltActiveEl) {
        clearBubbleTilt(bubbleTiltActiveEl);
        bubbleTiltActiveEl = el;
      }
      if (!el) return;

      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const py = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));

      // Tilt away from wherever the cursor sits within the control —
      // top of the bubble tilts back, bottom tilts toward you, same on
      // the left/right axis — like pressing a fingertip into a soft
      // glass sphere and having it lean away from the touch point.
      const rx = (0.5 - py) * 2 * BUBBLE_TILT_MAX_DEG;
      const ry = (px - 0.5) * 2 * BUBBLE_TILT_MAX_DEG;
      // Pops out furthest near the center, tapering toward the edges,
      // so it reads as a rounded volume bulging toward the viewer
      // rather than a flat card tipping on a hinge.
      const distFromCenter = Math.min(1, Math.hypot(px - 0.5, py - 0.5) * 2);
      const tz = BUBBLE_TILT_MAX_TZ * (1 - distFromCenter * 0.4);

      el.style.setProperty("--tilt-rx", `${rx.toFixed(2)}deg`);
      el.style.setProperty("--tilt-ry", `${ry.toFixed(2)}deg`);
      el.style.setProperty("--tilt-tz", `${tz.toFixed(1)}px`);
    },
    { passive: true }
  );

  // Covers the pointer leaving the whole window (not just sliding onto
  // another element, which the check above already handles).
  document.addEventListener("pointerleave", () => {
    clearBubbleTilt(bubbleTiltActiveEl);
    bubbleTiltActiveEl = null;
  });
}

// ---------- Ambient bubble field ----------
// Fills the empty #bubble-field overlay (see index.html) with a set of
// .bubble-particle divs that then just rise forever on the CSS
// bubble-rise-3d animation — see style.css for the visual recipe.
// Built once, lazily, the first time Liquid Interface is switched on;
// visibility after that is purely the CSS opacity toggle on
// body.bubbly-mode, so no further JS is needed to show/hide it.
const BUBBLE_FIELD_COUNT = 16;
let bubbleFieldBuilt = false;

// ---------- Bubble pop-on-touch/hover ----------
// Bubbles are decorative (pointer-events:none) EXCEPT while body.bubbly-mode
// is active — see style.css — at which point each .bubble-particle accepts
// pointer/touch so a hover or tap bursts it instantly with a liquid pop fx,
// then a fresh bubble is queued to keep the field's density steady.
function fishSpawnBubblePop(x, y, size) {
  const field = document.getElementById("bubble-field");
  if (!field) return;
  const fx = document.createElement("div");
  fx.className = "bubble-pop-fx";
  fx.style.left = `${x.toFixed(1)}px`;
  fx.style.top = `${y.toFixed(1)}px`;
  fx.style.setProperty("--pop-size", `${Math.max(size, 18).toFixed(0)}px`);
  const dropletCount = 6 + Math.floor(Math.random() * 3);
  let inner = "";
  for (let i = 0; i < dropletCount; i++) {
    const ang = (Math.PI * 2 * i) / dropletCount + Math.random() * 0.5;
    const dist = size * 0.3 + Math.random() * size * 0.35;
    inner += `<span class="bubble-droplet" style="--ddx:${(Math.cos(ang) * dist).toFixed(1)}px;--ddy:${(Math.sin(ang) * dist).toFixed(1)}px;--ddelay:${(Math.random() * 0.06).toFixed(2)}s"></span>`;
  }
  fx.innerHTML = inner;
  field.appendChild(fx);
  setTimeout(() => fx.remove(), 650);
}

function burstBubbleParticle(el) {
  if (!el || el.dataset.bursting === "1") return;
  if (!document.body.classList.contains("bubbly-mode")) return;
  el.dataset.bursting = "1";
  const rect = el.getBoundingClientRect();
  if (rect.width > 0) {
    fishSpawnBubblePop(rect.left + rect.width / 2, rect.top + rect.height / 2, rect.width);
  }
  el.classList.add("bubble-popped");
  setTimeout(() => {
    el.remove();
    spawnAmbientBubble();
  }, 130);
}

function bindBubblePopListeners(particle) {
  const trigger = () => burstBubbleParticle(particle);
  // pointerenter covers real mouse hover AND a touch that lands directly
  // on the bubble; touchstart is added on top since a fast finger swipe
  // across the field doesn't always fire pointerenter on every particle
  // it crosses.
  particle.addEventListener("pointerenter", trigger);
  particle.addEventListener("touchstart", trigger, { passive: true });
}

function createBubbleParticle(withNegativeDelay) {
  const particle = document.createElement("div");
  particle.className = "bubble-particle";
  const size = 14 + Math.random() * 46; // 14–60px
  const left = Math.random() * 100; // vw %
  const duration = 10 + Math.random() * 10; // 10–20s to cross the screen
  // Negative delay starts each bubble partway through its own rise
  // so the field looks already-in-motion on the very first frame,
  // instead of every bubble launching together from the bottom.
  const delay = withNegativeDelay ? -Math.random() * duration : 0;
  const opacity = 0.25 + Math.random() * 0.4;
  particle.style.setProperty("--bsize", `${size.toFixed(0)}px`);
  particle.style.setProperty("--bx", `${left.toFixed(1)}%`);
  particle.style.setProperty("--bdur", `${duration.toFixed(1)}s`);
  particle.style.setProperty("--bdelay", `${delay.toFixed(1)}s`);
  particle.style.setProperty("--bopacity", opacity.toFixed(2));
  bindBubblePopListeners(particle);
  return particle;
}

function spawnAmbientBubble() {
  const field = document.getElementById("bubble-field");
  if (!field || !bubbleFieldBuilt) return;
  field.appendChild(createBubbleParticle(false));
}

function initBubbleField() {
  if (bubbleFieldBuilt) return;
  const field = document.getElementById("bubble-field");
  if (!field) return;
  bubbleFieldBuilt = true;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < BUBBLE_FIELD_COUNT; i++) {
    frag.appendChild(createBubbleParticle(true));
  }
  field.appendChild(frag);
}

// ---------- 🐠 Liquid Interface Marine Ecosystem (Delta-Time Physics) ----------
// JS-driven vector physics replaces CSS swim animations. Fish react to
// bubbles, mouse, sharks; sharks hunt with steering AI. See style.css.
const FISH_SVG_VIEWBOX = "-10 -10 120 80";
const FISH_SPECIES_MARKUP = {
  clownfish: `
    <defs>
      <linearGradient id="clownfish-fin-sss" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#ffb066" stop-opacity="0.35"/>
        <stop offset="55%" stop-color="#ff7a30" stop-opacity="0.72"/>
        <stop offset="100%" stop-color="#e85f1c" stop-opacity="0.92"/>
      </linearGradient>
      <radialGradient id="clownfish-body-shade" cx="42%" cy="32%" r="75%">
        <stop offset="0%" stop-color="#ffa054"/>
        <stop offset="60%" stop-color="#ff7a30"/>
        <stop offset="100%" stop-color="#e2611c"/>
      </radialGradient>
    </defs>
    <path class="fish-fin-ray" d="M67,44 C71,50 70,55 65,56 C61,54 60,47 63,43 Z" fill="url(#clownfish-fin-sss)" stroke="#c85a1c" stroke-width="0.5" opacity="0.85"/>
    <path class="fish-fin-ray" d="M78,42 C81,47 80,51 76,52 C73,50 72,45 75,41 Z" fill="url(#clownfish-fin-sss)" stroke="#c85a1c" stroke-width="0.45" opacity="0.8"/>
    <path class="fish-tail" d="M28,30 C19,17 6,12 3,17 C1,21 1,39 3,43 C6,48 19,43 28,30 Z" fill="url(#clownfish-fin-sss)" stroke="#c1531a" stroke-width="0.8"/>
    <path class="fish-fin-ray" d="M22,30 Q10,22 5,19 M23,30 Q9,30 4,30 M22,30 Q10,38 5,41" fill="none" stroke="#a8441a" stroke-width="0.55" opacity="0.6"/>
    <path d="M36,11 L41,-6 L46,9 L52,-8 L57,9 L62,-7 L67,9 Q75,-1 82,13 Q71,15 60,14 Q48,15 36,11 Z" fill="url(#clownfish-fin-sss)" stroke="#c1531a" stroke-width="0.6" opacity="0.92"/>
    <path class="fish-fin-ray" d="M41,10 L41,-4 M46,9 L46,-6 M52,9 L52,-6 M57,9 L57,-5 M62,9 L62,-4 M67,10 Q73,4 79,11" fill="none" stroke="#a8441a" stroke-width="0.45" opacity="0.55"/>
    <path class="fish-body" d="M28,32 C26,20 36,8 56,7 C74,6 89,13 91,23 C92,27 92,33 91,37 C88,46 73,53 55,52 C36,52 26,44 28,32 Z" fill="url(#clownfish-body-shade)" stroke="#d2560f" stroke-width="0.6"/>
    <path d="M36,13 Q45,30 36,49 L45,49 Q54,30 45,13 Z" fill="#fff" stroke="#221b16" stroke-width="1.5"/>
    <path d="M53,9 Q61,30 53,52 L61,52 Q69,30 61,9 Z" fill="#fff" stroke="#221b16" stroke-width="1.5"/>
    <path d="M65,9 Q72,25 66,44 L74,44 Q80,25 72,9 Z" fill="#fff" stroke="#221b16" stroke-width="1.5"/>
    <path d="M89,26 Q94,30 89,34 Q86,30 89,26 Z" fill="#ff7a30" stroke="#d2560f" stroke-width="0.5"/>
    <path class="fish-gill-cover" d="M79,16 Q84,25 79,40" fill="none" stroke="#c1531a" stroke-width="1.1" opacity="0.5" stroke-linecap="round"/>
    <circle class="fish-eye-white" cx="87" cy="23" r="5.2" fill="#fff"/>
    <circle class="fish-pupil" cx="89" cy="23" r="2.6" fill="#241a14"/>
    <circle class="fish-eye-glint" cx="86.5" cy="21.2" r="1" fill="#fff" opacity="0.85"/>
  `,
  betta: `
    <path class="fish-tail fish-fin-wave" d="M25,30 C8,8 -8,10 -8,30 C-8,50 8,52 25,30 Z" fill="#5b6cff" opacity="0.85"/>
    <path class="fish-fin-ray" d="M18,30 Q2,20 -5,15 M18,30 Q0,30 -7,30 M18,30 Q2,40 -5,45" fill="none" stroke="#2b3aa8" stroke-width="0.5" opacity="0.5"/>
    <ellipse class="fish-body" cx="58" cy="30" rx="26" ry="14" fill="#3346c9"/>
    <path class="fish-fin-wave betta-fin-top" d="M40,16 C29,3 18,4 14,14 C25,20 35,20 40,16 Z" fill="#5b6cff" opacity="0.8"/>
    <path class="fish-fin-wave betta-fin-bot" d="M40,44 C29,57 18,56 14,46 C25,40 35,40 40,44 Z" fill="#5b6cff" opacity="0.8"/>
    <path class="fish-gill-cover" d="M72,20 Q76,26 72,40" fill="none" stroke="#212e8f" stroke-width="1" opacity="0.55" stroke-linecap="round"/>
    <circle class="fish-eye-white" cx="78" cy="26" r="5" fill="#fff"/>
    <circle class="fish-pupil" cx="80" cy="26" r="2.4" fill="#151b3d"/>
    <circle class="fish-eye-glint" cx="77.5" cy="24.3" r="1" fill="#fff" opacity="0.85"/>
  `,
  angelfish: `
    <path class="fish-tail" d="M22,30 L4,20 L4,40 Z" fill="#dfe6ee"/>
    <path class="fish-fin-ray" d="M16,24 L5,22 M16,30 L4,30 M16,36 L5,38" fill="none" stroke="#94a3b8" stroke-width="0.5" opacity="0.6"/>
    <path class="fish-body" d="M55,6 C75,10 78,30 75,30 C78,30 75,50 55,54 C40,50 30,40 30,30 C30,20 40,10 55,6 Z" fill="#e7edf3" stroke="#94a3b8" stroke-width="1"/>
    <rect x="48" y="8" width="6" height="44" fill="#2b3444" opacity="0.85"/>
    <path d="M52,5 L58,-6 L60,7 Z" fill="#dfe6ee"/>
    <path d="M52,55 L58,66 L60,53 Z" fill="#dfe6ee"/>
    <path class="fish-gill-cover" d="M62,14 Q66,30 62,46" fill="none" stroke="#94a3b8" stroke-width="1" opacity="0.55" stroke-linecap="round"/>
    <circle class="fish-eye-white" cx="72" cy="24" r="5" fill="#fff"/>
    <circle class="fish-pupil" cx="74" cy="24" r="2.4" fill="#1b2230"/>
    <circle class="fish-eye-glint" cx="71.5" cy="22.3" r="1" fill="#fff" opacity="0.85"/>
  `,
  // Guppy markup is generated per-instance (sex, tail shape, chromatophore
  // pattern, and colorway are all randomized at spawn — see fishSpawnPrey
  // and fishBuildGuppyMarkup below) rather than a single fixed string like
  // every other species here, so this is a function reference: fishCreateDOM
  // detects that and calls it with the fish object instead of using it as
  // a literal template.
  guppy: fishBuildGuppyMarkup,
  pufferfish: `
    <path class="fish-tail fish-fin-rotate" d="M28,30 L12,20 L12,40 Z" fill="#ffd23f"/>
    <circle class="fish-body" cx="55" cy="30" r="26" fill="#ffd23f"/>
    <circle cx="43" cy="8" r="2.2" fill="#f2b705"/>
    <circle cx="61" cy="4" r="2.2" fill="#f2b705"/>
    <circle cx="29" cy="18" r="2.2" fill="#f2b705"/>
    <circle cx="27" cy="42" r="2.2" fill="#f2b705"/>
    <circle cx="43" cy="54" r="2.2" fill="#f2b705"/>
    <circle cx="63" cy="56" r="2.2" fill="#f2b705"/>
    <path class="fish-gill-cover" d="M70,18 Q74,24 70,30" fill="none" stroke="#d99b04" stroke-width="1" opacity="0.5" stroke-linecap="round"/>
    <circle class="fish-eye-white" cx="72" cy="24" r="6" fill="#fff"/>
    <circle class="fish-pupil" cx="74" cy="24" r="3" fill="#241a14"/>
    <circle class="fish-eye-glint" cx="71.5" cy="21.7" r="1.2" fill="#fff" opacity="0.85"/>
  `,
};

/* =========================================================================
   🌈 GUPPY ANATOMY & SOFT-BODY FIN SYSTEM
   ---------------------------------------------------------------------
   Everything below builds ONE guppy's markup at spawn time (never per
   frame — this is pure string/geometry assembly, run once in
   fishSpawnPrey -> fishCreateDOM). The per-frame motion this sets up for
   is handled entirely by fishRenderGuppyExtras (see the swim-phase /
   fishRenderEntity section below), which only ever writes plain
   transform/filter strings onto the handful of elements cached here —
   no DOM structure changes after creation, so it's exactly as cheap per
   frame as every other species' tail-wag/body-flex.

   Part 1 (anatomy): fishGuppyPickTraits assigns sex + tail shape + size
   at spawn. Males get a small, slender body and one of three exaggerated
   ornamental tail shapes (GUPPY_TAIL_GEOMETRY); females get a larger,
   rounded, gravid body with a dark gravid spot and small clear fins.

   Part 2 (color): GUPPY_COLORWAYS holds the neon blue/red/yellow-green
   triads; GUPPY_PATTERN_DEFS builds the actual cobra/tuxedo/mosaic
   texture per fish (as real SVG gradients/patterns, unique-ID'd per fish
   instance the same way SHARK_VARIANT_SILHOUETTE already does with
   `${id}`, so multiple guppies never collide). Fin edges use an
   alpha-blended gradient (see GUPPY_FIN_SSS) for the light-permeating
   membrane look.

   Part 3 (soft-body tail): the male tail is NOT one rigid triangle. It's
   built as a shared-pivot fan — one soft "membrane" backing (a normal
   .fish-tail, so it gets the existing whole-fin wag for free) plus 4
   independently-animatable .guppy-tail-panel wedges layered on top. Each
   panel's own transform-origin is computed here (in %, against that
   panel's own fill-box — same trick every other fin in this file already
   relies on) so that, despite being 4 separate elements, they all rotate
   around the *same* physical peduncle point. fishRenderGuppyExtras then
   drives each panel with a phase-lagged, amplitude-growing sine (a cheap
   stand-in for a spring-mass cloth solver: lag ~= inertia dragging behind
   the body's beat, growing amplitude ~= a whip tip swinging wider than
   its base) plus a faster secondary ripple — see that function for the
   actual per-frame math.
--------------------------------------------------------------------- */
const GUPPY_TAIL_PIVOT = { x: 24, y: 30 };
const GUPPY_TAIL_VARIANTS = ["delta", "veiltail", "lyretail"];
// Five fin-ray angles/lengths per variant (degrees off the horizontal,
// measured swinging away from the body; positive = downward) -> 4 panels
// between consecutive rays. Delta flares wide and even; veiltail droops
// long and asymmetric; lyretail forks hard with a short/thin middle.
const GUPPY_TAIL_GEOMETRY = {
  delta: { angles: [-40, -18, 0, 18, 40], lengths: [26, 32, 34, 32, 26], bulge: 7 },
  veiltail: { angles: [-26, -9, 5, 19, 34], lengths: [30, 39, 44, 41, 33], bulge: 9 },
  lyretail: { angles: [-47, -31, 0, 31, 47], lengths: [35, 22, 8, 22, 35], bulge: 5 },
};
// Neon triads (blue / fiery red / yellow-green) a male's chromatophores
// are built from — GUPPY_PATTERN_DEFS below lays these into the actual
// cobra/tuxedo/mosaic texture per fish.
const GUPPY_COLORWAYS = [
  { blue: "#2fd9ff", red: "#ff2f5e", yellowGreen: "#d4ff3a", deep: "#12183a" },
  { blue: "#3d6bff", red: "#ff5a3d", yellowGreen: "#baff5e", deep: "#151033" },
  { blue: "#22e0c8", red: "#ff3d8a", yellowGreen: "#eaff6e", deep: "#0f1a2e" },
  { blue: "#4fa8ff", red: "#ff4d4d", yellowGreen: "#9dff3a", deep: "#181228" },
];

function fishGuppyFanPoints(pivot, angles, lengths) {
  return angles.map((a, i) => {
    const rad = (a * Math.PI) / 180;
    const len = lengths[i];
    return { x: pivot.x - Math.cos(rad) * len, y: pivot.y + Math.sin(rad) * len };
  });
}

// Backing membrane: a single continuous shape threaded through every fin-
// ray tip (Q-curved so the outer edge bows outward, away from the body).
// This keeps class="fish-tail" so it inherits the ordinary whole-fin wag
// every other species already gets for free — the panels above it (see
// fishGuppyTailPanelsMarkup) carry the extra cloth-lag/ripple motion.
function fishGuppyMembranePath(pivot, tips, bulge) {
  let d = `M${pivot.x},${pivot.y} L${tips[0].x.toFixed(1)},${tips[0].y.toFixed(1)} `;
  for (let i = 0; i < tips.length - 1; i++) {
    const mx = (tips[i].x + tips[i + 1].x) / 2 - bulge;
    const my = (tips[i].y + tips[i + 1].y) / 2;
    d += `Q${mx.toFixed(1)},${my.toFixed(1)} ${tips[i + 1].x.toFixed(1)},${tips[i + 1].y.toFixed(1)} `;
  }
  d += "Z";
  return d;
}

// The 4 independent cloth wedges. Each one computes its own fill-box
// origin (in %) so that, even though every panel has a different bbox,
// rotating each around "its own" origin still reads as rotation around
// the single shared peduncle point at GUPPY_TAIL_PIVOT — same technique
// .fish-tail/.shark-tail-seg already use, just computed per-panel instead
// of hand-picked, since these shapes are procedurally generated.
function fishGuppyTailPanelsMarkup(pivot, tips, bulge, fillUrl, strokeColor) {
  let out = "";
  for (let i = 0; i < tips.length - 1; i++) {
    const a = tips[i];
    const b = tips[i + 1];
    const mx = (a.x + b.x) / 2 - bulge;
    const my = (a.y + b.y) / 2;
    const minX = Math.min(pivot.x, a.x, b.x, mx);
    const maxX = Math.max(pivot.x, a.x, b.x, mx);
    const minY = Math.min(pivot.y, a.y, b.y, my);
    const maxY = Math.max(pivot.y, a.y, b.y, my);
    const ox = ((pivot.x - minX) / Math.max(maxX - minX, 0.001)) * 100;
    const oy = ((pivot.y - minY) / Math.max(maxY - minY, 0.001)) * 100;
    const d = `M${pivot.x},${pivot.y} L${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)} Z`;
    out += `<path class="guppy-tail-panel" data-panel="${i}" style="transform-origin:${ox.toFixed(1)}% ${oy.toFixed(1)}%" d="${d}" fill="${fillUrl}" stroke="${strokeColor}" stroke-width="0.4" stroke-opacity="0.35"/>`;
  }
  return out;
}

// Part 2: chromatophore/iridescent defs, unique-ID'd per fish instance
// (uid = fish.id, same convention SHARK_VARIANT_SILHOUETTE uses) so many
// guppies on screen at once never share (and fight over) a gradient/
// pattern id.
function fishGuppyDefs(uid, colorway, pattern, sex) {
  const fade = sex === "female" ? 0.55 : 1; // females: same family, muted
  let patternDef = "";
  if (pattern === "cobra") {
    patternDef = `
      <pattern id="guppy-pat-${uid}" width="7" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
        <rect width="7" height="5" fill="transparent"/>
        <ellipse cx="2" cy="2.5" rx="1.6" ry="0.9" fill="${colorway.deep}" opacity="${0.7 * fade}"/>
        <ellipse cx="5.5" cy="0.5" rx="1.3" ry="0.7" fill="${colorway.deep}" opacity="${0.55 * fade}"/>
      </pattern>`;
  } else if (pattern === "mosaic") {
    patternDef = `
      <pattern id="guppy-pat-${uid}" width="9" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-6)">
        <rect width="9" height="7" fill="transparent"/>
        <circle cx="2" cy="2" r="1.7" fill="${colorway.red}" opacity="${0.6 * fade}"/>
        <circle cx="6.5" cy="1.5" r="1.4" fill="${colorway.blue}" opacity="${0.6 * fade}"/>
        <circle cx="4" cy="5" r="1.6" fill="${colorway.yellowGreen}" opacity="${0.55 * fade}"/>
      </pattern>`;
  }
  // Tuxedo needs no <pattern> — it's a plain half-black gradient below.
  return `
    <defs>
      <linearGradient id="guppy-body-${uid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${colorway.blue}" stop-opacity="${0.95 * fade}"/>
        <stop offset="45%" stop-color="${colorway.yellowGreen}" stop-opacity="${0.85 * fade}"/>
        <stop offset="${pattern === "tuxedo" ? "62%" : "100%"}" stop-color="${colorway.red}" stop-opacity="${0.9 * fade}"/>
        ${pattern === "tuxedo" ? `<stop offset="100%" stop-color="${colorway.deep}" stop-opacity="${0.97}"/>` : ""}
      </linearGradient>
      <radialGradient id="guppy-irid-${uid}" cx="35%" cy="30%" r="80%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
        <stop offset="35%" stop-color="${colorway.blue}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${colorway.red}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="guppy-fin-sss-${uid}" x1="1" y1="0" x2="0" y2="0">
        <stop offset="0%" stop-color="${colorway.blue}" stop-opacity="${0.85 * fade}"/>
        <stop offset="55%" stop-color="${colorway.red}" stop-opacity="${0.55 * fade}"/>
        <stop offset="100%" stop-color="${colorway.yellowGreen}" stop-opacity="${0.12 * fade}"/>
      </linearGradient>
      ${patternDef}
    </defs>`;
}

// Assigns the per-instance traits a spawned guppy needs before its DOM/
// markup is built. Called once from fishSpawnPrey (Part 1: sexual
// dimorphism — roughly even split; Part 2: pattern/colorway variety).
function fishGuppyPickTraits(fish) {
  fish.sex = Math.random() < 0.52 ? "male" : "female";
  fish.tailVariant = GUPPY_TAIL_VARIANTS[Math.floor(Math.random() * GUPPY_TAIL_VARIANTS.length)];
  fish.pattern = ["cobra", "tuxedo", "mosaic"][Math.floor(Math.random() * 3)];
  fish.colorway = GUPPY_COLORWAYS[Math.floor(Math.random() * GUPPY_COLORWAYS.length)];
  fish.hueSeed = fishRand(0, 360);
  fish.pecPhase = fishRand(0, TWO_PI);
  // Part 1: males stay small/slender (~3cm-scale read); females are
  // noticeably larger and rounder (~5-6cm-scale read) — overrides the
  // generic FISH_SIZE_RANGES roll already done in fishSpawnPrey.
  fish.size = fish.sex === "male" ? fishRand(27, 35) : fishRand(40, 50);
}

function fishBuildGuppyMarkup(fish) {
  const uid = fish.id;
  const c = fish.colorway || GUPPY_COLORWAYS[0];
  const defs = fishGuppyDefs(uid, c, fish.pattern, fish.sex);
  const bodyFill = `url(#guppy-body-${uid})`;
  const patternFill = fish.pattern === "tuxedo" ? null : `url(#guppy-pat-${uid})`;
  const finFill = `url(#guppy-fin-sss-${uid})`;

  if (fish.sex === "female") {
    // Part 1: larger, robust, gravid body profile with the characteristic
    // dark gravid spot near the anal fin; Part 2: same colorway family as
    // males but muted (see `fade` in fishGuppyDefs), with much smaller,
    // rounded, near-transparent dorsal/caudal fins — no ornamental tail
    // rig, so it just uses the plain generic .fish-tail wag every other
    // species gets.
    return `
      ${defs}
      <path class="fish-tail" d="M20,30 C10,20 2,18 -2,24 C-4,30 -4,32 -2,37 C2,42 10,39 20,30 Z" fill="${finFill}" opacity="0.75"/>
      <ellipse class="fish-body" cx="56" cy="30" rx="25" ry="14" fill="${bodyFill}" stroke="${c.deep}" stroke-width="0.5" stroke-opacity="0.3"/>
      ${patternFill ? `<ellipse cx="56" cy="30" rx="25" ry="14" fill="${patternFill}"/>` : ""}
      <ellipse cx="56" cy="30" rx="25" ry="14" fill="url(#guppy-irid-${uid})" class="guppy-shine"/>
      <!-- gravid spot: darkened patch near the anal fin marking a pregnant female -->
      <ellipse cx="46" cy="39" rx="6" ry="4.5" fill="${c.deep}" opacity="0.55"/>
      <path class="guppy-dorsal" d="M46,17 C42,9 46,4 54,5 C58,9 56,15 50,18 Z" fill="${finFill}" opacity="0.55"/>
      <path class="guppy-pectoral" style="transform-origin:80% 30%" d="M64,34 C68,38 68,42 63,42 C60,40 59,36 64,34 Z" fill="${finFill}" opacity="0.6"/>
      <path class="fish-gill-cover" d="M70,22 Q74,30 70,38" fill="none" stroke="${c.deep}" stroke-width="0.9" opacity="0.4" stroke-linecap="round"/>
      <circle class="fish-eye-white" cx="76" cy="27" r="4.6" fill="#fff"/>
      <circle class="fish-pupil" cx="77.6" cy="27" r="2.3" fill="#241a14"/>
      <circle class="fish-eye-glint" cx="75.3" cy="25.5" r="0.9" fill="#fff" opacity="0.85"/>
    `;
  }

  // Male: small slender forward body, abrupt transition into the
  // exaggerated peduncle/tail rig built above.
  const geo = GUPPY_TAIL_GEOMETRY[fish.tailVariant] || GUPPY_TAIL_GEOMETRY.delta;
  const tips = fishGuppyFanPoints(GUPPY_TAIL_PIVOT, geo.angles, geo.lengths);
  const membrane = fishGuppyMembranePath(GUPPY_TAIL_PIVOT, tips, geo.bulge);
  const panels = fishGuppyTailPanelsMarkup(GUPPY_TAIL_PIVOT, tips, geo.bulge, finFill, c.deep);

  return `
    ${defs}
    <path class="fish-tail" d="${membrane}" fill="${finFill}" opacity="0.5" stroke="${c.deep}" stroke-width="0.4" stroke-opacity="0.3"/>
    ${panels}
    <path class="guppy-peduncle" d="M40,25 C33,26 27,28 24,30 C27,32 33,34 40,35 Z" fill="${bodyFill}"/>
    <ellipse class="fish-body" cx="60" cy="30" rx="19" ry="7.5" fill="${bodyFill}" stroke="${c.deep}" stroke-width="0.5" stroke-opacity="0.35"/>
    ${patternFill ? `<ellipse cx="60" cy="30" rx="19" ry="7.5" fill="${patternFill}"/>` : ""}
    <ellipse cx="60" cy="30" rx="19" ry="7.5" fill="url(#guppy-irid-${uid})" class="guppy-shine"/>
    <!-- elongated sweeping dorsal ribbon: trails/flutters independently, see fishRenderGuppyExtras -->
    <path class="guppy-dorsal-ribbon" style="transform-origin:88% 100%" d="M55,20 C48,4 36,-6 26,-4 C34,4 42,14 50,22 Z" fill="${finFill}" opacity="0.7" stroke="${c.deep}" stroke-width="0.35" stroke-opacity="0.3"/>
    <path class="guppy-pectoral" style="transform-origin:85% 25%" d="M70,33 C75,37 75,42 69,42 C65,40 64,35 70,33 Z" fill="${finFill}" opacity="0.65"/>
    <path class="fish-gill-cover" d="M76,24 Q79,30 76,36" fill="none" stroke="${c.deep}" stroke-width="0.8" opacity="0.45" stroke-linecap="round"/>
    <circle class="fish-eye-white" cx="80" cy="27" r="3.6" fill="#fff"/>
    <circle class="fish-pupil" cx="81.3" cy="27" r="1.8" fill="#241a14"/>
    <circle class="fish-eye-glint" cx="79.4" cy="25.9" r="0.7" fill="#fff" opacity="0.85"/>
  `;
}

// NOTE: sharks are no longer a single fixed-color entry in
// FISH_SPECIES_MARKUP (that object closed earlier, right after the guppy
// builder above) — see "Shark color variants & species management" right
// below for SHARK_VARIANTS / SHARK_VARIANT_MARKUP and how fishCreateDOM
// picks the right markup per shark instance.

/* ---------------------------------------------------------------------
   🦈 SHARK COLOR VARIANTS & SPECIES-VARIANT MANAGEMENT (Part 4)
   ---------------------------------------------------------------------
   Each variant is a full color palette (+ optional body pattern) applied
   to the same shark silhouette used previously. Adding a new variant is a
   single new entry below — nothing else in the engine needs to change:
   fishSpawnShark() already picks randomly among whichever variants are
   enabled, fishCreateDOM() already renders whatever SHARK_VARIANT_MARKUP
   resolves to, and the Display panel checkboxes are generated from
   SHARK_VARIANT_IDS (see index.html + the shark-variant-controls wiring
   below), so the UI never needs hand-written per-variant markup either.
--------------------------------------------------------------------- */
const SHARK_VARIANTS = {
  reef: {
    label: "Grey Reef",
    swatch: "🔵",
    // Realistic grey-reef-shark countershading: deep slate/charcoal dorsal
    // tones diving smoothly into an off-white cream belly (Part 2). No
    // fin pattern — a plain countershaded profile.
    colors: {
      tailBack: "#2E3944", tailFront: "#4B5A67", body: "#5E6E7C", belly: "#EDE8DC",
      fin: "#3A4753", dorsal: "#333F4A", dorsal2: "#333F4A",
      gillStroke: "#20272E", browStroke: "#232B32", mouthStroke: "#1B2126",
      accent: "#1B2126", pupil: "#0A0C0E",
    },
    pattern: null,
  },
  tiger: {
    label: "Tiger",
    swatch: "🟤",
    // Warm brownish-grey countershading with the vertical flank
    // striping juvenile tiger sharks are known for (Part 2 imperfections).
    colors: {
      tailBack: "#4A4030", tailFront: "#6B5F49", body: "#8A7C61", belly: "#F1E9D4",
      fin: "#5A4F3C", dorsal: "#453B2C", dorsal2: "#453B2C",
      gillStroke: "#2E271C", browStroke: "#33291D", mouthStroke: "#241D14",
      accent: "#241D14", pupil: "#120D08",
    },
    pattern: "stripes",
  },
  shadow: {
    label: "Blacktip",
    swatch: "⚫",
    // Cool indigo-black countershading with the ink-dipped fin tips of a
    // blacktip reef shark marking pectoral/dorsal/caudal edges.
    colors: {
      tailBack: "#1B2233", tailFront: "#333E52", body: "#404D63", belly: "#E7E9EE",
      fin: "#2A3242", dorsal: "#1E2534", dorsal2: "#1E2534",
      gillStroke: "#12161F", browStroke: "#171D28", mouthStroke: "#0E1117",
      accent: "#090B0F", pupil: "#060708",
    },
    pattern: "blacktips",
  },
};
// Per-variant gradient + sheen defs (Part 5: Dynamic Skin Texturing &
// Countershading). Each variant gets its own ids so the pastel-top → pink/
// cream-belly blend and the soft specular sheen use that variant's exact
// palette rather than a one-size-fits-all gradient. Defs are inlined into
// every spawned shark's own SVG markup (see buildSharkVariantMarkup) —
// duplicate ids across simultaneously-visible sharks of the same variant
// are harmless since each duplicate resolves to an identical definition.
const SHARK_VARIANT_DEFS = (id, c) => `
    <defs>
      <linearGradient id="shark-body-grad-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c.tailBack}"/>
        <stop offset="38%" stop-color="${c.body}"/>
        <stop offset="80%" stop-color="${c.belly}"/>
        <stop offset="100%" stop-color="${c.belly}"/>
      </linearGradient>
      <linearGradient id="shark-belly-grad-${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c.belly}" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="${c.belly}" stop-opacity="0.98"/>
      </linearGradient>
      <!-- Softened from a glossy highlight down to a low, matte gleam — real
           shark skin scatters light off dermal denticles rather than
           reflecting it like a plastic toy, so the old wide/bright specular
           blob is dimmer and tighter here. -->
      <radialGradient id="shark-sheen-grad-${id}" cx="28%" cy="10%" r="55%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/>
        <stop offset="60%" stop-color="#ffffff" stop-opacity="0.06"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
      <!-- Part 2: dermal-denticle texture. High-frequency feTurbulence
           stands in for the microscopic placoid-scale normal map — too
           fine to read as individual scales at this size, but it breaks
           up the flat gradient fill into a matte, slightly granular
           surface instead of a smooth plastic sheen. Composited back over
           itself with feDiffuseLighting so the grain actually catches
           light directionally rather than just being flat noise. -->
      <!-- Combined into one filter (denticle grain + procedural scarring)
           so it can be applied with a single filter="" reference on
           .shark-body: fine high-frequency turbulence for the matte
           scale texture, plus coarse low-octave turbulence thresholded
           down to a handful of faint streaks for scattered scarring/
           tone variation, both clipped to the body's own alpha so
           neither ever spills outside the silhouette. -->
      <filter id="shark-texture-${id}" x="-15%" y="-15%" width="130%" height="130%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9 1.4" numOctaves="2" seed="${(id.length * 7) % 97}" result="grain"/>
        <feDiffuseLighting in="grain" lighting-color="#ffffff" surfaceScale="1.1" diffuseConstant="1" result="lit">
          <feDistantLight azimuth="235" elevation="55"/>
        </feDiffuseLighting>
        <feColorMatrix in="lit" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.28 0.28 0.28 0 0" result="grainAlpha"/>
        <feComposite in="grainAlpha" in2="SourceAlpha" operator="in" result="grainClipped"/>
        <feTurbulence type="turbulence" baseFrequency="0.015 0.12" numOctaves="2" seed="${(id.length * 13 + 3) % 97}" result="scarNoise"/>
        <feColorMatrix in="scarNoise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 9 -7.6" result="scarMask"/>
        <feComposite in="scarMask" in2="SourceAlpha" operator="in" result="scarClipped"/>
        <feFlood flood-color="${c.tailBack}" flood-opacity="0.45" result="scarColor"/>
        <feComposite in="scarColor" in2="scarClipped" operator="in" result="scarFinal"/>
        <feMerge>
          <feMergeNode in="SourceGraphic"/>
          <feMergeNode in="grainClipped"/>
          <feMergeNode in="scarFinal"/>
        </feMerge>
      </filter>
    </defs>
`;
// Realistic anatomical redesign (Part 1/2/3): a sleek, tapered fusiform
// hull with an extended heterocercal caudal fin (big raked upper lobe,
// small lower lobe), a rigid triangular pectoral, a tall raked dorsal,
// matte denticle-textured countershading, and small dark predator eyes
// with a nictitating membrane — replacing the earlier round, chubby
// plush-toy proportions. Every class name below is unchanged on purpose:
// SharkPhysicsEngine/CSS key off .shark-spine-tail, .shark-tail-seg (x2,
// in order), .shark-pectoral, .shark-body/.shark-belly/.shark-sheen,
// .shark-mouth-open/.shark-mouth-closed/.shark-teeth-closed and
// .shark-brow-rest/.shark-brow-hunt for the hunting-state swap — so all
// tail-wag, spine-bend, fin-flap and expression-swap animation keeps
// working untouched even though the geometry underneath is all new.
// Two new wrapper groups drive the added motion: .shark-torso-flex (a
// gentle traveling flex just ahead of the neck joint, so the lateral
// sine wave visibly starts near the head instead of only appearing at
// the tail — see fishRenderEntity) and .shark-dorsal-flex (a soft
// trailing-edge flutter on the dorsal fin tip, the caudal fin's own
// trailing-edge motion already coming from .shark-tail-seg).
const SHARK_VARIANT_SILHOUETTE = (c, id) => `
    ${SHARK_VARIANT_DEFS(id, c)}
    <g class="shark-spine-tail">
      <!-- Heterocercal caudal fin: a long, raked, pointed upper lobe carrying
           most of the thrust, and a much smaller lower lobe — the shape that
           separates a shark's tail from prey fish's symmetric fin. Kept
           within the app's fixed viewBox (-10 -10 120 80, see
           FISH_SVG_VIEWBOX) — overflow:visible tolerates a little spill but
           not a lobe reaching halfway across the canvas. -->
      <path class="fish-tail shark-tail-seg" d="M14,25 C1,16 -13,6 -21,10 C-23,14 -18,20 -6,25 C2,27.5 9,27.8 14,25 Z" fill="${c.tailBack}" stroke="${c.tailBack}" stroke-width="0.6"/>
      <path class="fish-tail shark-tail-seg" d="M14,27 C6,33 -6,36 -12,32 C-13,29 -3,27.5 14,27 Z" fill="${c.tailFront}" opacity="0.95"/>
      <!-- trailing-edge notch hints on each lobe -->
      <path class="shark-tail-notch" d="M-17,13 Q-7,18.5 6,24" fill="none" stroke="${c.tailFront}" stroke-width="0.7" opacity="0.45" stroke-linecap="round"/>
      <path class="shark-tail-notch" d="M-11,30.5 Q-3,30 6,28" fill="none" stroke="${c.tailBack}" stroke-width="0.6" opacity="0.4" stroke-linecap="round"/>
    </g>
    <!-- Torso: everything forward of the tail assembly gets a gentle, phase-
         lagged flex (see fishRenderEntity) so the lateral traveling wave
         reads as starting near the head rather than only appearing at the
         neck joint — an approximation of a continuous head-to-peduncle
         wave riding on top of the discrete spine/tail-segment chain. -->
    <g class="shark-torso-flex">
      <!-- Body: sleek fusiform hull — tapers sharply from a rounded girth
           amidships to a pointed conical snout, replacing the previous
           blunt, round-foreheaded profile. -->
      <path class="shark-body" d="M20,25 C19,14 32,3 50,0.5 C68,-2 88,1.5 101,10 C107,14 111,18.5 110,23 C109,27.5 102,32.5 90,37 C71,43.5 44,44.5 28,38 C20,34.5 16.5,29.5 20,25 Z" fill="url(#shark-body-grad-${id})" filter="url(#shark-texture-${id})" stroke="${c.tailBack}" stroke-width="0.5" stroke-opacity="0.35"/>
      <path class="shark-belly" d="M24,31 C30,39 46,43.5 62,43.5 C78,43 92,38.5 100,32 C91,38 76,40.7 62,40.4 C47,40.1 30,35.8 24,31 Z" fill="url(#shark-belly-grad-${id})"/>
      <!-- lateral line: the faint sensory-line stripe running head-to-tail -->
      <path class="shark-lateral-line" d="M22,24 Q56,19 101,20" fill="none" stroke="${c.belly}" stroke-width="0.5" opacity="0.28" stroke-linecap="round"/>
      <ellipse class="shark-sheen" cx="46" cy="9" rx="38" ry="8" fill="url(#shark-sheen-grad-${id})"/>
    </g>
    <!-- Pectoral fin: rigid, pointed, swept-back hydrofoil blade — held
         fixed (no flap animation; see the torso-flex/dorsal-flex notes in
         fishRenderEntity) since real pectoral fins are stiff lift
         surfaces, not flexible paddles. -->
    <path class="shark-fin shark-pectoral" d="M60,28 C71,29.3 79,33.6 74,42.5 C69,49.5 57,51 46,45.8 C42,43.8 42,41 45,39 C52,40.2 58,35 60,28 Z" fill="${c.fin}" stroke="${c.tailBack}" stroke-width="0.5" stroke-opacity="0.4"/>
    <path class="shark-fin-ray" d="M56,36 Q49,44 42,47" fill="none" stroke="${c.tailBack}" stroke-width="0.5" opacity="0.35"/>
    <!-- Dorsal fin: tall, raked sickle, wrapped so its trailing edge can
         flutter softly (Part 1: soft-body vertex displacement simulating
         water resistance) instead of the whole fin staying perfectly rigid
         like the pectoral. Kept within the app's fixed viewBox — tall and
         raked, but not reaching a third of the way up the canvas. -->
    <g class="shark-dorsal-flex">
      <path class="shark-dorsal" d="M48,3 C47,-4 52,-11 59,-13 C65,-15 69,-9 67,1 C64,4.5 57,5 48,3 Z" fill="${c.dorsal}" stroke="${c.tailBack}" stroke-width="0.5" stroke-opacity="0.4"/>
      <path class="shark-fin-ray" d="M51,1 Q55,-6 60,-12" fill="none" stroke="${c.tailBack}" stroke-width="0.5" opacity="0.3"/>
    </g>
    <path class="shark-fin shark-dorsal-2" d="M20,20 C21,16 25,15.6 27,19.4 C25,21.2 22,21.2 20,20 Z" fill="${c.dorsal2}" opacity="0.9"/>
    <!-- Gill slits: five, real shark count, curving down the flank behind
         the eye — replaces the earlier three plush "cheek" strokes. -->
    <g class="shark-gills">
      <path class="shark-gill" d="M75,15 Q77.3,24 76,33" fill="none" stroke="${c.gillStroke}" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
      <path class="shark-gill" d="M79.5,14.3 Q81.8,24 80.5,34" fill="none" stroke="${c.gillStroke}" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
      <path class="shark-gill" d="M84,14 Q86.3,24.3 85,35" fill="none" stroke="${c.gillStroke}" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
      <path class="shark-gill" d="M88.5,14.3 Q90.8,24 89.5,34" fill="none" stroke="${c.gillStroke}" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
      <path class="shark-gill" d="M93,15 Q95.3,24 94,33" fill="none" stroke="${c.gillStroke}" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
    </g>
    <!-- snout ridge: faint line hinting at the pointed rostrum above the jaw -->
    <path class="shark-snout-ridge" d="M97,9 Q104,12.5 108,18" fill="none" stroke="${c.tailBack}" stroke-width="0.6" opacity="0.3" stroke-linecap="round"/>
    <!-- resting brow (default) is near-invisible for a calm, gliding
         expression; a bolder hunting brow swaps in by CSS off
         shark-particle[data-behavior] -->
    <path class="shark-brow shark-brow-rest" d="M84,13.5 Q88.5,11.5 93,13.5" fill="none" stroke="${c.browStroke}" stroke-width="1" opacity="0.3" stroke-linecap="round"/>
    <path class="shark-brow shark-brow-hunt" d="M82,15 Q88.5,8.5 95,12.5" fill="none" stroke="${c.browStroke}" stroke-width="2" stroke-linecap="round"/>
    <path class="shark-lower-lid" d="M86,22.5 Q90,24.6 94,23" fill="none" stroke="${c.browStroke}" stroke-width="0.8" opacity="0.4" stroke-linecap="round"/>
    <path class="shark-nostril" d="M104,20 Q105.6,21 104.3,22.6" fill="none" stroke="${c.mouthStroke}" stroke-width="0.9" opacity="0.6" stroke-linecap="round"/>
    <!-- closed, resting expression: a thin, faintly downturned predator line -->
    <path class="shark-mouth shark-mouth-closed" d="M92,27.5 Q98,32.5 105,26.5" fill="none" stroke="${c.mouthStroke}" stroke-width="1.3" stroke-linecap="round"/>
    <path class="shark-teeth shark-teeth-closed" d="M96.3,29 L97.4,31 L98.6,29.1 M99,28.4 L100.2,30.1 L101.4,28.2" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    <!-- wide-open hunting/eating expression: dark gape + tooth rows, hidden until data-behavior flips it on -->
    <g class="shark-mouth-open">
      <path d="M88,26 Q91,42 103,41 Q109,39 106,27 Q103,32 96,33 Q91,32 88,26 Z" fill="#3a0d0d"/>
      <path d="M90.6,27.6 L92.3,33.6 L94,28.1 Z" fill="#f6f2ea"/>
      <path d="M95.5,29 L97.2,35.9 L99,29.3 Z" fill="#f6f2ea"/>
      <path d="M100.3,29.4 L102,36 L103.8,29.6 Z" fill="#f6f2ea"/>
      <path d="M93,39.4 L94.6,34.4 L96.3,39.6 Z" fill="#f6f2ea"/>
      <path d="M98.2,40.2 L99.8,35.2 L101.5,40.4 Z" fill="#f6f2ea"/>
    </g>
    <!-- Small, dark predator eye — mostly pupil/iris rather than a big
         cartoon white, in line with real shark eyes. -->
    <circle class="fish-eye-white" cx="89" cy="18" r="4.6" fill="#e7e2d4"/>
    <circle class="fish-pupil" cx="89.8" cy="18.2" r="3.6" fill="${c.pupil}"/>
    <!-- Nictitating membrane: a translucent grey lid that sweeps up over the
         eye on the periodic blink (see shark-nictitate keyframes) — the
         "protective gleam" catching ambient light as it closes. -->
    <path class="shark-nictitating" d="M84.4,18 A4.6,4.6 0 0 1 93.6,18 L93.6,18 A4.6,4.6 0 0 1 84.4,18 Z" fill="#c9d3d8"/>
    <circle class="shark-eye-glint" cx="87.8" cy="16" r="1.1" fill="#fff"/>
    <circle class="shark-eye-glint shark-eye-glint-sm" cx="91.4" cy="19.8" r="0.6" fill="#fff" opacity="0.7"/>
`;
// Optional body-pattern overlays, keyed by SHARK_VARIANTS[id].pattern.
// Rendered *before* the fins/face markup above so teeth/eyes/gills still
// sit visually on top, matching how the reference art layers spots under
// the fin line.
const SHARK_PATTERN_OVERLAYS = {
  // Ink-dipped fin tips — the blacktip reef shark's signature marking.
  // Drawn after the fins above so the tips paint cleanly over the
  // pectoral, dorsal and upper-caudal-lobe edges.
  blacktips: (c) => `
    <g class="shark-pattern shark-pattern-blacktips" fill="${c.mouthStroke}" opacity="0.88">
      <path d="M70,42.5 C69,49.5 60,51.3 51,48.5 C56,46.5 62,43 65,37.5 C67.3,39 69,40.6 70,42.5 Z"/>
      <path d="M69,-7 C68,1 63,4 55,3.2 C59,-1 62,-8 63,-15 C66,-13 68,-10.3 69,-7 Z"/>
      <path d="M-13,7.3 C-19,9.5 -22,13.3 -21,17.3 C-18,15.3 -14,12.3 -8,11.3 C-10,9.8 -11.5,8.3 -13,7.3 Z"/>
    </g>
  `,
  stripes: (c) => `
    <g class="shark-pattern shark-pattern-stripes" fill="none" stroke="${c.tailBack}" stroke-width="2.6" stroke-linecap="round" opacity="0.65">
      <path d="M30,14.2 Q32,22.3 27,31"/>
      <path d="M46,11.7 Q49,22.3 43,33.4"/>
      <path d="M62,10.8 Q65,22.3 59,35.3"/>
      <path d="M78,11.7 Q81,22.3 76,35.9"/>
      <path d="M94,14.2 Q96,22.3 92,33.4"/>
    </g>
  `,
};
function buildSharkVariantMarkup(variantId) {
  const variant = SHARK_VARIANTS[variantId] || SHARK_VARIANTS.reef;
  const overlay = variant.pattern && SHARK_PATTERN_OVERLAYS[variant.pattern]
    ? SHARK_PATTERN_OVERLAYS[variant.pattern](variant.colors)
    : "";
  return overlay + SHARK_VARIANT_SILHOUETTE(variant.colors, variantId);
}
// Built once at load — one full SVG markup string per variant id — so
// per-frame/per-spawn rendering is just a lookup, not a rebuild.
const SHARK_VARIANT_MARKUP = SHARK_VARIANT_IDS.reduce((acc, id) => {
  acc[id] = buildSharkVariantMarkup(id);
  return acc;
}, {});

function getSharkVariantPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARK_VARIANT_STORAGE));
    if (raw && typeof raw === "object") {
      const merged = { ...DEFAULT_SHARK_VARIANT_PREFS };
      SHARK_VARIANT_IDS.forEach((id) => {
        if (typeof raw[id] === "boolean") merged[id] = raw[id];
      });
      return merged;
    }
  } catch (err) {
    // fall through to defaults
  }
  return { ...DEFAULT_SHARK_VARIANT_PREFS };
}

function setSharkVariantEnabled(id, on) {
  try {
    const prefs = getSharkVariantPrefs();
    prefs[id] = !!on;
    // Never allow the last enabled variant to be switched off — sharks
    // still need somewhere to draw from whenever fish mode is on.
    if (!prefs[id] && !SHARK_VARIANT_IDS.some((v) => v !== id && prefs[v])) return;
    localStorage.setItem(SHARK_VARIANT_STORAGE, JSON.stringify(prefs));
  } catch (err) {
    // non-fatal
  }
}

// Picks a random *enabled* variant for a freshly spawned shark. Falls
// back to "reef" if (somehow) nothing is enabled, so a shark can never
// fail to spawn just because of variant prefs.
function pickRandomSharkVariant() {
  const prefs = getSharkVariantPrefs();
  const enabled = SHARK_VARIANT_IDS.filter((id) => prefs[id]);
  if (!enabled.length) return "reef";
  return enabled[Math.floor(Math.random() * enabled.length)];
}
const FISH_SIZE_RANGES = {
  clownfish: [46, 62],
  betta: [50, 68],
  angelfish: [50, 70],
  guppy: [30, 42], // fallback only — fishGuppyPickTraits overrides per-sex (males 27-35, females 40-50)
  pufferfish: [38, 52],
  shark: [72, 96],
};

const FISH_PREY_COUNT = 12;
const FISH_MOUSE_RADIUS = 130;
const FISH_BUBBLE_RADIUS = 60;
const FISH_SHARK_PANIC_RADIUS = 200;
const SHARK_STRIKE_RADIUS = 150;
const SHARK_CATCH_RADIUS = 20;
const SHARK_CONFUSE_TIMEOUT = 5;
const SHARK_EAT_PAUSE = 1.5;

// ---- Part 7: organic spine flexibility -----------------------------------
// Rather than the shark's whole silhouette pivoting as one rigid slab
// through a turn, the rear of the body (the .shark-spine-tail group — see
// SHARK_VARIANT_SILHOUETTE) is allowed to lag/lead the heading change by a
// bounded amount, driven by how fast the heading itself is turning. That
// reads as a fluid C-curve through sharp turns, hunts, and strike bursts,
// instead of a flat, geometric spin. See SharkPhysicsEngine.integrate for
// where this is computed, and --spine-bend in style.css for how it's
// rendered on top of the existing tail wag.
const SHARK_SPINE_BEND_MAX = 24; // deg — hard cap so a fast direction snap can't fold the body in half
const SHARK_SPINE_BEND_GAIN = 6.5; // turn-rate (rad/s) -> degrees of spine curvature
const SHARK_SPINE_BEND_SMOOTH_MIN = 3.5; // lerp-per-second floor (mid state-transition, ai.alpha ~0)
const SHARK_SPINE_BEND_SMOOTH_MAX = 9; // lerp-per-second ceiling (settled, ai.alpha ~1)

// ---- Part 8: fish body flexibility ---------------------------------------
// Prey fish are a single-piece .fish-body shape (no segmented spine like the
// shark), so instead of a discrete joint, the torso gets a continuous
// sine-wave shear+scale written directly onto .fish-body's transform each
// frame in fishRenderEntity, driven by the fish's own swimPhase accumulator
// (see the swim-phase notes above). --body-flex-amp is a skewY() angle (the
// S-curve lean along the body's length) and --body-flex-scale is a small
// scaleX() pulse layered under it (the "ripple" — torso compressing/
// lengthening as the wave passes through), both eased by speed the same way
// tailHz/tailAmp are below so gliding reads as a gentle sway and a
// full-speed dart reads as a sharp undulation instead of a flat rigid
// ellipse gliding around. The ripple runs at the fish's own swim frequency
// with a constant phase lag behind the tail wag, so it reads as a wave
// traveling head-to-tail rather than the whole body flexing in lockstep
// with the fin. This is a single extra transform write per fish per frame
// (fish.bodyEl.style.transform) — still transform-only, so it never
// touches layout and stays cheap even with a full tank on screen.
const FISH_BODY_FLEX_IDLE_DEG = 1.6; // skew at rest — never fully static, even wandering slowly
const FISH_BODY_FLEX_CRUISE_DEG = 5.5; // skew at cfg.maxSpeed
const FISH_BODY_FLEX_PANIC_DEG = 9; // skew while fleeing/evading (fish.panic)
const FISH_BODY_FLEX_SCALE_IDLE = 0.008;
const FISH_BODY_FLEX_SCALE_CRUISE = 0.03;
const FISH_BODY_FLEX_SCALE_PANIC = 0.045;

// ---- Swim-phase accumulator (replaces CSS @keyframes for tail/body/fin
// motion) ---------------------------------------------------------------
// PREVIOUSLY the tail wag, body ripple, shark tail-seg sway, and pectoral
// flap were driven by CSS @keyframes whose `animation-duration` read
// `calc(1s / var(--tail-hz))` — and --tail-hz was rewritten by JS every
// single rAF frame as speed fluctuates. Changing animation-duration
// mid-flight doesn't restart the animation; the browser reinterprets the
// elapsed time against the new duration, so the cycle's progress fraction
// jumps discontinuously *every frame* tail-hz so much as ticks. At 60fps
// with continuously-varying speed that's a constant stream of tiny pops —
// exactly the "vibrating"/"wired" motion being reported. --spine-bend
// never had this problem because it drives a plain, non-keyframed
// `transform: rotate(var(--spine-bend))` — a normal style recalc, not an
// animation-timeline recalculation.
// Fix: every oscillating body part now uses the same static-transform
// pattern as spine-bend. Each fish/shark accumulates its own swimPhase by
// integrating tailHz over real dt (proper phase integration, not a
// wall-clock trig call), and fishRenderEntity writes the resulting
// sin/cos values straight into `element.style.transform` once per frame.
// Still a single transform-only write per part (no layout thrashing,
// still fully inside the rAF loop) — just no more CSS animation-duration
// churn underneath it.
const TWO_PI = Math.PI * 2;
// Constant *fraction of a cycle* the body ripple lags the tail beat (was
// the old `animation-delay: calc(-0.14s / var(--tail-hz))` — 0.14 of one
// period, a fixed phase fraction regardless of frequency).
const FISH_BODY_FLEX_PHASE_OFFSET = 0.14 * TWO_PI;
// Shark tail-seg-2 and the pectoral fin previously ran at slower fixed
// multiples of the tail period (1.1x and 1.5x). Since phase is the time
// integral of angular rate, and integration is linear, scaling the
// primary swimPhase by 1/ratio gives the exact same result as a separate
// accumulator running at rate/ratio — no extra state needed.
const SHARK_TAIL_SEG2_RATE = 1 / 1.1;
// Part 1/3: torso flex (traveling wave origin near the head) and dorsal
// trailing-edge flutter (soft-body vertex displacement) — see
// fishRenderEntity. Kept small/subtle relative to the tail-segment
// amplitudes above so the torso still visibly leads the much bigger tail
// beat rather than competing with it.
const SHARK_TORSO_FLEX_DEG = 2.2;
const SHARK_DORSAL_FLUTTER_RATE = 1 / 1.3;
const SHARK_DORSAL_FLUTTER_DEG = 3;

// ---- Shark AI state machine ---------------------------------------------
// States the shark AI controller tracks. Kept separate from
// `shark.currentBehavior` (which only ever distinguishes wandering /
// hunting / eating for rendering and other systems) so the controller can
// track a finer-grained state — e.g. "confused" — purely for blending,
// without touching any external code that reads currentBehavior.
const SHARK_STATES = {
  WANDERING: "wandering",
  HUNTING: "hunting",
  CONFUSED: "confused",
  EATING: "eating",
};
// How long (seconds) a state transition takes to fully blend in. Applies
// to both the per-state cruise-speed multiplier and the strike-mode burst,
// so switching states eases the shark's target speed in over this window
// instead of snapping straight to the new value in one frame.
const SHARK_STATE_TRANSITION_DURATION = 0.45;
const PREY_RESPAWN_DELAY = 5;
// Boids-style separation: keeps prey from visually overlapping/clumping.
// Deliberately gentle relative to flee/panic forces (see FISH_SEPARATION_WEIGHT
// below) so it never dominates a real escape — it's a background steering
// term, summed into `force` like every other behavior, so it rides through
// the same fishApplyForce(dt) integration and fishLimitVelocityChange safety
// net as everything else. No separate velocity-mutation path to keep in sync.
const FISH_SEPARATION_RADIUS = 46;
const FISH_SEPARATION_WEIGHT = 0.8;

const fishEngine = {
  state: {
    fishes: [],
    mouse: { x: -9999, y: -9999 },
    width: 0,
    height: 0,
    running: false,
    lastTime: 0,
    nextId: 1,
  },
  field: null,
  rafId: null,
  built: false,
  listenersBound: false,
  resizeTimer: null,
};

// flexMul scales Part 8's body-ripple amplitude per species — a long
// slender swimmer (guppy) undulates its torso far more visibly than a
// stiff, already-round one (pufferfish, mid-puff) at the same speed, so
// this is a separate knob from maxSpeed/maxForce/mass rather than trying
// to derive it from those.
const SPECIES_PHYSICS = {
  clownfish: { maxSpeed: 140, maxForce: 320, mass: 1, burst: true, flexMul: 1 },
  betta: { maxSpeed: 95, maxForce: 180, mass: 1.1, glide: true, flexMul: 1.15 },
  angelfish: { maxSpeed: 80, maxForce: 150, mass: 1.3, vertical: true, flexMul: 0.75 },
  guppy: { maxSpeed: 180, maxForce: 400, mass: 0.7, zigzag: true, flexMul: 1.3 },
  pufferfish: { maxSpeed: 65, maxForce: 120, mass: 1.8, heavy: true, flexMul: 0.4 },
  // minSpeed: Part 3 — sharks have no swim bladder and must keep moving
  // forward or they sink, so velocity is never allowed to drift toward
  // zero outside the deliberate eating pause (see fishUpdateShark).
  shark: { maxSpeed: 200, maxForce: 280, mass: 2.5, minSpeed: 32 },
};

// ---- Vector math --------------------------------------------------------
function fishVec(x = 0, y = 0) { return { x, y }; }
function fishLen(v) { return Math.hypot(v.x, v.y); }
function fishNorm(v) {
  const l = fishLen(v);
  return l > 0.0001 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}
function fishSub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function fishAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function fishScale(v, s) { return { x: v.x * s, y: v.y * s }; }
function fishDist(a, b) { return fishLen(fishSub(a, b)); }
function fishLimit(v, max) {
  const l = fishLen(v);
  if (l > max && l > 0.0001) return fishScale(v, max / l);
  return { x: v.x, y: v.y };
}
function fishClamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function fishLerp(a, b, t) { return a + (b - a) * t; }
function fishRand(min, max) { return min + Math.random() * (max - min); }
// Frame-rate independent exponential decay: `retainPerSecond` is the
// fraction of the vector left after a full second, regardless of how
// often this runs. Replaces the old `v *= 0.95` per-frame damping, which
// decayed slower in real time on higher refresh-rate displays.
function fishDamp(v, retainPerSecond, dt) {
  return fishScale(v, Math.pow(fishClamp(retainPerSecond, 0.0001, 0.999), dt));
}

// ---- Reynolds steering ---------------------------------------------------
// Both helpers return a STEERING FORCE (desired velocity minus current
// velocity, clamped to maxForce) — never touch position/velocity. Callers
// sum several of these, then integrate once per frame via fishApplyForce
// with the *real* frame dt so behavior stays frame-rate independent.
function fishSteerSeek(pos, vel, target, maxSpeed, maxForce) {
  const desired = fishScale(fishNorm(fishSub(target, pos)), maxSpeed);
  const steer = fishSub(desired, vel);
  return fishLimit(steer, maxForce);
}

function fishSteerFlee(pos, vel, threat, fleeRadius, maxSpeed, maxForce) {
  const d = fishDist(pos, threat);
  if (d > fleeRadius || d < 0.0001) return fishVec();
  const strength = (fleeRadius - d) / fleeRadius;
  const desired = fishScale(fishNorm(fishSub(pos, threat)), maxSpeed * strength);
  const steer = fishSub(desired, vel);
  return fishLimit(steer, maxForce * (1 + strength));
}

// Classic boids separation: average, distance-weighted push-away from every
// same-type neighbor inside `radius`. Like seek/flee above, this returns a
// STEERING FORCE already clamped to maxForce — callers sum it into their
// force accumulator and let fishApplyForce(dt) do the actual integration,
// so it inherits frame-rate independence and the velocity-change ceiling
// for free instead of needing its own.
function fishSteerSeparation(fish, neighbors, radius, maxForce) {
  let push = fishVec();
  let count = 0;
  for (let i = 0; i < neighbors.length; i++) {
    const other = neighbors[i];
    if (other === fish || other.removing || other.frozen) continue;
    const d = fishDist(fish.position, other.position);
    if (d < 0.0001 || d >= radius) continue;
    push = fishAdd(push, fishScale(fishNorm(fishSub(fish.position, other.position)), (radius - d) / radius));
    count++;
  }
  if (count === 0) return fishVec();
  return fishLimit(fishScale(push, 1 / count), maxForce);
}

// F = ma, integrated over exactly `dt` seconds. Every call site MUST pass
// the frame's real dt — hardcoding a value here is what caused shark
// strikes to feel erratic (a stray `1` snuck in downstream previously).
function fishApplyForce(fish, force, dt) {
  const accel = fishScale(force, 1 / (fish.mass || 1));
  fish.velocity.x += accel.x * dt;
  fish.velocity.y += accel.y * dt;
}

// ---- Velocity-change safety net -----------------------------------------
// Normal Reynolds steering (fishSteerSeek/Flee -> fishApplyForce) is
// already frame-rate independent and self-limiting via maxForce. But a
// few things intentionally step outside that system in a single frame —
// the guppy's twirl-exit dash, the pufferfish's puff-up hop, a bubble
// dodge that re-scales the steering force *after* it's already been
// clamped to maxForce, or a shark's speed cap instantly doubling/halving
// when strike mode toggles. Each of those used to be able to change a
// fish's velocity outright in one frame, which reads as a "flash"/teleport
// rather than a dash. This clamps the *change* in velocity for the frame,
// regardless of what caused it, to a species-appropriate maximum, so every
// dash, turn, or direction change gets eased in over a handful of frames
// instead of snapping instantly. Normal steering is comfortably inside
// this ceiling, so it's invisible during ordinary swimming.
const FISH_BURST_ACCEL_MULTIPLIER = 4;
function fishLimitVelocityChange(fish, prevVelocity, dt, cfg) {
  const maxAccel = (cfg.maxForce / (fish.mass || 1)) * FISH_BURST_ACCEL_MULTIPLIER;
  const maxDelta = maxAccel * dt;
  const dv = fishSub(fish.velocity, prevVelocity);
  const dvLen = fishLen(dv);
  if (dvLen > maxDelta && dvLen > 0.0001) {
    const capped = fishScale(dv, maxDelta / dvLen);
    fish.velocity.x = prevVelocity.x + capped.x;
    fish.velocity.y = prevVelocity.y + capped.y;
  }
}

function fishWrapBounds(fish, w, h, pad) {
  const p = fish.position;
  if (p.x < -pad) p.x = w + pad;
  else if (p.x > w + pad) p.x = -pad;
  if (p.y < -pad) p.y = h + pad;
  else if (p.y > h + pad) p.y = -pad;
}

function fishPerimeterSpawn(w, h) {
  const edge = Math.floor(Math.random() * 4);
  const m = 40;
  if (edge === 0) return { x: fishRand(-m, w + m), y: -m };
  if (edge === 1) return { x: w + m, y: fishRand(-m, h + m) };
  if (edge === 2) return { x: fishRand(-m, w + m), y: h + m };
  return { x: -m, y: fishRand(-m, h + m) };
}

function fishSpeciesHidden(species) {
  return document.body.classList.contains(`fish-hide-${species}`);
}

function fishCreateDOM(fish) {
  const el = document.createElement("div");
  el.className = `fish-particle species-${fish.species} type-${fish.type}`;
  el.dataset.fishId = String(fish.id);
  el.style.width = `${fish.size}px`;
  el.style.height = `${fish.size * 0.6}px`;
  const orient = document.createElement("div");
  orient.className = "fish-orient";
  const speciesMarkup = FISH_SPECIES_MARKUP[fish.species];
  const svgMarkup = fish.type === "shark"
    ? (SHARK_VARIANT_MARKUP[fish.variant] || SHARK_VARIANT_MARKUP.reef)
    // Guppy is the one species whose markup is a builder function (sex,
    // tail shape, pattern, colorway all vary per instance) rather than a
    // fixed template string — see fishBuildGuppyMarkup.
    : (typeof speciesMarkup === "function" ? speciesMarkup(fish) : speciesMarkup);
  // Part 6: explicit preserveAspectRatio + geometricPrecision keep the vector
  // paths crisp and undistorted at any render size — from the smallest prey
  // fish up through a fully "Add Shark"-ed tank — and as the window/liquid
  // interface is resized or the page is browser-zoomed. Nothing here is
  // rasterized, so there's no fixed-resolution source to run out of.
  orient.innerHTML = `<svg class="fish-svg" viewBox="${FISH_SVG_VIEWBOX}" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision">${svgMarkup}</svg>`;
  el.appendChild(orient);
  fish.el = el;
  fish.orientEl = orient;
  fish.pupilEl = orient.querySelector(".fish-pupil");
  fish.tailEl = orient.querySelector(".fish-tail");
  fish.bodyEl = orient.querySelector(".fish-body");
  if (fish.type === "shark") {
    // Sharks have two segmented tail parts (both also carry .fish-tail,
    // used for prey's single-piece tail — querySelectorAll here to drive
    // each segment independently). Pectoral fins are rigid lift surfaces
    // now (no flap — see fishRenderEntity), so no element is cached for
    // them; .shark-torso-flex and .shark-dorsal-flex are the two soft-
    // body joints that are animated instead (Part 1/3).
    fish.tailSegEls = Array.from(orient.querySelectorAll(".shark-tail-seg"));
    fish.torsoFlexEl = orient.querySelector(".shark-torso-flex");
    fish.dorsalFlexEl = orient.querySelector(".shark-dorsal-flex");
  }
  if (fish.pupilEl) {
    fish.pupilBase = {
      cx: parseFloat(fish.pupilEl.getAttribute("cx") || "0"),
      cy: parseFloat(fish.pupilEl.getAttribute("cy") || "0"),
    };
  }
  // Part 3: soft-body tail cloth panels, trailing dorsal ribbon, and
  // shimmering pectorals only exist on male guppies (fishBuildGuppyMarkup
  // renders none of these for females/other species) — cache whatever is
  // there so fishRenderGuppyExtras never has to re-query the DOM per frame.
  if (fish.species === "guppy") {
    fish.tailPanelEls = Array.from(orient.querySelectorAll(".guppy-tail-panel"));
    fish.dorsalRibbonEl = orient.querySelector(".guppy-dorsal-ribbon");
    fish.pectoralEls = Array.from(orient.querySelectorAll(".guppy-pectoral"));
    fish.shineEl = orient.querySelector(".guppy-shine");
  }
  return el;
}

function fishSpawnPrey(species, pos) {
  const [minS, maxS] = FISH_SIZE_RANGES[species] || [40, 60];
  const w = fishEngine.state.width || window.innerWidth;
  const h = fishEngine.state.height || window.innerHeight;
  const spawn = pos || { x: fishRand(0, w), y: fishRand(h * 0.08, h * 0.88) };
  const cfg = SPECIES_PHYSICS[species] || SPECIES_PHYSICS.clownfish;
  const fish = {
    id: fishEngine.state.nextId++,
    type: "prey",
    species,
    position: fishVec(spawn.x, spawn.y),
    velocity: fishVec(fishRand(-40, 40), fishRand(-20, 20)),
    targetVelocity: fishVec(),
    size: fishRand(minS, maxS),
    angle: 0,
    scaleX: 1,
    scaleY: 1,
    extraRot: 0,
    currentBehavior: "wandering",
    behaviorTimer: fishRand(8, 15),
    trickActive: null,
    trickTimer: 0,
    panic: false,
    mass: cfg.mass,
    maxSpeed: cfg.maxSpeed,
    maxForce: cfg.maxForce,
    wanderAngle: Math.random() * Math.PI * 2,
    burstPhase: 0,
    zigzagPhase: 0,
    pupilOffset: { x: 0, y: 0 },
    tailHz: 0.7,
    tailAmp: 16,
    // Random start offset so a whole school doesn't swim in lockstep —
    // see the swim-phase accumulator notes above Part 8's constants.
    swimPhase: fishRand(0, TWO_PI),
    removing: false,
    frozen: false,
  };
  // Part 1/2: sexual dimorphism + chromatophore pattern/colorway/tail-shape
  // roll, before fishCreateDOM builds the actual markup from these.
  if (species === "guppy") fishGuppyPickTraits(fish);
  fishCreateDOM(fish);
  fishEngine.field.appendChild(fish.el);
  fishEngine.state.fishes.push(fish);
  return fish;
}

function fishSpawnShark(pos, variant) {
  const w = fishEngine.state.width || window.innerWidth;
  const h = fishEngine.state.height || window.innerHeight;
  const spawn = pos || fishPerimeterSpawn(w, h);
  const cfg = SPECIES_PHYSICS.shark;
  const chosenVariant = variant || pickRandomSharkVariant();
  const fish = {
    id: fishEngine.state.nextId++,
    type: "shark",
    species: "shark",
    variant: chosenVariant,
    position: fishVec(spawn.x, spawn.y),
    velocity: fishVec(fishRand(-30, 30), fishRand(-30, 30)),
    targetVelocity: fishVec(),
    size: fishRand(FISH_SIZE_RANGES.shark[0], FISH_SIZE_RANGES.shark[1]),
    angle: 0,
    scaleX: 1,
    scaleY: 1,
    extraRot: 0,
    currentBehavior: "wandering",
    behaviorTimer: 0,
    targetPreyId: null,
    huntTimer: 0,
    strikeMode: false,
    confuseSpin: 0,
    chewTimer: 0,
    ai: new SharkAIController(),
    physics: new SharkPhysicsEngine(),
    mass: cfg.mass,
    maxSpeed: cfg.maxSpeed,
    maxForce: cfg.maxForce,
    wanderAngle: Math.random() * Math.PI * 2,
    pupilOffset: { x: 0, y: 0 },
    tailHz: 0.5,
    swimPhase: fishRand(0, TWO_PI),
    // Part 7: organic spine flex — degrees of extra curvature applied to
    // the tail end of the body during sharp turns/strikes, computed each
    // frame by SharkPhysicsEngine.integrate() from heading turn-rate. See
    // --spine-bend in fishRenderEntity + .shark-spine-tail in style.css.
    spineBend: 0,
    removing: false,
    frozen: false,
  };
  fishCreateDOM(fish);
  fish.el.classList.add("shark-particle", `shark-variant-${chosenVariant}`);
  fishEngine.field.appendChild(fish.el);
  fishEngine.state.fishes.push(fish);
  return fish;
}

function fishGetBubblePositions() {
  // Bubbles turned off (independently of Liquid Interface itself, or the
  // whole Liquid Interface theme off) — there's nothing on screen for fish
  // to dodge, so skip the layout-read walk below entirely.
  if (!document.body.classList.contains("bubble-mode-on")) return [];
  // While the page is actively scrolling, reuse last frame's positions
  // instead of forcing a fresh getBoundingClientRect layout read on every
  // bubble every frame — that forced read is one more thing competing
  // with the browser's scroll compositing work, on top of the glass-card
  // backdrop-filter cost (see the "is-scrolling" handling in style.css).
  // Bubbles drift slowly, so a couple hundred ms of stale avoidance data
  // is imperceptible.
  if (document.body.classList.contains("is-scrolling") && fishEngine.state.lastBubbles) {
    return fishEngine.state.lastBubbles;
  }
  const field = document.getElementById("bubble-field");
  if (!field) return fishEngine.state.lastBubbles || [];
  const bubbles = [];
  field.querySelectorAll(".bubble-particle").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1) return;
    const draftX = parseFloat(el.dataset.draftX || "0") || 0;
    const draftY = parseFloat(el.dataset.draftY || "0") || 0;
    bubbles.push({
      el,
      x: r.left + r.width / 2 + draftX,
      y: r.top + r.height / 2 + draftY,
      r: r.width / 2,
    });
  });
  fishEngine.state.lastBubbles = bubbles;
  return bubbles;
}

function fishPushBubbleDraft(bubble, fishVx, fishVy) {
  if (!bubble.el) return;
  let dx = (parseFloat(bubble.el.dataset.draftX) || 0) + fishVx * 0.012;
  let dy = (parseFloat(bubble.el.dataset.draftY) || 0) + fishVy * 0.008;
  dx *= 0.92;
  dy *= 0.92;
  bubble.el.dataset.draftX = dx.toFixed(2);
  bubble.el.dataset.draftY = dy.toFixed(2);
  bubble.el.style.setProperty("--bdraft-x", `${dx}px`);
  bubble.el.style.setProperty("--bdraft-y", `${dy}px`);
}

// SharkAIController: owns the shark's high-level state machine (wandering /
// hunting / confused / eating) and produces a single blended speed
// multiplier so switching between states — and ramping in/out of a strike —
// eases in over SHARK_STATE_TRANSITION_DURATION rather than snapping in a
// single frame. Steering itself (fishSteerSeek/fishApplyForce) is
// untouched; this only decides *how fast* the shark is allowed to want to
// go on any given frame, and callers plug that into the existing force /
// integration pipeline like any other value.
class SharkAIController {
  constructor() {
    this.state = SHARK_STATES.WANDERING;
    this.previousState = SHARK_STATES.WANDERING;
    // Starts "settled" (alpha === 1) so a freshly spawned shark doesn't
    // ease in from a phantom previous state.
    this.transitionElapsed = SHARK_STATE_TRANSITION_DURATION;
    // Strike is a burst layered on top of the hunting cruise speed and
    // eased independently, since a shark can enter/exit strike range
    // several times while remaining in the "hunting" state overall.
    this.strikeIntensity = 0;
    this.targetStrikeIntensity = 0;
  }

  // Switches the active state and restarts the blend clock so behavior
  // parameters ease from wherever they currently sit into the new target.
  // Re-entering the same state is a no-op so an in-progress blend never
  // gets reset just because targeting logic re-confirms "still hunting"
  // on a later frame.
  setState(next) {
    if (next === this.state) return;
    this.previousState = this.state;
    this.state = next;
    this.transitionElapsed = 0;
  }

  setStrike(on) {
    this.targetStrikeIntensity = on ? 1 : 0;
  }

  // 0 right at the instant of a state change, 1 once fully blended in.
  get alpha() {
    return fishClamp(this.transitionElapsed / SHARK_STATE_TRANSITION_DURATION, 0, 1);
  }

  // Advances the transition clock and eases strikeIntensity toward its
  // target. Must be called once per frame with the real frame dt so the
  // blend takes the same wall-clock time regardless of frame rate — same
  // convention as fishApplyForce/fishDamp elsewhere in the sim.
  update(dt) {
    this.transitionElapsed += dt;
    const step = dt / SHARK_STATE_TRANSITION_DURATION;
    if (this.strikeIntensity < this.targetStrikeIntensity) {
      this.strikeIntensity = Math.min(this.targetStrikeIntensity, this.strikeIntensity + step);
    } else if (this.strikeIntensity > this.targetStrikeIntensity) {
      this.strikeIntensity = Math.max(this.targetStrikeIntensity, this.strikeIntensity - step);
    }
  }

  // Baseline cruise-speed multiplier (fraction of maxSpeed) for a state,
  // before the strike burst is layered on top.
  static baseSpeedMul(state) {
    switch (state) {
      case SHARK_STATES.HUNTING: return 1;
      case SHARK_STATES.CONFUSED: return 0.25;
      case SHARK_STATES.EATING: return 0;
      case SHARK_STATES.WANDERING:
      default: return 0.6;
    }
  }

  // The multiplier callers should scale maxSpeed by this frame: lerps
  // between the previous and current state's baseline using `alpha` (so a
  // WANDERING -> HUNTING switch ramps up over the transition window instead
  // of jumping straight to full hunting speed), then layers the eased
  // strike burst (1x -> 2x) on top so entering/exiting strike range is
  // also a ramp rather than the speed cap instantly doubling/halving.
  blendedSpeedMul() {
    const fromMul = SharkAIController.baseSpeedMul(this.previousState);
    const toMul = SharkAIController.baseSpeedMul(this.state);
    const cruiseMul = fishLerp(fromMul, toMul, this.alpha);
    return cruiseMul * fishLerp(1, 2, this.strikeIntensity);
  }
}

// ---- Vector2 --------------------------------------------------------------
// Thin, self-descriptive wrapper over the fishVec/fishAdd/fishScale/fishLerp
// primitives above. The rest of the sim composes those directly, but
// SharkPhysicsEngine below leans on named vector ops — `Vector2.lerp` in
// particular — since it's blending whole velocity/heading vectors (not
// summing steering forces the way fishSteerSeek/fishApplyForce do), so a
// vector-level lerp reads clearer at each call site than reimplementing it
// inline. Same math as fishLerp per-axis; this is not a second vector
// system, just a named entry point onto the existing one.
const Vector2 = {
  lerp(a, b, t) {
    const ct = fishClamp(t, 0, 1);
    return { x: fishLerp(a.x, b.x, ct), y: fishLerp(a.y, b.y, ct) };
  },
  length(v) { return fishLen(v); },
  normalize(v) { return fishNorm(v); },
  sub(a, b) { return fishSub(a, b); },
  add(a, b) { return fishAdd(a, b); },
  scale(v, s) { return fishScale(v, s); },
};

// Confusion used to be rendered as a continuous full-body spin (up to
// 1080deg/sec, unbounded — several full barrel-rolls over the 1.2s timeout).
// Real sharks don't tumble like that when they lose a target; they break
// off with a sharp turn. This is now a small bounded head/body shake
// layered on top of the normal heading-based turn-away, decaying to 0
// instead of accumulating rotation. Amplitude in degrees, rate in Hz.
const SHARK_CONFUSE_SHAKE_AMPLITUDE = 9;
const SHARK_CONFUSE_SHAKE_HZ = 2.2;
// Per-second exponential decay rate applied to velocity while eating.
// Higher = the shark coasts to a stop faster after a catch.
const SHARK_EAT_DECEL_RATE = 5;
// How quickly (per second, scaled by ai.alpha below) the rendered heading
// vector chases the shark's actual velocity direction. Kept state-transition
// aware: slower right as a new state comes in (low alpha) so the heading
// doesn't pop instantly when targetVelocity jumps to a new direction, and
// fast once the shark has settled into the new state (alpha -> 1).
const SHARK_HEADING_EASE_MIN = 2.5;
const SHARK_HEADING_EASE_MAX = 9;

// SharkPhysicsEngine: owns per-frame application of the blended velocity
// that SharkAIController (Part 1) computes onto the shark's actual
// movement and heading. fishSteerSeek/fishApplyForce already turn steering
// intent into a physically reasonable velocity; what this adds is the
// smoothing pass *around* that — easing the confusion spin's rotation in
// and out instead of a flat per-frame increment, gliding to a stop while
// eating instead of an instant velocity snap, and blending the rendered
// heading toward the new velocity direction with Vector2.lerp so a state
// switch (e.g. snapping into/out of strike mode, or exiting a spin) can't
// pop the shark's orientation in a single frame. One instance lives on
// each shark (shark.physics) so its internal spin/heading state is
// per-shark, exactly like shark.ai.
class SharkPhysicsEngine {
  constructor() {
    // How long the shark has been in the current confusion shake, used to
    // drive the bounded oscillation in applyConfusionDamping() — reset to 0
    // whenever confuseSpin isn't active.
    this.confuseElapsed = 0;
    // Smoothed heading direction (unit-ish vector), blended toward the
    // shark's real velocity direction every frame via Vector2.lerp. Angle
    // and left/right facing are both derived from this instead of reading
    // shark.velocity directly, so they inherit the same easing.
    this.heading = fishVec(1, 0);
    // Smoothed spine-bend angle (deg), eased toward a turn-rate-derived
    // target each frame in integrate() — see Part 7 constants above.
    this.spineBend = 0;
  }

  // Confusion shake: while shark.confuseSpin is active this drives a small
  // bounded oscillation (a head-shake) instead of the old unbounded
  // `extraRot +=` accumulation, which added up to several full 360°
  // rotations over the timeout and read as the shark barrel-rolling in
  // place. The shark's actual body-turn away from the lost target already
  // comes from the normal heading/steering (it re-enters "wandering"
  // behavior the moment confuseSpin is set), so this is purely a small
  // cosmetic shake layered on top, and it decays to 0 as confuseSpin counts
  // down rather than cutting off dead the instant the timer ends.
  applyConfusionDamping(shark, dt) {
    if (shark.confuseSpin > 0) {
      this.confuseElapsed += dt;
      const decay = fishClamp(shark.confuseSpin / 1.2, 0, 1);
      shark.extraRot = Math.sin(this.confuseElapsed * SHARK_CONFUSE_SHAKE_HZ * Math.PI * 2)
        * SHARK_CONFUSE_SHAKE_AMPLITUDE * decay;
    } else {
      this.confuseElapsed = 0;
      shark.extraRot = fishLerp(shark.extraRot || 0, 0, fishClamp(dt * 6, 0, 1));
    }
  }

  // Eating deceleration: glides shark.velocity down to rest over the eat
  // pause using Vector2.lerp toward zero, frame-rate independent via the
  // same exponential-decay-as-lerp-factor pattern as fishDamp above.
  // Replaces the old one-shot `velocity *= 0.1` snap that fired once at
  // the instant of the catch and then left the (now-tiny) residual
  // velocity untouched for the rest of the chew.
  applyEatingDeceleration(shark, dt) {
    const t = fishClamp(dt * SHARK_EAT_DECEL_RATE, 0, 1);
    shark.velocity = Vector2.lerp(shark.velocity, fishVec(0, 0), t);
  }

  // Integrates the current velocity into position, and eases the visual
  // heading/rotation toward that velocity's direction rather than
  // recomputing angle straight off shark.velocity every frame. `ai.alpha`
  // (0 right at a state switch, 1 once settled) slows the heading blend
  // during an active transition so orientation doesn't pop the instant a
  // new target velocity appears, then speeds back up once settled.
  integrate(shark, ai, dt) {
    shark.position.x += shark.velocity.x * dt;
    shark.position.y += shark.velocity.y * dt;

    // Snapshot before this frame's heading blend — used below to measure
    // how fast the heading itself is turning, for the spine-bend curve.
    const prevHeading = this.heading;
    const speed = fishLen(shark.velocity);
    if (speed > 2) {
      const dir = fishScale(shark.velocity, 1 / speed);
      const headingT = fishClamp(dt * fishLerp(SHARK_HEADING_EASE_MIN, SHARK_HEADING_EASE_MAX, ai.alpha), 0, 1);
      this.heading = Vector2.lerp(this.heading, dir, headingT);
    }
    shark.angle = Math.atan2(this.heading.y, Math.abs(this.heading.x) + 0.001) * (180 / Math.PI) * 0.25;
    if (Math.abs(this.heading.x) > 0.05) {
      shark.orientEl.style.transform = this.heading.x < 0 ? "scaleX(-1)" : "scaleX(1)";
    }

    // ---- Part 7: organic spine flexibility -------------------------------
    // Signed angle between last frame's heading and this frame's, via
    // cross/dot rather than differencing two atan2() outputs directly, so
    // the ±180° wrap never shows up as a one-frame snap in the bend.
    const cross = prevHeading.x * this.heading.y - prevHeading.y * this.heading.x;
    const dot = prevHeading.x * this.heading.x + prevHeading.y * this.heading.y;
    const turnRate = dt > 0 ? Math.atan2(cross, dot) / dt : 0;
    // Strikes and hunting bursts whip the tail through a turn harder than
    // an ordinary wandering course-correction — lean into that instead of
    // smoothing it away like everything else here.
    const burstMul = fishLerp(1, 1.6, ai.strikeIntensity || 0);
    // The tail-group rotation lives in local (pre-mirror) SVG space, so
    // when the sprite is flipped via scaleX(-1) for leftward swimming the
    // sign has to flip too, or the curve would visually reverse on a turn.
    const mirrorSign = this.heading.x < 0 ? -1 : 1;
    const bendTarget = fishClamp(
      turnRate * SHARK_SPINE_BEND_GAIN * burstMul * mirrorSign,
      -SHARK_SPINE_BEND_MAX, SHARK_SPINE_BEND_MAX,
    );
    const bendT = fishClamp(dt * fishLerp(SHARK_SPINE_BEND_SMOOTH_MIN, SHARK_SPINE_BEND_SMOOTH_MAX, ai.alpha), 0, 1);
    this.spineBend = fishLerp(this.spineBend || 0, bendTarget, bendT);
    shark.spineBend = this.spineBend;
  }
}

function fishNearestPrey(shark) {
  let best = null;
  let bestD = Infinity;
  fishEngine.state.fishes.forEach((f) => {
    if (f.type !== "prey" || f.removing || f.frozen || fishSpeciesHidden(f.species)) return;
    const d = fishDist(shark.position, f.position);
    if (d < bestD) { bestD = d; best = f; }
  });
  return best;
}

function fishSharkTargeting(shark, dt) {
  const ai = shark.ai;
  if (shark.currentBehavior === "eating") return;
  if (shark.confuseSpin > 0) {
    shark.confuseSpin -= dt;
    // Rotation itself now eases in/out via SharkPhysicsEngine's damped
    // spin velocity instead of a flat `+= 18 * dt * 60` every frame — see
    // applyConfusionDamping(), called each frame from fishUpdateShark so
    // the decay keeps running for a moment even after confuseSpin hits 0.
    shark.currentBehavior = "wandering";
    shark.strikeMode = false;
    // Tracked as its own AI state (distinct from "wandering") purely so
    // blendedSpeedMul() eases the confused shark down to its slow spin
    // speed and back up again afterward, without changing anything the
    // rest of the sim reads off shark.currentBehavior.
    ai.setState(SHARK_STATES.CONFUSED);
    ai.setStrike(false);
    return;
  }
  let target = fishEngine.state.fishes.find((f) => f.id === shark.targetPreyId && !f.removing && !f.frozen);
  if (!target) {
    target = fishNearestPrey(shark);
    shark.targetPreyId = target ? target.id : null;
    shark.huntTimer = 0;
    shark.strikeMode = false;
  }
  if (!target) {
    shark.currentBehavior = "wandering";
    shark.strikeMode = false;
    ai.setState(SHARK_STATES.WANDERING);
    ai.setStrike(false);
    return;
  }
  const d = fishDist(shark.position, target.position);
  shark.huntTimer += dt;
  if (shark.huntTimer > SHARK_CONFUSE_TIMEOUT && d > SHARK_STRIKE_RADIUS) {
    shark.confuseSpin = 1.2;
    shark.targetPreyId = null;
    shark.huntTimer = 0;
    shark.strikeMode = false;
    ai.setState(SHARK_STATES.CONFUSED);
    ai.setStrike(false);
    return;
  }
  const inStrikeRange = d < SHARK_STRIKE_RADIUS;
  shark.strikeMode = inStrikeRange;
  shark.currentBehavior = "hunting";
  ai.setState(SHARK_STATES.HUNTING);
  // Eased toward 0/1 by ai.update(), not snapped — see blendedSpeedMul().
  ai.setStrike(inStrikeRange);
  const cfg = SPECIES_PHYSICS.shark;
  const speedMul = ai.blendedSpeedMul();
  const toPrey = fishSub(target.position, shark.position);
  const perp = fishNorm({ x: -toPrey.y, y: toPrey.x });
  // Ambush weave fades out smoothly as strike intensity ramps up (scaled
  // by 1 - strikeIntensity) instead of snapping off the instant the shark
  // crosses into strike range, so the approach line straightens gradually
  // into the final strike run.
  const ambushOffset = fishScale(perp, 80 * Math.sin(Date.now() * 0.001 + shark.id) * (1 - ai.strikeIntensity));
  const aim = fishAdd(target.position, ambushOffset);
  const desired = fishScale(fishNorm(fishSub(aim, shark.position)), cfg.maxSpeed * speedMul);
  shark.targetVelocity = desired;
  const force = fishSteerSeek(shark.position, shark.velocity, aim, cfg.maxSpeed * speedMul, cfg.maxForce);
  // BUG FIX: this used to hardcode `1` instead of `dt`, applying up to a
  // full second's worth of acceleration every single frame — the shark
  // would nearly teleport to max steering force at 60fps. Real dt keeps
  // this consistent with every other force application in the sim.
  fishApplyForce(shark, force, dt);
  // Gate the catch on strikeIntensity having mostly ramped in, so the bite
  // itself also reads as the payoff of an eased-in strike rather than
  // landing on the very first frame the shark crosses SHARK_STRIKE_RADIUS.
  if (inStrikeRange && ai.strikeIntensity > 0.6 && d < SHARK_CATCH_RADIUS) fishConsumePrey(shark, target);
}

function fishConsumePrey(shark, prey) {
  if (prey.removing) return;
  prey.removing = true;
  prey.frozen = true;
  prey.velocity.x = 0;
  prey.velocity.y = 0;
  prey.el.classList.add("fish-being-eaten");
  setTimeout(() => {
    if (prey.el && prey.el.parentNode) prey.el.parentNode.removeChild(prey.el);
    fishEngine.state.fishes = fishEngine.state.fishes.filter((f) => f.id !== prey.id);
  }, 150);
  fishSpawnFeastBurst(prey.position.x, prey.position.y);
  fishSpawnChompText(prey.position.x, prey.position.y);
  shark.currentBehavior = "eating";
  shark.chewTimer = SHARK_EAT_PAUSE;
  shark.strikeMode = false;
  shark.targetPreyId = null;
  shark.ai.setState(SHARK_STATES.EATING);
  shark.ai.setStrike(false);
  // Velocity is no longer snapped here — SharkPhysicsEngine.
  // applyEatingDeceleration() glides it to rest over the chew, called
  // every frame from the "eating" branch of fishUpdateShark, so the
  // shark visibly coasts to a stop rather than freezing mid-lunge.
  setTimeout(() => {
    const species = FISH_SPECIES_IDS[Math.floor(Math.random() * FISH_SPECIES_IDS.length)];
    if (!fishSpeciesHidden(species)) fishSpawnPrey(species, fishPerimeterSpawn(fishEngine.state.width, fishEngine.state.height));
  }, PREY_RESPAWN_DELAY * 1000);
}

function fishSpawnFeastBurst(x, y) {
  const n = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "feast-particle";
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 8 + Math.random() * 18;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty("--fbx", `${Math.cos(ang) * dist}px`);
    p.style.setProperty("--fby", `${Math.sin(ang) * dist}px`);
    fishEngine.field.appendChild(p);
    setTimeout(() => p.remove(), 700);
  }
}

function fishSpawnChompText(x, y) {
  const t = document.createElement("div");
  t.className = "chomp-text";
  t.textContent = "Chomp!";
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  fishEngine.field.appendChild(t);
  setTimeout(() => t.remove(), 900);
}

function fishUpdatePreyTrick(fish, dt) {
  if (fish.trickActive) {
    fish.trickTimer -= dt;
    if (fish.trickTimer <= 0) {
      const wasTwirl = fish.trickActive === "happy-twirl";
      fish.trickActive = null;
      fish.extraRot = 0;
      fish.scaleX = 1;
      fish.scaleY = 1;
      fish.el.classList.remove("fish-trick-active");
      fish.behaviorTimer = fishRand(8, 15);
      if (wasTwirl) {
        // "...before zooming off in a new direction" — exit the loop-de-loop
        // with a burst of speed along whichever way it was spinning toward,
        // rather than just quietly resuming the normal wander seek.
        const boostSpeed = SPECIES_PHYSICS.guppy.maxSpeed * 1.4;
        fish.velocity.x = Math.cos(fish.wanderAngle) * boostSpeed;
        fish.velocity.y = Math.sin(fish.wanderAngle) * boostSpeed;
      }
    }
    return;
  }
  fish.behaviorTimer -= dt;
  if (fish.behaviorTimer > 0) return;
  fish.el.classList.add("fish-trick-active");
  switch (fish.species) {
    case "clownfish":
      fish.trickActive = "wobbly-roll";
      fish.trickTimer = 1.1;
      break;
    case "betta":
      fish.trickActive = "flourish-flare";
      fish.trickTimer = 1.8;
      fish.scaleX = fish.scaleY = 1.2;
      break;
    case "angelfish":
      fish.trickActive = "curious-peek";
      fish.trickTimer = 2;
      fish.scaleY = 1.15;
      break;
    case "guppy":
      fish.trickActive = "happy-twirl";
      fish.trickTimer = 1.2;
      break;
    case "pufferfish":
      fish.trickActive = "puff-balloon";
      fish.trickTimer = 2;
      fish.scaleX = fish.scaleY = 2.5;
      fish.velocity.y -= 25;
      break;
    default:
      fish.behaviorTimer = fishRand(8, 15);
      fish.el.classList.remove("fish-trick-active");
  }
}

function fishBubbleDodgeForce(fish, bubble, cfg) {
  const away = fishSteerFlee(fish.position, fish.velocity, bubble, FISH_BUBBLE_RADIUS, cfg.maxSpeed * 1.2, cfg.maxForce);
  if (fish.species === "angelfish" || fish.species === "betta") {
    const tangent = fishNorm({ x: -away.y, y: away.x });
    return fishAdd(away, fishScale(tangent, cfg.maxForce * 0.6));
  }
  if (fish.species === "clownfish" || fish.species === "guppy") {
    return fishScale(away, 1.8);
  }
  if (fish.species === "pufferfish") {
    fish.scaleX = fish.scaleY = 0.85;
    return fishScale(away, 0.7);
  }
  return away;
}

function fishUpdatePrey(fish, dt, bubbles, sharks, preyNeighbors) {
  if (fish.frozen || fish.removing || fishSpeciesHidden(fish.species)) return;
  const cfg = SPECIES_PHYSICS[fish.species] || SPECIES_PHYSICS.clownfish;
  // Snapshot before anything this frame (steering, tricks, dodges, panic
  // caps) touches velocity — see fishLimitVelocityChange below.
  const prevVelocity = { x: fish.velocity.x, y: fish.velocity.y };
  let force = fishVec();
  let behavior = "wandering";
  fish.panic = false;

  const mouseD = fishDist(fish.position, fishEngine.state.mouse);
  if (mouseD < FISH_MOUSE_RADIUS) {
    behavior = "fleeing_mouse";
    fish.panic = true;
    // Each fish locks in a fixed lateral bias for the duration of a flee
    // episode so a whole group scatters apart in different directions
    // instead of bolting away from the pointer as one solid block.
    if (fish.scatterSeed === undefined || fish.currentBehavior !== "fleeing_mouse") {
      fish.scatterSeed = fishRand(-1, 1);
    }
    const fleeForce = fishSteerFlee(fish.position, fish.velocity, fishEngine.state.mouse, FISH_MOUSE_RADIUS, cfg.maxSpeed * 1.8, cfg.maxForce * 2.2);
    const lateral = fishNorm({ x: -fleeForce.y, y: fleeForce.x });
    force = fishAdd(force, fishAdd(fleeForce, fishScale(lateral, cfg.maxForce * 0.8 * fish.scatterSeed)));
  } else {
    fish.scatterSeed = undefined;
  }

  let nearestShark = null;
  let sharkD = Infinity;
  sharks.forEach((s) => {
    if (s.currentBehavior === "eating" || s.removing) return;
    const d = fishDist(fish.position, s.position);
    if (d < sharkD) { sharkD = d; nearestShark = s; }
    if (s.targetPreyId === fish.id && d < FISH_SHARK_PANIC_RADIUS) {
      behavior = "evading_shark";
      fish.panic = true;
      force = fishAdd(force, fishSteerFlee(fish.position, fish.velocity, s.position, FISH_SHARK_PANIC_RADIUS, cfg.maxSpeed * 2.5, cfg.maxForce * 2.5));
    }
  });

  bubbles.forEach((b) => {
    const d = fishDist(fish.position, b);
    if (d < FISH_BUBBLE_RADIUS + b.r) {
      if (behavior === "wandering") behavior = "evading_bubble";
      force = fishAdd(force, fishBubbleDodgeForce(fish, b, cfg));
    }
    if (d < 90 && fishLen(fish.velocity) > 60) fishPushBubbleDraft(b, fish.velocity.x, fish.velocity.y);
  });

  // Background separation runs every frame regardless of the dominant
  // behavior above (wandering, fleeing, evading) — a real flock keeps its
  // spacing even mid-panic. Weighted down so it never overrides an actual
  // flee/evade force, only nudges neighbors apart.
  if (preyNeighbors && preyNeighbors.length > 1) {
    force = fishAdd(force, fishScale(fishSteerSeparation(fish, preyNeighbors, FISH_SEPARATION_RADIUS, cfg.maxForce), FISH_SEPARATION_WEIGHT));
  }

  let wanderDesired = null;
  if (behavior === "wandering") {
    fishUpdatePreyTrick(fish, dt);

    // Flourish-flare and curious-peek are meant to be the fish holding
    // still to show off — pausedForTrick skips the wander-seek force
    // below so they actually stop instead of drifting through the pose.
    const pausedForTrick = fish.trickActive === "flourish-flare" || fish.trickActive === "curious-peek";

    if (fish.trickActive === "wobbly-roll") {
      fish.extraRot += 360 * dt; // one full barrel roll over the ~1.1s trick
      // Rapid tail vibration during the roll, overriding the usual
      // speed-based tail values for the duration of the trick.
      fish.tailHz = 3.4;
      fish.tailAmp = 26;
    }
    if (fish.trickActive === "flourish-flare") {
      // Fins "flare" via a sine-wave pulse layered on top of the 20%
      // base inflation, instead of holding one static scale.
      const pulse = Math.sin(Date.now() * 0.012) * 0.08;
      fish.scaleX = fish.scaleY = 1.2 + pulse;
    }
    if (fish.trickActive === "curious-peek") {
      // Side-to-side head wiggle, plus a subtle horizontal squash/stretch
      // to sell the "leaning toward the screen" 3D illusion.
      fish.extraRot = Math.sin(Date.now() * 0.008) * 8;
      fish.scaleX = 1 + Math.sin(Date.now() * 0.006) * 0.06;
    }
    if (fish.trickActive === "happy-twirl") {
      fish.wanderAngle += 12 * dt;
      force = fishAdd(force, fishScale(fishNorm({ x: Math.cos(fish.wanderAngle), y: Math.sin(fish.wanderAngle) }), cfg.maxForce));
    }

    if (pausedForTrick) {
      // Hold position: bleed off velocity instead of seeking a wander
      // target, so the flare/peek reads as an actual pause, not a glide.
      fish.velocity = fishDamp(fish.velocity, 0.02, dt);
    } else {
      const wanderTarget = {
        x: fish.position.x + Math.cos(fish.wanderAngle) * 120,
        y: fish.position.y + Math.sin(fish.wanderAngle) * 80,
      };
      fish.wanderAngle += fishRand(-0.4, 0.4) * dt;
      if (cfg.burst && fish.species === "clownfish") {
        fish.burstPhase += dt;
        if (fish.burstPhase > 1.2) {
          fish.burstPhase = 0;
          wanderDesired = fishScale(fishNorm(fishSub(wanderTarget, fish.position)), cfg.maxSpeed);
          force = fishAdd(force, fishSteerSeek(fish.position, fish.velocity, wanderTarget, cfg.maxSpeed, cfg.maxForce * 1.4));
        } else if (fish.burstPhase > 0.9) {
          // Coast-and-decay between bursts. Uses real elapsed time so the
          // glide feels the same regardless of display refresh rate.
          fish.velocity = fishDamp(fish.velocity, 0.05, dt);
        }
      } else if (cfg.zigzag) {
        fish.zigzagPhase += dt * 8;
        wanderTarget.x += Math.sin(fish.zigzagPhase) * 60;
        wanderDesired = fishScale(fishNorm(fishSub(wanderTarget, fish.position)), cfg.maxSpeed);
        force = fishAdd(force, fishSteerSeek(fish.position, fish.velocity, wanderTarget, cfg.maxSpeed, cfg.maxForce));
      } else if (cfg.vertical && fish.species === "angelfish") {
        wanderTarget.y += Math.sin(Date.now() * 0.001 + fish.id) * 40;
        wanderDesired = fishScale(fishNorm(fishSub(wanderTarget, fish.position)), cfg.maxSpeed * 0.85);
        force = fishAdd(force, fishSteerSeek(fish.position, fish.velocity, wanderTarget, cfg.maxSpeed * 0.85, cfg.maxForce));
      } else {
        wanderDesired = fishScale(fishNorm(fishSub(wanderTarget, fish.position)), cfg.maxSpeed);
        force = fishAdd(force, fishSteerSeek(fish.position, fish.velocity, wanderTarget, cfg.maxSpeed, cfg.maxForce * 0.7));
      }
    }
  }
  // targetVelocity tracks the fish's current steering intent (whichever
  // behavior is dominant this frame) — read by rendering for gaze/tail cues.
  fish.targetVelocity = wanderDesired || fishScale(fishNorm(force), cfg.maxSpeed);

  fish.currentBehavior = behavior;
  fishApplyForce(fish, force, dt);
  const speedCap = fish.panic ? cfg.maxSpeed * 2.5 : cfg.maxSpeed;
  fish.velocity = fishLimit(fish.velocity, speedCap);
  fishLimitVelocityChange(fish, prevVelocity, dt, cfg);
  fish.position.x += fish.velocity.x * dt;
  fish.position.y += fish.velocity.y * dt;
  fishWrapBounds(fish, fishEngine.state.width, fishEngine.state.height, fish.size * 0.9);
  if (!fish.trickActive && behavior !== "evading_bubble") {
    fish.scaleX = fish.scaleY = 1;
  }

  const spd = fishLen(fish.velocity);
  if (fish.trickActive !== "wobbly-roll") {
    fish.tailHz = fishLerp(0.35, fish.panic ? 2.2 : 1.4, Math.min(spd / cfg.maxSpeed, 1));
    fish.tailAmp = fish.panic ? 22 : fishLerp(8, 16, Math.min(spd / cfg.maxSpeed, 1));
  }
  // Integrate tailHz -> swimPhase over the real frame dt (proper phase
  // accumulation, not a Date.now()-driven trig call), consumed directly by
  // fishRenderEntity to write the tail-wag/body-ripple transforms — see
  // the swim-phase accumulator notes above Part 8's constants.
  fish.swimPhase = (fish.swimPhase || 0) + fish.tailHz * dt * TWO_PI;
  // Part 8: torso ripple amplitude/scale, keyed off the same speed ratio
  // (and swim frequency, via --tail-hz driving the CSS keyframe timing —
  // see fish-body-ripple-dynamic in style.css) so a fish gliding slowly
  // barely flexes while a full-speed dart or a panicked flee whips the
  // whole body through a visible S-curve. flexMul lets round/stiff-bodied
  // species (pufferfish) ripple far less than slender ones (guppy) at the
  // same speed.
  const speedRatio = Math.min(spd / cfg.maxSpeed, 1);
  const flexMul = cfg.flexMul !== undefined ? cfg.flexMul : 1;
  fish.bodyFlexAmp = flexMul * (fish.panic
    ? FISH_BODY_FLEX_PANIC_DEG
    : fishLerp(FISH_BODY_FLEX_IDLE_DEG, FISH_BODY_FLEX_CRUISE_DEG, speedRatio));
  fish.bodyFlexScale = flexMul * (fish.panic
    ? FISH_BODY_FLEX_SCALE_PANIC
    : fishLerp(FISH_BODY_FLEX_SCALE_IDLE, FISH_BODY_FLEX_SCALE_CRUISE, speedRatio));
  if (Math.abs(fish.velocity.x) > 2) fish.orientEl.style.transform = fish.velocity.x < 0 ? "scaleX(-1)" : "scaleX(1)";
  fish.angle = Math.atan2(fish.velocity.y, Math.abs(fish.velocity.x) + 0.001) * (180 / Math.PI) * 0.35;

  let look = fishNorm(fish.velocity);
  if (nearestShark && sharkD < FISH_SHARK_PANIC_RADIUS) {
    look = fishNorm(fishSub(fish.position, nearestShark.position));
  }
  if (fish.pupilEl && fish.pupilBase) {
    fish.pupilOffset.x = fishLerp(fish.pupilOffset.x, look.x * 1.8, 0.08);
    fish.pupilOffset.y = fishLerp(fish.pupilOffset.y, look.y * 1.2, 0.08);
    fish.pupilEl.setAttribute("cx", (fish.pupilBase.cx + fish.pupilOffset.x).toFixed(2));
    fish.pupilEl.setAttribute("cy", (fish.pupilBase.cy + fish.pupilOffset.y).toFixed(2));
  }
}

function fishUpdateShark(shark, dt) {
  if (shark.removing) return;
  const ai = shark.ai;
  const physics = shark.physics;
  // Advance the state-blend clock and ease strikeIntensity toward its
  // target every frame, regardless of which behavior branch runs below —
  // this is what turns setState()/setStrike() calls (which just record an
  // intent) into an actual gradual ramp over SHARK_STATE_TRANSITION_DURATION.
  ai.update(dt);
  // Called unconditionally, every frame, regardless of branch: this is what
  // lets the confusion spin's rotation wind down smoothly for a moment
  // after shark.confuseSpin hits 0, instead of the rotation just cutting
  // off the instant the timer runs out.
  physics.applyConfusionDamping(shark, dt);

  if (shark.currentBehavior === "eating") {
    shark.chewTimer -= dt;
    // A single decaying "chomp" snap, not a continuous wobble: the old
    // `Math.sin(Date.now() * 0.02)` ran off wall-clock time for the whole
    // SHARK_EAT_PAUSE (1.5s), swinging back and forth ~5 times. Since the
    // shark's heading is frozen while it decelerates to a stop here (see
    // SharkPhysicsEngine.integrate, gated on speed > 2), that repeated
    // swing was the only visible motion — reading as the shark spinning
    // in place rather than biting. chewProgress instead runs 0 -> 1 once
    // over the eat pause, and the amplitude decays to 0 alongside it, so
    // it reads as one bite snap that settles rather than a sustained spin.
    const chewProgress = fishClamp(1 - shark.chewTimer / SHARK_EAT_PAUSE, 0, 1);
    shark.extraRot = Math.sin(chewProgress * Math.PI * 2.2) * 5 * (1 - chewProgress);
    // Glide velocity to rest and keep integrating position/heading through
    // the chew (rather than freezing shark.position outright) so the
    // deceleration itself is visible as a coast-to-a-stop.
    physics.applyEatingDeceleration(shark, dt);
    physics.integrate(shark, ai, dt);
    fishWrapBounds(shark, fishEngine.state.width, fishEngine.state.height, shark.size * 0.9);
    // Keep swimPhase advancing, but decaying toward stillness with the
    // same deceleration curve as velocity, so the tail settles rather than
    // freezing mid-wag on whatever phase it happened to be at.
    shark.tailHz = fishLerp(shark.tailHz || 0.4, 0, fishClamp(dt * SHARK_EAT_DECEL_RATE, 0, 1));
    shark.swimPhase = (shark.swimPhase || 0) + shark.tailHz * dt * TWO_PI;
    if (shark.chewTimer <= 0) {
      shark.currentBehavior = "wandering";
      ai.setState(SHARK_STATES.WANDERING);
      shark.extraRot = 0;
    }
    return;
  }
  // Snapshot before targeting/steering/strike-mode logic touches velocity
  // — see fishLimitVelocityChange. Combined with ai.blendedSpeedMul()
  // below (which eases the speed cap instead of doubling/halving it
  // outright on a strike-mode toggle), this is what keeps state switches
  // from snapping the shark's speed in one frame instead of easing into it.
  const prevVelocity = { x: shark.velocity.x, y: shark.velocity.y };
  fishSharkTargeting(shark, dt);
  const cfg = SPECIES_PHYSICS.shark;
  if (shark.currentBehavior === "wandering") {
    const wanderTarget = {
      x: shark.position.x + Math.cos(shark.wanderAngle) * 160,
      y: shark.position.y + Math.sin(shark.wanderAngle) * 100,
    };
    shark.wanderAngle += fishRand(-0.3, 0.3) * dt;
    // Uses the same blended multiplier as hunting/confused so coming out
    // of a confused spin (0.25x) or a strike (up to 2x) into ordinary
    // wandering (0.6x) ramps smoothly too, rather than only the
    // hunting <-> strike transition being eased.
    const speedMul = ai.blendedSpeedMul();
    shark.targetVelocity = fishScale(fishNorm(fishSub(wanderTarget, shark.position)), cfg.maxSpeed * speedMul);
    fishApplyForce(shark, fishSteerSeek(shark.position, shark.velocity, wanderTarget, cfg.maxSpeed * speedMul, cfg.maxForce * 0.5), dt);
  }
  shark.velocity = fishLimit(shark.velocity, cfg.maxSpeed * fishLerp(1, 2, ai.strikeIntensity));
  // Part 3: sharks have no swim bladder, so — outside the deliberate
  // eating-pause coast-to-a-stop handled above — velocity is never
  // allowed to sink toward zero the way a resting bony fish's could.
  // Confusion's 0.25x multiplier is the slowest sanctioned state, so the
  // floor sits just under that rather than under ordinary wandering speed.
  const currentSpeed = fishLen(shark.velocity);
  if (currentSpeed < cfg.minSpeed) {
    // Almost-zero velocity has no meaningful direction to normalize, so
    // fall back to the shark's smoothed heading (physics.heading) rather
    // than snapping to an arbitrary axis.
    const dir = currentSpeed > 0.01 ? fishScale(shark.velocity, 1 / currentSpeed) : physics.heading;
    shark.velocity = fishScale(dir, cfg.minSpeed);
  }
  fishLimitVelocityChange(shark, prevVelocity, dt, cfg);
  // Applies the (now blended/limited) velocity to position, and eases the
  // rendered heading toward it via Vector2.lerp rather than reading angle
  // straight off shark.velocity — see SharkPhysicsEngine.integrate.
  physics.integrate(shark, ai, dt);
  fishWrapBounds(shark, fishEngine.state.width, fishEngine.state.height, shark.size * 0.9);
  shark.tailHz = fishLerp(0.4, 1.1, Math.min(fishLen(shark.velocity) / cfg.maxSpeed, 1));
  shark.swimPhase = (shark.swimPhase || 0) + shark.tailHz * dt * TWO_PI;
}

function fishRenderEntity(fish) {
  if (!fish.el || fish.removing) return;
  const rot = fish.angle + (fish.extraRot || 0);
  fish.el.style.transform = `translate3d(${fish.position.x.toFixed(1)}px,${fish.position.y.toFixed(1)}px,0) rotate(${rot.toFixed(2)}deg) scale(${fish.scaleX || 1},${fish.scaleY || 1})`;

  const phase = fish.swimPhase || 0;

  // Part 7: organic spine flex, sharks only — see SharkPhysicsEngine.integrate.
  // --spine-bend still drives the primary neck-joint rotation via a plain
  // (non-keyframed) CSS transform, which is why it was never the source of
  // the jitter — kept as-is.
  if (fish.type === "shark") {
    fish.el.style.setProperty("--spine-bend", `${(fish.spineBend || 0).toFixed(2)}deg`);

    // Segmented tail sway (secondary joint) + pectoral flap: previously
    // CSS @keyframes with animation-duration bound to the ever-changing
    // --tail-hz, which caused the reported vibration (see the swim-phase
    // accumulator notes above Part 8's constants). Now computed directly
    // from swimPhase and written as a static rotate() — same visual shape
    // as the old keyframes (a symmetric arch: base 1deg, amplitude 13deg,
    // -12deg/+14deg range), just driven by a continuous phase instead of a
    // restarting CSS timeline. Segment 1 carries more of spine-bend
    // (heaviest at the tail tip), segment 2 less (closer to the body) —
    // matches the original weighting.
    const spineBend = fish.spineBend || 0;
    if (fish.tailSegEls && fish.tailSegEls.length) {
      const seg1 = 1 - 13 * Math.cos(phase) + spineBend * 0.5;
      fish.tailSegEls[0].style.transform = `rotate(${seg1.toFixed(2)}deg)`;
      if (fish.tailSegEls[1]) {
        const seg2 = 1 - 13 * Math.cos(phase * SHARK_TAIL_SEG2_RATE) + spineBend * 0.3;
        fish.tailSegEls[1].style.transform = `rotate(${seg2.toFixed(2)}deg)`;
      }
    }
    // Part 1/3: traveling sine-wave propulsion. The tail assembly above
    // already carries the bulk of the visible beat; this adds a much
    // smaller-amplitude flex on the torso itself, at the *same* frequency
    // but with no phase lag, so the wave reads as originating near the
    // head and traveling back into the (larger-amplitude, lagged) tail
    // beat rather than the body staying rigid while only the tail moves.
    // Pectoral fins are deliberately NOT driven here — real pectorals are
    // stiff lift surfaces, not flexible paddles, so they stay static.
    if (fish.torsoFlexEl) {
      const torsoSkew = Math.sin(phase) * SHARK_TORSO_FLEX_DEG;
      fish.torsoFlexEl.style.transform = `skewY(${torsoSkew.toFixed(2)}deg)`;
    }
    // Part 1: soft-body vertex displacement on the dorsal fin's trailing
    // edge — a light, higher-frequency flutter layered on top of the
    // fin's own fixed rake, standing in for water resistance flexing the
    // fin's rear membrane as the shark swims. The caudal fin's equivalent
    // trailing-edge give is already carried by the tail-segment sway above.
    if (fish.dorsalFlexEl) {
      const dorsalFlutter = Math.sin(phase * SHARK_DORSAL_FLUTTER_RATE) * SHARK_DORSAL_FLUTTER_DEG;
      fish.dorsalFlexEl.style.transform = `skewX(${dorsalFlutter.toFixed(2)}deg)`;
    }
  } else {
    // Tail wag, prey only: same sine shape the old fish-tail-wag-dynamic
    // keyframe produced (amplitude = tailAmp, symmetric about 0), now a
    // static rotate() driven by swimPhase instead of a restarting
    // CSS-timed animation.
    if (fish.tailEl) {
      const tailAngle = Math.sin(phase) * (fish.tailAmp || 16);
      fish.tailEl.style.transform = `rotate(${tailAngle.toFixed(2)}deg)`;
    }
    // Part 8: organic torso ripple, prey fish only — see the body-flex
    // computation in fishUpdatePrey. Skipped for sharks, whose single
    // .shark-body silhouette is already carried by the segmented
    // spine-bend/tail-sway system above. bodyPhase keeps the old ripple's
    // constant-fraction-of-cycle lag behind the tail beat so the wave
    // still reads as traveling head-to-tail into the fin.
    if (fish.bodyEl) {
      const bodyPhase = phase - FISH_BODY_FLEX_PHASE_OFFSET;
      const wave = Math.sin(bodyPhase);
      const amp = fish.bodyFlexAmp || FISH_BODY_FLEX_IDLE_DEG;
      const scaleAmt = fish.bodyFlexScale || FISH_BODY_FLEX_SCALE_IDLE;
      const skew = wave * amp;
      const scaleX = 1 + wave * scaleAmt;
      fish.bodyEl.style.transform = `skewY(${skew.toFixed(2)}deg) scaleX(${scaleX.toFixed(4)})`;
    }
  }
  if (fish.species === "guppy") fishRenderGuppyExtras(fish, phase);

  fish.el.classList.toggle("fish-panic", !!fish.panic);
  fish.el.dataset.behavior = fish.currentBehavior;
}

// ---- Part 3: guppy soft-body tail cloth + trailing fins ------------------
// Driven every frame off the SAME swimPhase accumulator as the ordinary
// tail wag (fed by real dt via fish.tailHz — see fishUpdatePrey), so this
// stays frame-rate independent and never touches @keyframes/animation-
// duration (the exact bug the swim-phase system above was built to avoid).
// GUPPY_PANEL_LAG/AMP_GROWTH turn a single sine into a cheap stand-in for
// a spring-mass cloth chain: each panel out toward the tail tip lags
// further behind the body's beat (inertia dragging the fin membrane) and
// swings a little wider (a whip tip overshooting its base), and a faster,
// smaller secondary sine riding on top reads as the fin fabric's own
// higher-frequency ripple rather than one rigid flap.
const GUPPY_PANEL_LAG = 0.55; // rad phase lag added per panel index
const GUPPY_PANEL_AMP_GROWTH = 0.22; // fractional amplitude growth per panel
const GUPPY_RIPPLE_FREQ = 2.6; // secondary ripple frequency, x the tail beat
const GUPPY_RIPPLE_AMP = 5; // deg, scaled by panel index / panel count
const GUPPY_DORSAL_LAG = 0.9;
const GUPPY_DORSAL_AMP = 11;
const GUPPY_PEC_HZ = 0.016; // deg/ms-scale shimmer rate (Date.now()-driven, like the other trick pulses in this file)
function fishRenderGuppyExtras(fish, phase) {
  const cfg = SPECIES_PHYSICS.guppy;
  const speedRatio = Math.min(fishLen(fish.velocity) / cfg.maxSpeed, 1);
  const baseAmp = fish.tailAmp || 16;

  // Part 3: cloth-panel wave propagation down the male ornamental tail.
  if (fish.tailPanelEls && fish.tailPanelEls.length) {
    const n = fish.tailPanelEls.length;
    fish.tailPanelEls.forEach((el, i) => {
      const lag = i * GUPPY_PANEL_LAG;
      const amp = baseAmp * (1 + i * GUPPY_PANEL_AMP_GROWTH);
      const primary = Math.sin(phase - lag) * amp;
      const ripple = Math.sin(phase * GUPPY_RIPPLE_FREQ - lag * 1.4) * (GUPPY_RIPPLE_AMP * (i / n));
      el.style.transform = `rotate(${(primary + ripple).toFixed(2)}deg)`;
    });
  }

  // Part 1: dorsal ribbon trailing/catching fluid drag — same lagged-sine
  // idea as the tail panels, just one element, and scaled up a bit with
  // speed so it visibly streams out behind a fast dart.
  if (fish.dorsalRibbonEl) {
    const drift = Math.sin(phase - GUPPY_DORSAL_LAG) * GUPPY_DORSAL_AMP * (0.45 + speedRatio * 0.65);
    fish.dorsalRibbonEl.style.transform = `rotate(${drift.toFixed(2)}deg)`;
  }

  // Part 3: high-frequency pectoral shimmer for stability during hovers —
  // stays lively at low speed (hoverBoost near 1) and settles down during
  // a hard dash so it doesn't compete visually with the tail beat/dash.
  if (fish.pectoralEls && fish.pectoralEls.length) {
    const hoverBoost = 1 - speedRatio * 0.7;
    const t = (fish.pecPhase || 0) + Date.now() * GUPPY_PEC_HZ;
    fish.pectoralEls.forEach((el, i) => {
      const flick = Math.sin(t + i * 1.7) * 6 * hoverBoost;
      el.style.transform = `rotate(${flick.toFixed(2)}deg) scaleY(${(1 - Math.abs(flick) * 0.01).toFixed(3)})`;
    });
  }

  // Part 2: iridescent glint — a slow hue drift plus a contribution from
  // the fish's own current heading, so the shine visibly shifts as the
  // fish turns relative to the (implied) light source, not just over time.
  // Throttled to every 3rd frame: unlike the transform writes above (which
  // the compositor handles for free), a `filter` change forces an actual
  // repaint of the element. Doing that for every fish on every animation
  // frame is real, avoidable main-thread cost that's easy to not notice in
  // isolation but adds up with everything else fighting for frame budget
  // during a scroll. The drift is slow enough that 20 updates/sec reads
  // identically to 60.
  if (fish.shineEl) {
    fish._shineSkip = (fish._shineSkip || 0) + 1;
    if (fish._shineSkip >= 3) {
      fish._shineSkip = 0;
      const irid = Math.sin(phase * 0.35 + (fish.hueSeed || 0) * 0.02) * 24 + (fish.angle || 0) * 0.3;
      fish.shineEl.style.filter = `hue-rotate(${irid.toFixed(1)}deg)`;
    }
  }
}

function fishClearSharkThreats() {
  fishEngine.state.fishes.forEach((f) => {
    if (f.type !== "prey") return;
    if (f.currentBehavior === "evading_shark") f.currentBehavior = "wandering";
    f.panic = false;
  });
}

function fishTick(now) {
  if (!fishEngine.state.running) return;
  if (!document.body.classList.contains("bubbly-mode") || !document.body.classList.contains("fish-mode-on")) {
    fishEngine.rafId = requestAnimationFrame(fishTick);
    return;
  }
  // NOTE: fishTick used to fully skip the update+render pass while
  // "is-scrolling" was set, on the theory that a brief pause mid-swim would
  // be imperceptible. In practice the class stays on body for the entire
  // scroll gesture (it's re-armed on every scroll event, not just once), so
  // that "brief pause" was actually the whole scroll duration — which is
  // exactly the visible fish-freeze bug this was meant to prevent, not fix.
  // The real per-frame cost during scroll was backdrop-filter re-blurring
  // every glass card, and that's already handled cheaply in CSS (see the
  // body.is-scrolling.bubbly-mode rules in style.css, which drop blur to a
  // flat fill for the duration). Combined with fishGetBubblePositions()
  // reusing last frame's bubble positions instead of a fresh layout read
  // during scroll, that's enough — fish keep swimming normally here.
  const dt = Math.min((now - (fishEngine.state.lastTime || now)) / 1000, 0.05);
  fishEngine.state.lastTime = now;
  // width/height are kept current by fishHandleResize (debounced on the
  // "resize" event) rather than re-read every frame — re-reading here on
  // top of that just meant a fish could still be using stale bounds for
  // one frame right after a resize while also doing needless layout reads.

  const bubbles = fishGetBubblePositions();
  const sharks = fishEngine.state.fishes.filter((f) => f.type === "shark" && !f.removing);
  // Computed once per tick (not once per fish) — fishSteerSeparation is
  // O(n) per fish, so building this list per-entity would make the whole
  // pass O(n^2) filters on top of the O(n^2) distance checks it already
  // needs. frozen/removing prey are excluded up front so eaten fish don't
  // participate as either pusher or pushee mid-despawn.
  const preyNeighbors = fishEngine.state.fishes.filter((f) => f.type === "prey" && !f.removing && !f.frozen);

  fishEngine.state.fishes.forEach((f) => {
    if (f.type === "prey") fishUpdatePrey(f, dt, bubbles, sharks, preyNeighbors);
    else if (f.type === "shark") fishUpdateShark(f, dt);
    fishRenderEntity(f);
  });

  fishEngine.rafId = requestAnimationFrame(fishTick);
}

function fishStartEngine() {
  if (fishEngine.state.running || PREFERS_REDUCED_MOTION) return;
  fishEngine.state.running = true;
  fishEngine.state.lastTime = performance.now();
  fishEngine.rafId = requestAnimationFrame(fishTick);
}

function fishStopEngine() {
  fishEngine.state.running = false;
  if (fishEngine.rafId) cancelAnimationFrame(fishEngine.rafId);
  fishEngine.rafId = null;
}

// Dynamically manages screen boundaries on resize: rescales every fish's
// position proportionally to the new viewport (not just wrap-on-next-cross)
// so a fish sitting mid-screen doesn't end up stranded far outside the
// visible area after a large or sudden viewport change (e.g. rotating a
// device, or a browser window being resized a lot), and clamps to the new
// bounds so nothing is left waiting off-canvas indefinitely.
function fishHandleResize() {
  const newW = window.innerWidth;
  const newH = window.innerHeight;
  const oldW = fishEngine.state.width || newW;
  const oldH = fishEngine.state.height || newH;
  const scaleX = oldW > 0 ? newW / oldW : 1;
  const scaleY = oldH > 0 ? newH / oldH : 1;
  fishEngine.state.fishes.forEach((f) => {
    const pad = (f.size || 40) * 0.9;
    f.position.x = fishClamp(f.position.x * scaleX, -pad, newW + pad);
    f.position.y = fishClamp(f.position.y * scaleY, -pad, newH + pad);
  });
  fishEngine.state.width = newW;
  fishEngine.state.height = newH;
}

// Backgrounded/minimized tabs still get rAF callbacks throttled but not
// stopped in every browser, and — more importantly — a tab that's merely
// covered by another window or scrolled to a background browser tab keeps
// paying the full per-frame fish-physics + repaint cost for zero visible
// benefit. Pausing on hidden and resuming on visible frees that budget up,
// and resetting lastTime on resume stops the huge dt a long hidden period
// would otherwise produce from being treated as one giant physics step.
function fishBindVisibilityPause() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      fishStopEngine();
    } else if (
      document.body.classList.contains("bubbly-mode") &&
      document.body.classList.contains("fish-mode-on")
    ) {
      fishEngine.state.lastTime = performance.now();
      fishStartEngine();
    }
  });
}

function fishBindListeners() {
  if (fishEngine.listenersBound) return;
  fishEngine.listenersBound = true;
  fishBindVisibilityPause();
  const trackMouse = (e) => {
    fishEngine.state.mouse.x = e.clientX;
    fishEngine.state.mouse.y = e.clientY;
  };
  document.addEventListener("pointermove", trackMouse, { passive: true });
  document.addEventListener("mousemove", trackMouse, { passive: true });
  const trackTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    fishEngine.state.mouse.x = t.clientX;
    fishEngine.state.mouse.y = t.clientY;
  };
  document.addEventListener("touchstart", trackTouch, { passive: true });
  document.addEventListener("touchmove", trackTouch, { passive: true });
  // A lifted finger stops threatening the fish — reset off-screen instead
  // of leaving the last touch point as a permanent scare zone.
  document.addEventListener("touchend", () => {
    fishEngine.state.mouse.x = -9999;
    fishEngine.state.mouse.y = -9999;
  }, { passive: true });
  window.addEventListener("resize", () => {
    // Debounced: resize fires continuously while dragging a window edge,
    // and rescaling every fish on every one of those events is wasted
    // work — settle on the final size instead.
    clearTimeout(fishEngine.resizeTimer);
    fishEngine.resizeTimer = setTimeout(fishHandleResize, 120);
  }, { passive: true });

  // ---- Scroll performance: shed glass-blur cost while scrolling --------
  // In Liquid Interface every .card (plus each .definition-card/.image-card
  // nested inside it) carries its own backdrop-filter blur, sitting above
  // the constantly-animating #bubble-field/#fish-field. Every one of those
  // blur regions has to be recomposited by the browser on every scroll
  // frame, which competes with fishTick's own rAF work for the same frame
  // budget — that's what makes the fish visibly stutter/hang while
  // scrolling. Toggling "is-scrolling" (see style.css) drops backdrop-filter
  // to a flat, nearly-free fill for the duration of the scroll and restores
  // the real glass look a moment after it settles.
  window.addEventListener("scroll", () => {
    document.body.classList.add("is-scrolling");
    clearTimeout(fishEngine.scrollEndTimer);
    fishEngine.scrollEndTimer = setTimeout(() => {
      document.body.classList.remove("is-scrolling");
    }, 200);
  }, { passive: true });
}

window.addShark = function addShark() {
  if (!fishEngine.built) initFishField();
  if (!getFishMode()) return null;
  return fishSpawnShark();
};

window.removeShark = function removeShark() {
  const sharks = fishEngine.state.fishes.filter((f) => f.type === "shark" && !f.removing);
  if (!sharks.length) {
    fishClearSharkThreats();
    return null;
  }
  const oldest = sharks[0];
  oldest.removing = true;
  oldest.el.classList.add("shark-fade-out");
  setTimeout(() => {
    if (oldest.el && oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
    fishEngine.state.fishes = fishEngine.state.fishes.filter((f) => f.id !== oldest.id);
    if (!fishEngine.state.fishes.some((f) => f.type === "shark")) fishClearSharkThreats();
  }, 300);
  return oldest;
};

function getFishMode() {
  try {
    const v = localStorage.getItem(FISH_MODE_STORAGE);
    return v === null ? DEFAULT_FISH_MODE : v === "true";
  } catch (err) {
    return DEFAULT_FISH_MODE;
  }
}

function setFishMode(on) {
  try {
    localStorage.setItem(FISH_MODE_STORAGE, String(!!on));
  } catch (err) {
    // non-fatal
  }
}

function getFishSpeciesPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(FISH_SPECIES_STORAGE));
    if (raw && typeof raw === "object") {
      const merged = { ...DEFAULT_FISH_SPECIES_PREFS };
      FISH_SPECIES_IDS.forEach((id) => {
        if (typeof raw[id] === "boolean") merged[id] = raw[id];
      });
      return merged;
    }
  } catch (err) {
    // fall through to defaults
  }
  return { ...DEFAULT_FISH_SPECIES_PREFS };
}

function setFishSpeciesEnabled(id, on) {
  try {
    const prefs = getFishSpeciesPrefs();
    prefs[id] = !!on;
    localStorage.setItem(FISH_SPECIES_STORAGE, JSON.stringify(prefs));
  } catch (err) {
    // non-fatal
  }
}

// Mirrors applyGlassPrefs()'s pattern: sets body classes the CSS
// consumes directly, and syncs the Display panel's own checkboxes so
// they reflect saved state whenever the panel (re)opens.
function applyFishPrefs() {
  const on = getFishMode();
  document.body.classList.toggle("fish-mode-on", on);
  const prefs = getFishSpeciesPrefs();
  FISH_SPECIES_IDS.forEach((id) => {
    document.body.classList.toggle(`fish-hide-${id}`, !prefs[id]);
  });

  if (fishModeToggle) fishModeToggle.checked = on;
  fishSpeciesCheckboxes.forEach((cb) => {
    cb.checked = !!prefs[cb.dataset.species];
  });
  if (fishSpeciesControls) fishSpeciesControls.classList.toggle("disabled", !on);
  const sharkControls = document.querySelector(".fish-shark-controls");
  if (sharkControls) sharkControls.classList.toggle("disabled", !on);

  const sharkVariantPrefs = getSharkVariantPrefs();
  sharkVariantCheckboxes.forEach((cb) => {
    cb.checked = !!sharkVariantPrefs[cb.dataset.variant];
  });
  if (sharkVariantControls) sharkVariantControls.classList.toggle("disabled", !on);
}

const FISH_FIELD_COUNT = FISH_PREY_COUNT;
let fishFieldBuilt = false;

function initFishField() {
  if (fishFieldBuilt || PREFERS_REDUCED_MOTION) return;
  fishEngine.field = document.getElementById("fish-field");
  if (!fishEngine.field) return;
  fishFieldBuilt = true;
  fishEngine.built = true;
  fishEngine.state.width = window.innerWidth;
  fishEngine.state.height = window.innerHeight;
  fishBindListeners();

  FISH_SPECIES_IDS.forEach((species, i) => {
    const count = Math.ceil(FISH_PREY_COUNT / FISH_SPECIES_IDS.length);
    for (let j = 0; j < count && fishEngine.state.fishes.filter((f) => f.type === "prey").length < FISH_PREY_COUNT; j++) {
      if (!fishSpeciesHidden(species)) fishSpawnPrey(species);
    }
  });
  while (fishEngine.state.fishes.filter((f) => f.type === "prey").length < FISH_PREY_COUNT) {
    const species = FISH_SPECIES_IDS[Math.floor(Math.random() * FISH_SPECIES_IDS.length)];
    fishSpawnPrey(species);
  }
  fishSpawnShark();
  fishStartEngine();
}

// The three glass sliders — transparency, blur, and tint — only make
// sense once Liquid Interface is on, so they're read/written the same
// way as the other display prefs but applied as CSS custom properties
// that the body.bubbly-mode rules in style.css consume directly.
function getGlassTransparency() {
  try {
    const v = parseInt(localStorage.getItem(GLASS_TRANSPARENCY_STORAGE), 10);
    return Number.isFinite(v) ? clampRange(v, GLASS_TRANSPARENCY_MIN, GLASS_TRANSPARENCY_MAX, DEFAULT_GLASS_TRANSPARENCY) : DEFAULT_GLASS_TRANSPARENCY;
  } catch (err) {
    return DEFAULT_GLASS_TRANSPARENCY;
  }
}

function setGlassTransparency(n) {
  try {
    localStorage.setItem(GLASS_TRANSPARENCY_STORAGE, String(clampRange(n, GLASS_TRANSPARENCY_MIN, GLASS_TRANSPARENCY_MAX, DEFAULT_GLASS_TRANSPARENCY)));
  } catch (err) {
    // non-fatal
  }
}

function getGlassBlur() {
  try {
    const v = parseInt(localStorage.getItem(GLASS_BLUR_STORAGE), 10);
    return Number.isFinite(v) ? clampRange(v, GLASS_BLUR_MIN, GLASS_BLUR_MAX, DEFAULT_GLASS_BLUR) : DEFAULT_GLASS_BLUR;
  } catch (err) {
    return DEFAULT_GLASS_BLUR;
  }
}

function setGlassBlur(n) {
  try {
    localStorage.setItem(GLASS_BLUR_STORAGE, String(clampRange(n, GLASS_BLUR_MIN, GLASS_BLUR_MAX, DEFAULT_GLASS_BLUR)));
  } catch (err) {
    // non-fatal
  }
}

function getGlassTint() {
  try {
    const v = parseInt(localStorage.getItem(GLASS_TINT_STORAGE), 10);
    return Number.isFinite(v) ? clampRange(v, GLASS_TINT_MIN, GLASS_TINT_MAX, DEFAULT_GLASS_TINT) : DEFAULT_GLASS_TINT;
  } catch (err) {
    return DEFAULT_GLASS_TINT;
  }
}

function setGlassTint(n) {
  try {
    localStorage.setItem(GLASS_TINT_STORAGE, String(clampRange(n, GLASS_TINT_MIN, GLASS_TINT_MAX, DEFAULT_GLASS_TINT)));
  } catch (err) {
    // non-fatal
  }
}

// Transparency is stored/shown as "how see-through", but the CSS consumes
// it as an alpha percentage (how opaque the glass is), so it's inverted
// here — dragging the slider up makes the interface more transparent.
function applyGlassPrefs() {
  const root = document.documentElement.style;
  root.setProperty("--glass-alpha", `${100 - getGlassTransparency()}%`);
  root.setProperty("--glass-blur", `${getGlassBlur()}px`);
  root.setProperty("--glass-tint", `${getGlassTint()}%`);
  glassControls.classList.toggle("hidden", !getBubblyMode());
}

function applyDisplayPrefs() {
  const root = document.documentElement.style;
  root.setProperty("--search-bar-width", `${getSearchWidth()}px`);
  root.setProperty("--def-text-scale", String(getDefTextScale() / 100));
  root.setProperty("--img-thumb-size", `${getImgThumbSize()}px`);
  applyBubblyMode();
  applyGlassPrefs();
  applyFishPrefs();
}

bubblyModeToggle.addEventListener("change", () => {
  setBubblyMode(bubblyModeToggle.checked);
  applyBubblyMode();
  applyGlassPrefs();
});

if (bubbleModeToggle) {
  bubbleModeToggle.addEventListener("change", () => {
    setBubbleMode(bubbleModeToggle.checked);
    applyBubbleMode();
  });
}

if (fishModeToggle) {
  fishModeToggle.addEventListener("change", () => {
    setFishMode(fishModeToggle.checked);
    if (fishModeToggle.checked) initFishField();
    applyFishPrefs();
  });
}

fishSpeciesCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    setFishSpeciesEnabled(cb.dataset.species, cb.checked);
    applyFishPrefs();
  });
});

sharkVariantCheckboxes.forEach((cb) => {
  cb.addEventListener("change", () => {
    setSharkVariantEnabled(cb.dataset.variant, cb.checked);
    // A checkbox may get vetoed by setSharkVariantEnabled's "keep at
    // least one enabled" guard — re-sync from the actual saved prefs
    // rather than trusting the checkbox's own new state.
    applyFishPrefs();
  });
});

if (addSharkBtn) {
  addSharkBtn.addEventListener("click", () => {
    if (getFishMode()) window.addShark();
  });
}
if (removeSharkBtn) {
  removeSharkBtn.addEventListener("click", () => {
    window.removeShark();
  });
}

glassTransparencyInput.addEventListener("input", () => {
  glassTransparencyValue.textContent = `${glassTransparencyInput.value}%`;
  setGlassTransparency(glassTransparencyInput.value);
  applyGlassPrefs();
});

glassBlurInput.addEventListener("input", () => {
  glassBlurValue.textContent = `${glassBlurInput.value}px`;
  setGlassBlur(glassBlurInput.value);
  applyGlassPrefs();
});

glassTintInput.addEventListener("input", () => {
  glassTintValue.textContent = `${glassTintInput.value}%`;
  setGlassTint(glassTintInput.value);
  applyGlassPrefs();
});

displayToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (displayPanel.classList.contains("hidden")) initDisplayUI();
  displayPanel.classList.toggle("hidden");
});

searchWidthInput.addEventListener("input", () => {
  searchWidthValue.textContent = `${searchWidthInput.value}px`;
  setSearchWidth(searchWidthInput.value);
  applyDisplayPrefs();
});

defTextSizeInput.addEventListener("input", () => {
  defTextSizeValue.textContent = `${defTextSizeInput.value}%`;
  setDefTextScale(defTextSizeInput.value);
  applyDisplayPrefs();
});

imgThumbSizeInput.addEventListener("input", () => {
  imgThumbSizeValue.textContent = `${imgThumbSizeInput.value}px`;
  setImgThumbSize(imgThumbSizeInput.value);
  applyDisplayPrefs();
});

resetDisplayBtn.addEventListener("click", () => {
  setSearchWidth(DEFAULT_SEARCH_WIDTH);
  setDefTextScale(DEFAULT_DEF_TEXT_SCALE);
  setImgThumbSize(DEFAULT_IMG_THUMB_SIZE);
  setGlassTransparency(DEFAULT_GLASS_TRANSPARENCY);
  setGlassBlur(DEFAULT_GLASS_BLUR);
  setGlassTint(DEFAULT_GLASS_TINT);
  initDisplayUI();
});

function initDisplayUI() {
  const w = getSearchWidth();
  const t = getDefTextScale();
  const i = getImgThumbSize();
  const gt = getGlassTransparency();
  const gb = getGlassBlur();
  const gtint = getGlassTint();
  searchWidthInput.value = w;
  searchWidthValue.textContent = `${w}px`;
  defTextSizeInput.value = t;
  defTextSizeValue.textContent = `${t}%`;
  imgThumbSizeInput.value = i;
  imgThumbSizeValue.textContent = `${i}px`;
  bubblyModeToggle.checked = getBubblyMode();
  glassTransparencyInput.value = gt;
  glassTransparencyValue.textContent = `${gt}%`;
  glassBlurInput.value = gb;
  glassBlurValue.textContent = `${gb}px`;
  glassTintInput.value = gtint;
  glassTintValue.textContent = `${gtint}%`;
  applyDisplayPrefs();
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Some dictionary audio clips (older gstatic-hosted ones especially) come
// back as protocol-relative URLs like "//ssl.gstatic.com/.../hello_gb.mp3".
// Those resolve fine when the page is served over http/https, but silently
// fail to load if the app is opened directly as a local file
// (file://.../index.html) — "//host/path" resolves against a file:// base
// as "file://host/path", which isn't a valid location. Normalizing to an
// explicit https:// URL up front avoids that failure mode entirely.
function normalizeAudioUrl(url) {
  if (!url) return null;
  return url.startsWith("//") ? `https:${url}` : url;
}

/* ---------------------------------------------------------------------
   PAGE RANGES
   Entries carry `pageStart`/`pageEnd` rather than a single `pageNo`, so a
   word can be tagged to a whole page span (e.g. "450-470") as well as a
   single page. Single pages are stored uniformly as pageStart === pageEnd,
   so every other part of the app (sorting, filtering, export) only ever
   has to reason about a range.
--------------------------------------------------------------------- */

// Accepts "450", "450-470", "450–470" (en dash), "450—470" (em dash), or
// "450 to 470". Returns { pageStart, pageEnd } or null if the text isn't a
// valid page/range (non-numeric, non-positive, or start > end).
function parsePageRangeInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const rangeMatch = text.match(/^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/i);
  if (rangeMatch) {
    const pageStart = parseInt(rangeMatch[1], 10);
    const pageEnd = parseInt(rangeMatch[2], 10);
    if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd)) return null;
    if (pageStart < 1 || pageEnd < 1) return null;
    if (pageStart > pageEnd) return null;
    return { pageStart, pageEnd };
  }

  if (/^\d+$/.test(text)) {
    const pageStart = parseInt(text, 10);
    if (pageStart < 1) return null;
    return { pageStart, pageEnd: pageStart };
  }

  return null;
}

// Human-readable label for a page range: "Page 42" for a single page,
// "Page 450-470" for a real range.
function formatPageLabel(pageStart, pageEnd) {
  return pageStart === pageEnd ? `Page ${pageStart}` : `Page ${pageStart}-${pageEnd}`;
}

// Round-trips a range back into the compact text a person would type
// ("42" or "450-470"), used to prefill the Page input when editing.
function formatPageRangeText(pageStart, pageEnd) {
  return pageStart === pageEnd ? String(pageStart) : `${pageStart}-${pageEnd}`;
}

// Shared ordering used everywhere entries are processed for display,
// JSON export, or PDF export: Book (alphabetical) → Page start (ascending)
// → seq (the order the word was first entered). This guarantees that if
// "Word A" was added before "Word B" on the same page/range, "Word A"
// always appears first, regardless of any later edits.
function compareEntriesForExport(a, b) {
  if (a.bookTitle !== b.bookTitle) return a.bookTitle.localeCompare(b.bookTitle);
  if (a.pageStart !== b.pageStart) return a.pageStart - b.pageStart;
  return (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp);
}

/* ---------------------------------------------------------------------
   DEBOUNCE HELPER
--------------------------------------------------------------------- */
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* ---------------------------------------------------------------------
   DEFINITION + PHONETICS LOOKUP (Free Dictionary API — no auth)
   Returns MULTIPLE distinct definitions (one per part of speech, capped).
--------------------------------------------------------------------- */
async function fetchDefinitions(word) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${DICTIONARY_API_URL}${encodeURIComponent(word.toLowerCase())}`,
      { method: "GET", signal: controller.signal }
    );

    clearTimeout(timeoutId);

    if (response.status === 404) {
      return { ok: false, reason: "not-found" };
    }
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }

    const data = await response.json();
    const meanings = data?.[0]?.meanings || [];

    const seen = new Set();
    const definitions = [];
    meanings.forEach((meaning) => {
      const defList = meaning?.definitions || [];
      // Take up to 2 senses per part of speech, so even a word with only
      // one meaning (e.g. only "noun") still yields 2+ definitions.
      defList.slice(0, 2).forEach((defObj) => {
        const def = defObj?.definition;
        if (!def) return;
        const text = meaning.partOfSpeech ? `(${meaning.partOfSpeech}) ${def}` : def;
        if (seen.has(text) || definitions.length >= getSystemDefLimit()) return;
        seen.add(text);
        definitions.push({ text, source: "dictionary" });
      });
    });

    const phoneticsList = Array.isArray(data?.[0]?.phonetics) ? data[0].phonetics : [];
    const topLevelText = data?.[0]?.phonetic || "";

    const phonetics = { us: null, uk: null };
    const usedAudio = new Set();

    // Other-region tags we should NEVER treat as "British" in the pass-2
    // leftover fallback below (seen in real responses: mango-au.mp3 etc).
    // Without this exclusion, an Australian/Indian/etc. clip could get
    // mislabeled as the "UK" pronunciation just for being first in the
    // array, which sounds subtly wrong rather than obviously broken.
    const otherRegionTag = (audioLower) =>
      /(^|[-_])(au|aus|in|ind|nz|za|ie|sc|sco)([-_]|\.|$)/.test(audioLower);

    // Pass 1: explicit accent tags in the audio filename. Real-world
    // filenames use BOTH hyphen and underscore separators (e.g.
    // "mango-us.mp3" from api.dictionaryapi.dev, but also
    // "hello--_gb_1.mp3" from the older gstatic-hosted clips) — so we
    // need to check "-us"/"_us" and "-uk"/"_uk"/"-gb"/"_gb" all four.
    phoneticsList.forEach((p) => {
      if (!p.audio && !p.text) return;
      const audioLower = (p.audio || "").toLowerCase();
      if (audioLower.includes("-us") || audioLower.includes("_us")) {
        if (!phonetics.us) {
          phonetics.us = { text: p.text || topLevelText, audio: normalizeAudioUrl(p.audio) };
          if (p.audio) usedAudio.add(p.audio);
        }
      } else if (
        audioLower.includes("-uk") ||
        audioLower.includes("_uk") ||
        audioLower.includes("-gb") ||
        audioLower.includes("_gb")
      ) {
        if (!phonetics.uk) {
          phonetics.uk = { text: p.text || topLevelText, audio: normalizeAudioUrl(p.audio) };
          if (p.audio) usedAudio.add(p.audio);
        }
      }
    });

    // Pass 2: the Free Dictionary API doesn't always tag every clip —
    // very often the British/RP clip is left with no accent marker at
    // all rather than ever being tagged "-uk"/"-gb". Without this,
    // that untagged clip was being ignored entirely, so British audio
    // silently fell back to nothing even when a perfectly good British
    // clip was sitting right there in the response. Claim the first
    // not-yet-used, non-other-region entry (with audio and/or text) for
    // whichever accent is still missing, British first since it's the
    // more common gap.
    ["uk", "us"].forEach((accent) => {
      if (phonetics[accent]) return;
      const leftover = phoneticsList.find(
        (p) => (p.audio || p.text) && !usedAudio.has(p.audio) && !otherRegionTag((p.audio || "").toLowerCase())
      );
      if (leftover) {
        phonetics[accent] = { text: leftover.text || topLevelText, audio: normalizeAudioUrl(leftover.audio) };
        if (leftover.audio) usedAudio.add(leftover.audio);
      }
    });

    // Final fallback: nothing usable at all in the phonetics array —
    // reuse the top-level phonetic text (if any) for both, with
    // whatever single audio clip exists (if any) attached to US only.
    if (!phonetics.us && !phonetics.uk && (topLevelText || phoneticsList[0]?.text)) {
      const fallbackText = topLevelText || phoneticsList[0].text;
      phonetics.us = { text: fallbackText, audio: normalizeAudioUrl(phoneticsList.find((p) => p.audio)?.audio) };
      phonetics.uk = { text: fallbackText, audio: null };
    }

    if (definitions.length === 0) {
      return { ok: false, reason: "empty-response", phonetics };
    }

    return { ok: true, definitions, phonetics };
  } catch (err) {
    clearTimeout(timeoutId);
    const reason = err.name === "AbortError" ? "timeout" : "network-error";
    console.warn(`Dictionary lookup failed (${reason}):`, err);
    return { ok: false, reason };
  }
}

/* ---------------------------------------------------------------------
   RELATED IMAGES LOOKUP (Openverse API — no auth) — returns several,
   optionally biased toward a search phrase (used by the AI enhancement
   flow to pass context-aware queries instead of just the bare word).
--------------------------------------------------------------------- */
async function fetchImages(query, count, _isRetry = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const CANDIDATE_POOL = 12;

  try {
    const url = `${IMAGE_API_URL}?q=${encodeURIComponent(query)}&page_size=${CANDIDATE_POOL}&license_type=all-cc&mature=false`;
    const response = await fetch(url, { method: "GET", signal: controller.signal });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const queryLower = query.toLowerCase();
    const firstWord = queryLower.split(/\s+/)[0] || queryLower;

    // "Smart" relevance scoring: prefer images whose own title/tags
    // actually mention the query terms, since Openverse's own search is
    // fairly loose and often surfaces tangential results.
    const scored = results
      .map((r) => {
        // Prefer the original full-resolution image over the thumbnail so
        // entries and PDF exports display large and sharp; fall back to
        // the thumbnail only if no full-size URL is available.
        const src = r.url || r.thumbnail;
        if (!src) return null;
        const title = (r.title || "").toLowerCase();
        const tags = Array.isArray(r.tags) ? r.tags.map((t) => (t.name || "").toLowerCase()) : [];

        let score = 0;
        if (title === queryLower) score += 4;
        else if (title.includes(firstWord)) score += 3;
        if (tags.includes(firstWord)) score += 3;
        else if (tags.some((t) => t.includes(firstWord))) score += 1;
        if (!r.title) score -= 1;

        return { url: src, title: r.title || "", score };
      })
      .filter(Boolean);

    scored.sort((a, b) => b.score - a.score);

    // Prefer clearly relevant matches; if too few exist, top up with the
    // next-best scored candidates rather than showing nothing.
    const relevant = scored.filter((s) => s.score > 0);
    const chosen = (relevant.length >= 2 ? relevant : scored).slice(0, count);

    const images = chosen.map((s) => s.url);

    if (images.length === 0) {
      return { ok: false, reason: "no-image" };
    }

    return { ok: true, images };
  } catch (err) {
    clearTimeout(timeoutId);
    const reason = err.name === "AbortError" ? "timeout" : "network-error";
    console.warn(`Image lookup failed (${reason}):`, err);
    // One quiet retry for transient hiccups (flaky network / momentary
    // timeout) before actually giving up on the search.
    if (!_isRetry) return fetchImages(query, count, true);
    return { ok: false, reason };
  }
}

/* ---------------------------------------------------------------------
   fetchAiImages(word, book, aiQueries, limit)
   Images are treated as the FIRST PRIORITY of "Fetch with AI" — this
   never gives up just because the model's own imageQueries came back
   empty or didn't match anything on Openverse. It builds an ordered,
   de-duplicated queue — the AI's suggested queries first (usually the
   most specific), then a series of fallback queries built straight from
   the word/book themselves — and keeps working through that queue,
   one query at a time, until either the configured limit is filled or
   every reasonable query has genuinely been exhausted. Only returns
   once that queue is empty or the limit is met, so the calling code
   can rely on it having actually tried everything before reporting
   "no images found".
--------------------------------------------------------------------- */
async function fetchAiImages(word, book, aiQueries, limit) {
  if (!limit || limit <= 0) return { images: [], attempted: 0 };

  const seenQueries = new Set();
  const queue = [];
  const pushQuery = (q) => {
    const clean = (q || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    queue.push(clean);
  };

  // 1) The AI's own suggested search queries (most context-specific).
  (aiQueries || []).forEach(pushQuery);
  // 2) Fallbacks built directly from the word/book, so a fetch never
  //    comes back empty purely because the model's queries didn't
  //    surface anything — these keep the search going instead of
  //    stopping after just the AI's suggestions.
  pushQuery(`${word} ${book}`);
  pushQuery(word);
  pushQuery(`${word} illustration`);
  pushQuery(`${word} definition`);
  pushQuery(book);

  const images = [];
  for (const query of queue) {
    if (images.length >= limit) break;
    const imgResult = await fetchImages(query, limit - images.length);
    if (imgResult.ok) images.push(...imgResult.images);
  }
  return { images, attempted: queue.length };
}

/* ---------------------------------------------------------------------
   BOOK-AWARE AI ENHANCEMENT — triggered only by the explicit "Fetch
   with AI" button (never automatically), so it's used only when the
   person wants it and only costs a call when asked for.

   Talks to whatever server the person configured in AI Settings (local
   Ollama/LM Studio by default, or a hosted/cloud endpoint) via the
   OpenAI-compatible /v1/chat/completions shape, which all of the above
   support. Returns book-specific definitions AND concrete image-search
   queries in one call; the queries are then used to search Openverse
   for actual photos via the existing fetchImages().
--------------------------------------------------------------------- */
function buildEnhancePrompt(word, book, aiDefLimit, aiImgLimit) {
  const wantDefs = aiDefLimit > 0;
  const wantImages = aiImgLimit > 0;

  const asks = [];
  if (wantDefs) asks.push(`Exactly ${aiDefLimit} context-aware definition(s) specific to this book`);
  if (wantImages) asks.push(`Exactly ${aiImgLimit} concrete image search quer${aiImgLimit === 1 ? "y" : "ies"}`);
  // Images are the first priority: even when both are requested, call
  // them out explicitly so the model doesn't shortchange the queries.
  const askLine = asks.length
    ? `Provide: ${asks.join(", and ")}. `
    : "";

  return (
    `You are a literary analyst. The word is "${word}" and the book is "${book}". ` +
    askLine +
    `Respond ONLY in JSON: {"contextDefinitions": [${wantDefs ? Array(aiDefLimit).fill('"..."').join(", ") : ""}], "imageQueries": [${wantImages ? Array(aiImgLimit).fill('"..."').join(", ") : ""}]}. ` +
    `Do not include markdown or conversational text.`
  );
}

// Extracts and parses just the {...} portion of the model's reply, which
// tolerates surrounding markdown fences, stray preambles, or trailing
// chatter that some local models add despite being told not to.
function extractJsonObject(rawText) {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const candidate = rawText.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    return null;
  }
}

function parseEnhanceReply(rawText, aiDefLimit, aiImgLimit) {
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    console.warn("AI reply wasn't valid JSON:", rawText);
    return { ok: false, reason: "empty-response", message: "The AI's reply couldn't be parsed as JSON." };
  }

  const contextDefinitions = Array.isArray(parsed.contextDefinitions)
    ? parsed.contextDefinitions.map((d) => String(d || "").trim()).filter(Boolean)
    : [];
  const imageQueries = Array.isArray(parsed.imageQueries)
    ? parsed.imageQueries.map((q) => String(q || "").trim()).filter(Boolean)
    : [];

  // An empty reply is only a genuine failure if something was actually
  // requested. If both limits are set to 0 (deliberately disabled in
  // Settings ⚙️), empty arrays are the expected, correct outcome.
  const somethingWasRequested = (aiDefLimit ?? 1) > 0 || (aiImgLimit ?? 1) > 0;
  if (somethingWasRequested && contextDefinitions.length === 0 && imageQueries.length === 0) {
    return { ok: false, reason: "empty-response", message: "The AI didn't return any usable content." };
  }

  return { ok: true, contextDefinitions, imageQueries };
}

/**
 * enhanceVocabulary(word, book)
 * Calls the user-configured AI server (getSettings() at runtime — always
 * up to date with whatever was last saved, falling back to AI_CONFIG's
 * defaults if settings are empty/corrupt) and returns book-specific
 * definitions plus image-search queries.
 */
async function enhanceVocabulary(word, book) {
  const config = getSettings();
  const aiDefLimit = getAiDefLimit();
  const aiImgLimit = getAiImgLimit();
  const prompt = buildEnhancePrompt(word, book, aiDefLimit, aiImgLimit);

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  // Local models can take a while to load/generate, so this gets a much
  // longer budget (AI_TIMEOUT_MS) than the quick dictionary/image lookups.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.modelName,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        // Explicitly non-streaming: we want one complete JSON payload
        // back, not chunks — streaming is a common source of browser-side
        // connection instability for this kind of request.
        stream: false,
      }),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      // Distinct from a general network error: the request reached (or
      // was reaching) the server but didn't finish within AI_TIMEOUT_MS —
      // most often the model is still loading or still generating.
      console.warn(`AI request timed out after ${AI_TIMEOUT_MS}ms for ${url}:`, err);
      return {
        ok: false,
        reason: "timeout",
        message: "The AI is taking a long time. It might be loading the model or processing. Please wait a moment and try again.",
      };
    }
    // Genuine network failure — server unreachable, DNS failure, CORS, etc.
    console.warn(`AI request failed (network-error) for ${url}:`, err);
    return { ok: false, reason: "network-error", message: err.message };
  }
  clearTimeout(timeoutId);

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    // non-JSON body — handled below via !response.ok / missing content
  }

  if (!response.ok) {
    const serverMessage = body?.error?.message || body?.error || "";
    const reason = response.status === 401 || response.status === 403 ? "bad-key" : `http-${response.status}`;
    return { ok: false, reason, message: serverMessage };
  }

  const rawText = body?.choices?.[0]?.message?.content?.trim();
  if (!rawText) {
    return { ok: false, reason: "empty-response", message: "The AI server returned no content." };
  }

  return parseEnhanceReply(rawText, aiDefLimit, aiImgLimit);
}

/* ---------------------------------------------------------------------
   PENDING DEFINITIONS / IMAGES — shared render + mutation helpers
   (parameterized so the same logic drives both the add-form and the
   edit modal)
--------------------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function sourceLabel(source) {
  if (source === "dictionary") return '<span class="definition-source source-dictionary">Dictionary</span>';
  if (source === "ai") return '<span class="definition-source source-ai">AI</span>';
  if (source && source.startsWith("context")) return '<span class="definition-source source-context">Book-Specific Context:</span>';
  return '<span class="definition-source source-manual">Manual</span>';
}

function renderDefinitions(list, containerEl, onRemove, onToggle) {
  // Re-rendering replaces the whole innerHTML, which destroys whatever
  // checkbox the person just ticked and (in most browsers) drops focus
  // back onto <body>. Remember which one was focused so we can put focus
  // back on its replacement — otherwise a follow-up Enter press lands on
  // <body> instead of anywhere useful.
  const focusedId =
    document.activeElement?.classList?.contains("definition-checkbox") && containerEl.contains(document.activeElement)
      ? document.activeElement.dataset.id
      : null;

  if (list.length === 0) {
    containerEl.innerHTML = '<p class="empty-state" style="padding:0.6rem 0;">Nothing yet — type a word above, or add your own below.</p>';
    return;
  }
  containerEl.innerHTML = list
    .map((d) => {
      const isSelected = d.selected === true;
      return `
      <div class="definition-card${isSelected ? "" : " unselected"}" data-id="${d.id}">
        <input type="checkbox" class="definition-checkbox" data-id="${d.id}" ${isSelected ? "checked" : ""} title="Include this definition in the entry">
        <div class="definition-text">${sourceLabel(d.source)}${escapeHtml(d.text)}</div>
        <button type="button" class="definition-remove-btn" data-id="${d.id}" title="Remove this definition">✕</button>
      </div>`;
    })
    .join("");
  containerEl.querySelectorAll(".definition-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => onRemove(btn.dataset.id));
  });
  containerEl.querySelectorAll(".definition-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => onToggle(cb.dataset.id, cb.checked));
  });
  if (focusedId) {
    containerEl.querySelector(`.definition-checkbox[data-id="${focusedId}"]`)?.focus();
  }
}

function renderImages(list, containerEl, onRemove, onToggle) {
  const focusedId =
    document.activeElement?.classList?.contains("image-checkbox") && containerEl.contains(document.activeElement)
      ? document.activeElement.dataset.id
      : null;

  if (list.length === 0) {
    containerEl.innerHTML = "";
    return;
  }
  containerEl.innerHTML = list
    .map((img) => {
      const isSelected = img.selected === true;
      return `
      <div class="image-card${isSelected ? "" : " unselected"}" data-id="${img.id}">
        <label class="image-select-checkbox">
          <input type="checkbox" class="image-checkbox" data-id="${img.id}" ${isSelected ? "checked" : ""} title="Include this image in the entry">
        </label>
        <img src="${img.url}" alt="Related visual" loading="lazy" decoding="async">
        <button type="button" class="image-remove-btn" data-id="${img.id}" title="Remove this image">✕</button>
      </div>`;
    })
    .join("");
  containerEl.querySelectorAll(".image-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => onRemove(btn.dataset.id));
  });
  containerEl.querySelectorAll(".image-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => onToggle(cb.dataset.id, cb.checked));
  });
  // If an image link is dead/broken, drop it automatically rather than
  // showing a broken-image icon to the user.
  containerEl.querySelectorAll(".image-card img").forEach((imgEl) => {
    imgEl.addEventListener(
      "error",
      () => {
        const id = imgEl.closest(".image-card")?.dataset.id;
        if (id) onRemove(id);
      },
      { once: true }
    );
  });
  if (focusedId) {
    containerEl.querySelector(`.image-checkbox[data-id="${focusedId}"]`)?.focus();
  }
}

function renderPhoneticPreview(phonetics) {
  pronUsText.textContent = phonetics?.us?.text || "—";
  pronUkText.textContent = phonetics?.uk?.text || "—";

  // Gemini-supplied respellings are an approximation (no verified IPA,
  // no confirmed audio) rather than the Free Dictionary API's vetted
  // data, so flag them with a small visual cue + tooltip instead of
  // presenting them identically.
  const usFromAi = phonetics?.us?.source === "ai";
  const ukFromAi = phonetics?.uk?.source === "ai";
  pronUsText.classList.toggle("pron-text-ai", usFromAi);
  pronUkText.classList.toggle("pron-text-ai", ukFromAi);
  pronUsText.title = usFromAi ? "Phonetic respelling from Gemini (approximate)" : "";
  pronUkText.title = ukFromAi ? "Phonetic respelling from Gemini (approximate)" : "";
}

// Plays the word currently in the add-word form (before it's been saved as
// an entry), using whatever accent-specific recorded audio the lookup
// found, then a genuinely accent-matched voice if one exists, Google
// Translate's voice as a fallback, and the browser's own speech synthesis
// as a last resort. See playAudioChain() for the full order.
function playPendingPronunciation(accent) {
  const word = wordInput.value.trim();
  if (!word) return;
  const phonetic = pendingPhonetics?.[accent];
  const audioUrl = normalizeAudioUrl(phonetic?.audio);
  const respelling = phonetic?.source === "ai" ? cleanRespellingForSpeech(phonetic.text) : "";
  playAudioChain(word, accent, audioUrl, respelling);
}

// Clicking a <button> normally moves keyboard focus onto that button,
// which is what was yanking the text cursor out of the Word field
// whenever these were pressed. Preventing default on mousedown stops the
// browser from shifting focus at all, while the click (and its handler
// below) still fires normally — so the cursor/caret stays exactly where
// it was in the Word field.
function keepWordFocus(e) {
  e.preventDefault();
  if (document.activeElement !== wordInput) wordInput.focus();
}
pronUsBtn.addEventListener("mousedown", keepWordFocus);
pronUkBtn.addEventListener("mousedown", keepWordFocus);

pronUsBtn.addEventListener("click", () => playPendingPronunciation("us"));
pronUkBtn.addEventListener("click", () => playPendingPronunciation("uk"));

/* ---------------------------------------------------------------------
   ADD-FORM: pending state mutators
   New items are added UNSELECTED by default (except ones the person
   types in manually themselves) — nothing is pre-ticked for them.
--------------------------------------------------------------------- */
function addPendingDefinition(text, source, selected = false) {
  if (!text || !text.trim()) return;
  if (pendingDefinitions.some((d) => d.text === text.trim())) return;
  pendingDefinitions.push({ id: generateId(), text: text.trim(), source, selected });
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
}

function removePendingDefinition(id) {
  pendingDefinitions = pendingDefinitions.filter((d) => d.id !== id);
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
}

function togglePendingDefinition(id, selected) {
  const d = pendingDefinitions.find((item) => item.id === id);
  if (d) d.selected = selected;
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
}

function addPendingImage(url, source, selected = false) {
  if (!url) return;
  if (pendingImages.some((img) => img.url === url)) return;
  pendingImages.push({ id: generateId(), url, source, selected });
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
}

function removePendingImage(id) {
  pendingImages = pendingImages.filter((img) => img.id !== id);
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
}

function togglePendingImage(id, selected) {
  const img = pendingImages.find((item) => item.id === id);
  if (img) img.selected = selected;
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
}

function clearAutoPending() {
  // Keep manually-added definitions/images, drop the auto-fetched ones —
  // used when the word changes and old auto results no longer apply.
  pendingDefinitions = pendingDefinitions.filter((d) => d.source === "manual");
  pendingImages = pendingImages.filter((img) => img.source === "manual");
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
  pendingPhonetics = { us: null, uk: null };
  renderPhoneticPreview(null);
  manualModeTag.classList.add("hidden");
}

function resetFormPendingState() {
  pendingDefinitions = [];
  pendingImages = [];
  pendingPhonetics = { us: null, uk: null };
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
  renderPhoneticPreview(null);
  manualModeTag.classList.add("hidden");
  aiLoadingTag.classList.add("hidden");
  contextLoadingTag.classList.add("hidden");
  imageLoadingTag.classList.add("hidden");
  aiFetchStatus.classList.add("hidden");
  lookupState = { word: "", dictDone: false };
}

defSelectAllBtn.addEventListener("click", () => {
  pendingDefinitions.forEach((d) => (d.selected = true));
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
});
defSelectNoneBtn.addEventListener("click", () => {
  pendingDefinitions.forEach((d) => (d.selected = false));
  renderDefinitions(pendingDefinitions, definitionsList, removePendingDefinition, togglePendingDefinition);
});
imgSelectAllBtn.addEventListener("click", () => {
  pendingImages.forEach((img) => (img.selected = true));
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
});
imgSelectNoneBtn.addEventListener("click", () => {
  pendingImages.forEach((img) => (img.selected = false));
  renderImages(pendingImages, imagesGallery, removePendingImage, togglePendingImage);
});

/* ---------------------------------------------------------------------
   AUTO LOOKUP — triggered as the user types the word. Fetches a
   dictionary definition and a few generic images, none pre-selected.
   Book-aware results only come from the explicit "Fetch with AI" button.
--------------------------------------------------------------------- */
async function runWordLookup(word) {
  aiLoadingTag.classList.remove("hidden");
  imageLoadingTag.classList.remove("hidden");
  manualModeTag.classList.add("hidden");

  const systemImgLimit = getSystemImgLimit();
  const [defResult, imgResult] = await Promise.all([
    fetchDefinitions(word),
    systemImgLimit > 0 ? fetchImages(word, systemImgLimit) : Promise.resolve({ ok: false, reason: "limit-zero", images: [] }),
  ]);

  aiLoadingTag.classList.add("hidden");
  imageLoadingTag.classList.add("hidden");

  // Ignore stale results if the word field has since changed.
  if (wordInput.value.trim().toLowerCase() !== word.toLowerCase()) return;

  if (defResult.ok) {
    defResult.definitions.forEach((d) => addPendingDefinition(d.text, d.source));
  } else {
    manualModeTag.classList.remove("hidden");
  }
  pendingPhonetics = defResult.phonetics || { us: null, uk: null };
  renderPhoneticPreview(pendingPhonetics);

  if (imgResult.ok) {
    imgResult.images.forEach((url) => addPendingImage(url, "auto"));
  }

  lookupState.dictDone = true;
}

const debouncedWordLookup = debounce(() => {
  const word = wordInput.value.trim();
  if (word.length < 2) return;
  if (word.toLowerCase() === lookupState.word.toLowerCase() && lookupState.dictDone) return;
  clearAutoPending();
  lookupState.word = word;
  runWordLookup(word);
}, 450);

wordInput.addEventListener("input", debouncedWordLookup);

/* ---------------------------------------------------------------------
   AI SETTINGS MODAL — configure apiUrl / modelName / apiKey, persisted
   via SettingsManager. Fields are pre-filled with the current effective
   settings (saved values, or AI_CONFIG defaults) each time it's opened.
--------------------------------------------------------------------- */
function openAiSettingsModal() {
  const current = getSettings();
  aiSettingsUrlInput.value = current.apiUrl;
  aiSettingsModelInput.value = current.modelName;
  aiSettingsKeyInput.value = current.apiKey;
  aiSettingsModal.classList.remove("hidden");
}

function closeAiSettingsModal() {
  aiSettingsModal.classList.add("hidden");
}

aiSettingsBtn.addEventListener("click", openAiSettingsModal);
aiSettingsCancelBtn.addEventListener("click", closeAiSettingsModal);

aiSettingsModal.addEventListener("click", (e) => {
  if (e.target === aiSettingsModal) closeAiSettingsModal(); // click on backdrop
});

aiSettingsSaveBtn.addEventListener("click", () => {
  const saved = SettingsManager.saveSettings({
    apiUrl: aiSettingsUrlInput.value,
    modelName: aiSettingsModelInput.value,
    apiKey: aiSettingsKeyInput.value,
  });
  aiFetchStatus.textContent = saved ? "AI settings saved." : "Couldn't save AI settings — check browser storage.";
  aiFetchStatus.classList.remove("hidden");
  closeAiSettingsModal();
});

aiSettingsResetBtn.addEventListener("click", () => {
  SettingsManager.resetSettings();
  aiSettingsUrlInput.value = AI_CONFIG.apiUrl;
  aiSettingsModelInput.value = AI_CONFIG.modelName;
  aiSettingsKeyInput.value = AI_CONFIG.apiKey;
});

/* ---------------------------------------------------------------------
   "FETCH WITH AI" — book-aware definitions + images via enhanceVocabulary(),
   only run when the person explicitly asks for it. Never crashes the
   interface on failure: unreachable server / malformed JSON just show a
   friendly status message (and full detail in the console).
--------------------------------------------------------------------- */
aiFetchBtn.addEventListener("click", async () => {
  const word = wordInput.value.trim();
  const book = bookInput.value.trim();

  if (!word) {
    alert("Enter a word first.");
    wordInput.focus();
    return;
  }
  if (!book) {
    alert("Enter the book title first — the AI uses it to judge what fits.");
    bookInput.focus();
    return;
  }
  if (getAiDefLimit() === 0 && getAiImgLimit() === 0) {
    alert("Both AI definition and AI image limits are set to 0 in Settings (⚙️) — there's nothing for the AI to fetch. Raise one of them first.");
    return;
  }

  aiFetchBtn.disabled = true;
  contextLoadingTag.classList.remove("hidden");
  aiFetchStatus.classList.add("hidden");
  const originalLabel = aiFetchBtnLabel.textContent;
  aiFetchBtnLabel.textContent = "AI Processing…";

  // Everything below — the LLM call AND the image search that follows —
  // is wrapped in this single try/finally so the button stays disabled
  // and the spinner stays visible for the WHOLE operation. Images are
  // the first priority of "Fetch with AI": processing must not appear
  // "done" until the image search has genuinely finished (found
  // something or exhausted every fallback query), not just once the
  // LLM has replied.
  try {
    const result = await enhanceVocabulary(word, book);

    if (!result.ok) {
      const messages = {
        "network-error": "Couldn't reach the AI server — check it's running and the URL in AI Settings is correct.",
        "bad-key": "The AI server rejected the request — check your API key in AI Settings.",
        "empty-response": "The AI didn't return anything usable for that word/book.",
      };
      // "timeout" already carries its own complete, user-friendly message
      // from enhanceVocabulary() — show it as-is rather than wrapping it.
      let fullMessage;
      if (result.reason === "timeout") {
        fullMessage = result.message;
      } else {
        const base = messages[result.reason] || `Couldn't reach the AI server (${result.reason}).`;
        fullMessage = result.message ? `${base} (${result.message})` : base;
      }
      aiFetchStatus.textContent = fullMessage;
      aiFetchStatus.classList.remove("hidden");
      console.error("AI enhancement failed:", result);
      alert(fullMessage);
      return;
    }

    // Ignore stale results if the word/book have since changed.
    if (wordInput.value.trim().toLowerCase() !== word.toLowerCase() || bookInput.value.trim() !== book) {
      return;
    }

    // IMAGES FIRST — the top priority of this whole operation. Keeps
    // trying the AI's suggested queries and then a series of fallback
    // queries (built from the word/book) until the configured AI image
    // limit is filled or every reasonable option has been exhausted.
    // Skipped entirely only when the AI image limit is deliberately set
    // to 0 in Settings (⚙️).
    const aiImgLimit = getAiImgLimit();
    let imagesAdded = 0;
    if (aiImgLimit > 0) {
      aiFetchBtnLabel.textContent = "Fetching images…";
      contextLoadingTag.textContent = "Fetching images…";
      const { images } = await fetchAiImages(word, book, result.imageQueries, aiImgLimit);
      images.forEach((url) => addPendingImage(url, "ai"));
      imagesAdded = images.length;
    }

    // Dictionary display: append book-specific definitions below
    // whatever is already there, clearly labeled via sourceLabel()'s
    // "context" tag. Capped to the configured AI definitions limit
    // (aiDefLimit) even if the model returned more than asked.
    const aiDefLimit = getAiDefLimit();
    result.contextDefinitions.slice(0, aiDefLimit).forEach((def) => addPendingDefinition(def, `context:${book}`));

    const parts = [];
    if (result.contextDefinitions.length) parts.push(`${result.contextDefinitions.length} book-specific definition(s)`);
    if (imagesAdded) parts.push(`${imagesAdded} image(s)`);
    aiFetchStatus.textContent = parts.length
      ? `Added ${parts.join(" and ")} below — tick what you'd like to keep.`
      : aiImgLimit > 0
      ? "The AI responded, but no images could be found even after trying fallback searches."
      : "The AI responded with definitions only (AI image limit is set to 0).";
    aiFetchStatus.classList.remove("hidden");
  } finally {
    contextLoadingTag.textContent = "Asking AI…";
    contextLoadingTag.classList.add("hidden");
    aiFetchBtn.disabled = false;
    aiFetchBtnLabel.textContent = originalLabel;
  }
});

/* ---------------------------------------------------------------------
   ENTER KEY HANDLING
   Enter in Word / Book / Page adds the entry. We rely on the form's
   native "submit" behavior AND independently re-attempt on the next
   tick (guarded against double-firing) — this covers the case where a
   browser's Book datalist popup intercepts the keypress before it can
   trigger native submission.

   Checkboxes (definition/image selection) are NOT part of native
   implicit form submission — the browser only auto-submits on Enter
   from text-like fields. So after ticking a definition/image checkbox,
   focus sits on that checkbox and Enter used to do nothing at all. The
   form-level listener below catches Enter no matter which control
   inside the form currently has focus (checkboxes included), so adding
   an entry works the same whether or not you've just ticked something.

   Guarding against the double-fire: a single Enter press in a text
   field can trigger BOTH the native "submit" event (synchronous, fires
   immediately as part of the browser's default action for that
   keydown) AND our own setTimeout(...,0) fallback scheduled by the
   keydown listener below (needed for the datalist-popup edge case,
   where native submission never fires at all). Those two must resolve
   to exactly one add — this used to be done with a 300ms wall-clock
   window, but that broke once the entry table got long enough that
   re-rendering it after a successful add took longer than 300ms: the
   fallback would fire, see the guard window had "expired", and run
   addEntryFromForm() again against the now-already-cleared Word field,
   throwing "Please enter a word before adding." Tracking a single
   mutable "attempt token" instead of elapsed time sidesteps that
   entirely — whichever of the two paths (sync submit vs. the deferred
   fallback) runs first consumes the token and the other becomes a
   no-op, no matter how long the add itself takes to finish rendering.
--------------------------------------------------------------------- */
let pendingAddToken = null;

function beginAddAttempt() {
  const token = Symbol("addAttempt");
  pendingAddToken = token;
  return token;
}

function guardedAddEntry(token) {
  // A token from a keypress already consumed by the other path (or a
  // stale token from an earlier press) is a no-op — only the first of
  // the two triggers for a given press is allowed through.
  if (token !== pendingAddToken) return;
  pendingAddToken = null;
  addEntryFromForm();
}

[wordInput, bookInput, pageInput].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const token = beginAddAttempt();
    // Let any datalist "commit" finish updating the field's value first.
    setTimeout(() => guardedAddEntry(token), 0);
  });
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  // Native submission fires synchronously, before the fallback above
  // gets a chance to run — reuse its token if a keydown just started
  // one, otherwise (submit triggered some other way) mint a fresh one.
  guardedAddEntry(pendingAddToken ?? beginAddAttempt());
});

// Catches Enter from anywhere in (or even outside, if focus fell back to
// <body>) the add-entry workflow — most importantly the definition/image
// checkboxes, which never trigger native form submission on their own,
// and whose re-render can leave focus sitting on <body> rather than any
// element inside the form. Listening on `document` (not just `form`)
// means Enter still works no matter where focus actually landed.
// Skips controls that already define their own Enter behavior, and
// anything belonging to the edit modal or the filter/search bar, so it
// never fires where it shouldn't.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (!editModal.classList.contains("hidden")) return; // edit modal has its own Save button
  const target = e.target;
  const hasOwnHandler =
    target === wordInput ||
    target === bookInput ||
    target === pageInput ||
    target === definitionInput ||
    target === imageUrlInput ||
    target === searchInput ||
    target === pageFilter ||
    target === bookFilter;
  const isButtonLike =
    target.tagName === "BUTTON" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.tagName === "A";
  if (hasOwnHandler || isButtonLike) return;
  // Only fires within the add-entry form, or on <body> itself (which is
  // where focus ends up right after a checkbox re-render destroys the
  // element that was focused) — never inside the table or footer.
  if (target !== document.body && !form.contains(target)) return;
  e.preventDefault();
  const token = beginAddAttempt();
  setTimeout(() => guardedAddEntry(token), 0);
});


imageUrlInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  addImageBtn.click();
});

editImageUrlInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  editAddImageBtn.click();
});

/* ---------------------------------------------------------------------
   PASTE AN ACTUAL IMAGE (not just a URL) INTO THE MANUAL IMAGE BOX
   "Copy image" from Google Images / any webpage puts real image bytes
   on the clipboard, not a URL — a plain text paste can't pick that up.
   We listen for the paste event directly, read the image out of
   e.clipboardData, and convert it to a data URL so it can be stored and
   displayed exactly like any other image.
--------------------------------------------------------------------- */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read pasted image"));
    reader.readAsDataURL(blob);
  });
}

// Returns true if an image was found and handled (so the caller can skip
// its normal text-paste behavior); false if the clipboard held plain
// text/a URL instead, so normal pasting proceeds untouched.
async function handleImagePaste(e, onAdded) {
  const items = e.clipboardData?.items;
  if (!items) return false;
  const imageItem = Array.from(items).find((item) => item.type && item.type.startsWith("image/"));
  if (!imageItem) return false;

  const file = imageItem.getAsFile();
  if (!file) return false;

  e.preventDefault();
  try {
    const dataUrl = await blobToDataUrl(file);
    // Large pasted images can eat into localStorage's ~5-10MB quota fast
    // (base64 runs ~33% bigger than the original file), so give a heads
    // up rather than silently failing to save later.
    if (file.size > 3 * 1024 * 1024) {
      console.warn(`Pasted image is ${(file.size / (1024 * 1024)).toFixed(1)}MB — large images can fail to save if storage fills up.`);
    }
    onAdded(dataUrl);
  } catch (err) {
    console.warn("Failed to read pasted image:", err);
    alert("Couldn't read that pasted image — try copying it again.");
  }
  return true;
}

imageUrlInput.addEventListener("paste", (e) => {
  handleImagePaste(e, (dataUrl) => {
    const manualCount = pendingImages.filter((img) => bucketOf(img.source) === "manual").length;
    if (manualCount >= getManualImgLimit()) {
      alert(`Limit Reached: you can only keep ${getManualImgLimit()} manual image(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
      return;
    }
    addPendingImage(dataUrl, "manual", true);
    imageUrlInput.value = "";
    wordInput.focus();
  });
});

editImageUrlInput.addEventListener("paste", (e) => {
  handleImagePaste(e, (dataUrl) => {
    const manualCount = editPendingImages.filter((img) => bucketOf(img.source) === "manual").length;
    if (manualCount >= getManualImgLimit()) {
      alert(`Limit Reached: you can only keep ${getManualImgLimit()} manual image(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
      return;
    }
    editPendingImages.push({ id: generateId(), url: dataUrl, source: "manual", selected: true });
    renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
    editImageUrlInput.value = "";
  });
});

// Plain Enter in the definition box adds it as a definition (fast
// workflow); Shift+Enter still inserts a newline for longer definitions.
definitionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    addDefinitionBtn.click();
  }
});

editDefinitionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    editAddDefinitionBtn.click();
  }
});

addDefinitionBtn.addEventListener("click", () => {
  const text = definitionInput.value.trim();
  if (!text) return;
  const manualCount = pendingDefinitions.filter((d) => bucketOf(d.source) === "manual").length;
  if (manualCount >= getManualDefLimit()) {
    alert(`Limit Reached: you can only keep ${getManualDefLimit()} manual definition(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
    return;
  }
  addPendingDefinition(text, "manual", true);
  definitionInput.value = "";
  // Per request: focus goes back to the Word field, not back into this
  // box — so the person can immediately keep moving through the form
  // (or press Enter to add the entry) without an extra manual click.
  wordInput.focus();
});

addImageBtn.addEventListener("click", () => {
  const url = imageUrlInput.value.trim();
  if (!url) return;
  const manualCount = pendingImages.filter((img) => bucketOf(img.source) === "manual").length;
  if (manualCount >= getManualImgLimit()) {
    alert(`Limit Reached: you can only keep ${getManualImgLimit()} manual image(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
    return;
  }
  addPendingImage(url, "manual", true);
  imageUrlInput.value = "";
  wordInput.focus();
});

/* ---------------------------------------------------------------------
   ADD ENTRY
   - Book Title & Page No. are preserved (not cleared) after submit, and
     remembered in localStorage, so the next word defaults to the same
     book/page until you change them.
   - Focus returns to the Word field automatically for the next entry.
--------------------------------------------------------------------- */
function addEntryFromForm() {
  const word = wordInput.value.trim();
  const bookTitle = bookInput.value.trim();
  const pageRange = parsePageRangeInput(pageInput.value);

  if (!word) {
    alert("Please enter a word before adding.");
    wordInput.focus();
    return;
  }
  if (!bookTitle) {
    alert("Please enter the book title before adding.");
    bookInput.focus();
    return;
  }
  if (!pageRange) {
    alert("Please enter a valid page number or page range (e.g. 42 or 450-470) before adding.");
    pageInput.focus();
    return;
  }

  // Only ticked ("selected") definitions/images are saved. If the user
  // hasn't ticked anything, fall back to a placeholder definition so the
  // entry is never silently empty.
  const chosenDefinitions = pendingDefinitions.filter((d) => d.selected === true);
  const definitionsToSave = chosenDefinitions.length
    ? chosenDefinitions.map((d) => ({ id: d.id, text: d.text, source: d.source }))
    : [{ id: generateId(), text: "(no definition provided)", source: "manual" }];

  const imagesToSave = pendingImages
    .filter((img) => img.selected === true)
    .map((img) => ({ id: img.id, url: img.url, source: img.source }));

  // TRIPLE-STREAM DATA ARCHITECTURE — every saved item is bucketed by
  // where it came from (system/dictionary vs. AI vs. manual) rather than
  // kept in one flat list, so all three streams can be limited and
  // rendered completely independently (see getFilteredData()).
  const entry = {
    id: generateId(),
    word,
    bookTitle,
    pageStart: pageRange.pageStart,
    pageEnd: pageRange.pageEnd,
    timestamp: Date.now(),
    seq: nextSeq++, // guarantees stable "order first entered" for PDF/JSON export
    systemDefinitions: definitionsToSave.filter((d) => bucketOf(d.source) === "system"),
    aiDefinitions: definitionsToSave.filter((d) => bucketOf(d.source) === "ai"),
    manualDefinitions: definitionsToSave.filter((d) => bucketOf(d.source) === "manual"),
    systemImages: imagesToSave.filter((img) => bucketOf(img.source) === "system"),
    aiImages: imagesToSave.filter((img) => bucketOf(img.source) === "ai"),
    manualImages: imagesToSave.filter((img) => bucketOf(img.source) === "manual"),
    phonetics: pendingPhonetics || { us: null, uk: null },
  };

  entries.push(entry);
  saveEntries();
  saveLastBookPage(bookTitle, formatPageRangeText(pageRange.pageStart, pageRange.pageEnd));

  // Reset only the word/definitions/images — keep Book & Page as-is.
  wordInput.value = "";
  definitionInput.value = "";
  imageUrlInput.value = "";
  resetFormPendingState();

  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
  wordInput.focus();
}

/* ---------------------------------------------------------------------
   PREFILL LAST BOOK / PAGE ON LOAD
--------------------------------------------------------------------- */
function prefillLastBookPage() {
  const last = loadLastBookPage();
  if (last) {
    bookInput.value = last.book || "";
    pageInput.value = last.page || "";
  }
}

/* ---------------------------------------------------------------------
   DELETE / EDIT
--------------------------------------------------------------------- */
function deleteEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete "${entry.word}" from your register?`)) return;

  entries = entries.filter((e) => e.id !== id);
  saveEntries();
  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
}

function openEditModal(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  editingId = id;
  editWord.value = entry.word;
  editBook.value = entry.bookTitle;
  editPage.value = formatPageRangeText(entry.pageStart, entry.pageEnd);

  // Definitions/images already saved to an entry are, by definition,
  // ones the person chose to keep — so they stay ticked in the editor.
  // All three streams (system + AI + manual) are shown together here,
  // each item still carrying its own source so sourceLabel() shows
  // which is which.
  const allDefinitions = [
    ...(entry.systemDefinitions || []),
    ...(entry.aiDefinitions || []),
    ...(entry.manualDefinitions || []),
  ];
  const allImages = [
    ...(entry.systemImages || []),
    ...(entry.aiImages || []),
    ...(entry.manualImages || []),
  ];
  editPendingDefinitions = allDefinitions.map((d) => ({ ...d, selected: d.selected !== false }));
  editPendingImages = allImages.map((img) => ({ ...img, selected: img.selected !== false }));
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
  editDefinitionInput.value = "";
  editImageUrlInput.value = "";

  editModal.classList.remove("hidden");
}

function removeEditPendingDefinition(id) {
  editPendingDefinitions = editPendingDefinitions.filter((d) => d.id !== id);
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
}

function toggleEditPendingDefinition(id, selected) {
  const d = editPendingDefinitions.find((item) => item.id === id);
  if (d) d.selected = selected;
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
}

function removeEditPendingImage(id) {
  editPendingImages = editPendingImages.filter((img) => img.id !== id);
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
}

function toggleEditPendingImage(id, selected) {
  const img = editPendingImages.find((item) => item.id === id);
  if (img) img.selected = selected;
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
}

editAddDefinitionBtn.addEventListener("click", () => {
  const text = editDefinitionInput.value.trim();
  if (!text) return;
  const manualCount = editPendingDefinitions.filter((d) => bucketOf(d.source) === "manual").length;
  if (manualCount >= getManualDefLimit()) {
    alert(`Limit Reached: you can only keep ${getManualDefLimit()} manual definition(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
    return;
  }
  editPendingDefinitions.push({ id: generateId(), text, source: "manual", selected: true });
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
  editDefinitionInput.value = "";
});

editAddImageBtn.addEventListener("click", () => {
  const url = editImageUrlInput.value.trim();
  if (!url) return;
  const manualCount = editPendingImages.filter((img) => bucketOf(img.source) === "manual").length;
  if (manualCount >= getManualImgLimit()) {
    alert(`Limit Reached: you can only keep ${getManualImgLimit()} manual image(s) for this word. Raise the limit in Settings (⚙️) if you need more.`);
    return;
  }
  editPendingImages.push({ id: generateId(), url, source: "manual", selected: true });
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
  editImageUrlInput.value = "";
});

editDefSelectAllBtn.addEventListener("click", () => {
  editPendingDefinitions.forEach((d) => (d.selected = true));
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
});
editDefSelectNoneBtn.addEventListener("click", () => {
  editPendingDefinitions.forEach((d) => (d.selected = false));
  renderDefinitions(editPendingDefinitions, editDefinitionsList, removeEditPendingDefinition, toggleEditPendingDefinition);
});
editImgSelectAllBtn.addEventListener("click", () => {
  editPendingImages.forEach((img) => (img.selected = true));
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
});
editImgSelectNoneBtn.addEventListener("click", () => {
  editPendingImages.forEach((img) => (img.selected = false));
  renderImages(editPendingImages, editImagesGallery, removeEditPendingImage, toggleEditPendingImage);
});

function closeEditModal() {
  editingId = null;
  editModal.classList.add("hidden");
}

cancelEditBtn.addEventListener("click", closeEditModal);

saveEditBtn.addEventListener("click", () => {
  if (!editingId) return;
  const entry = entries.find((e) => e.id === editingId);
  if (!entry) return;

  const newWord = editWord.value.trim();
  const newBook = editBook.value.trim();
  const newPageRange = parsePageRangeInput(editPage.value);

  if (!newWord || !newBook || !newPageRange) {
    alert("Word, Book Title, and Page No. (e.g. 42 or 450-470) cannot be empty or invalid.");
    return;
  }

  const chosenDefinitions = editPendingDefinitions.filter((d) => d.selected !== false);
  const chosenImages = editPendingImages.filter((img) => img.selected !== false);

  const definitionsToSave = chosenDefinitions.length
    ? chosenDefinitions.map((d) => ({ id: d.id, text: d.text, source: d.source }))
    : [{ id: generateId(), text: "(no definition provided)", source: "manual" }];
  const imagesToSave = chosenImages.map((img) => ({ id: img.id, url: img.url, source: img.source }));

  entry.word = newWord;
  entry.bookTitle = newBook;
  entry.pageStart = newPageRange.pageStart;
  entry.pageEnd = newPageRange.pageEnd;
  entry.systemDefinitions = definitionsToSave.filter((d) => bucketOf(d.source) === "system");
  entry.aiDefinitions = definitionsToSave.filter((d) => bucketOf(d.source) === "ai");
  entry.manualDefinitions = definitionsToSave.filter((d) => bucketOf(d.source) === "manual");
  entry.systemImages = imagesToSave.filter((img) => bucketOf(img.source) === "system");
  entry.aiImages = imagesToSave.filter((img) => bucketOf(img.source) === "ai");
  entry.manualImages = imagesToSave.filter((img) => bucketOf(img.source) === "manual");
  // entry.seq is intentionally left untouched — editing an entry doesn't
  // change when it was first entered, so book/page/PDF ordering stays put.

  saveEntries();
  closeEditModal();
  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
});

editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeEditModal();
});

/* ---------------------------------------------------------------------
   SPEECH SYNTHESIS — American & British pronunciation
--------------------------------------------------------------------- */
function loadVoices() {
  availableVoices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
}

if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

// Given several voices that all technically match, prefer Chrome's own
// "Google UK English Female/Male" / "Google US English" voices — these
// are the same higher-quality, server-rendered voices behind Google's
// own search pronunciation widget, and sound far more natural/accurate
// than most OS-bundled voices (Microsoft's David/Zira, etc). Only
// matters when >1 candidate shares a locale; falls back to the first
// candidate otherwise.
function preferGoogleVoice(candidates) {
  if (!candidates.length) return null;
  return candidates.find((v) => v.name.toLowerCase().includes("google")) || candidates[0];
}

function pickVoice(accent) {
  const isUK = accent === "uk";
  const targetLang = isUK ? "en-GB" : "en-US";

  // Exact locale match first — prefer a "Google ..." voice among them.
  const exactMatches = availableVoices.filter((v) => v.lang === targetLang);
  if (exactMatches.length) return preferGoogleVoice(exactMatches);

  // Some browsers/OSes expose accent-appropriate voices under names
  // rather than a clean lang tag — match on those before giving up.
  const nameHints = isUK
    ? ["uk english", "british", "daniel", "kate", "hazel", "arthur", "english (united kingdom)"]
    : ["us english", "american", "samantha", "alex", "zira", "aria", "david", "english (united states)"];
  const nameMatches = availableVoices.filter((v) => nameHints.some((hint) => v.name.toLowerCase().includes(hint)));
  if (nameMatches.length) return preferGoogleVoice(nameMatches);

  // Broader "any English voice" fallback — but explicitly excluding the
  // OTHER accent's exact locale. Without this exclusion, asking for
  // "uk" on a system with only an en-US voice installed would silently
  // hand back that en-US voice, making the "British" button sound
  // identical to "American" (which looked like British "not working").
  const otherLang = isUK ? "en-US" : "en-GB";
  const broadMatches = availableVoices.filter((v) => v.lang?.startsWith("en") && v.lang !== otherLang);
  return preferGoogleVoice(broadMatches);
}

function speakWithBrowserTTS(word, accent, voice = pickVoice(accent)) {
  if (!("speechSynthesis" in window)) {
    alert("Sorry, your browser doesn't support speech synthesis.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = accent === "uk" ? "en-GB" : "en-US";
    // No matching (or even close) system voice was found for this
    // accent specifically — the browser will still speak using its
    // default voice, but let the person know why it may not sound
    // authentically British/American rather than leaving it a mystery.
    if (accent === "uk") {
      console.warn("No British (en-GB) voice found on this device — using the browser's default voice instead.");
    }
  }
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

// Google doesn't publish a public API for the pronunciation widget seen in
// Google Search (that's an internal, undocumented service) — but Google
// Translate's spoken-word endpoint is the closest real-time, no-key voice
// that's actually reachable from a browser. It's unofficial (not a
// documented API, so it can change or get rate-limited without notice).
// Crucially, it has NO accent parameter at all — "tl=en" always returns
// the exact same single generic voice no matter what accent was asked
// for, which is why it's no longer tried before a genuinely
// accent-matched system voice (see playAudioChain below).
function googleTranslateTtsUrl(word) {
  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${encodeURIComponent(word)}&tl=en`;
}

function tryPlayAudio(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.addEventListener("error", () => reject(new Error("load error")), { once: true });
    audio.play().then(resolve).catch(reject);
  });
}

// A Gemini-supplied respelling like "MEER-ee MAHZ DOO..." is meant to be
// READ, not spoken literally — the hyphens are syllable breaks, not
// pauses, and a trailing "…" is just the popup preview getting
// truncated, not part of the word. Strip both before handing it to any
// speech engine, or it comes out sounding like several separate words
// with an odd pause where the ellipsis was.
function cleanRespellingForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/[.…]+$/, "")
    .replace(/[-–—]/g, " ")
    .trim();
}

// Shared playback order for any word: (1) the accent-specific recorded
// clip from the dictionary lookup, if we have one — most accurate for
// US-vs-UK, when it exists; (2) a genuinely accent-matched system voice,
// if this device has one — this is the only remaining option that can
// actually sound different for "US" vs "UK" on the SAME word/text; (3)
// Google Translate's real-time voice as a fallback for when no such
// system voice is installed — it sounds more natural, but since it has
// no accent parameter, clicking US and UK back-to-back on the same word
// will sound identical through this option specifically; (4) the
// browser's default-voice speech synthesis as the final fallback.
//
// IMPORTANT: whenever a real accent-matched voice is available (step 2),
// it speaks the REAL WORD, not the Gemini respelling. A phonetic
// respelling like "lai-luhk" is meant to be READ by a person, not fed
// literally into a TTS engine — most engines mangle it (it isn't a real
// word), which is why AI-sourced pronunciations used to sound worse than
// the dictionary clips even when a proper en-GB/en-US voice was
// installed. A native voice given the actual word and the correct
// lang/accent produces a far more accurate result on its own — that's
// exactly how Google's own pronunciation widget does it.
//
// The respelling only gets used as a last resort: Google Translate's
// endpoint (step 3) and the browser's default voice (step 4) don't carry
// any accent information, so without it "US" and "UK" would render
// identically. `respellingText`, if supplied, is what's spoken there
// instead, purely to make the two buttons sound different from each
// other when nothing better is available.
async function playAudioChain(word, accent, dictionaryAudioUrl, respellingText = "") {
  if (dictionaryAudioUrl) {
    try {
      await tryPlayAudio(dictionaryAudioUrl);
      return;
    } catch (err) {
      console.warn(`${accent.toUpperCase()} dictionary clip failed (${err.message}) — trying next option.`, dictionaryAudioUrl);
    }
  }

  const matchedVoice = pickVoice(accent);
  if (matchedVoice) {
    speakWithBrowserTTS(word, accent, matchedVoice);
    return;
  }

  const fallbackText = respellingText || word;
  try {
    await tryPlayAudio(googleTranslateTtsUrl(fallbackText));
    return;
  } catch (err) {
    console.warn(`Google Translate voice failed (${err.message}) — falling back to on-device speech synthesis.`);
  }
  speakWithBrowserTTS(fallbackText, accent);
}

function playPronunciation(entry, accent) {
  const phonetic = entry.phonetics?.[accent];
  const audioUrl = normalizeAudioUrl(phonetic?.audio);
  const respelling = phonetic?.source === "ai" ? cleanRespellingForSpeech(phonetic.text) : "";
  playAudioChain(entry.word, accent, audioUrl, respelling);
}

/* ---------------------------------------------------------------------
   FILTER / SEARCH DROPDOWNS
--------------------------------------------------------------------- */
function refreshBookFilterOptions() {
  const currentSelection = bookFilter.value;
  const books = [...new Set(entries.map((e) => e.bookTitle))].sort((a, b) =>
    a.localeCompare(b)
  );

  bookFilter.innerHTML = '<option value="">— All Books —</option>';
  books.forEach((book) => {
    const opt = document.createElement("option");
    opt.value = book;
    opt.textContent = book;
    bookFilter.appendChild(opt);
  });

  if (books.includes(currentSelection)) {
    bookFilter.value = currentSelection;
  }
}

function refreshBookDatalist() {
  const books = [...new Set(entries.map((e) => e.bookTitle))].sort((a, b) =>
    a.localeCompare(b)
  );
  bookSuggestions.innerHTML = books
    .map((book) => `<option value="${escapeHtml(book)}"></option>`)
    .join("");
}

bookFilter.addEventListener("change", renderTable);
pageFilter.addEventListener("input", debounce(renderTable, 200));
searchInput.addEventListener("input", debounce(renderTable, 200));

/* ---------------------------------------------------------------------
   EXPORT / IMPORT
--------------------------------------------------------------------- */
// Groups an already-sorted flat entry list into the nested
// book → page-range → words tree used for JSON export. Page Ranges act as
// "chapters" and Words act as "sub-chapters", per the export schema.
function buildBooksTree(flatEntries) {
  const byBook = new Map();
  flatEntries.forEach((e) => {
    if (!byBook.has(e.bookTitle)) byBook.set(e.bookTitle, new Map());
    const byPage = byBook.get(e.bookTitle);
    const pageKey = `${e.pageStart}-${e.pageEnd}`;
    if (!byPage.has(pageKey)) {
      byPage.set(pageKey, { pageLabel: formatPageLabel(e.pageStart, e.pageEnd), pageStart: e.pageStart, pageEnd: e.pageEnd, words: [] });
    }
    byPage.get(pageKey).words.push({
      word: e.word,
      definitions: e.definitions,
      phonetics: e.phonetics,
      images: e.images,
      seq: e.seq,
    });
  });

  return [...byBook.entries()].map(([bookTitle, byPage]) => ({
    bookTitle,
    pages: [...byPage.values()],
  }));
}

function buildExportPayload() {
  const selectedBook = bookFilter.value;
  const relevant = selectedBook ? entries.filter((e) => e.bookTitle === selectedBook) : entries.slice();

  // Book (alphabetical) → Page start (ascending) → seq (the order you
  // first entered the word) — this ordering drives both JSON and PDF
  // export, and matches the strict sequencing used across the app's UI.
  const sorted = relevant.slice().sort(compareEntriesForExport);

  const flatEntries = sorted.map((e) => {
    const { definitions, images } = getFilteredData(e);
    return {
      word: e.word,
      bookTitle: e.bookTitle,
      pageStart: e.pageStart,
      pageEnd: e.pageEnd,
      pageLabel: formatPageLabel(e.pageStart, e.pageEnd),
      seq: e.seq,
      definitions: definitions.map((d) => ({ text: d.text, source: d.source })),
      phonetics: e.phonetics,
      images: images.map((img) => img.url),
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    scope: selectedBook || "All Books",
    // Flat, already-sorted list — kept for the PDF builder, which walks
    // entries in this exact order rather than re-deriving the tree.
    entries: flatEntries,
    // Nested tree — Page Ranges as chapters, Words as sub-chapters —
    // this is the shape written out to the JSON export file.
    books: buildBooksTree(flatEntries),
  };
}

// Uploads a one-off export file to Drive (distinct from the live entries
// file that saveEntries() keeps in sync) so repeated exports don't
// overwrite one another.
async function uploadExportToDrive(blob, filename, mimeType) {
  const metadata = { name: filename, mimeType };

  // A RESUMABLE upload, not a multipart one. Exported PDFs embed
  // full-resolution, uncompressed images (see the "NONE" compression
  // setting used by doc.addImage below) and can easily reach several MB.
  // Drive's multipart upload endpoint is only reliable for small files —
  // on a slower/mobile connection a large multipart request can be cut off
  // partway through, leaving a file that opens fine but is missing
  // whichever images landed after the truncation point. A resumable
  // upload has no such practical size ceiling: it first registers the
  // file, then PUTs the blob's bytes directly and in full, with no string
  // reconstruction of the body at all.
  const initRes = await driveApiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) throw new Error(`Drive export upload init failed (${initRes.status})`);

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("Drive didn't return a resumable upload session URL");

  // The session URL itself carries the authorization for this upload, so
  // the blob is PUT directly — no Authorization header, no multipart
  // boundary, no text conversion. Every byte goes over exactly as-is.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: blob,
  });
  if (!putRes.ok) throw new Error(`Drive export upload failed (${putRes.status})`);
}

// Handles the "Download" / "Save to Drive" checkboxes shared by both
// export buttons — runs whichever destinations are checked (both, if the
// person wants both), and makes sure at least one always happens.
async function deliverExport(blob, filename, mimeType) {
  const wantLocal = exportLocalCheckbox.checked || !usingCloudStorage;
  const wantCloud = exportDriveCheckbox.checked && usingCloudStorage;

  if (wantLocal) downloadBlob(blob, filename);

  if (wantCloud) {
    try {
      await uploadExportToDrive(blob, filename, mimeType);
    } catch (err) {
      console.error("Export upload to Drive failed:", err);
      alert("Downloaded locally, but couldn't also save a copy to Google Drive.");
    }
  }
}

exportJsonBtn.addEventListener("click", async () => {
  if (entries.length === 0) {
    alert("Nothing to export yet.");
    return;
  }
  const payload = buildExportPayload();
  const defaultName = `literary-vocab-${payload.scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const chosenName = window.prompt("Name this JSON file:", defaultName);
  if (chosenName === null) return; // cancelled

  // The file on disk is the nested tree (Page Ranges as chapters, Words as
  // sub-chapters) plus export metadata — the flat `entries` list on
  // `payload` is an internal shape used only to drive the PDF builder.
  const jsonOutput = {
    exportedAt: payload.exportedAt,
    scope: payload.scope,
    books: payload.books,
  };
  const blob = new Blob([JSON.stringify(jsonOutput, null, 2)], { type: "application/json" });
  await deliverExport(blob, `${chosenName || defaultName}.json`, "application/json");
});

exportPdfBtn.addEventListener("click", async () => {
  if (entries.length === 0) {
    alert("Nothing to export yet.");
    return;
  }
  if (!window.jspdf) {
    alert("The PDF library didn't load — check your internet connection and try again.");
    return;
  }

  const payload = buildExportPayload();
  const defaultName = `literary-vocab-${payload.scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const chosenName = window.prompt("Name this PDF file:", defaultName);
  if (chosenName === null) return; // cancelled

  exportPdfBtn.disabled = true;
  exportPdfBtn.textContent = "Building PDF…";
  try {
    const blob = await buildPdfBlob(payload);
    await deliverExport(blob, `${chosenName || defaultName}.pdf`, "application/pdf");
  } catch (err) {
    console.error("PDF export failed:", err);
    alert("Something went wrong building the PDF. Please try again.");
  } finally {
    exportPdfBtn.disabled = false;
    exportPdfBtn.textContent = "Export PDF";
  }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Best-effort: fetch an image and convert it to a data URL so it can be
// embedded in the PDF. If the host doesn't allow cross-origin fetches,
// this simply fails and the PDF falls back to printing the image's URL
// as a plain link instead of breaking the whole export.
async function imageUrlToDataUrl(url) {
  const response = await fetch(url, { mode: "cors" });
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Reads the image's real pixel width/height so it can be placed in the PDF
// at its own natural aspect ratio instead of being force-cropped to a
// square, and so high-resolution originals actually render sharp.
function getImageNaturalSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Theme colors (mirrors the app's blue palette from style.css)
const PDF_COLOR = {
  ink: [28, 43, 58],
  inkSoft: [91, 107, 124],
  blueDeep: [22, 63, 99],
  blue: [37, 99, 168],
  blueBand: [228, 237, 247],
  blueRule: [127, 168, 204],
  green: [47, 125, 92],
  purple: [106, 82, 201],
  ai: [124, 58, 237],
  danger: [179, 64, 63],
  paper: [255, 255, 255],
};

function pdfDefinitionColor(source) {
  if (source === "dictionary") return PDF_COLOR.green;
  if (source === "ai") return PDF_COLOR.ai;
  if (source && source.startsWith("context")) return PDF_COLOR.purple;
  return PDF_COLOR.danger;
}

function pdfDefinitionLabel(source) {
  if (source === "dictionary") return "Dictionary";
  if (source === "ai") return "AI";
  if (source && source.startsWith("context")) return "In-book";
  return "Manual";
}

async function buildPdfBlob(payload) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  function ensureSpace(neededHeight) {
    if (y + neededHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  // ---- Title block ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.setTextColor(...PDF_COLOR.blueDeep);
  ensureSpace(30);
  doc.text("Literary Vocabulary Register", margin, y);
  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PDF_COLOR.inkSoft);
  doc.text(`${payload.scope}  ·  Exported ${new Date(payload.exportedAt).toLocaleString()}`, margin, y);
  y += 10;
  doc.setDrawColor(...PDF_COLOR.blue);
  doc.setLineWidth(1.6);
  doc.line(margin, y, pageWidth - margin, y);
  doc.setTextColor(...PDF_COLOR.ink);
  y += 22;

  // ---- PDF outline / bookmarks -----------------------------------------
  // Mirrors the exported JSON tree (books → pages → words) as a navigable
  // sidebar outline, the same way a textbook PDF lists chapters and
  // sub-chapters: each Page (or page range) is a top-level bookmark, and
  // each Word on it is a nested sub-bookmark that jumps straight to the
  // page it's printed on. Not every jsPDF build ships the outline module,
  // so this degrades gracefully — the PDF still exports fine without a
  // sidebar if `doc.outline` isn't available.
  const supportsOutline = !!(doc.outline && typeof doc.outline.add === "function");
  function currentPdfPageNumber() {
    return doc.internal.getCurrentPageInfo().pageNumber;
  }

  // Group entries by book, then by page — entries within each page are
  // already sorted in "first entered" order by buildExportPayload().
  const byBook = new Map();
  payload.entries.forEach((e) => {
    if (!byBook.has(e.bookTitle)) byBook.set(e.bookTitle, []);
    byBook.get(e.bookTitle).push(e);
  });

  for (const [book, bookEntries] of byBook) {
    ensureSpace(28);
    const bookNode = supportsOutline ? doc.outline.add(null, book, { pageNumber: currentPdfPageNumber() }) : null;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...PDF_COLOR.blue);
    doc.text(book, margin, y);
    y += 6;
    doc.setDrawColor(...PDF_COLOR.blueRule);
    doc.setLineWidth(1);
    doc.line(margin, y, pageWidth - margin, y);
    doc.setTextColor(...PDF_COLOR.ink);
    y += 18;

    const byPage = new Map();
    bookEntries.forEach((e) => {
      const pageKey = `${e.pageStart}-${e.pageEnd}`;
      if (!byPage.has(pageKey)) byPage.set(pageKey, { label: e.pageLabel, entries: [] });
      byPage.get(pageKey).entries.push(e);
    });

    for (const { label: pageLabel, entries: pageEntries } of byPage.values()) {
      // Page-group band, mirrors the on-screen grouped table.
      ensureSpace(24);
      const pageNode = supportsOutline
        ? doc.outline.add(bookNode, pageLabel, { pageNumber: currentPdfPageNumber() })
        : null;
      doc.setFillColor(...PDF_COLOR.blueBand);
      doc.rect(margin, y - 12, maxWidth, 19, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...PDF_COLOR.blue);
      doc.text(pageLabel, margin + 8, y + 1);
      doc.setTextColor(...PDF_COLOR.ink);
      y += 22;

      for (const entry of pageEntries) {
        ensureSpace(20);
        if (supportsOutline) {
          doc.outline.add(pageNode, entry.word, { pageNumber: currentPdfPageNumber() });
        }
        // Word — set in blue to stand out from the body text.
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.setTextColor(...PDF_COLOR.blueDeep);
        doc.text(entry.word, margin + 10, y);
        doc.setTextColor(...PDF_COLOR.ink);
        y += 14;

        const phon = [];
        if (entry.phonetics?.us?.text) phon.push(`US ${entry.phonetics.us.text}`);
        if (entry.phonetics?.uk?.text) phon.push(`UK ${entry.phonetics.uk.text}`);
        if (phon.length) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(9);
          doc.setTextColor(...PDF_COLOR.inkSoft);
          ensureSpace(12);
          doc.text(phon.join("   ·   "), margin + 10, y);
          doc.setTextColor(...PDF_COLOR.ink);
          y += 13;
        }

        doc.setFontSize(10);
        entry.definitions.forEach((d) => {
          const color = pdfDefinitionColor(d.source);
          const label = `[${pdfDefinitionLabel(d.source)}] `;
          doc.setFont("helvetica", "bold");
          const labelWidth = doc.getTextWidth(`• ${label}`);
          const lines = doc.splitTextToSize(d.text, maxWidth - 10 - labelWidth);
          ensureSpace(lines.length * 12);
          doc.setTextColor(...color);
          doc.text(`• ${label}`, margin + 10, y);
          doc.setFont("helvetica", "normal");
          doc.setTextColor(...PDF_COLOR.ink);
          doc.text(lines, margin + 10 + labelWidth, y);
          y += lines.length * 12;
        });

        // Embed images where possible (best-effort), as elegant bordered
        // cards with a soft drop-shadow. Each image is laid out at its own
        // natural aspect ratio (never force-cropped to a square) within a
        // generous bounding box, and drawn at full quality, so photos read
        // large, sharp, and elegant in the printed/exported document.
        if (entry.images && entry.images.length) {
          const maxImgW = 230;
          const maxImgH = 270;
          const gap = 18;
          let x = margin + 10;
          let rowMaxHeight = 0;
          ensureSpace(maxImgH + gap);

          for (const imgUrl of entry.images) {
            let dataUrl = null;
            let format = "JPEG";
            let renderedW = 150;
            let renderedH = 150;

            try {
              dataUrl = await imageUrlToDataUrl(imgUrl);
              format = dataUrl.includes("image/png") ? "PNG" : "JPEG";
              const { w, h } = await getImageNaturalSize(dataUrl);
              // Scale to fit the bounding box at the image's true aspect
              // ratio; a modest upscale (capped at 1.6x) is allowed so
              // smaller source photos still read as generously sized.
              const scale = Math.min(maxImgW / w, maxImgH / h, 1.6);
              renderedW = w * scale;
              renderedH = h * scale;
            } catch (err) {
              dataUrl = null;
            }

            if (x + renderedW > pageWidth - margin && x > margin + 10) {
              x = margin + 10;
              y += rowMaxHeight + gap;
              rowMaxHeight = 0;
              ensureSpace(maxImgH + gap);
            }

            if (dataUrl) {
              // Soft shadow card behind the image, then a thin rule border
              // around it, mirroring the rounded, shadowed look used for
              // image thumbnails on screen.
              doc.setFillColor(224, 232, 242);
              doc.roundedRect(x - 3, y - 1, renderedW + 6, renderedH + 8, 7, 7, "F");
              // "FAST" applies lossless PDF-stream compression (no drop in
              // image quality) — keeps exported files far smaller than
              // "NONE" (uncompressed), which matters for uploading over a
              // mobile connection.
              doc.addImage(dataUrl, format, x, y, renderedW, renderedH, undefined, "FAST");
              doc.setDrawColor(...PDF_COLOR.blueRule);
              doc.setLineWidth(0.9);
              doc.roundedRect(x, y, renderedW, renderedH, 5, 5, "S");
            } else {
              doc.setFillColor(...PDF_COLOR.blueBand);
              doc.roundedRect(x, y, renderedW, renderedH, 5, 5, "F");
              doc.setFontSize(7);
              doc.setTextColor(...PDF_COLOR.inkSoft);
              const lines = doc.splitTextToSize(imgUrl, renderedW - 10);
              doc.text(lines, x + 5, y + 14);
              doc.setTextColor(...PDF_COLOR.ink);
            }

            rowMaxHeight = Math.max(rowMaxHeight, renderedH);
            x += renderedW + gap;
          }
          y += rowMaxHeight + gap + 6;
        }

        y += 8;
      }
      y += 4;
    }
    y += 10;
  }

  return doc.output("blob");
}

deleteAllBtn.addEventListener("click", () => {
  if (entries.length === 0) {
    alert("Your register is already empty.");
    return;
  }

  const count = entries.length;
  const firstConfirm = confirm(
    `Delete all ${count} ${count === 1 ? "entry" : "entries"} from your register?\n\n` +
      `This cannot be undone. If you haven't exported yet, click Cancel and use "Export JSON" or "Export PDF" first.`
  );
  if (!firstConfirm) return;

  // Second, explicit confirmation for a destructive bulk action.
  const typed = prompt(`Type DELETE to permanently erase all ${count} entries.`);
  if (typed !== "DELETE") {
    alert("Delete all cancelled — nothing was removed.");
    return;
  }

  entries = [];
  saveEntries();
  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
  alert("Your register has been cleared.");
});

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", () => {
  const file = importFileInput.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);

      // Current export shape is a nested books → pages → words tree;
      // flatten it back into one raw-entry-per-word list. Older flat
      // exports (an `entries` array) are still accepted for compatibility.
      let incoming = [];
      if (Array.isArray(parsed?.books)) {
        parsed.books.forEach((book) => {
          (book.pages || []).forEach((page) => {
            (page.words || []).forEach((w) => {
              incoming.push({
                word: w.word,
                bookTitle: book.bookTitle,
                pageStart: page.pageStart,
                pageEnd: page.pageEnd,
                definitions: w.definitions,
                phonetics: w.phonetics,
                images: w.images,
              });
            });
          });
        });
      } else if (Array.isArray(parsed?.entries)) {
        incoming = parsed.entries;
      }

      if (incoming.length === 0) {
        alert("This file doesn't contain any recognizable entries.");
        return;
      }

      const existingKeys = new Set(entries.map((e) => `${e.word}|${e.bookTitle}|${e.pageStart}-${e.pageEnd}`));
      let added = 0;

      incoming.forEach((raw) => {
        // Accept both the current range shape and legacy single-page exports.
        const pageStart = typeof raw.pageStart === "number" ? raw.pageStart : raw.pageNo;
        const pageEnd = typeof raw.pageEnd === "number" ? raw.pageEnd : raw.pageNo;
        if (typeof pageStart !== "number" || typeof pageEnd !== "number") return;

        const key = `${raw.word}|${raw.bookTitle}|${pageStart}-${pageEnd}`;
        if (existingKeys.has(key)) return; // skip duplicates
        existingKeys.add(key);

        const importedDefinitions = (raw.definitions || []).map((d) => ({
          id: generateId(),
          text: d.text,
          source: d.source || "manual",
        }));
        const importedImages = (raw.images || []).map((url) => ({ id: generateId(), url, source: "manual" }));

        entries.push({
          id: generateId(),
          word: raw.word,
          bookTitle: raw.bookTitle,
          pageStart,
          pageEnd,
          timestamp: Date.now(),
          // Assigned in the order entries appear in the file, so relative
          // "first entered" order from the source export is preserved.
          seq: nextSeq++,
          systemDefinitions: importedDefinitions.filter((d) => bucketOf(d.source) === "system"),
          aiDefinitions: importedDefinitions.filter((d) => bucketOf(d.source) === "ai"),
          manualDefinitions: importedDefinitions.filter((d) => bucketOf(d.source) === "manual"),
          systemImages: importedImages.filter((img) => bucketOf(img.source) === "system"),
          aiImages: importedImages.filter((img) => bucketOf(img.source) === "ai"),
          manualImages: importedImages.filter((img) => bucketOf(img.source) === "manual"),
          phonetics: raw.phonetics || { us: null, uk: null },
        });
        added++;
      });

      saveEntries();
      refreshBookFilterOptions();
      refreshBookDatalist();
      renderTable();
      alert(`Imported ${added} new ${added === 1 ? "entry" : "entries"} (duplicates were skipped).`);
    } catch (err) {
      console.error("Import failed:", err);
      alert("Couldn't read that file — please make sure it's a JSON export from this app.");
    } finally {
      importFileInput.value = "";
    }
  };
  reader.readAsText(file);
});

/* ---------------------------------------------------------------------
   RENDERING
--------------------------------------------------------------------- */
function getFilteredEntries() {
  const selectedBook = bookFilter.value;
  const pageQuery = pageFilter.value.trim();
  const searchQuery = searchInput.value.trim().toLowerCase();

  // Smart Page Range Filtering: a bare page number (e.g. "456") first
  // tries to match entries tagged to that exact single page. If nothing
  // explicit matches, fall back to any range that encompasses it (e.g. an
  // entry tagged "450-470" shows up when the person filters on "456").
  let pageQueryNum = null;
  let useRangeFallback = false;
  if (pageQuery) {
    pageQueryNum = parseInt(pageQuery, 10);
    if (Number.isInteger(pageQueryNum)) {
      const hasExactMatch = entries.some(
        (e) => e.pageStart === pageQueryNum && e.pageEnd === pageQueryNum && (!selectedBook || e.bookTitle === selectedBook)
      );
      useRangeFallback = !hasExactMatch;
    }
  }

  return entries.filter((e) => {
    if (selectedBook && e.bookTitle !== selectedBook) return false;
    if (pageQuery) {
      if (!Number.isInteger(pageQueryNum)) return false;
      const matches = useRangeFallback
        ? e.pageStart <= pageQueryNum && pageQueryNum <= e.pageEnd
        : e.pageStart === pageQueryNum && e.pageEnd === pageQueryNum;
      if (!matches) return false;
    }
    if (searchQuery) {
      const haystack = [
        e.word,
        e.bookTitle,
        ...(e.systemDefinitions || []).map((d) => d.text),
        ...(e.aiDefinitions || []).map((d) => d.text),
        ...(e.manualDefinitions || []).map((d) => d.text),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });
}

function renderTable() {
  const selectedBook = bookFilter.value;
  const filtered = getFilteredEntries();

  footerTotal.textContent = entries.length;
  entryCount.textContent = filtered.length
    ? `${filtered.length} ${filtered.length === 1 ? "entry" : "entries"}`
    : "";

  if (entries.length === 0) {
    tableContainer.innerHTML =
      '<p id="empty-state" class="empty-state">No entries yet. Add your first word above to begin your register.</p>';
    return;
  }

  if (filtered.length === 0) {
    tableContainer.innerHTML =
      '<p class="empty-state">No entries match your filters/search.</p>';
    return;
  }

  if (selectedBook) {
    renderGroupedByPage(filtered);
  } else {
    renderFlatTable(filtered);
  }
}

function renderImageCell(entry) {
  const { systemImages, aiImages, manualImages } = getFilteredData(entry);
  const all = [
    ...systemImages.map((img) => ({ ...img, bucket: "system" })),
    ...aiImages.map((img) => ({ ...img, bucket: "ai" })),
    ...manualImages.map((img) => ({ ...img, bucket: "manual" })),
  ];
  if (all.length === 0) {
    return `<td data-label="Images"><span class="no-image">—</span></td>`;
  }
  const bucketTitle = { system: "Dictionary/Auto", ai: "AI Context", manual: "Manual" };
  const imgs = all
    .map(
      (img) =>
        `<img class="row-thumb" data-img-id="${img.id}" data-bucket="${img.bucket}" src="${img.url}" alt="${escapeHtml(entry.word)}" title="${bucketTitle[img.bucket]}" loading="lazy" decoding="async">`
    )
    .join("");
  return `<td data-label="Images"><div class="row-images-gallery">${imgs}</div></td>`;
}

function renderDefinitionCell(entry) {
  const { systemDefinitions, aiDefinitions, manualDefinitions } = getFilteredData(entry);
  const systemItems = systemDefinitions.map((d) => `<li>${sourceLabel(d.source)}${escapeHtml(d.text)}</li>`).join("");
  const aiItems = aiDefinitions.map((d) => `<li>${sourceLabel(d.source)}${escapeHtml(d.text)}</li>`).join("");
  const manualItems = manualDefinitions.map((d) => `<li>${sourceLabel(d.source)}${escapeHtml(d.text)}</li>`).join("");

  // Visually differentiate the three streams with a group heading, per
  // the triple-stream rendering requirement.
  const groups = [];
  if (systemItems) {
    groups.push(
      `<div class="def-bucket"><span class="bucket-label bucket-system">Dictionary</span><ul class="row-definitions">${systemItems}</ul></div>`
    );
  }
  if (aiItems) {
    groups.push(
      `<div class="def-bucket"><span class="bucket-label bucket-ai">AI Context</span><ul class="row-definitions">${aiItems}</ul></div>`
    );
  }
  if (manualItems) {
    groups.push(
      `<div class="def-bucket"><span class="bucket-label bucket-manual">Manual</span><ul class="row-definitions">${manualItems}</ul></div>`
    );
  }
  const content = groups.length ? groups.join("") : '<span class="no-image">—</span>';
  return `<td data-label="Definitions" class="def-cell">${content}</td>`;
}

function renderRowCells(entry, includeBookColumn) {
  const hasUS = !!entry.phonetics?.us;
  const hasUK = !!entry.phonetics?.uk;

  const phoneticLine = [
    hasUS
      ? `<span class="${entry.phonetics.us.source === "ai" ? "pron-text-ai" : ""}" title="${
          entry.phonetics.us.source === "ai" ? "Phonetic respelling from Gemini (approximate)" : ""
        }">US ${escapeHtml(entry.phonetics.us.text || "")}</span>`
      : "",
    hasUK
      ? `<span class="${entry.phonetics.uk.source === "ai" ? "pron-text-ai" : ""}" title="${
          entry.phonetics.uk.source === "ai" ? "Phonetic respelling from Gemini (approximate)" : ""
        }">UK ${escapeHtml(entry.phonetics.uk.text || "")}</span>`
      : "",
  ]
    .filter(Boolean)
    .join(" &nbsp; ");

  return `
    <td data-label="Word">
      <div class="word-cell">
        <span class="word-text">${escapeHtml(entry.word)}</span>
      </div>
      ${phoneticLine ? `<div class="phonetic-line">${phoneticLine}</div>` : ""}
      <div class="pronounce-btns">
        <button class="icon-btn speak-btn" data-id="${entry.id}" data-accent="us" title="American pronunciation">US 🔊</button>
        <button class="icon-btn speak-btn" data-id="${entry.id}" data-accent="uk" title="British pronunciation">UK 🔊</button>
      </div>
    </td>
    ${renderImageCell(entry)}
    ${
      includeBookColumn
        ? `<td data-label="Book">${escapeHtml(entry.bookTitle)}</td>
           <td data-label="Page">${entry.pageStart === entry.pageEnd ? entry.pageStart : `${entry.pageStart}-${entry.pageEnd}`}</td>`
        : ""
    }
    ${renderDefinitionCell(entry)}
    <td data-label="Actions" class="actions-cell">
      <button class="icon-btn edit-btn" data-id="${entry.id}" title="Edit">✏️</button>
      <button class="icon-btn danger delete-btn" data-id="${entry.id}" title="Delete">🗑️</button>
    </td>
  `;
}

function renderFlatTable(list) {
  // Strict chronological/hierarchical sequencing: Book (alphabetical) →
  // Page start (ascending) → seq (order first entered) — the same
  // ordering used for JSON/PDF export, kept consistent everywhere entries
  // are displayed.
  const sorted = list.slice().sort(compareEntriesForExport);

  const rows = sorted
    .map((entry) => `<tr>${renderRowCells(entry, true)}</tr>`)
    .join("");

  tableContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Word &amp; Pronunciation</th>
          <th>Images</th>
          <th>Book</th>
          <th>Page</th>
          <th>Definitions</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  attachRowListeners();
}

function renderGroupedByPage(list) {
  const byPage = new Map();
  list.forEach((entry) => {
    const pageKey = `${entry.pageStart}-${entry.pageEnd}`;
    if (!byPage.has(pageKey)) byPage.set(pageKey, { pageStart: entry.pageStart, pageEnd: entry.pageEnd, entries: [] });
    byPage.get(pageKey).entries.push(entry);
  });

  const sortedGroups = [...byPage.values()].sort((a, b) => a.pageStart - b.pageStart);

  let rows = "";
  sortedGroups.forEach(({ pageStart, pageEnd, entries: pageEntries }) => {
    rows += `<tr class="page-group-row"><td colspan="4">${formatPageLabel(pageStart, pageEnd)}</td></tr>`;
    const wordsOnPage = pageEntries.sort((a, b) => (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp));
    wordsOnPage.forEach((entry) => {
      rows += `<tr>${renderRowCells(entry, false)}</tr>`;
    });
  });

  tableContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Word &amp; Pronunciation</th>
          <th>Images</th>
          <th>Definitions</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  attachRowListeners();
}

function attachRowListeners() {
  tableContainer.querySelectorAll(".speak-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const entry = entries.find((e) => e.id === btn.dataset.id);
      if (entry) playPronunciation(entry, btn.dataset.accent);
    });
  });

  tableContainer.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });

  tableContainer.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteEntry(btn.dataset.id));
  });

  tableContainer.querySelectorAll(".row-thumb").forEach((imgEl) => {
    imgEl.addEventListener("click", () => window.open(imgEl.src, "_blank"));
    imgEl.addEventListener(
      "error",
      () => {
        // Hide dead links in the table rather than showing a broken icon.
        imgEl.style.display = "none";
      },
      { once: true }
    );
  });
}

/* ---------------------------------------------------------------------
   INIT
--------------------------------------------------------------------- */
async function init() {
  storageStatus.textContent = "Checking storage…";
  await loadEntries();
  updateStorageStatusUI();
  updateOriginDisplay();
  initDisplayUI();
  prefillLastBookPage();
  refreshBookFilterOptions();
  refreshBookDatalist();
  renderTable();
  initCustomizeLayout();
  initFetchLimitsUI();
  wordInput.focus();

  console.info(
    "Definitions & phonetics: Free Dictionary API. Images: Openverse API. " +
      "Book-aware AI enhancement: user-configured local/cloud server (click 'AI Settings')."
  );
}

init();

/* ---------------------------------------------------------------------
   GEMINI BRIDGE (optional Chrome extension integration)
   This block only ever talks over window.postMessage — it never
   references chrome.* APIs directly, so the app works identically
   whether or not the "Vocab Register — Gemini Bridge" extension is
   installed; without it, "Search Gemini" is just inert and no
   GEMINI_ENTRY_SCRAPED messages ever arrive.
--------------------------------------------------------------------- */

// "Search Gemini" button — asks the extension to focus/open Gemini and
// type this word into its chat box (the Search-Bridge flow).
const searchGeminiBtn = document.getElementById("search-gemini-btn");
if (searchGeminiBtn) {
  searchGeminiBtn.addEventListener("click", () => {
    const word = wordInput.value.trim();
    if (!word) {
      alert("Type a word first, then click Search Gemini.");
      return;
    }
    const bookTitle = bookInput.value.trim();
    window.postMessage({ type: "SEARCH_GEMINI", word, bookTitle }, window.location.origin);
  });
}

// Gemini's "direct URL to a representative image" is frequently a
// hallucinated/dead link — LLMs are unreliable at producing real,
// resolvable image URLs. Probe it with a throwaway Image() first; if it
// 404s/errors, fall back to the app's own Openverse image search (the
// same one "Fetch with AI" already uses) instead of leaving nothing.
function addImageWithFallback(url, fallbackQuery) {
  const probe = new Image();
  probe.onload = () => addPendingImage(url, "ai", true);
  probe.onerror = async () => {
    console.warn("[VocabBridge] Gemini's image URL didn't load, falling back to image search:", url);
    if (!fallbackQuery) return;
    try {
      const result = await fetchImages(fallbackQuery, 1);
      if (result.ok && result.images[0]) {
        addPendingImage(result.images[0], "ai", true);
      } else {
        console.warn("[VocabBridge] Fallback image search also came up empty for:", fallbackQuery);
      }
    } catch (err) {
      console.warn("[VocabBridge] Fallback image search failed:", err);
    }
  };
  probe.src = url;
}

// Receives a scraped Gemini entry relayed by the extension's app-side
// content script (the Scrape-Back flow). Wrapped in try/catch so a
// malformed or unexpected message can never break the rest of the app.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "GEMINI_ENTRY_SCRAPED") return;

  console.log("[VocabBridge] script.js received GEMINI_ENTRY_SCRAPED:", event.data.payload);

  try {
    const payload = event.data.payload || {};
    // content-gemini.js already parses Gemini's reply into these fields
    // (DEF: / US: / UK: labeled lines, plus whatever <img> it attached)
    // before it ever leaves the extension — nothing left to split here.
    const definition = typeof payload.definition === "string" ? payload.definition.trim() : "";
    const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl.trim() : "";
    const usPronunciation = typeof payload.usPronunciation === "string" ? payload.usPronunciation.trim() : "";
    const ukPronunciation = typeof payload.ukPronunciation === "string" ? payload.ukPronunciation.trim() : "";
    const wordForFallback = wordInput.value.trim();

    // Clear any stale pending definitions/images/tags before injecting
    // the new data — same as a fresh "Fetch with AI" run would.
    resetFormPendingState();

    // source: "ai" so this flows through the app's existing AI
    // definition/image buckets (see bucketOf()) exactly like AI-fetched
    // results do — no separate handling needed anywhere else.
    if (definition) {
      addPendingDefinition(definition, "ai", true);
    }
    if (imageUrl) {
      addImageWithFallback(imageUrl, wordForFallback);
    }

    // Gemini can only ever supply the phonetic *text* here, never real
    // recorded audio — so this is stored with audio: null. Pressing the
    // 🔊 buttons still works exactly as before: playPendingPronunciation()
    // falls through to the Google Translate voice / on-device speech
    // synthesis chain (playAudioChain), which already picks the correct
    // US/UK accent. This is what makes proper nouns and book-specific
    // names — which the Free Dictionary API usually has no entry for at
    // all — show a pronunciation instead of "—".
    if (usPronunciation) pendingPhonetics.us = { text: usPronunciation, audio: null, source: "ai" };
    if (ukPronunciation) pendingPhonetics.uk = { text: ukPronunciation, audio: null, source: "ai" };
    if (usPronunciation || ukPronunciation) renderPhoneticPreview(pendingPhonetics);

    // Ready for the person to review/adjust and hit "Add Entry" —
    // fully auto-populated, zero further interaction needed to get here.
    wordInput.focus();
  } catch (err) {
    console.error("[VocabBridge] Ignored a malformed message from the Gemini bridge:", err);
  }
});

// Fires if bridge-app.js couldn't reach the extension at all — almost
// always because the extension was reloaded/updated in
// chrome://extensions after this tab was already open, orphaning its
// content script. A page refresh reconnects it.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "GEMINI_BRIDGE_DISCONNECTED") return;
  alert(
    "The Gemini Bridge extension isn't responding — this usually happens right after it's been " +
      "reloaded/updated. Please refresh this page (and the Gemini tab) and try again."
  );
});

// Handshake: tells the extension (if installed) that resetFormPendingState/
// addPendingDefinition/addPendingImage/wordInput above are now defined, so
// it's safe to deliver any Gemini data — including anything scraped and
// queued before this page finished loading.
//
// bridge-app.js is a content script injected at document_idle — it can
// easily still be initializing when script.js's own <script> tag runs,
// so a single postMessage() here can fire before anyone is listening
// and get lost forever. Instead, poll every 400ms until bridge-app.js
// sends back APP_READY_ACK, then stop. Capped at ~20 attempts (~8s) so
// this doesn't poll forever if the extension isn't installed/enabled.
let appReadyAckReceived = false;
let appReadyAttempts = 0;
const APP_READY_MAX_ATTEMPTS = 20;

const appReadyInterval = setInterval(() => {
  if (appReadyAckReceived) {
    clearInterval(appReadyInterval);
    return;
  }
  if (++appReadyAttempts > APP_READY_MAX_ATTEMPTS) {
    clearInterval(appReadyInterval);
    console.warn(
      "[VocabBridge] Gave up waiting for the extension's handshake ack after " +
        APP_READY_MAX_ATTEMPTS +
        " attempts — Gemini Bridge extension may not be installed/enabled."
    );
    return;
  }
  console.log("[VocabBridge] script.js sending APP_READY handshake...");
  window.postMessage({ type: "APP_READY" }, window.location.origin);
}, 400);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "APP_READY_ACK") return;
  appReadyAckReceived = true;
  clearInterval(appReadyInterval);
  console.log("[VocabBridge] script.js handshake acknowledged by extension!");
});

/* =========================================================================
   CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM
   ---------------------------------------------------------------------
   A single source of truth (SHORTCUT_FIELDS + shortcutConfig) drives:
     1. The sliding "⌨️ Keyboard Shortcuts" sidebar (#settings-sidebar),
        where every binding is click-to-record and saved to localStorage.
     2. A global keydown dispatcher that fires the matching action the
        instant a mapped key is pressed — even while a form field has
        focus — unless the configured Pass-Through Modifier is held, in
        which case we get out of the way entirely and let the browser
        type the character normally.
     3. Keyboard navigation + selection for the Definitions/Images lists.
     4. The two-way Gemini-tab / App-tab focus switch, relayed to the
        companion extension over the same window.postMessage channel
        the Gemini Bridge already uses (see the block above this one).

   Written as a single IIFE so its many small helpers don't leak into
   the global namespace / collide with anything above.
========================================================================= */
(function initShortcutSystem() {
  const SHORTCUT_STORAGE_KEY = "vocabRegister_shortcutConfig";

  // ---- Defaults (all non-alphabet, so plain word/book typing is never
  // affected unless a binding is deliberately reassigned) --------------
  // passThroughModifier defaults to Shift — it's a real modifier key
  // (the browser reports it natively via e.shiftKey), it has no native
  // default action of its own to fight with, and — unlike Alt or
  // Control/Meta — it doesn't collide with common OS/browser shortcuts
  // (Alt+Space opens Windows' system menu before the browser ever sees
  // it; Ctrl/Cmd+<key> is used everywhere). This is only the default —
  // like every other shortcut in this file, it's click-to-record: click
  // the Pass-Through Modifier button in the sidebar and press any key —
  // CapsLock, Tab, ContextMenu, Alt, a letter, whatever — to use that
  // instead.
  const DEFAULT_SHORTCUTS = {
    passThroughModifier: "Shift",

    defUp: "ArrowUp",
    defDown: "ArrowDown",
    imgLeft: "ArrowLeft",
    imgRight: "ArrowRight",
    selectItem: "Space",

    focusGeminiTab: "F7",
    focusAppTab: "F8",

    // Focus mappings — jump straight into the Word / Page bars.
    focusWordInput: "Backslash",
    focusPageInput: "Slash",

    // Word Bar inline cursor navigation — only acts while the Word
    // Input Bar itself is actively focused (see the dispatcher below).
    wordCursorLeft: "Minus",
    wordCursorRight: "Equal",

    // Multi-key Page Calculation (simultaneous press) — Increment/
    // Decrement Page Number aren't separate bindings of their own; they
    // fire when focusPageInput is held down together with
    // wordCursorRight/wordCursorLeft (default: '/' + '=' to increment,
    // '/' + '-' to decrement). Rebinding either of those three keys
    // above automatically updates which physical keys the chord needs.

    playUs: "BracketLeft",
    playUk: "BracketRight",

    toggleSettings: "F1",
    quickSearch: "F3",
    advancedPanel: "F6",
    manualBackup: "F9",

    searchGemini: "Quote",
    fetchAi: "F2",
    addEntry: "Enter",
    addManualDefinition: "Semicolon",
    addManualImage: "F4",
  };

  // Rendering metadata for the sidebar — order here is display order.
  const SHORTCUT_FIELDS = [
    { key: "toggleSettings", label: "Settings Panel Toggle (⌨️)", group: "Header Bar" },
    { key: "quickSearch", label: "Quick Search View (🔍 Display)", group: "Header Bar" },
    { key: "advancedPanel", label: "Advanced Control Panel (🎛️ Customize)", group: "Header Bar" },
    { key: "manualBackup", label: "Manual Backup / Save Layout (💾 Storage)", group: "Header Bar" },

    { key: "searchGemini", label: "Search Gemini", group: "Main Actions" },
    { key: "fetchAi", label: "Fetch with AI", group: "Main Actions" },
    { key: "addEntry", label: "Add Entry", group: "Main Actions" },
    { key: "addManualDefinition", label: "Add Manual Definition", group: "Main Actions" },
    { key: "addManualImage", label: "Add Manual Image", group: "Main Actions" },

    { key: "playUs", label: "Play US Pronunciation", group: "Pronunciation" },
    { key: "playUk", label: "Play UK Pronunciation", group: "Pronunciation" },

    { key: "defUp", label: "Definitions List — Up", group: "List Navigation" },
    { key: "defDown", label: "Definitions List — Down", group: "List Navigation" },
    { key: "imgLeft", label: "Images List — Left", group: "List Navigation" },
    { key: "imgRight", label: "Images List — Right", group: "List Navigation" },
    { key: "selectItem", label: "Select Highlighted Item", group: "List Navigation" },

    { key: "focusGeminiTab", label: "Focus Gemini Tab", group: "Extension / Tabs" },
    { key: "focusAppTab", label: "Return to App Tab", group: "Extension / Tabs" },

    { key: "focusWordInput", label: "Focus Word Input Bar", group: "Focus & Cursor" },
    { key: "focusPageInput", label: "Focus Page Input Bar", group: "Focus & Cursor" },
    { key: "wordCursorLeft", label: "Move Cursor Left in Word Bar", group: "Focus & Cursor" },
    { key: "wordCursorRight", label: "Move Cursor Right in Word Bar", group: "Focus & Cursor" },
  ];

  // The Pass-Through Modifier can be set to literally any key (see
  // startRecording() below) — not just a fixed list. Shift/Alt/Control/
  // Meta are real modifier keys, so the browser exposes them directly
  // as e.shiftKey/altKey/ctrlKey/metaKey and isConfiguredModifierHeld()
  // checks those natively. Anything else (CapsLock, Tab, ContextMenu, a
  // letter, an F-key...) is an ordinary key with no such flag, so its
  // "held" state is tracked by hand via `heldKeys` instead — see
  // isConfiguredModifierHeld() and the dispatcher below.
  const NATIVE_MODIFIER_FLAGS = { Shift: "shiftKey", Alt: "altKey", Control: "ctrlKey", Meta: "metaKey" };

  // ---- Pretty labels for KeyboardEvent.code values --------------------
  const KEY_LABELS = {
    ArrowUp: "↑ Up",
    ArrowDown: "↓ Down",
    ArrowLeft: "← Left",
    ArrowRight: "→ Right",
    Space: "Space",
    Enter: "Enter ⏎",
    Quote: "'",
    Semicolon: ";",
    BracketLeft: "[",
    BracketRight: "]",
    Escape: "Esc",
    Backslash: "\\",
    Slash: "/",
    Minus: "-",
    Equal: "=",
    CapsLock: "Caps Lock",
    Tab: "Tab ⇥",
    ContextMenu: "Menu ☰",
  };
  function labelForCode(code) {
    if (!code) return "— unbound —";
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    if (/^F([1-9]|1[0-9])$/.test(code)) return code;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    return code;
  }

  // ---- Load / persist config ------------------------------------------
  function loadConfig() {
    try {
      const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      const merged = { ...DEFAULT_SHORTCUTS, ...saved };
      return merged;
    } catch (err) {
      console.warn("[Shortcuts] Couldn't read saved shortcut config — using defaults.", err);
      return { ...DEFAULT_SHORTCUTS };
    }
  }

  let shortcutConfig = loadConfig();
  let codeToAction = {};

  function rebuildCodeToAction() {
    codeToAction = {};
    Object.keys(shortcutConfig).forEach((k) => {
      if (k === "passThroughModifier") return;
      if (shortcutConfig[k]) codeToAction[shortcutConfig[k]] = k;
    });
  }

  function saveConfig() {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcutConfig));
    rebuildCodeToAction();
    syncTabSwitchKeysToExtension();
  }

  // Tells the companion extension (if installed) which keys currently
  // mean "focus Gemini tab" / "return to app tab", so content-gemini.js
  // can listen for the *same* "return to app tab" key while you're
  // sitting on the Gemini tab itself — see background.js / bridge-app.js
  // for the relay, and content-gemini.js for where it's consumed.
  function syncTabSwitchKeysToExtension() {
    window.postMessage(
      {
        type: "SYNC_SHORTCUT_KEYS",
        focusGeminiKey: shortcutConfig.focusGeminiTab,
        focusAppKey: shortcutConfig.focusAppTab,
      },
      window.location.origin
    );
  }

  /* -----------------------------------------------------------------
     SIDEBAR: build + open/close + key-capture
  ----------------------------------------------------------------- */
  const settingsSidebar = document.getElementById("settings-sidebar");
  const settingsSidebarBackdrop = document.getElementById("settings-sidebar-backdrop");
  const shortcutsToggleBtn = document.getElementById("shortcuts-toggle-btn");
  const settingsSidebarCloseBtn = document.getElementById("settings-sidebar-close-btn");
  const shortcutFieldsList = document.getElementById("shortcut-fields-list");
  const shortcutsResetBtn = document.getElementById("shortcuts-reset-btn");

  function openSidebar() {
    if (!settingsSidebar) return;
    settingsSidebar.classList.add("open");
    settingsSidebarBackdrop?.classList.add("open");
    settingsSidebar.setAttribute("aria-hidden", "false");
  }
  function closeSidebar() {
    if (!settingsSidebar) return;
    settingsSidebar.classList.remove("open");
    settingsSidebarBackdrop?.classList.remove("open");
    settingsSidebar.setAttribute("aria-hidden", "true");
    cancelRecording();
  }
  function toggleSidebar() {
    if (!settingsSidebar) return;
    if (settingsSidebar.classList.contains("open")) closeSidebar();
    else openSidebar();
  }

  shortcutsToggleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  settingsSidebarCloseBtn?.addEventListener("click", closeSidebar);
  settingsSidebarBackdrop?.addEventListener("click", closeSidebar);

  let recordingBtn = null;
  let recordingKey = null;

  function cancelRecording() {
    if (recordingBtn) {
      recordingBtn.classList.remove("listening");
      recordingBtn.textContent = labelForCode(shortcutConfig[recordingKey]);
    }
    recordingBtn = null;
    recordingKey = null;
  }

  // Physical modifier-only key codes and the family name each normalizes
  // to. Regular shortcut fields still reject these outright (a bare
  // Shift/Alt/Control/Meta press makes no sense as a standalone
  // "trigger this action" binding) — but the Pass-Through Modifier field
  // uses this map to fold ShiftLeft/ShiftRight into plain "Shift" and so
  // on, so either physical key works no matter which one gets pressed.
  const MODIFIER_CODES = new Set([
    "AltLeft", "AltRight", "ControlLeft", "ControlRight",
    "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
  ]);
  const NATIVE_MODIFIER_FAMILY = {
    AltLeft: "Alt", AltRight: "Alt",
    ControlLeft: "Control", ControlRight: "Control",
    ShiftLeft: "Shift", ShiftRight: "Shift",
    MetaLeft: "Meta", MetaRight: "Meta",
  };

  function startRecording(btn, key) {
    cancelRecording();
    recordingBtn = btn;
    recordingKey = key;
    btn.classList.add("listening");
    btn.textContent = "Press a key…";

    // The Pass-Through Modifier isn't a "press this to trigger an
    // action" binding like every other field — it's whatever key you
    // hold down, so it's allowed to be literally anything, including
    // Shift/Alt/Control/Meta themselves.
    const isPassThroughField = key === "passThroughModifier";

    // Capture phase + {once:true} so this fires (and fully swallows the
    // event via stopPropagation) before the global dispatcher below —
    // and before anything else on the page — ever sees the keystroke.
    window.addEventListener(
      "keydown",
      (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.code === "Escape") {
          cancelRecording();
          return;
        }
        if (!isPassThroughField && MODIFIER_CODES.has(e.code)) {
          cancelRecording();
          alert("That's a modifier key — it can only be set as the Pass-Through Modifier, not a standalone shortcut.");
          return;
        }

        const newCode = isPassThroughField && NATIVE_MODIFIER_FAMILY[e.code]
          ? NATIVE_MODIFIER_FAMILY[e.code]
          : e.code;

        if (isPassThroughField) {
          // A held modifier isn't a single-press shortcut, so it doesn't
          // go through the clash check below — but if the chosen key
          // normally types a visible character (a letter, digit, Space,
          // punctuation...), holding it alone will stop it from typing
          // that character anywhere else in the app, so confirm first
          // instead of silently surprising you later.
          if (e.key.length === 1) {
            const proceed = confirm(
              `"${labelForCode(newCode)}" normally types a character. Using it as your Pass-Through Modifier means holding it by itself will stop it from typing that character anywhere in the app. Continue?`
            );
            if (!proceed) {
              cancelRecording();
              return;
            }
          }
          shortcutConfig.passThroughModifier = newCode;
          saveConfig();
          cancelRecording();
          renderSidebarRows();
          applyShortcutTitles();
          return;
        }

        const clashKey = Object.keys(shortcutConfig).find(
          (k) => k !== "passThroughModifier" && k !== key && shortcutConfig[k] === newCode
        );
        if (clashKey) {
          const clashField = SHORTCUT_FIELDS.find((f) => f.key === clashKey);
          const proceed = confirm(
            `"${labelForCode(newCode)}" is already used for "${clashField ? clashField.label : clashKey}". ` +
              `Assign it here anyway? (That other shortcut will become unbound.)`
          );
          if (!proceed) {
            cancelRecording();
            return;
          }
          shortcutConfig[clashKey] = null;
        }

        shortcutConfig[key] = newCode;
        saveConfig();
        cancelRecording();
        renderSidebarRows();
        applyShortcutTitles();
      },
      { capture: true, once: true }
    );
  }

  function renderSidebarRows() {
    if (!shortcutFieldsList) return;

    let html = `<div class="shortcut-group-title">Pass-Through Modifier</div>
      <div class="shortcut-row">
        <span class="shortcut-row-label">Hold this while pressing a mapped key to type it literally</span>
        <button type="button" class="shortcut-key-input" data-shortcut-key="passThroughModifier">${escapeHtml(
          labelForCode(shortcutConfig.passThroughModifier)
        )}</button>
      </div>`;

    let lastGroup = null;
    SHORTCUT_FIELDS.forEach((field) => {
      if (field.group !== lastGroup) {
        html += `<div class="shortcut-group-title">${escapeHtml(field.group)}</div>`;
        lastGroup = field.group;
      }
      const code = shortcutConfig[field.key];
      html += `
        <div class="shortcut-row">
          <span class="shortcut-row-label">${escapeHtml(field.label)}</span>
          <button type="button" class="shortcut-key-input" data-shortcut-key="${field.key}">${escapeHtml(
        labelForCode(code)
      )}</button>
        </div>`;
    });

    shortcutFieldsList.innerHTML = html;

    // ---- Multi-Key Page Calculation (Simultaneous Press) — informational
    // only, since these two "bindings" are derived from whatever
    // focusPageInput + wordCursorRight/wordCursorLeft are currently set
    // to above, rather than being independently recordable keys of
    // their own. Rebinding any of those three fields updates this
    // display (and the actual chord the dispatcher listens for)
    // automatically the next time the sidebar re-renders.
    const chordSection = document.createElement("div");
    chordSection.innerHTML = `
      <div class="shortcut-group-title">Multi-Key Page Calculation (Simultaneous Press)</div>
      <div class="shortcut-row">
        <span class="shortcut-row-label">Increment Page Number</span>
        <span class="shortcut-key-display">${escapeHtml(labelForCode(shortcutConfig.focusPageInput))} + ${escapeHtml(
      labelForCode(shortcutConfig.wordCursorRight)
    )}</span>
      </div>
      <div class="shortcut-row">
        <span class="shortcut-row-label">Decrement Page Number</span>
        <span class="shortcut-key-display">${escapeHtml(labelForCode(shortcutConfig.focusPageInput))} + ${escapeHtml(
      labelForCode(shortcutConfig.wordCursorLeft)
    )}</span>
      </div>
      <p class="shortcut-row-hint">Hold both keys of a pair down together — these aren't separately rebindable, they follow whatever "Focus Page Input Bar" / "Move Cursor Left/Right in Word Bar" are set to above.</p>
    `;
    shortcutFieldsList.appendChild(chordSection);

    shortcutFieldsList.querySelectorAll("[data-shortcut-key]").forEach((btn) => {
      btn.addEventListener("click", () => startRecording(btn, btn.dataset.shortcutKey));
    });
  }

  shortcutsResetBtn?.addEventListener("click", () => {
    if (!confirm("Reset all keyboard shortcuts to their defaults?")) return;
    shortcutConfig = { ...DEFAULT_SHORTCUTS };
    saveConfig();
    renderSidebarRows();
    applyShortcutTitles();
  });

  // Esc closes the sidebar (and cancels any in-progress key capture) —
  // wired independently of the existing Esc-closes-customize-mode
  // listener elsewhere in this file, so both work side by side.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsSidebar?.classList.contains("open")) closeSidebar();
  });

  /* -----------------------------------------------------------------
     Button title hints — "Add Entry [Enter]" etc. Stores each
     element's original title once (data-base-title) so re-applying
     after a rebinding never stacks up duplicate "[X] [Y]" suffixes.
  ----------------------------------------------------------------- */
  function ensureBaseTitle(el, fallback) {
    if (!el.dataset.baseTitle) {
      el.dataset.baseTitle = el.getAttribute("title") || fallback;
    }
    return el.dataset.baseTitle;
  }

  function applyShortcutTitles() {
    const targets = [
      [document.getElementById("entry-form-submit-btn"), "addEntry", "Add Entry"],
      [aiFetchBtn, "fetchAi", "Fetch with AI"],
      [typeof searchGeminiBtn !== "undefined" ? searchGeminiBtn : null, "searchGemini", "Search Gemini"],
      [addDefinitionBtn, "addManualDefinition", "Add this definition"],
      [addImageBtn, "addManualImage", "Add this image"],
      [pronUsBtn, "playUs", "Play American pronunciation"],
      [pronUkBtn, "playUk", "Play British pronunciation"],
      [shortcutsToggleBtn, "toggleSettings", "Keyboard Shortcuts"],
      [displayToggleBtn, "quickSearch", "Display settings"],
      [customizeToggleBtn, "advancedPanel", "Customize layout"],
      [storageToggleBtn, "manualBackup", "Storage settings"],
      [wordInput, "focusWordInput", "Word"],
      [pageInput, "focusPageInput", "Page No."],
    ];
    targets.forEach(([el, key, fallback]) => {
      if (!el) return;
      const base = ensureBaseTitle(el, fallback);
      const code = shortcutConfig[key];
      el.title = code ? `${base} [${labelForCode(code)}]` : base;
    });
  }

  /* -----------------------------------------------------------------
     LIST NAVIGATION (Definitions / Images) — works against whichever
     pair of lists is currently visible: the main add-entry form, or
     the edit modal, if it's open.
  ----------------------------------------------------------------- */
  function getDefListContext() {
    const inEdit = !editModal.classList.contains("hidden");
    return inEdit
      ? { container: editDefinitionsList, list: editPendingDefinitions, cardClass: "definition-card", checkboxClass: "definition-checkbox" }
      : { container: definitionsList, list: pendingDefinitions, cardClass: "definition-card", checkboxClass: "definition-checkbox" };
  }
  function getImgListContext() {
    const inEdit = !editModal.classList.contains("hidden");
    return inEdit
      ? { container: editImagesGallery, list: editPendingImages, cardClass: "image-card", checkboxClass: "image-checkbox" }
      : { container: imagesGallery, list: pendingImages, cardClass: "image-card", checkboxClass: "image-checkbox" };
  }

  let defNavId = null;
  let imgNavId = null;
  let lastNavKind = null; // "def" | "img" | null — which list Space acts on

  function hasEntries(kind) {
    const ctx = kind === "def" ? getDefListContext() : getImgListContext();
    return ctx.list.length > 0;
  }

  function navigateList(kind, direction) {
    const ctx = kind === "def" ? getDefListContext() : getImgListContext();
    const cards = Array.from(ctx.container.querySelectorAll(`.${ctx.cardClass}`));
    if (!cards.length) return;
    const currentId = kind === "def" ? defNavId : imgNavId;
    let idx = cards.findIndex((c) => c.dataset.id === currentId);
    idx = idx === -1 ? (direction > 0 ? 0 : cards.length - 1) : (idx + direction + cards.length) % cards.length;
    const newId = cards[idx].dataset.id;
    if (kind === "def") defNavId = newId;
    else imgNavId = newId;
    lastNavKind = kind;
    applyListHighlight(kind);
  }

  function applyListHighlight(kind) {
    const ctx = kind === "def" ? getDefListContext() : getImgListContext();
    const navId = kind === "def" ? defNavId : imgNavId;
    ctx.container.querySelectorAll(`.${ctx.cardClass}`).forEach((c) => {
      c.classList.toggle("shortcut-active-item", navId != null && c.dataset.id === navId);
    });
    if (navId) {
      ctx.container.querySelector(`.${ctx.cardClass}[data-id="${navId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  // Simulates a mouse click on the highlighted card's checkbox — this
  // reuses the existing onToggle/re-render wiring in renderDefinitions()/
  // renderImages() exactly as-is, so no changes were needed there. The
  // re-render wipes our highlight class, so we reapply it right after.
  function selectHighlightedItem() {
    const kind = lastNavKind;
    if (!kind) return;
    const ctx = kind === "def" ? getDefListContext() : getImgListContext();
    const navId = kind === "def" ? defNavId : imgNavId;
    if (!navId) return;
    const card = ctx.container.querySelector(`.${ctx.cardClass}[data-id="${navId}"]`);
    const checkbox = card?.querySelector(`.${ctx.checkboxClass}`);
    if (!checkbox) return;
    checkbox.click();
    applyListHighlight(kind);
  }

  /* -----------------------------------------------------------------
     WORD BAR INLINE CURSOR NAVIGATION + MULTI-KEY PAGE CHORDS
     ---------------------------------------------------------------
     moveWordCursor() shifts the text caret in the Word Input Bar by one
     character using its own selectionStart/selectionEnd — if there's an
     existing text selection, moving collapses it in the requested
     direction first rather than jumping from an arbitrary edge.

     adjustPageNumber() reads the Page bar's current value, nudges it by
     the given delta, and writes it straight back (never below 1) — used
     by the Increment/Decrement Page Number chords below.
  ----------------------------------------------------------------- */
  function moveWordCursor(direction) {
    const { selectionStart, selectionEnd } = wordInput;
    const base = selectionStart === selectionEnd ? selectionStart : direction < 0 ? selectionStart : selectionEnd;
    const newPos = Math.max(0, Math.min(wordInput.value.length, base + direction));
    wordInput.setSelectionRange(newPos, newPos);
  }

  function adjustPageNumber(delta) {
    // Range-aware: nudges both ends of a page range together (e.g.
    // "450-470" -> "451-471"), preserving the range's width. A plain
    // single page just nudges that one number, same as before.
    const parsed = parsePageRangeInput(pageInput.value);
    const pageStart = parsed ? parsed.pageStart : 0;
    const pageEnd = parsed ? parsed.pageEnd : 0;
    const nextStart = Math.max(1, pageStart + delta);
    const nextEnd = Math.max(nextStart, pageEnd + delta);
    pageInput.value = formatPageRangeText(nextStart, nextEnd);
    pageInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Physical key-hold tracking (true/false), used ONLY to detect the
  // Increment/Decrement Page Number chords — a genuine simultaneous
  // hold of the configured Page-focus key together with the Word Bar
  // cursor-left/right keys (default: '/' + '=' to increment, '/' + '-'
  // to decrement). Updated on every keydown/keyup regardless of which
  // element has focus, mirroring how every other global shortcut here
  // already ignores focus context (except where explicitly noted, like
  // the cursor-navigation actions below).
  const heldKeys = {};

  // True for controls where typing a literal character makes sense —
  // i.e. genuine text entry (Word/Book/Page bars, manual definition/
  // image-URL boxes, Search, table filters, and their edit-modal
  // equivalents). Deliberately false for checkboxes/radios/buttons.
  function isTextEntryElement(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
  }

  // True only when EXACTLY the configured Pass-Through Modifier is held
  // (no other modifiers at the same time) — keeps things predictable if
  // someone happens to hold two modifiers together for an unrelated
  // reason.
  //
  // Shift/Alt/Control/Meta are real modifier keys, so the browser
  // reports each directly via its own e.*Key flag and that's checked
  // natively below. Any other key (CapsLock, Tab, ContextMenu, a
  // letter, an F-key — whatever got recorded) is ordinary — nothing in
  // the KeyboardEvent API reflects its held state — so those rely on
  // `heldKeys`, which the dispatcher below keeps up to date on every
  // keydown/keyup regardless of focus (the same tracking the
  // Page-Number chord uses).
  function isConfiguredModifierHeld(e) {
    const modifier = shortcutConfig.passThroughModifier;
    if (!modifier) return false;
    const flag = NATIVE_MODIFIER_FLAGS[modifier];
    if (flag) {
      return ["altKey", "ctrlKey", "shiftKey", "metaKey"].every((f) => (f === flag ? e[f] : !e[f]));
    }
    return (
      !!heldKeys[modifier] &&
      e.code !== modifier &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.metaKey
    );
  }

  // Manually types `char` into `el` at the current cursor position (or
  // over the current selection). Needed because holding Control/Alt/Meta
  // — unlike Shift — makes the browser treat the keypress as a pure
  // command rather than typed text: it never fires its own "insert this
  // character" default action at all, with or without our own
  // preventDefault(). Letting the event "fall through" (as the pass-
  // through modifier used to) relied on the browser doing that
  // insertion itself, which is exactly what doesn't happen — this
  // does it explicitly instead, then fires a real "input" event so
  // anything listening for changes on the field still sees it.
  // The same is true — for a different reason — of any non-modifier key
  // (CapsLock, Tab, ContextMenu, a letter...): those aren't modifiers at
  // all, so the browser's normal typing behavior was never going to
  // fire for them regardless.
  function insertLiteralCharacter(el, char) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + char + el.value.slice(end);
    const newPos = start + char.length;
    el.setSelectionRange?.(newPos, newPos);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* -----------------------------------------------------------------
     GLOBAL KEY DISPATCHER
  ----------------------------------------------------------------- */
  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (recordingBtn) return; // sidebar is actively capturing a new binding

    if (!e.repeat) heldKeys[e.code] = true;

    // ---- Neutralize the pass-through modifier's own default action ----
    // Non-modifier keys each have some native default action of their
    // own on keydown — CapsLock toggles Caps Lock, Tab shifts focus,
    // ContextMenu opens the right-click menu, a letter types itself —
    // regardless of what's held afterward. None of that is useful while
    // the key is just being held to unlock literal typing for the
    // *next* keypress, so it's suppressed here. Shift/Alt/Control/Meta
    // have no such default action of their own, so they need nothing.
    if (
      shortcutConfig.passThroughModifier &&
      !NATIVE_MODIFIER_FLAGS[shortcutConfig.passThroughModifier] &&
      e.code === shortcutConfig.passThroughModifier &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.metaKey
    ) {
      e.preventDefault();
    }

    // ---- Multi-key chord check (Increment/Decrement Page Number) ----
    // Checked before the pass-through-modifier gate below (a held
    // modifier still falls through to "leave this alone", same as
    // every single-key shortcut) and before the single-key switch, so
    // a genuine simultaneous hold always wins over whichever key
    // happened to be pressed first.
    if (!e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      const pageKey = shortcutConfig.focusPageInput;
      const incKey = shortcutConfig.wordCursorRight;
      const decKey = shortcutConfig.wordCursorLeft;
      if (pageKey && incKey && heldKeys[pageKey] && heldKeys[incKey]) {
        e.preventDefault();
        adjustPageNumber(1);
        return;
      }
      if (pageKey && decKey && heldKeys[pageKey] && heldKeys[decKey]) {
        e.preventDefault();
        adjustPageNumber(-1);
        return;
      }
    }

    // ---- Pass-Through Modifier: type the literal character ourselves ----
    // Holding the configured modifier while pressing a key that's bound
    // to one of our shortcuts should type that key's own character (e.g.
    // Space) instead of triggering the shortcut. But Control/Alt/Meta
    // held down suppress the browser's normal character-typing action
    // entirely — simply doing nothing here (as before) left the
    // keystroke producing no character at all, not a passed-through one.
    // So when this fires while a real text field has focus, insert the
    // character ourselves.
    if (
      isConfiguredModifierHeld(e) &&
      codeToAction[e.code] &&
      e.key.length === 1 &&
      isTextEntryElement(document.activeElement)
    ) {
      e.preventDefault();
      insertLiteralCharacter(document.activeElement, e.key);
      return;
    }

    // Any modifier held at all means "leave this alone" for everything
    // else: if it's the configured Pass-Through Modifier but nothing
    // above applied (not a bound key, or focus isn't in a text field),
    // there's nothing useful to do here — the browser's own handling
    // (or lack thereof) for that combo takes over. If it's some other
    // combo, it might be a browser/OS shortcut we shouldn't step on
    // either way.
    if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;

    const action = codeToAction[e.code];
    if (!action) return;

    switch (action) {
      case "toggleSettings":
        e.preventDefault();
        toggleSidebar();
        break;

      case "quickSearch":
        e.preventDefault();
        displayToggleBtn?.click();
        break;

      case "advancedPanel":
        e.preventDefault();
        customizeToggleBtn?.click();
        break;

      case "manualBackup":
        e.preventDefault();
        storageToggleBtn?.click();
        break;

      case "searchGemini":
        e.preventDefault();
        if (typeof searchGeminiBtn !== "undefined") searchGeminiBtn?.click();
        break;

      case "fetchAi":
        e.preventDefault();
        aiFetchBtn?.click();
        break;

      case "addEntry": {
        // The default binding (Enter) is already handled — with its own
        // careful per-field exclusions — by the pre-existing document
        // Enter-listener earlier in this file. Only take over here once
        // the person has actually rebound Add Entry to something else.
        if (shortcutConfig.addEntry === "Enter") return;
        if (!editModal.classList.contains("hidden")) return;
        e.preventDefault();
        guardedAddEntry(beginAddAttempt());
        break;
      }

      case "addManualDefinition":
        e.preventDefault();
        (editModal.classList.contains("hidden") ? addDefinitionBtn : editAddDefinitionBtn)?.click();
        break;

      case "addManualImage":
        e.preventDefault();
        (editModal.classList.contains("hidden") ? addImageBtn : editAddImageBtn)?.click();
        break;

      case "playUs":
        e.preventDefault();
        playPendingPronunciation("us");
        break;

      case "playUk":
        e.preventDefault();
        playPendingPronunciation("uk");
        break;

      case "defUp":
        if (!hasEntries("def")) return;
        e.preventDefault();
        navigateList("def", -1);
        break;

      case "defDown":
        if (!hasEntries("def")) return;
        e.preventDefault();
        navigateList("def", 1);
        break;

      case "imgLeft":
        if (!hasEntries("img")) return;
        e.preventDefault();
        navigateList("img", -1);
        break;

      case "imgRight":
        if (!hasEntries("img")) return;
        e.preventDefault();
        navigateList("img", 1);
        break;

      case "selectItem":
        if (!lastNavKind) return; // nothing highlighted yet — let Space type a space
        e.preventDefault();
        selectHighlightedItem();
        break;

      case "focusGeminiTab":
        e.preventDefault();
        window.postMessage({ type: "FOCUS_GEMINI_TAB" }, window.location.origin);
        break;

      case "focusAppTab":
        // This tab (the app) already has focus when this fires, so
        // there's nothing to do here — the same binding is synced to
        // the extension (see syncTabSwitchKeysToExtension above) so
        // content-gemini.js can act on it while you're on Gemini's tab.
        e.preventDefault();
        break;

      case "focusWordInput":
        e.preventDefault();
        wordInput.focus();
        break;

      case "focusPageInput":
        e.preventDefault();
        pageInput.focus();
        pageInput.select();
        break;

      case "wordCursorLeft":
        // Only acts while the Word Input Bar is actively focused —
        // otherwise this key falls through and types its literal
        // character normally wherever it was pressed.
        if (document.activeElement !== wordInput) return;
        e.preventDefault();
        moveWordCursor(-1);
        break;

      case "wordCursorRight":
        if (document.activeElement !== wordInput) return;
        e.preventDefault();
        moveWordCursor(1);
        break;

      default:
        break;
    }
  });

  // Clears each key's held state the instant it's released, so the
  // Increment/Decrement Page Number chord above only ever fires on a
  // genuine simultaneous hold, never on a stale "was down earlier".
  document.addEventListener("keyup", (e) => {
    heldKeys[e.code] = false;
  });

  // ---- Init ------------------------------------------------------------
  rebuildCodeToAction();
  renderSidebarRows();
  applyShortcutTitles();
  syncTabSwitchKeysToExtension();
})();
