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
const GLASS_TRANSPARENCY_STORAGE = "litVocabGlassTransparency";
const GLASS_BLUR_STORAGE = "litVocabGlassBlur";
const GLASS_TINT_STORAGE = "litVocabGlassTint";
const DEFAULT_SEARCH_WIDTH = 220;   // px
const DEFAULT_DEF_TEXT_SCALE = 100; // % (stored as whole percent, applied as a ratio)
const DEFAULT_IMG_THUMB_SIZE = 150; // px
const DEFAULT_BUBBLY_MODE = false;
const DEFAULT_GLASS_TRANSPARENCY = 30; // % — how see-through the glass is (0 = opaque, 100 = fully transparent)
const DEFAULT_GLASS_BLUR = 20;         // px — backdrop blur radius
const DEFAULT_GLASS_TINT = 50;         // % — strength of the color tint / glossy highlight
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
     id, word, bookTitle, pageNo, timestamp,
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

function applyBubblyMode() {
  document.body.classList.toggle("bubbly-mode", getBubblyMode());
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
}

bubblyModeToggle.addEventListener("change", () => {
  setBubblyMode(bubblyModeToggle.checked);
  applyBubblyMode();
  applyGlassPrefs();
});

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
        <img src="${img.url}" alt="Related visual" loading="lazy">
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
}

