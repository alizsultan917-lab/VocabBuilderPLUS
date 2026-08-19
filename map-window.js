/* =========================================================================
   map-window.js
   -------------------------------------------------------------------------
   🗺️ FLOATING VOCABULARY MAP WINDOW — a detachable, draggable pan/zoom map
   viewer, sitting alongside the Vocabulary Audio Window (#vocab-audio-
   window, see the matching block near the end of script.js) rather than
   touching its internals. Gated entirely behind its own master toggle
   (#map-window-toggle-btn / isMapWindowActive below) — with the toggle
   off, the window stays hidden and every hook below is a no-op, exactly
   as if this file weren't loaded.

   Three features, one module:
     1. PAN & ZOOM — wheel-zoom (centered on the cursor), +/− buttons,
        and click-drag panning over #map-viewport, all driving a single
        `transform: translate(tx,ty) scale(s)` on #map-canvas-container.
     2. AI MAP COORDINATES — script.js's existing "Fetch with AI" flow
        (buildEnhancePrompt/parseEnhanceReply/aiFetchBtn in script.js)
        optionally asks the model for a map position when this window is
        open with an active map, and hands the result to
        window.MapWindow.ingestAiMapData(). Markers render into
        #map-markers-layer as plain positioned DOM elements.
     3. CUSTOM MAP UPLOADS — local images are decoded once and stored as
        a Blob in IndexedDB (litVocabMapImages DB — see the tiny idb
        helpers below, same shape as wallpaper-folder-service.js), never
        as a base64 string in localStorage; only small metadata (map id,
        label) and marker coordinates live in localStorage.

   Public surface (window.MapWindow) — the only things script.js touches:
     isActive()              — is the window open AND does it have an
                                active map loaded (gates the AI prompt ask)
     getActiveMapLabel()     — label shown to the AI for its map-location ask
     ingestAiMapData(word, mapData) — record a marker from an AI reply,
                                returns true/false (whether a marker was added)
     promotePendingMarker(word, entryId) — attach a saved entry's id to a
                                marker that was created before the entry
                                existed (see ingestAiMapData)
     centerOnEntry(entryId)  — pan/zoom to an entry's marker, switching
                                maps first if needed; opens the window if
                                it's closed
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------------------------------------------------
     STORAGE
     - IndexedDB (litVocabMapImages): the ONLY place image bytes live —
       one Blob per custom map, keyed by map id.
     - localStorage: everything else, and all of it is small strings/JSON
       (map id/label list, active map id, marker coordinates, window
       on/off + position) — never binary image data.
  ---------------------------------------------------------------------- */
  const MW_DB_NAME = "litVocabMapImages";
  const MW_DB_VERSION = 1;
  const MW_STORE = "images";

  // ---- Real local-folder storage (File System Access API), same shape
  // as the vocab-entries folder connection in script.js. When connected,
  // a map's image file is written straight to a folder the person picked
  // on their own computer — IndexedDB above becomes a fallback, used
  // automatically whenever no folder is connected or the browser doesn't
  // support the API (Firefox/Safari). The chosen folder's handle can't
  // live in localStorage (only strings), so it's kept in its own tiny
  // IndexedDB, same trick as HANDLE_DB_NAME in script.js. ----
  const MW_HANDLE_DB_NAME = "litVocabMapFolderHandle";
  const MW_HANDLE_DB_STORE = "handles";
  const MW_HANDLE_KEY = "mapFolder";
  const mwSupportsFileSystemAccess = "showDirectoryPicker" in window;

  let mapDirHandle = null;     // FileSystemDirectoryHandle, once a folder has been picked
  let usingMapDiskStorage = false; // true once that folder's permission is actually confirmed

  const MW_ACTIVE_STORAGE = "vocabRegister_mapWindowActive";
  const MW_POSITION_STORAGE = "vocabRegister_mapWindowPosition";
  const MW_MAPS_META_STORAGE = "vocabRegister_mapWindowMapsMeta"; // [{id, label}]
  const MW_ACTIVE_MAP_STORAGE = "vocabRegister_mapWindowActiveMapId";
  const MW_MARKERS_STORAGE = "vocabRegister_mapWindowMarkers"; // { [mapId]: [{id, entryId, word, xPercent, yPercent, label}] }
  const MW_PATHS_STORAGE = "vocabRegister_mapWindowPaths"; // { [mapId]: [{id, label, color, visible, points:[{xPercent,yPercent,symbol?}]}] }
  const MW_SYMBOLS_STORAGE = "vocabRegister_mapWindowSymbols"; // { [mapId]: [{id, xPercent, yPercent, symbol, label}] } — standalone icons, independent of any path
  const MW_RECENT_SYMBOLS_STORAGE = "vocabRegister_mapWindowRecentSymbols"; // [symbolChar, ...] — most-recent first, shared across maps/paths/markers
  const MW_FAVORITE_SYMBOLS_STORAGE = "vocabRegister_mapWindowFavoriteSymbols"; // [symbolChar, ...] — user-curated via the ★ toggle in the symbol picker
  const MW_RECENT_SYMBOLS_MAX = 24;

  // ---- Fit mode (see FIT MODE block below) --------------------------
  // "window": the viewport keeps whatever size the window happens to be;
  //   the map image fills it edge-to-edge (like object-fit: cover) but,
  //   unlike plain CSS cover, nothing is actually cropped away — the
  //   overflowing edges are simply reached by panning/scrolling.
  // "image": the viewport itself is reshaped to match the map's own
  //   aspect ratio (or a ratio the person drags/sets), so the whole
  //   image is visible at once with no overflow and no letterboxing
  //   (letterboxing only appears if a *custom* ratio doesn't match the
  //   image, since we never crop or stretch the source).
  const MW_TOOLBAR_HIDDEN_STORAGE = "vocabRegister_mapWindowToolbarHidden"; // "true" | "false"
  const MW_TOOLBAR_IN_SETTINGS_STORAGE = "vocabRegister_mapWindowToolbarInSettings"; // "true" | "false"
  const MW_HEADER_SIZE_STORAGE = "vocabRegister_mapWindowHeaderSize"; // "compact" | "normal" | "roomy"
  const MW_HEADER_MINIMAL_STORAGE = "vocabRegister_mapWindowHeaderMinimal"; // "true" | "false"
  const MW_FIT_MODE_STORAGE = "vocabRegister_mapWindowFitMode"; // "window" | "image"
  const MW_PATH_GLOW_DURATION_STORAGE = "vocabRegister_mapWindowPathGlowDuration"; // "3" | "6" | "10" | "20" | "until-next"
  const MW_SYMBOL_GLOW_DURATION_STORAGE = "vocabRegister_mapWindowSymbolGlowDuration"; // "3" | "6" | "10" | "20" | "until-next"
  const MW_ASPECT_STORAGE = "vocabRegister_mapWindowAspectByMap"; // { [mapId]: widthOverHeight }
  const MW_WINDOW_WIDTH_STORAGE = "vocabRegister_mapWindowWidth"; // px — the whole floating window's width, set by dragging the resize handle
  const MW_VIEWPORT_MIN_HEIGHT = 160;
  const MW_VIEWPORT_MAX_HEIGHT = 900;
  const MW_WINDOW_MIN_WIDTH = 320;
  const MW_WINDOW_MAX_WIDTH = 720;

  // ---- Symbol palette (190+ icons), shared by two features: decorating
  // a path point (openSymbolPicker call from the vertex click handler)
  // and standalone symbol markers pinned anywhere on the map (the
  // "📍 Place Symbol" panel). Grouped purely for browsability in the
  // picker popover; the flat list itself is what matters for storage —
  // a point's/marker's `symbol` is just one of these strings. ----
  const SYMBOL_CATEGORIES = [
    {
      label: "Landmarks",
      symbols: ["🏰", "🏯", "🏟️", "🕌", "🛕", "⛩️", "🗼", "🏛️", "🏚️", "🏠", "🏡", "🏘️", "🏢", "🏭", "🏗️", "⛪", "🕍", "🛖", "⛲", "⛺", "🌉", "🌁", "🗽", "🪦", "🕋", "🚪", "🪟", "🧱"],
    },
    {
      label: "Nature & Terrain",
      symbols: ["🌳", "🌲", "🌴", "🌵", "🌾", "🌿", "☘️", "🍀", "🌷", "🌸", "🌹", "🌻", "🌼", "💐", "🍁", "🍂", "🍃", "🪨", "⛰️", "🏔️", "🌋", "🏝️", "🏖️", "🏜️", "🏞️", "🌊", "💧", "🔥", "❄️", "⚡", "🌪️", "🌈", "☀️", "🌙", "⭐", "☁️", "🌫️"],
    },
    {
      label: "Travel & Transport",
      symbols: ["🚢", "⛵", "🛶", "🚤", "🛳️", "⚓", "🗺️", "🧭", "🚂", "🚆", "🚗", "🚙", "🚕", "🛻", "🚚", "🐎", "🛞", "🚀", "✈️", "🎈", "🛸", "🛷", "🚁", "🛤️"],
    },
    {
      label: "Tools & Treasure",
      symbols: ["🔨", "⚒️", "🛠️", "⚔️", "🗡️", "🏹", "🛡️", "🔱", "⛏️", "🪓", "🔧", "🔩", "⚙️", "🪛", "🧰", "📯", "🔔", "🕰️", "⏳", "🗝️", "🔑", "🔒", "🚩", "🏳️", "🏴", "🏴‍☠️", "📜", "🧭", "💰", "💎", "👑", "🎖️", "🏆", "⚗️", "🧪", "🧿", "🪬"],
    },
    {
      label: "Animals",
      symbols: ["🐴", "🦄", "🐺", "🦊", "🐻", "🐨", "🐼", "🦁", "🐯", "🐅", "🐆", "🐘", "🦣", "🐫", "🐪", "🦌", "🦬", "🐐", "🐑", "🐄", "🐖", "🐓", "🦃", "🕊️", "🦅", "🦉", "🦇", "🦜", "🐦", "🦢", "🦩", "🐢", "🐊", "🦎", "🐍", "🐉", "🦂", "🕷️", "🐝", "🦋", "🐌", "🐛", "🦑", "🐙", "🦀", "🐬", "🐳", "🐋", "🦈", "🐟", "🐇", "🦔", "🐿️", "🦫", "🦡"],
    },
    {
      label: "People & Fantasy",
      symbols: ["🧙", "🧙‍♂️", "🧙‍♀️", "🧝", "🧝‍♂️", "🧝‍♀️", "🧛", "🧛‍♂️", "🧟", "🧟‍♂️", "👸", "🤴", "🥷", "🧑‍🌾", "🧑‍🚀", "🧑‍✈️", "🧑‍🎨", "🕵️", "🧑‍🔬", "🧑‍⚕️", "🧌", "🧞", "🧜", "👤"],
    },
    {
      label: "Symbols & Weather",
      symbols: ["⭐", "✨", "💫", "🌟", "☠️", "💀", "👁️", "🔮", "📍", "📌", "🎯", "🏁", "💣", "🕳️", "🧨", "🎪"],
    },
  ];

  // ---- Extended symbol library (2,400+ icons) + search index ---------
  // map-symbols-data.js (loaded just before this file) defines
  // window.MW_SYMBOL_DATA: an array of { key, label, symbols:[{s,n}] }
  // groups. Deliberately curated for visual quality over raw count —
  // full-color pictographs (nature, objects, food, animals), illustrated
  // profession/activity emoji (astronaut, surfer, teacher, families,
  // couples), country flags, game tiles (mahjong/cards), alchemical
  // glyphs, dingbats, arrows, geometric shapes and currency symbols.
  // Left out on purpose: braille dots, box-drawing lines, block
  // elements, CJK squared/compat letters, superscripts, circled
  // numbers, and musical/Tai-Xuan-Jing notation — all plain, low-detail,
  // or poorly font-supported, which is why an earlier pass that
  // included them felt "dull." Each symbol carries its real Unicode
  // name so it's meaningfully searchable. The original hand-picked
  // SYMBOL_CATEGORIES becomes a "★ Favorites" tab up front (looking up
  // real names for them where we can), then every extended group
  // follows. SYMBOL_CATEGORIES above is left untouched since nothing
  // else references it directly anymore.
  const SYMBOL_GROUPS = (function buildSymbolGroups() {
    const nameByChar = {};
    (window.MW_SYMBOL_DATA || []).forEach((g) => {
      g.symbols.forEach((it) => {
        if (!(it.s in nameByChar)) nameByChar[it.s] = it.n;
      });
    });
    const favorites = {
      key: "favorites",
      label: "★ Favorites",
      symbols: SYMBOL_CATEGORIES.flatMap((cat) =>
        cat.symbols.map((s) => ({ s, n: nameByChar[s] || cat.label }))
      ),
    };
    const extended = (window.MW_SYMBOL_DATA || []).map((g) => ({
      key: g.key,
      label: g.label,
      symbols: g.symbols,
    }));
    return [favorites, ...extended];
  })();

  // Flat, de-duplicated (first occurrence wins — favorites take priority)
  // index used only for live search across every group at once.
  const SYMBOL_SEARCH_INDEX = (function buildSearchIndex() {
    const byChar = new Map();
    SYMBOL_GROUPS.forEach((g) => {
      g.symbols.forEach((it) => {
        if (!byChar.has(it.s)) byChar.set(it.s, { s: it.s, n: it.n, g: g.label });
      });
    });
    return Array.from(byChar.values());
  })();

  // Char → real Unicode name, for labelling recent-symbol buttons (built
  // once off the already-deduplicated search index rather than re-walking
  // every group).
  const SYMBOL_NAME_BY_CHAR = (function buildNameByChar() {
    const map = {};
    SYMBOL_SEARCH_INDEX.forEach((it) => {
      map[it.s] = it.n;
    });
    return map;
  })();

  // Best available human-readable label for a symbol: its real
  // Unicode/asset name when known, else a generic placeholder for custom
  // hand-authored artwork. NEVER falls back to the raw symbol string
  // itself — for custom SVG symbols (the ASOIAF structures etc.) that's
  // a data:image/svg+xml URI hundreds of characters long, and dropping
  // that into a title attribute or a text node blows up whatever UI it
  // lands in.
  function symbolLabelFor(symbol) {
    return SYMBOL_NAME_BY_CHAR[symbol] || (mwIsCustomSvgSymbol(symbol) ? "Custom symbol" : symbol);
  }

  // Builds the "🕓 Recent" tab fresh from the current recentSymbols list
  // (rather than being baked into the static SYMBOL_GROUPS array), so it
  // stays live as picks happen without needing a page reload.
  function buildRecentGroup() {
    return {
      key: "recent",
      label: "🕓 Recent",
      symbols: recentSymbols.map((s) => ({ s, n: symbolLabelFor(s) })),
    };
  }

  // Builds the "★ Favorites" tab fresh from the current favoriteSymbols
  // list — user-curated (star-toggle in the picker), persisted, and
  // editable, unlike the fixed SYMBOL_CATEGORIES seed it started from.
  function buildFavoritesGroup() {
    return {
      key: "favorites",
      label: "★ Favorites",
      symbols: favoriteSymbols.map((s) => ({ s, n: symbolLabelFor(s) })),
    };
  }

  // Tab list the picker actually renders: "Recent" first (only while it
  // has entries), then the live "Favorites" tab, then every extended
  // group from SYMBOL_GROUPS (skipping its own static "favorites" entry,
  // which only exists to seed the search index — see buildSymbolGroups).
  function symbolGroupsForPicker() {
    const recent = buildRecentGroup();
    const favorites = buildFavoritesGroup();
    const rest = SYMBOL_GROUPS.filter((g) => g.key !== "favorites");
    return recent.symbols.length ? [recent, favorites, ...rest] : [favorites, ...rest];
  }

  const SYMBOL_RENDER_CAP = 400; // cap DOM nodes per render for popover performance

  const MIN_SCALE = 1.0;
  // Raised from 5.0, then again from 16.0 — headroom to zoom in tight on
  // a small/detailed map and trace or drop a point on a precise "micro"
  // spot (a single building, two close-together paths) instead of the
  // click radius covering a chunk of the image at the old ceiling.
  const MAX_SCALE = 28.0;
  const ZOOM_STEP = 0.25;
  // Manual per-symbol size multiplier range (marker.scale), independent
  // of the automatic zoom counter-scaling above — this is what lets a
  // symbol be pinned at whatever fixed size the user picks via the
  // slider in the 📍 panel, overriding the default sizing entirely.
  const SYMBOL_SCALE_MIN = 0.1;
  const SYMBOL_SCALE_MAX = 4.0;
  const SYMBOL_SCALE_STEP = 0.05;
  const SYMBOL_SCALE_DEFAULT = 1.0;
  // Label size is a SEPARATE multiplier from the icon/symbol scale above —
  // it's what lets a name be shrunk down to near-nothing (or hidden
  // outright via labelHidden) while the icon itself stays full size, for
  // labels that only exist so the map search can find the thing by name.
  const LABEL_SCALE_MIN = 0.1;
  const LABEL_SCALE_MAX = 3.0;
  const LABEL_SCALE_STEP = 0.05;
  const LABEL_SCALE_DEFAULT = 1.0;
  const WHEEL_ZOOM_SENSITIVITY = 0.0016; // multiplied against -deltaY
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PATH_COLORS = ["#e63946", "#2f78bd", "#2a9d8f", "#f4a261", "#8e44ad", "#e07a5f", "#588157", "#c9184a"];

  function openImageDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(MW_DB_NAME, MW_DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(MW_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGetImage(id) {
    const db = await openImageDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(MW_STORE, "readonly").objectStore(MW_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSetImage(id, blob) {
    const db = await openImageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MW_STORE, "readwrite");
      tx.objectStore(MW_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDeleteImage(id) {
    const db = await openImageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MW_STORE, "readwrite");
      tx.objectStore(MW_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ----- Local folder: remembers the chosen directory handle across
     sessions, and reads/writes map image files directly inside it. ----- */
  function openMapHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(MW_HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(MW_HANDLE_DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGetMapFolderHandle() {
    try {
      const db = await openMapHandleDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(MW_HANDLE_DB_STORE, "readonly");
        const req = tx.objectStore(MW_HANDLE_DB_STORE).get(MW_HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn("Map Window: failed to read stored folder handle:", err);
      return null;
    }
  }
  async function idbSetMapFolderHandle(handle) {
    try {
      const db = await openMapHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(MW_HANDLE_DB_STORE, "readwrite");
        tx.objectStore(MW_HANDLE_DB_STORE).put(handle, MW_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("Map Window: failed to remember chosen folder:", err);
    }
  }
  async function idbClearMapFolderHandle() {
    try {
      const db = await openMapHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(MW_HANDLE_DB_STORE, "readwrite");
        tx.objectStore(MW_HANDLE_DB_STORE).delete(MW_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("Map Window: failed to forget chosen folder:", err);
    }
  }

  async function verifyMapFolderPermission(handle, requestIfNeeded) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // Extension used for a map's on-disk filename — kept in mapsMeta so a
  // re-load knows exactly what file to look for. Falls back to "png" for
  // maps saved before this existed, or when a name can't be worked out.
  function extFromFile(file) {
    const m = /\.([a-z0-9]+)$/i.exec(file?.name || "");
    if (m) return m[1].toLowerCase();
    if (/webp/i.test(file?.type || "")) return "webp";
    if (/jpe?g/i.test(file?.type || "")) return "jpg";
    return "png";
  }
  function mapFileName(id, ext) {
    return `${id}.${ext || "png"}`;
  }

  // ---- Per-map JSON sidecar filename, local-folder side: `<mapId>.json`
  // living right next to `<mapId>.<ext>`. On Drive the same two files get
  // a prefix (MW_DRIVE_PREFIX) so a "list my map bundles" query can filter
  // by filename alone, without downloading every file drive.file can see.
  function mapJsonFileName(id) {
    return `${id}.json`;
  }
  const MW_DRIVE_PREFIX = "mapwindow-";
  // Which Drive folder exports go into — "" means My Drive's root. Picked
  // (or created) from the folder dropdown beneath the export button, and
  // remembered across visits the same way the local export folder isn't
  // (that one deliberately re-asks every time; Drive doesn't need to).
  const MW_DRIVE_EXPORT_FOLDER_ID_STORAGE = "mapWindowDriveExportFolderId";
  const MW_DRIVE_EXPORT_FOLDER_NAME_STORAGE = "mapWindowDriveExportFolderName";
  let mwDriveExportFolderId = localStorage.getItem(MW_DRIVE_EXPORT_FOLDER_ID_STORAGE) || "";
  let mwDriveExportFolderName = localStorage.getItem(MW_DRIVE_EXPORT_FOLDER_NAME_STORAGE) || "";
  function driveMapFileName(id, ext) {
    return `${MW_DRIVE_PREFIX}${id}.${ext || "png"}`;
  }
  function driveMapJsonFileName(id) {
    return `${MW_DRIVE_PREFIX}${id}.json`;
  }
  function driveMimeForExt(ext) {
    const e = (ext || "png").toLowerCase();
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "webp") return "image/webp";
    return "image/png";
  }

  // Writes a map image to whichever storage is currently active — the
  // connected folder if there is one, IndexedDB otherwise. A folder write
  // failure (permission revoked mid-session, disk full, etc.) falls back
  // to IndexedDB automatically rather than losing the upload.
  async function storeMapImage(id, ext, blobOrFile) {
    if (usingMapDiskStorage && mapDirHandle) {
      try {
        const fh = await mapDirHandle.getFileHandle(mapFileName(id, ext), { create: true });
        const writable = await fh.createWritable();
        await writable.write(blobOrFile);
        await writable.close();
        return { ok: true };
      } catch (err) {
        console.warn("Map Window: couldn't write image to folder, falling back to browser storage:", err);
      }
    }
    try {
      await idbSetImage(id, blobOrFile);
      return { ok: true };
    } catch (err) {
      console.warn("Map Window: failed to store map image:", err);
      return { ok: false, message: "Couldn't store that image (folder or browser storage may be unavailable)." };
    }
  }

  // Reads a map's image back — from the connected folder if it's there,
  // otherwise IndexedDB (handles maps uploaded before a folder was
  // connected, which only ever landed in IndexedDB).
  async function readMapImage(id, ext) {
    if (usingMapDiskStorage && mapDirHandle) {
      try {
        const fh = await mapDirHandle.getFileHandle(mapFileName(id, ext), { create: false });
        return await fh.getFile();
      } catch {
        /* not in the folder — fall through to IndexedDB */
      }
    }
    try {
      return await idbGetImage(id);
    } catch (err) {
      console.warn("Map Window: couldn't read map image:", err);
      return null;
    }
  }

  async function deleteMapImage(id, ext) {
    if (usingMapDiskStorage && mapDirHandle) {
      try {
        await mapDirHandle.removeEntry(mapFileName(id, ext));
      } catch {
        /* file may not exist in the folder — non-fatal */
      }
    }
    try {
      await idbDeleteImage(id);
    } catch (err) {
      console.warn("Map Window: failed to delete map image:", err);
    }
  }

  /* ----------------------------------------------------------------------
     PER-MAP JSON BUNDLE — the connected local folder (and, optionally,
     Google Drive) as the single source of truth for one map's editable
     data: markers, paths, symbols, and its custom aspect ratio. A
     `<mapId>.json` file sits next to `<mapId>.<ext>` in the folder;
     mapsMeta itself is *derived* from scanning the folder rather than
     read from localStorage whenever a folder is connected (see
     saveMapsMeta()/scanMapFolder() below). Everything here is additive —
     when no folder and no Drive are connected, none of it runs, and the
     existing IndexedDB + localStorage path (Feature 5) is untouched.
  ---------------------------------------------------------------------- */
  const MW_BUNDLE_SOURCE = "mapWindowBundle";
  const MW_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

  function buildMapBundle(id) {
    const meta = mapsMeta.find((m) => m.id === id) || {};
    return {
      source: MW_BUNDLE_SOURCE,
      v: 1,
      id,
      label: meta.label || id,
      ext: meta.ext || "png",
      markers: markersByMap[id] || [],
      paths: pathsByMap[id] || [],
      symbols: symbolsByMap[id] || [],
      customRatio: customRatioByMap[id] || null,
      updatedAt: new Date().toISOString(),
    };
  }

  // Injects a loaded/imported bundle back into the live state variables
  // so every SVG path, vertex, and standalone symbol is immediately
  // editable — same shape setActiveMap() already expects.
  function applyMapBundle(id, bundle) {
    if (!bundle) return;
    markersByMap[id] = Array.isArray(bundle.markers) ? bundle.markers : [];
    pathsByMap[id] = Array.isArray(bundle.paths) ? bundle.paths : [];
    symbolsByMap[id] = Array.isArray(bundle.symbols) ? bundle.symbols : [];
    if (bundle.customRatio && isFinite(bundle.customRatio) && bundle.customRatio > 0) {
      customRatioByMap[id] = bundle.customRatio;
    } else {
      delete customRatioByMap[id];
    }
    saveJson(MW_MARKERS_STORAGE, markersByMap);
    saveJson(MW_PATHS_STORAGE, pathsByMap);
    saveJson(MW_SYMBOLS_STORAGE, symbolsByMap);
    saveJson(MW_ASPECT_STORAGE, customRatioByMap);
  }

  async function writeMapJsonToFolder(id, bundle) {
    if (!(usingMapDiskStorage && mapDirHandle)) return false;
    try {
      const fh = await mapDirHandle.getFileHandle(mapJsonFileName(id), { create: true });
      const writable = await fh.createWritable();
      await writable.write(JSON.stringify(bundle, null, 2));
      await writable.close();
      return true;
    } catch (err) {
      console.warn(`Map Window: couldn't write "${mapJsonFileName(id)}" to the folder:`, err);
      return false;
    }
  }

  async function readMapJsonFromFolder(id) {
    if (!(usingMapDiskStorage && mapDirHandle)) return null;
    try {
      const fh = await mapDirHandle.getFileHandle(mapJsonFileName(id), { create: false });
      const file = await fh.getFile();
      const parsed = JSON.parse(await file.text());
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null; // no sidecar json yet — the image still lists fine
    }
  }

  async function deleteMapJsonFromFolder(id) {
    if (!(usingMapDiskStorage && mapDirHandle)) return;
    try {
      await mapDirHandle.removeEntry(mapJsonFileName(id));
    } catch {
      /* may not exist — non-fatal */
    }
  }

  // Feature 1: reads the connected folder directly — every image file is
  // a map; its label/markers/paths/symbols/ratio come from the matching
  // `<mapId>.json` when one exists, or just the filename when it doesn't.
  async function scanMapFolder() {
    if (!(usingMapDiskStorage && mapDirHandle)) return null;
    const found = [];
    try {
      for await (const [name, handle] of mapDirHandle.entries()) {
        if (handle.kind !== "file") continue;
        const m = MW_IMAGE_EXT_RE.exec(name);
        if (!m) continue;
        found.push({ id: name.slice(0, -m[0].length), ext: m[1].toLowerCase() });
      }
    } catch (err) {
      console.warn("Map Window: couldn't read the connected folder:", err);
      return null;
    }
    const nextMeta = [];
    for (const { id, ext } of found) {
      const bundle = await readMapJsonFromFolder(id);
      nextMeta.push({ id, ext, label: (bundle && bundle.label) || id });
      if (bundle) applyMapBundle(id, bundle);
    }
    nextMeta.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    return nextMeta;
  }

  // Rebuilds mapsMeta from the folder (bypassing localStorage entirely —
  // see saveMapsMeta()) and refreshes the dropdown. Returns true if a scan
  // actually happened (folder connected), false otherwise so callers can
  // fall back to whatever mapsMeta already held.
  async function refreshMapsMetaFromFolder() {
    const scanned = await scanMapFolder();
    if (!scanned) return false;
    mapsMeta = scanned;
    populateRegionSelect();
    if (activeMapId && !mapsMeta.some((m) => m.id === activeMapId)) activeMapId = null;
    return true;
  }

  // Debounced "sync the active map's data to the folder" — called after
  // every marker/path/symbol edit (saveMarkers/savePaths/saveSymbols
  // below) so the `<mapId>.json` sidecar stays current without needing an
  // explicit Export click every time. A no-op unless a folder is actually
  // connected. Deliberately does NOT touch the resize-handle/aspect-ratio
  // code above, or push to Drive on every keystroke-level edit — Drive
  // sync (including the image) stays an explicit Export action.
  let mwFolderSyncTimer = null;
  function scheduleActiveMapSync() {
    if (!activeMapId || !(usingMapDiskStorage && mapDirHandle)) return;
    if (!mapsMeta.some((m) => m.id === activeMapId)) return; // e.g. mid-delete
    const id = activeMapId;
    clearTimeout(mwFolderSyncTimer);
    mwFolderSyncTimer = setTimeout(() => {
      writeMapJsonToFolder(id, buildMapBundle(id));
    }, 800);
  }

  /* ----- Google Drive — reuses script.js's existing OAuth token/fetch
     wrapper (driveApiFetch, usingCloudStorage) and drive.file-scoped
     connection; no separate auth flow. Files are named with
     MW_DRIVE_PREFIX so "list my map bundles" can filter by name alone. */
  async function driveFindFileIdByName(name) {
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
    const data = await res.json();
    return data.files && data.files.length ? data.files[0].id : null;
  }

  // Same lookup, but scoped to one folder (or the Drive root when folderId
  // is falsy) — used by the export path so picking a different destination
  // folder creates its own copy instead of silently updating whatever file
  // of the same name happens to exist elsewhere in Drive.
  async function driveFindFileIdInFolder(name, folderId) {
    const parentClause = folderId ? `'${folderId}' in parents` : `'root' in parents`;
    const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and trashed = false and ${parentClause}`);
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
    const data = await res.json();
    return data.files && data.files.length ? data.files[0].id : null;
  }

  // Lists folders the app can currently see. Under drive.file scope that's
  // only folders this app itself created (or the person explicitly opened
  // through a Drive file picker) — never the rest of their Drive — which
  // is exactly the "folders I made for this app" list the export dropdown
  // wants.
  async function driveListFolders() {
    if (!usingCloudStorage) return [];
    const q = encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=100&orderBy=name`);
    if (!res.ok) throw new Error(`Drive folder list failed (${res.status})`);
    const data = await res.json();
    return data.files || [];
  }

  async function driveCreateFolder(name) {
    const res = await driveApiFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
    });
    if (!res.ok) throw new Error(`Drive folder create failed (${res.status})`);
    return (await res.json()).id;
  }

  async function driveUpsertJson(name, obj, folderId) {
    const text = JSON.stringify(obj, null, 2);
    const id = await driveFindFileIdInFolder(name, folderId);
    if (id) {
      const res = await driveApiFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      if (!res.ok) throw new Error(`Drive JSON update failed (${res.status})`);
      return id;
    }
    const metadata = { name, mimeType: "application/json" };
    if (folderId) metadata.parents = [folderId];
    const boundary = "mapWindowJsonBoundary";
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await driveApiFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Drive JSON create failed (${res.status})`);
    return (await res.json()).id;
  }

  // Binary (image) upload — same resumable-upload pattern as script.js's
  // uploadExportToDrive, so large images can't be truncated mid-request.
  async function driveUpsertBinary(name, mimeType, blob, folderId) {
    const existingId = await driveFindFileIdInFolder(name, folderId);
    if (existingId) {
      const res = await driveApiFetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": mimeType },
        body: blob,
      });
      if (!res.ok) throw new Error(`Drive image update failed (${res.status})`);
      return existingId;
    }
    const metadata = { name, mimeType };
    if (folderId) metadata.parents = [folderId];
    const initRes = await driveApiFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify(metadata),
    });
    if (!initRes.ok) throw new Error(`Drive image upload init failed (${initRes.status})`);
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) throw new Error("Drive didn't return a resumable upload session URL");
    const putRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mimeType }, body: blob });
    if (!putRes.ok) throw new Error(`Drive image upload failed (${putRes.status})`);
    return true;
  }

  async function driveDeleteFileByName(name) {
    try {
      const id = await driveFindFileIdByName(name);
      if (id) await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: "DELETE" });
    } catch (err) {
      console.warn(`Map Window: couldn't remove "${name}" from Drive:`, err);
    }
  }

  // Feature 3: pushes the active map's json (always) and image (only when
  // asked — e.g. the explicit Export click, not every background sync) to
  // the same Drive connection/tokens script.js already manages. folderId
  // ("" for My Drive's root) comes from the export folder dropdown.
  async function pushMapBundleToDrive(id, bundle, { withImage = false, folderId = "" } = {}) {
    if (!usingCloudStorage) return false;
    try {
      const jsonName = driveMapJsonFileName(id);
      await driveUpsertJson(jsonName, bundle, folderId);
      if (withImage) {
        const meta = mapsMeta.find((m) => m.id === id);
        const blob = await readMapImage(id, meta?.ext);
        if (blob) await driveUpsertBinary(driveMapFileName(id, meta?.ext), driveMimeForExt(meta?.ext), blob, folderId);
      }
      // Verify the write actually landed in the folder we think it did,
      // rather than trusting a 200 response alone — a stale/incorrect
      // folderId, a wrong Drive account, or Drive's own indexing lag can
      // otherwise let this report success while nothing shows up where
      // the person is looking. This costs one more round trip per export.
      const confirmedId = await driveFindFileIdInFolder(jsonName, folderId);
      if (!confirmedId) {
        console.warn("Map Window: Drive upload reported success but the file couldn't be found back in the target folder.");
        return false;
      }
      return true;
    } catch (err) {
      console.warn("Map Window: Drive sync failed:", err);
      return false;
    }
  }

  // Feature 4 (Drive side): lists every map bundle json this app has
  // written to Drive, for the "Import from Drive" picker.
  async function driveListMapBundles() {
    if (!usingCloudStorage) return [];
    const q = encodeURIComponent(`name contains '${MW_DRIVE_PREFIX}' and mimeType = 'application/json' and trashed = false`);
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=100`);
    if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
    const data = await res.json();
    return (data.files || []).filter((f) => f.name.startsWith(MW_DRIVE_PREFIX) && f.name.endsWith(".json"));
  }

  async function driveDownloadJson(fileId) {
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`Drive read failed (${res.status})`);
    return res.json();
  }

  async function driveDownloadBinary(fileId) {
    const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`Drive image read failed (${res.status})`);
    return res.blob();
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* non-fatal — quota or private-mode storage failure */
    }
  }

  function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `mw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function slugify(name) {
    const base = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || `map-${Date.now()}`;
  }

  let mapsMeta = loadJson(MW_MAPS_META_STORAGE, []); // [{id, label}]
  let markersByMap = loadJson(MW_MARKERS_STORAGE, {}); // { mapId: [marker...] }
  let pathsByMap = loadJson(MW_PATHS_STORAGE, {}); // { mapId: [path...] }
  let symbolsByMap = loadJson(MW_SYMBOLS_STORAGE, {}); // { mapId: [{id, xPercent, yPercent, symbol, label}] }
  let customRatioByMap = loadJson(MW_ASPECT_STORAGE, {}); // { mapId: widthOverHeight } — only set once someone drags the resize handle
  let activeMapId = localStorage.getItem(MW_ACTIVE_MAP_STORAGE) || null;

  // Feature 1: once a folder is connected it is the single source of
  // truth for *which maps exist and what they're labelled* — mapsMeta is
  // rebuilt from scanMapFolder()/refreshMapsMetaFromFolder() instead, so
  // writing it back to localStorage here is skipped entirely. Disconnect
  // the folder (or never connect one) and this falls straight back to the
  // original localStorage behavior (Feature 5).
  function saveMapsMeta() {
    if (usingMapDiskStorage && mapDirHandle) return;
    saveJson(MW_MAPS_META_STORAGE, mapsMeta);
  }
  function saveMarkers() {
    saveJson(MW_MARKERS_STORAGE, markersByMap);
    scheduleActiveMapSync();
  }
  function markersFor(mapId) {
    if (!markersByMap[mapId]) markersByMap[mapId] = [];
    return markersByMap[mapId];
  }
  function savePaths() {
    saveJson(MW_PATHS_STORAGE, pathsByMap);
    scheduleActiveMapSync();
  }
  function pathsFor(mapId) {
    if (!pathsByMap[mapId]) pathsByMap[mapId] = [];
    return pathsByMap[mapId];
  }
  function saveSymbols() {
    saveJson(MW_SYMBOLS_STORAGE, symbolsByMap);
    scheduleActiveMapSync();
  }
  function symbolsFor(mapId) {
    if (!symbolsByMap[mapId]) symbolsByMap[mapId] = [];
    return symbolsByMap[mapId];
  }

  // Recently-used symbols — one flat list shared across every context the
  // picker opens from (path points, standalone markers), most-recent
  // first, deduplicated, capped at MW_RECENT_SYMBOLS_MAX. Persisted so it
  // survives a reload, same as everything else in this file.
  let recentSymbols = loadJson(MW_RECENT_SYMBOLS_STORAGE, []).filter((s) => typeof s === "string" && s);
  function saveRecentSymbols() {
    saveJson(MW_RECENT_SYMBOLS_STORAGE, recentSymbols);
  }
  function recordRecentSymbol(symbol) {
    if (!symbol) return; // "No symbol" / clear picks don't count
    recentSymbols = [symbol, ...recentSymbols.filter((s) => s !== symbol)].slice(0, MW_RECENT_SYMBOLS_MAX);
    saveRecentSymbols();
  }
  // Removes one entry from the "Recent" tab without touching favorites —
  // called from the ✖ badge on a recent-tab symbol button.
  function removeRecentSymbol(symbol) {
    recentSymbols = recentSymbols.filter((s) => s !== symbol);
    saveRecentSymbols();
  }

  // User-curated favorites — a real, editable list (star-toggle in the
  // picker adds/removes), persisted the same way as recentSymbols.
  // Seeded once from the original curated SYMBOL_CATEGORIES set so
  // existing users don't open the picker to an empty Favorites tab.
  let favoriteSymbols = loadJson(MW_FAVORITE_SYMBOLS_STORAGE, null);
  if (!Array.isArray(favoriteSymbols)) {
    favoriteSymbols = SYMBOL_CATEGORIES.flatMap((cat) => cat.symbols);
  }
  favoriteSymbols = favoriteSymbols.filter((s) => typeof s === "string" && s);
  function saveFavoriteSymbols() {
    saveJson(MW_FAVORITE_SYMBOLS_STORAGE, favoriteSymbols);
  }
  function isFavoriteSymbol(symbol) {
    return favoriteSymbols.includes(symbol);
  }
  function addFavoriteSymbol(symbol) {
    if (!symbol || favoriteSymbols.includes(symbol)) return;
    favoriteSymbols = [symbol, ...favoriteSymbols];
    saveFavoriteSymbols();
  }
  function removeFavoriteSymbol(symbol) {
    favoriteSymbols = favoriteSymbols.filter((s) => s !== symbol);
    saveFavoriteSymbols();
  }
  function toggleFavoriteSymbol(symbol) {
    if (isFavoriteSymbol(symbol)) removeFavoriteSymbol(symbol);
    else addFavoriteSymbol(symbol);
  }

  /* ----------------------------------------------------------------------
     DOM
  ---------------------------------------------------------------------- */
  const toggleBtn = document.getElementById("map-window-toggle-btn");
  const win = document.getElementById("vocab-map-window");
  if (!toggleBtn || !win) return; // markup not present — nothing to wire up

  const dragHandle = document.getElementById("mw-drag-handle");
  const closeBtn = document.getElementById("mw-close-btn");
  const optionsBtn = document.getElementById("mw-options-btn");
  const optionsPanel = document.getElementById("mw-options-panel");
  const regionSelect = document.getElementById("mw-region-select");
  const zoomInBtn = document.getElementById("vaw-map-zoom-in");
  const zoomOutBtn = document.getElementById("vaw-map-zoom-out");
  const zoomResetBtn = document.getElementById("mw-zoom-reset");
  const zoomLevelEl = document.getElementById("mw-zoom-level");
  const viewport = document.getElementById("map-viewport");
  const canvasContainer = document.getElementById("map-canvas-container");
  const imageEl = document.getElementById("active-map-image");
  const markersLayer = document.getElementById("map-markers-layer");
  const emptyStateEl = document.getElementById("mw-empty-state");
  const uploadNameInput = document.getElementById("mw-upload-name-input");
  const uploadBtn = document.getElementById("mw-upload-btn");
  const fileInput = document.getElementById("mw-file-input");
  const uploadStatusEl = document.getElementById("mw-upload-status");
  const chooseFolderBtn = document.getElementById("mw-choose-folder-btn");
  const reconnectFolderBtn = document.getElementById("mw-reconnect-folder-btn");
  const folderStatusEl = document.getElementById("mw-folder-status");
  const folderReconnectBanner = document.getElementById("mw-folder-reconnect-banner");
  const reconnectBannerBtn = document.getElementById("mw-reconnect-banner-btn");
  const saveImageBtn = document.getElementById("mw-save-image-btn");
  const saveStatusEl = document.getElementById("mw-save-status");
  const exportDataBtn = document.getElementById("mw-export-data-btn");
  const exportDataStatusEl = document.getElementById("mw-export-data-status");
  const exportLocalCheckbox = document.getElementById("mw-export-local-checkbox");
  const exportDriveCheckbox = document.getElementById("mw-export-drive-checkbox");
  const exportDriveCheckWrap = document.getElementById("mw-export-drive-check-wrap");
  const exportDriveFolderRow = document.getElementById("mw-export-drive-folder-row");
  const exportDriveFolderSelect = document.getElementById("mw-export-drive-folder-select");
  const importDiskBtn = document.getElementById("mw-import-disk-btn");
  const importFilesInput = document.getElementById("mw-import-files-input");
  const importDriveBtn = document.getElementById("mw-import-drive-btn");
  const importDriveBrowseBtn = document.getElementById("mw-import-drive-browse-btn");
  const importDriveSelect = document.getElementById("mw-import-drive-select");
  const importDriveConfirmBtn = document.getElementById("mw-import-drive-confirm-btn");
  const importStatusEl = document.getElementById("mw-import-status");
  const deleteMapBtn = document.getElementById("mw-delete-map-btn");
  const tableContainer = document.getElementById("table-container");
  const pathsBtn = document.getElementById("mw-paths-btn");
  const pathsPanel = document.getElementById("mw-paths-panel");
  const drawPathBtn = document.getElementById("mw-draw-path-btn");
  const draftColorBtn = document.getElementById("mw-draft-color-btn");
  const drawHintEl = document.getElementById("mw-draw-hint");
  const pathsListEl = document.getElementById("mw-paths-list");
  const pathsEmptyEl = document.getElementById("mw-paths-empty");
  const pathsSvg = document.getElementById("map-paths-layer");
  const symbolsBtn = document.getElementById("mw-symbols-btn");
  const symbolsPanel = document.getElementById("mw-symbols-panel");
  const placeSymbolBtn = document.getElementById("mw-place-symbol-btn");
  const symbolHintEl = document.getElementById("mw-symbol-hint");
  const symbolsListEl = document.getElementById("mw-symbols-list");
  const symbolsEmptyEl = document.getElementById("mw-symbols-empty");
  const symbolsLayer = document.getElementById("map-symbols-layer");
  const mapSearchWrap = document.getElementById("mw-map-search-wrap");
  const mapSearchInput = document.getElementById("mw-map-search-input");
  const mapSearchClearBtn = document.getElementById("mw-map-search-clear");
  const mapSearchResultsEl = document.getElementById("mw-map-search-results");
  const fitWindowBtn = document.getElementById("mw-fit-window-btn");
  const fitImageBtn = document.getElementById("mw-fit-image-btn");
  const ratioPresetsRow = document.getElementById("mw-ratio-presets");
  const ratioPresetBtns = Array.from(document.querySelectorAll(".mw-ratio-preset-btn"));
  const resizeHandle = document.getElementById("mw-resize-handle");
  const resizeTooltip = document.getElementById("mw-resize-tooltip");
  const toolbarEl = document.querySelector(".mw-toolbar");
  const toolbarHideToggle = document.getElementById("mw-toolbar-hide-toggle");
  const toolbarMoveToggle = document.getElementById("mw-toolbar-move-toggle");
  const toolbarSettingsSlot = document.getElementById("mw-toolbar-settings-slot");
  const headerEl = document.querySelector(".mw-header");
  const headerSizeBtns = Array.from(document.querySelectorAll("[data-header-size]"));
  const headerSizeHintEl = document.getElementById("mw-header-size-hint");
  const minimalHeaderToggle = document.getElementById("mw-minimal-header-toggle");
  const settingsCloseBtn = document.getElementById("mw-settings-close-btn");
  // Where the toolbar lives by default (between the header and the options
  // panel) — captured once up front so "Move Toolbar into Settings" can put
  // it back exactly where it came from when switched off again.
  const toolbarHomeParent = toolbarEl ? toolbarEl.parentNode : null;
  const toolbarHomeNextSibling = toolbarEl ? toolbarEl.nextSibling : null;

  let isMapWindowActive = false;
  let currentObjectUrl = null; // revoked whenever we switch/clear the active image

  // ---- Paths (routes) state — see the PATHS block below for the logic ----
  let isDrawing = false;
  let draftPoints = [];
  let draftColor = "";
  let rubberPoint = null;
  let selectedPathId = null;
  let editingPathId = null; // the ONE path (if any) currently unlocked for vertex drag/insert/delete/symbol edits
  let draggingVertex = null; // { pathId, index }
  let vertexDragMoved = false; // distinguishes a plain vertex click (open symbol picker) from a drag
  let draftColorOverride = null; // set by the spectrum wheel; falls back to auto-cycling PATH_COLORS
  let lastPanMoved = false; // guards the viewport "click" handler against drag-end clicks

  // ---- Standalone symbol markers state — see the SYMBOL MARKERS block ----
  let pendingPlaceSymbol = null; // an icon queued via "📍 Place Symbol"; the next map click drops it there
  let editingSymbolId = null; // the ONE symbol marker (if any) unlocked for dragging/re-picking
  let draggingSymbolMarker = null; // { id }
  let symbolMarkerDragMoved = false; // distinguishes a plain marker click (open picker) from a drag

  // ---- Map search — see the MAP SEARCH block below ----
  let mapSearchGlowPathId = null; // path id currently glowing (rendered by renderPaths itself)
  let mapSearchGlowSymbolId = null; // symbol marker id currently glowing (rendered by renderSymbols itself)
  let mapSearchGlowColor = null; // the glowing symbol's own colour, resolved async from its artwork — null while unresolved (CSS fallback covers that gap)
  let mapSearchGlowTimer = null; // auto-clears a glow after a few seconds
  let mapSearchActiveIndex = -1; // keyboard-highlighted row in the results dropdown
  let mapSearchLastResults = []; // the results the dropdown currently shows

  /* ----------------------------------------------------------------------
     FIT MODE — decides how #map-canvas-container (and so the map image
     inside it) is sized/positioned within #map-viewport at scale 1.

     Everything downstream — pan clamping, click→percent conversion,
     marker/path/symbol placement — is expressed in terms of this
     "content box" (contentLeft/Top/W/H below) rather than the
     viewport's own box, so a marker's xPercent/yPercent is always a
     percentage of the actual, undistorted map image — stable no matter
     how the window is resized or which fit mode is active. That's the
     fix for markers drifting/misaligning when the window shape changes.

       "window" — cover-style: the content box fills the viewport
         edge-to-edge in whichever dimension is the tighter fit, and
         overflows (deliberately) in the other — pan/zoom, which already
         operates on this same box, is what reaches the overflow. Unlike
         plain CSS object-fit:cover, the overflowing part is real DOM
         content, not a crop, so nothing is ever unreachable.
       "image" — contain-style: the content box fits entirely inside the
         viewport. In this mode #map-viewport itself is resized (see
         applyViewportSizing) to the target ratio first, so in the
         common case (target ratio = image's own ratio) the content box
         ends up exactly matching the viewport, edge-to-edge, no
         letterboxing. Letterboxing only shows up if someone drags the
         resize handle to a ratio that doesn't match the image — which
         is expected, since we still never crop or stretch the source.
  ---------------------------------------------------------------------- */
  let mapFitMode = (function loadFitMode() {
    try {
      return localStorage.getItem(MW_FIT_MODE_STORAGE) === "image" ? "image" : "window";
    } catch {
      return "window";
    }
  })();
  let contentLeft = 0;
  let contentTop = 0;
  let contentW = 0;
  let contentH = 0;

  function currentImageAspect() {
    return imageEl.naturalWidth && imageEl.naturalHeight
      ? imageEl.naturalWidth / imageEl.naturalHeight
      : null;
  }

  // The aspect ratio "image" fit mode targets for the active map: a
  // custom one the person dragged in, or the image's own ratio by
  // default.
  function currentTargetRatio() {
    const custom = activeMapId ? customRatioByMap[activeMapId] : null;
    if (custom && isFinite(custom) && custom > 0) return custom;
    return currentImageAspect() || 16 / 9;
  }

  function hasCustomRatio() {
    return !!(activeMapId && customRatioByMap[activeMapId]);
  }

  // In "image" mode, #map-viewport's CSS height is driven by JS to match
  // the target ratio at the viewport's current (responsive) width. In
  // "window" mode it reverts to the CSS default (see .map-viewport).
  function applyViewportSizing() {
    if (mapFitMode !== "image") {
      viewport.style.height = "";
      return;
    }
    const w = viewport.clientWidth || 1;
    const ratio = currentTargetRatio();
    const h = Math.min(MW_VIEWPORT_MAX_HEIGHT, Math.max(MW_VIEWPORT_MIN_HEIGHT, Math.round(w / ratio)));
    viewport.style.height = `${h}px`;
  }

  // Computes the content box (see block comment above) for the given
  // viewport size + image aspect + fit mode, then applies it to
  // #map-canvas-container as explicit pixel left/top/width/height —
  // overriding the CSS inset:0/100% fallback that's only there so the
  // element isn't zero-sized before JS first runs.
  function recomputeContentBox() {
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const imgAspect = currentImageAspect() || vw / vh;
    const viewportAspect = vw / vh;

    let left, top, width, height;
    const wider = imgAspect > viewportAspect; // image is relatively wider than the viewport box
    if (mapFitMode === "window") {
      // COVER: fill the tighter dimension, overflow the other.
      if (wider) {
        height = vh;
        width = height * imgAspect;
        top = 0;
        left = (vw - width) / 2;
      } else {
        width = vw;
        height = width / imgAspect;
        left = 0;
        top = (vh - height) / 2;
      }
    } else {
      // CONTAIN: fit entirely inside, no overflow (letterbox instead,
      // only visible when the viewport's own ratio — set by
      // applyViewportSizing — doesn't match the image).
      if (wider) {
        width = vw;
        height = width / imgAspect;
        left = 0;
        top = (vh - height) / 2;
      } else {
        height = vh;
        width = height * imgAspect;
        top = 0;
        left = (vw - width) / 2;
      }
    }

    contentLeft = left;
    contentTop = top;
    contentW = width;
    contentH = height;

    canvasContainer.style.left = `${left}px`;
    canvasContainer.style.top = `${top}px`;
    canvasContainer.style.right = "auto";
    canvasContainer.style.bottom = "auto";
    canvasContainer.style.width = `${width}px`;
    canvasContainer.style.height = `${height}px`;
  }

  // Single entry point for anything that can change the content box:
  // switching maps/images, toggling fit mode, dragging the resize
  // handle, resetting the ratio, or the browser window resizing.
  function refreshMapLayout() {
    applyViewportSizing();
    recomputeContentBox();
    const clamped = clampTranslate(tx, ty, scale);
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();
    if (activeMapId) renderPaths();
  }

  function formatRatio(ratio) {
    const knownRatios = [
      { label: "1:1", value: 1 },
      { label: "4:3", value: 4 / 3 },
      { label: "3:2", value: 3 / 2 },
      { label: "16:9", value: 16 / 9 },
      { label: "3:4", value: 3 / 4 },
      { label: "2:3", value: 2 / 3 },
      { label: "9:16", value: 9 / 16 },
    ];
    const match = knownRatios.find((r) => Math.abs(r.value - ratio) < 0.015);
    return match ? match.label : `${ratio.toFixed(2)}:1`;
  }

  function updateRatioPresetActiveState() {
    const custom = hasCustomRatio();
    const target = currentTargetRatio();
    ratioPresetBtns.forEach((btn) => {
      const val = btn.dataset.ratio;
      if (val === "auto") {
        btn.classList.toggle("active", !custom);
        return;
      }
      const ratio = parseFloat(val);
      btn.classList.toggle("active", custom && Math.abs(target - ratio) < 0.01);
    });
  }

  function updateFitModeUI() {
    fitWindowBtn?.classList.toggle("active", mapFitMode === "window");
    fitWindowBtn?.setAttribute("aria-pressed", String(mapFitMode === "window"));
    fitImageBtn?.classList.toggle("active", mapFitMode === "image");
    fitImageBtn?.setAttribute("aria-pressed", String(mapFitMode === "image"));
    resizeHandle?.classList.toggle("hidden", mapFitMode !== "image");
    ratioPresetsRow?.classList.toggle("hidden", mapFitMode !== "image");
    updateRatioPresetActiveState();
  }

  function setFitMode(mode) {
    if (mode !== "window" && mode !== "image") return;
    if (mapFitMode === mode) return;
    mapFitMode = mode;
    try {
      localStorage.setItem(MW_FIT_MODE_STORAGE, mapFitMode);
    } catch {
      /* non-fatal */
    }
    updateFitModeUI();
    refreshMapLayout();
  }

  function resetCustomRatio() {
    if (!activeMapId || !customRatioByMap[activeMapId]) return;
    delete customRatioByMap[activeMapId];
    saveJson(MW_ASPECT_STORAGE, customRatioByMap);
    updateFitModeUI();
    refreshMapLayout();
  }

  fitWindowBtn?.addEventListener("click", () => setFitMode("window"));
  fitImageBtn?.addEventListener("click", () => setFitMode("image"));

  ratioPresetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (mapFitMode !== "image") setFitMode("image");
      const val = btn.dataset.ratio;
      if (val === "auto") {
        resetCustomRatio();
        return;
      }
      const ratio = parseFloat(val);
      if (!activeMapId || !isFinite(ratio) || ratio <= 0) return;
      customRatioByMap[activeMapId] = ratio;
      saveJson(MW_ASPECT_STORAGE, customRatioByMap);
      updateFitModeUI();
      refreshMapLayout();
    });
  });

  // ---- Drag-to-resize handle (Image fit mode only) — a single corner
  // grip, like resizing a native app window: dragging horizontally sets
  // the floating window's WIDTH, dragging vertically sets the map
  // viewport's HEIGHT, and together they define the aspect ratio. Uses
  // Pointer Events (not separate mouse/touch listeners) so mouse,
  // trackpad, touch, and pen all drag it identically. A small tooltip
  // shows the live size while dragging; releasing persists both the
  // window width (global) and the ratio (per map). ----
  (function initResizeHandle() {
    if (!resizeHandle) return;
    let resizing = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    function maxAllowedWidth() {
      return Math.min(MW_WINDOW_MAX_WIDTH, window.innerWidth - 32);
    }

    function showTooltip(w, h) {
      if (!resizeTooltip) return;
      resizeTooltip.textContent = `${Math.round(w)} × ${Math.round(h)}  ·  ${formatRatio(w / h)}`;
      resizeTooltip.classList.remove("hidden");
    }

    function hideTooltip() {
      resizeTooltip?.classList.add("hidden");
    }

    resizeHandle.addEventListener("pointerdown", (e) => {
      if (mapFitMode !== "image") return;
      resizing = true;
      pointerId = e.pointerId;
      try {
        resizeHandle.setPointerCapture(pointerId);
      } catch {
        /* non-fatal */
      }
      startX = e.clientX;
      startY = e.clientY;
      startWidth = win.offsetWidth;
      startHeight = viewport.clientHeight;
      resizeHandle.classList.add("mw-resizing");
      showTooltip(startWidth, startHeight);
      e.preventDefault();
      e.stopPropagation();
    });

    resizeHandle.addEventListener("pointermove", (e) => {
      if (!resizing || e.pointerId !== pointerId) return;
      const nextWidth = Math.min(
        maxAllowedWidth(),
        Math.max(MW_WINDOW_MIN_WIDTH, startWidth + (e.clientX - startX))
      );
      const nextHeight = Math.min(
        MW_VIEWPORT_MAX_HEIGHT,
        Math.max(MW_VIEWPORT_MIN_HEIGHT, startHeight + (e.clientY - startY))
      );
      win.style.width = `${nextWidth}px`;
      viewport.style.height = `${nextHeight}px`;
      if (activeMapId) customRatioByMap[activeMapId] = nextWidth / nextHeight;
      recomputeContentBox();
      const clamped = clampTranslate(tx, ty, scale);
      tx = clamped.tx;
      ty = clamped.ty;
      applyTransform();
      renderPaths();
      showTooltip(nextWidth, nextHeight);
    });

    function endResize(e) {
      if (!resizing || (e && e.pointerId !== pointerId)) return;
      resizing = false;
      resizeHandle.classList.remove("mw-resizing");
      hideTooltip();
      try {
        resizeHandle.releasePointerCapture(pointerId);
      } catch {
        /* non-fatal */
      }
      pointerId = null;
      try {
        localStorage.setItem(MW_WINDOW_WIDTH_STORAGE, String(win.offsetWidth));
      } catch {
        /* non-fatal */
      }
      if (activeMapId) saveJson(MW_ASPECT_STORAGE, customRatioByMap);
      updateFitModeUI();
    }

    resizeHandle.addEventListener("pointerup", endResize);
    resizeHandle.addEventListener("pointercancel", endResize);
  })();

  // The image's natural dimensions aren't known until it actually
  // decodes, so setActiveMap()'s resetView() call (which fires right
  // after imageEl.src is assigned, before load completes) necessarily
  // lays out against the *previous* image for a moment — this listener
  // re-lays-out the instant the real dimensions are in.
  imageEl.addEventListener("load", () => {
    refreshMapLayout();
  });

  /* ----------------------------------------------------------------------
     FEATURE 1 — PAN & ZOOM
  ---------------------------------------------------------------------- */
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  // Clamps translate so the content box (contentLeft/Top/W/H, at the
  // given scale) never leaves a gap inside the viewport — generalises
  // the old "canvas-container always equals the viewport" assumption to
  // a content box that can be offset/larger/smaller than the viewport,
  // depending on fit mode. See the FIT MODE block above.
  function clampTranslate(nextTx, nextTy, nextScale) {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    const minTx = (w - contentW * nextScale) - contentLeft;
    const maxTx = -contentLeft;
    const minTy = (h - contentH * nextScale) - contentTop;
    const maxTy = -contentTop;
    return {
      tx: Math.min(maxTx, Math.max(minTx, nextTx)),
      ty: Math.min(maxTy, Math.max(minTy, nextTy)),
    };
  }

  // Computes a clamped (tx,ty) that centers the given content-local
  // point (in un-scaled px, within the 0..contentW/0..contentH box) in
  // the viewport at targetScale. Shared by focusOnPath() and
  // centerOnEntry() — the only two places that need to "fly to" a
  // specific spot on the map.
  function computeCenterTranslate(contentXLocal, contentYLocal, targetScale) {
    const rect = viewport.getBoundingClientRect();
    const rawTx = rect.width / 2 - contentXLocal * targetScale - contentLeft;
    const rawTy = rect.height / 2 - contentYLocal * targetScale - contentTop;
    return clampTranslate(rawTx, rawTy, targetScale);
  }

  // Keeps every arrowhead pinned to its path's end at a constant ON-SCREEN
  // size as the zoom changes. Each arrowhead <path> carries its anchor
  // point, heading, and base size as data-* attributes (set once in
  // renderPaths()); this just recomputes its `transform` attribute against
  // the live `scale`. Plain attribute update on a normally-rendered
  // element — no <marker>/CSS-custom-property involved — so it reliably
  // repaints every time, and it's cheap enough to run on every pan/zoom
  // tick alongside applyTransform() without a full renderPaths().
  function updateArrowheadTransform(el) {
    const ax = parseFloat(el.dataset.mwAx);
    const ay = parseFloat(el.dataset.mwAy);
    const angle = parseFloat(el.dataset.mwAngle);
    const size = parseFloat(el.dataset.mwSize);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(size)) return;
    const k = size / 14 / (scale || 1);
    el.setAttribute("transform", `translate(${ax} ${ay}) rotate(${angle}) scale(${k})`);
  }

  function syncArrowheadScale() {
    if (!pathsSvg) return;
    pathsSvg.querySelectorAll(".mw-path-arrowhead").forEach(updateArrowheadTransform);
  }

  // See the `.mw-zoom-live` rule in map-window.css for the full story:
  // `will-change: transform` is only ever applied while a zoom/pan
  // gesture is actually in flight. We add the class here on every
  // transform tick and clear it a beat after the ticks stop, which
  // tears down the GPU compositing layer and makes the browser
  // re-rasterize the map image, SVG paths, and symbol markers crisply
  // at whatever scale things settled on — instead of leaving a
  // stretched, blurry texture behind (the bug that previously only
  // "fixed itself" by closing and reopening the window).
  let zoomIdleTimer = null;
  const ZOOM_IDLE_MS = 120;

  function applyTransform() {
    canvasContainer.classList.add("mw-zoom-live");
    clearTimeout(zoomIdleTimer);
    zoomIdleTimer = setTimeout(() => {
      canvasContainer.classList.remove("mw-zoom-live");
    }, ZOOM_IDLE_MS);

    canvasContainer.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // Mirrors `scale` into a CSS variable so the path-drawing layer's
    // stylesheet (map-window.css) can counter-scale line thickness and
    // vertex-handle size against it on every pan/zoom tick, without a
    // full renderPaths() call — see the PATHS block in that file.
    canvasContainer.style.setProperty("--mw-zoom", String(scale));
    syncArrowheadScale();
    if (zoomLevelEl) zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
    viewport.classList.toggle("mw-can-pan", scale > MIN_SCALE || contentW * scale > viewport.clientWidth + 1 || contentH * scale > viewport.clientHeight + 1);
  }

  // Zooms to `nextScale`, keeping the content point currently under
  // (anchorX, anchorY) — viewport-relative pixels — fixed on screen.
  function zoomTo(nextScale, anchorX, anchorY) {
    const clamped = clampScale(nextScale);
    if (clamped === scale) return;
    const contentX = (anchorX - contentLeft - tx) / scale;
    const contentY = (anchorY - contentTop - ty) / scale;
    const rawTx = anchorX - contentLeft - contentX * clamped;
    const rawTy = anchorY - contentTop - contentY * clamped;
    const clampedTranslate = clampTranslate(rawTx, rawTy, clamped);
    scale = clamped;
    tx = clampedTranslate.tx;
    ty = clampedTranslate.ty;
    applyTransform();
  }

  function stepZoom(direction) {
    const rect = viewport.getBoundingClientRect();
    zoomTo(scale + direction * ZOOM_STEP, rect.width / 2, rect.height / 2);
  }

  function resetView() {
    scale = 1;
    tx = 0;
    ty = 0;
    refreshMapLayout();
  }

  zoomInBtn?.addEventListener("click", () => stepZoom(1));
  zoomOutBtn?.addEventListener("click", () => stepZoom(-1));
  zoomResetBtn?.addEventListener("click", resetView);

  viewport?.addEventListener(
    "wheel",
    (e) => {
      if (!imageEl.getAttribute("src")) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const anchorY = e.clientY - rect.top;
      const factor = 1 - e.deltaY * WHEEL_ZOOM_SENSITIVITY;
      zoomTo(scale * factor, anchorX, anchorY);
    },
    { passive: false }
  );

  // ---- Drag pan (over the viewport, ignoring marker/button clicks) ----
  (function initPan() {
    let panning = false;
    let startClientX = 0;
    let startClientY = 0;
    let startTx = 0;
    let startTy = 0;

    viewport?.addEventListener("mousedown", (e) => {
      lastPanMoved = false;
      // NOTE: pendingPlaceSymbol deliberately does NOT block panning here
      // (unlike isDrawing). Placement mode is exactly when you're most
      // likely to be zoomed in tight hunting for a precise "micro" spot,
      // so you need to be able to drag the view to reach it before you
      // click to drop the symbol. This is safe: the viewport "click"
      // handler below already checks lastPanMoved and skips placement
      // when the mousedown turned into a real drag, so a genuine pan
      // never places a symbol — only a plain, un-dragged click does.
      if (isDrawing) return;
      if (e.target.closest(".map-marker") || e.target.closest("button")) return;
      if (e.target.closest(".mw-path-vertex") || e.target.closest(".mw-path-hit")) return;
      if (!imageEl.getAttribute("src")) return;
      panning = true;
      startClientX = e.clientX;
      startClientY = e.clientY;
      startTx = tx;
      startTy = ty;
      viewport.classList.add("mw-panning");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!panning) return;
      if (Math.abs(e.clientX - startClientX) > 3 || Math.abs(e.clientY - startClientY) > 3) lastPanMoved = true;
      const rawTx = startTx + (e.clientX - startClientX);
      const rawTy = startTy + (e.clientY - startClientY);
      const clamped = clampTranslate(rawTx, rawTy, scale);
      tx = clamped.tx;
      ty = clamped.ty;
      applyTransform();
    });

    window.addEventListener("mouseup", () => {
      if (!panning) return;
      panning = false;
      viewport.classList.remove("mw-panning");
    });
  })();

  // Re-layout on resize: re-clamps pan so a shrunk viewport can't leave
  // the map stranded off-screen, and — in "image" fit mode — recomputes
  // the viewport's height so it keeps tracking the target aspect ratio
  // as the window's (responsive) width changes.
  window.addEventListener("resize", refreshMapLayout);

  /* ----------------------------------------------------------------------
     MARKERS (Feature 2 rendering + Feature 2/3 interaction)
  ---------------------------------------------------------------------- */
  function renderMarkers() {
    markersLayer.innerHTML = "";
    if (!activeMapId) return;
    markersFor(activeMapId).forEach((marker) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "map-marker";
      pin.style.left = `${marker.xPercent}%`;
      pin.style.top = `${marker.yPercent}%`;
      pin.dataset.markerId = marker.id;
      pin.title = marker.label || marker.word;
      pin.innerHTML = `<span class="map-marker-dot"></span><span class="map-marker-label">${escapeHtml(marker.label || marker.word)}</span>`;
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        highlightEntryRow(marker.entryId);
      });
      markersLayer.appendChild(pin);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }

  /* ----------------------------------------------------------------------
     RICH SYMBOL RENDERING — every symbol on the map (picker buttons,
     standalone pinned icons, path-point icons, list-row swatches) is
     drawn as a real Twemoji SVG image rather than the raw Unicode
     character. Two problems that fixes at once:

     1. Cross-platform look: a bare Unicode emoji renders using whatever
        font the visitor's OS happens to ship — on many Windows/Linux
        setups that's a flat, low-detail, sometimes monochrome font, and
        country flags in particular often fall back to two boxed
        capital letters ("US", "FR"...) instead of an actual flag,
        because plenty of systems/browsers still don't ship real flag
        glyphs (that's literally what a pair of "regional indicator"
        code points looks like without a font that ligatures them into
        a flag). A Twemoji image is the same rich, full-colour artwork
        everywhere, flags included.
     2. The old "big number" bug: the path-point icons used to be
        plain SVG <text> with a CSS `stroke` on it (for a white halo
        behind the glyph). Stroking a colour/multi-layer emoji glyph is
        exactly the case browsers can't handle — since a stroked font
        run is drawn path-by-path rather than as the pre-rendered
        colour glyph, Chrome/Blink silently falls back to rendering the
        character's raw Unicode CODE POINT NUMBER instead of the emoji
        (e.g. "128754" instead of 🏰). Swapping every rendering path
        over to an <img>/SVG <image> sidesteps that failure mode
        entirely — there's no font glyph being stroked any more.

     twemoji.parse() does the hard part correctly (it has its own
     regex/lookup table for turning any valid emoji sequence — multi-
     codepoint ZWJ professions, flag pairs, skin tones, keycaps... —
     into the right asset filename), so this leans on the real library
     rather than hand-rolling codepoint math that would silently break
     on exactly the multi-part sequences (flags, ZWJ professions) this
     redesign cares most about.

     RESILIENCE: this page already trusts cdnjs.cloudflare.com (the
     jsPDF <script> tag above loads from it), so that's the PRIMARY
     source — most likely to already be allowed through by whatever
     network/CSP this page runs behind. jsDelivr is a second, backup
     source, tried automatically (per image, via onerror) only if the
     primary one is blocked or a given asset 404s there. If every
     source fails, or the twemoji library itself never loaded, each
     symbol quietly degrades to the plain Unicode character rather
     than a broken-image icon — same as before this redesign, never
     worse.
  ---------------------------------------------------------------------- */
  const MW_TWEMOJI_SOURCES = [
    { base: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/", folder: "svg", ext: ".svg" },
    { base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/", folder: "svg", ext: ".svg" },
  ];

  function mwTwemojiReady() {
    return !!(window.twemoji && window.twemoji.parse);
  }

  // Resolves `emoji` to its Twemoji asset code point (e.g. "1f3f0" or
  // "1f1e8-1f1f3" for a flag pair) using the real library's own
  // matching/lookup, so multi-part sequences (flags, ZWJ professions,
  // skin tones) come out correct. Returns null if unresolved.
  function mwEmojiCodepoint(emoji) {
    if (!emoji || !mwTwemojiReady()) return null;
    let icon = null;
    try {
      window.twemoji.parse(emoji, {
        callback(ic) {
          icon = ic;
          return false; // we only want the code point, not a replacement
        },
      });
    } catch (err) {
      return null;
    }
    return icon;
  }

  /* ---- Flag-specific image source (flagcdn.com) -----------------------
     Country/region flag emoji are exactly the case most likely to still
     come out wrong even with Twemoji in the mix: they're two "regional
     indicator" letters glued together, and if the Twemoji CDN is ever
     blocked/slow, the ONLY thing left is the raw font glyph — which on
     Windows and plenty of Linux setups isn't a flag ligature at all, just
     the two boxed capital letters ("US", "FR") that look like a spelled-
     out code instead of a flag. flagcdn.com is a dedicated flag-image
     host (no emoji-font/codepoint matching involved), so it's used as the
     FIRST candidate for anything flag-shaped, ahead of Twemoji, for extra
     redundancy — not instead of it. Everything else about the fallback
     chain (progressive retry, eventual plain-glyph fallback) is
     unchanged.
  ------------------------------------------------------------------------ */
  // The three "subdivision" flags in the library (England/Scotland/Wales)
  // aren't two regional-indicator letters — they're U+1F3F4 plus a run of
  // invisible "tag" characters — so they can't be decoded generically and
  // are just listed here against flagcdn's subdivision codes.
  const MW_FLAG_TAG_CODES = {
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}": "gb-eng", // England
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}": "gb-sct", // Scotland
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}": "gb-wls", // Wales
  };
  // A regular country flag is exactly two "regional indicator symbol"
  // code points (U+1F1E6–U+1F1FF, one per A–Z); flagcdn's country codes
  // are just those two letters, lower-cased (and this happens to also
  // fall out correctly for 🇪🇺 → "eu"). Returns null for anything that
  // isn't flag-shaped, so this never misfires on a non-flag symbol.
  function mwFlagCode(emoji) {
    if (!emoji) return null;
    if (MW_FLAG_TAG_CODES[emoji]) return MW_FLAG_TAG_CODES[emoji];
    const chars = Array.from(emoji);
    if (chars.length !== 2) return null;
    const points = chars.map((ch) => ch.codePointAt(0));
    if (points.some((cp) => cp < 0x1f1e6 || cp > 0x1f1ff)) return null;
    return points.map((cp) => String.fromCharCode(cp - 0x1f1e6 + 65)).join("").toLowerCase();
  }
  function mwFlagImgUrl(emoji) {
    const code = mwFlagCode(emoji);
    return code ? `https://flagcdn.com/w160/${code}.png` : null;
  }

  // Custom, hand-authored artwork (currently the "ASOIAF Main Structures"
  // group in map-symbols-data.js) is stored directly as a
  // data:image/svg+xml symbol string rather than a Unicode character —
  // there's no codepoint to resolve, so it's detected up front and
  // short-circuits straight past the flag/Twemoji lookups below (which
  // would otherwise waste a regex pass over a multi-KB string and,
  // for mwFlagCode, could never match anyway).
  function mwIsCustomSvgSymbol(emoji) {
    return typeof emoji === "string" && emoji.startsWith("data:image/svg+xml");
  }

  // All candidate asset URLs for `emoji`, in try-order, or null. Real
  // flag artwork (if any) leads; the Twemoji chain follows as backup(s).
  function mwEmojiUrls(emoji) {
    if (mwIsCustomSvgSymbol(emoji)) return [emoji];
    const flagUrl = mwFlagImgUrl(emoji);
    const cp = mwEmojiCodepoint(emoji);
    const twemojiUrls = cp ? MW_TWEMOJI_SOURCES.map((src) => `${src.base}${src.folder}/${cp}${src.ext}`) : [];
    const all = flagUrl ? [flagUrl, ...twemojiUrls] : twemojiUrls;
    return all.length ? all : null;
  }

  // Global (reachable from inline onerror="" attributes, since this
  // whole file is wrapped in an IIFE): when an <img class="mw-emoji-img">
  // fails to load, advance to the next candidate URL stashed on it, and
  // if none are left, replace it with the plain glyph as a last resort.
  window.mwEmojiOnError = function (img) {
    try {
      const raw = img.getAttribute("data-mw-fallback-urls");
      const backups = raw ? JSON.parse(raw) : [];
      if (backups.length) {
        const next = backups.shift();
        img.setAttribute("data-mw-fallback-urls", JSON.stringify(backups));
        img.src = next;
        return;
      }
    } catch (err) {
      /* fall through to the plain-glyph fallback below */
    }
    const emoji = img.getAttribute("data-mw-emoji") || "";
    const span = document.createElement("span");
    span.className = `${img.className} mw-emoji-fallback`;
    // A custom SVG data URI has no plain-glyph equivalent — falling back
    // to its raw text would dump several KB of markup onto the page, so
    // it gets a generic placeholder instead. Everything else (real
    // Unicode emoji) still falls back to the plain character as before.
    span.textContent = mwIsCustomSvgSymbol(emoji) ? "🏰" : emoji;
    img.replaceWith(span);
  };

  // HTML string for a rich symbol icon. Falls back to the plain
  // (escaped) character immediately if Twemoji hasn't loaded at all,
  // and to progressively-tried backup CDNs (then the plain character)
  // if the image itself fails to load — see mwEmojiOnError above.
  function mwEmojiImgHtml(emoji, extraClass) {
    const cls = `mw-emoji-img${extraClass ? " " + extraClass : ""}`;
    const urls = mwEmojiUrls(emoji);
    if (!urls || !urls.length) return `<span class="${cls} mw-emoji-fallback">${escapeHtml(emoji)}</span>`;
    const [primary, ...backups] = urls;
    return `<img class="${cls}" src="${primary}" data-mw-fallback-urls='${JSON.stringify(backups)}' data-mw-emoji="${escapeHtml(
      emoji
    )}" alt="${escapeHtml(emoji)}" draggable="false" loading="lazy" onerror="window.mwEmojiOnError(this)" />`;
  }

  function highlightEntryRow(entryId) {
    if (!entryId || !tableContainer) return;
    const row = tableContainer.querySelector(`tr[data-id="${CSS.escape(entryId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("mw-row-highlight");
    setTimeout(() => row.classList.remove("mw-row-highlight"), 1600);
  }

  /* ----------------------------------------------------------------------
     PATHS — draw & edit routes across the map, Google-Maps-style.

     A path is { id, label, color, visible, points: [{xPercent,yPercent}] }.
     Rendering happens entirely inside #map-paths-layer, an SVG sibling of
     the markers layer inside #map-canvas-container — so it inherits the
     same pan/zoom transform "for free". Its viewBox is set to the
     content box's real CSS-pixel size at render time (not a 0–100 box —
     see contentW/contentH in the FIT MODE block), so stroke widths and
     vertex circles stay circular/uniform regardless of the map image's
     aspect ratio.

     Interaction model:
       - Draw mode (toggled by #mw-draw-path-btn): click the map to drop
         points, with a dashed "rubber band" preview to the cursor.
         Double-click or Enter finishes the path (min 2 points); Esc
         cancels the whole draft.
       - Once saved, clicking a path selects it and reveals its vertices.
         Drag a vertex to move it; right-click a vertex to delete it
         (guarded so a path never drops below 2 points); click a
         selected path's line (away from a vertex) to insert a new point
         there, same as editing a route in Google Maps.
       - The panel list gives each path an inline color swatch, rename
         field, visibility toggle, "center on this path" button, and
         delete.
  ---------------------------------------------------------------------- */

  function nextPathColor() {
    const used = activeMapId ? pathsFor(activeMapId).length : 0;
    return PATH_COLORS[used % PATH_COLORS.length];
  }

  /* ---------- Spectrum colour-wheel popover ----------
     A small floating hue/saturation wheel (angle = hue, radius =
     saturation, fixed 50% lightness), matching the classic full-
     spectrum picker look — opened from the per-path swatch button and
     from the draft-color swatch above "Draw New Path". Only one
     instance is ever open at a time. */
  let colorWheelPopover = null;
  let colorWheelCleanup = null;

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  function closeColorWheel() {
    if (colorWheelCleanup) colorWheelCleanup();
    colorWheelCleanup = null;
    colorWheelPopover?.remove();
    colorWheelPopover = null;
  }

  // Opens the wheel anchored below (or above, if there's no room)
  // `anchorEl`, calling onPick(hex) live as the person drags/clicks.
  function openColorWheel(anchorEl, currentColor, onPick) {
    if (colorWheelPopover) {
      closeColorWheel();
      return; // treat a second click on the same trigger as toggling closed
    }

    const pop = document.createElement("div");
    pop.className = "mw-color-wheel-popover";
    pop.innerHTML = `
      <div class="mw-color-wheel"><div class="mw-color-wheel-cursor"></div></div>
      <div class="mw-color-wheel-preview"></div>
    `;
    document.body.appendChild(pop);
    colorWheelPopover = pop;

    const disc = pop.querySelector(".mw-color-wheel");
    const cursor = pop.querySelector(".mw-color-wheel-cursor");
    const preview = pop.querySelector(".mw-color-wheel-preview");
    preview.style.background = currentColor;

    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (top + popRect.height > window.innerHeight - 8) top = anchorRect.top - popRect.height - 8;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;

    function pickAt(clientX, clientY) {
      const r = disc.getBoundingClientRect();
      const radius = r.width / 2;
      let dx = clientX - (r.left + radius);
      let dy = clientY - (r.top + radius);
      const dist = Math.hypot(dx, dy);
      if (dist > radius) {
        dx = (dx / dist) * radius;
        dy = (dy / dist) * radius;
      }
      const clampedDist = Math.min(radius, dist);
      const hue = (((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360;
      const sat = Math.round((clampedDist / radius) * 100);
      const hex = hslToHex(hue, sat, 50);
      cursor.style.left = `${50 + (dx / radius) * 50}%`;
      cursor.style.top = `${50 + (dy / radius) * 50}%`;
      cursor.style.background = hex;
      preview.style.background = hex;
      onPick(hex);
    }

    let picking = false;
    function moveHandler(e) {
      if (picking) pickAt(e.clientX, e.clientY);
    }
    function upHandler() {
      picking = false;
    }
    disc.addEventListener("mousedown", (e) => {
      picking = true;
      pickAt(e.clientX, e.clientY);
      e.preventDefault();
    });
    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("mouseup", upHandler);

    function outsideClick(e) {
      if (!pop.contains(e.target) && e.target !== anchorEl) closeColorWheel();
    }
    function escHandler(e) {
      if (e.key === "Escape") closeColorWheel();
    }
    // Deferred so the click that opened the popover doesn't immediately
    // register as an "outside" click and close it again.
    setTimeout(() => document.addEventListener("mousedown", outsideClick), 0);
    document.addEventListener("keydown", escHandler);

    colorWheelCleanup = () => {
      window.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("mouseup", upHandler);
      document.removeEventListener("mousedown", outsideClick);
      document.removeEventListener("keydown", escHandler);
    };
  }

  function refreshDraftColorSwatch() {
    if (draftColorBtn) draftColorBtn.style.background = draftColorOverride || nextPathColor();
  }

  /* ----------------------------------------------------------------------
     SYMBOL PICKER — a popover (same anchored-positioning pattern as the
     color wheel above) offering 190+ grouped icons. Generic: it doesn't
     know whether it's stamping a path point or placing a standalone
     marker — callers pass the symbol currently in effect (if any) and an
     onPick(symbolOrNull) callback that does the actual assigning/saving.
     Two callers: the vertex click handler (path points) further down,
     and the standalone SYMBOL MARKERS block below.
  ---------------------------------------------------------------------- */
  let symbolPopover = null;
  let symbolPopoverCleanup = null;

  function closeSymbolPicker() {
    if (symbolPopoverCleanup) symbolPopoverCleanup();
    symbolPopoverCleanup = null;
    symbolPopover?.remove();
    symbolPopover = null;
  }

  function openSymbolPicker(anchorEl, currentSymbol, onPick, opts = {}) {
    closeSymbolPicker();
    const title = opts.title || "Pin a symbol to this point";
    const clearLabel = opts.clearLabel || "✖ No symbol";

    const pop = document.createElement("div");
    pop.className = "mw-symbol-picker-popover";
    pop.innerHTML = `
      <div class="mw-symbol-picker-head">
        <span>${escapeHtml(title)}</span>
        <button type="button" class="mw-symbol-clear-btn">${escapeHtml(clearLabel)}</button>
      </div>
      <div class="mw-symbol-search-row">
        <input type="text" class="mw-symbol-search-input" placeholder="🔎 Search ${SYMBOL_SEARCH_INDEX.length.toLocaleString()} symbols…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="mw-symbol-tabs"></div>
      <div class="mw-symbol-picker-body"></div>
    `;
    document.body.appendChild(pop);
    symbolPopover = pop;

    const searchInput = pop.querySelector(".mw-symbol-search-input");
    const tabsEl = pop.querySelector(".mw-symbol-tabs");
    const bodyEl = pop.querySelector(".mw-symbol-picker-body");
    // Snapshotted once per popover open (not re-derived on every render)
    // so the tab strip doesn't jump around under the user's cursor while
    // they're browsing it — it only picks up newly-recorded picks the
    // NEXT time the picker is opened.
    // `let`, not `const` — normally snapshotted for the life of the
    // popover (see comment above) so the tab strip doesn't reflow under
    // the cursor during ordinary picks, but an explicit ★/✖ action below
    // rebuilds it on the spot so the Favorites/Recent tab you're looking
    // at actually reflects the change you just made instead of waiting
    // for the next time the picker opens.
    let groups = symbolGroupsForPicker();
    let activeKey = groups[0].key;

    function renderTabs() {
      const query = searchInput.value.trim();
      tabsEl.classList.toggle("hidden", !!query);
      if (query) return;
      tabsEl.innerHTML = groups.map(
        (g) =>
          `<button type="button" class="mw-symbol-tab${g.key === activeKey ? " active" : ""}" data-key="${escapeHtml(g.key)}">${escapeHtml(g.label)}</button>`
      ).join("");
      tabsEl.querySelectorAll(".mw-symbol-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeKey = btn.dataset.key;
          renderTabs();
          renderBody();
        });
      });
    }

    // `removeCtx`, when set, is which live list the ✖ badge removes this
    // item from ("recent" or "favorites") — only shown on those two tabs,
    // since every other tab is a fixed library, not an editable list. The
    // ★ favorite-toggle badge is shown everywhere so a symbol can be
    // favorited (or unfavorited) from any tab, including search results.
    function iconButtonHtml(item, removeCtx) {
      const active = item.s === currentSymbol ? " active" : "";
      const fav = isFavoriteSymbol(item.s);
      const label = escapeHtml(item.n || symbolLabelFor(item.s));
      const removeBtn = removeCtx
        ? `<button type="button" class="mw-symbol-remove-btn" data-remove-ctx="${removeCtx}" data-symbol="${escapeHtml(item.s)}" title="${removeCtx === "favorites" ? "Remove from favorites" : "Remove from recent"}" aria-label="Remove">✖</button>`
        : "";
      return `<span class="mw-symbol-cell">
        <button type="button" class="mw-symbol-btn${active}" data-symbol="${escapeHtml(item.s)}" title="${label}">${mwEmojiImgHtml(item.s, "mw-symbol-btn-img")}</button>
        <button type="button" class="mw-symbol-fav-btn${fav ? " active" : ""}" data-symbol="${escapeHtml(item.s)}" title="${fav ? "Remove from favorites" : "Add to favorites"}" aria-label="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "★" : "☆"}</button>
        ${removeBtn}
      </span>`;
    }

    function renderBody() {
      const query = searchInput.value.trim().toLowerCase();
      let items, footNote = "";
      let removeCtx = null;
      if (query) {
        const matches = SYMBOL_SEARCH_INDEX.filter(
          (it) => it.n.toLowerCase().includes(query) || it.s === query
        );
        items = matches.slice(0, SYMBOL_RENDER_CAP);
        footNote =
          matches.length === 0
            ? `<div class="mw-symbol-empty">No symbols match "${escapeHtml(searchInput.value.trim())}"</div>`
            : matches.length > SYMBOL_RENDER_CAP
              ? `<div class="mw-symbol-count">Showing ${SYMBOL_RENDER_CAP} of ${matches.length} matches — keep typing to narrow it down</div>`
              : `<div class="mw-symbol-count">${matches.length} match${matches.length === 1 ? "" : "es"}</div>`;
      } else {
        const group = groups.find((g) => g.key === activeKey) || groups[0];
        if (group.key === "recent" || group.key === "favorites") removeCtx = group.key;
        items = group.symbols.slice(0, SYMBOL_RENDER_CAP);
        footNote =
          group.symbols.length > SYMBOL_RENDER_CAP
            ? `<div class="mw-symbol-count">Showing ${SYMBOL_RENDER_CAP} of ${group.symbols.length} in this category — search by name to find more</div>`
            : group.symbols.length === 0 && group.key === "favorites"
              ? `<div class="mw-symbol-empty">No favorites yet — tap ☆ on any symbol to add it here.</div>`
              : group.symbols.length === 0 && group.key === "recent"
                ? `<div class="mw-symbol-empty">Symbols you pick will show up here.</div>`
                : "";
      }
      bodyEl.innerHTML = `<div class="mw-symbol-grid">${items.map((it) => iconButtonHtml(it, removeCtx)).join("")}</div>${footNote}`;
      bodyEl.querySelectorAll(".mw-symbol-btn").forEach((btn) => {
        btn.addEventListener("click", () => pick(btn.dataset.symbol));
      });
      function refreshAfterListEdit() {
        groups = symbolGroupsForPicker();
        if (!groups.find((g) => g.key === activeKey)) activeKey = groups[0].key;
        renderTabs();
        renderBody();
      }
      bodyEl.querySelectorAll(".mw-symbol-fav-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleFavoriteSymbol(btn.dataset.symbol);
          refreshAfterListEdit();
        });
      });
      bodyEl.querySelectorAll(".mw-symbol-remove-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (btn.dataset.removeCtx === "favorites") removeFavoriteSymbol(btn.dataset.symbol);
          else removeRecentSymbol(btn.dataset.symbol);
          refreshAfterListEdit();
        });
      });
    }

    renderTabs();
    renderBody();
    searchInput.addEventListener("input", () => {
      renderTabs();
      renderBody();
    });

    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (top + popRect.height > window.innerHeight - 8) top = anchorRect.top - popRect.height - 8;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;

    function pick(symbol) {
      recordRecentSymbol(symbol);
      closeSymbolPicker();
      onPick(symbol || null);
    }
    pop.querySelector(".mw-symbol-clear-btn")?.addEventListener("click", () => pick(null));

    function outsideClick(e) {
      if (!pop.contains(e.target) && e.target !== anchorEl) closeSymbolPicker();
    }
    function escHandler(e) {
      if (e.key === "Escape") closeSymbolPicker();
    }
    setTimeout(() => document.addEventListener("mousedown", outsideClick), 0);
    document.addEventListener("keydown", escHandler);
    symbolPopoverCleanup = () => {
      document.removeEventListener("mousedown", outsideClick);
      document.removeEventListener("keydown", escHandler);
    };
    searchInput.focus();
  }

  draftColorBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    openColorWheel(draftColorBtn, draftColorOverride || nextPathColor(), (hex) => {
      draftColorOverride = hex;
      draftColorBtn.style.background = hex;
    });
  });

  // Converts a mouse event's viewport-relative client coordinates into a
  // map-content percentage, inverting the current pan/zoom transform —
  // the same math applied in reverse in centerOnEntry()/focusOnPath().
  function clientToPercent(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const contentX = (clientX - rect.left - contentLeft - tx) / scale;
    const contentY = (clientY - rect.top - contentTop - ty) / scale;
    return {
      xPercent: Math.min(100, Math.max(0, (contentX / contentW) * 100)),
      yPercent: Math.min(100, Math.max(0, (contentY / contentH) * 100)),
    };
  }

  function pointToSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function updateDrawHint() {
    if (!drawHintEl) return;
    const n = draftPoints.length;
    drawHintEl.textContent =
      n === 0
        ? "Click anywhere on the map to place your first point."
        : `${n} point${n === 1 ? "" : "s"} placed — click to continue, double-click or Enter to finish${n >= 2 ? " (Esc to cancel)" : " (need at least 2)"}.`;
  }

  function enterDrawMode() {
    if (!activeMapId) {
      if (drawHintEl) {
        drawHintEl.textContent = "Select or upload a map first.";
        drawHintEl.classList.remove("hidden");
      }
      return;
    }
    isDrawing = true;
    draftPoints = [];
    rubberPoint = null;
    selectedPathId = null;
    editingPathId = null;
    closeSymbolPicker();
    draftColor = draftColorOverride || nextPathColor();
    viewport.classList.add("mw-drawing");
    if (drawPathBtn) drawPathBtn.textContent = "✔️ Finish Path";
    drawHintEl?.classList.remove("hidden");
    updateDrawHint();
    renderPaths();
  }

  function exitDrawMode() {
    isDrawing = false;
    draftPoints = [];
    rubberPoint = null;
    viewport.classList.remove("mw-drawing");
    if (drawPathBtn) drawPathBtn.textContent = "✏️ Draw New Path";
    drawHintEl?.classList.add("hidden");
  }

  function cancelDrawing() {
    exitDrawMode();
    renderPaths();
  }

  function addDraftPoint(pt) {
    draftPoints.push(pt);
    updateDrawHint();
    renderPaths();
  }

  function finishDrawing() {
    // A double-click ending the path fires two "click" events before the
    // "dblclick", so the same spot has already been recorded twice —
    // drop the accidental duplicate.
    if (draftPoints.length >= 2) {
      const a = draftPoints[draftPoints.length - 1];
      const b = draftPoints[draftPoints.length - 2];
      if (Math.abs(a.xPercent - b.xPercent) < 0.4 && Math.abs(a.yPercent - b.yPercent) < 0.4) {
        draftPoints.pop();
      }
    }
    if (draftPoints.length < 2) {
      if (drawHintEl) drawHintEl.textContent = "Add at least 2 points before finishing.";
      return;
    }
    const path = {
      id: uuid(),
      label: `Path ${pathsFor(activeMapId).length + 1}`,
      color: draftColor,
      visible: true,
      points: draftPoints.slice(),
      labelScale: LABEL_SCALE_DEFAULT,
      // Paths never used to show their name on the map at all (only in
      // this panel and in search) — default new paths to that same
      // behavior; turning the on-map name on is opt-in via the 🏷️ toggle.
      labelHidden: true,
    };
    pathsFor(activeMapId).push(path);
    savePaths();
    selectedPathId = path.id;
    exitDrawMode();
    renderPaths();
    renderPathsList();
    refreshDraftColorSwatch();
    // Hand focus straight to the new path's name field so it's easy to
    // rename right away, while the moment (and the points) are fresh.
    requestAnimationFrame(() => {
      const input = pathsListEl?.querySelector(`[data-path-id="${CSS.escape(path.id)}"] .mw-path-name-input`);
      input?.focus();
      input?.select();
    });
  }

  function insertVertexAtClick(path, e) {
    const w = contentW;
    const h = contentH;
    const click = clientToPercent(e.clientX, e.clientY);
    const cx = (click.xPercent / 100) * w;
    const cy = (click.yPercent / 100) * h;
    let bestIdx = path.points.length - 1;
    let bestDist = Infinity;
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i];
      const b = path.points[i + 1];
      const dist = pointToSegmentDistance(
        cx, cy,
        (a.xPercent / 100) * w, (a.yPercent / 100) * h,
        (b.xPercent / 100) * w, (b.yPercent / 100) * h
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    path.points.splice(bestIdx + 1, 0, click);
    savePaths();
    renderPaths();
  }

  function deleteVertex(pathId, index) {
    const path = pathsFor(activeMapId).find((p) => p.id === pathId);
    if (!path || path.points.length <= 2) return;
    path.points.splice(index, 1);
    savePaths();
    renderPaths();
  }

  function focusOnPath(path) {
    if (!path.points.length) return;
    if (!isMapWindowActive) setMapWindowActive(true);
    const xs = path.points.map((p) => p.xPercent);
    const ys = path.points.map((p) => p.yPercent);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rect = viewport.getBoundingClientRect();
    const bboxWpx = ((maxX - minX) / 100) * contentW;
    const bboxHpx = ((maxY - minY) / 100) * contentH;
    const fitScaleX = bboxWpx > 4 ? (rect.width * 0.7) / bboxWpx : MAX_SCALE;
    const fitScaleY = bboxHpx > 4 ? (rect.height * 0.7) / bboxHpx : MAX_SCALE;
    const targetScale = clampScale(Math.min(fitScaleX, fitScaleY));
    const centerXpct = (minX + maxX) / 2;
    const centerYpct = (minY + maxY) / 2;
    const contentX = (centerXpct / 100) * contentW;
    const contentY = (centerYpct / 100) * contentH;
    const clamped = computeCenterTranslate(contentX, contentY, targetScale);
    scale = targetScale;
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();
    selectedPathId = path.id;
    renderPaths();
    renderPathsList();
  }

  function renderPaths() {
    if (!pathsSvg) return;
    const w = contentW || 1;
    const h = contentH || 1;
    pathsSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    pathsSvg.innerHTML = "";
    if (!activeMapId) return;

    pathsFor(activeMapId).forEach((path) => {
      if (path.visible === false || path.points.length < 2) return;
      const pts = path.points.map((p) => [(p.xPercent / 100) * w, (p.yPercent / 100) * h]);
      const ptsAttr = pts.map(([x, y]) => `${x},${y}`).join(" ");

      const wantsArrow = path.showArrow !== false && pts.length >= 2;
      let arrowHead = null;

      if (wantsArrow) {
        // Slim, tapered "dart" arrowhead (tip + concave notch) instead of
        // a blunt solid triangle — reads as a clean, flat, top-down
        // direction marker (compass needle / paper-airplane nose) rather
        // than a chunky wedge.
        //   - Base size is proportional to the map's own content box
        //     (min(w,h) below), not a fixed pixel count, so it stays the
        //     same visual proportion whether the map window is large or
        //     compact.
        //   - It only shrinks for a genuinely TINY path (total length,
        //     not just the final segment — a zigzag with many short hops
        //     still has plenty of total length, so it keeps its full,
        //     visible size instead of vanishing into the line, which is
        //     what capping against the last segment alone used to do).
        //   - A thin dark "halo" stroke around the dart (below) keeps it
        //     legible over both light and dark parts of the map at any
        //     zoom, the same trick real maps use for icons over varied
        //     terrain — without adding bulk, since a stroke this thin
        //     barely changes the shape's footprint.
        //
        // This is drawn as a plain SVG <path>, positioned with the
        // `transform` ATTRIBUTE (not CSS) directly in the paths layer —
        // deliberately NOT an SVG <marker> (the old approach). <marker>
        // content is a "paint server"-style reference, not a normal part
        // of the render tree, and in practice browsers don't reliably
        // keep it live: neither a CSS custom-property read (var(--mw-zoom))
        // nor a later attribute change on the <marker> itself was enough
        // to force a repaint once it had already been referenced once —
        // it would render correctly at first (whatever zoom it was first
        // drawn at) and then silently stop updating, which is exactly the
        // "disappears once you zoom" symptom. A plain element positioned
        // via its own `transform` attribute — the same category of update
        // as the vertex handles' cx/cy/r below — is guaranteed to repaint
        // every time we touch it, at any zoom level.
        const baseArrowSize = Math.max(9, Math.min(15, Math.min(w, h) * 0.02));
        let totalLen = 0;
        for (let i = 1; i < pts.length; i++) totalLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const arrowSize = Math.max(8, Math.min(baseArrowSize, totalLen * 0.9));

        const [ax, ay] = pts[pts.length - 1];
        const [px, py] = pts[pts.length - 2];
        const angleDeg = (Math.atan2(ay - py, ax - px) * 180) / Math.PI;

        arrowHead = document.createElementNS(SVG_NS, "path");
        // Local shape with its tip at the origin, pointing along +X —
        // translate to the path's last point, rotate to match its final
        // heading, then scale — all via the `transform` attribute, whose
        // rotate/scale always pivot around the local (0,0) origin (unlike
        // CSS `transform-origin`, which is the part that was ambiguous
        // inside <marker> content). Since the tip sits exactly at (0,0),
        // it stays pinned to the path's end at any scale.
        arrowHead.setAttribute("d", "M-12,-5.5 L0,0 L-12,5.5 L-8.6,0 Z");
        arrowHead.setAttribute("class", "mw-path-arrowhead");
        arrowHead.setAttribute("fill", path.color);
        arrowHead.dataset.mwAx = String(ax);
        arrowHead.dataset.mwAy = String(ay);
        arrowHead.dataset.mwAngle = String(angleDeg);
        arrowHead.dataset.mwSize = String(arrowSize);
        updateArrowheadTransform(arrowHead);
      }


      const isEditing = path.id === editingPathId;
      const isHighlighted = isEditing || path.id === selectedPathId;

      const hit = document.createElementNS(SVG_NS, "polyline");
      hit.setAttribute("points", ptsAttr);
      hit.setAttribute("class", "mw-path-hit");
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isEditing) {
          // Only a path explicitly unlocked via "✏️ Edit" can have its
          // shape changed — this is what stops a stray click from
          // silently distorting a finished route.
          insertVertexAtClick(path, e);
        } else if (selectedPathId !== path.id) {
          selectedPathId = path.id;
          renderPaths();
          renderPathsList();
        }
      });
      pathsSvg.appendChild(hit);

      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("points", ptsAttr);
      line.setAttribute(
        "class",
        `mw-path-line${isHighlighted ? " selected" : ""}${isEditing ? " editing" : ""}${path.id === mapSearchGlowPathId ? " mw-path-search-glow" : ""}`
      );
      line.style.stroke = path.color;
      line.style.setProperty("--mw-search-glow-color", path.color);
      line.dataset.pathId = path.id;
      pathsSvg.appendChild(line);
      if (path.id === mapSearchGlowPathId) {
        pathsSvg.appendChild(buildSearchFlowLine(pts, path.color));
        pathsSvg.appendChild(buildSearchEndpointMarker(pts[0][0], pts[0][1], "start"));
        pathsSvg.appendChild(buildSearchEndpointMarker(pts[pts.length - 1][0], pts[pts.length - 1][1], "end"));
      }
      if (arrowHead) pathsSvg.appendChild(arrowHead);

      // Path name label — off by default (see finishDrawing) since paths
      // never used to show a name on the map at all, only in this list
      // and in search. When turned on via the 🏷️ toggle, it's drawn as a
      // small pill at the path's midpoint, sized independently via
      // path.labelScale so it can be shrunk down to near-nothing without
      // affecting anything else about the path.
      if (path.label && path.labelHidden !== true) {
        const midIdx = Math.floor((pts.length - 1) / 2);
        const [lx, ly] = pts[midIdx];
        const fontSize = Math.max(1, getLabelBaseFontPx() * (path.labelScale ?? LABEL_SCALE_DEFAULT));
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("x", lx);
        text.setAttribute("y", ly);
        text.setAttribute("font-size", fontSize.toFixed(2));
        text.setAttribute("font-family", "system-ui, sans-serif");
        text.setAttribute("font-weight", "600");
        text.setAttribute("fill", "#fff");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("class", "mw-path-name-label");
        text.style.pointerEvents = "none";
        text.textContent = path.label;
        pathsSvg.appendChild(text);
        try {
          const bbox = text.getBBox();
          const padX = fontSize * 0.5;
          const padY = fontSize * 0.35;
          const rect = document.createElementNS(SVG_NS, "rect");
          rect.setAttribute("x", String(bbox.x - padX));
          rect.setAttribute("y", String(bbox.y - padY));
          rect.setAttribute("width", String(bbox.width + padX * 2));
          rect.setAttribute("height", String(bbox.height + padY * 2));
          rect.setAttribute("rx", String((bbox.height + padY * 2) / 2));
          rect.setAttribute("fill", "rgba(20, 24, 30, 0.78)");
          rect.style.pointerEvents = "none";
          pathsSvg.insertBefore(rect, text);
        } catch (err) {
          /* getBBox can throw if the SVG isn't laid out yet (e.g. display:none
             ancestor) — the bare text still renders fine without its pill */
        }
      }

      // Vertex drag/insert/delete handles — rendered ONLY while this path
      // is unlocked for editing, so a path just sits inert (no handles to
      // catch a mis-click) whenever it's merely selected or not touched.
      if (isEditing) {
        pts.forEach(([x, y], idx) => {
          const c = document.createElementNS(SVG_NS, "circle");
          c.setAttribute("cx", x);
          c.setAttribute("cy", y);
          c.setAttribute("r", "6");
          c.setAttribute("class", "mw-path-vertex");
          c.style.fill = path.color;
          c.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            vertexDragMoved = false;
            draggingVertex = { pathId: path.id, index: idx };
          });
          c.addEventListener("click", (e) => {
            e.stopPropagation();
            // A plain click (no drag movement in between) opens the
            // symbol picker for this point instead of doing nothing.
            if (!vertexDragMoved) {
              openSymbolPicker(c, path.points[idx].symbol, (symbol) => {
                if (symbol) path.points[idx].symbol = symbol;
                else delete path.points[idx].symbol;
                savePaths();
                renderPaths();
              });
            }
            vertexDragMoved = false;
          });
          c.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            deleteVertex(path.id, idx);
          });
          pathsSvg.appendChild(c);
        });
      }

      // Symbol decorations — drawn for every point that has one,
      // regardless of selection/edit state, so placed icons (castle,
      // ship, tree...) stay visible as permanent map decoration.
      // pointer-events:none lets clicks fall through to the vertex
      // handle (when editing) or the line/hit beneath.
      path.points.forEach((p, idx) => {
        if (!p.symbol) return;
        const [x, y] = pts[idx];
        const urls = mwEmojiUrls(p.symbol);
        const fallbackToText = () => {
          // Twemoji never loaded, or every candidate URL failed — plain
          // glyph, deliberately with NO stroke (see comment above), so
          // it can't reproduce the old code-point-number rendering bug.
          const label = document.createElementNS(SVG_NS, "text");
          label.setAttribute("x", x);
          label.setAttribute("y", y);
          label.setAttribute("class", "mw-path-symbol-fallback");
          label.textContent = p.symbol;
          pathsSvg.appendChild(label);
        };
        if (urls && urls.length) {
          // Real Twemoji artwork as an SVG <image>, centred on the point
          // via transform-box:fill-box (see CSS) so x/y can stay the
          // point's plain coordinates. This is what replaced the old
          // stroked <text> glyph that used to render as a bare number.
          const img = document.createElementNS(SVG_NS, "image");
          img.setAttribute("x", x);
          img.setAttribute("y", y);
          img.setAttribute("class", "mw-path-symbol-img");
          let srcIdx = 0;
          const trySrc = () => {
            img.setAttribute("href", urls[srcIdx]);
            img.setAttributeNS("http://www.w3.org/1999/xlink", "href", urls[srcIdx]);
          };
          img.addEventListener("error", () => {
            srcIdx += 1;
            if (srcIdx < urls.length) {
              trySrc();
            } else {
              img.remove();
              fallbackToText();
            }
          });
          trySrc();
          pathsSvg.appendChild(img);
        } else {
          fallbackToText();
        }
      });
    });

    if (isDrawing && draftPoints.length) {
      const dpts = draftPoints.map((p) => [(p.xPercent / 100) * w, (p.yPercent / 100) * h]);
      const draftLine = document.createElementNS(SVG_NS, "polyline");
      draftLine.setAttribute("points", dpts.map(([x, y]) => `${x},${y}`).join(" "));
      draftLine.setAttribute("class", "mw-path-draft-line");
      draftLine.style.stroke = draftColor;
      pathsSvg.appendChild(draftLine);

      dpts.forEach(([x, y]) => {
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", x);
        c.setAttribute("cy", y);
        c.setAttribute("r", "4");
        c.setAttribute("class", "mw-path-draft-vertex");
        pathsSvg.appendChild(c);
      });

      if (dpts.length && rubberPoint) {
        const last = dpts[dpts.length - 1];
        const rubber = document.createElementNS(SVG_NS, "line");
        rubber.setAttribute("x1", last[0]);
        rubber.setAttribute("y1", last[1]);
        rubber.setAttribute("x2", (rubberPoint.xPercent / 100) * w);
        rubber.setAttribute("y2", (rubberPoint.yPercent / 100) * h);
        rubber.setAttribute("class", "mw-path-rubber");
        pathsSvg.appendChild(rubber);
      }
    }
  }

  function renderPathsList() {
    if (!pathsListEl) return;
    const list = activeMapId ? pathsFor(activeMapId) : [];
    pathsEmptyEl?.classList.toggle("hidden", list.length > 0);
    pathsListEl.innerHTML = list
      .map(
        (path) => `
      <li class="mw-path-row${path.id === selectedPathId ? " active" : ""}${path.id === editingPathId ? " mw-path-row-editing" : ""}${path.visible === false ? " mw-path-row-hidden" : ""}" data-path-id="${escapeHtml(path.id)}">
        <button type="button" class="mw-path-swatch" style="background:${escapeHtml(path.color)}" title="Path colour" aria-label="Path colour"></button>
        <input type="text" class="mw-path-name-input" value="${escapeHtml(path.label)}" maxlength="40" title="Path name">
        <div class="mw-path-row-actions">
          <button type="button" class="icon-btn mw-path-edit-btn${path.id === editingPathId ? " active" : ""}" title="${path.id === editingPathId ? "Done editing (locks the path again)" : "Unlock to drag points, insert points, or pin symbols"}">${path.id === editingPathId ? "🔓 Editing" : "🔒 Edit"}</button>
          <button type="button" class="icon-btn mw-path-arrow-btn${path.showArrow === false ? " off" : ""}" title="${path.showArrow === false ? "Show direction arrow" : "Hide direction arrow"}">➤</button>
          <button type="button" class="icon-btn mw-path-visibility-btn" title="${path.visible === false ? "Show path" : "Hide path"}">${path.visible === false ? "🙈" : "👁️"}</button>
          <button type="button" class="icon-btn mw-path-label-visibility-btn" title="${path.labelHidden === false ? "Hide this name on the map (still searchable by name)" : "Show this name on the map"}">${path.labelHidden === false ? "👁️" : "🙈"}</button>
          <button type="button" class="icon-btn mw-path-focus-btn" title="Center on path">🎯</button>
          <button type="button" class="icon-btn mw-path-delete-btn" title="Delete path">🗑️</button>
        </div>
        <div class="mw-symbol-size-control mw-path-label-size-control">
          <span class="mw-symbol-size-icon" title="Name label size">🏷️</span>
          <input type="range" class="mw-path-label-size-slider" min="${LABEL_SCALE_MIN}" max="${LABEL_SCALE_MAX}" step="${LABEL_SCALE_STEP}" value="${path.labelScale ?? LABEL_SCALE_DEFAULT}" title="On-map name size — drag all the way down to make it barely visible">
          <span class="mw-path-label-size-value">${Math.round((path.labelScale ?? LABEL_SCALE_DEFAULT) * 100)}%</span>
        </div>
      </li>`
      )
      .join("");

    pathsListEl.querySelectorAll(".mw-path-row").forEach((row) => {
      const id = row.dataset.pathId;
      const path = list.find((p) => p.id === id);
      if (!path) return;

      row.querySelector(".mw-path-swatch")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const swatchEl = e.currentTarget;
        openColorWheel(swatchEl, path.color, (hex) => {
          path.color = hex;
          swatchEl.style.background = hex;
          savePaths();
          renderPaths();
        });
      });
      row.querySelector(".mw-path-name-input")?.addEventListener("change", (e) => {
        path.label = e.target.value.trim() || path.label;
        savePaths();
      });
      row.querySelector(".mw-path-edit-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSymbolPicker();
        if (editingPathId === path.id) {
          editingPathId = null;
        } else {
          // Only one path can be unlocked at a time — switching to a new
          // one always re-locks whatever was being edited before.
          editingPathId = path.id;
          selectedPathId = path.id;
        }
        renderPaths();
        renderPathsList();
      });
      row.querySelector(".mw-path-arrow-btn")?.addEventListener("click", () => {
        path.showArrow = path.showArrow === false ? true : false;
        savePaths();
        renderPaths();
        renderPathsList();
      });
      row.querySelector(".mw-path-visibility-btn")?.addEventListener("click", () => {
        path.visible = path.visible === false ? true : false;
        savePaths();
        renderPaths();
        renderPathsList();
      });
      row.querySelector(".mw-path-label-visibility-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        path.labelHidden = path.labelHidden === false ? true : false;
        savePaths();
        renderPaths();
        renderPathsList();
      });
      const pathLabelSizeSlider = row.querySelector(".mw-path-label-size-slider");
      const pathLabelSizeValueEl = row.querySelector(".mw-path-label-size-value");
      pathLabelSizeSlider?.addEventListener("click", (e) => e.stopPropagation());
      pathLabelSizeSlider?.addEventListener("input", (e) => {
        const val = Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, parseFloat(e.target.value) || LABEL_SCALE_DEFAULT));
        path.labelScale = val;
        if (pathLabelSizeValueEl) pathLabelSizeValueEl.textContent = `${Math.round(val * 100)}%`;
        savePaths();
        renderPaths(); // path labels are SVG text/rect pairs sized by attribute, so a full repaint is needed (unlike the symbol label's plain CSS font-size)
      });
      row.querySelector(".mw-path-focus-btn")?.addEventListener("click", () => focusOnPath(path));
      row.querySelector(".mw-path-delete-btn")?.addEventListener("click", () => {
        if (!confirm(`Delete "${path.label}"? This can't be undone.`)) return;
        const arr = pathsFor(activeMapId);
        const idx = arr.findIndex((p) => p.id === path.id);
        if (idx !== -1) arr.splice(idx, 1);
        if (selectedPathId === path.id) selectedPathId = null;
        if (editingPathId === path.id) editingPathId = null;
        savePaths();
        renderPaths();
        renderPathsList();
      });
      row.addEventListener("click", (e) => {
        if (e.target.closest("input") || e.target.closest("button")) return;
        selectedPathId = selectedPathId === path.id ? null : path.id;
        renderPaths();
        renderPathsList();
      });
    });
  }

  pathsBtn?.addEventListener("click", () => {
    optionsPanel?.classList.add("hidden");
    symbolsPanel?.classList.add("hidden");
    pathsPanel?.classList.toggle("hidden");
    refreshDraftColorSwatch();
    // #vocab-map-window scrolls internally (capped height); without
    // resetting scroll here, switching panels from deep within a long
    // Settings scroll leaves the newly-shown panel scrolled out of view
    // above the fold — can look like only the bare map is showing.
    win.scrollTop = 0;
  });

  drawPathBtn?.addEventListener("click", () => {
    if (isDrawing) {
      if (draftPoints.length < 2) {
        if (drawHintEl) drawHintEl.textContent = "Add at least 2 points before finishing.";
        return;
      }
      finishDrawing();
    } else {
      enterDrawMode();
    }
  });

  /* ----------------------------------------------------------------------
     SYMBOL MARKERS — pin any icon from SYMBOL_CATEGORIES at a fixed spot
     on the map (a campfire at a campsite, a skull at a battle site...),
     independent of any path. A marker is
     { id, xPercent, yPercent, symbol, label }.

     Interaction model:
       - "📍 Place Symbol" opens the same symbol-picker popover used for
         path points; picking an icon arms placement mode (crosshair
         cursor + hint), and the NEXT click anywhere on the map drops the
         marker there and disarms placement mode. Esc cancels.
       - Markers are LOCKED by default — permanent decoration, inert to
         click/drag, exactly like an unedited path. The panel list's
         🔒 Edit toggle unlocks exactly one marker at a time (mirrors
         editingPathId): while unlocked it can be dragged on the map, and
         clicking it re-opens the picker to swap its icon.
       - Renders into #map-symbols-layer, a plain HTML sibling of the
         markers/paths layers inside #map-canvas-container, so it pans
         and zooms with the map for free — no SVG/counter-scale needed.
  ---------------------------------------------------------------------- */

  function beginPlacingSymbol(symbol) {
    // Placing a symbol is mutually exclusive with drawing/editing a path
    // — keep exactly one "mode" active on the map at a time.
    cancelDrawing();
    selectedPathId = null;
    editingPathId = null;
    editingSymbolId = null;
    closeSymbolPicker();
    pendingPlaceSymbol = symbol;
    viewport?.classList.add("mw-placing-symbol");
    if (symbolHintEl) {
      // Never interpolate the raw symbol value into the hint text — for
      // custom hand-authored artwork (ASOIAF structures etc.) `symbol` is
      // a full data:image/svg+xml;... URI hundreds of characters long,
      // and dumping that into a text node blows up the panel. Show a
      // small rendered icon plus its friendly name instead, falling back
      // to a generic phrase if no name is known for it.
      const label = SYMBOL_NAME_BY_CHAR[symbol] || (mwIsCustomSvgSymbol(symbol) ? "this symbol" : symbol);
      symbolHintEl.innerHTML = `Click anywhere on the map to pin ${mwEmojiImgHtml(symbol, "mw-symbol-hint-img")} ${escapeHtml(label)} there (Esc to cancel).`;
      symbolHintEl.classList.remove("hidden");
    }
  }

  function cancelPlacingSymbol() {
    pendingPlaceSymbol = null;
    viewport?.classList.remove("mw-placing-symbol");
    symbolHintEl?.classList.add("hidden");
  }

  function renderSymbols() {
    if (!symbolsLayer) return;
    symbolsLayer.innerHTML = "";
    if (!activeMapId) return;
    symbolsFor(activeMapId).forEach((marker) => {
      const isEditing = marker.id === editingSymbolId;
      const isGlowing = marker.id === mapSearchGlowSymbolId;
      const el = document.createElement("button");
      el.type = "button";
      el.className = `map-symbol-marker${isEditing ? " editing" : ""}${isGlowing ? " mw-symbol-search-glow" : ""}`;
      el.style.left = `${marker.xPercent}%`;
      el.style.top = `${marker.yPercent}%`;
      el.style.setProperty("--mw-symbol-scale", String(marker.scale || 1));
      if (isGlowing) {
        // Own-colour glow: mapSearchGlowColor is resolved asynchronously
        // from the symbol's actual artwork (see mwResolveSymbolGlowColor)
        // and may not have landed yet on the very first paint after a
        // search — the CSS custom property's own fallback (a warm gold)
        // covers that gap until the real colour arrives and this re-renders.
        el.style.setProperty("--mw-search-glow-color", mapSearchGlowColor || MW_SYMBOL_GLOW_DEFAULT);
      }
      el.dataset.symbolMarkerId = marker.id;
      el.title = isEditing
        ? "Drag to reposition, click to change icon"
        : marker.label
        ? `${marker.symbol} ${marker.label}`
        : "Unlock from the 📍 panel to move or change this symbol";
      const showLabel = !!marker.label && marker.labelHidden !== true;
      const labelFontPx = getLabelBaseFontPx() * (marker.labelScale ?? LABEL_SCALE_DEFAULT);
      el.innerHTML = `${mwEmojiImgHtml(marker.symbol, "map-symbol-marker-emoji")}${
        showLabel
          ? `<span class="map-symbol-marker-label" style="font-size:${labelFontPx.toFixed(2)}px">${escapeHtml(marker.label)}</span>`
          : ""
      }`;
      el.addEventListener("mousedown", (e) => {
        if (!isEditing) return; // locked markers are inert to drag, same as an unedited path
        e.stopPropagation();
        e.preventDefault();
        symbolMarkerDragMoved = false;
        draggingSymbolMarker = { id: marker.id };
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isEditing) return; // locked: does nothing on the map itself, only from the list
        if (symbolMarkerDragMoved) {
          symbolMarkerDragMoved = false;
          return;
        }
        openSymbolPicker(
          el,
          marker.symbol,
          (symbol) => {
            if (!symbol) return;
            marker.symbol = symbol;
            saveSymbols();
            renderSymbols();
            renderSymbolsList();
          },
          { title: "Change this symbol", clearLabel: "✖ Cancel" }
        );
      });
      symbolsLayer.appendChild(el);
    });
  }

  function renderSymbolsList() {
    if (!symbolsListEl) return;
    const list = activeMapId ? symbolsFor(activeMapId) : [];
    symbolsEmptyEl?.classList.toggle("hidden", list.length > 0);
    symbolsListEl.innerHTML = list
      .map(
        (marker) => `
      <li class="mw-path-row mw-symbol-row${marker.id === editingSymbolId ? " mw-path-row-editing" : ""}" data-symbol-marker-id="${escapeHtml(marker.id)}">
        <button type="button" class="mw-symbol-swatch" title="Change symbol" aria-label="Change symbol">${mwEmojiImgHtml(marker.symbol, "mw-symbol-swatch-img")}</button>
        <input type="text" class="mw-path-name-input" value="${escapeHtml(marker.label || "")}" maxlength="40" placeholder="Label (optional)" title="Symbol label">
        <div class="mw-path-row-actions">
          <button type="button" class="icon-btn mw-path-edit-btn${marker.id === editingSymbolId ? " active" : ""}" title="${marker.id === editingSymbolId ? "Done editing (locks it in place)" : "Unlock to drag or change this symbol"}">${marker.id === editingSymbolId ? "🔓 Editing" : "🔒 Edit"}</button>
          <button type="button" class="icon-btn mw-symbol-label-visibility-btn" title="${marker.labelHidden ? "Show this label on the map" : "Hide this label on the map (still searchable by name)"}">${marker.labelHidden ? "🙈" : "👁️"}</button>
          <button type="button" class="icon-btn mw-symbol-focus-btn" title="Center on this symbol">🎯</button>
          <button type="button" class="icon-btn mw-symbol-delete-btn" title="Delete symbol">🗑️</button>
        </div>
        <div class="mw-symbol-size-control">
          <span class="mw-symbol-size-icon">🔎</span>
          <input type="range" class="mw-symbol-size-slider" min="${SYMBOL_SCALE_MIN}" max="${SYMBOL_SCALE_MAX}" step="${SYMBOL_SCALE_STEP}" value="${marker.scale || SYMBOL_SCALE_DEFAULT}" title="Symbol size — drag to make it as small or as big as you want">
          <span class="mw-symbol-size-value">${Math.round((marker.scale || SYMBOL_SCALE_DEFAULT) * 100)}%</span>
        </div>
        <div class="mw-symbol-size-control mw-symbol-label-size-control">
          <span class="mw-symbol-size-icon" title="Label size">🏷️</span>
          <input type="range" class="mw-symbol-label-size-slider" min="${LABEL_SCALE_MIN}" max="${LABEL_SCALE_MAX}" step="${LABEL_SCALE_STEP}" value="${marker.labelScale ?? LABEL_SCALE_DEFAULT}" title="Label size — independent of the icon size above; drag all the way down to make the name nearly invisible">
          <span class="mw-symbol-label-size-value">${Math.round((marker.labelScale ?? LABEL_SCALE_DEFAULT) * 100)}%</span>
        </div>
      </li>`
      )
      .join("");

    symbolsListEl.querySelectorAll("li").forEach((row) => {
      const id = row.dataset.symbolMarkerId;
      const marker = list.find((m) => m.id === id);
      if (!marker) return;

      row.querySelector(".mw-symbol-swatch")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openSymbolPicker(
          e.currentTarget,
          marker.symbol,
          (symbol) => {
            if (!symbol) return;
            marker.symbol = symbol;
            saveSymbols();
            renderSymbols();
            renderSymbolsList();
          },
          { title: "Change this symbol", clearLabel: "✖ Cancel" }
        );
      });
      row.querySelector(".mw-path-name-input")?.addEventListener("change", (e) => {
        marker.label = e.target.value.trim();
        saveSymbols();
        renderSymbols();
      });
      row.querySelector(".mw-path-edit-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSymbolPicker();
        // Only one symbol marker can be unlocked at a time — matches the
        // one-path-editing-at-a-time rule above.
        editingSymbolId = editingSymbolId === marker.id ? null : marker.id;
        renderSymbols();
        renderSymbolsList();
      });
      row.querySelector(".mw-symbol-label-visibility-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        marker.labelHidden = !marker.labelHidden;
        saveSymbols();
        renderSymbols();
        renderSymbolsList();
      });
      row.querySelector(".mw-symbol-focus-btn")?.addEventListener("click", () => focusOnSymbol(marker));
      row.querySelector(".mw-symbol-delete-btn")?.addEventListener("click", () => {
        if (!confirm(`Delete this ${marker.symbol} symbol? This can't be undone.`)) return;
        const arr = symbolsFor(activeMapId);
        const idx = arr.findIndex((m) => m.id === marker.id);
        if (idx !== -1) arr.splice(idx, 1);
        if (editingSymbolId === marker.id) editingSymbolId = null;
        saveSymbols();
        renderSymbols();
        renderSymbolsList();
      });

      // Size slider: updates the on-map marker live as you drag (via the
      // --mw-symbol-scale CSS var, no full re-render so the slider never
      // loses focus mid-drag), persists on every tick since it's a cheap
      // write, and only touches this one marker's DOM node.
      const sizeSlider = row.querySelector(".mw-symbol-size-slider");
      const sizeValueEl = row.querySelector(".mw-symbol-size-value");
      sizeSlider?.addEventListener("input", (e) => {
        const val = Math.min(SYMBOL_SCALE_MAX, Math.max(SYMBOL_SCALE_MIN, parseFloat(e.target.value) || SYMBOL_SCALE_DEFAULT));
        marker.scale = val;
        if (sizeValueEl) sizeValueEl.textContent = `${Math.round(val * 100)}%`;
        const markerEl = symbolsLayer?.querySelector(`[data-symbol-marker-id="${CSS.escape(marker.id)}"]`);
        markerEl?.style.setProperty("--mw-symbol-scale", String(val));
        saveSymbols();
      });

      // Label size slider: completely independent of the icon-size slider
      // above — updates the label span's font-size live (no full
      // re-render, so the slider never loses focus mid-drag) and persists
      // on every tick. Dragging to the minimum shrinks the name to
      // barely-there without touching the icon at all.
      const labelSizeSlider = row.querySelector(".mw-symbol-label-size-slider");
      const labelSizeValueEl = row.querySelector(".mw-symbol-label-size-value");
      labelSizeSlider?.addEventListener("input", (e) => {
        const val = Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, parseFloat(e.target.value) || LABEL_SCALE_DEFAULT));
        marker.labelScale = val;
        if (labelSizeValueEl) labelSizeValueEl.textContent = `${Math.round(val * 100)}%`;
        const labelEl = symbolsLayer?.querySelector(`[data-symbol-marker-id="${CSS.escape(marker.id)}"] .map-symbol-marker-label`);
        if (labelEl) labelEl.style.fontSize = `${(getLabelBaseFontPx() * val).toFixed(2)}px`;
        saveSymbols();
      });
    });
  }

  function focusOnSymbol(marker) {
    if (!isMapWindowActive) setMapWindowActive(true);
    const targetScale = clampScale(2.2);
    const contentX = (marker.xPercent / 100) * contentW;
    const contentY = (marker.yPercent / 100) * contentH;
    const clamped = computeCenterTranslate(contentX, contentY, targetScale);
    scale = targetScale;
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();
    renderPaths(); // keep zoom-dependent stroke/vertex sizing in sync
  }

  /* ----------------------------------------------------------------------
     MAP SEARCH — find a path or symbol by name, then jump to it and make
     it glow. Purely a UI convenience over data that already exists
     (pathsFor/symbolsFor for the active map); it doesn't add, remove, or
     rename anything. Visibility of the search bar itself is handled
     entirely in CSS (hover the top strip, or focus the input — see
     .mw-map-search-wrap in map-window.css); this block only owns the
     matching, the results dropdown, and the glow effect.
  ---------------------------------------------------------------------- */

  // A small SVG polyline riding on top of the matched path with a short
  // bright dash animating along stroke-dashoffset (see @keyframes
  // mw-search-flow in map-window.css). Rebuilt fresh on every renderPaths()
  // call for the glowing path (cheap — it's one extra element) rather than
  // mutated in place, so it never drifts out of sync with edits/zoom.
  function buildSearchFlowLine(pts, color) {
    const flow = document.createElementNS(SVG_NS, "polyline");
    flow.setAttribute("points", pts.map(([x, y]) => `${x},${y}`).join(" "));
    flow.setAttribute("class", "mw-path-flow-line");
    flow.style.setProperty("--mw-search-glow-color", color);
    return flow;
  }

  // The two ends of a glowing path get their own little beacon — a solid
  // glowing dot plus two staggered "radar ping" rings expanding outward —
  // in fixed colors that always mean the same thing (emerald = where it
  // starts, coral = where it ends), independent of the path's own color,
  // so the two ends read clearly apart even on a single-color line.
  // Position (cx/cy) is set here from the current content-box coordinates
  // like everything else in this layer; on-screen SIZE is left to CSS,
  // which counter-scales it against --mw-zoom the same way the vertex
  // handles do, so the beacon stays a small, constant size at any zoom.
  function buildSearchEndpointMarker(x, y, variant) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `mw-path-endpoint mw-path-endpoint-${variant}`);
    const makeCircle = (cls) => {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", x);
      c.setAttribute("cy", y);
      c.setAttribute("class", cls);
      return c;
    };
    g.appendChild(makeCircle("mw-path-endpoint-ring mw-path-endpoint-ring-a"));
    g.appendChild(makeCircle("mw-path-endpoint-ring mw-path-endpoint-ring-b"));
    g.appendChild(makeCircle("mw-path-endpoint-core"));
    return g;
  }

  // Pans to center the matched path in the viewport WITHOUT touching the
  // current zoom level — unlike focusOnPath() (used by the 🎯 button in
  // the paths list), which deliberately zooms to fit. Search results only
  // change where you're looking, never how close.
  function panToPath(path) {
    if (!path.points.length) return;
    if (!isMapWindowActive) setMapWindowActive(true);
    const xs = path.points.map((p) => p.xPercent);
    const ys = path.points.map((p) => p.yPercent);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const centerXpct = (minX + maxX) / 2;
    const centerYpct = (minY + maxY) / 2;
    const contentX = (centerXpct / 100) * contentW;
    const contentY = (centerYpct / 100) * contentH;
    const clamped = computeCenterTranslate(contentX, contentY, scale);
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();
    selectedPathId = path.id;
    renderPaths();
    renderPathsList();
  }

  // Same idea for a symbol — recenters on it at whatever zoom you're
  // already at, rather than snapping in to a fixed close-up scale.
  function panToSymbol(marker) {
    if (!isMapWindowActive) setMapWindowActive(true);
    const contentX = (marker.xPercent / 100) * contentW;
    const contentY = (marker.yPercent / 100) * contentH;
    const clamped = computeCenterTranslate(contentX, contentY, scale);
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();
    renderPaths();
  }

  function mapSearchCandidates() {
    if (!activeMapId) return [];
    const paths = pathsFor(activeMapId)
      .filter((p) => p.points.length >= 2)
      .map((p) => ({ type: "path", id: p.id, label: p.label || "Untitled path", icon: "🛤️", ref: p }));
    const symbols = symbolsFor(activeMapId).map((m) => ({
      type: "symbol",
      id: m.id,
      label: m.label || SYMBOL_NAME_BY_CHAR[m.symbol] || m.symbol,
      icon: m.symbol,
      ref: m,
    }));
    return [...paths, ...symbols];
  }

  function runMapSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return mapSearchCandidates()
      .filter((c) => c.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q))
      .slice(0, 8);
  }

  /* ---- Symbol search-glow colour — "twinkle in its own colour" --------
     A searched symbol's glow should read as THAT icon's colour (a red
     flag glows red, a blue droplet glows blue…), not one generic tint
     for every symbol. There's no colour field in the symbol data, so it
     comes from the icon's own artwork: the same Twemoji/flag image
     mwEmojiImgHtml() renders is drawn onto a small offscreen canvas
     (loadCanvasSafeImage — already used by the PNG-flatten/export code
     above) and the most vivid, legible pixel colour is picked out of it.
     Resolved once per distinct symbol and cached forever after (an
     emoji's artwork never changes), so repeat searches for the same
     icon are instant. Falls back to a warm gold if the artwork can't be
     loaded/sampled (offline, blocked CDN, a mostly-monochrome glyph like
     💀) or before the very first resolution lands. */
  const MW_SYMBOL_GLOW_DEFAULT = "#ffd76b";
  const mwSymbolGlowColorCache = new Map(); // symbol char -> resolved "rgb(...)" | MW_SYMBOL_GLOW_DEFAULT

  function mwRgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s, l };
  }

  // Samples `img` (already loaded, CORS-clean) for the most vivid,
  // legible colour in it. Prefers a saturated, mid-lightness pixel (the
  // kind that reads clearly as "a colour" rather than near-white/near-
  // black shading); if nothing in the artwork is saturated enough (a
  // grey/black-and-white glyph), falls back to the average colour of its
  // opaque pixels, and only gives up (returns null) if even that is
  // essentially colourless.
  function mwExtractGlowColorFromImage(img) {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    let data;
    try {
      data = ctx.getImageData(0, 0, size, size).data;
    } catch (err) {
      return null; // canvas got tainted — shouldn't happen with the CORS-enabled sources, but never let it throw
    }
    let bestScore = -1;
    let best = null;
    let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 100) continue; // skip transparent/near-transparent pixels
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { s, l } = mwRgbToHsl(r, g, b);
      if (l > 0.08 && l < 0.92) {
        sumR += r * a; sumG += g * a; sumB += b * a; sumW += a;
      }
      const score = s * (1 - Math.abs(l - 0.55) * 1.3);
      if (l > 0.12 && l < 0.9 && score > bestScore) {
        bestScore = score;
        best = { r, g, b, s };
      }
    }
    if (best && best.s > 0.32) return `rgb(${best.r}, ${best.g}, ${best.b})`;
    if (sumW > 0) {
      const avgR = Math.round(sumR / sumW), avgG = Math.round(sumG / sumW), avgB = Math.round(sumB / sumW);
      if (mwRgbToHsl(avgR, avgG, avgB).s > 0.14) return `rgb(${avgR}, ${avgG}, ${avgB})`;
    }
    return null;
  }

  async function mwResolveSymbolGlowColor(symbol) {
    if (!symbol) return MW_SYMBOL_GLOW_DEFAULT;
    if (mwSymbolGlowColorCache.has(symbol)) return mwSymbolGlowColorCache.get(symbol);
    let color = null;
    try {
      const img = await loadCanvasSafeImage(mwEmojiUrls(symbol));
      if (img) color = mwExtractGlowColorFromImage(img);
    } catch (err) {
      color = null;
    }
    color = color || MW_SYMBOL_GLOW_DEFAULT;
    mwSymbolGlowColorCache.set(symbol, color);
    return color;
  }

  /* ---- Search glow duration (Settings → Search glow timing) -----------
     How long the pulse animation runs after a path or symbol search
     before settling back down, independently configurable per type.
     "until-next" skips the auto-clear timer entirely — the glow then
     keeps pulsing until the next search of that same type replaces it
     (or the search bar is explicitly cleared/closed), rather than on a
     fixed clock. */
  const MW_GLOW_DURATION_OPTIONS = ["3", "6", "10", "20", "until-next"];
  const MW_GLOW_DURATION_DEFAULT = "6"; // matches the original fixed 6s behaviour

  function getGlowDuration(kind) {
    // kind: "path" | "symbol"
    const storageKey = kind === "path" ? MW_PATH_GLOW_DURATION_STORAGE : MW_SYMBOL_GLOW_DURATION_STORAGE;
    try {
      const v = localStorage.getItem(storageKey);
      return MW_GLOW_DURATION_OPTIONS.includes(v) ? v : MW_GLOW_DURATION_DEFAULT;
    } catch {
      return MW_GLOW_DURATION_DEFAULT;
    }
  }

  function clearMapSearchGlow() {
    clearTimeout(mapSearchGlowTimer);
    mapSearchGlowTimer = null;
    if (!mapSearchGlowPathId && !mapSearchGlowSymbolId) return;
    mapSearchGlowPathId = null;
    mapSearchGlowSymbolId = null;
    mapSearchGlowColor = null;
    renderPaths();
    renderSymbols();
  }

  function glowMapSearchResult(result) {
    clearTimeout(mapSearchGlowTimer);
    mapSearchGlowPathId = result.type === "path" ? result.id : null;
    mapSearchGlowSymbolId = result.type === "symbol" ? result.id : null;
    if (result.type === "symbol") {
      const symbolChar = result.ref?.symbol || result.icon;
      // Show the cached colour immediately if we've already resolved
      // this symbol before; otherwise start on the gold fallback and
      // swap to the real colour the moment it's ready.
      mapSearchGlowColor = mwSymbolGlowColorCache.get(symbolChar) || null;
      const glowToken = mapSearchGlowSymbolId;
      mwResolveSymbolGlowColor(symbolChar).then((color) => {
        // The glow may have moved to a different symbol (or cleared)
        // while this was in flight — don't let a stale result stomp it.
        if (mapSearchGlowSymbolId !== glowToken) return;
        mapSearchGlowColor = color;
        renderSymbols();
      });
    } else {
      mapSearchGlowColor = null;
    }
    renderPaths();
    renderSymbols();
    // Elegant, not permanent by default — the glow settles back down on
    // its own after a configurable pulse (Settings → Search glow timing),
    // unless that's set to "Until next search", in which case it just
    // keeps pulsing (no timer at all) until the next search of the same
    // type replaces it.
    const duration = getGlowDuration(result.type);
    if (duration !== "until-next") {
      mapSearchGlowTimer = setTimeout(clearMapSearchGlow, Number(duration) * 1000);
    }
  }

  function renderMapSearchResults() {
    if (!mapSearchResultsEl) return;
    const query = mapSearchInput?.value || "";
    const results = runMapSearch(query);
    mapSearchLastResults = results;
    mapSearchActiveIndex = results.length ? 0 : -1;

    if (!query.trim()) {
      mapSearchResultsEl.classList.add("hidden");
      mapSearchResultsEl.innerHTML = "";
      return;
    }

    if (!results.length) {
      mapSearchResultsEl.classList.remove("hidden");
      mapSearchResultsEl.innerHTML = `<li class="mw-map-search-empty">No matching paths or symbols</li>`;
      return;
    }

    mapSearchResultsEl.innerHTML = results
      .map(
        (r, i) => `
      <li class="mw-map-search-result${i === 0 ? " mw-map-search-result-active" : ""}" data-index="${i}">
        <span class="mw-map-search-result-icon">${
          r.type === "path" ? r.icon : mwEmojiImgHtml(r.icon, "mw-map-search-result-emoji")
        }</span>
        <span class="mw-map-search-result-label">${escapeHtml(r.label)}</span>
        <span class="mw-map-search-result-type">${r.type === "path" ? "Path" : "Symbol"}</span>
      </li>`
      )
      .join("");
    mapSearchResultsEl.classList.remove("hidden");

    mapSearchResultsEl.querySelectorAll(".mw-map-search-result").forEach((li) => {
      // mousedown (not click) + preventDefault so the input never loses
      // focus/blurs before the pick registers — keeps the bar from
      // fading out mid-click on the region it lives over.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const idx = parseInt(li.dataset.index, 10);
        selectMapSearchResult(mapSearchLastResults[idx]);
      });
    });
  }

  function updateMapSearchActiveRow() {
    mapSearchResultsEl?.querySelectorAll(".mw-map-search-result").forEach((li, i) => {
      li.classList.toggle("mw-map-search-result-active", i === mapSearchActiveIndex);
    });
  }

  function selectMapSearchResult(result) {
    if (!result) return;
    if (result.type === "path") panToPath(result.ref);
    else panToSymbol(result.ref);
    glowMapSearchResult(result);
    if (mapSearchResultsEl) {
      mapSearchResultsEl.classList.add("hidden");
      mapSearchResultsEl.innerHTML = "";
    }

    // A pick is "done" — clear the query and drop focus so the bar isn't
    // just sitting there over the freshly-revealed path/symbol. :hover
    // alone would keep it open (the cursor is still over the wrap right
    // after a click), so force-hide it too until the mouse actually
    // leaves the strip; mouseleave below lifts that so hovering again
    // later works exactly as before.
    if (mapSearchInput) {
      mapSearchInput.value = "";
      mapSearchInput.blur();
    }
    mapSearchClearBtn?.classList.add("hidden");
    mapSearchWrap?.classList.add("mw-search-force-hide");
  }

  mapSearchWrap?.addEventListener("mouseleave", () => {
    mapSearchWrap.classList.remove("mw-search-force-hide");
  });

  function resetMapSearchUI() {
    if (mapSearchInput) mapSearchInput.value = "";
    mapSearchClearBtn?.classList.add("hidden");
    if (mapSearchResultsEl) {
      mapSearchResultsEl.classList.add("hidden");
      mapSearchResultsEl.innerHTML = "";
    }
    mapSearchLastResults = [];
    mapSearchActiveIndex = -1;
    clearMapSearchGlow();
  }

  mapSearchInput?.addEventListener("input", () => {
    mapSearchClearBtn?.classList.toggle("hidden", !mapSearchInput.value);
    renderMapSearchResults();
  });

  mapSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (mapSearchInput.value) {
        mapSearchInput.value = "";
        mapSearchClearBtn?.classList.add("hidden");
        renderMapSearchResults();
      } else {
        mapSearchInput.blur();
      }
      return;
    }
    if (!mapSearchLastResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mapSearchActiveIndex = (mapSearchActiveIndex + 1) % mapSearchLastResults.length;
      updateMapSearchActiveRow();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      mapSearchActiveIndex = (mapSearchActiveIndex - 1 + mapSearchLastResults.length) % mapSearchLastResults.length;
      updateMapSearchActiveRow();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = mapSearchLastResults[mapSearchActiveIndex] || mapSearchLastResults[0];
      selectMapSearchResult(pick);
    }
  });

  mapSearchClearBtn?.addEventListener("click", () => {
    if (!mapSearchInput) return;
    mapSearchInput.value = "";
    mapSearchClearBtn.classList.add("hidden");
    mapSearchInput.focus();
    renderMapSearchResults();
  });

  // Prevent a click/drag starting inside the search bar or its results
  // from being read as a map pan.
  mapSearchWrap?.addEventListener("mousedown", (e) => e.stopPropagation());
  mapSearchWrap?.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  symbolsBtn?.addEventListener("click", () => {
    optionsPanel?.classList.add("hidden");
    pathsPanel?.classList.add("hidden");
    symbolsPanel?.classList.toggle("hidden");
    // See the matching comment on pathsBtn's handler above — without this,
    // switching here from deep within a scrolled Settings panel leaves the
    // symbols panel scrolled out of view (only the map below it shows).
    win.scrollTop = 0;
  });

  placeSymbolBtn?.addEventListener("click", () => {
    if (pendingPlaceSymbol) {
      cancelPlacingSymbol();
      return;
    }
    if (!activeMapId) {
      if (symbolHintEl) {
        symbolHintEl.textContent = "Select or upload a map first.";
        symbolHintEl.classList.remove("hidden");
      }
      return;
    }
    openSymbolPicker(
      placeSymbolBtn,
      null,
      (symbol) => {
        if (symbol) beginPlacingSymbol(symbol);
      },
      { title: "Choose a symbol to place", clearLabel: "✖ Cancel" }
    );
  });

  window.addEventListener("mousemove", (e) => {
    if (!draggingSymbolMarker || !activeMapId) return;
    const marker = symbolsFor(activeMapId).find((m) => m.id === draggingSymbolMarker.id);
    if (!marker) return;
    symbolMarkerDragMoved = true;
    const pt = clientToPercent(e.clientX, e.clientY);
    marker.xPercent = pt.xPercent;
    marker.yPercent = pt.yPercent;
    renderSymbols();
  });

  window.addEventListener("mouseup", () => {
    if (!draggingSymbolMarker) return;
    draggingSymbolMarker = null;
    saveSymbols();
  });

  viewport?.addEventListener("mousemove", (e) => {
    if (!isDrawing) return;
    rubberPoint = clientToPercent(e.clientX, e.clientY);
    renderPaths();
  });

  viewport?.addEventListener("dblclick", (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    finishDrawing();
  });

  // Places a draft point while drawing, or deselects the current path
  // when clicking empty map space. Guarded against firing at the end of
  // a click-drag pan (see lastPanMoved) and against clicks already
  // handled by a marker, path line, or vertex (which stopPropagation).
  viewport?.addEventListener("click", (e) => {
    if (lastPanMoved) {
      lastPanMoved = false;
      return;
    }
    if (e.target.closest(".map-marker") || e.target.closest(".mw-path-vertex") || e.target.closest(".mw-path-hit") || e.target.closest(".map-symbol-marker")) return;
    if (!imageEl.getAttribute("src")) return;
    const pt = clientToPercent(e.clientX, e.clientY);
    if (pendingPlaceSymbol) {
      symbolsFor(activeMapId).push({
        id: uuid(),
        xPercent: pt.xPercent,
        yPercent: pt.yPercent,
        symbol: pendingPlaceSymbol,
        label: "",
        scale: SYMBOL_SCALE_DEFAULT,
        labelScale: LABEL_SCALE_DEFAULT,
        labelHidden: false,
      });
      saveSymbols();
      cancelPlacingSymbol();
      renderSymbols();
      renderSymbolsList();
      return;
    }
    if (isDrawing) {
      addDraftPoint(pt);
      return;
    }
    if (selectedPathId || editingPathId) {
      selectedPathId = null;
      editingPathId = null;
      renderPaths();
      renderPathsList();
    }
    if (editingSymbolId) {
      editingSymbolId = null;
      renderSymbols();
      renderSymbolsList();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!isMapWindowActive) return;
    if (pendingPlaceSymbol && e.key === "Escape") {
      e.preventDefault();
      cancelPlacingSymbol();
      return;
    }
    if (isDrawing) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (draftPoints.length >= 2) finishDrawing();
        else if (drawHintEl) drawHintEl.textContent = "Add at least 2 points before finishing.";
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelDrawing();
      }
    } else if ((selectedPathId || editingPathId) && e.key === "Escape") {
      selectedPathId = null;
      editingPathId = null;
      closeSymbolPicker();
      renderPaths();
      renderPathsList();
    } else if (editingSymbolId && e.key === "Escape") {
      editingSymbolId = null;
      closeSymbolPicker();
      renderSymbols();
      renderSymbolsList();
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!draggingVertex || !activeMapId) return;
    const path = pathsFor(activeMapId).find((p) => p.id === draggingVertex.pathId);
    if (!path) return;
    vertexDragMoved = true;
    const prevSymbol = path.points[draggingVertex.index]?.symbol;
    const next = clientToPercent(e.clientX, e.clientY);
    if (prevSymbol) next.symbol = prevSymbol;
    path.points[draggingVertex.index] = next;
    renderPaths();
  });

  window.addEventListener("mouseup", () => {
    if (!draggingVertex) return;
    draggingVertex = null;
    savePaths();
  });

  /* ----------------------------------------------------------------------
     SAVE IMAGE — flattens the currently loaded map image together with
     every marker/path/symbol drawn on it into one PNG, so the edits
     become a permanent part of the picture instead of a separate overlay
     that only exists inside this app. The canvas is sized to the image's
     own natural aspect ratio — since a marker/path/symbol's stored
     xPercent/yPercent is now always "percent of the full image" (see the
     FIT MODE block), it lines up pixel-for-pixel with no dependency on
     today's viewport shape, fit mode, or pan/zoom.
  ---------------------------------------------------------------------- */
  const MW_FLATTEN_MIN_DIMENSION = 1600; // export resolution floor, independent of the source image size

  // Loads a fresh, CORS-enabled copy of a twemoji URL so it can be drawn
  // onto a canvas without tainting it (cdnjs/jsDelivr both serve these
  // with permissive CORS headers). Falls through the same URL list
  // mwEmojiUrls() builds; resolves null if every candidate fails.
  function loadCanvasSafeImage(urls) {
    return new Promise((resolve) => {
      if (!urls || !urls.length) {
        resolve(null);
        return;
      }
      let i = 0;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => {
        i += 1;
        if (i < urls.length) img.src = urls[i];
        else resolve(null);
      };
      img.src = urls[i];
    });
  }

  async function drawSymbolOnCanvas(ctx, symbol, cx, cy, sizePx) {
    const img = await loadCanvasSafeImage(mwEmojiUrls(symbol));
    if (img) {
      ctx.drawImage(img, cx - sizePx / 2, cy - sizePx / 2, sizePx, sizePx);
      return;
    }
    // Twemoji unreachable (offline, blocked host…) — fall back to the
    // plain Unicode glyph via the system emoji font so the export still
    // has *something* at this point rather than a gap.
    ctx.save();
    ctx.font = `${Math.round(sizePx * 0.85)}px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, cx, cy);
    ctx.restore();
  }

  // Reads the real, CSS-declared font-size of a label pill by briefly
  // rendering an invisible probe with the same class, instead of guessing
  // a pixel value — so the label-size slider's "100%" always matches
  // whatever map-window.css actually defines, however that changes.
  let mwLabelBaseFontPxCache = null;
  function getLabelBaseFontPx() {
    if (mwLabelBaseFontPxCache != null) return mwLabelBaseFontPxCache;
    let size = 12;
    try {
      const probe = document.createElement("span");
      probe.className = "map-symbol-marker-label";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.textContent = "x";
      document.body.appendChild(probe);
      const computed = parseFloat(getComputedStyle(probe).fontSize);
      if (computed > 0) size = computed;
      probe.remove();
    } catch (err) {
      /* fall back to the 12px default above */
    }
    mwLabelBaseFontPxCache = size;
    return size;
  }

  function drawPillLabel(ctx, text, cx, topY, canvasW) {
    if (!text) return;
    const fontSize = Math.max(11, Math.round(canvasW * 0.011));
    ctx.save();
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const padX = fontSize * 0.6;
    const metrics = ctx.measureText(text);
    const boxW = metrics.width + padX * 2;
    const boxH = fontSize * 1.6;
    const boxX = cx - boxW / 2;
    ctx.fillStyle = "rgba(20, 24, 30, 0.78)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(boxX, topY, boxW, boxH, boxH / 2);
      ctx.fill();
    } else {
      ctx.fillRect(boxX, topY, boxW, boxH);
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(text, cx, topY + boxH * 0.2);
    ctx.restore();
  }

  // Builds the flattened PNG as a Blob. Returns null if there's nothing
  // loaded to flatten.
  async function buildFlattenedImageBlob() {
    if (!activeMapId || !imageEl.naturalWidth) return null;

    // xPercent/yPercent are always percentages of the full, undistorted
    // map image now (see the FIT MODE block above) — regardless of
    // fit mode, viewport shape, or zoom — so the export canvas is
    // simply the image's own aspect ratio at a resolution floor, and
    // every marker/path/symbol maps onto it directly. No crop/offset
    // replication needed (there's nothing cropped to replicate).
    const imgAspect = imageEl.naturalWidth / imageEl.naturalHeight;
    const canvasW = Math.max(MW_FLATTEN_MIN_DIMENSION, imageEl.naturalWidth);
    const canvasH = Math.round(canvasW / imgAspect);

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageEl, 0, 0, canvasW, canvasH);

    // ---- Paths ----
    const lineWidth = Math.max(2, canvasW * 0.0035);
    pathsFor(activeMapId).forEach((path) => {
      if (path.visible === false || path.points.length < 2) return;
      const pts = path.points.map((p) => [(p.xPercent / 100) * canvasW, (p.yPercent / 100) * canvasH]);
      ctx.save();
      ctx.strokeStyle = path.color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      ctx.restore();
    });

    // ---- Path-point symbols ----
    const pathSymbolSize = canvasW * 0.03;
    for (const path of pathsFor(activeMapId)) {
      if (path.visible === false) continue;
      for (const p of path.points) {
        if (!p.symbol) continue;
        await drawSymbolOnCanvas(ctx, p.symbol, (p.xPercent / 100) * canvasW, (p.yPercent / 100) * canvasH, pathSymbolSize);
      }
    }

    // ---- Standalone symbol markers ----
    for (const marker of symbolsFor(activeMapId)) {
      const size = canvasW * 0.032 * (marker.scale || 1);
      const cx = (marker.xPercent / 100) * canvasW;
      const cy = (marker.yPercent / 100) * canvasH;
      await drawSymbolOnCanvas(ctx, marker.symbol, cx, cy, size);
      if (marker.label) drawPillLabel(ctx, marker.label, cx, cy + size * 0.55, canvasW);
    }

    // ---- Vocabulary markers (dot + label) ----
    const dotR = Math.max(3, canvasW * 0.006);
    markersFor(activeMapId).forEach((marker) => {
      const cx = (marker.xPercent / 100) * canvasW;
      const cy = (marker.yPercent / 100) * canvasH;
      ctx.save();
      ctx.fillStyle = "#e63946";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1.5, dotR * 0.35);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      drawPillLabel(ctx, marker.label || marker.word, cx, cy + dotR + 4, canvasW);
    });

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showSaveStatus(text) {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = text;
    saveStatusEl.classList.remove("hidden");
  }

  /* ----------------------------------------------------------------------
     PORTABLE MAP EXPORT/IMPORT — embeds this map's paths & symbols as a
     JSON payload directly inside the PNG file itself (a standard "iTXt"
     ancillary chunk, keyword "mapWindowData"). That makes the exported
     PNG self-contained: export it, hand it to someone else or just
     re-import it later (even in a different browser/profile), and
     "Upload Image…" recognizes the embedded data and restores the paths
     & symbols as live, still-editable data — not baked-in pixels like
     the "Save Map Image" flatten button above produces.

     Only PNG carries this (iTXt is a PNG-specific chunk type), which is
     why export always converts to PNG first — a JPG/WEBP source is
     re-encoded (losslessly, from the already-decoded pixels) rather than
     skipping the embed. Ancillary chunks like iTXt are, by the PNG spec,
     safe to carry through unknown to any reader/editor that doesn't
     understand them — but not every image tool preserves *unrecognized*
     chunks when it re-saves a file, so the guarantee is "round-trips
     through this app" rather than "survives every external editor".
  ---------------------------------------------------------------------- */
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_DATA_KEYWORD = "mapWindowData";

  const CRC_TABLE = (function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function isPngBytes(bytes) {
    if (bytes.length < 8) return false;
    return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  }

  // Walks a PNG's chunk list, calling onChunk(type, dataBytes, chunkStartOffset)
  // for each one. Stops after IEND (or once onChunk returns true, to bail early).
  function forEachPngChunk(bytes, onChunk) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8; // past the 8-byte signature
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) break; // truncated/corrupt — stop
      const data = bytes.subarray(dataStart, dataEnd);
      const stop = onChunk(type, data, offset);
      if (stop || type === "IEND") break;
      offset = dataEnd + 4; // past the 4-byte CRC
    }
  }

  function buildPngChunk(type, data) {
    const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crc = crc32(chunk.subarray(4, 8 + data.length));
    view.setUint32(8 + data.length, crc);
    return chunk;
  }

  // iTXt payload: keyword \0 compressionFlag(0) compressionMethod(0) langTag\0 translatedKeyword\0 UTF-8 text
  function buildITxtChunkData(keyword, text) {
    const enc = new TextEncoder();
    const keywordBytes = enc.encode(keyword);
    const textBytes = enc.encode(text);
    const data = new Uint8Array(keywordBytes.length + 5 + textBytes.length); // keyword + [null, flag, method, langTag-null, translatedKeyword-null] + text
    let o = 0;
    data.set(keywordBytes, o);
    o += keywordBytes.length;
    data[o++] = 0; // null after keyword
    data[o++] = 0; // compression flag
    data[o++] = 0; // compression method
    data[o++] = 0; // empty language tag, null-terminated
    data[o++] = 0; // empty translated keyword, null-terminated
    data.set(textBytes, o);
    return data;
  }

  // Inserts an iTXt chunk (right after IHDR, the first "safe" spot) carrying
  // JSON for the given mapId's paths & symbols. Returns a new Uint8Array —
  // the input bytes are never mutated.
  function embedMapDataInPng(pngBytes, mapId) {
    if (!isPngBytes(pngBytes)) return pngBytes;
    const payload = JSON.stringify({
      v: 1,
      source: "mapWindow",
      mapId,
      paths: pathsFor(mapId),
      symbols: symbolsFor(mapId),
    });
    const chunk = buildPngChunk("iTXt", buildITxtChunkData(PNG_DATA_KEYWORD, payload));

    let insertAt = null;
    forEachPngChunk(pngBytes, (type, data, chunkStart) => {
      if (type === "IHDR") {
        insertAt = chunkStart + 8 + data.length + 4; // just after IHDR's chunk (incl. its CRC)
        return true; // stop walking, we have what we need
      }
      return false;
    });
    if (insertAt == null) insertAt = 8; // fallback: right after the signature

    const out = new Uint8Array(pngBytes.length + chunk.length);
    out.set(pngBytes.subarray(0, insertAt), 0);
    out.set(chunk, insertAt);
    out.set(pngBytes.subarray(insertAt), insertAt + chunk.length);
    return out;
  }

  // Reads an iTXt/tEXt chunk with our keyword back out of a PNG. Returns
  // the parsed { paths, symbols } object, or null if this PNG doesn't
  // carry one (an image never exported by this app, most likely).
  function extractMapDataFromPng(pngBytes) {
    if (!isPngBytes(pngBytes)) return null;
    let found = null;
    forEachPngChunk(pngBytes, (type, data) => {
      if (type !== "iTXt" && type !== "tEXt") return false;
      // Both chunk types start with "keyword\0" — locate that first.
      let nul = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
          nul = i;
          break;
        }
      }
      if (nul === -1) return false;
      const keyword = new TextDecoder("latin1").decode(data.subarray(0, nul));
      if (keyword !== PNG_DATA_KEYWORD) return false;

      let textBytes;
      if (type === "tEXt") {
        textBytes = data.subarray(nul + 1);
      } else {
        // iTXt: compressionFlag, compressionMethod, langTag\0, translatedKeyword\0, then text
        let p = nul + 1;
        const compressed = data[p] === 1;
        p += 2; // skip compressionFlag + compressionMethod
        while (p < data.length && data[p] !== 0) p++;
        p++; // past language tag's null
        const tkStart = p;
        while (p < data.length && data[p] !== 0) p++;
        p++; // past translated keyword's null
        textBytes = data.subarray(p);
        if (compressed) return false; // we never write compressed text; skip if we somehow see it
      }
      try {
        const text = new TextDecoder("utf-8").decode(textBytes);
        const parsed = JSON.parse(text);
        if (parsed && parsed.source === "mapWindow") found = parsed;
      } catch {
        /* not our chunk / corrupt — ignore */
      }
      return !!found;
    });
    return found;
  }

  // Decodes any image Blob/File to a fresh PNG Uint8Array via canvas —
  // used so JPG/WEBP uploads can still be exported with embedded data
  // (PNG is the only format here that carries a text chunk).
  async function blobToPngBytes(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await pngBlob.arrayBuffer());
  }

  function showExportStatus(text) {
    if (!exportDataStatusEl) return;
    exportDataStatusEl.textContent = text;
    exportDataStatusEl.classList.remove("hidden");
  }

  // Export always asks which folder, via the native folder picker — this
  // is deliberately independent of the persistently-connected mapDirHandle
  // (that one stays silent, used for the background auto-sync and for
  // opening maps). Writes both `<mapId>.<ext>` and `<mapId>.json` into
  // whichever folder is picked, so the pair stays together wherever it
  // lands. Returns { ok, folderName } on success, or null if the picker
  // isn't supported, was cancelled, or the write failed.
  async function exportBundleToPickedFolder(id, bundle) {
    if (!mwSupportsFileSystemAccess) return null;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Map Window: export folder pick failed:", err);
      return null;
    }
    const granted = await verifyMapFolderPermission(handle, true);
    if (!granted) return null;
    try {
      const meta = mapsMeta.find((m) => m.id === id);
      const imgBlob = await readMapImage(id, meta?.ext);
      if (imgBlob) {
        const ifh = await handle.getFileHandle(mapFileName(id, meta?.ext), { create: true });
        const iw = await ifh.createWritable();
        await iw.write(imgBlob);
        await iw.close();
      }
      const jfh = await handle.getFileHandle(mapJsonFileName(id), { create: true });
      const jw = await jfh.createWritable();
      await jw.write(JSON.stringify(bundle, null, 2));
      await jw.close();
      return { ok: true, folderName: handle.name };
    } catch (err) {
      console.warn("Map Window: couldn't write the export to the chosen folder:", err);
      return null;
    }
  }

  // Feature 2: bundles the active map's markers/paths/symbols/ratio into
  // `<mapId>.json` (plus its image) and exports to whichever destination(s)
  // are ticked beneath the button — a folder the person picks fresh every
  // time, and/or the Drive folder chosen in the dropdown. With neither
  // ticked (or nothing available), it falls back to a plain JSON download
  // so the data is never stranded.
  async function exportActiveMapBundle() {
    if (!activeMapId) return;
    const wantLocal = !!exportLocalCheckbox?.checked;
    const wantDrive = usingCloudStorage && !!exportDriveCheckbox?.checked;
    exportDataBtn.disabled = true;
    showExportStatus(wantLocal && mwSupportsFileSystemAccess ? "Choose a folder to export to…" : "Exporting…");
    try {
      const bundle = buildMapBundle(activeMapId);
      const folderResult = wantLocal ? await exportBundleToPickedFolder(activeMapId, bundle) : null;
      const wroteDrive = wantDrive
        ? await pushMapBundleToDrive(activeMapId, bundle, { withImage: true, folderId: mwDriveExportFolderId })
        : false;

      if (!folderResult && !wroteDrive) {
        downloadBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }), mapJsonFileName(activeMapId));
        const driveFailedNote = wantDrive ? ` Google Drive export failed — check your connection and Drive folder selection.` : "";
        showExportStatus(
          wantDrive
            ? `Downloaded "${mapJsonFileName(activeMapId)}" instead.${driveFailedNote}`
            : `Downloaded "${mapJsonFileName(activeMapId)}" — tick "Local folder" or "Save to Drive" above to export directly next time.`
        );
      } else {
        const parts = [];
        if (folderResult) parts.push(`image + "${mapJsonFileName(activeMapId)}" saved to "${folderResult.folderName}"`);
        if (wroteDrive) parts.push(`image + metadata pushed to Google Drive${mwDriveExportFolderName ? ` ("${mwDriveExportFolderName}")` : " (My Drive)"}`);
        showExportStatus(`Exported — ${parts.join(" and ")}.`);
      }
    } catch (err) {
      console.error("Map Window: export failed:", err);
      showExportStatus("Couldn't export that map — see the console for details.");
    } finally {
      exportDataBtn.disabled = !activeMapId;
    }
  }

  // ---- Export destination UI: Drive checkbox visibility + folder picker ----
  // The Drive tick (and folder row beneath it) only ever show once Drive is
  // actually connected — mirrors how the main vocabulary export's "Save to
  // Drive" checkbox behaves. Refreshed each time the settings panel opens,
  // since map-window.js has no live event feed for script.js's connect/
  // disconnect actions.
  const MW_NEW_DRIVE_FOLDER_VALUE = "__new__";
  let mwDriveFolderListPromise = null;

  function populateDriveFolderSelect(folders) {
    if (!exportDriveFolderSelect) return;
    exportDriveFolderSelect.innerHTML = "";
    const rootOpt = document.createElement("option");
    rootOpt.value = "";
    rootOpt.textContent = "My Drive (root)";
    exportDriveFolderSelect.appendChild(rootOpt);
    folders.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      exportDriveFolderSelect.appendChild(opt);
    });
    const newOpt = document.createElement("option");
    newOpt.value = MW_NEW_DRIVE_FOLDER_VALUE;
    newOpt.textContent = "➕ New folder…";
    exportDriveFolderSelect.appendChild(newOpt);

    // Re-select whatever was chosen last time, if it still exists in the
    // list; otherwise fall back to the root.
    const stillExists = mwDriveExportFolderId && folders.some((f) => f.id === mwDriveExportFolderId);
    exportDriveFolderSelect.value = stillExists ? mwDriveExportFolderId : "";
    if (!stillExists && mwDriveExportFolderId) {
      mwDriveExportFolderId = "";
      mwDriveExportFolderName = "";
      localStorage.removeItem(MW_DRIVE_EXPORT_FOLDER_ID_STORAGE);
      localStorage.removeItem(MW_DRIVE_EXPORT_FOLDER_NAME_STORAGE);
    }
  }

  // ensureFolder: a { id, name } just created via the "+ New folder…"
  // prompt below. Drive's files.list can lag a moment before a just-created
  // folder shows up in query results (eventual consistency) — without this,
  // that race would make populateDriveFolderSelect think the freshly
  // created folder doesn't exist yet and silently fall back the selection
  // to "My Drive (root)", right after the person picked a specific folder.
  async function refreshDriveFolderSelect(ensureFolder) {
    if (!exportDriveFolderSelect || !usingCloudStorage) return;
    try {
      const folders = await driveListFolders();
      if (ensureFolder && ensureFolder.id && !folders.some((f) => f.id === ensureFolder.id)) {
        folders.unshift(ensureFolder);
      }
      populateDriveFolderSelect(folders);
    } catch (err) {
      console.warn("Map Window: couldn't list Drive folders:", err);
      showExportStatus("Couldn't load your Drive folders — check your connection and try again.");
    }
  }

  function setMwDriveExportFolder(id, name) {
    mwDriveExportFolderId = id || "";
    mwDriveExportFolderName = name || "";
    if (mwDriveExportFolderId) {
      localStorage.setItem(MW_DRIVE_EXPORT_FOLDER_ID_STORAGE, mwDriveExportFolderId);
      localStorage.setItem(MW_DRIVE_EXPORT_FOLDER_NAME_STORAGE, mwDriveExportFolderName);
    } else {
      localStorage.removeItem(MW_DRIVE_EXPORT_FOLDER_ID_STORAGE);
      localStorage.removeItem(MW_DRIVE_EXPORT_FOLDER_NAME_STORAGE);
    }
  }

  exportDriveFolderSelect?.addEventListener("change", async () => {
    const val = exportDriveFolderSelect.value;
    if (val !== MW_NEW_DRIVE_FOLDER_VALUE) {
      const label = exportDriveFolderSelect.selectedOptions[0]?.textContent || "";
      setMwDriveExportFolder(val, val ? label : "");
      return;
    }
    const name = window.prompt("Name for the new Google Drive folder:", "");
    if (!name || !name.trim()) {
      exportDriveFolderSelect.value = mwDriveExportFolderId || "";
      return;
    }
    exportDriveFolderSelect.disabled = true;
    try {
      const id = await driveCreateFolder(name.trim());
      setMwDriveExportFolder(id, name.trim());
      await refreshDriveFolderSelect({ id, name: name.trim() });
    } catch (err) {
      console.error("Map Window: couldn't create Drive folder:", err);
      alert("Couldn't create that folder in Drive — see the console for details.");
      exportDriveFolderSelect.value = mwDriveExportFolderId || "";
    } finally {
      exportDriveFolderSelect.disabled = false;
    }
  });

  function updateExportDriveVisibility() {
    exportDriveCheckWrap?.classList.toggle("hidden", !usingCloudStorage);
    if (!usingCloudStorage && exportDriveCheckbox) exportDriveCheckbox.checked = false;
    const showFolderRow = usingCloudStorage && !!exportDriveCheckbox?.checked;
    exportDriveFolderRow?.classList.toggle("hidden", !showFolderRow);
    if (showFolderRow && !mwDriveFolderListPromise) {
      mwDriveFolderListPromise = refreshDriveFolderSelect().finally(() => {
        mwDriveFolderListPromise = null;
      });
    }
  }

  exportDriveCheckbox?.addEventListener("change", updateExportDriveVisibility);

  function updateSaveButtonState() {
    if (saveImageBtn) saveImageBtn.disabled = !activeMapId || !imageEl.getAttribute("src");
    if (exportDataBtn) exportDataBtn.disabled = !activeMapId || !imageEl.getAttribute("src");
  }

  async function saveFlattenedMapImage() {
    if (!activeMapId) return;
    const meta = mapsMeta.find((m) => m.id === activeMapId);
    showSaveStatus("Flattening image…");
    saveImageBtn.disabled = true;
    try {
      const blob = await buildFlattenedImageBlob();
      if (!blob) {
        showSaveStatus("Nothing to save — load a map image first.");
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${activeMapId}-flattened-${stamp}.png`;

      if (usingMapDiskStorage && mapDirHandle) {
        const fh = await mapDirHandle.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        downloadBlob(blob, filename);
      }

      const replace = confirm(
        "Saved a flattened copy with the markers, paths, and symbols baked in.\n\n" +
        "Also make this the map's image going forward, so those edits show up every time you open this map? " +
        "(The original uploaded image is kept as the backup file just saved.)"
      );
      if (replace) {
        const newExt = "png";
        await storeMapImage(activeMapId, newExt, blob);
        if (meta) {
          meta.ext = newExt;
          saveMapsMeta();
        }
        if (currentObjectUrl) {
          URL.revokeObjectURL(currentObjectUrl);
        }
        currentObjectUrl = URL.createObjectURL(blob);
        imageEl.src = currentObjectUrl;
        showSaveStatus(
          usingMapDiskStorage && mapDirHandle
            ? `Saved — this map now uses the flattened image, and a backup lives in your folder as "${filename}".`
            : `Saved — this map now uses the flattened image. A backup copy downloaded as "${filename}".`
        );
      } else {
        showSaveStatus(
          usingMapDiskStorage && mapDirHandle
            ? `Saved "${filename}" to your folder. The active map image is unchanged.`
            : `Downloaded "${filename}". The active map image is unchanged.`
        );
      }
    } catch (err) {
      console.error("Map Window: failed to save flattened image:", err);
      showSaveStatus("Couldn't save the image — see the console for details.");
    } finally {
      updateSaveButtonState();
    }
  }

  saveImageBtn?.addEventListener("click", saveFlattenedMapImage);
  exportDataBtn?.addEventListener("click", exportActiveMapBundle);

  /* ----------------------------------------------------------------------
     MAPS — switching, uploading, deleting (Feature 3)
  ---------------------------------------------------------------------- */
  function populateRegionSelect() {
    if (!regionSelect) return;
    const prevValue = activeMapId || "";
    regionSelect.innerHTML = `<option value="">No map selected…</option>` +
      mapsMeta.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join("");
    regionSelect.value = prevValue;
  }

  async function setActiveMap(id) {
    activeMapId = id || null;
    try {
      if (activeMapId) localStorage.setItem(MW_ACTIVE_MAP_STORAGE, activeMapId);
      else localStorage.removeItem(MW_ACTIVE_MAP_STORAGE);
    } catch {
      /* non-fatal */
    }
    if (regionSelect) regionSelect.value = activeMapId || "";
    updateFitModeUI();

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    // Switching maps mid-draw or with a path selected/unlocked would
    // leave stale points/handles pointing at the wrong map, so clear all.
    exitDrawMode();
    selectedPathId = null;
    editingPathId = null;
    editingSymbolId = null;
    cancelPlacingSymbol();
    closeColorWheel();
    closeSymbolPicker();
    resetMapSearchUI();

    // Feature 3, part 3: dynamic view switching resets pan/zoom to fit
    // the newly loaded image cleanly, every time — including on clear.
    resetView();

    if (!activeMapId) {
      imageEl.removeAttribute("src");
      emptyStateEl?.classList.remove("hidden");
      renderMarkers();
      renderPaths();
      renderPathsList();
      renderSymbols();
      renderSymbolsList();
      updateSaveButtonState();
      return;
    }

    const activeMeta = mapsMeta.find((m) => m.id === activeMapId);
    const blob = await readMapImage(activeMapId, activeMeta?.ext);
    if (!blob) {
      emptyStateEl.textContent = "This map's image couldn't be loaded — it may have been cleared from browser storage.";
      emptyStateEl?.classList.remove("hidden");
      imageEl.removeAttribute("src");
      renderMarkers();
      renderPaths();
      renderPathsList();
      renderSymbols();
      renderSymbolsList();
      updateSaveButtonState();
      return;
    }

    currentObjectUrl = URL.createObjectURL(blob);
    imageEl.src = currentObjectUrl;
    emptyStateEl?.classList.add("hidden");
    renderMarkers();
    renderPaths();
    renderPathsList();
    renderSymbols();
    renderSymbolsList();
    updateSaveButtonState();
  }

  async function addCustomMap(label, file) {
    const id = ensureUniqueId(slugify(label || file.name.replace(/\.[^.]+$/, "")));
    const ext = extFromFile(file);
    const stored = await storeMapImage(id, ext, file);
    if (!stored.ok) return stored;
    mapsMeta.push({ id, label: label || file.name, ext });
    saveMapsMeta();
    if (usingMapDiskStorage && mapDirHandle) await writeMapJsonToFolder(id, buildMapBundle(id));
    populateRegionSelect();
    await setActiveMap(id);
    return { ok: true, id };
  }

  function ensureUniqueId(base) {
    let id = base;
    let n = 2;
    const existing = new Set(mapsMeta.map((m) => m.id));
    while (existing.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    return id;
  }

  async function deleteActiveMap() {
    if (!activeMapId) return;
    const id = activeMapId;
    const meta = mapsMeta.find((m) => m.id === id);
    await deleteMapImage(id, meta?.ext);
    await deleteMapJsonFromFolder(id);
    if (usingCloudStorage) {
      driveDeleteFileByName(driveMapJsonFileName(id));
      driveDeleteFileByName(driveMapFileName(id, meta?.ext));
    }
    mapsMeta = mapsMeta.filter((m) => m.id !== id);
    delete markersByMap[id];
    delete pathsByMap[id];
    delete symbolsByMap[id];
    saveMapsMeta();
    saveJson(MW_MARKERS_STORAGE, markersByMap);
    saveJson(MW_PATHS_STORAGE, pathsByMap);
    saveJson(MW_SYMBOLS_STORAGE, symbolsByMap);
    populateRegionSelect();
    await setActiveMap(mapsMeta[0]?.id || null);
  }

  regionSelect?.addEventListener("change", () => setActiveMap(regionSelect.value || null));

  uploadBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      showUploadStatus("Please choose a PNG, JPG, or WEBP image.");
      return;
    }
    showUploadStatus("Uploading…");

    // If this is a PNG previously exported via "Export Portable Map", it
    // carries its own paths & symbols — pull those out before storing,
    // so they can be attached to the new map id below.
    let embeddedData = null;
    if (/^image\/png$/i.test(file.type)) {
      try {
        embeddedData = extractMapDataFromPng(new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        console.warn("Map Window: couldn't inspect PNG for embedded path/symbol data:", err);
      }
    }

    const label = uploadNameInput?.value.trim() || file.name.replace(/\.[^.]+$/, "");
    const result = await addCustomMap(label, file);
    if (result.ok && embeddedData) {
      if (Array.isArray(embeddedData.paths) && embeddedData.paths.length) {
        pathsByMap[result.id] = embeddedData.paths;
        savePaths();
      }
      if (Array.isArray(embeddedData.symbols) && embeddedData.symbols.length) {
        symbolsByMap[result.id] = embeddedData.symbols;
        saveSymbols();
      }
      renderPaths();
      renderPathsList();
      renderSymbols();
      renderSymbolsList();
    }
    showUploadStatus(
      result.ok
        ? `"${label}" added and set as the active map.` +
          (embeddedData ? ` Restored ${embeddedData.paths?.length || 0} path(s) and ${embeddedData.symbols?.length || 0} symbol(s) from the file.` : "")
        : result.message
    );
    if (result.ok && uploadNameInput) uploadNameInput.value = "";
  });

  function showUploadStatus(text) {
    if (!uploadStatusEl) return;
    uploadStatusEl.textContent = text;
    uploadStatusEl.classList.remove("hidden");
  }

  /* ----------------------------------------------------------------------
     IMPORT (Feature 4) — bring in a map bundle (image + `<mapId>.json`)
     from disk or from Google Drive. Either way it's written into the
     connected folder (or IndexedDB/localStorage, per Feature 5's
     fallback) and immediately injected into the live state so it's fully
     editable, exactly like any other map.
  ---------------------------------------------------------------------- */
  function showImportStatus(text) {
    if (!importStatusEl) return;
    importStatusEl.textContent = text;
    importStatusEl.classList.remove("hidden");
  }

  // Shared by both import paths: stores the image, applies the bundle's
  // markers/paths/symbols/ratio to live state, registers it in mapsMeta,
  // mirrors it into the folder if one's connected, and makes it active.
  async function finishMapImport(imageBlobOrFile, ext, bundle) {
    const id = ensureUniqueId(slugify(bundle?.id || bundle?.label || "imported-map"));
    const stored = await storeMapImage(id, ext, imageBlobOrFile);
    if (!stored.ok) return stored;
    const label = bundle?.label || id;
    applyMapBundle(id, { ...bundle, id, ext });
    mapsMeta.push({ id, label, ext });
    saveMapsMeta();
    if (usingMapDiskStorage && mapDirHandle) await writeMapJsonToFolder(id, buildMapBundle(id));
    populateRegionSelect();
    await setActiveMap(id);
    return { ok: true, id, label };
  }

  // A file counts as the JSON sidecar if it's named/typed as JSON; anything
  // else that matches the accepted image types counts as the image. This
  // lets the user ctrl/cmd-click both files in a single native dialog
  // instead of clicking through two separate pickers.
  function isJsonFile(file) {
    return /\.json$/i.test(file.name || "") || file.type === "application/json";
  }
  function isImageFile(file) {
    return /\.(png|jpe?g|webp)$/i.test(file.name || "") || /^image\//.test(file.type || "");
  }

  importDiskBtn?.addEventListener("click", () => importFilesInput?.click());

  importFilesInput?.addEventListener("change", async () => {
    const files = Array.from(importFilesInput.files || []);
    importFilesInput.value = "";
    if (!files.length) return;

    const jsonFiles = files.filter(isJsonFile);
    const imageFiles = files.filter((f) => isImageFile(f) && !isJsonFile(f));

    if (!imageFiles.length && !jsonFiles.length) {
      showImportStatus("Couldn't recognize those files — pick one map image (.png/.jpg/.webp) and its .json metadata file together.");
      return;
    }
    if (!imageFiles.length) {
      showImportStatus("Missing the map image — select it together with the .json file (ctrl/cmd-click both in the picker).");
      return;
    }
    if (!jsonFiles.length) {
      showImportStatus("Missing the .json metadata file — select it together with the map image (ctrl/cmd-click both in the picker).");
      return;
    }
    if (imageFiles.length > 1 || jsonFiles.length > 1) {
      showImportStatus("Pick just one image and one .json file at a time — select exactly that pair and try again.");
      return;
    }

    const imageFile = imageFiles[0];
    const jsonFile = jsonFiles[0];
    showImportStatus("Importing…");
    try {
      const bundle = JSON.parse(await jsonFile.text());
      if (!bundle || typeof bundle !== "object") {
        showImportStatus("Couldn't import — the .json file isn't a valid map bundle exported from this app.");
        return;
      }
      const ext = extFromFile(imageFile);
      const result = await finishMapImport(imageFile, ext, bundle);
      showImportStatus(
        result.ok
          ? `Imported "${result.label}" — it's now the active map, fully editable.`
          : result.message || "Couldn't import that pair."
      );
    } catch (err) {
      console.error("Map Window: import from disk failed:", err);
      showImportStatus("Couldn't import — make sure the .json file is a valid map bundle exported from this app.");
    }
  });

  importDriveBtn?.addEventListener("click", async () => {
    if (!usingCloudStorage) {
      showImportStatus("Connect Google Drive first (Storage settings, above the vocabulary table) to import from there.");
      return;
    }
    showImportStatus("Looking up map bundles saved to Drive…");
    try {
      const files = await driveListMapBundles();
      if (!files.length) {
        showImportStatus("No map bundles found in Drive yet — export one from another device first.");
        importDriveSelect?.classList.add("hidden");
        importDriveConfirmBtn?.classList.add("hidden");
        return;
      }
      if (importDriveSelect) {
        importDriveSelect.innerHTML = files
          .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name.replace(/^mapwindow-/, "").replace(/\.json$/i, ""))}</option>`)
          .join("");
        importDriveSelect.classList.remove("hidden");
      }
      importDriveConfirmBtn?.classList.remove("hidden");
      showImportStatus(`Found ${files.length} map bundle${files.length === 1 ? "" : "s"} in Drive — pick one, then confirm.`);
    } catch (err) {
      console.error("Map Window: Drive list failed:", err);
      showImportStatus("Couldn't reach Google Drive — see the console for details.");
    }
  });

  importDriveConfirmBtn?.addEventListener("click", async () => {
    const fileId = importDriveSelect?.value;
    if (!fileId) return;
    showImportStatus("Downloading from Drive…");
    try {
      const bundle = await driveDownloadJson(fileId);
      const ext = bundle?.ext || "png";
      const imgName = driveMapFileName(bundle?.id || "map", ext);
      const imgFileId = await driveFindFileIdByName(imgName);
      if (!imgFileId) {
        showImportStatus("Found the metadata but couldn't find its matching image file in Drive.");
        return;
      }
      const blob = await driveDownloadBinary(imgFileId);
      const result = await finishMapImport(blob, ext, bundle);
      importDriveSelect?.classList.add("hidden");
      importDriveConfirmBtn?.classList.add("hidden");
      showImportStatus(
        result.ok
          ? `Imported "${result.label}" from Drive — it's now the active map, fully editable.`
          : result.message || "Couldn't import that map."
      );
    } catch (err) {
      console.error("Map Window: Drive import failed:", err);
      showImportStatus("Couldn't import from Drive — see the console for details.");
    }
  });

  /* ----------------------------------------------------------------------
     IMPORT FROM DRIVE — GOOGLE PICKER (Feature 4b)
     ------------------------------------------------------------------
     The "Import from Drive (app-saved)" flow above only ever finds files
     this app itself already wrote to Drive — under the drive.file scope
     it's granted, that's the *only* thing it's allowed to see, by design
     (the app can never browse someone's whole Drive on its own). A map
     bundle saved by hand into a folder — uploaded through Drive's own
     website, or moved there after the fact — was never touched by this
     app, so it's invisible to that flow no matter how it's searched.

     Google's Picker is the standard fix: it's Google's own file browser,
     running with the person's full Drive visibility, and whatever they
     explicitly select inside it becomes visible to the app's existing
     drive.file token from that point on — permanently, for those exact
     files. So the person can navigate into their own folder, ctrl/cmd-
     click the image and its .json together, and this app can then read
     just those two files through the very same driveApiFetch() calls
     used everywhere else on this page.
  ---------------------------------------------------------------------- */
  let mwGapiScriptPromise = null;
  // The <script> tag for apis.google.com/js/api.js in index.html loads with
  // async/defer, so it can still be in flight — or not yet started — the
  // moment someone clicks "Browse Drive Folder". Rather than fail on that
  // race, wait for it: reuse the existing tag if it's there (attaching a
  // load listener works whether it's still loading or about to start),
  // otherwise inject one on demand.
  function loadGapiScript() {
    if (window.gapi) return Promise.resolve();
    if (mwGapiScriptPromise) return mwGapiScriptPromise;
    mwGapiScriptPromise = new Promise((resolve, reject) => {
      if (window.gapi) {
        resolve();
        return;
      }
      let script = document.querySelector('script[src="https://apis.google.com/js/api.js"]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://apis.google.com/js/api.js";
        document.head.appendChild(script);
      }
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("Couldn't load Google's API script — check your internet connection.")),
        { once: true }
      );
      // Belt-and-suspenders in case neither event ever fires (e.g. the tag
      // already finished loading before this listener attached).
      setTimeout(() => {
        if (window.gapi) resolve();
        else reject(new Error("Timed out waiting for Google's API script to load — check your internet connection and try again."));
      }, 15000);
    }).catch((err) => {
      mwGapiScriptPromise = null; // let a retry try again
      throw err;
    });
    return mwGapiScriptPromise;
  }

  let mwPickerApiPromise = null;
  function loadDrivePickerApi() {
    if (window.google?.picker) return Promise.resolve();
    if (mwPickerApiPromise) return mwPickerApiPromise;
    mwPickerApiPromise = loadGapiScript()
      .then(
        () =>
          new Promise((resolve, reject) => {
            gapi.load("picker", {
              callback: () => resolve(),
              onerror: () => reject(new Error("Couldn't load Google Picker.")),
            });
          })
      )
      .catch((err) => {
        mwPickerApiPromise = null; // let a retry try loading again
        throw err;
      });
    return mwPickerApiPromise;
  }

  // The Picker wants the Cloud project's numeric app ID, which is just
  // the digits before the first "-" in the OAuth Client ID already used
  // to connect Drive.
  function driveAppIdFromClientId() {
    const clientId = typeof getDriveClientId === "function" ? getDriveClientId() : "";
    return (clientId.split("-")[0] || "").trim();
  }

  function isJsonPickerDoc(doc) {
    return /\.json$/i.test(doc?.name || "") || doc?.mimeType === "application/json";
  }
  function isImagePickerDoc(doc) {
    return /^image\//.test(doc?.mimeType || "") || /\.(png|jpe?g|webp)$/i.test(doc?.name || "");
  }

  async function handleDrivePickerPicked(data) {
    console.log("Map Window: Drive Picker callback fired", data);
    if (data.action !== google.picker.Action.PICKED) return; // cancelled or just loaded
    const docs = data.docs || [];
    console.log("Map Window: Drive Picker docs picked", docs);
    const jsonDocs = docs.filter(isJsonPickerDoc);
    const imageDocs = docs.filter((d) => isImagePickerDoc(d) && !isJsonPickerDoc(d));
    console.log("Map Window: Drive Picker classified", { jsonDocs, imageDocs });

    if (!jsonDocs.length && !imageDocs.length) {
      showImportStatus("Couldn't recognize those files — pick one map image (.png/.jpg/.webp) and its .json metadata file together.");
      return;
    }
    if (!imageDocs.length) {
      showImportStatus("Missing the map image — select it together with the .json file (ctrl/cmd-click both in Drive's picker).");
      return;
    }
    if (!jsonDocs.length) {
      showImportStatus("Missing the .json metadata file — select it together with the map image (ctrl/cmd-click both in Drive's picker).");
      return;
    }
    if (imageDocs.length > 1 || jsonDocs.length > 1) {
      showImportStatus("Pick just one image and one .json file at a time — select exactly that pair and try again.");
      return;
    }

    showImportStatus("Downloading from Drive…");
    try {
      const bundle = await driveDownloadJson(jsonDocs[0].id);
      console.log("Map Window: Drive Picker JSON downloaded", bundle);
      if (!bundle || typeof bundle !== "object") {
        showImportStatus("Couldn't import — that .json file isn't a valid map bundle exported from this app.");
        return;
      }
      const ext = extFromFile({ name: imageDocs[0].name, type: imageDocs[0].mimeType }) || bundle.ext || "png";
      const blob = await driveDownloadBinary(imageDocs[0].id);
      console.log("Map Window: Drive Picker image downloaded", { ext, size: blob?.size, type: blob?.type });
      const result = await finishMapImport(blob, ext, bundle);
      console.log("Map Window: Drive Picker import finished", result);
      showImportStatus(
        result.ok
          ? `Imported "${result.label}" from Drive — it's now the active map, fully editable.`
          : result.message || "Couldn't import that pair."
      );
    } catch (err) {
      console.error("Map Window: Drive Picker import failed:", err);
      showImportStatus("Couldn't import from Drive — see the console for details.");
    }
  }

  function openDriveImportPicker() {
    if (!usingCloudStorage || !driveAccessToken) {
      showImportStatus("Connect Google Drive first (Storage settings, above the vocabulary table) to browse it.");
      return;
    }
    showImportStatus("Opening Google Drive… (loading Google's file picker — may take a moment)");
    loadDrivePickerApi()
      .then(() => {
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setIncludeFolders(true) // lets the person navigate into any folder, including ones they made themselves
          .setSelectFolderEnabled(false) // folders are for navigating into, not selecting as the result
          .setMimeTypes("application/json,text/plain,image/png,image/jpeg,image/webp");
        const appId = driveAppIdFromClientId();
        const builder = new google.picker.PickerBuilder()
          .setOAuthToken(driveAccessToken)
          .addView(view)
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
          .setTitle("Select the map image + its .json file (ctrl/cmd-click both)")
          .setCallback(handleDrivePickerPicked);
        if (appId) builder.setAppId(appId);
        const picker = builder.build();
        picker.setVisible(true);
        showImportStatus("Navigate to the folder, then ctrl/cmd-click the image and its .json file together and click Select.");
      })
      .catch((err) => {
        console.error("Map Window: Drive Picker failed to load:", err);
        showImportStatus("Couldn't open Google Drive's file browser — see the console for details.");
      });
  }

  importDriveBrowseBtn?.addEventListener("click", openDriveImportPicker);

  /* ----------------------------------------------------------------------
     LOCAL FOLDER — connect a real folder on disk for map images to live
     in, instead of (invisible, browser-only) IndexedDB. Same UX pattern
     as the vocab-entries folder connection in script.js.
  ---------------------------------------------------------------------- */
  function updateFolderStatusUI() {
    if (folderStatusEl) {
      folderStatusEl.textContent = usingMapDiskStorage && mapDirHandle
        ? `Connected — map images are saved to the "${mapDirHandle.name}" folder on your computer.`
        : mwSupportsFileSystemAccess
        ? "Not connected — map images are stored in browser storage only. Connect a folder to keep real files on disk."
        : "Your browser doesn't support connecting a local folder (try Chrome or Edge on desktop) — map images stay in browser storage.";
    }
    if (chooseFolderBtn) chooseFolderBtn.textContent = usingMapDiskStorage ? "🗂️ Change Folder…" : "🗂️ Connect Local Folder…";
    const needsReconnect = !!(mapDirHandle && !usingMapDiskStorage);
    reconnectFolderBtn?.classList.toggle("hidden", !needsReconnect);
    folderReconnectBanner?.classList.toggle("hidden", !needsReconnect);
  }

  // Best-effort, silent reconnect attempt — tried every time the map
  // window opens (a real click, so the browser will actually honor a
  // permission re-request off the back of it) so a previously-connected
  // folder keeps working without a trip to Settings. If the browser still
  // won't grant it silently, updateFolderStatusUI() surfaces the banner
  // above the map so reconnecting is one visible click away either way.
  async function maybeAutoReconnectFolder() {
    if (!mwSupportsFileSystemAccess || !mapDirHandle || usingMapDiskStorage) return;
    try {
      const granted = await verifyMapFolderPermission(mapDirHandle, true);
      if (granted) {
        usingMapDiskStorage = true;
        await refreshMapsMetaFromFolder();
        await setActiveMap(activeMapId || mapsMeta[0]?.id || null);
      }
    } catch (err) {
      console.warn("Map Window: auto-reconnect attempt failed:", err);
    }
    updateFolderStatusUI();
  }

  async function chooseMapFolder() {
    if (!mwSupportsFileSystemAccess) {
      updateFolderStatusUI();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const granted = await verifyMapFolderPermission(handle, true);
      if (!granted) {
        showUploadStatus("Permission to that folder was denied, so nothing changed.");
        return;
      }
      mapDirHandle = handle;
      usingMapDiskStorage = true;
      await idbSetMapFolderHandle(handle);
      updateFolderStatusUI();

      // Copy every map already stored in IndexedDB/localStorage into the
      // newly chosen folder — image AND its `<mapId>.json` sidecar — so
      // nothing already uploaded or edited is left behind, and the folder
      // becomes a genuinely complete, portable copy from this point on.
      let migrated = 0;
      for (const m of mapsMeta) {
        try {
          const existing = await mapDirHandle.getFileHandle(mapFileName(m.id, m.ext), { create: false }).then(() => true, () => false);
          if (!existing) {
            const blob = await idbGetImage(m.id);
            if (blob) {
              const ext = m.ext || extFromFile(blob);
              m.ext = ext;
              await storeMapImage(m.id, ext, blob);
              migrated += 1;
            }
          }
          await writeMapJsonToFolder(m.id, buildMapBundle(m.id));
        } catch (err) {
          console.warn(`Map Window: couldn't migrate map "${m.id}" into the new folder:`, err);
        }
      }
      // Folder is now the source of truth — rebuild mapsMeta by scanning
      // it (Feature 1), rather than trusting the in-memory list above.
      await refreshMapsMetaFromFolder();
      showUploadStatus(`Connected! Map images now save to the "${handle.name}" folder${migrated ? ` (${migrated} existing map${migrated === 1 ? "" : "s"} copied over)` : ""}.`);
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("Map Window: folder selection failed:", err);
        showUploadStatus("Couldn't connect to that folder. Nothing was changed.");
      }
    }
  }

  async function reconnectMapFolder() {
    if (!mapDirHandle) return;
    const granted = await verifyMapFolderPermission(mapDirHandle, true);
    usingMapDiskStorage = granted;
    updateFolderStatusUI();
    if (granted) {
      await refreshMapsMetaFromFolder();
      await setActiveMap(activeMapId || mapsMeta[0]?.id || null);
    }
    showUploadStatus(granted ? "Reconnected to your folder." : "Permission wasn't granted — still using browser storage.");
  }

  async function tryRestoreMapFolder() {
    if (!mwSupportsFileSystemAccess) return;
    const handle = await idbGetMapFolderHandle();
    if (!handle) {
      updateFolderStatusUI();
      return;
    }
    mapDirHandle = handle;
    usingMapDiskStorage = await verifyMapFolderPermission(handle, false);
    updateFolderStatusUI();
    if (usingMapDiskStorage) await refreshMapsMetaFromFolder();
  }

  chooseFolderBtn?.addEventListener("click", chooseMapFolder);
  reconnectFolderBtn?.addEventListener("click", reconnectMapFolder);
  reconnectBannerBtn?.addEventListener("click", reconnectMapFolder);

  // Covers the case where the window was already open on page load (so
  // the toggle-button click that normally triggers maybeAutoReconnectFolder
  // never fires): the first real click/tap anywhere in the window is
  // itself a user gesture, so piggyback one silent reconnect attempt on
  // it, then stop listening.
  win.addEventListener(
    "pointerdown",
    () => {
      maybeAutoReconnectFolder();
    },
    { once: true }
  );

  deleteMapBtn?.addEventListener("click", () => {
    if (!activeMapId) return;
    const meta = mapsMeta.find((m) => m.id === activeMapId);
    if (!confirm(`Delete "${meta?.label || activeMapId}"? This removes its image and every marker pinned to it.`)) return;
    deleteActiveMap();
  });

  // Drop-to-upload directly onto the viewport, for convenience alongside
  // the file-input button in the options panel.
  viewport?.addEventListener("dragover", (e) => {
    e.preventDefault();
    viewport.classList.add("mw-drop-hover");
  });
  viewport?.addEventListener("dragleave", () => viewport.classList.remove("mw-drop-hover"));
  viewport?.addEventListener("drop", async (e) => {
    e.preventDefault();
    viewport.classList.remove("mw-drop-hover");
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) return;
    const label = file.name.replace(/\.[^.]+$/, "");
    optionsPanel?.classList.remove("hidden");
    showUploadStatus("Uploading…");
    const result = await addCustomMap(label, file);
    showUploadStatus(result.ok ? `"${label}" added and set as the active map.` : result.message);
  });

  /* ----------------------------------------------------------------------
     WINDOW CHROME — open/close + drag, mirroring the Audio Window
  ---------------------------------------------------------------------- */
  function showWindow() {
    win.classList.remove("hidden");
    requestAnimationFrame(() => {
      win.classList.add("mw-open");
      refreshMapLayout();
    });
    win.setAttribute("aria-hidden", "false");
    maybeAutoReconnectFolder();
  }
  function hideWindow() {
    closeColorWheel();
    win.classList.remove("mw-open");
    win.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (!isMapWindowActive) win.classList.add("hidden");
    }, 220);
  }

  function setMapWindowActive(on) {
    isMapWindowActive = !!on;
    try {
      localStorage.setItem(MW_ACTIVE_STORAGE, String(isMapWindowActive));
    } catch {
      /* non-fatal */
    }
    toggleBtn.setAttribute("aria-pressed", String(isMapWindowActive));
    toggleBtn.classList.toggle("active", isMapWindowActive);
    toggleBtn.title = `Map Window: ${isMapWindowActive ? "ON" : "OFF"}`;
    if (isMapWindowActive) showWindow();
    else hideWindow();
  }

  toggleBtn.addEventListener("click", () => setMapWindowActive(!isMapWindowActive));
  closeBtn?.addEventListener("click", () => setMapWindowActive(false));
  optionsBtn?.addEventListener("click", () => {
    pathsPanel?.classList.add("hidden");
    symbolsPanel?.classList.add("hidden");
    optionsPanel?.classList.toggle("hidden");
    updateExportDriveVisibility();
    // Same fix as the paths/symbols buttons — reopening Settings after
    // leaving it scrolled deep should land back at the top, not wherever
    // the scroll happened to be.
    win.scrollTop = 0;
  });

  /* ----------------------------------------------------------------------
     TOOLBAR VISIBILITY & PLACEMENT — the map-picker/zoom row under the
     header can be hidden entirely, and/or relocated down into the
     settings panel (Map settings ⚙️ → Toolbar). Both are independent,
     persisted booleans; placement just moves the same live DOM node
     between its home slot and the settings slot, so nothing about the
     toolbar's own wiring (region select, zoom buttons) needs to know
     which one is active.
  ---------------------------------------------------------------------- */
  (function initToolbarSettings() {
    if (!toolbarEl) return;

    function isToolbarHidden() {
      try {
        return localStorage.getItem(MW_TOOLBAR_HIDDEN_STORAGE) === "true";
      } catch {
        return false;
      }
    }
    function isToolbarInSettings() {
      try {
        return localStorage.getItem(MW_TOOLBAR_IN_SETTINGS_STORAGE) === "true";
      } catch {
        return false;
      }
    }

    function applyVisibility() {
      toolbarEl.classList.toggle("hidden", isToolbarHidden());
    }

    function applyPlacement() {
      const inSettings = isToolbarInSettings();
      if (inSettings && toolbarSettingsSlot) {
        toolbarSettingsSlot.appendChild(toolbarEl);
        toolbarSettingsSlot.classList.remove("hidden");
      } else {
        if (toolbarHomeParent) {
          if (toolbarHomeNextSibling) toolbarHomeParent.insertBefore(toolbarEl, toolbarHomeNextSibling);
          else toolbarHomeParent.appendChild(toolbarEl);
        }
        toolbarSettingsSlot?.classList.add("hidden");
      }
    }

    if (toolbarHideToggle) {
      toolbarHideToggle.checked = !isToolbarHidden();
      toolbarHideToggle.addEventListener("change", () => {
        try {
          localStorage.setItem(MW_TOOLBAR_HIDDEN_STORAGE, String(!toolbarHideToggle.checked));
        } catch {
          /* non-fatal */
        }
        applyVisibility();
      });
    }

    if (toolbarMoveToggle) {
      toolbarMoveToggle.checked = isToolbarInSettings();
      toolbarMoveToggle.addEventListener("change", () => {
        try {
          localStorage.setItem(MW_TOOLBAR_IN_SETTINGS_STORAGE, String(toolbarMoveToggle.checked));
        } catch {
          /* non-fatal */
        }
        applyPlacement();
      });
    }

    applyVisibility();
    applyPlacement();
  })();

  /* ----------------------------------------------------------------------
     HEADER BAR — size (Compact/Normal/Roomy) and Minimal Header mode.
     Size scales the header's own padding/font/icon dimensions (the
     region a screenshot would circle in orange); Minimal strips the
     bar down to just the drag grip + title + ⚙️ (the region circled in
     blue), hiding the ✕ so the map viewport underneath gets the extra
     height back. Both are independent, persisted settings.
  ---------------------------------------------------------------------- */
  (function initHeaderSettings() {
    if (!headerEl) return;

    function getHeaderSize() {
      try {
        const v = localStorage.getItem(MW_HEADER_SIZE_STORAGE);
        return v === "compact" || v === "roomy" || v === "micro" ? v : "normal";
      } catch {
        return "normal";
      }
    }
    function isHeaderMinimal() {
      try {
        return localStorage.getItem(MW_HEADER_MINIMAL_STORAGE) === "true";
      } catch {
        return false;
      }
    }

    function applyHeaderSize() {
      const size = getHeaderSize();
      headerEl.classList.toggle("mw-header--compact", size === "compact");
      headerEl.classList.toggle("mw-header--roomy", size === "roomy");
      headerEl.classList.toggle("mw-header--micro", size === "micro");
      headerSizeBtns.forEach((btn) => {
        const active = btn.dataset.headerSize === size;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      headerSizeHintEl?.classList.toggle("hidden", size !== "micro");
      applyCloseFallback();
    }

    function applyHeaderMinimal() {
      headerEl.classList.toggle("mw-header--minimal", isHeaderMinimal());
      applyCloseFallback();
    }

    // The ✕ only lives in the header bar itself in the default (Normal/
    // Compact/Roomy, non-minimal) case. Both Minimal Header and the Micro
    // size hide it from the bar, so whenever either is active this button
    // in the settings panel steps in as the way to close the window.
    function applyCloseFallback() {
      const needsFallback = isHeaderMinimal() || getHeaderSize() === "micro";
      settingsCloseBtn?.classList.toggle("hidden", !needsFallback);
    }

    headerSizeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          localStorage.setItem(MW_HEADER_SIZE_STORAGE, btn.dataset.headerSize);
        } catch {
          /* non-fatal */
        }
        applyHeaderSize();
      });
    });

    if (minimalHeaderToggle) {
      minimalHeaderToggle.checked = isHeaderMinimal();
      minimalHeaderToggle.addEventListener("change", () => {
        try {
          localStorage.setItem(MW_HEADER_MINIMAL_STORAGE, String(minimalHeaderToggle.checked));
        } catch {
          /* non-fatal */
        }
        applyHeaderMinimal();
      });
    }

    settingsCloseBtn?.addEventListener("click", () => setMapWindowActive(false));

    applyHeaderSize();
    applyHeaderMinimal();
  })();

  /* ---- Search glow timing settings (Settings → Search glow timing) ----
     Two independent segmented controls — one for paths, one for symbols
     — each backed by its own localStorage key via getGlowDuration()/
     the matching *_GLOW_DURATION_STORAGE constant above. Purely a
     preference: it doesn't touch a glow already in progress, only how
     the *next* search of that type behaves. */
  (function initGlowDurationSettings() {
    const groups = [
      { kind: "path", el: document.getElementById("mw-path-glow-duration-group"), storageKey: MW_PATH_GLOW_DURATION_STORAGE },
      { kind: "symbol", el: document.getElementById("mw-symbol-glow-duration-group"), storageKey: MW_SYMBOL_GLOW_DURATION_STORAGE },
    ];

    groups.forEach(({ kind, el, storageKey }) => {
      if (!el) return;
      const btns = Array.from(el.querySelectorAll("[data-glow-duration]"));

      function applyActive() {
        const current = getGlowDuration(kind);
        btns.forEach((btn) => {
          const active = btn.dataset.glowDuration === current;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-pressed", String(active));
        });
      }

      btns.forEach((btn) => {
        btn.addEventListener("click", () => {
          try {
            localStorage.setItem(storageKey, btn.dataset.glowDuration);
          } catch {
            /* non-fatal — falls back to the default next read */
          }
          applyActive();
        });
      });

      applyActive();
    });
  })();

  (function initDrag() {
    if (!dragHandle) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".icon-btn")) return;
      dragging = true;
      const rect = win.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      win.style.left = `${startLeft}px`;
      win.style.top = `${startTop}px`;
      win.style.right = "auto";
      win.style.bottom = "auto";
      dragHandle.classList.add("mw-dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - win.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - win.offsetHeight);
      win.style.left = `${Math.min(Math.max(0, startLeft + (e.clientX - startX)), maxLeft)}px`;
      win.style.top = `${Math.min(Math.max(0, startTop + (e.clientY - startY)), maxTop)}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      dragHandle.classList.remove("mw-dragging");
      try {
        saveJson(MW_POSITION_STORAGE, { left: win.style.left, top: win.style.top });
      } catch {
        /* non-fatal */
      }
    });
  })();

  /* ----------------------------------------------------------------------
     PUBLIC SURFACE — the only things script.js calls into
  ---------------------------------------------------------------------- */
  function isActive() {
    return isMapWindowActive && !!activeMapId;
  }

  function getActiveMapLabel() {
    return mapsMeta.find((m) => m.id === activeMapId)?.label || "";
  }

  // Called from script.js's aiFetchBtn handler right after a successful
  // enhanceVocabulary() reply. `word` isn't a saved entry yet at this
  // point (the person hasn't clicked "Add Entry"), so the marker is
  // created with entryId: null and later attached via
  // promotePendingMarker() below once the entry is actually saved.
  function ingestAiMapData(word, mapData) {
    if (!isActive() || !mapData) return false;
    const list = markersFor(activeMapId);
    // Replace any earlier pending marker for the same not-yet-saved word
    // rather than piling up duplicates from repeated "Fetch with AI" runs.
    const existingIdx = list.findIndex((m) => m.entryId === null && m.word.toLowerCase() === word.toLowerCase());
    const marker = {
      id: existingIdx === -1 ? uuid() : list[existingIdx].id,
      entryId: null,
      word,
      xPercent: mapData.xPercent,
      yPercent: mapData.yPercent,
      label: mapData.label || word,
    };
    if (existingIdx === -1) list.push(marker);
    else list[existingIdx] = marker;
    saveMarkers();
    renderMarkers();
    return true;
  }

  function promotePendingMarker(word, entryId) {
    if (!word || !entryId) return;
    Object.values(markersByMap).forEach((list) => {
      const marker = list.find((m) => m.entryId === null && m.word.toLowerCase() === word.toLowerCase());
      if (marker) marker.entryId = entryId;
    });
    saveMarkers();
    if (activeMapId) renderMarkers();
  }

  function findMarkerByEntryId(entryId) {
    for (const [mapId, list] of Object.entries(markersByMap)) {
      const marker = list.find((m) => m.entryId === entryId);
      if (marker) return { mapId, marker };
    }
    return null;
  }

  // Resolves once the currently-active map's image has actually decoded
  // (naturalWidth available) — needed before any content-box-dependent
  // centering math, since a just-switched-to map's dimensions aren't
  // known until its "load" event fires (see the imageEl listener above).
  function waitForActiveImageReady() {
    if (!activeMapId || imageEl.naturalWidth || !imageEl.getAttribute("src")) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        imageEl.removeEventListener("load", done);
        imageEl.removeEventListener("error", done);
        resolve();
      };
      imageEl.addEventListener("load", done, { once: true });
      imageEl.addEventListener("error", done, { once: true });
    });
  }

  async function centerOnEntry(entryId) {
    const found = findMarkerByEntryId(entryId);
    if (!found) return;
    if (!isMapWindowActive) setMapWindowActive(true);
    if (found.mapId !== activeMapId) await setActiveMap(found.mapId);
    await waitForActiveImageReady();

    // Center the marker's content point in the viewport at a fixed,
    // readable zoom level.
    const targetScale = clampScale(2.5);
    const contentX = (found.marker.xPercent / 100) * contentW;
    const contentY = (found.marker.yPercent / 100) * contentH;
    const clamped = computeCenterTranslate(contentX, contentY, targetScale);
    scale = targetScale;
    tx = clamped.tx;
    ty = clamped.ty;
    applyTransform();

    const pin = markersLayer.querySelector(`[data-marker-id="${CSS.escape(found.marker.id)}"]`);
    if (pin) {
      pin.classList.add("map-marker-pulse");
      setTimeout(() => pin.classList.remove("map-marker-pulse"), 1200);
    }
  }

  window.MapWindow = {
    isActive,
    getActiveMapLabel,
    ingestAiMapData,
    promotePendingMarker,
    centerOnEntry,
  };

  /* ----------------------------------------------------------------------
     INIT — restore persisted position, on/off state, and active map
  ---------------------------------------------------------------------- */
  (function initPersisted() {
    const pos = loadJson(MW_POSITION_STORAGE, null);
    if (pos?.left && pos?.top) {
      win.style.left = pos.left;
      win.style.top = pos.top;
      win.style.right = "auto";
      win.style.bottom = "auto";
    }
    const savedWidth = parseFloat(localStorage.getItem(MW_WINDOW_WIDTH_STORAGE) || "");
    if (isFinite(savedWidth) && savedWidth > 0) {
      const cap = Math.min(MW_WINDOW_MAX_WIDTH, window.innerWidth - 32);
      win.style.width = `${Math.min(cap, Math.max(MW_WINDOW_MIN_WIDTH, savedWidth))}px`;
    }
    populateRegionSelect();
    updateFolderStatusUI();
    updateFitModeUI();
    tryRestoreMapFolder().then(() => setActiveMap(activeMapId));
    refreshDraftColorSwatch();

    let savedActive = false;
    try {
      savedActive = localStorage.getItem(MW_ACTIVE_STORAGE) === "true";
    } catch {
      savedActive = false;
    }
    setMapWindowActive(savedActive);
  })();
})();
