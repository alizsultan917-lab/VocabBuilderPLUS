/* =========================================================================
   backup-manager.js
   -------------------------------------------------------------------------
   Automatic Local Backup System for Literary Vocabulary Register.

   This file is self-contained by design. It does NOT read/write the
   vocabulary entries array directly and does NOT duplicate the app's
   existing persistence (localStorage mirror, disk folder, Google Drive —
   see script.js's STORAGE_KEY / HANDLE_DB_NAME / DRIVE_* constants). It
   only ever touches:
     - its OWN localStorage keys (AUTO_BACKUP_* below) for backup settings
       and status,
     - its OWN IndexedDB database (BACKUP_DB_NAME below) for the backup
       destination folder's FileSystemDirectoryHandle,
     - the vocabulary data, indirectly, through the small callback API the
       host app hands over via BackupManager.initialize({ getEntries,
       setEntries, saveEntries, refreshUI }) — see the INTEGRATION
       section near the bottom of this file.

   Same architectural shape already used by the other folder-backed
   features in this app (wallpaper-folder-service.js,
   youtube-playlist-folder-service.js): its own DB name/store, its own
   IndexedDB key, File System Access API with a supportsFileSystemAccess
   capability check, restore-on-load that always re-requests permission
   (browsers never trust a stored grant across sessions).

   PART 2 laid the configuration, internal state, integration surface, and
   initialize(). PART 3 added real backup folder handling (choose/restore/
   permission states). PART 4 added actual backup file creation
   (createBackup()). PART 5 added intelligent change detection and
   automatic scheduling: checkIfBackupDue()'s real elapsed-time decision,
   startScheduler()/stopScheduler() with duplicate-timer protection, and
   visibilitychange/focus lifecycle handling. PART 6 added the settings
   UI adapter (updateBackupUI() / computeUiState() / renderBackupStatus
   integration) and a restoreBackup() stub. PART 7 (this revision) adds
   retention/cleanup: cleanupOldBackups(), called only from createBackup()'s
   own success path, strictly after a new backup is written and marked
   successful. PART 8 (this revision) replaces the restoreBackup() stub
   with real restore logic — validateBackup(), a safety backup of the
   CURRENT data before anything is touched, and applying the restored
   entries through the same getEntries/setEntries/saveEntries/refreshUI
   integration API createBackup() already uses, plus the one addition
   restore actually needed: a setEntries callback (see the INTEGRATION
   section) so this file can hand restored entries back to the host
   without ever touching the host's storage itself. PART 9 (this
   revision) is a reliability/architecture hardening pass: no new
   behavior, just closing a small concurrency gap in checkIfBackupDue()
   and dropping the one integration point (getMetadata) that had been
   accepted since Part 2 but never actually used anywhere in this file
   — "minimal application integration points" means an unused one gets
   removed, not kept around for hypothetical future use.
   ========================================================================= */

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     CONFIGURATION — localStorage keys
     All are namespaced under the app's existing "litVocab" prefix so they
     sit alongside script.js's own keys (STORAGE_KEY, LAST_BOOK_PAGE_KEY,
     etc.) without colliding with any of them.
  ----------------------------------------------------------------------- */
  const AUTO_BACKUP_ENABLED_STORAGE = "litVocabAutoBackupEnabled";
  const AUTO_BACKUP_INTERVAL_STORAGE = "litVocabAutoBackupInterval";
  const AUTO_BACKUP_RETENTION_STORAGE = "litVocabAutoBackupRetention";
  const AUTO_BACKUP_LAST_SUCCESS_STORAGE = "litVocabAutoBackupLastSuccess";
  const AUTO_BACKUP_LAST_ENTRY_COUNT_STORAGE = "litVocabAutoBackupLastEntryCount";
  const AUTO_BACKUP_DATA_CHANGED_STORAGE = "litVocabAutoBackupDataChanged";
  // Folder display label only (mirrors WFS_META_STORAGE /
  // YPF_META_STORAGE's "label only, never a handle or entry data" rule).
  const AUTO_BACKUP_FOLDER_LABEL_STORAGE = "litVocabAutoBackupFolderLabel";

  /* -----------------------------------------------------------------------
     CONFIGURATION — dedicated IndexedDB for the backup folder handle
     Deliberately separate from script.js's HANDLE_DB_NAME
     ("litVocabFSHandles"), wallpaper-folder-service.js's WFS_DB_NAME
     ("litVocabWallpaperFS"), and youtube-playlist-folder-service.js's
     YPF_DB_NAME ("litVocabYoutubePlaylistFS") — the backup destination
     folder must never be confused with, or silently overwrite, any of
     those.
  ----------------------------------------------------------------------- */
  const BACKUP_DB_NAME = "litVocabBackupFS";
  const BACKUP_DB_VERSION = 1;
  const BACKUP_DB_STORE = "handles";
  const HANDLE_DB_KEY_BACKUP = "vocabBackupFolder";

  const supportsFileSystemAccess = "showDirectoryPicker" in window;

  /* -----------------------------------------------------------------------
     PERMISSION STATES — single source of truth for what the backup
     folder's connection currently looks like, so the future UI (and the
     future scheduler, which must never fire a backup into a folder it
     doesn't actually have permission for) can branch on one value instead
     of re-deriving it from handle/permission checks themselves.

       connected            — handle present, "readwrite" permission
                               confirmed granted.
       permission-required  — handle present (restored from IndexedDB)
                               but the browser hasn't confirmed
                               "readwrite" permission for this session yet
                               (browsers never trust a stored grant across
                               sessions/reloads). Needs an explicit,
                               user-triggered reconnect.
       unavailable          — handle present but unusable (e.g. the folder
                               was moved, renamed, or deleted since it was
                               chosen; the permission check itself threw).
       unsupported          — this browser has no File System Access API
                               at all (Firefox/Safari) — there is no
                               fallback backend for backups, matching
                               youtube-playlist-folder-service.js's
                               "write access is required, so read-only
                               fallback isn't good enough" reasoning.
       disconnected         — no backup folder has ever been chosen (or it
                               was explicitly forgotten).
  ----------------------------------------------------------------------- */
  const BACKUP_PERMISSION_STATES = Object.freeze({
    CONNECTED: "connected",
    PERMISSION_REQUIRED: "permission-required",
    UNAVAILABLE: "unavailable",
    UNSUPPORTED: "unsupported",
    DISCONNECTED: "disconnected",
  });


  /* -----------------------------------------------------------------------
     BACKUP INTERVAL CONFIGURATION — centralized, single source of truth.
     Values are in milliseconds; "disabled" has no interval and simply
     means the scheduler (future part) never arms a timer.
  ----------------------------------------------------------------------- */
  const BACKUP_INTERVALS = {
    "5min":   { label: "Every 5 minutes",  ms: 5 * 60 * 1000 },
    "15min":  { label: "Every 15 minutes", ms: 15 * 60 * 1000 },
    "30min":  { label: "Every 30 minutes", ms: 30 * 60 * 1000 },
    "1hour":  { label: "Every 1 hour",     ms: 60 * 60 * 1000 },
    "3hour":  { label: "Every 3 hours",    ms: 3 * 60 * 60 * 1000 },
    "6hour":  { label: "Every 6 hours",    ms: 6 * 60 * 60 * 1000 },
    "12hour": { label: "Every 12 hours",   ms: 12 * 60 * 60 * 1000 },
    "1day":   { label: "Every 1 day",      ms: 24 * 60 * 60 * 1000 },
    "3day":   { label: "Every 3 days",     ms: 3 * 24 * 60 * 60 * 1000 },
    "1week":  { label: "Every 1 week",     ms: 7 * 24 * 60 * 60 * 1000 },
    "disabled": { label: "Disabled", ms: null },
  };
  const DEFAULT_BACKUP_INTERVAL = "1hour";

  /* -----------------------------------------------------------------------
     RETENTION CONFIGURATION — centralized, single source of truth.
     "unlimited" (null) means retention cleanup (future part) never
     deletes anything on count grounds.
  ----------------------------------------------------------------------- */
  const RETENTION_OPTIONS = {
    "5":  { label: "5 backups",  count: 5 },
    "10": { label: "10 backups", count: 10 },
    "20": { label: "20 backups", count: 20 },
    "50": { label: "50 backups", count: 50 },
    "unlimited": { label: "Unlimited", count: null },
  };
  const DEFAULT_RETENTION = "20";

  /* -----------------------------------------------------------------------
     BACKUP FILE FORMAT — centralized so retention cleanup (a later part,
     which must recognize which files in the folder are actually backups
     it's allowed to delete) and createBackup() agree on exactly one
     naming/shape convention.
  ----------------------------------------------------------------------- */
  const BACKUP_FORMAT_VERSION = 1;
  const APP_NAME = "Literary Vocabulary Register";
  const BACKUP_FILENAME_PREFIX = "vocabulary-backup-";
  const BACKUP_FILENAME_EXT = ".json";
  // Matches BACKUP_FILENAME_PREFIX + YYYY-MM-DD_HH-MM-SS + BACKUP_FILENAME_EXT.
  const BACKUP_FILENAME_PATTERN = /^vocabulary-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.json$/;
  const VALID_BACKUP_REASONS = ["automatic", "manual", "safety-before-restore"];

  /* -----------------------------------------------------------------------
     SCHEDULER CONFIGURATION
     Per the spec's explicit rule: the timer itself only ever periodically
     CHECKS whether a backup is due — it is never the thing that decides
     "an hour has passed". That decision is always a real elapsed-time
     comparison (Date.now() - lastSuccessfulBackup >= interval.ms) inside
     checkIfBackupDue(). SCHEDULER_TICK_MS is deliberately much shorter
     than the shortest selectable interval (5 minutes) so even that
     interval fires reasonably close to on time, while staying cheap
     (checkIfBackupDue() short-circuits almost immediately in the common
     case where nothing has changed).
  ----------------------------------------------------------------------- */
  const SCHEDULER_TICK_MS = 60 * 1000; // 1 minute

  /* -----------------------------------------------------------------------
     Small localStorage helpers — same "never throw, fall back quietly"
     convention used throughout script.js (see SettingsManager,
     loadLastBookPage/saveLastBookPage).
  ----------------------------------------------------------------------- */
  function readString(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (err) {
      return fallback;
    }
  }
  function writeString(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false; // non-fatal — e.g. storage full or blocked
    }
  }
  function readInt(key, fallback) {
    const raw = readString(key, null);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  function readBool(key, fallback) {
    const raw = readString(key, null);
    if (raw === null) return fallback;
    return raw === "true";
  }

  /* -----------------------------------------------------------------------
     Tiny IndexedDB helper for the backup folder handle — same shape as
     openHandleDB() in script.js / wallpaper-folder-service.js /
     youtube-playlist-folder-service.js, pointed at BACKUP_DB_NAME so it
     never shares a database with any of those.
  ----------------------------------------------------------------------- */
  function openBackupHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(BACKUP_DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function backupIdbGet(key) {
    const db = await openBackupHandleDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(BACKUP_DB_STORE, "readonly").objectStore(BACKUP_DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function backupIdbSet(key, value) {
    const db = await openBackupHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BACKUP_DB_STORE, "readwrite");
      tx.objectStore(BACKUP_DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function backupIdbDelete(key) {
    const db = await openBackupHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BACKUP_DB_STORE, "readwrite");
      tx.objectStore(BACKUP_DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* -----------------------------------------------------------------------
     BackupManager
     -------------------------------------------------------------------------
     Internal state lives entirely in this closure — nothing is attached
     to `window` except the deliberately small public surface at the
     bottom of the file (mirrors window.WallpaperFolder / window.WallpaperTone
     / window.YouTubePlaylistFolder elsewhere in this app).
  ----------------------------------------------------------------------- */
  const state = {
    // Folder / permission (populated in this part)
    backupFolderHandle: null, // FileSystemDirectoryHandle | null
    permissionState: BACKUP_PERMISSION_STATES.DISCONNECTED,

    // Activity flags
    backupInProgress: false,
    initialized: false,

    // Settings (loaded from localStorage in initialize())
    selectedInterval: DEFAULT_BACKUP_INTERVAL,
    retentionLimit: DEFAULT_RETENTION,
    autoBackupEnabled: false,

    // Scheduler (armed in a later part — never started here)
    schedulerTimer: null,

    // Status
    lastSuccessfulBackup: null,   // ms timestamp | null
    lastBackupEntryCount: null,   // number | null
    dataChangedSinceBackup: false,
    // In-memory only (never persisted — a stale failure shouldn't survive
    // a reload and block the UI forever): the failure code from the most
    // recent createBackup() call, cleared the moment any backup succeeds.
    // Purely a display concern for updateBackupUI()'s "failed" state.
    lastBackupError: null,

    // Application integration — supplied via BackupManager.initialize()
    api: {
      getEntries: null,        // () => entries[]
      setEntries: null,        // (entries[]) => void — host's own setter, PART 8:
                                // the one piece restoreBackup() needs that no
                                // earlier part required. Replaces the host's
                                // in-memory entries wholesale (no merge, no id
                                // regeneration) and updates whatever derived
                                // state (e.g. an id/seq counter) the host keeps
                                // alongside it — mirrors what the host's own
                                // "load entries" path already does, per the
                                // integration comment on restoreBackup() below.
      saveEntries: null,       // () => void  (host app's own persistence)
      refreshUI: null,         // () => void
      renderBackupStatus: null,// (status) => void — thin UI paint hook, called
                                // by updateBackupUI() any time backup status
                                // changes; BackupManager computes what the
                                // status IS, the host only paints it.
      notify: null,            // (kind, message) => void — reuses the host's
                                // own notification/toast surface for one-off
                                // "backup succeeded/failed" pings; never
                                // required, always optional-chained.
    },
  };

  // Folder display label only — mirrors WFS_META_STORAGE / YPF_META_STORAGE
  // ("label only, never a handle or entry data") one level up in this file.
  function getBackupFolderLabel() {
    return readString(AUTO_BACKUP_FOLDER_LABEL_STORAGE, null);
  }
  function setBackupFolderLabel(label) {
    if (label == null) {
      try { localStorage.removeItem(AUTO_BACKUP_FOLDER_LABEL_STORAGE); } catch (err) { /* non-fatal */ }
      return;
    }
    writeString(AUTO_BACKUP_FOLDER_LABEL_STORAGE, label);
  }

  /* -----------------------------------------------------------------------
     Settings persistence — load/save the small set of user-facing
     preferences. Kept intentionally simple; validity of each stored value
     against BACKUP_INTERVALS / RETENTION_OPTIONS is enforced on load so a
     hand-edited or stale localStorage value can never point at a config
     key that no longer exists.
  ----------------------------------------------------------------------- */
  function loadSettings() {
    const enabled = readBool(AUTO_BACKUP_ENABLED_STORAGE, false);

    let interval = readString(AUTO_BACKUP_INTERVAL_STORAGE, DEFAULT_BACKUP_INTERVAL);
    if (!BACKUP_INTERVALS[interval]) interval = DEFAULT_BACKUP_INTERVAL;

    let retention = readString(AUTO_BACKUP_RETENTION_STORAGE, DEFAULT_RETENTION);
    if (!RETENTION_OPTIONS[retention]) retention = DEFAULT_RETENTION;

    const lastSuccess = readInt(AUTO_BACKUP_LAST_SUCCESS_STORAGE, null);
    const lastEntryCount = readInt(AUTO_BACKUP_LAST_ENTRY_COUNT_STORAGE, null);
    const dataChanged = readBool(AUTO_BACKUP_DATA_CHANGED_STORAGE, false);

    state.autoBackupEnabled = enabled;
    state.selectedInterval = interval;
    state.retentionLimit = retention;
    state.lastSuccessfulBackup = lastSuccess;
    state.lastBackupEntryCount = lastEntryCount;
    state.dataChangedSinceBackup = dataChanged;
  }

  // Individual setters persist immediately, same "write straight through"
  // convention as SettingsManager.saveSettings() in script.js — no batched
  // "Save" button for these preferences.
  function setAutoBackupEnabled(enabled) {
    state.autoBackupEnabled = !!enabled;
    writeString(AUTO_BACKUP_ENABLED_STORAGE, String(state.autoBackupEnabled));
    // Scheduler lifecycle follows this setting directly: turning
    // automatic backups off must stop the timer immediately (never leave
    // a stray one ticking), and turning them on must (re)start it exactly
    // once (startScheduler() itself guarantees no duplicate timer — see
    // its own doc comment).
    if (state.autoBackupEnabled) startScheduler();
    else stopScheduler();
    updateBackupUI();
  }
  function setSelectedInterval(key) {
    if (!BACKUP_INTERVALS[key]) return false;
    // "Changing frequency: 1. Stop old scheduler. 2. Save new setting.
    // 3. Start new scheduler." — only meaningful (and only done) while a
    // scheduler is actually running; if automatic backups are currently
    // disabled, this is just a settings write with nothing to restart.
    const wasRunning = !!state.schedulerTimer;
    if (wasRunning) stopScheduler(); // 1. Stop old scheduler.
    state.selectedInterval = key;
    writeString(AUTO_BACKUP_INTERVAL_STORAGE, key); // 2. Save new setting.
    if (wasRunning) startScheduler(); // 3. Start new scheduler.
    updateBackupUI();
    return true;
  }
  function setRetentionLimit(key) {
    if (!RETENTION_OPTIONS[key]) return false;
    state.retentionLimit = key;
    writeString(AUTO_BACKUP_RETENTION_STORAGE, key);
    updateBackupUI();
    return true;
  }
  function setLastSuccessfulBackup(timestampMs, entryCount) {
    state.lastSuccessfulBackup = timestampMs;
    state.lastBackupEntryCount = entryCount;
    writeString(AUTO_BACKUP_LAST_SUCCESS_STORAGE, String(timestampMs));
    writeString(AUTO_BACKUP_LAST_ENTRY_COUNT_STORAGE, String(entryCount));
  }
  function setDataChangedSinceBackup(changed) {
    state.dataChangedSinceBackup = !!changed;
    writeString(AUTO_BACKUP_DATA_CHANGED_STORAGE, String(state.dataChangedSinceBackup));
  }

  /* -----------------------------------------------------------------------
     markDataChanged()
     The one hook the host app calls from its own central mutation point
     (saveEntries() in script.js, per the Part 1 integration plan). Cheap
     and side-effect-light on purpose — actual backup-triggering logic
     (e.g. "back up soon because data changed") belongs to the scheduler
     built in a later part, not here.
  ----------------------------------------------------------------------- */
  function markDataChanged() {
    setDataChangedSinceBackup(true);
  }

  /* -----------------------------------------------------------------------
     initialize(hostApi)
     Part 2 scope only:
       1. Load backup settings.
       2. Restore internal state (from settings + localStorage status).
       3. Check browser support.
       4. Prepare for backup folder restoration (deferred to a later part
          — restoreFolder() is a documented no-op stub for now).
       5. Accept/connect to application data API.
     Deliberately does NOT pick/restore a folder, create a backup, or
     start the scheduler timer yet.
  ----------------------------------------------------------------------- */
  async function initialize(hostApi) {
    if (state.initialized) {
      console.warn("BackupManager.initialize() called more than once — ignoring the extra call.");
      return getStatus();
    }

    // 5. Accept/connect to application data API. Validated defensively —
    // a missing callback should degrade gracefully in later parts rather
    // than throw here.
    hostApi = hostApi || {};
    state.api.getEntries = typeof hostApi.getEntries === "function" ? hostApi.getEntries : null;
    state.api.setEntries = typeof hostApi.setEntries === "function" ? hostApi.setEntries : null;
    state.api.saveEntries = typeof hostApi.saveEntries === "function" ? hostApi.saveEntries : null;
    state.api.refreshUI = typeof hostApi.refreshUI === "function" ? hostApi.refreshUI : null;
    state.api.renderBackupStatus =
      typeof hostApi.renderBackupStatus === "function" ? hostApi.renderBackupStatus : null;
    state.api.notify = typeof hostApi.notify === "function" ? hostApi.notify : null;

    if (!state.api.getEntries) {
      console.warn(
        "BackupManager.initialize() was not given a getEntries callback — " +
          "backup creation will have nothing to read from until this is provided."
      );
    }
    if (!state.api.setEntries) {
      console.warn(
        "BackupManager.initialize() was not given a setEntries callback — " +
          "restoreBackup() will be unable to load restored entries until this is provided."
      );
    }

    // 1 & 2. Load settings / restore internal state.
    loadSettings();

    // 3. Check browser support. Recorded on state rather than just
    // returned, so later parts (UI, scheduler) can branch on it without
    // re-deriving it.
    state.supportsFileSystemAccess = supportsFileSystemAccess;

    // 4. Prepare for / perform backup folder restoration — SILENT only
    // (see restoreBackupFolderHandle's docs). Never prompts the user.
    await restoreBackupFolderHandle();

    // Lifecycle listeners are attached once per page load, independent of
    // whether automatic backup ends up enabled — they're cheap no-ops via
    // checkIfBackupDue()'s own "auto-backup-disabled" early return when
    // it isn't.
    attachLifecycleListeners();

    // Resume the scheduler across reloads if the person previously left
    // automatic backup turned on. setAutoBackupEnabled() is deliberately
    // NOT reused here — that setter also re-persists the (unchanged)
    // setting on every call, which is unnecessary on a plain reload — so
    // startScheduler() is called directly instead, still going through
    // its own duplicate-timer protection.
    if (state.autoBackupEnabled) startScheduler();

    state.initialized = true;
    updateBackupUI(); // paint whatever the settings UI is showing right now
    return getStatus();
  }

  /* -----------------------------------------------------------------------
     Permission checking — SILENT vs EXPLICIT are kept as two distinct code
     paths on purpose:
       - queryPermission() only ever *reads* the current grant; it never
         shows a browser dialog, so it's safe to call from automatic paths
         (initialize(), the future scheduler) at any time.
       - requestPermission() CAN show a browser permission dialog, so it
         must only ever be reached from a function that is itself only
         ever called as the direct result of a user click/action
         (chooseBackupFolder(), reconnectBackupFolder()) — never from
         initialize(), never from a timer.
  ----------------------------------------------------------------------- */
  async function queryBackupPermission(handle) {
    try {
      return await handle.queryPermission({ mode: "readwrite" });
    } catch (err) {
      return null; // handle can throw if the folder was moved/deleted since
    }
  }
  async function requestBackupPermission(handle) {
    try {
      return await handle.requestPermission({ mode: "readwrite" });
    } catch (err) {
      return null; // e.g. folder moved/deleted, or the browser refused the request context
    }
  }

  // Recomputes and caches state.permissionState from whatever is
  // currently known (supportsFileSystemAccess + backupFolderHandle +
  // a SILENT queryPermission check only — never requestPermission).
  // Safe to call at any time, including from automatic paths.
  async function refreshPermissionStateSilently() {
    if (!supportsFileSystemAccess) {
      state.permissionState = BACKUP_PERMISSION_STATES.UNSUPPORTED;
      return state.permissionState;
    }
    if (!state.backupFolderHandle) {
      state.permissionState = BACKUP_PERMISSION_STATES.DISCONNECTED;
      return state.permissionState;
    }
    const perm = await queryBackupPermission(state.backupFolderHandle);
    if (perm === "granted") {
      state.permissionState = BACKUP_PERMISSION_STATES.CONNECTED;
    } else if (perm === "prompt" || perm === "denied") {
      state.permissionState = BACKUP_PERMISSION_STATES.PERMISSION_REQUIRED;
    } else {
      // queryPermission threw (folder moved/deleted/otherwise unusable)
      state.permissionState = BACKUP_PERMISSION_STATES.UNAVAILABLE;
    }
    return state.permissionState;
  }

  /* -----------------------------------------------------------------------
     chooseBackupFolder()
     USER-TRIGGERED ONLY. Opens the native folder picker, confirms
     read/write permission (a real prompt is expected and fine here — this
     call only ever happens as the direct result of a click), then:
       1. Stores the directory handle internally.
       2. Persists it to the dedicated backup IndexedDB
          (BACKUP_DB_NAME / HANDLE_DB_KEY_BACKUP — never touches
          script.js's HANDLE_DB_NAME, wallpaper-folder-service.js's
          WFS_DB_NAME, or youtube-playlist-folder-service.js's
          YPF_DB_NAME).
       3. Verifies read/write permission (requestPermission above).
       4. Updates BackupManager status (permissionState + folder label).
     Also serves as "change backup folder": calling this again with a
     folder already connected simply replaces the in-memory/IndexedDB
     handle — it never deletes anything in the previously-chosen folder,
     never touches the app's primary storage folder, and any backups
     already written to the old folder are left exactly as they are.
     Returns { label } on success, or null if the person cancelled the
     picker (AbortError) or permission wasn't granted.
  ----------------------------------------------------------------------- */
  async function chooseBackupFolder() {
    if (!supportsFileSystemAccess) {
      state.permissionState = BACKUP_PERMISSION_STATES.UNSUPPORTED;
      return null;
    }
    let handle;
    try {
      // A distinct picker `id` (separate from script.js's own
      // showDirectoryPicker({ id: "wallpapers", ... }) or the primary
      // vocab-folder picker) so the browser remembers a separate
      // "last folder opened here" starting point for backups specifically.
      handle = await window.showDirectoryPicker({ id: "vocabBackupFolder", mode: "readwrite" });
    } catch (err) {
      return null; // AbortError (user cancelled) — not an error, nothing changes
    }

    const granted = await requestBackupPermission(handle);
    if (granted !== "granted") {
      // Permission declined — do NOT store a handle we don't actually
      // have usable access to.
      state.permissionState = BACKUP_PERMISSION_STATES.PERMISSION_REQUIRED;
      updateBackupUI();
      return null;
    }

    // 1. Store internally.
    state.backupFolderHandle = handle;
    // 2. Persist via the dedicated backup IndexedDB.
    try {
      await backupIdbSet(HANDLE_DB_KEY_BACKUP, handle);
    } catch (err) {
      console.warn("BackupManager: couldn't persist the backup folder handle to IndexedDB:", err);
      // Non-fatal — the handle still works for the rest of this session,
      // it just won't silently restore on the next page load.
    }
    setBackupFolderLabel(handle.name);

    // 3 & 4. Permission already verified above; update status.
    state.permissionState = BACKUP_PERMISSION_STATES.CONNECTED;
    updateBackupUI();
    return { label: handle.name };
  }

  // Explicit alias — same underlying operation as chooseBackupFolder(),
  // named for the "change backup folder" UI action so that call site
  // reads clearly even though there is nothing behaviorally special
  // about switching folders versus picking one for the first time.
  async function changeBackupFolder() {
    return chooseBackupFolder();
  }

  /* -----------------------------------------------------------------------
     reconnectBackupFolder()
     USER-TRIGGERED ONLY. For the "permission-required" state: the handle
     was already restored from IndexedDB (see restoreBackupFolderHandle
     below) but the browser hasn't re-confirmed permission for this
     session. Re-requesting permission on an *already-known* handle avoids
     making the person re-browse to the same folder just to re-grant
     access. Must only ever be wired to a click — never called
     automatically.
  ----------------------------------------------------------------------- */
  async function reconnectBackupFolder() {
    if (!state.backupFolderHandle) return false;
    const granted = await requestBackupPermission(state.backupFolderHandle);
    if (granted === "granted") {
      state.permissionState = BACKUP_PERMISSION_STATES.CONNECTED;
      updateBackupUI();
      return true;
    }
    state.permissionState = BACKUP_PERMISSION_STATES.PERMISSION_REQUIRED;
    updateBackupUI();
    return false;
  }

  /* -----------------------------------------------------------------------
     restoreBackupFolderHandle()
     Called from initialize() (i.e. automatically, on every page load).
     SILENT ONLY:
       1. Retrieve the saved handle from IndexedDB.
       2. Restore it internally if present.
       3. Check permission with queryPermission() ONLY — never
          requestPermission() — so this can never pop an unexpected
          browser dialog during ordinary app startup.
       4. Never triggers a permission prompt itself; if permission isn't
          already granted, the resulting state is "permission-required"
          and a later, user-triggered reconnectBackupFolder() call is
          what actually asks.
     Never throws — worst case there's nothing to restore, or the folder
     is gone, and permissionState ends up "disconnected"/"unavailable".
  ----------------------------------------------------------------------- */
  async function restoreBackupFolderHandle() {
    if (!supportsFileSystemAccess) {
      state.permissionState = BACKUP_PERMISSION_STATES.UNSUPPORTED;
      return null;
    }
    let handle = null;
    try {
      handle = await backupIdbGet(HANDLE_DB_KEY_BACKUP);
    } catch (err) {
      console.warn("BackupManager: couldn't read the backup folder handle from IndexedDB:", err);
    }
    if (!handle) {
      state.permissionState = BACKUP_PERMISSION_STATES.DISCONNECTED;
      return null;
    }

    state.backupFolderHandle = handle;
    await refreshPermissionStateSilently(); // query-only — never prompts
    return getStatus();
  }

  /* -----------------------------------------------------------------------
     forgetBackupFolder()
     USER-TRIGGERED. Clears this feature's own handle/label/IndexedDB
     entry only. Deliberately does NOT touch anything written into the
     folder on disk — existing backup files are left exactly where they
     are; only this app's *reference* to the folder is removed. Also
     never touches script.js's primary-storage handle, wallpaper folder,
     YouTube playlist folder, or Google Drive connection — all live in
     entirely separate IndexedDB databases/localStorage keys.
  ----------------------------------------------------------------------- */
  async function forgetBackupFolder() {
    state.backupFolderHandle = null;
    state.permissionState = supportsFileSystemAccess
      ? BACKUP_PERMISSION_STATES.DISCONNECTED
      : BACKUP_PERMISSION_STATES.UNSUPPORTED;
    setBackupFolderLabel(null);
    try {
      await backupIdbDelete(HANDLE_DB_KEY_BACKUP);
    } catch (err) {
      // non-fatal — worst case a stale handle sits in IndexedDB and the
      // next restoreBackupFolderHandle() attempt just fails its
      // permission check, same convention as
      // youtube-playlist-folder-service.js's disconnect().
    }
    updateBackupUI();
  }

  /* =========================================================================
     BACKUP CREATION
     -------------------------------------------------------------------------
     createBackup(reason) is the only entry point. Everything below it is a
     private helper the scheduler (a later part) and any manual/"back up
     now" UI action both call through — neither ever writes a file itself.
     ========================================================================= */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Local time on purpose (matches the example in the spec,
  // "2026-09-02_14-30-00") — a person browsing their own backup folder
  // wants filenames that match their own wall clock, not UTC.
  function formatBackupFilenameTimestamp(date) {
    return (
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
      `_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`
    );
  }

  // "Never overwrite an existing backup": builds the base
  // vocabulary-backup-<timestamp>.json name, then — only in the edge case
  // where that exact filename is already taken (e.g. two backups
  // requested within the same second) — appends _2, _3, ... until an
  // unused name is found. getFileHandle({ create: false }) throws
  // NotFoundError when the name is free, which is exactly the signal
  // this loop wants.
  async function reserveUniqueBackupFileHandle(dirHandle, date) {
    const base = `${BACKUP_FILENAME_PREFIX}${formatBackupFilenameTimestamp(date)}`;
    let candidate = `${base}${BACKUP_FILENAME_EXT}`;
    let suffix = 2;
    // Capped so a persistent, unrelated conflict can never spin forever.
    while (suffix <= 1000) {
      try {
        await dirHandle.getFileHandle(candidate, { create: false });
        // No throw — a file by this name already exists. Try the next suffix.
        candidate = `${base}_${suffix}${BACKUP_FILENAME_EXT}`;
        suffix += 1;
      } catch (err) {
        // NotFoundError (or equivalent) — this name is free. Now actually
        // create it. If creation itself fails, let that error propagate to
        // the caller's try/catch — that's a real write failure, not a
        // naming collision.
        return dirHandle.getFileHandle(candidate, { create: true });
      }
    }
    throw new Error("Could not find an available backup filename after 1000 attempts.");
  }

  // Structural check only — this never strips or reshapes entries, it
  // just confirms getEntries() returned something serializable and
  // sane enough to write. "Preserve COMPLETE entry objects" (per spec)
  // means this must NOT filter/normalize fields; it only pass/fails the
  // whole snapshot.
  function validateEntriesSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) {
      return { valid: false, reason: "getEntries() did not return an array" };
    }
    for (const entry of snapshot) {
      if (!entry || typeof entry !== "object") {
        return { valid: false, reason: "snapshot contains a non-object entry" };
      }
    }
    return { valid: true, reason: null };
  }

  function buildBackupPayload(snapshot, reason) {
    return {
      backupVersion: BACKUP_FORMAT_VERSION,
      backupCreatedAt: new Date().toISOString(),
      appName: APP_NAME,
      entryCount: snapshot.length,
      entries: snapshot, // complete objects, untouched — no field stripping
      metadata: {
        backupReason: reason,
      },
    };
  }

  /* -----------------------------------------------------------------------
     createBackup(reason)
     reason: "automatic" | "manual" | "safety-before-restore"

     Returns a result object rather than throwing, so both an automatic
     scheduler tick (later part) and a manual "Back Up Now" button (later
     part) can inspect what happened without needing a try/catch of their
     own:
       { status: "success",  filename, entryCount, timestamp }
       { status: "skipped",  code: "empty-data" | "already-in-progress" }
       { status: "failed",   code: "...", error }
  ----------------------------------------------------------------------- */
  async function createBackup(reason) {
    // Local bookkeeping wrapper — every return path in this function goes
    // through here so lastBackupError / the notify callback / the UI
    // adapter all stay in exactly one place instead of being repeated at
    // every return statement below. Purely internal to createBackup();
    // does not change any of the result shapes documented above.
    function finish(result) {
      // Release the lock here (not just in the `finally` below) so that
      // the updateBackupUI() call a few lines down already sees
      // backupInProgress === false and can report "successful"/"failed"
      // instead of still showing "backup in progress" for one extra tick.
      // The `finally` block's own assignment is a harmless no-op safety
      // net for the (never expected) case of an exception escaping
      // without going through finish() at all.
      state.backupInProgress = false;
      if (result.status === "success") {
        state.lastBackupError = null;
      } else if (result.status === "failed") {
        state.lastBackupError = result.code || "unknown";
      }
      // "skipped" (already-in-progress / empty-data) is not a failure —
      // leave whatever lastBackupError already held untouched.
      if (typeof state.api.notify === "function" && result.status !== "skipped") {
        const verb = reason === "automatic" ? "Automatic backup" : "Backup";
        try {
          if (result.status === "success") {
            state.api.notify("success", `${verb} completed — ${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"} saved.`);
          } else {
            state.api.notify("error", `${verb} failed (${result.code}).`);
          }
        } catch (err) {
          console.error("BackupManager: notify callback threw:", err);
        }
      }
      updateBackupUI();
      return result;
    }

    if (!VALID_BACKUP_REASONS.includes(reason)) {
      return finish({ status: "failed", code: "invalid-reason", error: `Unknown backup reason: ${reason}` });
    }

    // 4. Acquire backup lock FIRST, before any other check, so two
    // near-simultaneous calls (e.g. a scheduler tick and a manual click)
    // can never both proceed past this point. Checked (not just set)
    // atomically within this synchronous block — JS has no other thread
    // that could interleave here.
    if (state.backupInProgress) {
      return { status: "skipped", code: "already-in-progress" };
    }
    state.backupInProgress = true;
    updateBackupUI(); // paint "backup in progress" right away

    try {
      // 1. Check support.
      if (!supportsFileSystemAccess) {
        return finish({ status: "failed", code: "unsupported" });
      }

      // 2. Check folder.
      if (!state.backupFolderHandle) {
        return finish({ status: "failed", code: "no-folder" });
      }

      // 3. Check permission — SILENT only (query, never request). If the
      // folder was disconnected/moved/permission-revoked since it was
      // last confirmed, this call must fail cleanly rather than pop a
      // permission dialog out of an automatic backup tick.
      await refreshPermissionStateSilently();
      if (state.permissionState !== BACKUP_PERMISSION_STATES.CONNECTED) {
        return finish({ status: "failed", code: state.permissionState }); // "permission-required" | "unavailable"
      }

      // Data access via the clean integration API only — never a second
      // storage system.
      if (typeof state.api.getEntries !== "function") {
        return finish({ status: "failed", code: "no-data-api" });
      }

      // 5. Snapshot entries. Deep-cloned via JSON round-trip: entries are
      // plain, JSON-serializable data (see the STATE shape documented in
      // script.js), so this is a cheap, safe way to guarantee the
      // in-progress serialize/write below can never be mutated out from
      // under it by a concurrent edit elsewhere in the app.
      let snapshot;
      try {
        snapshot = JSON.parse(JSON.stringify(state.api.getEntries()));
      } catch (err) {
        return finish({ status: "failed", code: "snapshot-failed", error: err });
      }

      // 6. Validate.
      const validation = validateEntriesSnapshot(snapshot);
      if (!validation.valid) {
        return finish({ status: "failed", code: "invalid-data", error: validation.reason });
      }

      // EMPTY DATA — automatic backups skip safely and must NOT update
      // the last-successful-backup timestamp. Manual and
      // safety-before-restore backups still proceed even with zero
      // entries (a manual click is an explicit request; a
      // safety-before-restore snapshot legitimately may be of an
      // already-empty register right before a restore repopulates it).
      if (reason === "automatic" && snapshot.length === 0) {
        return finish({ status: "skipped", code: "empty-data" });
      }

      // 7. Serialize.
      const now = new Date();
      const payload = buildBackupPayload(snapshot, reason);
      let serialized;
      try {
        serialized = JSON.stringify(payload, null, 2);
      } catch (err) {
        return finish({ status: "failed", code: "serialize-failed", error: err });
      }

      // 8/9/10. Create timestamped file, write, close.
      let fileHandle;
      let writable;
      try {
        fileHandle = await reserveUniqueBackupFileHandle(state.backupFolderHandle, now);
        writable = await fileHandle.createWritable();
        await writable.write(serialized);
        await writable.close();
      } catch (err) {
        // Failure: do not modify vocabulary data (nothing here ever does),
        // do not mark success, keep dataChangedSinceBackup as-is, allow
        // retry on the next tick/click.
        try { await writable?.abort?.(); } catch (abortErr) { /* best effort */ }
        return finish({ status: "failed", code: "write-failed", error: err });
      }

      // 11. Mark success ONLY after the write has fully completed.
      setLastSuccessfulBackup(now.getTime(), snapshot.length);
      // Resetting the "changed since last backup" flag is appropriate
      // here precisely because this backup did capture a real, current
      // snapshot of the entries — true for all three reasons once a
      // write actually succeeds (the "only if appropriate" case that
      // does NOT reset it is the empty-data skip above, which returns
      // before reaching this line).
      setDataChangedSinceBackup(false);

      // 4. Run cleanup — strictly AFTER the new backup is written and
      // marked successful, never before (see cleanupOldBackups()'s own
      // doc comment for why the order matters: a cleanup failure must
      // never be allowed to turn this createBackup() call into a
      // "failed" result, and a *new* backup must never be at risk of
      // being deleted by a cleanup pass that ran before it existed).
      try {
        await cleanupOldBackups();
      } catch (err) {
        console.warn("BackupManager: cleanupOldBackups() threw after a successful backup — ignoring, backup itself still succeeded:", err);
      }

      return finish({
        status: "success",
        filename: fileHandle.name,
        entryCount: snapshot.length,
        timestamp: now.getTime(),
      });
    } finally {
      // Always release the lock, on every exit path above (including
      // every early return), never just on the happy path.
      state.backupInProgress = false;
    }
  }

  /* =========================================================================
     RETENTION / CLEANUP (Part 7)
     -------------------------------------------------------------------------
     cleanupOldBackups() is the only entry point. It is called from exactly
     one place — createBackup()'s success path, strictly after the new
     backup file has been written and marked successful (see the comment
     at that call site). It is never called before a backup is confirmed
     written, and its own failures are always swallowed by the caller so
     that a cleanup problem can never turn a successful backup into a
     failed createBackup() result.
     ========================================================================= */

  /* -----------------------------------------------------------------------
     parseBackupFilename(name)
     STRICT FILENAME VALIDATION — the single gate everything in this
     section goes through before a file is even considered a candidate
     for deletion. Reuses BACKUP_FILENAME_PATTERN (the exact same regex
     createBackup()'s own naming logic is built around, so cleanup can
     never disagree with creation about what counts as "one of ours") and
     then goes one step further: it re-parses the matched digits as a
     real calendar date and REJECTS anything the regex would let through
     structurally but that isn't an actual valid date (e.g. a filename
     naming month "13" or day "32") — JavaScript's Date silently rolls
     invalid components over into a different date instead of throwing,
     so that rollover is detected explicitly below rather than trusted.
     Returns { timestampMs, suffix } on a fully valid match, or null for
     absolutely anything else — including every unrelated file a user
     might have stored in the same folder, which this function (and so
     cleanupOldBackups()) never even considers touching.
  ----------------------------------------------------------------------- */
  function parseBackupFilename(name) {
    if (!BACKUP_FILENAME_PATTERN.test(name)) return null;

    const core = name.slice(BACKUP_FILENAME_PREFIX.length, name.length - BACKUP_FILENAME_EXT.length);
    const pieces = core.split("_"); // ["YYYY-MM-DD", "HH-MM-SS"] or + ["N"]
    if (pieces.length !== 2 && pieces.length !== 3) return null; // defensive; regex already guarantees this

    const [datePart, timePart] = pieces;
    const suffix = pieces.length === 3 ? parseInt(pieces[2], 10) : 1; // unsuffixed name ⇒ treated as "_1" for tie-breaking

    const dateNums = datePart.split("-").map(Number);
    const timeNums = timePart.split("-").map(Number);
    if (dateNums.length !== 3 || timeNums.length !== 3) return null;
    const [y, mo, d] = dateNums;
    const [h, mi, s] = timeNums;

    const date = new Date(y, mo - 1, d, h, mi, s);
    // Reject calendar-impossible dates instead of trusting Date's rollover.
    if (
      date.getFullYear() !== y ||
      date.getMonth() !== mo - 1 ||
      date.getDate() !== d ||
      date.getHours() !== h ||
      date.getMinutes() !== mi ||
      date.getSeconds() !== s
    ) {
      return null;
    }

    return { timestampMs: date.getTime(), suffix };
  }

  /* -----------------------------------------------------------------------
     cleanupOldBackups()
     Steps, per spec:
       1. Scan backup folder.
       2. Identify valid application backup files (parseBackupFilename()
          above — anything that doesn't match is left completely alone).
       3. Extract timestamps (done inline in step 2).
       4. Sort newest to oldest — primary key is the timestamp encoded in
          the filename itself (the filename, not disk metadata like
          lastModified, is this feature's single source of truth for
          "when" a backup was taken); secondary key is the numeric _N
          collision suffix, so among several backups that share one exact
          wall-clock second, the one with the higher suffix — the one
          reserveUniqueBackupFileHandle() actually created later — sorts
          as the newer of the two.
       5. Keep the configured number.
       6. Delete only the excess, and only files that passed step 2.
     UNLIMITED short-circuits before step 1 — "do not scan/delete
     unnecessarily" per spec, so an unlimited-retention setup never even
     lists the folder's contents.
     Returns a diagnostic result object rather than throwing.
  ----------------------------------------------------------------------- */
  async function cleanupOldBackups() {
    const retentionConfig = RETENTION_OPTIONS[state.retentionLimit];
    const keepCount = retentionConfig ? retentionConfig.count : RETENTION_OPTIONS[DEFAULT_RETENTION].count;

    // UNLIMITED — nothing to enforce, and per spec, no scan/delete at all.
    if (keepCount == null) {
      return { status: "skipped", code: "unlimited" };
    }

    if (!supportsFileSystemAccess || !state.backupFolderHandle) {
      return { status: "skipped", code: "no-folder" };
    }

    // SILENT permission check only — cleanup always runs automatically
    // right after a backup write, never as the direct result of a click,
    // so (same rule as everywhere else in this file) it must never be
    // able to pop a browser permission dialog.
    await refreshPermissionStateSilently();
    if (state.permissionState !== BACKUP_PERMISSION_STATES.CONNECTED) {
      return { status: "failed", code: state.permissionState };
    }

    // 1. Scan backup folder / 2. Identify valid backups / 3. Extract
    // timestamps. Every entry is checked against parseBackupFilename()
    // — this is the ONLY place cleanup decides whether a file is "ours";
    // directories and any non-matching file (an unrelated document the
    // user happens to keep in this same folder, a backup from a
    // different app, anything) are skipped and never touched.
    const candidates = [];
    try {
      for await (const [name, handle] of state.backupFolderHandle.entries()) {
        if (handle.kind !== "file") continue; // never descend into or touch subfolders
        const parsed = parseBackupFilename(name);
        if (!parsed) continue; // strict match only
        candidates.push({ name, handle, timestampMs: parsed.timestampMs, suffix: parsed.suffix });
      }
    } catch (err) {
      return { status: "failed", code: "scan-failed", error: err };
    }

    // 4. Sort newest to oldest.
    candidates.sort((a, b) => {
      if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs;
      return b.suffix - a.suffix;
    });

    // 5. Keep the configured number / 6. Delete only the excess.
    const toDelete = candidates.slice(keepCount);
    if (toDelete.length === 0) {
      return { status: "success", deletedCount: 0, keptCount: candidates.length };
    }

    let deletedCount = 0;
    const errors = [];
    for (const file of toDelete) {
      try {
        // removeEntry() by exact name on the backup folder handle itself
        // — the same handle everything else in this file already treats
        // as the single, exclusive backup destination. Nothing here ever
        // touches script.js's primary storage folder, the wallpaper
        // folder, or the YouTube playlist folder — those live behind
        // entirely separate handles this function never receives.
        await state.backupFolderHandle.removeEntry(file.name);
        deletedCount += 1;
      } catch (err) {
        // One deletion failing (permissions changed mid-loop, file was
        // already removed by something else, etc.) must never abort the
        // rest of the cleanup pass, and — per the try/catch around this
        // function's only call site — must never propagate up into
        // createBackup()'s own result either.
        errors.push({ name: file.name, error: err });
      }
    }

    return {
      status: errors.length ? "partial" : "success",
      deletedCount,
      keptCount: candidates.length - deletedCount,
      errors: errors.length ? errors : undefined,
    };
  }

  /* =========================================================================
     SCHEDULING AND CHANGE DETECTION
     -------------------------------------------------------------------------
     markDataChanged() (defined above, already wired from script.js's
     saveEntries() since Part 2) just flips a flag. Everything about
     deciding WHEN that flag should actually turn into a real backup on
     disk lives here.
     ========================================================================= */

  /* -----------------------------------------------------------------------
     checkIfBackupDue()
     The elapsed-time decision point. Called by the scheduler's periodic
     tick AND by the visibilitychange/focus lifecycle handlers below —
     both are just different reasons to ask the same question, so both
     funnel through this one function rather than duplicating the
     condition checks.

     Checks, in order (per spec):
       1. Automatic backup enabled.
       2. Valid, non-disabled interval.
       3. Backup folder exists.
       4. Permission available (silent check only — never prompts).
       5. Entries exist.
       6. Data changed since the last backup.
       7. Enough real elapsed time has passed:
          Date.now() - lastSuccessfulBackup >= interval.ms
          (never backed up yet ⇒ treated as overdue, since there is
          nothing to measure elapsed time against).
     Only once all seven hold does it call createBackup("automatic").

     Returns a diagnostic object rather than throwing — useful for a
     future "why hasn't it backed up yet" status line, and safe to call
     as often as the tick/lifecycle handlers like without side effects
     when nothing is actually due.
  ----------------------------------------------------------------------- */
  async function checkIfBackupDue() {
    if (!state.initialized) return { due: false, reason: "not-initialized" };

    // CONCURRENCY (Part 9): the scheduler tick, the visibilitychange
    // handler, the focus handler, and the initial "check right away" call
    // from startScheduler() are four independent reasons to call this
    // function, and any of them can land while a backup — automatic,
    // manual, or a restore's safety backup — is already mid-write.
    // createBackup()'s own backupInProgress lock would catch that later
    // anyway (see its own doc comment), but bailing out here first avoids
    // doing a full silent-permission-check + getEntries() round trip
    // whose result is guaranteed to be thrown away a few lines later.
    if (state.backupInProgress) return { due: false, reason: "already-in-progress" };

    // 1. Automatic backup enabled.
    if (!state.autoBackupEnabled) return { due: false, reason: "auto-backup-disabled" };

    // 2. Valid, non-disabled interval.
    const intervalConfig = BACKUP_INTERVALS[state.selectedInterval];
    if (!intervalConfig || intervalConfig.ms == null) {
      return { due: false, reason: "interval-disabled" };
    }

    // 3. Backup folder exists.
    if (!supportsFileSystemAccess) return { due: false, reason: "unsupported" };
    if (!state.backupFolderHandle) return { due: false, reason: "no-folder" };

    // 4. Permission available — SILENT check only. This runs from an
    // unattended timer tick as often as every SCHEDULER_TICK_MS, so it
    // must never be able to pop a browser permission dialog.
    await refreshPermissionStateSilently();
    if (state.permissionState !== BACKUP_PERMISSION_STATES.CONNECTED) {
      // Permission can be silently revoked between ticks (folder moved,
      // access pulled outside the browser, etc.) — repaint immediately
      // rather than waiting for the next user-triggered action to notice.
      updateBackupUI();
      return { due: false, reason: state.permissionState }; // "permission-required" | "unavailable"
    }

    // 5. Entries exist.
    if (typeof state.api.getEntries !== "function") return { due: false, reason: "no-data-api" };
    let currentEntries;
    try {
      currentEntries = state.api.getEntries();
    } catch (err) {
      return { due: false, reason: "get-entries-threw" };
    }
    if (!Array.isArray(currentEntries) || currentEntries.length === 0) {
      return { due: false, reason: "no-entries" };
    }

    // 6. Data changed since the last backup.
    if (!state.dataChangedSinceBackup) return { due: false, reason: "no-changes" };

    // 7. Enough real elapsed time has passed. This is the actual decision
    // — SCHEDULER_TICK_MS only controls how often this math gets
    // re-checked, never how it comes out.
    const elapsedMs = state.lastSuccessfulBackup == null
      ? Infinity // never backed up before ⇒ always overdue
      : Date.now() - state.lastSuccessfulBackup;
    if (elapsedMs < intervalConfig.ms) {
      return { due: false, reason: "interval-not-elapsed", elapsedMs, requiredMs: intervalConfig.ms };
    }

    // All seven conditions hold — actually back up. createBackup() has
    // its own backupInProgress lock, so a tick that lands while a manual
    // backup (or another tick, in a pathological double-timer scenario)
    // is already writing simply gets a clean "skipped" result back
    // instead of racing it.
    const result = await createBackup("automatic");
    return { due: true, result };
  }

  /* -----------------------------------------------------------------------
     startScheduler() / stopScheduler()
     DUPLICATE TIMER PROTECTION: startScheduler() unconditionally calls
     stopScheduler() first, so no matter how many times or from where it's
     called (settings toggle, interval change, initialize() re-arming
     after a folder reconnect, etc.) there is only ever, at most, one
     setInterval handle alive at a time — tracked as the single
     state.schedulerTimer field.
  ----------------------------------------------------------------------- */
  function startScheduler() {
    stopScheduler(); // guarantees only one timer ever exists
    state.schedulerTimer = setInterval(() => {
      checkIfBackupDue();
    }, SCHEDULER_TICK_MS);
    // Also check right away rather than waiting a full tick — enabling
    // automatic backups (or reconnecting a folder) shouldn't mean sitting
    // idle for up to SCHEDULER_TICK_MS before the first real check.
    checkIfBackupDue();
  }

  function stopScheduler() {
    if (state.schedulerTimer) {
      clearInterval(state.schedulerTimer);
      state.schedulerTimer = null;
    }
  }

  /* -----------------------------------------------------------------------
     LIFECYCLE EVENTS — visibilitychange / focus
     When the app comes back into view (tab refocused, window refocused,
     laptop woken from sleep) a plain setInterval could have been throttled
     or entirely suspended by the browser in the background, silently
     making a scheduled backup run late. Re-running checkIfBackupDue() on
     both events closes that gap using the exact same elapsed-time
     decision the timer itself uses — it does not create a second,
     parallel scheduling mechanism.

     attachLifecycleListeners() is idempotent (guarded by
     lifecycleListenersAttached) so it is always safe to call from
     initialize() even though initialize() itself is already guarded
     against being re-run.
  ----------------------------------------------------------------------- */
  let lifecycleListenersAttached = false;

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") checkIfBackupDue();
  }
  function handleWindowFocus() {
    checkIfBackupDue();
  }

  function attachLifecycleListeners() {
    if (lifecycleListenersAttached) return;
    lifecycleListenersAttached = true;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
  }

  /* -----------------------------------------------------------------------
     UI ADAPTER (Part 6)
     -------------------------------------------------------------------------
     computeUiState() collapses everything BackupManager knows into exactly
     one of the states the settings UI needs to show. All the deciding
     happens here — the UI never re-derives a status from raw fields, it
     just paints whatever string this returns. Priority order matters:
     more urgent/specific states are checked first so, e.g., a folder that
     is mid-write always reads "backup in progress" rather than anything
     else, even if a dozen other conditions also technically apply.
  ----------------------------------------------------------------------- */
  const UI_STATUS_LABELS = {
    "no-folder-selected": "No backup folder selected.",
    "unsupported": "This browser doesn't support local folder backups.",
    "permission-required": "Permission needed — reconnect your backup folder.",
    "backup-in-progress": "Backing up…",
    "failed": "Last backup attempt failed.",
    "disabled": "Automatic backup is off — you can still back up manually.",
    "waiting": "Connected. Waiting for the next scheduled backup.",
    "backup-due": "A backup is due and will run shortly.",
    "connected": "Connected and up to date.",
  };

  function computeUiState() {
    if (state.backupInProgress) return "backup-in-progress";
    if (!supportsFileSystemAccess) return "unsupported";
    if (state.permissionState === BACKUP_PERMISSION_STATES.DISCONNECTED) return "no-folder-selected";
    if (state.permissionState !== BACKUP_PERMISSION_STATES.CONNECTED) return "permission-required"; // permission-required | unavailable
    if (state.lastBackupError) return "failed";

    const intervalConfig = BACKUP_INTERVALS[state.selectedInterval];
    if (!state.autoBackupEnabled || !intervalConfig || intervalConfig.ms == null) return "disabled";
    if (state.lastSuccessfulBackup == null) return "waiting"; // connected + scheduled, never run yet
    if (!state.dataChangedSinceBackup) return "connected"; // up to date, nothing pending

    const elapsedMs = Date.now() - state.lastSuccessfulBackup;
    return elapsedMs >= intervalConfig.ms ? "backup-due" : "waiting";
  }

  // computeDisplayStatus() is getStatus() plus the two fields above — kept
  // as a separate function (rather than folded into getStatus() itself)
  // so getStatus()'s existing shape/contract for any earlier-part caller
  // never changes.
  function computeDisplayStatus() {
    const uiState = computeUiState();
    return Object.assign(getStatus(), {
      uiState,
      uiStatusLabel: UI_STATUS_LABELS[uiState] || "",
    });
  }

  /* -----------------------------------------------------------------------
     updateBackupUI()
     THE UI adapter. Computes the current display status and, if the host
     app registered a renderBackupStatus callback via initialize(), hands
     it the computed object to paint — BackupManager decides WHAT the
     status is, the host only decides HOW it looks on screen. Called
     automatically after every operation in this file that could change
     what the settings panel should show (folder chosen/reconnected/
     forgotten, backup started/finished, any setting changed), so UI code
     never needs to remember to call this itself after using a public
     method — though it's also exposed publicly (below) for the settings
     panel to call once when it first opens.
  ----------------------------------------------------------------------- */
  function updateBackupUI() {
    const status = computeDisplayStatus();
    if (typeof state.api.renderBackupStatus === "function") {
      try {
        state.api.renderBackupStatus(status);
      } catch (err) {
        console.error("BackupManager: renderBackupStatus callback threw:", err);
      }
    }
    return status;
  }

  /* =========================================================================
     RESTORE (Part 8)
     -------------------------------------------------------------------------
     restoreBackup() is the only entry point, same shape as createBackup():
     it never throws, it returns a result object so the UI's click handler
     can just inspect { status }. Every step below maps 1:1 to the RESTORE
     FLOW in the spec (file select → read → parse → validate → preview →
     confirm → safety backup → apply → refresh UI), and nothing here reads
     or writes vocabulary data through any path except the integration API
     (getEntries / setEntries / saveEntries / refreshUI) — nothing new is
     invented for restore specifically.
     ========================================================================= */

  /* -----------------------------------------------------------------------
     pickBackupFile()
     A plain <input type="file"> rather than showOpenFilePicker(): unlike
     the backup FOLDER (which needs sustained write access, hence the File
     System Access API and its supportsFileSystemAccess gate), restoring
     only ever needs one-time read access to a single file the person
     chooses — something every browser supports, including the ones
     createBackup()/chooseBackupFolder() can't run on at all. That keeps
     "restore from a backup someone downloaded/copied over" working even
     in a browser where automatic backup itself is "unsupported".
     Resolves to the chosen File, or null if the person cancelled. Most
     browsers don't fire "change" on cancel, so cancellation is detected
     via the window regaining focus after the native picker closes (with a
     short grace period for "change" to arrive first when a file WAS
     picked) rather than leaving the promise to hang forever.
  ----------------------------------------------------------------------- */
  function pickBackupFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";

      let settled = false;
      function cleanup() {
        window.removeEventListener("focus", onFocus);
        input.remove();
      }
      function onChange() {
        if (settled) return;
        settled = true;
        const file = input.files && input.files[0] ? input.files[0] : null;
        cleanup();
        resolve(file);
      }
      function onFocus() {
        // The native picker only returns focus to the page once it's
        // closed, cancel included. Give "change" (fired first on a real
        // pick) a brief moment to win the race before treating this as a
        // cancellation.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          const file = input.files && input.files[0] ? input.files[0] : null;
          cleanup();
          resolve(file);
        }, 300);
      }

      input.addEventListener("change", onChange, { once: true });
      window.addEventListener("focus", onFocus, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  /* -----------------------------------------------------------------------
     validateBackup(data)
     "Never blindly restore arbitrary JSON": every one of these checks must
     pass before restoreBackup() will even show the person a preview, let
     alone touch their data.
       - the parsed JSON is a plain object (not an array, not null, not a
         primitive that happened to be valid JSON on its own);
       - backupVersion exists, is a finite number, and isn't from a newer
         backup format than this app understands (an older/equal version
         is fine — nothing here has ever removed a field);
       - entries exists and is an array;
       - entries' actual contents pass the exact same structural check
         createBackup() itself runs before ever writing a file
         (validateEntriesSnapshot() above) — reused, not reimplemented, so
         restore can never disagree with creation about what a valid
         entries array looks like.
     Metadata beyond that ("reasonable", per the spec) is checked but never
     fatal on its own — entryCount mismatches, a missing/unparseable
     backupCreatedAt, or a zero-entry backup are surfaced as `warnings` for
     the confirmation preview rather than blocking a restore the person
     may still legitimately want.
     Returns { valid, reason, warnings, entryCount } — reason is only set
     when valid is false; warnings/entryCount are only set when it's true.
  ----------------------------------------------------------------------- */
  function validateBackup(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { valid: false, reason: "The file doesn't contain a backup object." };
    }
    if (data.backupVersion == null) {
      return { valid: false, reason: "Missing backupVersion — this doesn't look like a backup file created by this app." };
    }
    if (!Number.isFinite(data.backupVersion)) {
      return { valid: false, reason: "backupVersion isn't a valid number." };
    }
    if (data.backupVersion > BACKUP_FORMAT_VERSION) {
      return {
        valid: false,
        reason:
          `This backup was created by a newer backup format (v${data.backupVersion}) than this app ` +
          `understands (v${BACKUP_FORMAT_VERSION}). Restoring it isn't safe until the app is updated.`,
      };
    }
    if (!("entries" in data)) {
      return { valid: false, reason: "Missing entries." };
    }
    if (!Array.isArray(data.entries)) {
      return { valid: false, reason: "entries isn't an array." };
    }
    const entriesCheck = validateEntriesSnapshot(data.entries);
    if (!entriesCheck.valid) {
      return { valid: false, reason: `entries failed validation: ${entriesCheck.reason}` };
    }

    const warnings = [];
    if (typeof data.entryCount === "number" && data.entryCount !== data.entries.length) {
      warnings.push(
        `The backup's stated entry count (${data.entryCount}) doesn't match its actual entries (${data.entries.length}).`
      );
    }
    if (data.backupCreatedAt == null) {
      warnings.push("This backup has no creation date recorded.");
    } else if (Number.isNaN(new Date(data.backupCreatedAt).getTime())) {
      warnings.push("This backup's creation date isn't recognizable.");
    }
    if (data.entries.length === 0) {
      warnings.push("This backup contains zero entries.");
    }

    return { valid: true, reason: null, warnings, entryCount: data.entries.length };
  }

  /* -----------------------------------------------------------------------
     restoreBackup()
     Real implementation. Reads/validates/applies a backup file the person
     picks, per the RESTORE FLOW in the spec:
       1-2. pickBackupFile() + file.text().
       3.   JSON.parse().
       4.   validateBackup().
       5-6. Native confirm() preview + explicit confirmation — same
            convention script.js itself already uses for other destructive
            actions (resolveEntriesOnConnect, deleteAllBtn, etc.), so this
            stays consistent without inventing a new in-app modal.
       7.   createBackup("safety-before-restore") of whatever is CURRENTLY
            in the register — only required (and only blocking on failure)
            when there's current data to protect; an empty register has
            nothing a safety backup would preserve, and requiring one
            anyway would make restore impossible for anyone who hasn't
            connected a backup folder yet.
       8.   Apply restored entries via api.setEntries() + api.saveEntries()
            — the host's own setter/persistence, never a second storage
            path here.
       9.   api.refreshUI().
     Every failure path before step 8 leaves the current register
     completely untouched. Returns one of:
       { status: "success", entryCount, filename }
       { status: "cancelled" }                                  — file picker or confirm dialog
       { status: "skipped", code: "already-in-progress" }
       { status: "failed", code: "...", error? }
  ----------------------------------------------------------------------- */
  async function restoreBackup() {
    if (state.backupInProgress) {
      return { status: "skipped", code: "already-in-progress" };
    }

    // 1. User selects backup JSON.
    let file;
    try {
      file = await pickBackupFile();
    } catch (err) {
      return { status: "failed", code: "file-picker-failed", error: err };
    }
    if (!file) {
      return { status: "cancelled" };
    }

    // 2. Read file.
    let text;
    try {
      text = await file.text();
    } catch (err) {
      alert("Couldn't read that file.");
      return { status: "failed", code: "read-failed", error: err };
    }

    // 3. Parse JSON.
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      alert("That file isn't valid JSON, so it can't be used as a backup.");
      return { status: "failed", code: "invalid-json", error: err };
    }

    // 4. Validate backup.
    const validation = validateBackup(data);
    if (!validation.valid) {
      alert(`This doesn't look like a valid backup file:\n\n${validation.reason}`);
      return { status: "failed", code: "invalid-backup", error: validation.reason };
    }

    // Current data, read through the integration API only — never a
    // second source of truth for what's "currently" in the register.
    let currentEntries;
    try {
      currentEntries = typeof state.api.getEntries === "function" ? state.api.getEntries() : [];
      if (!Array.isArray(currentEntries)) currentEntries = [];
    } catch (err) {
      currentEntries = [];
    }

    // 5. Show backup preview + 6. user confirms.
    const createdLabel =
      data.backupCreatedAt != null && !Number.isNaN(new Date(data.backupCreatedAt).getTime())
        ? new Date(data.backupCreatedAt).toLocaleString()
        : "unknown";
    const reasonLabel = data.metadata && data.metadata.backupReason ? ` (${data.metadata.backupReason})` : "";
    let message =
      `Restore this backup?\n\n` +
      `File: ${file.name}\n` +
      `Created: ${createdLabel}${reasonLabel}\n` +
      `Entries in backup: ${validation.entryCount}\n`;
    if (validation.warnings.length > 0) {
      message += `\nWarnings:\n- ${validation.warnings.join("\n- ")}\n`;
    }
    message +=
      `\nThis will REPLACE everything currently in your register (currently ${currentEntries.length} ` +
      `${currentEntries.length === 1 ? "entry" : "entries"}) with the ${validation.entryCount} ` +
      `${validation.entryCount === 1 ? "entry" : "entries"} from this backup.\n\n` +
      `Click OK to restore, or Cancel to keep what you have now.`;

    if (!confirm(message)) {
      return { status: "cancelled" };
    }

    // 7. Create a safety backup of the CURRENT data before replacing
    // anything. Only required when there's current data to lose — see the
    // doc comment above for why an empty register doesn't block restore.
    if (currentEntries.length > 0) {
      let safetyResult;
      try {
        safetyResult = await createBackup("safety-before-restore");
      } catch (err) {
        safetyResult = { status: "failed", code: "safety-backup-threw", error: err };
      }
      if (safetyResult.status !== "success") {
        alert(
          "Couldn't create a safety backup of your CURRENT data before restoring, so nothing was " +
            "changed — your existing entries are exactly as they were.\n\n" +
            `Reason: ${safetyResult.code || "unknown"}\n\n` +
            "Connect or reconnect a backup folder (or resolve whatever the reason above points to) " +
            "and try Restore Backup again."
        );
        return { status: "failed", code: "safety-backup-failed", safetyResult };
      }
    }

    // 8. Restore entries through the existing application API — no
    // second storage system, no duplicate persistence here.
    if (typeof state.api.setEntries !== "function") {
      alert("Restore isn't available in this session — the app didn't provide a way to load restored entries.");
      return { status: "failed", code: "no-set-entries-api" };
    }
    let restoredEntries;
    try {
      // Deep-cloned via JSON round-trip, same convention createBackup()
      // uses for its own snapshot — the host's `entries` and this parsed
      // `data.entries` must never end up aliasing the same objects.
      restoredEntries = JSON.parse(JSON.stringify(data.entries));
    } catch (err) {
      alert("Something went wrong while preparing the restored entries. Nothing was changed.");
      return { status: "failed", code: "clone-failed", error: err };
    }
    try {
      state.api.setEntries(restoredEntries);
    } catch (err) {
      alert(
        "Something went wrong while loading the restored entries. The safety backup created just now " +
          "still has your previous data if anything looks wrong."
      );
      return { status: "failed", code: "set-entries-failed", error: err };
    }
    if (typeof state.api.saveEntries === "function") {
      try {
        state.api.saveEntries();
      } catch (err) {
        // Entries are already applied in memory at this point; surface the
        // failure but don't attempt any automatic rollback — undoing a
        // restore that partially succeeded risks losing it a second time.
        // The safety backup from step 7 remains available either way.
        console.error("BackupManager: saveEntries() threw after restore:", err);
      }
    }

    // 9. Refresh application UI.
    if (typeof state.api.refreshUI === "function") {
      try {
        state.api.refreshUI();
      } catch (err) {
        console.error("BackupManager: refreshUI() threw after restore:", err);
      }
    }

    // AFTER RESTORE, remaining steps: mark data changed (the restored
    // state differs from whatever createBackup() last captured, so the
    // next scheduled/automatic backup should actually run and capture
    // it), and refresh backup status/UI. Called directly rather than
    // relying on api.saveEntries() to trigger it indirectly — in this
    // app's own wiring saveEntries() happens to also call
    // BackupManager.markDataChanged() itself (see script.js), but that's
    // an implementation detail of that one callback, not part of the
    // documented saveEntries contract above ("host app's own
    // persistence"). This file stays correct on its own regardless of
    // what a given host's saveEntries happens to do internally — calling
    // markDataChanged() twice in that case is a harmless, idempotent
    // no-op (see setDataChangedSinceBackup()), which is a cheap price for
    // not silently depending on another file's side effect.
    markDataChanged();

    if (typeof state.api.notify === "function") {
      try {
        state.api.notify(
          "success",
          `Restore complete — ${validation.entryCount} ${validation.entryCount === 1 ? "entry" : "entries"} loaded.`
        );
      } catch (err) {
        console.error("BackupManager: notify callback threw:", err);
      }
    }

    updateBackupUI();

    return { status: "success", entryCount: validation.entryCount, filename: file.name };
  }

  /* -----------------------------------------------------------------------
     Status snapshot — read-only view of internal state for the UI /
     future scheduler to consume, without exposing the mutable `state`
     object itself.
  ----------------------------------------------------------------------- */
  function getStatus() {
    return {
      initialized: state.initialized,
      supportsFileSystemAccess: state.supportsFileSystemAccess,
      backupFolderConnected: state.permissionState === BACKUP_PERMISSION_STATES.CONNECTED,
      backupFolderLabel: getBackupFolderLabel(),
      permissionState: state.permissionState,
      backupInProgress: state.backupInProgress,
      autoBackupEnabled: state.autoBackupEnabled,
      schedulerRunning: !!state.schedulerTimer,
      selectedInterval: state.selectedInterval,
      selectedIntervalLabel: BACKUP_INTERVALS[state.selectedInterval]?.label || null,
      retentionLimit: state.retentionLimit,
      retentionLimitLabel: RETENTION_OPTIONS[state.retentionLimit]?.label || null,
      lastSuccessfulBackup: state.lastSuccessfulBackup,
      lastBackupEntryCount: state.lastBackupEntryCount,
      dataChangedSinceBackup: state.dataChangedSinceBackup,
    };
  }

  /* -----------------------------------------------------------------------
     Public surface — intentionally small. Folder handling, backup
     creation, scheduling, retention, and restore all attach their own
     public methods here in later parts; this part only wires up
     configuration, state, and initialization.
  ----------------------------------------------------------------------- */
  window.BackupManager = {
    // lifecycle
    initialize,
    getStatus,

    // integration hook for the host app's central mutation point
    markDataChanged,

    // settings (used by the future settings UI)
    setAutoBackupEnabled,
    setSelectedInterval,
    setRetentionLimit,

    // backup folder management (this part)
    chooseBackupFolder,     // user-triggered: pick a folder (also used to change it)
    changeBackupFolder,     // alias of chooseBackupFolder, for UI clarity
    reconnectBackupFolder,  // user-triggered: re-grant permission on the already-known folder
    restoreBackupFolderHandle, // silent, automatic — called from initialize()
    forgetBackupFolder,     // user-triggered: disconnect (never deletes on-disk contents)
    getPermissionState: () => state.permissionState,

    // backup creation (this part)
    createBackup,

    // retention / cleanup (Part 7)
    cleanupOldBackups,

    // restore (Part 8)
    restoreBackup,
    validateBackup, // exposed read-only so a future UI could preview/validate a file itself if it ever wants to

    // UI adapter (Part 6) — settings UI calls this once on open; every
    // other public method above already triggers it internally after any
    // state change, so this is a manual refresh hook, not a requirement.
    updateBackupUI,

    // scheduling and change detection (Part 5)
    startScheduler,
    stopScheduler,
    checkIfBackupDue,

    // configuration, exposed read-only for the future settings UI to
    // render options from without hardcoding them a second time
    BACKUP_INTERVALS,
    RETENTION_OPTIONS,
    DEFAULT_BACKUP_INTERVAL,
    DEFAULT_RETENTION,
    BACKUP_PERMISSION_STATES,
    BACKUP_FORMAT_VERSION,
    BACKUP_FILENAME_PREFIX,
    BACKUP_FILENAME_EXT,
    BACKUP_FILENAME_PATTERN,
    VALID_BACKUP_REASONS,
    SCHEDULER_TICK_MS,

    // exposed for later parts (backup creation, scheduling, retention) —
    // not part of the settings/folder-UI-facing surface above.
    _internal: {
      HANDLE_DB_KEY_BACKUP,
      openBackupHandleDB,
      backupIdbGet,
      backupIdbSet,
      backupIdbDelete,
      supportsFileSystemAccess,
      getBackupFolderHandle: () => state.backupFolderHandle,
    },
  };
})();