// Plays the word currently in the add-word form (before it's been saved as
// an entry), using whatever accent-specific recorded audio the lookup
// found, a Google Translate voice as a second try, and the browser's own
// speech synthesis as a last resort. See playAudioChain() for the order.
function playPendingPronunciation(accent) {
  const word = wordInput.value.trim();
  if (!word) return;
  const audioUrl = normalizeAudioUrl(pendingPhonetics?.[accent]?.audio);
  playAudioChain(word, accent, audioUrl);
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
--------------------------------------------------------------------- */
let lastAddAt = 0;
function guardedAddEntry() {
  const now = Date.now();
  if (now - lastAddAt < 300) return; // collapses double-fires into one add
  lastAddAt = now;
  addEntryFromForm();
}

[wordInput, bookInput, pageInput].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    // Let any datalist "commit" finish updating the field's value first.
    setTimeout(guardedAddEntry, 0);
  });
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  guardedAddEntry();
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
  setTimeout(guardedAddEntry, 0);
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
  const pageNo = parseInt(pageInput.value, 10);

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
  if (!pageNo || pageNo < 1) {
    alert("Please enter a valid page number before adding.");
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
    pageNo,
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
  saveLastBookPage(bookTitle, pageNo);

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
  editPage.value = entry.pageNo;

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
  const newPage = parseInt(editPage.value, 10);

  if (!newWord || !newBook || !newPage) {
    alert("Word, Book Title, and Page No. cannot be empty.");
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
  entry.pageNo = newPage;
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

function pickVoice(accent) {
  const isUK = accent === "uk";
  const targetLang = isUK ? "en-GB" : "en-US";

  // Exact locale match first.
  let voice = availableVoices.find((v) => v.lang === targetLang);
  if (voice) return voice;

  // Some browsers/OSes expose accent-appropriate voices under names
  // rather than a clean lang tag — match on those before giving up.
  const nameHints = isUK
    ? ["uk english", "british", "daniel", "kate", "hazel", "arthur", "english (united kingdom)"]
    : ["us english", "american", "samantha", "alex", "zira", "aria", "david", "english (united states)"];
  voice = availableVoices.find((v) => nameHints.some((hint) => v.name.toLowerCase().includes(hint)));
  if (voice) return voice;

  // Broader "any English voice" fallback — but explicitly excluding the
  // OTHER accent's exact locale. Without this exclusion, asking for
  // "uk" on a system with only an en-US voice installed would silently
  // hand back that en-US voice, making the "British" button sound
  // identical to "American" (which looked like British "not working").
  const otherLang = isUK ? "en-US" : "en-GB";
  voice = availableVoices.find((v) => v.lang?.startsWith("en") && v.lang !== otherLang);
  return voice || null;
}

function speakWithBrowserTTS(word, accent) {
  if (!("speechSynthesis" in window)) {
    alert("Sorry, your browser doesn't support speech synthesis.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  const voice = pickVoice(accent);
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
// documented API, so it can change or get rate-limited without notice) and
// speaks one generic voice rather than a true US/UK pair, which is why the
// accent-tagged recordings from the dictionary lookup are tried first.
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

// Shared playback order for any word: (1) the accent-specific recorded
// clip from the dictionary lookup, if we have one — most accurate for
// US-vs-UK; (2) Google Translate's real-time voice endpoint; (3) the
// browser's own offline speech synthesis, which always works but sounds
// the most robotic and is the least accent-accurate.
async function playAudioChain(word, accent, dictionaryAudioUrl) {
  if (dictionaryAudioUrl) {
    try {
      await tryPlayAudio(dictionaryAudioUrl);
      return;
    } catch (err) {
      console.warn(`${accent.toUpperCase()} dictionary clip failed (${err.message}) — trying Google's voice next.`, dictionaryAudioUrl);
    }
  }
  try {
    await tryPlayAudio(googleTranslateTtsUrl(word));
    return;
  } catch (err) {
    console.warn(`Google Translate voice failed (${err.message}) — falling back to on-device speech synthesis.`);
  }
  speakWithBrowserTTS(word, accent);
}

function playPronunciation(entry, accent) {
  const audioUrl = normalizeAudioUrl(entry.phonetics?.[accent]?.audio);
  playAudioChain(entry.word, accent, audioUrl);
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
function buildExportPayload() {
  const selectedBook = bookFilter.value;
  const relevant = selectedBook ? entries.filter((e) => e.bookTitle === selectedBook) : entries.slice();

  // Book (alphabetical) → Page (ascending) → seq (the order you first
  // entered the word) — this ordering drives both JSON and PDF export.
  const sorted = relevant.slice().sort((a, b) => {
    if (a.bookTitle !== b.bookTitle) return a.bookTitle.localeCompare(b.bookTitle);
    if (a.pageNo !== b.pageNo) return a.pageNo - b.pageNo;
    return (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp);
  });

  return {
    exportedAt: new Date().toISOString(),
    scope: selectedBook || "All Books",
    entries: sorted.map((e) => {
      const { definitions, images } = getFilteredData(e);
      return {
        word: e.word,
        bookTitle: e.bookTitle,
        pageNo: e.pageNo,
        seq: e.seq,
        definitions: definitions.map((d) => ({ text: d.text, source: d.source })),
        phonetics: e.phonetics,
        images: images.map((img) => img.url),
      };
    }),
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

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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

  // Group entries by book, then by page — entries within each page are
  // already sorted in "first entered" order by buildExportPayload().
  const byBook = new Map();
  payload.entries.forEach((e) => {
    if (!byBook.has(e.bookTitle)) byBook.set(e.bookTitle, []);
    byBook.get(e.bookTitle).push(e);
  });

  for (const [book, bookEntries] of byBook) {
    ensureSpace(28);
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
      if (!byPage.has(e.pageNo)) byPage.set(e.pageNo, []);
      byPage.get(e.pageNo).push(e);
    });

    for (const [page, pageEntries] of byPage) {
      // Page-group band, mirrors the on-screen grouped table.
      ensureSpace(24);
      doc.setFillColor(...PDF_COLOR.blueBand);
      doc.rect(margin, y - 12, maxWidth, 19, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...PDF_COLOR.blue);
      doc.text(`Page ${page}`, margin + 8, y + 1);
      doc.setTextColor(...PDF_COLOR.ink);
      y += 22;

      for (const entry of pageEntries) {
        ensureSpace(20);
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
      const incoming = Array.isArray(parsed?.entries) ? parsed.entries : [];
      if (incoming.length === 0) {
        alert("This file doesn't contain any recognizable entries.");
        return;
      }

      const existingKeys = new Set(entries.map((e) => `${e.word}|${e.bookTitle}|${e.pageNo}`));
      let added = 0;

      incoming.forEach((raw) => {
        const key = `${raw.word}|${raw.bookTitle}|${raw.pageNo}`;
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
          pageNo: raw.pageNo,
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

  return entries.filter((e) => {
    if (selectedBook && e.bookTitle !== selectedBook) return false;
    if (pageQuery && String(e.pageNo) !== pageQuery) return false;
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
        `<img class="row-thumb" data-img-id="${img.id}" data-bucket="${img.bucket}" src="${img.url}" alt="${escapeHtml(entry.word)}" title="${bucketTitle[img.bucket]}" loading="lazy">`
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
    hasUS ? `US ${escapeHtml(entry.phonetics.us.text || "")}` : "",
    hasUK ? `UK ${escapeHtml(entry.phonetics.uk.text || "")}` : "",
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
           <td data-label="Page">${entry.pageNo}</td>`
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
  const sorted = list.slice().sort((a, b) => b.timestamp - a.timestamp);

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
    if (!byPage.has(entry.pageNo)) byPage.set(entry.pageNo, []);
    byPage.get(entry.pageNo).push(entry);
  });

  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

  let rows = "";
  sortedPages.forEach((page) => {
    rows += `<tr class="page-group-row"><td colspan="4">Page ${page}</td></tr>`;
    const wordsOnPage = byPage.get(page).sort((a, b) => (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp));
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
    window.postMessage({ type: "SEARCH_GEMINI", word }, window.location.origin);
  });
}

// Receives a scraped Gemini entry relayed by the extension's app-side
// content script (the Scrape-Back flow). Wrapped in try/catch so a
// malformed or unexpected message can never break the rest of the app.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "GEMINI_ENTRY_SCRAPED") return;

  try {
    const payload = event.data.payload || {};
    const definition = typeof payload.definition === "string" ? payload.definition.trim() : "";
    const images = Array.isArray(payload.images) ? payload.images : [];

    // Clear any stale pending definitions/images/tags before injecting
    // the new data — same as a fresh "Fetch with AI" run would.
    resetFormPendingState();

    // source: "ai" so this flows through the app's existing AI
    // definition/image buckets (see bucketOf()) exactly like AI-fetched
    // results do — no separate handling needed anywhere else.
    if (definition) {
      addPendingDefinition(definition, "ai", true);
    }
    images.forEach((dataUrl) => {
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        addPendingImage(dataUrl, "ai", true);
      }
    });

    // Ready for the person to review/adjust and hit "Add Entry".
    wordInput.focus();
  } catch (err) {
    console.error("[VocabBridge] Ignored a malformed message from the Gemini bridge:", err);
  }
});

// Handshake: tells the extension (if installed) that resetFormPendingState/
// addPendingDefinition/addPendingImage/wordInput above are now defined, so
// it's safe to deliver any Gemini data — including anything scraped and
// queued before this page finished loading.
window.postMessage({ type: "APP_READY" }, window.location.origin);
