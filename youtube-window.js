/* =========================================================================
   ▶ FLOATING YOUTUBE WINDOW — a detachable, draggable, resizable mini
   YouTube player, built with the same architectural philosophy as
   map-window.js / the Audio Window in script.js:
     - a single floating panel, hidden by default, toggled from a header
       button (#youtube-window-toggle-btn), same on/off pattern as the
       other two windows
     - a header bar that's the drag handle (mousedown/mousemove/mouseup,
       clamped to the viewport, position persisted to localStorage)
     - a corner resize handle (Pointer Events, clamped to a min/max box,
       size persisted to localStorage)
     - a tiny public surface other code (or the console) can call into:
       window.YouTubeWindow = { open, close, hide, show, toggle,
       loadVideo, search, isOpen, skipAd, transport: { previous, playPause, next } }

   WHY SEARCH NEEDS AN API KEY (AND WHY IT'S NOT AN IFRAME):
   YouTube's own watch/search/results pages send
   `X-Frame-Options: SAMEORIGIN`, so browsers refuse to render them inside
   an iframe on any other site — that's YouTube's clickjacking protection,
   not something this app can override, and the old "load search results
   into the /embed player" trick (listType=search) was deprecated by
   YouTube in 2020 and now errors out. The one page type YouTube *does*
   allow other sites to frame is its dedicated player endpoint,
   /embed/<videoId> (that's the whole point of "Share → Embed"), which is
   what this file uses for actual playback.
   So a real, in-window, thumbnailed results list needs the official
   YouTube Data API v3 `search.list` endpoint instead — free (no paid
   tier required, generous daily quota), but it does need a key the
   person creates themselves in Google Cloud Console, same "bring your
   own credentials" pattern this app already uses for the AI features.
   Once a key is saved (⚙ in the header), searches render right here as
   a clickable results list — nothing ever opens a new tab. Pasted
   video links/IDs always work instantly with no key needed, since
   loading a *known* video ID is just an /embed/ URL.

   WHY "ERROR 153" HAPPENS (AND WHY IT CAN'T BE FIXED FROM INSIDE THIS
   FILE): the embedded player validates the page that's framing it by
   reading the browser's HTTP Referer header. A page opened as a local
   file — file:///C:/…/index.html, as opposed to http://… — never sends
   a Referer at all, because there's no URL to send. YouTube's player
   then reports "embedder.identity.missing.referrer", surfaced to people
   as "Error 153: Video player configuration error". No iframe attribute,
   referrerpolicy value, or JS workaround changes that: there's simply no
   referrer to hand over. Below, `isFileProtocol` checks for exactly this
   case up front and skips the doomed embed attempt, showing a single
   short line in the status bar (see `showStatus` in `loadVideo`) instead
   of letting people hit YouTube's own cryptic error screen.

   PLAYBACK PERSISTENCE: the "hide" (▤) button does NOT remove the player
   or set display:none on it — either would suspend/stop the video in
   most browsers. Instead the panel is visually shrunk to nothing
   (opacity 0, 2×2px, non-interactive) while staying "on screen" as far
   as the browser's rendering/media pipeline is concerned, so the video
   keeps playing while the person goes back to their vocabulary list.
   The "close" (✕) button is the real stop: it tears the player down.

   PLAYER ENGINE: uses the official YouTube IFrame Player API (not a bare
   <iframe src="…">) so this file can drive real playback state — needed
   for the Loop toggle (re-seeking to 0 on end) and for keeping the play
   indicator accurate. The API script is loaded once, lazily, the first
   time a video actually plays.

   WHAT THIS WINDOW DELIBERATELY DOES NOT DO, AND WHY:
     - Like / Subscribe / Save to playlist: these are account actions —
       YouTube requires the *person's own* Google sign-in (OAuth) to
       perform them, an API key alone can't. Building that would mean
       standing up a full Google OAuth consent flow. Instead, the ↗
       button opens the real video on youtube.com in a new tab, signed
       in as the person already is there, where those actions exist.
     - Downloading videos: not implemented, on purpose — it runs against
       YouTube's Terms of Service. The ↗ button is the honest path back
       to YouTube's own (Premium) offline/download features for anyone
       who has them.
   ========================================================================= */

/* =========================================================================
   ARCHITECTURE MAP — YouTube Window upgrade (multi-part effort)
   -------------------------------------------------------------------------
   This file is the single home for all YouTube functionality. No second
   window, API-key system, settings panel, or performance-monitor hook
   gets created anywhere else — everything below extends what already
   exists here. This map records, for each planned component, where it
   already lives (reuse) or where it will be added (new) as the work
   proceeds across parts. Nothing in this block changes behavior; it's
   orientation for whoever (human or Claude) picks up the next part.

     1. YouTube API layer     — DONE (Part 2). Centralized in the "YOUTUBE
        API LAYER" block below as `ytFetch()` + the `YTApi` object
        (searchVideos/searchChannels/getChannel/getChannelUploadsPlaylist/
        getPlaylistVideos/getVideoDetails/getVideoStatistics). The old
        apiGet() and resolveUploadsPlaylistId() are gone — runApiSearch()
        and findChannelVideo() now call YTApi exclusively. No raw fetch()
        against googleapis.com exists anywhere else in this file.
     2. Search state          — currently implicit (closure vars like
        pendingQuery/pendingChannelQuery). A richer UI (tabs, filters,
        sort, paging) needs an explicit state object (query, kind,
        filters, sortOrder, pageToken, results) rather than more loose
        variables — new, alongside the existing `let` declarations.
     3. Video search           — DONE for the base case (Part 3). Explicit
        `searchState` object (query/nextPageToken/items/loadedIds),
        runApiSearch()/loadMoreResults()/renderResultsList() render rich
        cards (thumbnail, title, channel, published date, description
        snippet, video ID, view count, duration, live/upcoming) via
        YTApi.searchVideos() + one batched YTApi.getVideoDetails() call
        per page for duration/views. Filters/sort (order=, videoDuration=)
        still pass straight through `opts` in searchVideos() but have no
        UI yet — future part, not this one.
     4. Channel search         — DONE (Part 4). A second explicit state
        object, `channelSearchState` (mirrors `searchState`'s shape:
        query/nextPageToken/items/loadedIds/loadingMore), driven by the
        new Videos/Channels tabs in the footer (`activeSearchMode`).
        `runChannelSearch()`/`loadMoreChannelResults()` call
        YTApi.searchChannels() then batch-enrich each page with
        YTApi.getChannelsDetails() (new — channels.list, part=statistics,
        up to 50 IDs/request, same chunking pattern as getVideoDetails)
        for subscriber/video/view counts. parseChannelInput() +
        searchChannels() (the `query` branch inside
        getChannelUploadsPlaylist) are unchanged and untouched by this —
        that remains the single-result lookup the oldest/newest finder
        uses; this is a separate, standalone "browse channels" list.
     5. Channel detail         — DONE (Part 4). New #yw-channel-detail
        view (a 4th `setView()` state alongside empty/results/video),
        populated by `openChannelDetail()` via YTApi.getChannel(id,
        "snippet,statistics,contentDetails") — contentDetails is fetched
        now (even though this part doesn't use it) so Part 5's channel
        video browser can reuse the same cached response for the uploads
        playlist ID instead of firing a second channels.list call.
     6. Channel video browsing — DONE (Part 5). New `channelVideosState`
        object (own query-less twin of `searchState`'s shape: playlistId/
        nextPageToken/items/loadedIds/loadingMore, plus a `status` flag
        for the loading/error/loaded/empty states the spec calls for).
        `loadChannelVideosPage()` reads `selectedChannel.uploadsPlaylistId`
        (resolved once, in Part 4's channels.list call, and cached — see
        component 5) via YTApi.getPlaylistVideos(), then batches
        YTApi.getVideoDetails() for the fetched page's IDs — never
        search.list, per the spec's quota-efficiency requirement. Renders
        into a dedicated sub-container inside the channel detail view
        (own render function, `renderChannelVideosSection()`) so paging
        doesn't re-render — and doesn't scroll-jump — the channel header
        above it. findChannelVideo()'s own playlistItems + single-item
        logic is untouched; this is a new, parallel "browse everything"
        path built the same way, not a replacement.
     7. Sorting                — DONE (Part 6). Channel video browser:
        Newest/Oldest/Most popular via `channelVideosState.sortOrder` —
        see PART 6 NOTES. Video search: Relevance/Newest/Most popular via
        `searchState.order`, passed straight through as search.list's own
        `order` param (relevance/date/viewCount) — no client-side
        resorting needed there, since the API's ordering is already
        authoritative for a live query. General search intentionally has
        no "Oldest" — YouTube's API has no such native ordering, and
        Part 6 doesn't fake one; see PART 6 NOTES.
     8. Pagination             — DONE (Part 3), made robust (Part 7).
        `searchState.nextPageToken` is preserved between an initial
        search and each "Load more"/scroll trigger; `searchState.loadedIds`
        (a Set) guards every append against duplicates, including the
        occasional one-item overlap YouTube's own paging can produce
        at a page boundary. findChannelVideo("oldest")'s page-to-the-end
        loop is unrelated (it already keeps nothing) and is untouched.
        `channelSearchState` mirrors this exactly for the Channels tab.
        `channelVideosState` had its own version already (Part 5/6). Part 7
        adds: infinite scroll (on top of, not instead of, "Load more") for
        both search tabs; a `requestId` generation counter on all three
        state objects so a stale response from a superseded search/sort/
        channel can never overwrite newer results (see PART 7 NOTES);
        and `prevPageToken` bookkeeping. Backward paging still has no UI —
        not needed until a future part wants a "back a page" control
        instead of the current forward-only append.
     9. Video URL parsing      — DONE (Part 8). `parseVideoUrlInput()` is
        now the source of truth (watch/shorts/embed/live, youtu.be,
        nocookie, www./m./music. variants, http/https/no-scheme, bare
        ID) — see PART 8 NOTES for the three-way "id" / "invalid" /
        "text" classification it adds on top of the earlier id-or-null
        version. `extractVideoId()` still exists, now as a thin wrapper
        over it, so `loadVideo()` and any other id-only caller are
        unchanged.
    10. Embedded player        — loadPlayerApi()/mountPlayer()/
        destroyPlayer()/onPlayerStateChange(). Already the real IFrame
        Player API (not a bare iframe), which is what makes Loop and the
        play indicator possible. Extends cleanly for future controls
        (seek, playback rate, related-video queueing) via the same
        `player` instance.
    11. API quota tracking     — DONE (Part 2). `quotaState`, persisted to
        `vocabRegister_youtubeQuotaUsage`, keyed by UTC day, tracking
        estimatedUnits/apiCalls/cacheHits/dedupPrevented separately (per
        the spec's "request made vs cached vs duplicate prevented"
        distinction). Surfaced as one line in the existing settings
        panel (#yw-quota-status, added to index.html) and via
        `window.YouTubeWindow.getApiUsage()` — no new widget.
    12. Caching                — DONE (Part 2). `ytCache`, an in-memory
        Map keyed by endpoint+params (same shape as map-window.js's
        symbol-glow-color cache), with per-endpoint TTLs in
        `YW_CACHE_TTL`. In-flight requests are separately deduped via
        `ytInFlight` so two identical concurrent calls share one fetch.
    13. Error handling         — DONE for the API layer (Part 2).
        `classifyYtError()` sorts every failure into invalid_key /
        quota_exceeded / network_error / malformed_response / api_error,
        each with one plain-language sentence; renderResultsError()/
        showStatus() still do the on-screen rendering, unchanged.
    14. Playlists (music-player upgrade) — DONE for data/architecture
       only (Playlist Part 1 of a separate six-part effort layered on
       top of everything above — NOT the same "Part" numbering as
       components 1-13 above; see "PLAYLIST FOUNDATION NOTES" at the
       very end of this header comment for specifics). `playlists`
       (persistent definitions) + `playbackState` (queue position/
       repeat/shuffle, persisted separately) + the queue-math functions
       (getActivePlaylist/getCurrentQueueItem/buildPlaybackQueue/
       getNextQueueIndex/getPreviousQueueIndex/playPlaylistItem/
       startPlaylist/stopPlaylist/setRepeatMode/setShuffleEnabled) live
       in a new "PLAYLISTS" block placed right after LOAD VIDEO.
       Playlist Part 2A (library view, creation, rename/delete, and the
       playlist detail shell) is DONE — see the "PLAYLIST UI" block
       immediately after "PLAYLISTS" in this file, and the PART 2A NOTES
       right after the PLAYLIST FOUNDATION NOTES below. Playlist Part 2B1
       (adding videos to a playlist from a search result's own "+ Add"
       or the current video's header "+ Add to Playlist", zero extra API
       calls either way) is DONE — see the "ADD TO PLAYLIST" block right
       after the ⋮ playlist-row menu, and the PART 2B1 NOTES after the
       PART 2A NOTES below. Playlist Part 2B2 (per-item Play now/Play
       next/Move up/Move down/Move to top/Move to bottom/Remove, the
       up-next temporary queue, and windowed rendering so a multi-
       thousand-item playlist never creates more than a screenful of DOM
       nodes) is DONE — see the "LARGE PLAYLIST RENDERING" block and the
       per-item ⋮ menu right after "playlist detail" inside "PLAYLIST UI",
       and the PART 2B2 NOTES after the PART 2B1 NOTES below. This closes
       out the whole Playlist Part 2 effort. Playlist Part 3 (full
       playback engine), Part 4A (smart shuffle/repeat), and Part 4B
       (transport keyboard shortcuts) are also DONE — see PLAYLIST PART 3
       NOTES / PLAYLIST PART 4A NOTES below. Playlist Part 5
       (unlimited-scale performance, persistence, and quota protection —
       lazy batched metadata enrichment, storage-failure handling, and
       local JSON export/import) is DONE — see PLAYLIST PART 5 NOTES,
       the last section before this comment closes.

   RISKS / CONFLICTS FOUND DURING THIS AUDIT (see Part 1 summary for the
   full writeup):
     - The CSP's script-src was missing https://www.youtube.com, so the
       IFrame Player API script that mountPlayer() injects would have
       been silently blocked — fixed in index.html as part of this pass
       (additive allowlist entry only; no other directive touched).

   PART 2 NOTES:
     - apiGet() and resolveUploadsPlaylistId() (flagged as duplicate-risk
       in Part 1) are removed; runApiSearch() and findChannelVideo() now
       call YTApi exclusively, so there is exactly one request path.
     - getChannelUploadsPlaylist() also shaves a request off the old
       handle/username path: the old code always did a bare
       `channels.list?part=id` lookup followed by a second
       `part=contentDetails,snippet` lookup by the resolved id, even for
       a known handle. YTApi.getChannel() fetches both parts in the same
       call when the identifier (handle/username/id) is already known,
       cutting that path from 2 channels.list calls to 1.
     - getVideoDetails()/getVideoStatistics() are implemented and batch
       up to 50 IDs per request, per the spec — but nothing calls them
       yet, since no UI shows per-video metadata or stats today. They're
       ready for Part 3+ once result cards need that data, so that
       feature never fires one request per card.

   PART 3 NOTES (video search):
     - New `searchState` object replaces the bare "did we search" implied
       state with query/nextPageToken/items/loadedIds/loadingMore — see
       component 2 above. `resetSearchState()` starts fresh on every
       genuine new search; `loadMoreResults()` is the only thing that
       extends it, using the same request path (YTApi.searchVideos with
       a pageToken) and the same dedup guard.
     - Result cards now call YTApi.getVideoDetails(ids, { parts:
       "contentDetails,statistics" }) once per page of (up to 8) fresh
       IDs — one extra request per search/page, not one per card — for
       duration + view count. Title/channel/published date/description/
       live-or-upcoming all come free from the search.list response
       already in hand, no extra request needed.
     - loadVideo() already left #yw-results untouched when playing a
       result (it only ever hid it via setView), so search results were
       already preserved in the DOM after a click — this part adds a
       small "◀ Results" pill (created lazily in ensureBackToResultsBtn())
       over the player so that preserved state is actually reachable
       again, instead of only surviving invisibly until the next search.
     - Empty-query submission now shows a status line instead of
       silently no-op'ing, per the spec's "empty query" state.

   PART 4 NOTES (channel search + channel detail):
     - New Videos/Channels tabs (#yw-tab-videos-btn / #yw-tab-channels-btn)
       above the search bar set `activeSearchMode`, which only decides
       (a) what the search form's Enter/submit does and (b) which of the
       two state objects gets rendered into #yw-results. It never clears
       either state object, so flipping tabs back and forth is always
       non-destructive — see `switchSearchMode()`.
     - `channelSearchState` is a full duplicate of `searchState`'s shape
       (query/nextPageToken/items/loadedIds/loadingMore) rather than a
       shared object with a "kind" flag, specifically so the two searches
       can never bleed into each other — the spec's "must not corrupt
       existing video-search state" requirement.
     - `selectedChannel` is separate again from both search states: which
       channel (if any) is open in detail view, independent of what's in
       either results list. `close()` now resets all three.
     - Channel result cards intentionally do NOT show a handle — the
       search.list (type=channel) response has no `customUrl` field, only
       channels.list does, and fetching that per-card would mean one
       extra request per result. The spec's list-card field set (thumb,
       name, ID, description, subscriber/video/view counts) doesn't need
       it; the detail view fetches full channels.list snippet anyway and
       shows the handle there.
     - Bug fix, pre-existing (not part of the Part 4 spec, but blocking
       it): `findChannelVideo()` (the "Channel: oldest/newest video"
       mini-tool below) called a `renderResults()` function that was
       never defined anywhere in this file — presumably orphaned by an
       earlier refactor. Added a small `renderResults()` shim that shapes
       raw items through `shapeResultRow()` and hands them to
       `renderResultsList()`, matching the pattern `runApiSearch()` uses.

   PART 5 NOTES (channel video browser):
     - Data path follows the spec exactly: `selectedChannel.uploadsPlaylistId`
       (resolved by Part 4's channels.list call, already cached 6 hr under
       `YW_CACHE_TTL.channelLookup`) → YTApi.getPlaylistVideos() (cached
       2 min) → one batched YTApi.getVideoDetails() call per fresh page
       for duration + views. No search.list call anywhere in this path —
       playlistItems.list is 1 unit vs. search.list's 100, which is the
       whole reason the spec calls this out.
     - `channelVideosState` is intentionally NOT reset by
       `backToChannelResults()` — leaving a channel's video list intact
       when you back out is what makes reopening the same channel feel
       instant (a straight cache-and-state hit, no refetch) rather than
       starting the browse over. It IS reset the moment a *different*
       channel is opened (`startChannelVideosForSelected()` checks
       `channelVideosState.channelId` against the newly selected one).
     - Pagination uses both a "Load more" button and scroll-triggered
       infinite loading on the channel-detail panel itself (it's already
       the one scrollable region in this view) — the spec allows either
       and prefers infinite scroll where it fits; here it fits, so both
       are wired to the same `loadChannelVideosPage({ more: true })`,
       which is guarded by `loadingMore`/`nextPageToken` either way, so
       a fast scroll can't fire the request twice.
     - The video list re-renders through its own sub-container
       (`#yw-channel-videos-section`, filled by
       `renderChannelVideosSection()`) rather than by re-running
       `renderChannelDetail()` on every page — paging in a list that's
       nested inside a scrolling panel must not reset that panel's
       scroll position back to the top after every "Load more".
     - The existing "◀ Results" pill (Part 3, over the video player) now
       reads context: `lastResultsContext` records whether the video
       being played came from a video search or a channel's video list,
       so the pill can say "◀ Channel" and return to
       `renderChannelDetail()` (video list, scroll state, and all, since
       nothing was torn down) instead of always assuming a video search.
     - Sorting is a visible, inert placeholder only (Newest / Oldest /
       Most popular buttons that show a "coming in Part 6" status message
       and change nothing) — the spec is explicit that real sorting is
       Part 6's job, not this one.

   PART 6 NOTES (sorting):
     - Video search (`searchState`): three real sort modes — Relevance
       (default; no `order` param is sent, so search.list uses its own
       default), Newest (`order=date`), Most popular (`order=viewCount`)
       — all native YouTube Data API orderings, so no client-side
       resorting is needed, and "Load more" always re-sends the same
       `order` the person picked so a page can't drift into a different
       ordering mid-scroll. There is deliberately no "Oldest" for general
       search: the Data API has no ascending-date order, and faking one
       by paging to the end of an open-ended, unbounded search result set
       (unlike a single channel's finite uploads list) isn't something
       this app can do accurately, so it isn't offered.
       `searchState.order` persists across a person's *next* typed search
       too (mirrors how the channel sort choice persists across channels
       below) rather than silently resetting to Relevance every time. The
       sort row itself only renders when `searchState.sortable` is true —
       false for the single-item "channel oldest/newest" mini-tool's
       result (via the `renderResults()` shim), since a sort control over
       one video is meaningless.
     - Channel videos (`channelVideosState`): Newest keeps Part 5's
       existing cheap incremental paging (`loadChannelVideosPage()`,
       playlistItems.list 10 at a time) — the uploads playlist already
       arrives newest-first, but every fetched page is still explicitly
       resorted client-side by `snippet.publishedAt` before rendering,
       per the spec's "use actual publication dates, don't rely on card
       arrival order." Oldest and Most popular both need the *entire*
       uploads playlist before a single row can be placed correctly,
       since neither ordering is knowable from any one page in isolation
       — `loadFullChannelPlaylist()` pages playlistItems.list all the way
       to the end (the same 400-page/20,000-video guard the existing
       channel oldest/newest finder already uses). Oldest then sorts
       ascending on the free `publishedAt` already in hand from that
       traversal — no extra request. Most popular additionally needs
       every video's view count, which only videos.list exposes, so it
       makes one pass over every fetched ID in batches of 50 (never one
       request per video) for `contentDetails,statistics` together, sorts
       descending on `viewCount`, and caches the enriched, sorted list so
       paging through it afterward costs nothing further. Oldest
       deliberately does NOT do that full-catalog stats pass up front —
       it only enriches (duration/views) the 10 rows about to be shown,
       batched, the moment "Load more" reveals them — so sorting a
       channel oldest-first and never scrolling far never pays for stats
       on videos that are never displayed.
     - Both Oldest and Most popular still render through the existing
       `channelVideosState.items` / `renderChannelVideosSection()` path —
       "Load more" beyond the first reveal is a local slice-and-enrich of
       the already-fetched full list (`revealMoreFromFullList()`), not a
       new network page, so paging can never drift out of the order
       already established.
     - If a channel's uploads playlist is bigger than the 400-page guard,
       `channelVideosState.truncated` is set and a banner is shown above
       the video list (Oldest/Most popular only) explaining the ordering
       is only established over the videos actually scanned — per the
       spec's "don't claim globally accurate results the implementation
       can't guarantee." Newest is unaffected; it never needed the whole
       catalog to begin with.
     - Switching sort (`changeChannelSort()`) always fully resets
       `channelVideosState` (via the now sort-aware
       `resetChannelVideosState()`) before starting the new sort's fetch
       — the same "don't mix results from different sorting modes"
       requirement Part 5 already applied to a channel switch now also
       applies to a live sort change. The chosen sort persists across
       channels (like `searchState.order` persists across searches)
       rather than reverting to Newest every time a different channel is
       opened.
     - The channel sort buttons (`#yw-channel-sort`, in
       `renderChannelDetail()`'s static markup) are no longer inert — the
       `not-allowed` cursor and "coming in Part 6" tooltip are gone from
       the CSS/markup, and clicking one calls `changeChannelSort()`
       directly. The active-button highlight is kept in sync separately,
       via the new `reflectChannelSortUI()`, rather than by re-running
       the whole `renderChannelDetail()` on every click — a sort change
       shouldn't repaint the channel header/stats or reset the panel's
       scroll position, the same reasoning Part 5 already applied to
       plain pagination.

   PART 7 NOTES (robust pagination / infinite loading):
     - Scope: video search (`searchState`) and channel search
       (`channelSearchState`) previously only had a "Load more" button and
       no protection against a stale response landing after a newer
       search/sort had already replaced it. `channelVideosState` (channel
       video browser) already had solid pagination from Parts 5/6 —
       infinite scroll AND "Load more", a `loadingMore` re-entry guard, and
       a hand-rolled channelId/sortOrder staleness check in
       `startFullListSort()` — but that staleness check didn't cover
       `loadChannelVideosPage()`'s "newest" path at all, and
       `revealMoreFromFullList()` had no re-entry guard against rapid
       repeated scrolling. This part closes every one of those gaps and
       brings all three state objects onto the same pattern.
     - RACE CONDITIONS — the `requestId` generation counter: each of
       `searchState`, `channelSearchState`, and `channelVideosState` now
       carries a `requestId` that its reset function (`resetSearchState()`
       / `resetChannelSearchState()` / `resetChannelVideosState()`) bumps
       and returns. Every async fetch against that state captures the
       ID *before* its first `await` and re-checks `state.requestId ===
       myRequestId` after every subsequent await, before touching state or
       re-rendering. A mismatch means a newer search, sort change, or
       channel switch already reset things — the in-flight response is
       simply dropped. This is what makes "search A, then search B before
       A resolves, then A's slow response finally arrives" leave B's
       results on screen untouched, instead of a coin-flip on whichever
       response lands last (the pre-Part-7 behavior for the two search
       states). `loadMoreResults()`/`loadMoreChannelResults()` (which
       don't reset, so don't bump the counter themselves) capture
       whatever generation is current at their own start, for the same
       reason — a "Load more" started just before a brand-new search must
       never append its page onto the new search's unrelated results.
     - INFINITE SCROLL for both search tabs: one scroll listener on
       `resultsEl` (already the single scrollable container either tab
       renders into — `.yw-results { overflow-y: auto }`), routed by
       `activeSearchMode`, added once at setup — not per-render, so it can
       never accumulate duplicate listeners across searches. It calls the
       exact same `loadMoreResults()` / `loadMoreChannelResults()` the
       "Load more" button already called, and those functions' own
       `loadingMore`/`nextPageToken` guards mean a fast scroll and a
       button click (or two fast scroll events) can never both fire a
       duplicate request for the same page — same reasoning Part 5 already
       applied to the channel video browser's own scroll listener.
       "Load more" buttons are kept, not replaced — they still render
       whenever there's a next page, both as a fallback for anyone who
       doesn't scroll (results that already fit on screen) and as an
       explicit affordance some people just prefer.
     - END OF RESULTS: all three footers now read exactly "No more
       results" once `nextPageToken` comes back empty, instead of the
       previous "— end of results —" styling — same meaning, wording
       matched to the spec. Nothing about *when* that state is reached
       changed: it's still driven by the absence of `nextPageToken` in
       YouTube's own response, so the app stops requesting further pages
       the moment YouTube says there aren't any, never before and never
       after.
     - `prevPageToken` is now captured from every search/channel-search
       response (`searchState.prevPageToken` / `channelSearchState.
       prevPageToken`) alongside `pageToken` (the token that produced the
       page currently on screen), per the spec's full state list — neither
       is consumed by any UI yet, since there's still no "back a page"
       control (unchanged from Part 3's note on this).
     - PERFORMANCE: every network call this part touches or adds is now
       wrapped in `perfTimeAsync()` (script.js's pass-through into
       perf-monitor.js, a no-op if that file isn't loaded) under a
       descriptive category — "YouTube Video Search", "…— Load More",
       "YouTube Channel Search", "…— Load More", "YouTube Channel Videos",
       "…— Reveal", "…— Full Sort Scan" — so the 📊 performance panel's
       Detailed Report breaks pagination cost out same as every other
       instrumented feature. Page sizes are unchanged (8 for both
       searches, 10 for channel videos) — plenty small enough that no
       additional DOM virtualization is needed for the "don't render
       thousands of nodes at once" requirement.

   PART 8 NOTES (direct video URL handling — quota-free playback):
     - THE CORE REQUIREMENT: pasting a recognized YouTube video URL (or a
       bare 11-char ID) must play the video with ZERO Data API calls —
       no search.list, no videos.list. This was already mostly true going
       into this part (search() already special-cased a successfully
       extracted ID by calling loadVideo() directly, which only ever
       builds a local /embed/<id> URL — see loadVideo()'s own header
       comment), so the main gap this part closes is the *invalid* case:
       previously, a YouTube video URL with a missing/malformed ID (e.g.
       "youtube.com/watch" with no `v=`, or a truncated one) fell through
       silently into a plain-text search.list call using the mangled URL
       as the query string — wasted quota, and a confusing wall of
       irrelevant results instead of the "clear error" the spec calls for.
     - `parseVideoUrlInput()` (replacing the old id-or-null
       `extractVideoId()` as the thing `search()` calls) returns one of
       three kinds — "id" (play it, zero quota), "invalid" (recognizably
       a youtube.com/youtu.be *video* URL shape — /watch, /embed/,
       /shorts/, /live/, or a bare youtu.be path — whose ID didn't
       validate), or "text" (anything else, including non-video YouTube
       URLs like channel links, and links to other sites entirely) — so
       `search()` can react correctly to each: "id" → `loadVideo()`
       immediately; "invalid" → a `showStatus()` error and a hard return,
       never reaching `runApiSearch()`; "text" → the existing search path,
       completely unchanged, including the existing "no API key yet"
       settings-panel prompt.
     - `extractVideoId()` is kept, now implemented as a one-line wrapper
       around `parseVideoUrlInput()` that collapses back to the old
       id-or-null shape — `loadVideo()` (called both from pasted input and
       from every existing result-card click across search/channel-videos)
       only ever needs the ID, never the three-way distinction, so it and
       every other pre-existing call site are unaffected by this part.
     - VALIDATION HARDENING alongside the "invalid" case: the URL parser
       now explicitly rejects any non-http/https scheme before it gets
       anywhere near host/path inspection (`url.protocol !== "http:" &&
       url.protocol !== "https:"` → treated as plain text, never as a
       candidate for ID extraction), on top of the pre-existing ID regex
       validation. Nothing here ever concatenates user input into an
       iframe `src` directly — the only path to `mountPlayer()` is a
       video ID that has already passed `VIDEO_ID_RE`, which is what the
       spec's "do not insert user-provided iframe URLs directly" means in
       practice for this file.
     - NORMAL SEARCH TEXT is protected the same way it always was, now
       explicit rather than incidental: `parseVideoUrlInput()` only
       attempts a `new URL()` parse when the input has an explicit scheme
       or is a single whitespace-free token containing a dot — an ordinary
       multi-word query (which may itself contain a stray "." or "/") is
       classified "text" before it ever reaches the URL parser, so it
       reaches `runApiSearch()` exactly as before.
     - UX: a pasted link now shows the recognized ID briefly in the status
       line ("Recognized video ID “…” — playing in-window.", 3.5s), while
       a result-card click keeps the plainer pre-existing message — done
       via a new optional `opts.source` param on `loadVideo()` rather than
       a second function, so every existing call site (unchanged, no
       `opts` passed) keeps its old behavior.
     - Preserving search results across a pasted-URL playback needed no
       new code: `loadVideo()` never touched `searchState` before this
       part and still doesn't, and Part 3's "◀ Results" pill already
       covers "get back to whatever was on screen" for any path into the
       video view, paste included.

   PLAYLIST FOUNDATION NOTES (Playlist Part 1 — data model, persistence,
   and the playback-queue abstraction; NOT the same numbering as Parts
   1-8 above, which were a separate, already-finished effort on search/
   browsing. This is Part 1 of a new six-part plan: build a proper
   playlist-based music player on top of the player/window/API layer
   that already exists above):
     - WHERE IT LIVES: one new block, "PLAYLISTS", inserted right after
       LOAD VIDEO and before the existing SEARCH (Part 3) block. Nothing
       above or below it was restructured — it's a pure addition.
     - TWO STORAGE KEYS, ON PURPOSE: `vocabRegister_youtubePlaylists`
       (the `playlists` array — names/items/ordering, the data a person
       would be upset to lose) and `vocabRegister_youtubePlaybackState`
       (the `playbackState` object — active playlist id, queue position,
       repeat mode, shuffle order — session/preference data, never the
       source of truth for what's *in* a playlist). Both go through the
       existing `loadJson`/`saveJson` helpers, so corrupted/malformed
       JSON degrades to an empty list / default state instead of
       throwing, same as every other persisted key in this file.
       `loadPlaylistsFromStorage()` additionally drops any entry missing
       a usable id/videoId rather than let one bad row break the whole
       list.
     - NO ARTIFICIAL LIMITS: no `.slice()`, no `if (items.length >= N)`,
       anywhere in the playlist CRUD or persistence path. A playlist's
       `items` array grows exactly as large as the person adds to it;
       the same is true of the `playlists` array itself. The only
       ceiling is whatever the browser's actual localStorage quota is,
       and hitting that fails soft (via the existing `saveJson` try/
       catch) instead of crashing the window.
     - DEBOUNCED WRITES: `persistPlaylistsDebounced` (400ms) and
       `persistPlaybackStateDebounced` (300ms) collapse bursts of rapid
       mutation (adding many items back-to-back, clicking "next"
       repeatedly) into a single localStorage write each, per the
       spec's "don't re-stringify+save a huge playlist on every tiny
       change" requirement. `persistPlaylistsNow()` (a `.flush()` on the
       debounced writer) runs once on `beforeunload` so a person closing
       the tab right after an edit doesn't lose it to the debounce
       window. Playback state is never written on a player timeupdate/
       progress tick — only on actual track/mode changes (new current
       index, repeat mode flipped, shuffle toggled) — so a long song
       doesn't generate any writes at all while it plays.
     - REPEAT MODES (`playbackState.repeatMode`: "off" | "playlist" |
       "one") are entirely separate from the pre-existing single-video
       `loopEnabled` variable/toggle — neither reads nor writes the
       other. Where they interact is exactly one `if` in
       `onPlayerStateChange`'s ENDED branch: the old single-video loop
       is checked first and still wins if it's on (unchanged pre-
       existing behavior); only if it's *off* does an ended video ask
       the new queue ("is there an active playlist, and was this ended
       video its current item?") what to do next, via `playNextInQueue()`
       — which itself resolves "one" (replay), "playlist" (wrap to
       index 0), or "off" (stop) using `getNextQueueIndex()`. A
       standalone video with no active playlist is unaffected either
       way — it just falls through to the existing "stopped" indicator.
     - SHUFFLE is a deterministic pre-computed order, not a live
       Math.random() comparator sort: `generateShuffleOrder(items)` is
       a one-time Fisher-Yates shuffle of `[0..items.length-1]` (index
       positions into `playlist.items`), stored as
       `playbackState.shuffleOrder`, walked via
       `playbackState.shufflePosition`. `playbackState.currentIndex`
       (an index into `playlist.items`) stays canonical for "what's
       playing right now" in *both* shuffle and sequential mode — that's
       what `getCurrentQueueItem()` reads — while `shuffleOrder`/
       `shufflePosition` only decide what "next"/"previous" resolve to.
       `rebuildShuffleOrder(playlist, { preserveCurrent })` regenerates
       the order (e.g. after an add/remove/reorder invalidates it) and,
       when `preserveCurrent` is set, re-locates the still-canonical
       `currentIndex` inside the fresh order so a shuffled queue never
       audibly jumps just because the list changed. The playlist's own
       saved item order (`playlist.items`) is never touched by any of
       this — shuffle is purely a second, disposable index over it.
     - QUEUE MUTATIONS DURING ACTIVE PLAYBACK: `addItemToPlaylist()`
       only ever appends, so it can't disturb `currentIndex`; it just
       invalidates/rebuilds shuffle order if that playlist is the active
       one and shuffle is on. `removeItemFromPlaylist()` and
       `reorderPlaylistItem()` both resolve the *currently playing
       item's id* before mutating and re-locate it after, so deleting or
       dragging some other row never silently skips or repeats the song
       actually playing; removing the currently-playing row itself
       clamps to the nearest valid index rather than stopping playback
       outright (nobody wants their music to cut out because the queue
       changed). Deleting a playlist that's currently active calls
       `stopPlaylist()` to clear `playbackState` rather than leaving a
       dangling `activePlaylistId` pointing at nothing.
     - ZERO NEW API CALLS: `playPlaylistItem()` goes straight to the
       existing `loadVideo(item.videoId, …)` — the same function pasted
       links and search-result clicks already use — which only ever
       builds a local `/embed/<id>` URL. A playlist item's stored
       `videoId`/`title`/`channelTitle`/`thumbnailUrl`/`duration` is
       never re-fetched from YTApi just to play or list it, satisfying
       the "playlists must work with no key / no quota / offline"
       requirement (components 10-11 of the Part 1 spec) for free — it's
       the same guarantee `loadVideo()` already gave standalone pasted
       IDs.
     - STANDALONE PLAYBACK UNCHANGED: nothing in this block is called
       from `loadVideo()`, `search()`, or any result-card click handler
       — playlists are additive. Pasting a link or clicking a search
       result still never touches `playlists`/`playbackState` at all,
       so "play a video with no playlist involved" keeps working exactly
       as before.
     - PUBLIC SURFACE: `window.YouTubeWindow.playlists` (getAll/get/
       create/rename/remove/addItem/removeItem/reorderItem) and
       `window.YouTubeWindow.playback` (getState/getActivePlaylist/
       getCurrentItem/buildQueue/play/start/stop/next/previous/
       setRepeatMode/setShuffleEnabled) are exposed the same way
       `getApiUsage()` already was, mainly so later parts' UI code (and
       manual console testing now) have a stable entry point without
       reaching into this file's closure directly.
     - NOT DONE YET (later parts, by design): no playlist UI (create/
       rename/delete controls, an "Add to playlist" action anywhere,
       a queue/list view, drag-to-reorder handles, transport buttons for
       next/previous/repeat/shuffle). This part is the data layer and
       queue math those UIs will call into — see the six-part plan in
       the task this was built from.

   PART 2A NOTES (playlist library, creation, and playlist detail shell):
     - WHERE IT LIVES: one new block, "PLAYLIST UI", inserted right after
       the PLAYLISTS data/queue block and before the existing SEARCH
       (Part 3) block — same "pure addition" approach Part 1 used. It
       calls into Part 1's functions (getAllPlaylists/getPlaylist/
       createPlaylist/renamePlaylist/deletePlaylist/startPlaylist/
       playPlaylistItem/setShuffleEnabled/setRepeatMode/playbackState)
       and never touches localStorage, YTApi, or `playlists`/
       `playbackState` directly.
     - TWO MORE `setView()` STATES: "playlists" (#yw-playlists, the
       library) and "playlist-detail" (#yw-playlist-detail) join the
       pre-existing empty/results/video/channel-detail states, hidden/
       shown the same way (a single class toggle per element) — no
       second view-switching mechanism was introduced.
     - NAVIGATION: the header's new 🎵 button (#yw-playlists-btn) is the
       entry point — toggles into the library, or (if already showing a
       playlist view) back out to whatever was on screen before
       (leavePlaylistsView(): a playing video wins, else the active
       search tab's own results, else empty). It never stops playback —
       same "hidden view keeps playing" pattern the existing "back to
       results" pill already relies on. Inside the feature, "← My
       Playlists" always returns to the library specifically, per spec.
     - MODALS REUSE THE APP'S OWN .modal SYSTEM: #yw-playlist-name-modal
       (create and rename — one small form, mode-dependent title/button
       label, in openPlaylistNameModal()) and #yw-playlist-delete-modal
       (destructive-action confirm) are plain .modal/.modal-content/
       .modal-actions markup, added in index.html as top-level siblings
       of the app's other dialogs (#ai-settings-modal, #edit-modal,
       etc.) — not nested inside #vocab-youtube-window, since that
       element's CSS transform would clip a position:fixed descendant
       (the exact reason #yw-settings-panel reparents to <body> at
       runtime; living top-level from the start avoids needing that same
       workaround for these two).
     - NAME VALIDATION: trimmed, empty rejected (inline error text in the
       modal, focus returned to the input) — no arbitrary character-count
       cap, since none was asked for. Duplicate names are allowed by
       design: identity is always `playlist.id` (createPlaylist() mints
       a fresh one via the existing genId("pl")), never `playlist.name`.
     - ⋮ OVERFLOW MENU: one shared implementation
       (togglePlaylistRowMenu()) used by both a library row's ⋮ and the
       playlist-detail header's ⋮ — same two actions (Rename/Delete)
       either way. It's an in-flow absolutely-positioned dropdown
       anchored to its own row (not position:fixed), so — unlike the
       settings panel — it never needs to escape the window's clipping
       and can stay a normal child of the view it belongs to.
     - DELETE SAFETY: the confirm modal states the video count and that
       YouTube itself is unaffected, per spec. deletePlaylist() (Part 1)
       already clears `playbackState` via stopPlaylist() if the deleted
       playlist was active; this part's only job is the view — if the
       deleted playlist was open in the detail view, it navigates back to
       the library (never leaves the detail view pointing at a playlist
       that no longer exists) rather than touching playback further.
     - ITEM ROWS ARE PLAY-ONLY: renderPlaylistDetail() lists the real,
       uncapped `playlist.items` and wires each row to the existing
       playPlaylistItem() — but adding/removing/reordering items has no
       UI yet, by design (Part 2B's boundary). #yw-playlist-detail-content
       is the scrollable container Part 2B's incremental/virtualized
       rendering will replace the innerHTML-per-render approach inside,
       without needing to change the header/controls above it.
     - ZERO NEW API CALLS, SAME AS PART 1: every function in this block
       is either pure rendering or a direct call into Part 1's CRUD/
       queue functions, which are themselves YTApi-free (see PLAYLIST
       FOUNDATION NOTES above) — creating, renaming, deleting, opening,
       or navigating between playlists costs 0 YouTube Data API requests.

   PART 2B1 NOTES (adding videos to a playlist from search results / the
   current video — item removal, reorder, and large-playlist rendering
   remain Part 2B2, not touched here):
     - WHERE IT LIVES: one new block, "ADD TO PLAYLIST", inserted right
       after the ⋮ playlist-row menu and before the create/rename modal
       (which it also extends — see below) — same "pure addition, reuse
       everything below/above it" approach Parts 1/2A used. It calls
       straight into Part 1's addItemToPlaylist()/getPlaylist() and Part
       2A's getAllPlaylists()/createPlaylist()/openPlaylistNameModal();
       nothing here touches localStorage or YTApi directly, and no
       second playlist store, persistence layer, or creation flow was
       created.
     - ZERO EXTRA API CALLS, BY CONSTRUCTION: every `source` object handed
       to addItemToPlaylist() here comes from data already in hand —
       `playlistSourceFromResultRow()` reshapes an already-rendered
       `searchState.items` row (field-renaming only: `row.id` →
       `videoId`, `row.thumb` → `thumbnailUrl`), and the header's
       "+ Add to Playlist" button uses `currentVideoMeta`, a small object
       loadVideo() now populates from whatever `opts.meta` its caller
       already had (a search-result row, a playlist item) — see
       loadVideo()'s own comments. A bare pasted link/ID has no such
       metadata, so `currentVideoMeta` falls back to `{ title: "YouTube
       Video", channelTitle: "", thumbnailUrl: "", duration: null }`
       rather than firing a videos.list lookup just to name it (spec #9).
       Neither path ever calls search.list, videos.list, or any other
       YTApi method — "Add" is purely a local playlists-array mutation.
     - THE CARD ITSELF IS UNTOUCHED: `renderResultCard()`'s existing
       `.yw-result-item` button (thumbnail/title/channel/meta/desc, click
       to play) is byte-for-byte the same as before Part 2B1, just now
       wrapped in a new sibling `.yw-result-row` alongside a small
       `.yw-add-btn` ("+ Add") pill in its own `.yw-result-add-wrap` —
       satisfies "integrate into the existing card, don't redesign it."
       `renderChannelVideoCard()` (the channel video browser, Part 5) was
       deliberately left alone — Part 2B1's spec scopes "Add" to video
       search results and the current video, not every list that happens
       to reuse `.yw-result-item` styling.
     - POPOVER SHAPE mirrors the existing ⋮ playlist-row menu exactly: an
       in-flow `position:relative` wrap (`.yw-result-add-wrap` per card,
       or `.yw-header-add-wrap` around the current-video button) +
       `position:absolute` dropdown (`openAddToPlaylistMenu()`), never
       `position:fixed` — so, like the ⋮ menu and unlike the settings
       panel, it never needs to escape the window's own `overflow:
       hidden`/transform by reparenting to <body>.
     - "+ NEW PLAYLIST" REUSES PART 2A'S OWN MODAL: `openPlaylistNameModal()`
       gained a third, optional `opts.addSource` argument (only honored
       in "create" mode) rather than a parallel creation flow. When set,
       `commitPlaylistNameModal()`'s create branch calls the pending
       `addItemToPlaylist()` immediately after `createPlaylist()` and
       shows the same confirmation toast — but, unlike the library's own
       "+ New" button (which still auto-opens the fresh playlist's detail
       view, unchanged), it deliberately does NOT navigate anywhere,
       since adding — new playlist or existing — must never leave search
       results/the current video (spec #5/#6).
     - DUPLICATES ARE INTENTIONAL, NOT A BUG: `handleAddToPlaylistSelect()`
       never checks whether `source.videoId` is already present in the
       target playlist, and nothing here disables/hides a "+ Add" control
       after use — every click (search result or current video, same
       video or different) is its own independent `addItemToPlaylist()`
       call, each producing its own unique playlist-item id (Part 1's
       `genId("item")`), and addable to any number of different playlists
       independently. `flashAddButton()` is purely a transient CSS class
       for feedback; it never becomes a disabled/"Added" state.
     - CONFIRMATION IS THE APP'S EXISTING STATUS LINE: `showAddedConfirmation()`
       is a one-line call into the pre-existing `showStatus(html,
       autoHideMs)` (the same `#yw-status` line under the search bar
       every other status message already uses) — no new toast/modal
       component was built.
     - STAYING PUT: a successful add never calls `setView()`, never
       re-runs a search, never touches `searchInput`/`currentVideoId`. If
       a playlist library/detail view happens to already be on screen
       when an add happens, its item count is kept live
       (`renderPlaylistLibrary()`/`renderPlaylistDetail()` re-run only in
       that case) — but that view is never *opened* as a side effect of
       adding, and both already read the live `playlists` array fresh on
       their own next render regardless, so nothing goes stale even when
       neither is currently shown (the common case, since "Add" only
       appears on search results / the current video, which are mutually
       exclusive on-screen states with the playlist views).
     - GRACEFUL FAILURE (spec #20): `handleAddToPlaylistSelect()` re-checks
       `getPlaylist(playlistId)` at click time — if the chosen playlist
       was deleted between opening the picker and choosing it (e.g. from
       another tab), it shows a plain status message and refreshes
       whatever playlist view might be open instead of throwing; a
       persistence failure inside `addItemToPlaylist()` (it returns
       `null` rather than throwing — see Part 1) is handled the same way,
       so "Added" is never shown unless the item genuinely landed in
       `playlist.items`.

   PART 2B2 NOTES (item removal/reorder/Play Next, and large-playlist
   rendering — the final stage of Part 2):
     - WHERE IT LIVES: "LARGE PLAYLIST RENDERING" and the per-item ⋮ menu
       block, both inserted right after renderPlaylistDetail() inside
       "PLAYLIST UI"; queueUpNext()/the upNext-draining change to
       playNextInQueue() live in "PLAYLISTS" next to the functions they
       extend. Nothing here is a second copy of anything — Play now/Move
       up/Move down/Move to top/Move to bottom/Remove call straight into
       Part 1's playPlaylistItem()/reorderPlaylistItem()/
       removeItemFromPlaylist(), which already existed and already
       handled duplicates-by-id, active-index re-anchoring, and
       shuffle-order invalidation correctly — this part only wires UI to
       them.
     - WINDOWED RENDERING, NOT AN ITEM LIMIT: mountVirtualPlaylist() gives
       #yw-playlist-detail-content a full-height "sizer" div
       (`count * PL_ROW_HEIGHT`) so native scrolling/scrollbar size stays
       correct, then renders only `renderPlaylistItemRow()` for the rows a
       rAF-throttled scroll handler determines are visible (+ a small
       PL_OVERSCAN buffer) — see that block's own header comment for the
       full design. `playlist.items` itself is never sliced/capped
       anywhere; a 5,000-item playlist and a 5-item one run through the
       exact same code path, the only difference being how many rows
       `computeVisibleRange()` decides to materialize at once.
     - CLICKS ARE DELEGATED, NOT PER-ROW: because rows are constantly
       created/destroyed as the window scrolls, binding a listener per row
       would mean constant bind/unbind churn. Instead one click listener
       on the stable `playlistDetailEl` (bound once, not per render) reads
       `data-play-item`/`data-play-index`/`data-item-menu`/
       `data-item-index` off whatever was actually clicked.
     - ACTIVE-ITEM HIGHLIGHT UPDATES WITHOUT A RERENDER (spec #2/#14):
       playPlaylistItem()/stopPlaylist() (Part 1) each now call the new
       notifyPlaylistUIOfPlaybackChange(), which — only when a
       playlist-detail view happens to be open — finds the previously-
       active and newly-active row (if either is currently within the
       rendered window) and flips just their classList/aria-current/index
       text. No full renderPlaylistDetail() call, no rebuilding of rows
       that didn't change. A structural change (remove/move) still calls
       the full renderPlaylistDetail(), but that stays cheap regardless of
       playlist size since it only ever (re)creates the visible window.
     - PLAY NEXT IS A SEPARATE, TEMPORARY QUEUE (spec #5/#9): `upNext` on
       `playbackState` is a small FIFO of video snapshots — never indices
       into `playlist.items`, never touched by reorderPlaylistItem(), and
       drained by playNextInQueue() before it falls back to the normal
       playlist queue. Queuing a track this way never reorders the saved
       playlist and never touches shuffleOrder — the three concepts
       (saved order / shuffle order / up-next queue) stay exactly as
       separate as Part 1's design intended. This is deliberately
       minimal — it does NOT build history/back-tracking or
       auto-skip-unavailable-videos; those remain Part 3's job (spec #27).
     - MUTUAL EXCLUSIVITY: the per-item ⋮ menu, the library/detail-header
       ⋮ menu, and the "+ Add to Playlist" popover all close each other on
       open (closeAllPlaylistMenus() now also calls
       closePlaylistItemMenu() and vice versa) so at most one popover is
       ever on screen — the same convention Part 2A/2B1 already
       established, just extended to a third popover type.
     - ZERO NEW API CALLS: every action here (remove/reorder/play
       now/play next) is a local mutation of `playlists`/`playbackState`
       plus, at most, the existing loadVideo() → local `/embed/<id>` — no
       new YTApi.* call is introduced anywhere in this block.

   PLAYLIST PART 3 NOTES (full playback engine & continuous playback —
   the video-view transport bar, error/unavailable-video handling,
   autoplay-restriction handling, and the ended/completed state):
     - WHERE IT LIVES: one new block, "PLAYBACK ENGINE", inserted right
       after the per-item ⋮ menu / "ADD TO PLAYLIST" code and before the
       pre-existing SEARCH (Part 3, old numbering) block — same
       "append after everything playlist-related, touch nothing else"
       approach every prior playlist part used. It calls straight into
       Part 1's queue math (getActivePlaylist/getCurrentQueueItem/
       getNextQueueIndex/buildPlaybackQueue/playPlaylistItem/
       playNextInQueue/playPreviousInQueue/setRepeatMode) and Part 2's
       notifyPlaylistUIOfPlaybackChange() hook; it introduces no second
       queue/state system.
     - THE TRANSPORT BAR IS PLAYLIST-ONLY, BY DESIGN (spec #15): a small
       overlay (`ensureTransportBar()`, built once, lazily, the first
       time it's needed) sits at the bottom of `#yw-video-wrap` and is
       shown only when the currently-loaded video IS the active
       playlist's current queue item (same identity check the pre-
       existing ENDED handler already used: `activePlaylistId` set AND
       `getCurrentQueueItem()?.videoId === currentVideoId`). A standalone
       video (pasted link, search-result click with no playlist
       involved) never shows Next/Previous/Track-X-of-Y/playlist name —
       it keeps exactly its pre-Part-3 look (loop button, volume,
       ↗/+Add/⋮ header row). This is the "clear distinction between
       standalone and playlist playback" the spec asks for, expressed as
       a UI difference, not just an internal one.
     - NO NEW METADATA FETCHES (spec #7): the Now Playing block reads
       `currentVideoMeta` (already populated by loadVideo() from the
       playlist item's own stored title/channelTitle — see PLAYLIST
       FOUNDATION NOTES' "ZERO NEW API CALLS") and `currentVideoMeta.title
       || "YouTube video"` is the exact fallback spec #7 asks for. Track
       X of Y comes from `playbackState.currentIndex + 1` /
       `playlist.items.length` — pure local arithmetic.
     - PROGRESS BAR, NOT A COMPLETION POLLER (spec #4 vs #8 — these are
       different things): `startProgressTicker()`/`stopProgressTicker()`
       wrap a single 1000ms `setInterval` that only ever calls
       `player.getCurrentTime()`/`getDuration()` to move a width % and
       repaint two mm:ss labels — it never inspects player state to
       infer song completion (that's still exclusively
       `onPlayerStateChange`'s ENDED branch, unchanged in kind from
       before this part). The ticker is started on PLAYING and stopped
       on PAUSED/ENDED/error/window-close, so nothing runs while nothing
       is playing.
     - PREVIOUS THRESHOLD (spec #6): `handlePreviousClick()` reads
       `player.getCurrentTime()` (a local IFrame-API call, not a YouTube
       Data API request, so this costs zero quota) and restarts the
       current track via `seekTo(0, true)` past the ~3s mark, or defers
       to `playPreviousInQueue()` before it. No extra network call
       either way.
     - UNAVAILABLE-VIDEO SKIP, BOUNDED (spec #12/#13): `unavailableItemIds`
       is a plain in-memory `Set` of playlist *item* ids (never videoIds
       — two items can share a videoId) — deliberately NOT persisted,
       since it describes only "what failed during this playback pass,"
       not a fact about the playlist itself (the spec is explicit that a
       failing video must never be auto-removed from the user's saved
       playlist). `startPlaylist()` clears it (a fresh ▶ Play is a fresh
       pass); `playPlaylistItem()` clears just the one item id being
       played (an explicit click — row, Next, Previous, or the skip
       logic itself retrying — always gets a real attempt). On
       `onPlayerError()`, if the failed video is the active playlist's
       current item, `skipToNextPlayableAfterError()` adds that item's id
       to the set, then walks the *play-order* (via `buildPlaybackQueue()`
       — respects shuffle, same ordering Next/Previous already use) for
       up to `playlist.items.length` steps looking for an id not in the
       set. Every failure adds exactly one new id, so the set can never
       exceed the playlist's own size — the walk is mathematically
       bounded, satisfying "attempt each item at most once per pass"
       without a separate attempt counter. Exhausting it (or finding no
       next index at all, e.g. repeat=off at the last item) shows the
       "no playable videos remain" ended state rather than looping.
     - AUTOPLAY-RESTRICTION HANDLING IS A WATCHDOG, NOT A WORKAROUND
       (spec #11): `armAutoplayWatchdog()` is called every time
       `playPlaylistItem()` loads a new track (manual or automatic
       alike) and simply checks, ~1.8s later, whether the player's own
       state ever reached PLAYING/BUFFERING. If not, `playbackBlocked`
       flips true, the transport bar's center button becomes a plain
       "▶ Play" affordance (calling `player.playVideo()` — a normal user
       gesture from here on satisfies the browser), and a one-line status
       explains why. Playlist state (`currentIndex`/`activePlaylistId`)
       is untouched either way — the queue doesn't get confused by a
       browser policy, per spec's "do not break playlist state." No
       referrer/attribute/permissions-policy trick is attempted, per
       spec's "do not attempt browser-policy workarounds."
     - ENDED STATE KEEPS THE PLAYLIST "OPEN" (spec #3): when
       `playNextInQueue()` returns false from the ENDED handler (repeat
       off, last item), `playbackState.activePlaylistId`/`currentIndex`
       are deliberately left exactly where Part 1 already leaves them
       (pointing at the last item) — this part only sets a local
       `playlistFinished` flag and swaps the transport bar's center
       button for "↺ Replay", which calls `startPlaylist(id, {fromIndex:
       0})`. The player/iframe itself is never destroyed (still the same
       reused `YT.Player` from mountPlayer's loadVideoById reuse path —
       untouched by this part).
     - REUSE, NOT REBUILD (spec #10): nothing in this part calls
       `destroyPlayer()`/creates a second `YT.Player`. Every track change
       — manual click, auto-advance, error-skip, or Replay — goes through
       the exact same `playPlaylistItem()` → `loadVideo()` → `mountPlayer()`
       path Part 1 already built, which already prefers
       `player.loadVideoById()` over tearing the instance down (see
       mountPlayer, unchanged by this part).
     - ZERO NEW YOUTUBE DATA API CALLS: every function this part adds
       talks only to the already-mounted `YT.Player` instance (getCurrentTime/
       getDuration/getPlayerState/playVideo/pauseVideo/seekTo) or to
       `playlists`/`playbackState` already in memory — no `YTApi.*` call
       appears anywhere in this block, keeping playlists fully usable
       with no API key configured (same guarantee every earlier playlist
       part gave).

   PLAYLIST PART 4A NOTES (smart shuffle, repeat modes, and the
   playback-order engine — the request's own numbering; this project's
   playlist effort had already covered most of this ground under its
   Part 1/2A/2B1/2B2 numbering above, so this pass is a targeted
   extension of the existing PLAYLISTS block rather than a rewrite):
     - ALREADY IN PLACE FROM PART 1, UNCHANGED HERE: the three repeat
       modes and their precedence in `getNextQueueIndex()`/
       `getPreviousQueueIndex()` (spec #3-7/#27-28), `shuffleEnabled`/
       `shuffleOrder`/`shufflePosition` as the one authoritative shuffle
       state (spec #8), shuffle never writing back into `playlist.items`
       (spec #2/#9), the ID-based (not object-based) shuffle queue (spec
       #10), preserving the current item across shuffle on/off (spec
       #15-17 — `currentIndex` is always a `playlist.items` position,
       never a `shuffleOrder` position, so turning shuffle off already
       "just works" with no extra code), and invalidating/rebuilding a
       stale shuffle order on add/remove/reorder while preserving the
       playing item (spec #29, `invalidateShuffleIfActive()`).
     - WHAT THIS PASS ADDS: `generateShuffleOrder()` now takes the
       playlist's `items` (not a bare length) and runs one deterministic
       smoothing pass afterward to avoid two ADJACENT entries sharing a
       videoId — spec #13's "don't play the same song twice in a row
       just because it's in the playlist twice", answered by comparing
       videoId, not item id, since two different items can point at the
       same video. `getNextQueueIndex()` now calls it again to start a
       genuinely NEW shuffle cycle when Shuffle+Repeat Playlist wraps
       (spec #22/#25) instead of silently re-walking the same fixed
       order forever, and passes the outgoing cycle's last item as
       `avoidFirstItem` so the new cycle tries not to open on it (spec
       #23). Shuffle+Repeat One is unaffected (still resolved by the
       `repeatMode === "one"` branch ahead of any shuffle logic, so nothing
       here advances the queue — spec #24), and Shuffle+Repeat Off is
       unaffected too (`repeatMode !== "playlist"` still returns -1 at
       the end of a cycle — spec #26).
     - RESHUFFLE (spec #30): `reshuffleActivePlaylist()` is a thin
       wrapper over the existing `rebuildShuffleOrder(playlist,
       { preserveCurrent: true })` — no new anchor-relocation logic
       needed, since that already keeps the playing item in place and
       the smoothing pass above already covers "avoid immediate
       repetition where possible". Exposed at
       `window.YouTubeWindow.playback.reshuffle` for Part 4B's UI (and
       manual testing) to call.
     - SHUFFLE HISTORY (spec #18/#20): deliberately NOT a second,
       separately-maintained array. `shuffleOrder` already IS the
       current cycle's visiting order and `shufflePosition` already IS
       how far into it playback has gotten, so Previous already follows
       real playback history for free (spec #19/#21 — it's a walk
       backward through a FIXED order, not a fresh random pick), and it
       can never grow unbounded (spec #20) since it's capped at the
       playlist's own length. `getShuffleHistory()` is a read-only
       derived view (`shuffleOrder` sliced to before the current
       position, most-recent-first) added only so a future "recently
       played" UI has something to read without reaching into
       `playbackState` directly.
     - NOT TOUCHED, BY DESIGN (Part 4B's boundary): no new buttons, no
       keyboard shortcuts, no changes to the existing shuffle/repeat
       buttons already in the playlist-detail view or the transport bar
       — both already call straight into `setShuffleEnabled()`/
       `setRepeatMode()` from Part 2A/3 and need no changes for any of
       the above.

   PLAYLIST PART 5 NOTES (unlimited-scale performance, persistence, and
   quota protection — an audit-and-close-the-gaps pass across everything
   Parts 1-4B already built, not a rewrite of any of it):
     - AUDIT RESULT — MOST OF THIS WAS ALREADY TRUE: playback is already
       API-free (Part 1's "ZERO NEW API CALLS" — playPlaylistItem() only
       ever calls the local loadVideo()), a known videoId is never
       resolved through search.list anywhere in the playlist code path,
       persistence is already debounced (400ms/300ms) and never fires on
       a playback progress tick, rendering is already windowed
       (mountVirtualPlaylist(), Part 2B2 — a 5,000-item playlist creates
       exactly as many DOM rows as fit on screen + overscan, never 5,000),
       playlists/playback-state/loop/volume/mute are already five
       separate localStorage keys (never one big blob rewritten for a
       volume change), the existing YW_CACHE_TTL/quota system already
       distinguishes its own browser-local estimate from Google's real
       quota in the UI copy itself, and search was already user-triggered
       with a 5-minute cache — none of that needed changing. This part is
       the genuine gaps found on top of that foundation:
     - METADATA ENRICHMENT (spec #3-#5) — new "PLAYLIST ITEM METADATA
       ENRICHMENT" block, right after mountVirtualPlaylist() in "LARGE
       PLAYLIST RENDERING". The gap: an item added by pasting a raw video
       ID/URL, or arriving via Part 5's own Import below, has no title/
       thumbnail/duration the way a search-result-sourced item already
       does. `enrichVisiblePlaylistItems(playlist, start, end)` is called
       from renderVirtualPlaylistWindow() every time the visible window
       is (re)painted — LAZY (spec #5): it only ever looks at rows
       actually on screen, never sweeps a whole playlist when opened.
       BATCHED (spec #4): every videoId needing enrichment across that
       window goes into one YTApi.getVideoDetails() call, which already
       chunks at 50 and already caches by request shape — no second cache
       was built on top of it. NEVER SEARCHES (spec #2, reinforced): only
       ever calls videos.list for an id already known, never search.list.
       `ywEnrichAttempted` (a plain in-memory Set of item ids, session-
       only, same reasoning as the Playback Engine's `unavailableItemIds`)
       caps every item at one attempt, so a permanently-unavailable
       pasted id doesn't refire a request every time it scrolls back into
       view. No API key configured → the function returns immediately —
       enrichment is a pure bonus, never a requirement for playback.
     - STORAGE FAILURE HANDLING (spec #9) — `savePlaylistsToStorage()`
       replaces the bare `saveJson(YW_PLAYLISTS_STORAGE, playlists)` call
       inside `persistPlaylistsDebounced` specifically (playbackState/
       prefs are untouched — see PLAYLIST FOUNDATION NOTES on why they're
       already lower-stakes than the playlists array itself). On a
       QuotaExceededError (or a private-browsing equivalent) it does NOT
       throw, does NOT touch the in-memory `playlists` array (nothing is
       ever deleted because a write failed), and shows exactly one
       warning via the existing showStatus() line — deduped with
       `playlistStorageWarningActive` so a burst of failed debounced
       writes while storage stays full doesn't spam the status line, and
       automatically clears the moment a write succeeds again. The
       warning names Export (below) as the actual way to not lose
       anything, rather than just stating the problem.
     - EXPORT / IMPORT (spec #10-#12) — new "PLAYLIST EXPORT / IMPORT"
       block, right after the delete-confirm modal's own listeners.
       Export (`downloadPlaylistExport()`) writes an explicit field list
       (id/name/createdAt/updatedAt/items, each item's id/videoId/title/
       channelTitle/thumbnailUrl/duration/addedAt) — never
       `JSON.stringify(playlists)` directly, and never the API key or any
       other app setting, per spec. Import is read-only until confirmed:
       `parsePlaylistImportFile()` only parses+validates (rejects
       non-JSON, rejects a shape with no playlists array, drops any
       record with no usable items via `sanitizeImportedPlaylist()`/
       `sanitizeImportedPlaylistItem()` — the exact same defensive
       cleaning style `loadPlaylistsFromStorage()` already applies to
       locally-saved data, including a plausible-shape check on every
       videoId via `isPlausibleVideoId()`) and hands the result to
       `openPlaylistImportModal()`, which shows a playlist/video count
       and a Merge-vs-Replace choice (#yw-playlist-import-modal, same
       plain .modal markup convention as every other dialog in this app)
       — nothing is written to `playlists` until that modal's own Import
       button is clicked. PROTOTYPE POLLUTION / NO CODE EXECUTION (spec
       #11): every field is copied individually onto a fresh object
       literal in the two sanitize functions above — never
       `{...raw}`/`Object.assign(target, raw)` — so a crafted
       `"__proto__"`/`"constructor"` key in the file can reach nothing;
       the file is only ever passed through `JSON.parse`, never `eval`
       or a Function constructor. DUPLICATE IDS (spec #12): every
       imported ITEM gets a brand-new id unconditionally
       (`sanitizeImportedPlaylistItem()`), and every imported PLAYLIST's
       id is re-checked against this browser's existing ids at commit
       time (`commitPlaylistImport()`) and regenerated on collision — two
       distinct items or playlists can never silently merge into one just
       because an id matched. ASYNC FOR LARGE IMPORTS (spec #16):
       `commitPlaylistImport()` pushes playlists onto the array in
       chunks of 25 with a `setTimeout(resolve, 0)` yield between chunks,
       rather than one long synchronous loop, so a many-thousand-item
       export doesn't freeze the tab for the whole import — the browser
       gets a chance to paint/handle input between chunks. One debounced
       persist happens at the end, not one per chunk. REPLACE MODE calls
       the existing `stopPlaylist()` before clearing `playlists`, so a
       currently-active playlist that's about to be wiped never leaves
       `playbackState` pointing at a now-dangling id (same guard
       `deletePlaylist()` already applies to a single deletion). The
       trigger buttons (⇩ Export / ⇧ Import) live in
       `renderPlaylistLibrary()`'s own header markup, rebuilt/rebound on
       every render exactly like the pre-existing "+ New" button already
       is; Import is available even from the empty-playlists state (the
       whole point of restoring a backup on a fresh browser/profile),
       Export is not (nothing to export, and a click is now a no-op
       status message rather than downloading an empty file — belt-and-
       suspenders, since the button isn't rendered in the empty state at
       all).
     - MEMORY LEAK AUDIT (spec #17): every timer/listener/observer this
       playlist effort has ever added was checked for a matching
       teardown. `teardownVirtualPlaylist()` (Part 2B2, unchanged) already
       removes its scroll listener and cancels any pending
       `requestAnimationFrame` before a new virtual list mounts or the
       detail view is left — confirmed still correct. `startProgressTicker()`
       / `stopProgressTicker()` (Part 3)'s single `setInterval` is stopped
       on PAUSED/ENDED/error, and `close()` (pre-existing, outside the
       playlist effort) already calls both `stopProgressTicker()` and
       `clearAutoplayWatchdog()` alongside `destroyPlayer()` — confirmed
       no dangling interval/timeout can outlive the window being closed.
       `armAutoplayWatchdog()` (Part 3)'s one-shot `setTimeout`
       self-clears on firing and is never re-armed without a fresh track
       load overwriting the previous timer id — confirmed no accumulation
       across rapid track changes. The two `beforeunload` listeners
       (Playlist Part 1, for the two debounced writers' `.flush()`) are
       intentionally permanent for the page's lifetime, same as every
       other top-level listener in this file (drag/resize/etc.) — not a
       leak, since there's exactly one of each for the file's entire
       lifetime, never re-added per playlist/render. No new
       `setInterval`/`IntersectionObserver`/`MutationObserver` was
       introduced by this part — enrichment (above) is a plain async
       function call with no persistent handle to clean up, and
       export/import's FileReader/object-URL are each used once and
       explicitly revoked (`URL.revokeObjectURL()`) or left to GC
       normally once `onload` fires, matching the pattern the app's
       pre-existing PDF/Drive export code already uses.
     - STRESS-TEST NOTES: 1×1 through 50×100 all exercise the same code
       paths as 1×1 — there is no separate "large playlist" branch
       anywhere in this file, only the windowed-rendering/lazy-enrichment
       behavior naturally doing less work when there's less to show.
       Shuffle/repeat/refresh/rapid-Next were already covered by Parts
       3-4A and are untouched here. "API key removed mid-session" and
       "quota exhausted" both already degrade gracefully for playback
       (Part 1's zero-API-calls guarantee) and now also degrade
       gracefully for enrichment specifically (the `if (!apiKey) return`
       guard above, and getVideoDetails()'s existing try/catch inside
       `enrichVisiblePlaylistItems()`) — an item just keeps showing
       "Untitled" instead of erroring.
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------------------------------------------------
     STORAGE
  ---------------------------------------------------------------------- */
  const YW_ACTIVE_STORAGE = "vocabRegister_youtubeWindowActive"; // was the window open last session?
  const YW_STATE_STORAGE = "vocabRegister_youtubeWindowState"; // { left, top, width, height }
  const YW_API_KEY_STORAGE = "vocabRegister_youtubeApiKey"; // user's own free YouTube Data API v3 key
  const YW_LOOP_STORAGE = "vocabRegister_youtubeLoopEnabled"; // "true" | "false"
  const YW_VOLUME_STORAGE = "vocabRegister_youtubeVolume"; // 0-100, last slider value
  const YW_MUTED_STORAGE = "vocabRegister_youtubeMuted"; // "true" | "false"
  // Part 6 — "Player-focused" (default) vs "Playlist-focused": which
  // panel a playlist track load lands on. Purely a display preference —
  // never affects what plays or the saved playlist/queue data itself.
  const YW_LAYOUT_MODE_STORAGE = "vocabRegister_youtubeLayoutMode"; // "player" | "playlist"
  // "Keep YouTube tab open (copy link only)" — see the settings-panel
  // toggle and syncStayOnTabToExtension() below. Purely a preference this
  // app remembers; the extension is what actually acts on it (see
  // background.js/content-youtube.js), synced over the same postMessage
  // bridge as SYNC_ACCENT_COLOR/SYNC_SHORTCUT_KEYS.
  const YW_STAY_ON_TAB_STORAGE = "vocabRegister_youtubeStayOnTab"; // "true" | "false"
  // Compact Mode (⚙ Settings > Compact Mode) — { enabled, allowed:
  // { volume/loop/external/add/playlists/layout/hide/close: bool },
  // hideMode: "timer" | "onlyAfterSearch", hideSeconds: 5-120 (seconds) }.
  // See loadCompactSettings() below.
  const YW_COMPACT_STORAGE = "vocabRegister_youtubeCompactSettings";
  // Transport bar (Now Playing / shuffle / prev / play-pause / next /
  // repeat overlay) visibility. Off (default): the overlay now only
  // reveals itself while the mouse is over the window — see the
  // .yw-transport-bar hover rules in youtube-window.css — instead of
  // sitting on screen the whole time a playlist track is loaded. On: the
  // overlay never shows at all, hover or not. See applyTransportHideSetting()
  // and the "Auto-hide playback controls" settings-panel toggle.
  const YW_TRANSPORT_HIDE_STORAGE = "vocabRegister_youtubeTransportPermanentlyHidden";

  // Lowered from 180/120 on request — the header (Compact Mode) and the
  // transport bar (see the "Auto-hide playback controls" settings toggle
  // below) already collapse gracefully at small sizes, so there's no
  // layout reason to stop someone shrinking the window further than this.
  const YW_MIN_WIDTH = 90;
  const YW_MIN_HEIGHT = 70;
  const YW_MAX_WIDTH = 900;
  const YW_MAX_HEIGHT = 700;

  // See the file header — a page opened via file:// never sends a Referer,
  // so YouTube's embedded player will always refuse it (Error 153). This
  // is checked once at load and used to swap in an explanation instead of
  // attempting a doomed embed.
  const isFileProtocol = window.location.protocol === "file:";

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* non-fatal — quota exceeded / private browsing, etc. */
    }
  }

  /* ----------------------------------------------------------------------
     DOM
  ---------------------------------------------------------------------- */
  const toggleBtn = document.getElementById("youtube-window-toggle-btn");
  const win = document.getElementById("vocab-youtube-window");
  if (!toggleBtn || !win) return; // markup not present — nothing to wire up

  const dragHandle = document.getElementById("yw-drag-handle");
  // Compact Mode — the grip doubles as the one always-reachable hover/
  // tap target that reveals the floating header pill (see the
  // .yw-compact .yw-drag-grip rules in youtube-window.css and the tap
  // handler near initDrag() below).
  const dragGrip = document.getElementById("yw-drag-grip");
  const titleEl = document.getElementById("yw-title");
  const playDotEl = document.getElementById("yw-play-dot");
  const loopBtn = document.getElementById("yw-loop-btn");
  const volumeSlider = document.getElementById("yw-volume-slider");
  const muteBtn = document.getElementById("yw-mute-btn");
  const openExternalBtn = document.getElementById("yw-open-external-btn");
  // Playlist Part 2B1 — "+ Add to Playlist" for the current video.
  const addCurrentBtn = document.getElementById("yw-add-current-btn");
  const settingsBtn = document.getElementById("yw-settings-btn");
  const settingsPanel = document.getElementById("yw-settings-panel");
  // Escape the youtube window's `overflow: hidden` (and its transform,
  // which would otherwise pin `position: fixed` right back to it too) by
  // parking the panel directly under <body>. positionSettingsPanel()
  // below then places it with real fixed coordinates every time it opens.
  if (settingsPanel && settingsPanel.parentElement !== document.body) {
    document.body.appendChild(settingsPanel);
  }
  const stayOnTabToggle = document.getElementById("yw-stay-tab-toggle");
  const apiKeyInput = document.getElementById("yw-api-key-input");
  const apiKeySaveBtn = document.getElementById("yw-api-key-save-btn");
  const apiKeyStatusEl = document.getElementById("yw-api-key-status");
  const quotaStatusEl = document.getElementById("yw-quota-status");
  const hideBtn = document.getElementById("yw-hide-btn");
  const closeBtn = document.getElementById("yw-close-btn");
  const body = document.getElementById("yw-body");
  const videoWrap = document.getElementById("yw-video-wrap");
  const resultsEl = document.getElementById("yw-results");
  const channelDetailEl = document.getElementById("yw-channel-detail");
  const emptyStateEl = document.getElementById("yw-empty-state");
  const emptyStateTextEl = document.getElementById("yw-empty-state-text");
  const searchForm = document.getElementById("yw-search-form");
  const searchInput = document.getElementById("yw-search-input");
  const searchExternalBtn = document.getElementById("yw-search-external-btn");
  const tabVideosBtn = document.getElementById("yw-tab-videos-btn");
  const tabChannelsBtn = document.getElementById("yw-tab-channels-btn");
  const statusEl = document.getElementById("yw-status");
  const resizeHandle = document.getElementById("yw-resize-handle");
  const resizeTooltip = document.getElementById("yw-resize-tooltip");
  const channelToggleBtn = document.getElementById("yw-channel-toggle-btn");
  const channelForm = document.getElementById("yw-channel-form");
  const channelInput = document.getElementById("yw-channel-input");

  // Compact Mode — settings panel controls + the footer search wrapper.
  const compactModeToggle = document.getElementById("yw-compact-mode-toggle");
  const compactHeaderBarToggle = document.getElementById("yw-compact-header-bar-toggle");
  // Transport bar hover-reveal / permanent-hide toggle (see
  // YW_TRANSPORT_HIDE_STORAGE above).
  const transportHideToggle = document.getElementById("yw-transport-hide-toggle");
  const compactOptionsEl = document.getElementById("yw-compact-options");
  const compactTickInputs = Array.from(document.querySelectorAll("#yw-compact-tick-list [data-compact-tick]"));
  const compactHideModeRadios = Array.from(document.querySelectorAll("input[name='yw-compact-hide-mode']"));
  const compactDelayRow = document.getElementById("yw-compact-delay-row");
  const compactDelaySlider = document.getElementById("yw-compact-delay-slider");
  const compactDelayValueEl = document.getElementById("yw-compact-delay-value");
  const compactQuickHideBtn = document.getElementById("yw-compact-hide-btn");
  const compactQuickCloseBtn = document.getElementById("yw-compact-close-btn");
  const footerSearchArea = document.getElementById("yw-footer-search-area");
  // Compact Mode — the footer wrapper itself (search area + status line)
  // is now toggled active/inactive as a whole; see updateFooterActiveState().
  const footerEl = document.getElementById("yw-footer");
  // Header buttons a person can grant/revoke hover-visibility to in
  // compact mode, keyed the same as each element's [data-compact-key].
  const compactButtonEls = {
    volume: document.getElementById("yw-volume-control"),
    loop: document.getElementById("yw-loop-btn"),
    external: document.getElementById("yw-open-external-btn"),
    add: document.getElementById("yw-header-add-wrap"),
    playlists: document.getElementById("yw-playlists-btn"),
    layout: document.getElementById("yw-layout-toggle-btn"),
    hide: document.getElementById("yw-hide-btn"),
    close: document.getElementById("yw-close-btn"),
  };

  // Playlist Part 2A — library/detail views, header entry point, and the
  // two modals (create/rename, delete confirm). The modals live outside
  // #vocab-youtube-window in index.html (siblings of the app's other
  // .modal dialogs) rather than nested inside it, since the window itself
  // has a CSS transform (see .yw-open/.yw-minimized in youtube-window.css)
  // which would create a containing block that clips any position:fixed
  // descendant — exactly the problem #yw-settings-panel already had to
  // work around by reparenting to <body> at runtime. Living top-level
  // from the start avoids needing that same workaround here.
  const playlistsEl = document.getElementById("yw-playlists");
  const playlistDetailEl = document.getElementById("yw-playlist-detail");
  const playlistsBtn = document.getElementById("yw-playlists-btn");
  const layoutToggleBtn = document.getElementById("yw-layout-toggle-btn");
  const playlistNameModal = document.getElementById("yw-playlist-name-modal");
  const playlistNameTitleEl = document.getElementById("yw-playlist-name-modal-title");
  const playlistNameInput = document.getElementById("yw-playlist-name-input");
  const playlistNameErrorEl = document.getElementById("yw-playlist-name-error");
  const playlistNameSaveBtn = document.getElementById("yw-playlist-name-save-btn");
  const playlistNameCancelBtn = document.getElementById("yw-playlist-name-cancel-btn");
  const playlistDeleteModal = document.getElementById("yw-playlist-delete-modal");
  const playlistDeleteTextEl = document.getElementById("yw-playlist-delete-text");
  const playlistDeleteConfirmBtn = document.getElementById("yw-playlist-delete-confirm-btn");
  const playlistDeleteCancelBtn = document.getElementById("yw-playlist-delete-cancel-btn");
  // Playlist Part 5 — export/import. The trigger buttons themselves are
  // rendered dynamically inside renderPlaylistLibrary() (like "+ New"
  // already is), so only the modal/file-input pieces that live in static
  // markup are looked up here.
  const playlistImportFileInput = document.getElementById("yw-playlist-import-input");
  const playlistImportModal = document.getElementById("yw-playlist-import-modal");
  const playlistImportSummaryEl = document.getElementById("yw-playlist-import-summary");
  const playlistImportErrorEl = document.getElementById("yw-playlist-import-error");
  const playlistImportConfirmBtn = document.getElementById("yw-playlist-import-confirm-btn");
  const playlistImportCancelBtn = document.getElementById("yw-playlist-import-cancel-btn");
  const channelOldestBtn = document.getElementById("yw-channel-oldest-btn");
  const channelNewestBtn = document.getElementById("yw-channel-newest-btn");

  let isActive = false; // window is open (visible OR minimized-but-playing)
  let isMinimized = false; // hidden-but-playing
  let currentVideoId = null;
  // Playlist Part 2B1 — whatever metadata is known for `currentVideoId`,
  // so "+ Add to Playlist" on the current-video view never needs a fresh
  // API call (spec #8/#9). Set by loadVideo()'s `opts.meta`; falls back
  // to a bare "YouTube Video" title when nothing richer is known (a
  // pasted link/ID, or a video ID typed directly) — the same fallback
  // spec #9 asks for. `null` whenever nothing is loaded.
  let currentVideoMeta = null;
  let player = null; // YT.Player instance
  let playerReadyPromise = null;
  let apiKey = "";
  try {
    apiKey = localStorage.getItem(YW_API_KEY_STORAGE) || "";
  } catch {
    apiKey = "";
  }
  let pendingQuery = null; // a video search typed before an API key was configured
  let pendingChannelQuery = null; // an oldest/newest channel lookup typed before a key was configured
  let pendingChannelSearchTerm = null; // a channel *search* (Channels tab) typed before a key was configured
  let loopEnabled = loadJson(YW_LOOP_STORAGE, false) === true;
  let transportPermanentlyHidden = loadJson(YW_TRANSPORT_HIDE_STORAGE, false) === true;
  let stayOnYoutubeTab = loadJson(YW_STAY_ON_TAB_STORAGE, false) === true;
  let playerReady = false; // true once the current YT.Player has fired onReady
  let playerVolume = (() => {
    const v = loadJson(YW_VOLUME_STORAGE, 100);
    return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
  })();
  let playerMuted = loadJson(YW_MUTED_STORAGE, false) === true;
  // Part 6 — "player" (default) or "playlist". See loadVideo()'s view
  // choice and reflectLayoutModeUI() below; purely which panel a
  // playlist-sourced track load lands on.
  let layoutMode = loadJson(YW_LAYOUT_MODE_STORAGE, "player") === "playlist" ? "playlist" : "player";

  // Part 4: which search mode the footer's tabs are on. Purely a UI/routing
  // flag — it never owns any results itself, so switching it back and forth
  // can't corrupt either `searchState` (videos) or `channelSearchState`.
  let activeSearchMode = "videos"; // "videos" | "channels"

  /* ----------------------------------------------------------------------
     COMPACT MODE — the video fills the entire window; nothing is
     reserved above or below it. The header (⚙, plus whatever's ticked
     "allowed" below) floats as a small top-right pill directly on the
     video, revealed only by hovering/dragging/tapping its grip dot or
     having ⚙'s own panel open. The footer (search bar + status line)
     floats the same way at the bottom, but only appears when it
     actually has something to show — the search area (after the "Focus
     YouTube Window Search Bar" shortcut) or a status message — never on
     hover. One master toggle drives both; see the .yw-compact rules in
     youtube-window.css and applyCompactMode()/showFooterSearchArea()/
     updateFooterActiveState() below.
  ---------------------------------------------------------------------- */
  const YW_COMPACT_BUTTON_KEYS = ["volume", "loop", "external", "add", "playlists", "layout", "hide", "close"];
  const YW_COMPACT_DELAY_MIN = 5; // seconds
  const YW_COMPACT_DELAY_MAX = 120; // seconds (2 min) — slider is a continuous 1s-step range now, not a preset list

  function defaultCompactAllowed() {
    // Every header button defaults to "allowed" except Close — closing
    // from a hover-revealed header is easy to hit by accident right next
    // to Hide/Settings, so it starts off opt-in; the quick-action "✕
    // Close Window" button in ⚙ Settings always works regardless.
    const allowed = {};
    YW_COMPACT_BUTTON_KEYS.forEach((key) => {
      allowed[key] = key !== "close";
    });
    return allowed;
  }

  function loadCompactSettings() {
    const raw = loadJson(YW_COMPACT_STORAGE, null);
    const allowed = defaultCompactAllowed();
    if (raw && raw.allowed && typeof raw.allowed === "object") {
      YW_COMPACT_BUTTON_KEYS.forEach((key) => {
        if (typeof raw.allowed[key] === "boolean") allowed[key] = raw.allowed[key];
      });
    }
    return {
      enabled: !!(raw && raw.enabled),
      allowed,
      // Off by default — the top-right corner pill. On switches to a
      // full-width header bar that stays completely invisible (no grip,
      // no hint at all) until the mouse is over where it sits. See the
      // .yw-compact-bar rules in youtube-window.css.
      headerBarMode: !!(raw && raw.headerBarMode),
      hideMode: raw && raw.hideMode === "onlyAfterSearch" ? "onlyAfterSearch" : "timer",
      hideSeconds:
        raw && Number.isFinite(raw.hideSeconds) && raw.hideSeconds >= YW_COMPACT_DELAY_MIN && raw.hideSeconds <= YW_COMPACT_DELAY_MAX
          ? raw.hideSeconds
          : 10,
    };
  }

  let compactSettings = loadCompactSettings();

  function saveCompactSettings() {
    saveJson(YW_COMPACT_STORAGE, compactSettings);
  }

  /* ----------------------------------------------------------------------
     YOUTUBE API LAYER (Part 2) — the one place every YouTube Data API v3
     request goes through. Nothing outside this block ever calls fetch()
     against googleapis.com directly. Gives every caller, present and
     future (Parts 3–10), the same request construction, the same error
     shapes, an in-memory cache with per-endpoint TTLs, duplicate-request
     prevention for identical in-flight calls, and a local "estimated
     API usage" counter — see the ARCHITECTURE MAP above (component 1).

     QUOTA NOTE: the Data API bills in "units", not requests — a
     search.list call costs 100 units, everything else used here
     (channels.list / playlistItems.list / videos.list) costs 1. The
     counters below are this browser's own best-effort estimate from the
     calls it has actually made; they are NOT Google's authoritative
     quota, which only Google Cloud Console can show. Every place this
     estimate is surfaced says so explicitly, on purpose.
  ---------------------------------------------------------------------- */
  const YW_QUOTA_STORAGE = "vocabRegister_youtubeQuotaUsage"; // { date, apiCalls, estimatedUnits, cacheHits, dedupPrevented }
  const YT_API_BASE = "https://www.googleapis.com/youtube/v3/";

  // Per-endpoint unit costs (search.list is the expensive one; the rest
  // are flat 1s regardless of which parts are requested).
  const YW_QUOTA_COST = { search: 100, channels: 1, playlistItems: 1, videos: 1 };

  // Per-endpoint cache lifetimes — tuned to how often each thing actually
  // changes, not a single blanket TTL. Uploads-playlist IDs are close to
  // permanent; view/like counts drift by the minute.
  const YW_CACHE_TTL = {
    search: 5 * 60 * 1000, // 5 min — fresh uploads can reorder results
    channelLookup: 6 * 60 * 60 * 1000, // 6 hr — channel id / uploads playlist id essentially never change
    playlistItems: 2 * 60 * 1000, // 2 min — a channel's newest upload can change
    videoDetails: 60 * 60 * 1000, // 1 hr — title/description/duration rarely change
    videoStats: 10 * 60 * 1000, // 10 min — view/like/comment counts keep moving
    channelStats: 15 * 60 * 1000, // 15 min — subscriber/video/view counts on a channel (Part 4)
  };

  const ytCache = new Map(); // cacheKey -> { data, expiresAt }
  const ytInFlight = new Map(); // cacheKey -> Promise (collapses identical concurrent requests into one)

  function todayUtc() {
    return new Date().toISOString().slice(0, 10);
  }
  function loadQuotaState() {
    const q = loadJson(YW_QUOTA_STORAGE, null);
    if (!q || q.date !== todayUtc()) {
      return { date: todayUtc(), apiCalls: 0, estimatedUnits: 0, cacheHits: 0, dedupPrevented: 0 };
    }
    return q;
  }
  let quotaState = loadQuotaState();
  // Session counters (Part 9) — deliberately NOT persisted: "this
  // session" means since the page was last loaded, so a plain in-memory
  // object that starts at zero every load is exactly right. Kept
  // alongside the persisted daily counters above rather than replacing
  // them, since the spec wants both a daily estimate AND a session one
  // visible at once.
  const sessionQuota = { apiCalls: 0, estimatedUnits: 0, cacheHits: 0, dedupPrevented: 0 };
  function persistQuotaState() {
    saveJson(YW_QUOTA_STORAGE, quotaState);
    reflectQuotaUI();
  }
  function recordApiCall(cost) {
    quotaState = loadQuotaState(); // re-check for a UTC day rollover since the last write
    quotaState.apiCalls += 1;
    quotaState.estimatedUnits += cost;
    sessionQuota.apiCalls += 1;
    sessionQuota.estimatedUnits += cost;
    persistQuotaState();
  }
  function recordCacheHit() {
    quotaState = loadQuotaState();
    quotaState.cacheHits += 1;
    sessionQuota.cacheHits += 1;
    persistQuotaState();
  }
  function recordDedupPrevented() {
    quotaState = loadQuotaState();
    quotaState.dedupPrevented += 1;
    sessionQuota.dedupPrevented += 1;
    persistQuotaState();
  }

  // Soft, clearly-labeled heuristic only — NOT a real quota check. Most
  // free YouTube Data API v3 projects default to a 10,000 unit/day
  // quota, so 80% of that is used as a "you might be getting close"
  // nudge. A project with a different (raised, or already-reduced) quota
  // will see this be over- or under-cautious, which is exactly why the
  // warning spells out the assumption instead of stating it as fact.
  const YW_ASSUMED_DAILY_QUOTA = 10000;
  const YW_QUOTA_WARNING_RATIO = 0.8;

  function reflectQuotaUI() {
    if (!quotaStatusEl) return;
    const q = quotaState;
    const s = sessionQuota;
    const warnThreshold = YW_ASSUMED_DAILY_QUOTA * YW_QUOTA_WARNING_RATIO;
    const isHigh = q.estimatedUnits >= warnThreshold;

    const stat = (value, label) => `<div class="yw-quota-stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;

    quotaStatusEl.innerHTML = `
      <p class="yw-quota-title">Estimated API usage <span class="yw-quota-caveat">(measured in this browser — not Google's own quota counter)</span></p>
      <div class="yw-quota-grid">
        ${stat(q.estimatedUnits, "estimated requests today")}
        ${stat(q.cacheHits, "served from cache")}
        ${stat(q.dedupPrevented, "duplicates avoided")}
        ${stat(s.apiCalls, "requests this session")}
      </div>
      ${
        isHigh
          ? `<p class="yw-quota-warning">⚠ Usage today (~${q.estimatedUnits} units) is getting close to the ~${YW_ASSUMED_DAILY_QUOTA.toLocaleString()}-unit quota most free API keys start with. If searches start failing, that's likely why — see “quota exceeded” errors below, or check the real number in Google Cloud Console.</p>`
          : ""
      }
    `;
  }

  function buildCacheKey(path, params) {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${path}?${sorted}`;
  }

  // Classifies a failed request into a small stable set of causes so
  // every call site can show one honest sentence instead of a raw
  // Google error blob. Covers: invalid API key, quota exceeded, rate
  // limiting, network failure, a generic API error response, and a
  // malformed (non-JSON) response. "Empty response" (0 results) is
  // deliberately NOT an error here — that's a normal outcome callers
  // already handle themselves.
  function classifyYtError(status, data, kind) {
    if (kind === "network") {
      return { code: "network_error", message: "Couldn't reach YouTube — check your connection and try again." };
    }
    if (kind === "malformed") {
      return { code: "malformed_response", message: "YouTube sent back something this app couldn't read — try again in a moment." };
    }
    const reason = data?.error?.errors?.[0]?.reason || "";
    const apiMessage = data?.error?.message || "";
    if (/keyInvalid|API_KEY_INVALID/i.test(reason) || (status === 400 && /API key not valid/i.test(apiMessage))) {
      return { code: "invalid_key", message: "That YouTube API key looks invalid — check it in ⚙ settings." };
    }
    if (status === 403 && /key/i.test(apiMessage) && /(restrict|forbidden)/i.test(reason)) {
      return { code: "invalid_key", message: "That YouTube API key looks restricted for this use — check its settings in Google Cloud Console." };
    }
    // Distinct from a used-up daily quota (below): rateLimitExceeded /
    // userRateLimitExceeded mean too many requests too quickly, not too
    // many for the day — a short pause and retry is the right response,
    // not "try again tomorrow."
    if (status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
      return { code: "rate_limited", message: "Too many YouTube requests too quickly — wait a few seconds and try again." };
    }
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
      return { code: "quota_exceeded", message: "Today's YouTube API quota looks used up — try again tomorrow, or use a different key." };
    }
    return { code: "api_error", message: apiMessage || `YouTube request failed (HTTP ${status}).` };
  }

  // The single request path every API call funnels through: attaches the
  // stored key, serves from cache when fresh, collapses duplicate
  // concurrent requests into one in-flight promise, classifies failures,
  // and records estimated quota usage on success.
  async function ytFetch(path, params, { cost = 1, ttlMs = 0 } = {}) {
    if (!apiKey) {
      throw Object.assign(new Error("A YouTube API key is needed for this — add one in ⚙ settings."), { code: "no_api_key" });
    }
    const cacheKey = buildCacheKey(path, params);

    if (ttlMs > 0) {
      const cached = ytCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        recordCacheHit();
        return cached.data;
      }
    }

    if (ytInFlight.has(cacheKey)) {
      recordDedupPrevented();
      return ytInFlight.get(cacheKey);
    }

    const requestPromise = (async () => {
      let res;
      try {
        const url = `${YT_API_BASE}${path}?${new URLSearchParams({ ...params, key: apiKey }).toString()}`;
        res = await fetch(url);
      } catch {
        const { code, message } = classifyYtError(0, null, "network");
        throw Object.assign(new Error(message), { code });
      }
      let data;
      try {
        data = await res.json();
      } catch {
        const { code, message } = classifyYtError(res.status, null, "malformed");
        throw Object.assign(new Error(message), { code });
      }
      if (!res.ok) {
        const { code, message } = classifyYtError(res.status, data, "api");
        throw Object.assign(new Error(message), { code });
      }
      recordApiCall(cost);
      if (ttlMs > 0) ytCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
      return data;
    })();

    ytInFlight.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      ytInFlight.delete(cacheKey);
    }
  }

  /* ---- the 7 API functions every YouTube feature builds on ---- */

  // searchVideos(query, { maxResults, pageToken, order, videoDuration, safeSearch })
  // -> raw search.list response ({ items, nextPageToken, prevPageToken, pageInfo, ... })
  function searchVideos(query, opts = {}) {
    const { maxResults = 8, pageToken, order, videoDuration, safeSearch } = opts;
    const params = { part: "snippet", type: "video", q: query, maxResults: String(maxResults) };
    if (pageToken) params.pageToken = pageToken;
    if (order) params.order = order;
    if (videoDuration) params.videoDuration = videoDuration;
    if (safeSearch) params.safeSearch = safeSearch;
    return ytFetch("search", params, { cost: YW_QUOTA_COST.search, ttlMs: YW_CACHE_TTL.search });
  }

  // searchChannels(query, { maxResults, pageToken }) -> raw search.list response (type=channel)
  function searchChannels(query, opts = {}) {
    const { maxResults = 5, pageToken } = opts;
    const params = { part: "snippet", type: "channel", q: query, maxResults: String(maxResults) };
    if (pageToken) params.pageToken = pageToken;
    return ytFetch("search", params, { cost: YW_QUOTA_COST.search, ttlMs: YW_CACHE_TTL.search });
  }

  // getChannel({ id } | { forHandle } | { forUsername }, parts) -> raw channels.list response
  function getChannel(identifier, parts) {
    const params = { part: parts || "snippet,contentDetails", ...identifier };
    return ytFetch("channels", params, { cost: YW_QUOTA_COST.channels, ttlMs: YW_CACHE_TTL.channelLookup });
  }

  // getChannelUploadsPlaylist(parsed) -> { uploadsId, channelId, channelTitle, channelThumbnail } | null
  // parsed comes from parseChannelInput(): { kind: "id"|"handle"|"username"|"query", value }.
  // Resolves in as few calls as possible: id/handle/username go straight
  // to channels.list (which can fetch snippet+contentDetails together —
  // the old code spent two separate channels.list calls doing this as
  // "look up the id, then look up the details" even for a known handle).
  async function getChannelUploadsPlaylist(parsed) {
    let chData = null;
    if (parsed.kind === "id") {
      chData = await getChannel({ id: parsed.value });
    } else if (parsed.kind === "handle") {
      chData = await getChannel({ forHandle: parsed.value });
    } else if (parsed.kind === "username") {
      chData = await getChannel({ forUsername: parsed.value });
      if (!chData?.items?.length) {
        // Legacy /c/ custom URLs aren't always real "usernames" — fall
        // back to a channel search on the same text.
        const searched = await searchChannels(parsed.value, { maxResults: 1 });
        const channelId = searched.items?.[0]?.id?.channelId || null;
        if (channelId) chData = await getChannel({ id: channelId });
      }
    } else {
      const searched = await searchChannels(parsed.value, { maxResults: 1 });
      const channelId = searched.items?.[0]?.id?.channelId || null;
      if (channelId) chData = await getChannel({ id: channelId });
    }
    const ch = chData?.items?.[0];
    const uploadsId = ch?.contentDetails?.relatedPlaylists?.uploads || null;
    if (!uploadsId) return null;
    return {
      uploadsId,
      channelId: ch.id,
      channelTitle: ch?.snippet?.title || parsed.value,
      channelThumbnail: ch?.snippet?.thumbnails?.default?.url || null,
    };
  }

  // getPlaylistVideos(playlistId, { maxResults, pageToken }) -> raw playlistItems.list response
  function getPlaylistVideos(playlistId, opts = {}) {
    const { maxResults = 50, pageToken } = opts;
    const params = { part: "snippet", playlistId, maxResults: String(maxResults) };
    if (pageToken) params.pageToken = pageToken;
    return ytFetch("playlistItems", params, { cost: YW_QUOTA_COST.playlistItems, ttlMs: YW_CACHE_TTL.playlistItems });
  }

  // Shared by getVideoDetails/getVideoStatistics: videos.list accepts at
  // most 50 IDs per call, so this chunks any longer list and merges the
  // results — callers (and future card-rendering UI) never fire one
  // request per video, however many results are on screen.
  async function batchedVideosRequest(videoIds, parts, ttlMs) {
    const ids = (Array.isArray(videoIds) ? videoIds : [videoIds]).filter(Boolean);
    if (!ids.length) return { items: [] };
    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const results = await Promise.all(
      chunks.map((chunk) => ytFetch("videos", { part: parts, id: chunk.join(",") }, { cost: YW_QUOTA_COST.videos, ttlMs }))
    );
    return { items: results.flatMap((r) => (Array.isArray(r.items) ? r.items : [])) };
  }

  // getVideoDetails(videoId | videoId[], { parts }) -> { items } (snippet + contentDetails by default)
  function getVideoDetails(videoIds, opts = {}) {
    return batchedVideosRequest(videoIds, opts.parts || "snippet,contentDetails", YW_CACHE_TTL.videoDetails);
  }

  // getVideoStatistics(videoId | videoId[], { parts }) -> { items } (statistics by default)
  // A caller that wants both details AND stats for the same IDs should
  // call getVideoDetails(ids, { parts: "snippet,contentDetails,statistics" })
  // instead of calling both — one batched request instead of two.
  function getVideoStatistics(videoIds, opts = {}) {
    return batchedVideosRequest(videoIds, opts.parts || "statistics", YW_CACHE_TTL.videoStats);
  }

  // Same chunk-and-merge shape as batchedVideosRequest, but against
  // channels.list — which also accepts up to 50 comma-joined IDs per
  // call. Used by Part 4's channel search to enrich a page of
  // search.list(type=channel) results (which carry no statistics) with
  // subscriber/video/view counts in one batched request per page,
  // never one request per card.
  async function batchedChannelsRequest(channelIds, parts, ttlMs) {
    const ids = (Array.isArray(channelIds) ? channelIds : [channelIds]).filter(Boolean);
    if (!ids.length) return { items: [] };
    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const results = await Promise.all(
      chunks.map((chunk) => ytFetch("channels", { part: parts, id: chunk.join(",") }, { cost: YW_QUOTA_COST.channels, ttlMs }))
    );
    return { items: results.flatMap((r) => (Array.isArray(r.items) ? r.items : [])) };
  }

  // getChannelsDetails(channelId | channelId[], { parts }) -> { items } (statistics by default)
  function getChannelsDetails(channelIds, opts = {}) {
    return batchedChannelsRequest(channelIds, opts.parts || "statistics", YW_CACHE_TTL.channelStats);
  }

  const YTApi = {
    searchVideos,
    searchChannels,
    getChannel,
    getChannelUploadsPlaylist,
    getPlaylistVideos,
    getVideoDetails,
    getVideoStatistics,
    getChannelsDetails,
    getUsageSnapshot: () => ({ ...quotaState, session: { ...sessionQuota } }),
  };

  /* ----------------------------------------------------------------------
     VIDEO ID EXTRACTION (Part 8) — supports watch/shorts/embed/live URLs,
     youtu.be short links, youtube-nocookie.com links, www./m./music.
     subdomain variants, http/https/no-scheme input, and a bare 11-char
     video ID typed directly. This is a pure, local, zero-network string
     parse — nothing here ever touches the API, which is what makes the
     "paste a link → play it" path free per the CRITICAL QUOTA REQUIREMENT
     (search() below routes straight to loadVideo() on an `id` result, and
     loadVideo() only ever constructs a trusted /embed/<id> URL from that
     already-validated ID — no search.list, no videos.list, ever, on this
     path).

     `parseVideoUrlInput()` is the richer classifier: it distinguishes
     three cases so the UI can react correctly to each —
       "id"      — a valid video ID, from a URL or typed bare    → play it
       "invalid" — recognizably a YouTube *video* URL (matched one of the
                 watch/shorts/embed/live/youtu.be shapes) but the ID part
                 didn't validate (missing, truncated, malformed)
                                                                  → clear error, no search fallback
       "text"    — anything else (a normal query, a non-video YouTube URL
                 like a channel link, a link to some other site)
                                                                  → normal text search
     `extractVideoId()` is kept as a thin wrapper (same signature/behavior
     as before — id-or-null) since loadVideo() and any external caller
     only ever need the ID, not the three-way classification.
  ---------------------------------------------------------------------- */
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseVideoUrlInput(raw) {
    const input = (raw || "").trim();
    if (!input) return { kind: "empty" };

    // Bare video ID typed directly — always the fast path.
    if (VIDEO_ID_RE.test(input)) return { kind: "id", videoId: input };

    // Only attempt URL parsing on things that look like an attempt at a
    // URL — an explicit scheme, or a single "word" containing a dot (a
    // bare host/path with no scheme, e.g. "youtu.be/xyz"). This keeps
    // ordinary multi-word search text (which may well contain a stray
    // dot or slash) from ever being run through the URL parser.
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    const looksUrlish = hasScheme || (!/\s/.test(input) && input.includes("."));
    if (!looksUrlish) return { kind: "text" };

    let url;
    try {
      url = new URL(hasScheme ? input : `https://${input}`);
    } catch {
      return { kind: "text" }; // not actually parseable as a URL — treat as search text
    }

    // Only accept http/https — never let some other scheme (javascript:,
    // data:, etc.) anywhere near URL construction below.
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "text" };

    const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, "");
    const isYouTube = host === "youtu.be" || host === "youtube.com" || host === "youtube-nocookie.com";
    if (!isYouTube) return { kind: "text" }; // some other site entirely — let it fall through to search

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return VIDEO_ID_RE.test(id) ? { kind: "id", videoId: id } : { kind: "invalid" };
    }

    // host is youtube.com or youtube-nocookie.com from here on.
    if (url.pathname === "/watch") {
      const v = url.searchParams.get("v") || "";
      return VIDEO_ID_RE.test(v) ? { kind: "id", videoId: v } : { kind: "invalid" };
    }
    const m = url.pathname.match(/^\/(embed|shorts|live)\/([^/?#]*)/);
    if (m) {
      return VIDEO_ID_RE.test(m[2]) ? { kind: "id", videoId: m[2] } : { kind: "invalid" };
    }

    // Recognized YouTube host but not shaped like a single-video URL at
    // all (a channel page, the homepage, /results?search_query=…, etc.)
    // — outside this feature's scope, so let it fall through to a normal
    // text search rather than manufacturing an error for it.
    return { kind: "text" };
  }

  function extractVideoId(raw) {
    const parsed = parseVideoUrlInput(raw);
    return parsed.kind === "id" ? parsed.videoId : null;
  }

  /* ----------------------------------------------------------------------
     STATUS MESSAGE (small line under the search bar)
  ---------------------------------------------------------------------- */
  let statusTimer = null;
  function showStatus(html, autoHideMs) {
    if (!statusEl) return;
    statusEl.innerHTML = html;
    statusEl.classList.toggle("hidden", !html);
    updateFooterActiveState();
    if (statusTimer) clearTimeout(statusTimer);
    if (autoHideMs) {
      statusTimer = setTimeout(() => {
        statusEl.classList.add("hidden");
        updateFooterActiveState();
      }, autoHideMs);
    }
  }

  /* ----------------------------------------------------------------------
     YOUTUBE IFRAME PLAYER API — loaded lazily, once, the first time a
     video actually plays. Using the real API (rather than a bare
     <iframe src="…">) is what makes the Loop toggle possible: raw iframes
     have no way for this file to know when a video ends.
  ---------------------------------------------------------------------- */
  function loadPlayerApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (playerReadyPromise) return playerReadyPromise;
    playerReadyPromise = new Promise((resolve, reject) => {
      const previousCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousCallback === "function") previousCallback();
        resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => reject(new Error("Couldn't load the YouTube player script."));
      document.head.appendChild(script);
    });
    return playerReadyPromise;
  }

  function ensurePlayerTarget() {
    let target = document.getElementById("yw-iframe-target");
    if (!target) {
      target = document.createElement("div");
      target.id = "yw-iframe-target";
      videoWrap.appendChild(target);
    }
    return target;
  }

  function destroyPlayer() {
    if (player) {
      try {
        player.destroy();
      } catch {
        /* non-fatal */
      }
      player = null;
    }
    playerReady = false;
    const target = document.getElementById("yw-iframe-target");
    if (target) target.remove();
  }

  function onPlayerStateChange(event) {
    if (!window.YT) return;
    if (event.data === window.YT.PlayerState.PLAYING) {
      setPlayingIndicator(true);
      // Playback Engine (Part 3) — the state we were waiting on to know
      // autoplay wasn't blocked, and the trigger to start the (modest,
      // stop-when-idle) progress ticker. See PLAYLIST PART 3 NOTES.
      clearAutoplayWatchdog();
      playbackBlocked = false;
      startProgressTicker();
      updateTransportUI();
    } else if (event.data === window.YT.PlayerState.ENDED) {
      stopProgressTicker();
      if (loopEnabled) {
        // Pre-existing single-video loop — unchanged, and still takes
        // priority over playlist auto-advance below (see PLAYLIST
        // FOUNDATION NOTES: the two systems are independent, but where
        // they meet, the person's explicit per-video loop wins).
        try {
          player.seekTo(0, true);
          player.playVideo();
        } catch {
          /* non-fatal */
        }
      } else if (playbackState.activePlaylistId && getCurrentQueueItem()?.videoId === currentVideoId) {
        // The video that just ended is still the active playlist's
        // current item (not a standalone video played while a playlist
        // happened to be active) — let the queue decide what's next,
        // per whatever repeat mode is set. playNextInQueue() itself
        // resolves "one"/"playlist"/"off" via getNextQueueIndex().
        if (!playNextInQueue()) {
          setPlayingIndicator(false);
          // Spec #3 — repeat=off, last item: stop progression, show an
          // ended state, keep the window/player alive, allow replay. See
          // PLAYLIST PART 3 NOTES.
          showPlaylistFinished();
        }
      } else {
        setPlayingIndicator(false);
      }
    } else if (event.data === window.YT.PlayerState.PAUSED) {
      setPlayingIndicator(false);
      stopProgressTicker();
      updateTransportUI();
    }
  }

  // The IFrame API's error event — distinct from Error 153 (which never
  // reaches here; the file:// case is caught before mountPlayer() runs).
  // event.data is one of the IFrame Player API's own error codes:
  //   2   invalid parameter — the video ID itself wasn't well-formed
  //   5   HTML5 player error — playback failed in this browser
  //   100 video not found — removed, or made private, by its owner
  //   101/150 embedding disallowed by the video's owner (two codes, same
  //       meaning — YouTube documents both)
  // Each gets its own honest sentence rather than one message covering
  // every case, per the spec's "video unavailable" vs "private/deleted
  // video" vs embedding-disabled being distinct states.
  function onPlayerError(event) {
    const code = event?.data;
    if (code === 100) {
      showStatus("This video isn't available — it may have been removed or made private by its owner.", 6000);
    } else if (code === 101 || code === 150) {
      showStatus("This video can't play here — its owner has disabled embedding. Try “Open on YouTube.com”.", 6000);
    } else if (code === 2) {
      showStatus("That video link doesn't look valid — double-check the URL and try again.", 6000);
    } else if (code === 5) {
      showStatus("This video hit a playback error in this browser's player — try again, or open it on YouTube.com.", 6000);
    } else {
      showStatus("This video couldn't be played here — try “Open on YouTube.com”.", 6000);
    }
    stopProgressTicker();
    clearAutoplayWatchdog();
    setPlayingIndicator(false);
    // Playback Engine (Part 3, spec #12/#13) — only a playlist's own
    // current item triggers auto-skip; a standalone video's error just
    // stops here, exactly as before this part. See PLAYLIST PART 3 NOTES.
    if (playbackState.activePlaylistId && getCurrentQueueItem()?.videoId === currentVideoId) {
      skipToNextPlayableAfterError();
    }
  }

  async function mountPlayer(id) {
    try {
      await loadPlayerApi();
    } catch {
      showStatus("Couldn't reach YouTube's player script — check your connection.", 5000);
      return;
    }
    ensurePlayerTarget();
    if (player) {
      try {
        player.loadVideoById(id);
        return;
      } catch {
        destroyPlayer();
        ensurePlayerTarget();
      }
    }
    player = new window.YT.Player("yw-iframe-target", {
      videoId: id,
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
        origin: window.location.origin || undefined,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }

  // Fires once per YT.Player instance, when it's actually ready to accept
  // setVolume()/mute() calls (calling those before this fires either
  // throws or silently no-ops, depending on browser). Applies whatever
  // volume/mute state the slider already has. The player instance is
  // reused across loadVideoById() calls (see mountPlayer above), so its
  // volume carries over to later videos on its own — no need to reapply.
  function onPlayerReady() {
    playerReady = true;
    try {
      player.setVolume(playerVolume);
      if (playerMuted) player.mute();
      else player.unMute();
    } catch {
      /* non-fatal */
    }
    reflectVolumeUI();
  }

  // Keeps the slider's thumb position and the mute button's icon/label in
  // sync with playerVolume/playerMuted — called after any change to
  // either, from either the slider, the mute button, or a fresh player
  // becoming ready.
  function reflectVolumeUI() {
    const effectiveVolume = playerMuted ? 0 : playerVolume;
    if (volumeSlider) volumeSlider.value = String(effectiveVolume);
    if (muteBtn) {
      const icon = effectiveVolume === 0 ? "🔇" : effectiveVolume < 50 ? "🔉" : "🔊";
      muteBtn.textContent = icon;
      muteBtn.setAttribute("aria-pressed", String(playerMuted));
      muteBtn.title = playerMuted ? "Unmute" : "Mute";
      muteBtn.setAttribute("aria-label", playerMuted ? "Unmute" : "Mute");
    }
  }
  reflectVolumeUI(); // reflect the restored state immediately, before any player exists

  volumeSlider?.addEventListener("input", () => {
    const v = Math.min(100, Math.max(0, parseInt(volumeSlider.value, 10) || 0));
    playerVolume = v || playerVolume || 100; // never let the *stored* volume collapse to 0 from a mute
    playerMuted = v === 0;
    saveJson(YW_VOLUME_STORAGE, playerVolume);
    saveJson(YW_MUTED_STORAGE, playerMuted);
    if (playerReady && player) {
      try {
        player.setVolume(v);
        if (v === 0) player.mute();
        else player.unMute();
      } catch {
        /* non-fatal */
      }
    }
    reflectVolumeUI();
  });

  muteBtn?.addEventListener("click", () => {
    playerMuted = !playerMuted;
    if (!playerMuted && playerVolume === 0) playerVolume = 100; // unmuting from a zeroed slider restores audible volume
    saveJson(YW_MUTED_STORAGE, playerMuted);
    saveJson(YW_VOLUME_STORAGE, playerVolume);
    if (playerReady && player) {
      try {
        if (playerMuted) player.mute();
        else {
          player.unMute();
          player.setVolume(playerVolume);
        }
      } catch {
        /* non-fatal */
      }
    }
    reflectVolumeUI();
  });

  function setPlayingIndicator(on) {
    playDotEl?.classList.toggle("hidden", !on);
    toggleBtn.classList.toggle("yw-playing-hidden", on && isMinimized);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // The window body is always exactly one of four views: the initial
  // placeholder, a search-results list (shared by both Videos and
  // Channels tabs — whichever tab is active decides what's actually
  // rendered into it), the live video player, or (Part 4) a channel
  // detail page. The file:// case (see file header) doesn't get its own
  // view anymore — it just swaps the empty-state text and adds a
  // one-line status note, so it never eats up space in the window.
  let currentBodyView = "empty"; // tracked so tab-switching can leave a playing video alone
  function setView(view) {
    currentBodyView = view;
    emptyStateEl?.classList.toggle("hidden", view !== "empty");
    resultsEl?.classList.toggle("hidden", view !== "results");
    videoWrap?.classList.toggle("hidden", view !== "video");
    channelDetailEl?.classList.toggle("hidden", view !== "channel-detail");
    playlistsEl?.classList.toggle("hidden", view !== "playlists");
    playlistDetailEl?.classList.toggle("hidden", view !== "playlist-detail");
    if (view === "empty") updateEmptyStateText();
    reflectBackToResultsUI(view);
    reflectPlaylistsBtnUI();
  }

  // Header entry-point button state — "on" while either playlist view is
  // showing, same visual language as the loop button's aria-pressed style.
  function reflectPlaylistsBtnUI() {
    const isPlaylistsView = currentBodyView === "playlists" || currentBodyView === "playlist-detail";
    playlistsBtn?.setAttribute("aria-pressed", String(isPlaylistsView));
    playlistsBtn?.classList.toggle("active", isPlaylistsView);
  }

  // The empty-state placeholder's copy depends on which tab is active —
  // "paste a video link" doesn't make sense while browsing channels.
  function updateEmptyStateText() {
    if (!emptyStateTextEl) return;
    emptyStateTextEl.textContent =
      activeSearchMode === "channels"
        ? "Search for a channel below to see its details right here."
        : "Search YouTube below, or paste a video link — it'll play right here with full controls.";
  }

  // A small floating pill over the player, shown only when (a) we're in
  // the video view and (b) there's somewhere meaningful to go back to —
  // either a video search with results waiting, or an open channel (its
  // detail view, videos and all, per Part 5) — so clicking a result to
  // play it never loses that context (per the spec: "keep search results
  // available"). `lastResultsContext` tracks which of the two a video was
  // most recently played from, so the pill knows where "back" goes and
  // what to call itself. Created once, lazily, and reused; no HTML
  // changes needed for this.
  let backToResultsBtn = null;
  let lastResultsContext = "search"; // "search" | "channel" — set right before loadVideo() from either list
  function ensureBackToResultsBtn() {
    if (backToResultsBtn || !videoWrap) return backToResultsBtn;
    backToResultsBtn = document.createElement("button");
    backToResultsBtn.type = "button";
    backToResultsBtn.id = "yw-back-to-results-btn";
    backToResultsBtn.className = "yw-back-to-results-btn hidden";
    backToResultsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (lastResultsContext === "channel" && selectedChannel) renderChannelDetail();
      else backToResults();
    });
    videoWrap.appendChild(backToResultsBtn);
    return backToResultsBtn;
  }
  function reflectBackToResultsUI(view) {
    if (!videoWrap) return;
    const btn = ensureBackToResultsBtn();
    if (!btn) return;
    const hasChannelToReturnTo = lastResultsContext === "channel" && !!selectedChannel;
    const hasSearchToReturnTo = searchState.items.length > 0;
    btn.classList.toggle("hidden", !(view === "video" && (hasChannelToReturnTo || hasSearchToReturnTo)));
    if (hasChannelToReturnTo) {
      btn.textContent = "◀ Channel";
      btn.title = "Back to channel";
    } else {
      btn.textContent = "◀ Results";
      btn.title = "Back to search results";
    }
  }

  function reflectLoopUI() {
    loopBtn?.setAttribute("aria-pressed", String(loopEnabled));
    if (loopBtn) loopBtn.title = loopEnabled ? "Loop this video: on — click to turn off" : "Loop this video: off — click to turn on";
  }

  function reflectStayOnTabUI() {
    if (stayOnTabToggle) stayOnTabToggle.checked = stayOnYoutubeTab;
  }

  // Relays the current "Keep YouTube tab open" preference to the Gemini
  // Bridge extension, if installed — same postMessage-bridge pattern as
  // the 🌐 Search on YouTube.com button above and syncAccentColorToExtension()/
  // syncTabSwitchKeysToExtension() in script.js. bridge-app.js relays this
  // to background.js, which stores it (chrome.storage.local) for both
  // itself (whether to close the search tab after a pick) and
  // content-youtube.js (whether to stop a video click from navigating at
  // all) to read. Entirely inert with no error if the extension isn't
  // installed. Fired once on load (so a freshly (re)started extension
  // picks up whatever was last saved here) and again every time the
  // toggle changes.
  function syncStayOnTabToExtension() {
    window.postMessage({ type: "SYNC_YT_STAY_MODE", stayOnTab: stayOnYoutubeTab }, window.location.origin);
  }

  // Part 6 — mirrors reflectLoopUI()'s pattern for the new layout toggle.
  function reflectLayoutModeUI() {
    if (!layoutToggleBtn) return;
    const isPlaylistFocused = layoutMode === "playlist";
    layoutToggleBtn.classList.toggle("active", isPlaylistFocused);
    layoutToggleBtn.setAttribute("aria-pressed", String(isPlaylistFocused));
    layoutToggleBtn.title = isPlaylistFocused ? "Layout: Playlist-focused — click for Player-focused" : "Layout: Player-focused — click for Playlist-focused";
    layoutToggleBtn.setAttribute("aria-label", isPlaylistFocused ? "Switch to player-focused layout" : "Switch to playlist-focused layout");
  }

  // Mirrors applyCompactMode()'s win.classList.toggle() pattern — the
  // actual show/hide-on-hover behavior lives in CSS (see the
  // .yw-transport-bar rules in youtube-window.css); this just flips the
  // one class those rules key off, plus the settings checkbox.
  function applyTransportHideSetting() {
    win.classList.toggle("yw-transport-permanent-hide", transportPermanentlyHidden);
    if (transportHideToggle) transportHideToggle.checked = transportPermanentlyHidden;
  }

  function reflectOpenExternalUI() {
    if (openExternalBtn) {
      openExternalBtn.disabled = !currentVideoId;
      openExternalBtn.title = currentVideoId
        ? "Open on YouTube.com — for Like, Subscribe, Save, Download, and everything else only Google's own site can do"
        : "Load a video first";
    }
    // Playlist Part 2B1 — same enabled/disabled pattern as ↗ above.
    if (addCurrentBtn) {
      addCurrentBtn.disabled = !currentVideoId;
      addCurrentBtn.title = currentVideoId ? "Add to Playlist" : "Load a video first";
    }
  }

  /* ----------------------------------------------------------------------
     COMPACT MODE — apply state to the DOM, reflect it into the settings
     panel's controls, and drive the footer search area's reveal/hide.
  ---------------------------------------------------------------------- */
  function applyCompactMode() {
    win.classList.toggle("yw-compact", compactSettings.enabled);
    // "Classic header bar" (hover-to-reveal header) is now a standalone
    // toggle, independent of Compact Mode — see the Header Bar settings
    // section in index.html. It no longer requires compactSettings.enabled.
    win.classList.toggle("yw-compact-bar", compactSettings.headerBarMode);
    YW_COMPACT_BUTTON_KEYS.forEach((key) => {
      const el = compactButtonEls[key];
      if (!el) return;
      el.classList.toggle("yw-compact-allowed", !!compactSettings.allowed[key]);
    });
    if (!compactSettings.enabled) {
      // Leaving compact mode: the search area should just be a normal,
      // always-visible part of the footer again — drop any leftover
      // "revealed" state/timer from before it was turned off.
      clearFooterHideTimer();
      footerSearchArea?.classList.remove("yw-search-area-visible");
      dragHandle?.classList.remove("yw-revealed");
    }
    // The footer overlay's active/inactive state depends on compact mode
    // itself (inactive-by-default only applies while compact is on), so
    // re-derive it any time compact mode flips either way.
    updateFooterActiveState();
  }

  // Compact Mode — the footer wrapper (search area + status line) floats
  // over the video with zero footprint until there's actually something
  // in it worth showing. "Something worth showing" is exactly: the
  // search area was explicitly revealed (via the search shortcut), or
  // the status line currently has a real message in it (e.g. "Error
  // 153"). Called from showFooterSearchArea()/hideFooterSearchArea() and
  // from showStatus() (both when a message is set and when its auto-hide
  // timer clears it) so the overlay never lags behind what's actually
  // inside it. Outside compact mode this is a no-op — the footer is just
  // a normal, always-visible part of the layout there.
  function updateFooterActiveState() {
    if (!footerEl) return;
    if (!compactSettings.enabled) {
      footerEl.classList.remove("yw-footer-active");
      return;
    }
    const searchVisible = !!footerSearchArea?.classList.contains("yw-search-area-visible");
    const hasStatus = !!statusEl && !statusEl.classList.contains("hidden") && statusEl.textContent.trim() !== "";
    footerEl.classList.toggle("yw-footer-active", searchVisible || hasStatus);
  }

  function formatCompactDelayLabel(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return rem === 0 ? `${mins} min` : `${mins}m ${rem}s`;
  }

  function reflectCompactSettingsUI() {
    if (compactModeToggle) compactModeToggle.checked = compactSettings.enabled;
    if (compactHeaderBarToggle) compactHeaderBarToggle.checked = compactSettings.headerBarMode;
    compactOptionsEl?.classList.toggle("hidden", !compactSettings.enabled);
    compactTickInputs.forEach((input) => {
      const key = input.dataset.compactTick;
      input.checked = !!compactSettings.allowed[key];
    });
    compactHideModeRadios.forEach((radio) => {
      radio.checked = radio.value === compactSettings.hideMode;
    });
    if (compactDelaySlider) compactDelaySlider.value = String(compactSettings.hideSeconds);
    if (compactDelayValueEl) compactDelayValueEl.textContent = formatCompactDelayLabel(compactSettings.hideSeconds);
    compactDelayRow?.classList.toggle("yw-compact-delay-disabled", compactSettings.hideMode === "onlyAfterSearch");
  }

  // FOOTER SEARCH AREA (Compact Mode) — hidden by default while compact
  // mode is on; revealed only by showFooterSearchArea() (called from
  // focusSearch(), i.e. the "Focus YouTube Window Search Bar" shortcut —
  // never by hover, per the spec), then hidden again either the moment a
  // real search fires (hideFooterSearchArea(), called from search()/
  // searchChannelsQuery()/findChannelVideo() below) or, in "Auto-hide
  // after a delay" mode, once compactSettings.hideSeconds elapses with no
  // search at all.
  let footerHideTimer = null;
  function clearFooterHideTimer() {
    if (footerHideTimer) {
      clearTimeout(footerHideTimer);
      footerHideTimer = null;
    }
  }
  function showFooterSearchArea() {
    if (!compactSettings.enabled || !footerSearchArea) return;
    footerSearchArea.classList.add("yw-search-area-visible");
    updateFooterActiveState();
    clearFooterHideTimer();
    if (compactSettings.hideMode === "timer") {
      footerHideTimer = setTimeout(() => {
        hideFooterSearchArea();
      }, compactSettings.hideSeconds * 1000);
    }
  }
  function hideFooterSearchArea() {
    clearFooterHideTimer();
    footerSearchArea?.classList.remove("yw-search-area-visible");
    updateFooterActiveState();
  }
  // Called right as a genuine search/lookup is about to run — hides the
  // search area regardless of hideMode, since "searched something" is
  // the one condition both auto-hide modes agree should hide it.
  function hideFooterSearchAreaOnSearch() {
    if (compactSettings.enabled) hideFooterSearchArea();
  }

  /* ----------------------------------------------------------------------
     WINDOW CHROME — open/close/hide/show, mirroring the Map Window
  ---------------------------------------------------------------------- */
  function clampToViewport() {
    const maxLeft = Math.max(0, window.innerWidth - win.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - win.offsetHeight);
    if (win.style.left) {
      win.style.left = `${Math.min(parseFloat(win.style.left) || 0, maxLeft)}px`;
    }
    if (win.style.top) {
      win.style.top = `${Math.min(parseFloat(win.style.top) || 0, maxTop)}px`;
    }
  }

  function persistState() {
    saveJson(YW_STATE_STORAGE, {
      left: win.style.left || null,
      top: win.style.top || null,
      width: win.offsetWidth,
      height: win.offsetHeight,
    });
  }

  function restoreState() {
    const s = loadJson(YW_STATE_STORAGE, null);
    if (!s) return;
    if (s.left && s.top) {
      win.style.left = s.left;
      win.style.top = s.top;
      win.style.right = "auto";
      win.style.bottom = "auto";
    }
    if (isFinite(s.width) && s.width > 0) {
      const capW = Math.min(YW_MAX_WIDTH, window.innerWidth - 32);
      win.style.width = `${Math.min(capW, Math.max(YW_MIN_WIDTH, s.width))}px`;
    }
    if (isFinite(s.height) && s.height > 0) {
      const capH = Math.min(YW_MAX_HEIGHT, window.innerHeight - 32);
      win.style.height = `${Math.min(capH, Math.max(YW_MIN_HEIGHT, s.height))}px`;
    }
    clampToViewport();
  }

  function reflectToggleUI() {
    const showingPlaying = isActive && !isMinimized;
    toggleBtn.setAttribute("aria-pressed", String(isActive));
    toggleBtn.classList.toggle("active", showingPlaying);
    toggleBtn.classList.toggle("yw-playing-hidden", isActive && isMinimized && !!currentVideoId);
    toggleBtn.title = !isActive
      ? "YouTube Window: OFF"
      : isMinimized
      ? "YouTube Window: hidden (still playing) — click to show"
      : "YouTube Window: ON";
  }

  function open() {
    isActive = true;
    isMinimized = false;
    win.classList.remove("hidden");
    win.classList.remove("yw-minimized");
    requestAnimationFrame(() => {
      win.classList.add("yw-open");
      clampToViewport();
    });
    win.setAttribute("aria-hidden", "false");
    saveJson(YW_ACTIVE_STORAGE, true);
    reflectToggleUI();
    if (!currentVideoId) {
      // Compact Mode — the search bar only ever reveals itself via the
      // "Focus YouTube Window Search Bar" shortcut (see focusSearch()),
      // never just because the window opened, so don't auto-focus (and
      // thereby auto-reveal) a search box that's meant to stay tucked
      // away until asked for.
      if (!compactSettings.enabled) searchInput?.focus();
    }
  }

  function show() {
    if (!isActive) return open();
    isMinimized = false;
    win.classList.remove("yw-minimized");
    win.classList.remove("hidden");
    requestAnimationFrame(() => {
      win.classList.add("yw-open");
      clampToViewport();
    });
    win.setAttribute("aria-hidden", "false");
    reflectToggleUI();
  }

  function hide() {
    if (!isActive) return;
    if (currentVideoId) {
      // Keep playing: shrink visually instead of unmounting.
      isMinimized = true;
      win.classList.add("yw-minimized");
      win.setAttribute("aria-hidden", "true");
      reflectToggleUI();
    } else {
      // Nothing playing — hiding is the same as a full close, there's
      // no playback to preserve.
      close();
    }
  }

  function close() {
    isActive = false;
    isMinimized = false;
    currentVideoId = null;
    currentVideoMeta = null;
    destroyPlayer();
    // Playback Engine (Part 3) — a real close (unlike hide()) tears
    // everything down, so its own runtime-only state shouldn't outlive
    // it either. See PLAYLIST PART 3 NOTES.
    stopProgressTicker();
    clearAutoplayWatchdog();
    playlistFinished = false;
    playbackBlocked = false;
    hideTransportBar();
    if (resultsEl) resultsEl.innerHTML = "";
    if (channelDetailEl) channelDetailEl.innerHTML = "";
    if (playlistsEl) playlistsEl.innerHTML = "";
    if (playlistDetailEl) playlistDetailEl.innerHTML = "";
    currentDetailPlaylistId = null;
    // Part 6.1C fix — close() already tears down every other per-view
    // state (search, channel, playlist menus/modals) below; the
    // virtualized-playlist scroll/rAF state was the one piece left
    // dangling, holding a reference (and an active scroll listener) on
    // the DOM node this innerHTML reset just detached.
    teardownVirtualPlaylist();
    closeAllPlaylistMenus();
    closeAddToPlaylistMenu();
    closePlaylistNameModal();
    closePlaylistDeleteModal();
    resetSearchState("");
    resetChannelSearchState("");
    resetChannelVideosState(null, null);
    selectedChannel = null;
    lastResultsContext = "search";
    activeSearchMode = "videos";
    reflectTabsUI();
    setView("empty");
    if (searchInput) searchInput.value = "";
    showStatus("");
    setPlayingIndicator(false);
    reflectOpenExternalUI();
    settingsPanel?.classList.add("hidden");
    settingsBtn?.setAttribute("aria-expanded", "false");
    channelForm?.classList.add("hidden");
    win.classList.remove("yw-open", "yw-minimized");
    win.setAttribute("aria-hidden", "true");
    saveJson(YW_ACTIVE_STORAGE, false);
    setTimeout(() => {
      if (!isActive) win.classList.add("hidden");
    }, 220);
    reflectToggleUI();
  }

  function toggle() {
    if (!isActive) return open();
    if (isMinimized) return show();
    return hide();
  }

  // FOCUS SEARCH — the "Focus YouTube Window Search Bar" keyboard
  // shortcut's in-app half (see focusYoutubeSearch in script.js's
  // CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM). Opens the window if it's
  // closed, un-minimizes it if it's just hidden-while-playing, then puts
  // the text cursor in the search bar either way — including when a
  // video is already loaded, which open() alone doesn't do (it only
  // auto-focuses the search bar when nothing's currently playing).
  function focusSearch() {
    if (!isActive) {
      open();
    } else if (isMinimized) {
      show();
    }
    // Compact Mode — this shortcut is the ONLY way the search bar
    // reveals itself (never on hover); see showFooterSearchArea().
    showFooterSearchArea();
    searchInput?.focus();
    searchInput?.select?.();
  }

  /* ----------------------------------------------------------------------
     LOAD VIDEO — plays a known video ID right here. Never needs an API
     key, since a specific video's /embed/ URL is public and always
     frameable (modulo the file:// case explained in the file header,
     and modulo the video owner disallowing embedding entirely).
  ---------------------------------------------------------------------- */
  function loadVideo(videoId, opts = {}) {
    // extractVideoId() already covers a bare 11-char ID as well as every
    // supported URL shape (see VIDEO ID EXTRACTION above), so a single
    // call is sufficient here.
    const id = extractVideoId(videoId);
    if (!id) return false;
    if (!isActive) open();
    else show();

    if (isFileProtocol) {
      // Don't even attempt the embed — it will always fail with Error
      // 153 (see file header). A short, non-blocking status note
      // explains why instead of YouTube's own confusing error screen.
      currentVideoId = null;
      currentVideoMeta = null;
      setView("empty");
      reflectOpenExternalUI();
      showStatus("Playback needs the page served over http:// (not file://) — that's what Error 153 was.");
      if (searchInput) searchInput.value = "";
      return true;
    }

    currentVideoId = id;
    // Playlist Part 2B1 — capture whatever metadata the caller already
    // has in hand (a search-result row, a playlist item) so "+ Add to
    // Playlist" on this video never has to re-fetch it. No metadata at
    // all (a pasted link/ID) falls back to a bare title per spec #9.
    currentVideoMeta = {
      videoId: id,
      title: (opts.meta && opts.meta.title) || "YouTube Video",
      channelTitle: (opts.meta && opts.meta.channelTitle) || "",
      thumbnailUrl: (opts.meta && (opts.meta.thumbnailUrl || opts.meta.thumb)) || "",
      duration: (opts.meta && opts.meta.duration) || null,
    };
    mountPlayer(id);
    // Part 6 — layout mode. A playlist-sourced load in "playlist-focused"
    // mode stays on (or jumps to) that playlist's detail view instead of
    // switching to the video panel; the docked transport bar (moved onto
    // #yw-body in ensureTransportBar()) still supplies Play/Pause/Next/
    // Previous/Shuffle/Repeat regardless. Every other load path — search
    // results, pasted links, channel videos, and playlist loads while in
    // the default "player-focused" mode — is completely unchanged.
    if (opts.source === "playlist" && layoutMode === "playlist" && (playbackState.activePlaylistId || currentDetailPlaylistId)) {
      const targetPlaylistId = playbackState.activePlaylistId || currentDetailPlaylistId;
      // Avoid rebuilding the (possibly virtualized, possibly 1000-item)
      // playlist-detail view on every single track change — Next/
      // Previous/autoplay already gets its active-row highlight updated
      // cheaply via playPlaylistItem()'s notifyPlaylistUIOfPlaybackChange()
      // right after this returns. Only do the fuller openPlaylistDetail()
      // switch when we're not already sitting on that exact view.
      if (currentBodyView !== "playlist-detail" || currentDetailPlaylistId !== targetPlaylistId) {
        openPlaylistDetail(targetPlaylistId);
      }
    } else {
      setView("video");
    }
    setPlayingIndicator(true);
    reflectOpenExternalUI();
    // Pasted-link path (Part 8) briefly names the recognized ID, so
    // pasting is legible feedback rather than a silent jump to a player —
    // clicking a result card already shows a video, so it keeps the
    // plainer message.
    showStatus(
      opts.source === "paste" ? `Recognized video ID “${escapeHtml(id)}” — playing in-window.` : "Playing in-window with full YouTube controls.",
      3500
    );
    if (searchInput) searchInput.value = "";
    return true;
  }

  /* ----------------------------------------------------------------------
     PLAYLISTS (Playlist Part 1 — data model, persistence, and the
     playback-queue abstraction) — see "PLAYLIST FOUNDATION NOTES" at the
     end of the big file-header comment for the full writeup. Short
     version: two separate persisted concerns (playlist definitions vs.
     playback state), no artificial count limits anywhere, deterministic
     shuffle, repeat modes independent of the pre-existing single-video
     `loopEnabled`, and zero new YouTube API calls — playback always goes
     through the existing `loadVideo()` with a known video ID.
  ---------------------------------------------------------------------- */
  const YW_PLAYLISTS_STORAGE = "vocabRegister_youtubePlaylists"; // Playlist[] — persistent user data
  const YW_PLAYBACK_STATE_STORAGE = "vocabRegister_youtubePlaybackState"; // queue position / repeat / shuffle — session preference data

  function genId(prefix) {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return `${prefix}-${window.crypto.randomUUID()}`;
      }
    } catch {
      /* fall through to the fallback below */
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Generic trailing-edge debounce — collapses a burst of calls (adding
  // many playlist items back-to-back, rapid "next" clicks) into a single
  // execution of `fn` using the LAST call's arguments. `.flush()` runs
  // immediately if a call is pending, used on `beforeunload` below so a
  // person closing the tab right after an edit doesn't lose it.
  function debounce(fn, wait) {
    let t = null;
    let pendingArgs = null;
    const debounced = (...args) => {
      pendingArgs = args;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        const a = pendingArgs;
        pendingArgs = null;
        fn(...a);
      }, wait);
    };
    debounced.flush = () => {
      if (t) {
        clearTimeout(t);
        t = null;
        const a = pendingArgs || [];
        pendingArgs = null;
        fn(...a);
      }
    };
    return debounced;
  }

  /* ---- Playlist definitions (persistent user data) ----------------- */

  // Loaded once at startup. Malformed/corrupted storage (wrong type,
  // half-written JSON, an old/foreign shape, duplicate ids, an item with
  // no videoId, etc.) degrades to as much of the list as is usable
  // rather than throwing or wiping everything — losing a few bad rows is
  // fine, crashing the whole window over them is not.
  // Shared by loadPlaylistsFromStorage() (localStorage) AND the Folder
  // Sync block below (a JSON file read back from a connected local
  // folder) — same shape, same defensive cleaning, either way. Kept
  // separate from sanitizeImportedPlaylist() (Playlist Part 5): import
  // always mints fresh ids because it's merging in data that may have
  // come from a different browser/profile, but both sources handled
  // here are trusted to be OUR OWN previously-saved data, so ids (and
  // therefore things like `playbackState.activePlaylistId` still
  // pointing at the right playlist) must be preserved, not regenerated.
  function sanitizeStoredPlaylistsArray(raw) {
    if (!Array.isArray(raw)) return [];
    const seenPlaylistIds = new Set();
    const cleaned = [];
    for (const p of raw) {
      if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || seenPlaylistIds.has(p.id)) continue;
      seenPlaylistIds.add(p.id);
      const rawItems = Array.isArray(p.items) ? p.items : [];
      const seenItemIds = new Set();
      const items = [];
      for (const it of rawItems) {
        if (!it || typeof it !== "object" || typeof it.videoId !== "string" || !it.videoId) continue;
        let itemId = typeof it.id === "string" && it.id ? it.id : genId("item");
        if (seenItemIds.has(itemId)) itemId = genId("item");
        seenItemIds.add(itemId);
        items.push({
          id: itemId,
          videoId: it.videoId,
          title: typeof it.title === "string" && it.title ? it.title : "Untitled",
          channelTitle: typeof it.channelTitle === "string" ? it.channelTitle : "",
          thumbnailUrl: typeof it.thumbnailUrl === "string" ? it.thumbnailUrl : "",
          duration: typeof it.duration === "string" ? it.duration : null,
          addedAt: typeof it.addedAt === "number" ? it.addedAt : Date.now(),
        });
        // No cap here — a playlist keeps every item the person added
        // (spec requirement: no fixed max videos per playlist).
      }
      const cleanedPlaylist = {
        id: p.id,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Untitled playlist",
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
        updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now(),
        items,
      };
      // YOUTUBE PLAYLIST IMPORT — carried through only when this playlist
      // was created by importYoutubePlaylist() (see that block above).
      // sourcePlaylistNextPageToken is what lets "Load more from YouTube"
      // keep working after a reload without re-fetching page 1 again;
      // sourcePlaylistId is also how importYoutubePlaylist() recognizes
      // "already imported this one" and reuses it instead of duplicating.
      if (typeof p.sourcePlaylistId === "string" && p.sourcePlaylistId) {
        cleanedPlaylist.sourcePlaylistId = p.sourcePlaylistId;
        cleanedPlaylist.sourcePlaylistNextPageToken =
          typeof p.sourcePlaylistNextPageToken === "string" && p.sourcePlaylistNextPageToken
            ? p.sourcePlaylistNextPageToken
            : null;
      }
      cleaned.push(cleanedPlaylist);
      // No cap here either — no fixed max number of playlists.
    }
    return cleaned;
  }

  function loadPlaylistsFromStorage() {
    return sanitizeStoredPlaylistsArray(loadJson(YW_PLAYLISTS_STORAGE, []));
  }

  let playlists = loadPlaylistsFromStorage();

  // Playlist Part 5 (spec #9 — storage failure handling). A plain
  // saveJson() call would swallow a full-storage error silently, same as
  // every other persisted key in this file — fine for a volume slider,
  // not fine for "the data a person would be upset to lose" (see
  // PLAYLIST FOUNDATION NOTES). This wrapper is used ONLY for the
  // playlists array, not playbackState/prefs, and:
  //   - never touches the in-memory `playlists` array on failure, so a
  //     write that can't be persisted never becomes a playlist that gets
  //     deleted or silently reverted;
  //   - shows exactly one warning per failure "episode" (not one per
  //     debounced write) via `playlistStorageWarningActive`, which only
  //     resets once a write actually succeeds again;
  //   - points at Export (Playlist Part 5's own backup feature, below)
  //     as the actual way to not lose anything, rather than just naming
  //     the problem.
  let playlistStorageWarningActive = false;
  // Folder Sync (see the "PLAYLIST FOLDER SYNC" block further down) — when
  // a local folder is connected, playlists are written THERE instead of
  // localStorage, which is the whole point (a folder has no ~5-10MB quota
  // the way localStorage does). localStorage keeps working as the default
  // fallback for anyone who never connects a folder, and as a same-tab
  // safety net if a folder write fails mid-session (permission revoked,
  // folder moved/deleted, disk full, etc.) so nothing already typed is
  // lost even though the live sync hiccuped.
  function savePlaylistsToStorage() {
    if (window.YouTubePlaylistFolder && window.YouTubePlaylistFolder.isConnected()) {
      window.YouTubePlaylistFolder.writePlaylists(playlists).then((ok) => {
        if (ok) {
          playlistStorageWarningActive = false;
          renderFolderSyncStatus();
          return;
        }
        // Folder write failed this time — fall back to localStorage so the
        // change isn't lost outright, and surface exactly one warning per
        // failure "episode" (same convention as the localStorage-quota
        // warning below).
        saveJson(YW_PLAYLISTS_STORAGE, playlists);
        if (!playlistStorageWarningActive) {
          playlistStorageWarningActive = true;
          showStatus("⚠ Couldn't write to your connected folder — saving to browser storage instead this time. Check the folder still exists and permission wasn't revoked.", 8000);
        }
        renderFolderSyncStatus();
      });
      return true; // optimistic — matches this function's existing sync return shape; the actual outcome is handled async above
    }
    try {
      localStorage.setItem(YW_PLAYLISTS_STORAGE, JSON.stringify(playlists));
      playlistStorageWarningActive = false;
      return true;
    } catch {
      // QuotaExceededError (storage full) or a private-browsing quirk —
      // either way, non-fatal: the session keeps working from memory.
      if (!playlistStorageWarningActive) {
        playlistStorageWarningActive = true;
        showStatus("⚠ Browser storage is full — this change may not be saved. Delete an old playlist to free up space, connect a 📁 local folder (My Playlists → 📁 Folder) to sync there instead, or use Export to back up what's already saved.", 9000);
      }
      return false;
    }
  }

  // See file-header PLAYLIST FOUNDATION NOTES — debounced so building a
  // large playlist doesn't re-stringify+write the whole array per click.
  const persistPlaylistsDebounced = debounce(() => {
    savePlaylistsToStorage();
  }, 400);

  // beforeunload can't await anything — the tab may already be gone
  // before an in-flight folder write (File System Access is always
  // async) finishes. flush() still kicks that write off on a best-effort
  // basis, but as a synchronous safety net ALSO mirrors the current
  // in-memory `playlists` straight into localStorage right here, folder
  // sync or not. Normal editing never touches localStorage while a
  // folder's connected (that's the point of this feature — avoiding its
  // quota) — this is a one-time, tab-closing-anyway exception, not a
  // regression back to writing there on every change.
  window.addEventListener("beforeunload", () => {
    persistPlaylistsDebounced.flush();
    try {
      localStorage.setItem(YW_PLAYLISTS_STORAGE, JSON.stringify(playlists));
    } catch {
      /* non-fatal — quota exceeded or private browsing; the folder write
         (if connected) already had its best-effort shot via flush() above */
    }
  });

  function touchPlaylist(playlist) {
    playlist.updatedAt = Date.now();
  }

  function getPlaylist(playlistId) {
    return playlists.find((p) => p.id === playlistId) || null;
  }

  function getAllPlaylists() {
    return playlists;
  }

  function createPlaylist(name) {
    const playlist = {
      id: genId("pl"),
      name: (name && String(name).trim()) || "Untitled playlist",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
    };
    playlists.push(playlist); // no cap — unlimited playlists, per spec
    persistPlaylistsDebounced();
    return playlist;
  }

  function renamePlaylist(playlistId, name) {
    const playlist = getPlaylist(playlistId);
    const trimmed = (name && String(name).trim()) || "";
    if (!playlist || !trimmed) return false;
    playlist.name = trimmed;
    touchPlaylist(playlist);
    persistPlaylistsDebounced();
    return true;
  }

  function deletePlaylist(playlistId) {
    const idx = playlists.findIndex((p) => p.id === playlistId);
    if (idx === -1) return false;
    playlists.splice(idx, 1);
    persistPlaylistsDebounced();
    // A now-dangling activePlaylistId would make every queue function
    // silently no-op — stop cleanly instead.
    if (playbackState.activePlaylistId === playlistId) stopPlaylist();
    return true;
  }

  // `source` is anything with videoId + optional title/channelTitle/
  // duration/thumbnailUrl (or `thumb`, matching shapeResultRow()'s field
  // name) — so a raw search-result row can be handed straight in later
  // without reshaping it first.
  function addItemToPlaylist(playlistId, source) {
    const playlist = getPlaylist(playlistId);
    if (!playlist || !source || !source.videoId) return null;
    const item = {
      id: genId("item"),
      videoId: source.videoId,
      title: source.title || "Untitled",
      channelTitle: source.channelTitle || "",
      thumbnailUrl: source.thumbnailUrl || source.thumb || "",
      duration: source.duration || null,
      addedAt: Date.now(),
    };
    playlist.items.push(item); // append only — never disturbs currentIndex of an active queue
    touchPlaylist(playlist);
    persistPlaylistsDebounced();
    invalidateShuffleIfActive(playlistId);
    return item;
  }

  function removeItemFromPlaylist(playlistId, itemId) {
    const playlist = getPlaylist(playlistId);
    if (!playlist) return false;
    const idx = playlist.items.findIndex((it) => it.id === itemId);
    if (idx === -1) return false;

    const wasActive = playbackState.activePlaylistId === playlistId;
    const currentItemId = wasActive ? getCurrentQueueItem()?.id || null : null;
    const removingCurrent = currentItemId === itemId;

    playlist.items.splice(idx, 1);
    touchPlaylist(playlist);
    persistPlaylistsDebounced();

    if (wasActive) {
      if (!playlist.items.length) {
        stopPlaylist();
      } else {
        if (removingCurrent) {
          // The playing item was itself removed — don't cut playback,
          // just clamp the pointer to the nearest remaining item; the
          // player keeps playing whatever's already loaded until the
          // person (or auto-advance) moves on.
          playbackState.currentIndex = Math.min(idx, playlist.items.length - 1);
        } else if (currentItemId) {
          playbackState.currentIndex = playlist.items.findIndex((it) => it.id === currentItemId);
        }
        if (playbackState.shuffleEnabled) rebuildShuffleOrder(playlist, { preserveCurrent: true });
        persistPlaybackStateDebounced();
      }
    }
    return true;
  }

  function reorderPlaylistItem(playlistId, itemId, newIndex) {
    const playlist = getPlaylist(playlistId);
    if (!playlist) return false;
    const oldIndex = playlist.items.findIndex((it) => it.id === itemId);
    if (oldIndex === -1) return false;

    const wasActive = playbackState.activePlaylistId === playlistId;
    const currentItemId = wasActive ? getCurrentQueueItem()?.id || null : null;

    const clampedIndex = Math.max(0, Math.min(newIndex, playlist.items.length - 1));
    const [moved] = playlist.items.splice(oldIndex, 1);
    playlist.items.splice(clampedIndex, 0, moved);
    touchPlaylist(playlist);
    persistPlaylistsDebounced();

    if (wasActive && currentItemId) {
      // Re-locate the still-playing item by id — a reorder must never
      // make playback silently jump to whatever item now sits at the
      // old numeric index.
      playbackState.currentIndex = playlist.items.findIndex((it) => it.id === currentItemId);
      if (playbackState.shuffleEnabled) rebuildShuffleOrder(playlist, { preserveCurrent: true });
      persistPlaybackStateDebounced();
    }
    return true;
  }

  /* ---- Playback state (session/preference data — kept separate from
     the playlist definitions above; see PLAYLIST FOUNDATION NOTES) --- */
  function loadPlaybackStateFromStorage() {
    const raw = loadJson(YW_PLAYBACK_STATE_STORAGE, null);
    const validRepeatMode = raw && (raw.repeatMode === "off" || raw.repeatMode === "playlist" || raw.repeatMode === "one");
    // upNext (Part 2B2 — "Play Next", spec #5): a small FIFO of one-off
    // track snapshots, deliberately NOT indices into any playlist. This
    // keeps it independent of `playlist.items` order/shuffleOrder — the
    // saved playlist and the temporary "what plays after this" queue are
    // two different things, per spec #9/#5. Malformed entries (no
    // videoId) are dropped rather than discarding the whole queue.
    const rawUpNext = raw && Array.isArray(raw.upNext) ? raw.upNext : [];
    const upNext = rawUpNext
      .filter((it) => it && typeof it === "object" && typeof it.videoId === "string" && it.videoId)
      .map((it) => ({
        videoId: it.videoId,
        title: typeof it.title === "string" && it.title ? it.title : "Untitled",
        channelTitle: typeof it.channelTitle === "string" ? it.channelTitle : "",
        thumbnailUrl: typeof it.thumbnailUrl === "string" ? it.thumbnailUrl : "",
        duration: typeof it.duration === "string" ? it.duration : null,
      }));
    return {
      activePlaylistId: raw && typeof raw.activePlaylistId === "string" ? raw.activePlaylistId : null,
      currentIndex: raw && typeof raw.currentIndex === "number" ? raw.currentIndex : -1,
      repeatMode: validRepeatMode ? raw.repeatMode : "off",
      shuffleEnabled: !!(raw && raw.shuffleEnabled === true),
      shuffleOrder: raw && Array.isArray(raw.shuffleOrder) ? raw.shuffleOrder.filter((n) => Number.isInteger(n)) : [],
      shufflePosition: raw && typeof raw.shufflePosition === "number" ? raw.shufflePosition : -1,
      upNext,
    };
  }

  let playbackState = loadPlaybackStateFromStorage();

  // A track change or a repeat/shuffle toggle is the only thing that
  // ever calls this — nothing here fires on player timeupdate/progress,
  // so a long-playing video generates zero writes while it plays.
  const persistPlaybackStateDebounced = debounce(() => {
    saveJson(YW_PLAYBACK_STATE_STORAGE, playbackState);
  }, 300);

  window.addEventListener("beforeunload", () => persistPlaybackStateDebounced.flush());

  // Playlist Part 4A (spec #13/#23) — whether two playlist ITEMS should
  // be treated as "the same song" for shuffle adjacency-avoidance, even
  // though they're separate entries with separate ids (a playlist can
  // legitimately contain the same video twice). Only videoId is
  // compared; each item's own id is naturally unique already (it's a
  // permutation), so id equality can never happen here.
  function sameShuffleTrack(itemA, itemB) {
    return !!itemA && !!itemB && itemA.videoId === itemB.videoId;
  }

  // Fisher-Yates — NOT `items.sort(() => Math.random() - 0.5)`, which is
  // both statistically biased and re-randomizes on every call. This
  // builds the order once; `shufflePosition` walks it, and the
  // underlying `playlist.items` order is never touched.
  //
  // `items` is the playlist's own `items` array (order math still works
  // over `[0..items.length-1]` positions into it, unchanged from
  // before) — it's needed now, not just a bare length, so the smoothing
  // pass below can compare videoIds. `avoidFirstItem` (spec #23/#25) is
  // optional: when starting a fresh shuffle cycle right after a
  // previous one ended, pass the item that cycle just finished on so
  // this one tries not to open on the same track.
  //
  // After the shuffle itself, one deterministic smoothing pass tries to
  // separate any two ADJACENT entries that share a videoId (spec #13 —
  // two playlist rows pointing at the same video shouldn't play back to
  // back if it can be avoided) by testing a swap against every other
  // position and keeping the first one that actually clears it. This
  // never re-randomizes/retries the whole shuffle — one bounded pass —
  // so a playlist saturated with one repeated video (spec #14, the
  // one-item case included) just leaves whatever adjacency it can't fix
  // rather than looping forever chasing an impossible arrangement.
  function generateShuffleOrder(items, { avoidFirstItem = null } = {}) {
    const order = Array.from({ length: items.length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    // True if the item at position `pos` shares a videoId with either
    // neighbor it currently has in `order`.
    const violatesAt = (pos) => {
      if (pos > 0 && sameShuffleTrack(items[order[pos - 1]], items[order[pos]])) return true;
      if (pos < order.length - 1 && sameShuffleTrack(items[order[pos]], items[order[pos + 1]])) return true;
      return false;
    };

    // Adjacent same-video avoidance (spec #13/#22). For each violating
    // position, try swapping it with every other position and keep the
    // swap only if it clears the violation at both positions without
    // creating a new one — checked in both directions (not just
    // forward), so a violation sitting at the very end of the order can
    // still be fixed by pulling in an earlier item. One deterministic
    // pass, no re-randomization; a slot that can't be fixed (spec #14 —
    // e.g. a playlist saturated with one repeated video) is left as-is.
    for (let i = 1; i < order.length; i++) {
      if (!violatesAt(i)) continue;
      for (let j = 0; j < order.length; j++) {
        if (j === i) continue;
        [order[i], order[j]] = [order[j], order[i]];
        if (!violatesAt(i) && !violatesAt(j)) break;
        [order[i], order[j]] = [order[j], order[i]]; // revert, try next j
      }
    }

    // Cycle-boundary avoidance (spec #23/#25) — try not to *open* this
    // cycle on the same track the previous one just closed on. Same
    // swap-and-verify approach so it never introduces a fresh adjacent
    // violation elsewhere in the order while fixing the boundary.
    if (avoidFirstItem && order.length > 1 && sameShuffleTrack(items[order[0]], avoidFirstItem)) {
      for (let j = 1; j < order.length; j++) {
        [order[0], order[j]] = [order[j], order[0]];
        const openViolates = sameShuffleTrack(items[order[0]], avoidFirstItem) || violatesAt(0);
        if (!openViolates && !violatesAt(j)) break;
        [order[0], order[j]] = [order[j], order[0]]; // revert, try next j
      }
    }

    return order;
  }

  // Regenerates `shuffleOrder` for `playlist` (e.g. after items were
  // added/removed/reordered). When `preserveCurrent` is set, re-locates
  // the still-canonical `playbackState.currentIndex` inside the fresh
  // order so an active shuffled queue never audibly jumps just because
  // the underlying list changed shape.
  function rebuildShuffleOrder(playlist, { preserveCurrent = false } = {}) {
    const anchorIndex = preserveCurrent ? playbackState.currentIndex : -1;
    playbackState.shuffleOrder = generateShuffleOrder(playlist.items);
    if (anchorIndex > -1 && anchorIndex < playlist.items.length) {
      const pos = playbackState.shuffleOrder.indexOf(anchorIndex);
      playbackState.shufflePosition = pos > -1 ? pos : -1;
    } else {
      playbackState.shufflePosition = -1;
    }
  }

  function invalidateShuffleIfActive(playlistId) {
    if (playbackState.activePlaylistId !== playlistId || !playbackState.shuffleEnabled) return;
    const playlist = getPlaylist(playlistId);
    if (!playlist) return;
    rebuildShuffleOrder(playlist, { preserveCurrent: true });
    persistPlaybackStateDebounced();
  }

  /* ---- Playback queue abstraction — centralized here rather than
     scattered across future UI event handlers ------------------------ */

  function getActivePlaylist() {
    return playbackState.activePlaylistId ? getPlaylist(playbackState.activePlaylistId) : null;
  }

  // `currentIndex` is canonical for "what's playing" in BOTH shuffle and
  // sequential mode — shuffle only ever decides what next/previous
  // resolve to, never what "current" means.
  function getCurrentQueueItem() {
    const playlist = getActivePlaylist();
    if (!playlist || playbackState.currentIndex < 0) return null;
    return playlist.items[playbackState.currentIndex] || null;
  }

  // Returns the visiting order (playlist-item indices) for the given
  // playlist — shuffled or sequential. Pure index math, no side effects;
  // useful for a future "up next" list without duplicating this logic.
  function buildPlaybackQueue(playlist) {
    const target = playlist || getActivePlaylist();
    if (!target || !target.items.length) return [];
    if (playbackState.shuffleEnabled) {
      return playbackState.shuffleOrder.length === target.items.length
        ? playbackState.shuffleOrder.slice()
        : generateShuffleOrder(target.items);
    }
    return target.items.map((_, i) => i);
  }

  function getNextQueueIndex() {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.items.length) return -1;

    if (playbackState.repeatMode === "one") {
      return playbackState.currentIndex > -1 ? playbackState.currentIndex : 0;
    }

    if (playbackState.shuffleEnabled) {
      if (playbackState.shuffleOrder.length !== playlist.items.length) rebuildShuffleOrder(playlist, { preserveCurrent: true });
      const nextPos = playbackState.shufflePosition + 1;
      if (nextPos < playbackState.shuffleOrder.length) return playbackState.shuffleOrder[nextPos];
      if (playbackState.repeatMode !== "playlist" || !playbackState.shuffleOrder.length) return -1;
      // Playlist Part 4A (spec #22/#25) — the shuffle cycle is exhausted
      // and Repeat Playlist is on: start a genuinely NEW cycle rather
      // than silently looping the same fixed order forever (that would
      // just be "repeat one fixed order", not shuffle). Avoid opening
      // the new cycle on the same track this one just ended on, where
      // possible (spec #23). `shufflePosition` is left at -1 here —
      // `playPlaylistItem()` re-anchors it via `shuffleOrder.indexOf()`
      // once this index is actually played, same as every other queue
      // move in this file.
      const lastItem = playlist.items[playbackState.shuffleOrder[playbackState.shuffleOrder.length - 1]];
      playbackState.shuffleOrder = generateShuffleOrder(playlist.items, { avoidFirstItem: lastItem });
      playbackState.shufflePosition = -1;
      return playbackState.shuffleOrder[0];
    }

    const nextIndex = playbackState.currentIndex + 1;
    if (nextIndex < playlist.items.length) return nextIndex;
    return playbackState.repeatMode === "playlist" ? 0 : -1;
  }

  function getPreviousQueueIndex() {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.items.length) return -1;

    if (playbackState.repeatMode === "one") {
      return playbackState.currentIndex > -1 ? playbackState.currentIndex : 0;
    }

    if (playbackState.shuffleEnabled) {
      if (playbackState.shuffleOrder.length !== playlist.items.length) rebuildShuffleOrder(playlist, { preserveCurrent: true });
      const prevPos = playbackState.shufflePosition - 1;
      if (prevPos >= 0) return playbackState.shuffleOrder[prevPos];
      return playbackState.repeatMode === "playlist" && playbackState.shuffleOrder.length
        ? playbackState.shuffleOrder[playbackState.shuffleOrder.length - 1]
        : -1;
    }

    const prevIndex = playbackState.currentIndex - 1;
    if (prevIndex >= 0) return prevIndex;
    return playbackState.repeatMode === "playlist" ? playlist.items.length - 1 : -1;
  }

  // Plays the item at `index` within `playlistId`. This is the ONLY
  // place playlist playback touches the player, and it does so via the
  // existing loadVideo() — same code path as a pasted link or a search-
  // result click, so a stored videoId never triggers a fresh API call
  // (spec requirement: playlist membership must be independent of API
  // availability).
  function playPlaylistItem(playlistId, index) {
    const playlist = getPlaylist(playlistId);
    if (!playlist || !playlist.items.length) return false;
    const clamped = Math.max(0, Math.min(index, playlist.items.length - 1));
    const item = playlist.items[clamped];
    if (!item) return false;

    playbackState.activePlaylistId = playlistId;
    playbackState.currentIndex = clamped;
    if (playbackState.shuffleEnabled) {
      if (playbackState.shuffleOrder.length !== playlist.items.length) rebuildShuffleOrder(playlist);
      const pos = playbackState.shuffleOrder.indexOf(clamped);
      playbackState.shufflePosition = pos > -1 ? pos : 0;
    }
    persistPlaybackStateDebounced();

    // Playback Engine (Part 3) — this item is getting a real, fresh
    // attempt right now (manual click, Next/Previous, or the error-skip
    // logic itself), so it deserves another chance even if a previous
    // pass marked it unavailable. See PLAYLIST PART 3 NOTES.
    unavailableItemIds.delete(item.id);
    playlistFinished = false;
    playbackBlocked = false;
    armAutoplayWatchdog();

    loadVideo(item.videoId, {
      source: "playlist",
      meta: {
        title: item.title,
        channelTitle: item.channelTitle,
        thumbnailUrl: item.thumbnailUrl,
        duration: item.duration,
      },
    });
    // Playlist Part 2B2 (spec #2) — update just the active-item highlight
    // in an open playlist-detail view, if any, without rebuilding the
    // list. See notifyPlaylistUIOfPlaybackChange() in the PLAYLIST UI
    // block below (hoisted function declaration, safe to call from here).
    notifyPlaylistUIOfPlaybackChange();
    return true;
  }

  function startPlaylist(playlistId, { fromIndex = 0 } = {}) {
    const playlist = getPlaylist(playlistId);
    if (!playlist || !playlist.items.length) {
      // Spec #1 — friendly empty state rather than silently doing
      // nothing (the "▶ Play All" button is already disabled for this
      // case; this covers the programmatic/console entry point too).
      showStatus("This playlist doesn't have any videos yet — add one first.", 4000);
      return false;
    }
    // Playback Engine (Part 3) — a fresh ▶ Play is a fresh playback
    // pass: any videos marked unavailable during an earlier pass get a
    // clean slate. See PLAYLIST PART 3 NOTES.
    unavailableItemIds.clear();
    playlistFinished = false;
    return playPlaylistItem(playlistId, fromIndex);
  }

  function stopPlaylist() {
    playbackState.activePlaylistId = null;
    playbackState.currentIndex = -1;
    playbackState.shufflePosition = -1;
    persistPlaybackStateDebounced();
    playlistFinished = false;
    stopProgressTicker();
    clearAutoplayWatchdog();
    notifyPlaylistUIOfPlaybackChange();
  }

  /* ----------------------------------------------------------------------
     YOUTUBE PLAYLIST IMPORT (Bridge) — turns a REAL YouTube playlist
     picked on the 🌐 "Search on YouTube.com" tab (a `ytd-playlist-renderer`/
     `ytd-radio-renderer` card there — see content-youtube.js's playlist
     click/arrow-key interception) into one of THIS app's own local
     playlists, using the exact same playlistItems.list call/cache/cost
     accounting `getPlaylistVideos()` already uses everywhere else in this
     file (see loadFullChannelPlaylist() above).

     QUOTA DISCIPLINE, ON PURPOSE: this fetches exactly ONE page (up to
     50 items, 1 quota unit — the cheapest read the Data API offers,
     already cached by ytFetch()) no matter how large the real playlist
     is. A 60-video playlist and a 6,000-video playlist cost the same
     single request here; nothing past that first page is ever fetched
     unless the person explicitly clicks "Load more from YouTube" in the
     playlist-detail view (loadMoreFromYoutube(), below), which spends
     one more page/one more unit per click. Picking a big playlist off
     the search tab can therefore never surprise-drain a quota the way
     eagerly walking every page up front would.

     DEDUPE: re-picking a playlist already imported this way reuses the
     same local playlist (matched on `sourcePlaylistId`) instead of
     creating a duplicate and re-spending quota on a page it already has.
  ---------------------------------------------------------------------- */
  function playlistItemToSource(raw) {
    const videoId = raw?.snippet?.resourceId?.videoId;
    if (!videoId) return null;
    return {
      videoId,
      title: raw.snippet?.title,
      channelTitle: raw.snippet?.videoOwnerChannelTitle || raw.snippet?.channelTitle,
      thumbnailUrl: raw.snippet?.thumbnails?.medium?.url || raw.snippet?.thumbnails?.default?.url,
    };
  }

  async function importYoutubePlaylist(sourcePlaylistId, opts = {}) {
    if (!sourcePlaylistId) return null;
    const { title, autoplay = true } = opts;

    const existing = playlists.find((p) => p.sourcePlaylistId === sourcePlaylistId);
    if (existing) {
      openPlaylistDetail(existing.id);
      if (autoplay) startPlaylist(existing.id);
      return existing;
    }

    const playlist = createPlaylist((title && title.trim()) || "YouTube playlist");
    playlist.sourcePlaylistId = sourcePlaylistId;
    playlist.sourcePlaylistNextPageToken = null;

    openPlaylistDetail(playlist.id); // show it immediately — items stream in below, no need to wait
    showStatus("Loading playlist from YouTube…", 2500);

    try {
      const data = await YTApi.getPlaylistVideos(sourcePlaylistId, { maxResults: 50 });
      const items = Array.isArray(data.items) ? data.items : [];
      for (const raw of items) {
        const source = playlistItemToSource(raw);
        if (source) addItemToPlaylist(playlist.id, source);
      }
      playlist.sourcePlaylistNextPageToken = data.nextPageToken || null;
      persistPlaylistsDebounced();
      if (currentDetailPlaylistId === playlist.id) renderPlaylistDetail();
      if (autoplay && playlist.items.length) startPlaylist(playlist.id);
      if (!playlist.items.length) {
        showStatus("That playlist looks empty (or private) — nothing to import.", 4000);
      }
    } catch (err) {
      console.warn("[YouTubeWindow] importYoutubePlaylist failed:", err);
      showStatus("Couldn't load that playlist from YouTube — check your API key/quota and try again.", 5000);
    }
    return playlist;
  }

  // Fetches exactly one more page (see the QUOTA DISCIPLINE note above)
  // for a playlist that was imported via importYoutubePlaylist(). A no-op
  // if this playlist didn't come from YouTube, or the last fetch already
  // reached its real end (sourcePlaylistNextPageToken is null).
  async function loadMoreFromYoutube(playlistId) {
    const playlist = getPlaylist(playlistId);
    if (!playlist || !playlist.sourcePlaylistId || !playlist.sourcePlaylistNextPageToken) return false;
    showStatus("Loading more from YouTube…", 2500);
    try {
      const data = await YTApi.getPlaylistVideos(playlist.sourcePlaylistId, {
        maxResults: 50,
        pageToken: playlist.sourcePlaylistNextPageToken,
      });
      const items = Array.isArray(data.items) ? data.items : [];
      for (const raw of items) {
        const source = playlistItemToSource(raw);
        if (source) addItemToPlaylist(playlist.id, source);
      }
      playlist.sourcePlaylistNextPageToken = data.nextPageToken || null;
      persistPlaylistsDebounced();
      if (currentDetailPlaylistId === playlist.id) renderPlaylistDetail();
      return true;
    } catch (err) {
      console.warn("[YouTubeWindow] loadMoreFromYoutube failed:", err);
      showStatus("Couldn't load more from YouTube — check your connection/quota and try again.", 4000);
      return false;
    }
  }

  // Playlist Part 2B2 — "Play Next" (spec #5). `upNext` is drained before
  // falling back to the normal playlist queue, and a played-next item is
  // loaded directly via loadVideo() rather than playPlaylistItem() — it
  // may not even belong to `playbackState.activePlaylistId`'s own items,
  // so it must never overwrite `currentIndex`/`activePlaylistId`. This is
  // intentionally a one-off detour, not the "sophisticated
  // previous/next history" the spec reserves for Part 3.
  function queueUpNext(source) {
    if (!source || !source.videoId) return null;
    const entry = {
      videoId: source.videoId,
      title: source.title || "Untitled",
      channelTitle: source.channelTitle || "",
      thumbnailUrl: source.thumbnailUrl || source.thumb || "",
      duration: source.duration || null,
    };
    // Newest "Play next" plays soonest (stacks in front of any previous
    // one) — the common "play next" convention, and it never touches
    // `playlist.items` or `shuffleOrder`.
    playbackState.upNext.unshift(entry);
    persistPlaybackStateDebounced();
    return entry;
  }

  function playNextInQueue() {
    if (playbackState.upNext.length) {
      const next = playbackState.upNext.shift();
      persistPlaybackStateDebounced();
      loadVideo(next.videoId, {
        source: "playlist",
        meta: { title: next.title, channelTitle: next.channelTitle, thumbnailUrl: next.thumbnailUrl, duration: next.duration },
      });
      return true;
    }
    if (!playbackState.activePlaylistId) return false;
    const nextIndex = getNextQueueIndex();
    if (nextIndex === -1) return false;
    return playPlaylistItem(playbackState.activePlaylistId, nextIndex);
  }

  function playPreviousInQueue() {
    if (!playbackState.activePlaylistId) return false;
    const prevIndex = getPreviousQueueIndex();
    if (prevIndex === -1) return false;
    return playPlaylistItem(playbackState.activePlaylistId, prevIndex);
  }

  function setRepeatMode(mode) {
    if (mode !== "off" && mode !== "playlist" && mode !== "one") return false;
    playbackState.repeatMode = mode;
    persistPlaybackStateDebounced();
    return true;
  }

  function setShuffleEnabled(enabled) {
    playbackState.shuffleEnabled = !!enabled;
    const playlist = getActivePlaylist();
    if (playbackState.shuffleEnabled && playlist && playlist.items.length) {
      rebuildShuffleOrder(playlist, { preserveCurrent: true });
    } else if (!playbackState.shuffleEnabled) {
      playbackState.shuffleOrder = [];
      playbackState.shufflePosition = -1;
    }
    persistPlaybackStateDebounced();
    return true;
  }

  // Playlist Part 4A (spec #30) — explicit "Reshuffle": get a fresh
  // shuffle order for the CURRENT cycle on demand (Part 4B will expose
  // this as a button), without touching repeat mode, without touching
  // the saved playlist, and — same guarantee as every other order
  // regeneration in this file — without interrupting whatever's
  // currently playing. Reuses `rebuildShuffleOrder(preserveCurrent)`
  // rather than duplicating its anchor-relocation logic: that already
  // keeps the playing item in place and its adjacent-repeat smoothing
  // pass already covers "avoid immediate repetition where possible".
  // If shuffle wasn't already on, turning it on is what "reshuffle"
  // means here rather than silently no-op'ing.
  function reshuffleActivePlaylist() {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.items.length) return false;
    playbackState.shuffleEnabled = true;
    rebuildShuffleOrder(playlist, { preserveCurrent: true });
    persistPlaybackStateDebounced();
    notifyPlaylistUIOfPlaybackChange();
    return true;
  }

  // Playlist Part 4A (spec #18/#20) — "shuffle history" for Previous,
  // exposed as a read-only view for a future "recently played" UI
  // (Part 4B). Deliberately NOT a second, separately-maintained array:
  // `shuffleOrder` already IS this cycle's visiting order, and
  // `shufflePosition` already IS "how far into it we are", so the
  // history is just the slice before the current position — which can
  // never grow past the playlist's own length, satisfying the "don't
  // let this grow forever" requirement for free, with no second
  // bookkeeping structure to keep in sync. Returns playlist ITEM ids
  // (not videoIds — see the file-header note on why that distinction
  // matters), most-recently-played first.
  function getShuffleHistory() {
    const playlist = getActivePlaylist();
    if (!playlist || !playbackState.shuffleEnabled || playbackState.shufflePosition < 1) return [];
    return playbackState.shuffleOrder
      .slice(0, playbackState.shufflePosition)
      .reverse()
      .map((idx) => playlist.items[idx]?.id)
      .filter(Boolean);
  }

  /* ----------------------------------------------------------------------
     PLAYLIST FOLDER SYNC — connects "My Playlists" to
     window.YouTubePlaylistFolder (youtube-playlist-folder-service.js,
     same File System Access API approach the 🖼️ wallpaper folder feature
     already uses). The whole point: localStorage has a hard ~5-10MB quota
     that a big music library of playlists can actually hit, while a
     folder on disk doesn't. This block owns nothing about *what* a
     playlist is — it only decides *where* `playlists` gets read from at
     startup and written to on every change, via the existing
     persistPlaylistsDebounced() → savePlaylistsToStorage() path (see the
     "Folder Sync" note added there) plus a one-time reconciliation on
     connect.

     CONNECT/RECONNECT IS ASYNC, STARTUP IS NOT: `playlists` is already
     loaded from localStorage synchronously above so the window still
     opens instantly even with no folder involved at all. initFolderSync()
     runs after that, tries to silently reattach a previously-connected
     folder (same "ask permission again, but never re-browse" model as
     wallpapers), and — ONLY if that succeeds — treats the folder's own
     file as the source of truth from that point forward, same as
     reopening a saved document. A brand-new connection (the person just
     clicked 📁 Folder for the first time) instead treats whatever's
     already in `playlists` as the thing to seed the empty folder with,
     so connecting never silently discards a library someone already
     built up in this browser.
  ---------------------------------------------------------------------- */
  const YW_FOLDER_SYNC_ENABLED_STORAGE = "vocabRegister_youtubePlaylistFolderSyncOn"; // "true" once a folder's been connected at least once, so restore is only attempted when relevant

  function folderSyncAvailable() {
    return !!(window.YouTubePlaylistFolder && window.YouTubePlaylistFolder.supportsFileSystemAccess);
  }
  function folderSyncConnected() {
    return !!(window.YouTubePlaylistFolder && window.YouTubePlaylistFolder.isConnected());
  }

  // Rebinds the 📁 Folder button's label/title every time it exists in the
  // DOM — called after connect/disconnect/failed-write AND from inside
  // renderPlaylistLibrary() itself, since that function rebuilds the
  // button fresh on every render (same convention as the Export/Import
  // buttons right next to it).
  function renderFolderSyncStatus() {
    const btn = document.getElementById("yw-playlist-folder-btn");
    if (!btn) return;
    if (!folderSyncAvailable()) {
      btn.disabled = true;
      btn.title = "Needs a browser with folder access (Chrome or Edge) to sync playlists live to disk.";
      btn.textContent = "📁 Folder";
      return;
    }
    btn.disabled = false;
    if (folderSyncConnected()) {
      const label = window.YouTubePlaylistFolder.getFolderLabel() || "connected folder";
      btn.textContent = `📁 Synced: ${label}`;
      btn.title = `Playlists are being saved live to "${label}" instead of browser storage. Click to disconnect.`;
      btn.classList.add("yw-folder-connected");
    } else {
      btn.textContent = "📁 Folder";
      btn.title = "Connect a local folder to save playlists there instead of browser storage — avoids running out of storage with a large library.";
      btn.classList.remove("yw-folder-connected");
    }
  }

  async function connectPlaylistFolder() {
    if (!folderSyncAvailable()) return;
    try {
      const label = await window.YouTubePlaylistFolder.connect();
      if (!label) return; // person cancelled the picker
      saveJson(YW_FOLDER_SYNC_ENABLED_STORAGE, true);
      // Reconciliation: an empty/missing file in a freshly-chosen folder
      // means "nothing there yet" — seed it with whatever's already built
      // up in this browser rather than wiping the in-memory library.
      // A folder that already has a playlists file (reconnecting to one
      // used before, possibly from another device/session) wins instead —
      // that's the whole point of connecting to an EXISTING synced folder.
      const safeLabel = escapeHtml(label); // a folder name is untrusted, filesystem-provided text — showStatus() renders via innerHTML
      const existing = await window.YouTubePlaylistFolder.readPlaylists();
      if (existing && Array.isArray(existing.playlists) && existing.playlists.length) {
        playlists = sanitizeStoredPlaylistsArray(existing.playlists);
        showStatus(`📁 Connected to "${safeLabel}" — loaded ${playlists.length} playlist${playlists.length === 1 ? "" : "s"} already saved there.`, 5000);
      } else {
        await window.YouTubePlaylistFolder.writePlaylists(playlists);
        showStatus(`📁 Connected to "${safeLabel}" — playlists now save here live instead of browser storage.`, 5000);
      }
      playlistStorageWarningActive = false;
      renderFolderSyncStatus();
      if (currentBodyView === "playlists") renderPlaylistLibrary();
    } catch (err) {
      // AbortError = person closed the picker without choosing — not a
      // real failure, nothing to say about it.
      if (err && err.name === "AbortError") return;
      showStatus("⚠ Couldn't connect that folder — check your browser allowed folder access and try again.", 6000);
    }
  }

  async function disconnectPlaylistFolder() {
    if (!folderSyncConnected()) return;
    const safeLabel = escapeHtml(window.YouTubePlaylistFolder.getFolderLabel() || "the connected folder");
    await window.YouTubePlaylistFolder.disconnect();
    saveJson(YW_FOLDER_SYNC_ENABLED_STORAGE, false);
    // Back to browser storage — write what's currently in memory there
    // right away so switching back never leaves a gap.
    saveJson(YW_PLAYLISTS_STORAGE, playlists);
    showStatus(`📁 Disconnected from "${safeLabel}" — playlists now save to browser storage again.`, 5000);
    renderFolderSyncStatus();
  }

  async function initFolderSync() {
    if (!folderSyncAvailable()) return;
    if (!loadJson(YW_FOLDER_SYNC_ENABLED_STORAGE, false)) return; // never connected one before — nothing to silently restore
    const label = await window.YouTubePlaylistFolder.restoreConnection();
    if (!label) return; // permission wasn't re-granted, or the folder's gone — stays on localStorage, no error shown (matches wallpaper folder's own silent-fallback behavior)
    const existing = await window.YouTubePlaylistFolder.readPlaylists();
    if (existing && Array.isArray(existing.playlists)) {
      playlists = sanitizeStoredPlaylistsArray(existing.playlists);
      if (currentBodyView === "playlists") renderPlaylistLibrary();
    }
    renderFolderSyncStatus();
  }
  // Fire-and-forget at module init — see the block comment above for why
  // this doesn't block the synchronous localStorage-backed startup path.
  initFolderSync();

  /* ----------------------------------------------------------------------
     PLAYLIST UI (Playlist Part 2A — library, creation, rename/delete, and
     the playlist detail shell) — built entirely on top of the data model,
     persistence, and playback-queue functions in the PLAYLISTS block just
     above (getAllPlaylists/getPlaylist/createPlaylist/renamePlaylist/
     deletePlaylist, and the playback.* functions). Nothing here talks to
     localStorage directly, calls YTApi, or introduces a second playlist
     state system — it only renders `playlists`/`playbackState` and calls
     the existing CRUD/queue functions. See the file-header PLAYLIST
     FOUNDATION NOTES for the data layer's own design notes.

     TWO VIEWS, ONE PATTERN: "playlists" (the library, #yw-playlists) and
     "playlist-detail" (#yw-playlist-detail) are two more `setView()`
     states, following the exact same show-one-hide-the-rest approach as
     the pre-existing empty/results/video/channel-detail views — no new
     view-switching mechanism was introduced. `currentDetailPlaylistId`
     is this block's one piece of new UI-only state: which playlist the
     detail view is currently showing (null when the library is showing
     instead).

     NAVIGATION: the header's 🎵 button toggles the whole feature on/off
     the same way the Videos/Channels footer tabs already coexist with a
     playing video — switching to it never stops playback (loadVideo()'s
     video keeps playing in its now-hidden iframe exactly as it already
     does when "back to results" is used); switching away from it
     restores whatever was on screen before (playing video > the search
     tab's own results > empty), via leavePlaylistsView(). Inside the
     library, "← My Playlists" always returns to the library specifically
     (not a generic "back"), per spec.

     ITEM RENDERING IS READ/PLAY-ONLY IN 2A: renderPlaylistDetail() lists
     `playlist.items` (real data, already unlimited per Part 1 — no
     `.slice()`) and lets each row call the existing playPlaylistItem(),
     but there is no add/remove/reorder UI here — that is Part 2B's job,
     per the spec's explicit boundary. The scrollable
     #yw-playlist-detail-content container this renders into is the
     "large playlist architecture" hook Part 2B can swap for incremental/
     virtualized/windowed rendering without touching the header above it.

     ⋮ MENU: a small in-flow dropdown (not position:fixed, so it never
     needs the settings-panel's reparent-to-<body> trick) anchored to
     whichever button opened it — one shared implementation
     (togglePlaylistRowMenu) used by both a library row's ⋮ and the
     playlist-detail header's ⋮, since both offer the same two actions.

     MODALS REUSE THE APP'S OWN DIALOG SYSTEM: #yw-playlist-name-modal
     (create AND rename — same small form, different title/button label)
     and #yw-playlist-delete-modal (destructive-action confirm) are plain
     .modal/.modal-content/.modal-actions markup, the same classes
     #ai-settings-modal/#edit-modal/#topage-confirm-modal already use
     elsewhere in this app — no new dialog design, per spec.
  ---------------------------------------------------------------------- */

  let currentDetailPlaylistId = null; // which playlist #yw-playlist-detail is showing, or null (library showing)

  // ---- entry point: header 🎵 toggle -------------------------------
  playlistsBtn?.addEventListener("click", () => {
    if (currentBodyView === "playlists" || currentBodyView === "playlist-detail") {
      leavePlaylistsView();
    } else {
      openPlaylistLibrary();
    }
  });

  // Mirrors the fallback used elsewhere (e.g. the results "✕" clear
  // button) for "what should be on screen now that this view is done" —
  // a playing video wins, then whichever search tab is active and has
  // something to show, else the empty state. Never touches playback.
  function leavePlaylistsView() {
    currentDetailPlaylistId = null;
    if (currentVideoId) {
      setView("video");
      return;
    }
    if (activeSearchMode === "channels") {
      if (selectedChannel) {
        renderChannelDetail();
        return;
      }
      if (channelSearchState.items.length) {
        renderChannelResultsList();
        return;
      }
      setView("empty");
      return;
    }
    if (searchState.items.length) {
      renderResultsList();
      return;
    }
    setView("empty");
  }

  function openPlaylistLibrary() {
    currentDetailPlaylistId = null;
    closeAllPlaylistMenus();
    if (!isActive) open();
    else show();
    renderPlaylistLibrary();
  }

  function openPlaylistDetail(playlistId) {
    const playlist = getPlaylist(playlistId);
    if (!playlist) {
      openPlaylistLibrary();
      return;
    }
    currentDetailPlaylistId = playlistId;
    closeAllPlaylistMenus();
    if (!isActive) open();
    else show();
    renderPlaylistDetail();
  }

  // ---- library ("My Playlists") -------------------------------------
  function renderPlaylistLibrary() {
    if (!playlistsEl) return;
    const list = getAllPlaylists(); // live reference — no cap, no .slice()
    const activeId = playbackState.activePlaylistId;

    if (!list.length) {
      playlistsEl.innerHTML = `
        <div class="yw-playlists-head">
          <h3>My Playlists</h3>
          <div class="yw-playlists-head-actions">
            <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-folder-btn"></button>
            <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-import-btn" title="Import playlists from a JSON file">⇧ Import</button>
          </div>
        </div>
        <div class="yw-playlists-empty">
          <span class="yw-playlists-empty-icon" aria-hidden="true">🎵</span>
          <p>No playlists yet.<br>Create your first playlist to start building your music library.</p>
          <button type="button" class="btn btn-primary btn-small" id="yw-playlist-empty-new-btn">+ New Playlist</button>
        </div>
      `;
      setView("playlists");
      document.getElementById("yw-playlist-empty-new-btn")?.addEventListener("click", () => openPlaylistNameModal("create"));
      // Playlist Part 5 — Import works even with zero playlists (it's the
      // whole point of restoring a backup on a fresh browser/profile).
      document.getElementById("yw-playlist-import-btn")?.addEventListener("click", () => playlistImportFileInput?.click());
      document.getElementById("yw-playlist-folder-btn")?.addEventListener("click", () => (folderSyncConnected() ? disconnectPlaylistFolder() : connectPlaylistFolder()));
      renderFolderSyncStatus();
      return;
    }

    const rows = list
      .map((p) => {
        const isPlaying = p.id === activeId;
        const count = p.items.length;
        return `
          <div class="yw-playlist-row${isPlaying ? " yw-playlist-row-active" : ""}" data-playlist-id="${escapeHtml(p.id)}">
            <button type="button" class="yw-playlist-row-main" data-open-playlist="${escapeHtml(p.id)}">
              <span class="yw-playlist-row-icon" aria-hidden="true">${isPlaying ? "🔊" : "🎵"}</span>
              <span class="yw-playlist-row-name">${escapeHtml(p.name)}</span>
              <span class="yw-playlist-row-count">${count}</span>
            </button>
            <button type="button" class="yw-playlist-row-play-btn" data-play-playlist="${escapeHtml(p.id)}" title="Play" aria-label="Play ${escapeHtml(p.name)}"${count ? "" : " disabled"}>▶</button>
            <div class="yw-playlist-row-menu-wrap">
              <button type="button" class="yw-playlist-row-menu-btn" data-menu-playlist="${escapeHtml(p.id)}" title="More options" aria-label="More options for ${escapeHtml(p.name)}" aria-haspopup="true" aria-expanded="false">⋮</button>
            </div>
          </div>
        `;
      })
      .join("");

    playlistsEl.innerHTML = `
      <div class="yw-playlists-head">
        <h3>My Playlists</h3>
        <div class="yw-playlists-head-actions">
          <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-folder-btn"></button>
          <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-export-btn" title="Export all playlists as a JSON file">⇩ Export</button>
          <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-import-btn" title="Import playlists from a JSON file">⇧ Import</button>
          <button type="button" class="btn btn-secondary btn-small" id="yw-playlist-new-btn">+ New</button>
        </div>
      </div>
      <div class="yw-playlists-list">${rows}</div>
    `;
    setView("playlists");

    document.getElementById("yw-playlist-new-btn")?.addEventListener("click", () => openPlaylistNameModal("create"));
    // Playlist Part 5 — see the "PLAYLIST EXPORT / IMPORT" block for what
    // these actually do; rebinding on every render matches the existing
    // "+ New" convention right above (the whole library markup, buttons
    // included, is rebuilt from scratch each render).
    document.getElementById("yw-playlist-export-btn")?.addEventListener("click", downloadPlaylistExport);
    document.getElementById("yw-playlist-import-btn")?.addEventListener("click", () => playlistImportFileInput?.click());
    document.getElementById("yw-playlist-folder-btn")?.addEventListener("click", () => (folderSyncConnected() ? disconnectPlaylistFolder() : connectPlaylistFolder()));
    renderFolderSyncStatus();
    playlistsEl.querySelectorAll("[data-open-playlist]").forEach((btn) => {
      btn.addEventListener("click", () => openPlaylistDetail(btn.dataset.openPlaylist));
    });
    playlistsEl.querySelectorAll("[data-play-playlist]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        startPlaylist(btn.dataset.playPlaylist);
      });
    });
    playlistsEl.querySelectorAll("[data-menu-playlist]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePlaylistRowMenu(btn.dataset.menuPlaylist, btn);
      });
    });
  }

  // ---- playlist detail -----------------------------------------------
  function renderPlaylistDetail() {
    if (!playlistDetailEl) return;
    const playlist = getPlaylist(currentDetailPlaylistId);
    if (!playlist) {
      // Dangling reference (e.g. deleted from another tab/console) —
      // never leave the detail view pointing at nothing.
      openPlaylistLibrary();
      return;
    }
    // Part 6.1C fix — this function always rebuilds the header AND the
    // content container from scratch (see the innerHTML replace below),
    // which recreates the scroll container itself. Left alone, every
    // reorder/remove/reshuffle/shuffle-toggle/repeat-toggle call into
    // this function (there are several — see call sites) would snap a
    // scrolled-down large playlist back to the top. Capture the outgoing
    // scroll position here (only meaningful for the same playlist that's
    // already mounted) so it can be restored onto the freshly mounted
    // container below, without changing anything about what gets
    // rendered or how virtualization itself works.
    const priorScrollTop =
      virtualPlaylistState && virtualPlaylistState.playlistId === currentDetailPlaylistId
        ? virtualPlaylistState.container.scrollTop
        : 0;
    const count = playlist.items.length;
    const shuffleOn = playbackState.shuffleEnabled;
    const repeatMode = playbackState.repeatMode; // "off" | "playlist" | "one"

    // Playlist Part 2B2 (spec #10-#16) — the header/controls are still a
    // plain innerHTML rebuild (cheap: a handful of elements, unrelated to
    // playlist size), but the item LIST itself is never joined into one
    // giant string here. When there are items, the content container is
    // left empty and handed to mountVirtualPlaylist() below, which is the
    // only thing that ever creates item row DOM nodes — and only for the
    // visible window + a small overscan, regardless of whether `count` is
    // 10 or 50,000.
    const contentInnerHtml = count
      ? ""
      : `
        <div class="yw-playlists-empty">
          <span class="yw-playlists-empty-icon" aria-hidden="true">🎵</span>
          <p>No videos in this playlist yet.<br>Search for one and use “+ Add” to add it here.</p>
        </div>
      `;

    playlistDetailEl.innerHTML = `
      <button type="button" class="yw-channel-detail-back-btn" id="yw-playlist-detail-back-btn">◀ My Playlists</button>
      <div class="yw-playlist-detail-header">
        <div class="yw-playlist-detail-title-row">
          <h3 class="yw-playlist-detail-name" title="${escapeHtml(playlist.name)}">${escapeHtml(playlist.name)}</h3>
          <div class="yw-playlist-row-menu-wrap">
            <button type="button" class="yw-playlist-row-menu-btn" id="yw-playlist-detail-menu-btn" title="More options" aria-label="More options for ${escapeHtml(playlist.name)}" aria-haspopup="true" aria-expanded="false">⋮</button>
          </div>
        </div>
        <p class="yw-playlist-detail-count">${count} video${count === 1 ? "" : "s"}${playlist.sourcePlaylistId ? " · from YouTube" : ""}</p>
        <div class="yw-playlist-detail-controls">
          <button type="button" class="yw-playlist-play-all-btn" id="yw-playlist-play-all-btn"${count ? "" : " disabled"}>▶ Play All</button>
          <button type="button" class="yw-playlist-toggle-btn" id="yw-playlist-shuffle-btn" aria-pressed="${shuffleOn}" title="Shuffle: ${shuffleOn ? "on" : "off"} — click to turn ${shuffleOn ? "off" : "on"}">🔀 Shuffle</button>
          <button type="button" class="yw-playlist-toggle-btn" id="yw-playlist-repeat-btn" aria-pressed="${repeatMode !== "off"}" title="Repeat: ${repeatMode === "one" ? "one song" : repeatMode === "playlist" ? "whole playlist" : "off"} — click to change">${repeatMode === "one" ? "🔂 Repeat one" : repeatMode === "playlist" ? "🔁 Repeat all" : "🔁 Repeat"}</button>
          ${
            playlist.sourcePlaylistId && playlist.sourcePlaylistNextPageToken
              ? `<button type="button" class="yw-playlist-toggle-btn" id="yw-playlist-load-more-btn" title="Fetch the next batch of videos from this YouTube playlist (1 more quota unit)">⇩ Load more from YouTube</button>`
              : ""
          }
        </div>
      </div>
      <div class="yw-playlist-detail-content" id="yw-playlist-detail-content">${contentInnerHtml}</div>
    `;
    setView("playlist-detail");

    document.getElementById("yw-playlist-detail-back-btn")?.addEventListener("click", () => openPlaylistLibrary());
    document.getElementById("yw-playlist-detail-menu-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlaylistRowMenu(playlist.id, e.currentTarget);
    });
    document.getElementById("yw-playlist-play-all-btn")?.addEventListener("click", () => startPlaylist(playlist.id));
    document.getElementById("yw-playlist-load-more-btn")?.addEventListener("click", (e) => {
      e.currentTarget.disabled = true;
      loadMoreFromYoutube(playlist.id).finally(() => {
        // Button is rebuilt by renderPlaylistDetail() on success (new
        // count, possibly no more pages) — this only matters if the
        // fetch failed and the same button is still on screen.
        const btn = document.getElementById("yw-playlist-load-more-btn");
        if (btn) btn.disabled = false;
      });
    });
    // Shuffle/Repeat here call straight into Part 1's setShuffleEnabled/
    // setRepeatMode — no new playback logic, per spec.
    document.getElementById("yw-playlist-shuffle-btn")?.addEventListener("click", () => {
      setShuffleEnabled(!playbackState.shuffleEnabled);
      renderPlaylistDetail();
    });
    document.getElementById("yw-playlist-repeat-btn")?.addEventListener("click", () => {
      const order = ["off", "playlist", "one"];
      const next = order[(order.indexOf(playbackState.repeatMode) + 1) % order.length];
      setRepeatMode(next);
      renderPlaylistDetail();
    });

    const contentEl = document.getElementById("yw-playlist-detail-content");
    if (count) mountVirtualPlaylist(playlist, contentEl, { restoreScrollTop: priorScrollTop });
    else teardownVirtualPlaylist();
  }

  /* ----------------------------------------------------------------------
     LARGE PLAYLIST RENDERING (Playlist Part 2B2, spec #10-#16) —
     windowed/virtualized rendering for #yw-playlist-detail-content. Only
     the rows that could actually be visible (viewport height ÷ row
     height, plus a small overscan buffer) are ever created as real DOM
     nodes; a tall "sizer" div gives the container the correct total
     scrollHeight (`count * PL_ROW_HEIGHT`) so native scrolling/scrollbars
     work exactly as if every row existed, and each rendered row is
     positioned with `top: index * PL_ROW_HEIGHT` inside it — no
     transform/translate bookkeeping needed. A scroll handler
     (rAF-throttled, so at most one recompute per frame) recalculates the
     visible range and only touches the DOM when that range actually
     changed. PL_ROW_HEIGHT must match the fixed height set on
     `.yw-playlist-item` in youtube-window.css.

     Click handling is delegated once on `playlistDetailEl` itself (see
     just below) rather than rebound per row/per scroll — the whole point
     of windowing is to avoid repeated bind/unbind churn on every
     recompute, and delegation reads the target row's data-* attributes
     at click time instead.
  ---------------------------------------------------------------------- */
  const PL_ROW_HEIGHT = 42; // px — keep in sync with .yw-playlist-item's fixed height + inter-row gap
  const PL_OVERSCAN = 6; // extra rows rendered above/below the visible window

  // { playlistId, count, activeIndex, container, viewport, rafId,
  //   lastStart, lastEnd, scrollHandler } | null
  let virtualPlaylistState = null;

  function teardownVirtualPlaylist() {
    if (virtualPlaylistState) {
      closePlaylistItemMenu();
      if (virtualPlaylistState.container && virtualPlaylistState.scrollHandler) {
        virtualPlaylistState.container.removeEventListener("scroll", virtualPlaylistState.scrollHandler);
      }
      if (virtualPlaylistState.rafId) cancelAnimationFrame(virtualPlaylistState.rafId);
    }
    virtualPlaylistState = null;
  }

  function renderPlaylistItemRow(playlist, idx) {
    const item = playlist.items[idx];
    if (!item) return "";
    const isActivePlaylist = playbackState.activePlaylistId === playlist.id;
    const playing = isActivePlaylist && playbackState.currentIndex === idx;
    const thumb = item.thumbnailUrl
      ? `<img class="yw-playlist-item-thumb" src="${escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" draggable="false">`
      : `<span class="yw-playlist-item-thumb yw-playlist-item-thumb-placeholder" aria-hidden="true">🎵</span>`;
    return `
      <div class="yw-playlist-item${playing ? " yw-playlist-item-playing" : ""}" data-index="${idx}" style="top:${idx * PL_ROW_HEIGHT}px;">
        <button type="button" class="yw-playlist-item-play" data-play-item="${escapeHtml(item.id)}" data-play-index="${idx}"${playing ? ' aria-current="true"' : ""} aria-label="Play ${escapeHtml(item.title)}${playing ? " (now playing)" : ""}">
          <span class="yw-playlist-item-index" aria-hidden="true">${playing ? "🔊" : idx + 1}</span>
          ${thumb}
          <span class="yw-playlist-item-text">
            <span class="yw-playlist-item-title">${escapeHtml(item.title)}</span>
            ${item.channelTitle ? `<span class="yw-playlist-item-channel">${escapeHtml(item.channelTitle)}</span>` : ""}
          </span>
          ${item.duration ? `<span class="yw-playlist-item-duration">${escapeHtml(item.duration)}</span>` : ""}
        </button>
        <div class="yw-playlist-row-menu-wrap">
          <button type="button" class="yw-playlist-row-menu-btn yw-playlist-item-menu-btn" data-item-menu="${escapeHtml(item.id)}" data-item-index="${idx}" title="More options" aria-label="More options for ${escapeHtml(item.title)}" aria-haspopup="true" aria-expanded="false">⋮</button>
        </div>
      </div>
    `;
  }

  function computeVisibleRange(container, count) {
    if (!container || !count) return [0, 0];
    const scrollTop = container.scrollTop;
    const viewportH = container.clientHeight || 300;
    let start = Math.floor(scrollTop / PL_ROW_HEIGHT) - PL_OVERSCAN;
    let end = Math.ceil((scrollTop + viewportH) / PL_ROW_HEIGHT) + PL_OVERSCAN;
    // Clamp start to `count` too, not just 0 — a stale/overshoot scrollTop
    // (e.g. right after removing a large batch of items, before the
    // browser has reflowed the now-shorter sizer div) could otherwise
    // leave `start` past `count` while `end` gets clamped down to `count`,
    // producing an inverted [start, end) range that silently renders zero
    // rows instead of the correct trailing window.
    start = Math.max(0, Math.min(start, count));
    end = Math.min(count, Math.max(end, start));
    return [start, end];
  }

  function renderVirtualPlaylistWindow(force) {
    const st = virtualPlaylistState;
    if (!st) return;
    const [start, end] = computeVisibleRange(st.container, st.count);
    if (!force && start === st.lastStart && end === st.lastEnd) return; // spec #14 — nothing actually changed, skip the rebuild
    st.lastStart = start;
    st.lastEnd = end;
    const playlist = getPlaylist(st.playlistId);
    if (!playlist) return;
    let html = "";
    for (let i = start; i < end; i++) html += renderPlaylistItemRow(playlist, i);
    st.viewport.innerHTML = html;
    // Playlist Part 5 (spec #3-#5 — lazy, batched, cached metadata) — see
    // the block below. Fire-and-forget: never blocks the paint above, and
    // a playlist with nothing missing resolves to a no-op instantly.
    enrichVisiblePlaylistItems(playlist, start, end);
  }

  /* ----------------------------------------------------------------------
     PLAYLIST ITEM METADATA ENRICHMENT (Playlist Part 5, spec #3-#5) —
     every item added through the app already carries its own title/
     channelTitle/thumbnailUrl/duration at add time (see PLAYLIST
     FOUNDATION NOTES' "ZERO NEW API CALLS"), so this block exists purely
     for items that DIDN'T come with that: a raw pasted video ID/URL
     added straight to a playlist, or an imported item from someone
     else's export that only had a bare videoId. Those still play fine —
     loadVideo() only ever needs the id — they just show "Untitled" with
     a placeholder thumbnail until enriched.

     LAZY, NOT EAGER (spec #5): nothing here runs when a playlist is
     opened. It only runs from renderVirtualPlaylistWindow() above, so it
     only ever looks at the rows actually on screen (+ overscan) — a
     5,000-item playlist with 3 pasted-ID items scrolled into view
     triggers one small batched request, not a 5,000-item sweep.

     BATCHED (spec #4): every videoId needing enrichment across the
     current visible window is collected into ONE array and handed to
     YTApi.getVideoDetails(), which already chunks at 50 and already
     caches by (path, params) — never a per-item fetch, and never a
     second network request for an id this file already asked about
     recently. This block doesn't add a second cache on top of that; it
     relies entirely on the existing central one.

     NEVER SEARCH (spec #2, restated for this block specifically): this
     calls videos.list (getVideoDetails), never search.list — a known
     videoId is resolved by asking about that exact id, not by
     re-discovering it through a text query.

     AT-MOST-ONCE PER SESSION, NOT A RETRY LOOP: `ywEnrichAttempted` is a
     plain in-memory Set of item ids already asked about this session
     (session-only, deliberately not persisted — same reasoning as
     `unavailableItemIds` in the Playback Engine). Without it, scrolling
     a still-unenriched row in and out of view repeatedly (or a
     genuinely-private/deleted video that will never enrich) would
     re-fire a request on every scroll pass.
  ---------------------------------------------------------------------- */
  const ywEnrichAttempted = new Set(); // playlist-item ids already asked about this session

  function playlistItemNeedsEnrichment(item) {
    // "Untitled" is loadPlaylistsFromStorage()'s/sanitizeImportedPlaylistItem()'s
    // own fallback for "no title was ever known" — a real video legitimately
    // titled the single word "Untitled" is indistinguishable from this and
    // would keep re-attempting harmlessly (one extra batched id, not a loop,
    // since ywEnrichAttempted still caps it at once).
    return !item.thumbnailUrl || !item.duration || item.title === "Untitled";
  }

  async function enrichVisiblePlaylistItems(playlist, start, end) {
    if (!apiKey) return; // spec: playlists must keep working with no key/no quota — enrichment is a pure bonus, never required
    const targets = [];
    for (let i = start; i < end; i++) {
      const item = playlist.items[i];
      if (!item || ywEnrichAttempted.has(item.id) || !playlistItemNeedsEnrichment(item)) continue;
      ywEnrichAttempted.add(item.id); // mark before the request, not after — a slow request must not let a second scroll pass re-fire it
      targets.push(item);
    }
    if (!targets.length) return;
    const ids = [...new Set(targets.map((it) => it.videoId))]; // de-dupe videoIds — two different items can point at the same video
    let data;
    try {
      data = await YTApi.getVideoDetails(ids, { parts: "snippet,contentDetails" });
    } catch {
      return; // no key configured mid-flight, quota exhausted, offline, etc. — items simply keep showing what they already had
    }
    const byId = new Map((data.items || []).map((v) => [v.id, v]));
    let changed = false;
    // Patch every item in the WHOLE playlist that shares one of the
    // enriched videoIds, not just the ones in `targets` — a video that
    // appears 3 times in a playlist only needs asking about once.
    for (const item of playlist.items) {
      const v = byId.get(item.videoId);
      if (!v) continue;
      const title = v.snippet?.title;
      const channelTitle = v.snippet?.channelTitle;
      const thumbnailUrl = v.snippet?.thumbnails?.default?.url || v.snippet?.thumbnails?.medium?.url;
      const duration = formatIsoDuration(v.contentDetails?.duration);
      if (title && item.title === "Untitled") { item.title = title; changed = true; }
      if (channelTitle && !item.channelTitle) { item.channelTitle = channelTitle; changed = true; }
      if (thumbnailUrl && !item.thumbnailUrl) { item.thumbnailUrl = thumbnailUrl; changed = true; }
      if (duration && !item.duration) { item.duration = duration; changed = true; }
    }
    if (!changed) return;
    persistPlaylistsDebounced(); // same debounced writer everything else in this file uses — no dedicated write path for this
    // Repaint only if this exact window is still the one on screen (the
    // person may have scrolled away, or closed the detail view, during
    // the await above) — never a full renderPlaylistDetail(), same
    // "cheap regardless of playlist size" property notifyPlaylistUIOfPlaybackChange() relies on.
    if (virtualPlaylistState && virtualPlaylistState.playlistId === playlist.id) {
      renderVirtualPlaylistWindow(true);
    }
  }

  function scheduleVirtualPlaylistRender() {
    const st = virtualPlaylistState;
    if (!st || st.rafId) return; // spec #11 — coalesce a burst of scroll events into one recompute per frame
    st.rafId = requestAnimationFrame(() => {
      st.rafId = null;
      renderVirtualPlaylistWindow(false);
    });
  }

  function mountVirtualPlaylist(playlist, container, { restoreScrollTop = 0 } = {}) {
    teardownVirtualPlaylist();
    if (!container) return;
    const count = playlist.items.length;
    const isActivePlaylist = playbackState.activePlaylistId === playlist.id;
    container.innerHTML = `
      <div class="yw-playlist-virtual-sizer" id="yw-playlist-virtual-sizer" style="height:${count * PL_ROW_HEIGHT}px;">
        <div class="yw-playlist-virtual-viewport"></div>
      </div>
    `;
    const viewport = container.querySelector(".yw-playlist-virtual-viewport");
    virtualPlaylistState = {
      playlistId: playlist.id,
      count,
      activeIndex: isActivePlaylist ? playbackState.currentIndex : -1,
      container,
      viewport,
      rafId: null,
      lastStart: -1,
      lastEnd: -1,
      scrollHandler: null,
    };
    // Part 6.1C fix — re-apply the scroll position renderPlaylistDetail()
    // captured before rebuilding, if any. The browser clamps this to the
    // sizer's actual height on its own, so an oversized value (e.g. the
    // list just got shorter) is harmless. 0 (the default — no prior
    // state, or a different playlist) is a no-op, same as before this fix.
    if (restoreScrollTop > 0) container.scrollTop = restoreScrollTop;
    const onScroll = () => {
      closePlaylistItemMenu(); // an open ⋮ popover would otherwise float away from the row it belongs to
      scheduleVirtualPlaylistRender();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    virtualPlaylistState.scrollHandler = onScroll;
    renderVirtualPlaylistWindow(true);
  }

  // Playlist Part 2B2 (spec #2/#14) — called whenever playback's
  // active playlist/current index changes (playPlaylistItem/stopPlaylist
  // above). Touches only the specific row(s) whose active state actually
  // flipped — never re-renders the list — so switching tracks stays cheap
  // even inside a multi-thousand-item playlist.
  function notifyPlaylistUIOfPlaybackChange() {
    // Playback Engine (Part 3) — the video-view transport bar isn't tied
    // to whether a playlist-detail view happens to be open, so it's kept
    // outside that early return. See PLAYLIST PART 3 NOTES.
    updateTransportUI();
    if (currentBodyView !== "playlist-detail" || !currentDetailPlaylistId || !virtualPlaylistState) return;
    if (virtualPlaylistState.playlistId !== currentDetailPlaylistId) return;
    const isActivePlaylist = playbackState.activePlaylistId === currentDetailPlaylistId;
    const newIndex = isActivePlaylist ? playbackState.currentIndex : -1;
    const prevIndex = virtualPlaylistState.activeIndex;
    if (prevIndex === newIndex) return;
    virtualPlaylistState.activeIndex = newIndex;
    [prevIndex, newIndex].forEach((i) => {
      if (i == null || i < 0 || !virtualPlaylistState.viewport) return;
      const row = virtualPlaylistState.viewport.querySelector(`.yw-playlist-item[data-index="${i}"]`);
      if (!row) return; // not currently rendered (scrolled out of the window) — it'll pick up the right state next time it IS rendered, since renderPlaylistItemRow() always reads live playbackState
      const nowPlaying = i === newIndex;
      row.classList.toggle("yw-playlist-item-playing", nowPlaying);
      const playBtn = row.querySelector(".yw-playlist-item-play");
      if (playBtn) {
        if (nowPlaying) playBtn.setAttribute("aria-current", "true");
        else playBtn.removeAttribute("aria-current");
      }
      const indexEl = row.querySelector(".yw-playlist-item-index");
      if (indexEl) indexEl.textContent = nowPlaying ? "🔊" : String(i + 1);
    });
  }

  // ---- per-item ⋮ overflow menu (Play now / Play next / Move / Remove) ---
  let openPlaylistItemMenuId = null; // the item id whose menu is open, or null
  let openPlaylistItemMenuBtn = null;

  function closePlaylistItemMenu() {
    if (!openPlaylistItemMenuId) return;
    const btn = openPlaylistItemMenuBtn;
    const hadFocusInside = btn ? btn.closest(".yw-playlist-row-menu-wrap")?.contains(document.activeElement) : false;
    document.querySelectorAll(".yw-playlist-item-action-menu").forEach((m) => m.remove());
    document.querySelectorAll("[data-item-menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    openPlaylistItemMenuId = null;
    openPlaylistItemMenuBtn = null;
    if (hadFocusInside) btn?.focus(); // spec #20 — Escape/a selection shouldn't drop focus to <body>
  }

  function togglePlaylistItemMenu(playlistId, itemId, idx, btn) {
    const alreadyOpen = openPlaylistItemMenuId === itemId && btn.getAttribute("aria-expanded") === "true";
    closePlaylistItemMenu();
    closeAllPlaylistMenus();
    closeAddToPlaylistMenu();
    if (alreadyOpen) return;
    const playlist = getPlaylist(playlistId);
    if (!playlist) return;
    const wrap = btn.closest(".yw-playlist-row-menu-wrap");
    if (!wrap) return;
    const atTop = idx <= 0;
    const atBottom = idx >= playlist.items.length - 1;
    const menu = document.createElement("div");
    menu.className = "yw-playlist-row-menu yw-playlist-item-action-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="play-now">Play now</button>
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="play-next">Play next</button>
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="move-up"${atTop ? " disabled" : ""}>Move up</button>
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="move-down"${atBottom ? " disabled" : ""}>Move down</button>
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="move-top"${atTop ? " disabled" : ""}>Move to top</button>
      <button type="button" class="yw-playlist-row-menu-item" role="menuitem" data-item-action="move-bottom"${atBottom ? " disabled" : ""}>Move to bottom</button>
      <button type="button" class="yw-playlist-row-menu-item yw-playlist-row-menu-item-danger" role="menuitem" data-item-action="remove">Remove</button>
    `;
    wrap.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    openPlaylistItemMenuId = itemId;
    openPlaylistItemMenuBtn = btn;
    menu.querySelectorAll("[data-item-action]").forEach((actionBtn) => {
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handlePlaylistItemAction(actionBtn.dataset.itemAction, playlistId, itemId, idx);
      });
    });
    menu.querySelector(".yw-playlist-row-menu-item:not(:disabled)")?.focus();
  }

  // The one place all seven per-item actions (spec #3-#9) are carried
  // out — each calls straight into Part 1's existing
  // addItemToPlaylist/removeItemFromPlaylist/reorderPlaylistItem/
  // playPlaylistItem, so playlist-order vs. shuffle-order vs. the new
  // upNext queue stay exactly as separate as Part 1 designed them.
  function handlePlaylistItemAction(action, playlistId, itemId, idx) {
    closePlaylistItemMenu();
    const playlist = getPlaylist(playlistId);
    if (!playlist) {
      openPlaylistLibrary();
      return;
    }
    const item = playlist.items.find((it) => it.id === itemId) || null;
    switch (action) {
      case "play-now":
        // Playback change only — notifyPlaylistUIOfPlaybackChange() (via
        // playPlaylistItem) updates the highlight; no list rebuild needed.
        playPlaylistItem(playlistId, idx);
        return;
      case "play-next":
        if (item) {
          queueUpNext(item);
          showStatus(`Will play next: ${escapeHtml(item.title)}`, 2200);
        }
        return; // the temporary queue only — saved order is untouched, nothing on screen needs to change
      case "move-up":
        if (!atStart(idx) && reorderPlaylistItem(playlistId, itemId, idx - 1)) renderPlaylistDetail();
        return;
      case "move-down":
        if (idx < playlist.items.length - 1 && reorderPlaylistItem(playlistId, itemId, idx + 1)) renderPlaylistDetail();
        return;
      case "move-top":
        if (!atStart(idx) && reorderPlaylistItem(playlistId, itemId, 0)) renderPlaylistDetail();
        return;
      case "move-bottom":
        if (idx < playlist.items.length - 1 && reorderPlaylistItem(playlistId, itemId, playlist.items.length - 1)) renderPlaylistDetail();
        return;
      case "remove":
        if (removeItemFromPlaylist(playlistId, itemId)) {
          showStatus("Removed from playlist.", 2000);
          renderPlaylistDetail();
        }
        return;
      default:
        return;
    }
  }
  function atStart(idx) {
    return idx <= 0;
  }

  // Delegated once on the (stable) #yw-playlist-detail element rather
  // than rebound per row/per scroll — see the LARGE PLAYLIST RENDERING
  // notes above for why that matters at scale.
  playlistDetailEl?.addEventListener("click", (e) => {
    const playBtn = e.target.closest("[data-play-item]");
    if (playBtn) {
      const idx = Number(playBtn.dataset.playIndex);
      if (currentDetailPlaylistId != null && Number.isInteger(idx)) playPlaylistItem(currentDetailPlaylistId, idx);
      return;
    }
    const menuBtn = e.target.closest("[data-item-menu]");
    if (menuBtn) {
      e.stopPropagation();
      const idx = Number(menuBtn.dataset.itemIndex);
      if (currentDetailPlaylistId != null) togglePlaylistItemMenu(currentDetailPlaylistId, menuBtn.dataset.itemMenu, idx, menuBtn);
    }
  });

  // ---- ⋮ overflow menu (shared by a library row and the detail header) ---
  let openPlaylistMenuId = null;
  function closeAllPlaylistMenus() {
    document.querySelectorAll(".yw-playlist-row-menu").forEach((m) => m.remove());
    document.querySelectorAll("[data-menu-playlist], #yw-playlist-detail-menu-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    openPlaylistMenuId = null;
    closePlaylistItemMenu(); // mutually exclusive with the per-item ⋮ menu (Part 2B2)
  }
  function togglePlaylistRowMenu(playlistId, btn) {
    const alreadyOpenForThis = openPlaylistMenuId === playlistId && btn.getAttribute("aria-expanded") === "true";
    closeAllPlaylistMenus();
    if (alreadyOpenForThis) return;
    const wrap = btn.closest(".yw-playlist-row-menu-wrap");
    if (!wrap) return;
    const menu = document.createElement("div");
    menu.className = "yw-playlist-row-menu";
    // Playlist Part 4B (spec #11) — Reshuffle only ever acts on
    // reshuffleActivePlaylist()'s own target (the ACTIVE playlist, see
    // Part 4A), so it's only offered here when this row's playlist is
    // that active one; offering it for a playlist that isn't playing
    // would silently reshuffle a different playlist than the one the
    // menu was opened on.
    const showReshuffle = playbackState.activePlaylistId === playlistId;
    menu.innerHTML = `
      ${showReshuffle ? '<button type="button" class="yw-playlist-row-menu-item" data-action="reshuffle">🔀 Reshuffle</button>' : ""}
      <button type="button" class="yw-playlist-row-menu-item" data-action="rename">Rename</button>
      <button type="button" class="yw-playlist-row-menu-item yw-playlist-row-menu-item-danger" data-action="delete">Delete</button>
    `;
    wrap.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    openPlaylistMenuId = playlistId;
    menu.querySelector('[data-action="reshuffle"]')?.addEventListener("click", () => {
      closeAllPlaylistMenus();
      reshuffleActivePlaylist();
      if (currentBodyView === "playlist-detail") renderPlaylistDetail();
    });
    menu.querySelector('[data-action="rename"]')?.addEventListener("click", () => {
      closeAllPlaylistMenus();
      openPlaylistNameModal("rename", playlistId);
    });
    menu.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
      closeAllPlaylistMenus();
      openPlaylistDeleteModal(playlistId);
    });
  }
  document.addEventListener("click", (e) => {
    if (openPlaylistMenuId && !e.target.closest(".yw-playlist-row-menu-wrap")) closeAllPlaylistMenus();
    if (openPlaylistItemMenuId && !e.target.closest(".yw-playlist-row-menu-wrap")) closePlaylistItemMenu();
  });

  /* ----------------------------------------------------------------------
     ADD TO PLAYLIST (Playlist Part 2B1) — the "+ Add" picker used by both
     a search-result card's own "+ Add" pill and the current-video header
     button. Reuses Part 1's addItemToPlaylist() and Part 2A's
     getAllPlaylists()/createPlaylist()/openPlaylistNameModal() exactly as
     they already exist — no second playlist store, no second creation
     flow, no new YouTube API call anywhere in this block (every `source`
     handed in here already came from an already-fetched search row or
     the currently-loaded video's own known metadata; see
     playlistSourceFromResultRow() and currentVideoMeta above).

     POPOVER SHAPE mirrors the existing ⋮ playlist-row menu exactly: an
     in-flow, position:relative wrap + position:absolute dropdown (never
     position:fixed), so it never needs to escape the window's own
     overflow:hidden the way the settings panel does.

     DUPLICATES ARE INTENTIONAL (spec #11/#12) — handleAddToPlaylistSelect()
     never checks whether the video is already in the target playlist, and
     nothing here disables the "+ Add" control after a successful add;
     every click is a genuine, independent addition, each getting its own
     playlist-item id from addItemToPlaylist() (Part 1's genId("item")).

     KEEPING THE USER WHERE THEY WERE (spec #5/#6) — a successful add only
     ever shows a status-line confirmation (showAddedConfirmation(), the
     app's existing #yw-status line) and flashes the button that was
     clicked; it never calls setView()/openPlaylistDetail()/re-searches/
     re-renders the results list. The one exception, matching spec #15,
     is if a playlist view already happens to be on screen when the add
     happens — its counts are kept live rather than going stale — but
     that view is never *opened* as a side effect of adding.
  ---------------------------------------------------------------------- */

  // Reshapes an already-rendered search-result row (see shapeResultRow())
  // into the {videoId, title, channelTitle, thumbnailUrl, duration} shape
  // addItemToPlaylist()/playlist items use — a field-name mapping only
  // (row.id → videoId, row.thumb → thumbnailUrl), never a re-fetch.
  function playlistSourceFromResultRow(row) {
    return {
      videoId: row.id,
      title: row.title,
      channelTitle: row.channelTitle,
      thumbnailUrl: row.thumb,
      duration: row.duration,
    };
  }

  let addToPlaylistMenuState = null; // { wrap, anchorBtn, source } | null

  function closeAddToPlaylistMenu() {
    if (!addToPlaylistMenuState) return;
    const { wrap, anchorBtn } = addToPlaylistMenuState;
    const hadFocusInside = wrap?.contains(document.activeElement);
    wrap?.querySelector(".yw-add-playlist-menu")?.remove();
    anchorBtn?.setAttribute("aria-expanded", "false");
    addToPlaylistMenuState = null;
    // Keyboard usability (spec #22) — if focus was inside the popover
    // when it closed (Escape, a selection), it would otherwise fall back
    // to <body> since the focused element was just removed from the DOM.
    if (hadFocusInside) anchorBtn?.focus();
  }

  function renderAddToPlaylistMenuMarkup() {
    const list = getAllPlaylists(); // live reference — reflects any playlist created moments ago
    const rows = list.length
      ? list.map((p) => `<button type="button" class="yw-add-playlist-menu-item" role="menuitem" data-playlist-id="${escapeHtml(p.id)}">🎵 ${escapeHtml(p.name)}</button>`).join("")
      : `<p class="yw-add-playlist-menu-empty">No playlists yet.</p>`;
    return `
      <div class="yw-add-playlist-menu" role="menu" aria-label="Add to Playlist">
        <div class="yw-add-playlist-menu-head">Add to Playlist</div>
        ${rows}
        <div class="yw-add-playlist-menu-sep"></div>
        <button type="button" class="yw-add-playlist-menu-item yw-add-playlist-menu-item-new" role="menuitem" data-action="new-playlist">+ New Playlist</button>
      </div>
    `;
  }

  // `anchorBtn` is either a search-result card's "+ Add" pill (wrapped in
  // .yw-result-add-wrap) or the header's "+ Add to Playlist" button
  // (wrapped in .yw-header-add-wrap) — both are position:relative wraps
  // this appends the dropdown into. `source` is whatever
  // addItemToPlaylist() itself expects: {videoId, title, channelTitle,
  // thumbnailUrl, duration}.
  function openAddToPlaylistMenu(anchorBtn, source) {
    if (!anchorBtn || !source || !source.videoId) return;
    const reopeningSameOne = addToPlaylistMenuState?.anchorBtn === anchorBtn;
    closeAddToPlaylistMenu();
    closeAllPlaylistMenus(); // the ⋮ menu and this one are mutually exclusive on screen
    if (reopeningSameOne) return; // clicking the same "+ Add" again just closes it

    const wrap = anchorBtn.closest(".yw-result-add-wrap") || anchorBtn.closest(".yw-header-add-wrap");
    if (!wrap) return;

    wrap.insertAdjacentHTML("beforeend", renderAddToPlaylistMenuMarkup());
    const menu = wrap.querySelector(".yw-add-playlist-menu");
    if (!menu) return;
    anchorBtn.setAttribute("aria-expanded", "true");
    addToPlaylistMenuState = { wrap, anchorBtn, source };

    menu.querySelectorAll("[data-playlist-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAddToPlaylistSelect(btn.dataset.playlistId, source, anchorBtn);
      });
    });
    menu.querySelector('[data-action="new-playlist"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAddToPlaylistMenu();
      // Reuses Part 2A's createPlaylist()/openPlaylistNameModal() as-is —
      // see the modal's commitPlaylistNameModal() below for the
      // create-then-add branch this `addSource` triggers.
      openPlaylistNameModal("create", null, { addSource: source });
    });
    // First item focused for immediate keyboard use (spec #22) — Tab/
    // Shift+Tab and Enter/Space on any item already work for free since
    // these are plain, normally-flowed <button> elements.
    menu.querySelector(".yw-add-playlist-menu-item")?.focus();
  }

  document.addEventListener("click", (e) => {
    if (!addToPlaylistMenuState) return;
    if (e.target.closest(".yw-add-playlist-menu")) return;
    if (e.target.closest("[data-add-video-id]") || e.target.closest("#yw-add-current-btn")) return;
    closeAddToPlaylistMenu();
  });

  // Brief visual flash on the button that was actually clicked — spec
  // #23's "only update the card that was interacted with if visual
  // feedback is necessary". Never disables the button (spec #12 — an
  // "Added" look must still allow another intentional Add).
  function flashAddButton(btn) {
    if (!btn || !btn.classList.contains("yw-add-btn")) return;
    btn.classList.add("yw-add-btn-flash");
    setTimeout(() => btn.classList.remove("yw-add-btn-flash"), 450);
  }

  function showAddedConfirmation(playlistName) {
    showStatus(`✓ Added to ${escapeHtml(playlistName)}`, 2500);
  }

  // The one place an actual addItemToPlaylist() call happens for this
  // whole feature — entirely local (see PLAYLIST FOUNDATION NOTES: Part
  // 1's addItemToPlaylist() is YTApi-free), persists via the existing
  // debounced writer, and never navigates away (spec #5/#6).
  function handleAddToPlaylistSelect(playlistId, source, anchorBtn) {
    closeAddToPlaylistMenu();
    const playlist = getPlaylist(playlistId);
    if (!playlist) {
      // Spec #20 — the playlist vanished between opening the picker and
      // choosing it (e.g. deleted from another tab). Handle gracefully,
      // refresh whatever playlist UI might be open, never throw.
      showStatus("That playlist no longer exists.", 3000);
      if (currentBodyView === "playlists") renderPlaylistLibrary();
      else if (currentBodyView === "playlist-detail") renderPlaylistDetail();
      return;
    }
    const item = addItemToPlaylist(playlistId, source);
    if (!item) {
      // Spec #20 — never claim "Added" if it didn't actually happen.
      showStatus("Couldn't add that video — please try again.", 3500);
      return;
    }
    showAddedConfirmation(playlist.name);
    flashAddButton(anchorBtn);
    // Spec #15/#16 — keep an already-open library/detail view's counts
    // live without navigating there or rebuilding anything else; if
    // neither is currently on screen there's nothing to repaint here —
    // both already read the live `playlists` array fresh the next time
    // they're opened regardless.
    if (currentBodyView === "playlist-detail" && currentDetailPlaylistId === playlistId) renderPlaylistDetail();
    else if (currentBodyView === "playlists") renderPlaylistLibrary();
  }

  // ---- create / rename modal (one shared form, two modes) -----------
  let playlistNameModalMode = null; // "create" | "rename"
  let playlistNameModalTargetId = null;
  // Playlist Part 2B1 — when the modal is opened from the "+ New
  // Playlist" item inside an Add-to-Playlist picker (rather than the
  // library's own "+ New" button), this holds the video that should be
  // added to the playlist the instant it's created (spec #7), and
  // suppresses the normal "open the new playlist" navigation (spec #5/#6
  // — adding must never navigate away from search results/current video).
  let playlistNameModalAddSource = null;

  function openPlaylistNameModal(mode, playlistId, opts = {}) {
    playlistNameModalMode = mode;
    playlistNameModalTargetId = playlistId || null;
    playlistNameModalAddSource = (mode === "create" && opts.addSource) || null;
    if (playlistNameTitleEl) playlistNameTitleEl.textContent = mode === "rename" ? "Rename Playlist" : "New Playlist";
    if (playlistNameSaveBtn) playlistNameSaveBtn.textContent = mode === "rename" ? "Rename" : "Create";
    if (playlistNameErrorEl) {
      playlistNameErrorEl.textContent = "";
      playlistNameErrorEl.classList.add("hidden");
    }
    if (playlistNameInput) {
      playlistNameInput.value = mode === "rename" ? getPlaylist(playlistId)?.name || "" : "";
    }
    playlistNameModal?.classList.remove("hidden");
    playlistNameInput?.focus();
    playlistNameInput?.select();
  }

  function closePlaylistNameModal() {
    playlistNameModal?.classList.add("hidden");
    playlistNameModalMode = null;
    playlistNameModalTargetId = null;
    playlistNameModalAddSource = null;
  }

  function commitPlaylistNameModal() {
    if (!playlistNameModalMode) return;
    const trimmed = (playlistNameInput?.value || "").trim();
    if (!trimmed) {
      if (playlistNameErrorEl) {
        playlistNameErrorEl.textContent = "Enter a playlist name.";
        playlistNameErrorEl.classList.remove("hidden");
      }
      playlistNameInput?.focus();
      return;
    }
    if (playlistNameModalMode === "rename" && playlistNameModalTargetId) {
      const targetId = playlistNameModalTargetId;
      renamePlaylist(targetId, trimmed); // preserves id, updates updatedAt, persists — see PLAYLISTS block
      closePlaylistNameModal();
      if (currentDetailPlaylistId === targetId) renderPlaylistDetail();
      else if (currentBodyView === "playlists") renderPlaylistLibrary();
    } else {
      const playlist = createPlaylist(trimmed); // unique id, createdAt/updatedAt, empty items, persisted — same Part 2A call either way
      // Playlist Part 2B1 — "+ New Playlist" inside the Add-to-Playlist
      // picker (spec #7): the new playlist gets the pending video
      // immediately, and — unlike the library's own "+ New" button —
      // this must NOT navigate to the new playlist's detail view; the
      // person stays on search results / the current video (spec #5/#6).
      const addSource = playlistNameModalAddSource;
      closePlaylistNameModal();
      if (addSource) {
        const item = addItemToPlaylist(playlist.id, addSource);
        if (item) {
          showAddedConfirmation(playlist.name);
          if (currentBodyView === "playlists") renderPlaylistLibrary();
        } else {
          showStatus("Couldn't add that video — please try again.", 3500);
        }
      } else {
        openPlaylistDetail(playlist.id); // library's own "+ New" — spec: newly created playlist opens automatically
      }
    }
  }

  playlistNameSaveBtn?.addEventListener("click", commitPlaylistNameModal);
  playlistNameCancelBtn?.addEventListener("click", closePlaylistNameModal);
  playlistNameModal?.addEventListener("click", (e) => {
    if (e.target === playlistNameModal) closePlaylistNameModal(); // backdrop click
  });
  playlistNameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPlaylistNameModal();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePlaylistNameModal();
    }
  });

  // ---- delete confirm modal ------------------------------------------
  let playlistDeleteTargetId = null;

  function openPlaylistDeleteModal(playlistId) {
    const playlist = getPlaylist(playlistId);
    if (!playlist) return;
    playlistDeleteTargetId = playlistId;
    if (playlistDeleteTextEl) {
      const count = playlist.items.length;
      playlistDeleteTextEl.textContent = `“${playlist.name}” contains ${count} video${count === 1 ? "" : "s"}. This removes the playlist from this app.`;
    }
    playlistDeleteModal?.classList.remove("hidden");
    playlistDeleteConfirmBtn?.focus();
  }

  function closePlaylistDeleteModal() {
    playlistDeleteModal?.classList.add("hidden");
    playlistDeleteTargetId = null;
  }

  function commitPlaylistDelete() {
    const id = playlistDeleteTargetId;
    if (!id) {
      closePlaylistDeleteModal();
      return;
    }
    // deletePlaylist() (PLAYLISTS block above) already calls stopPlaylist()
    // if this was the active playlist, clearing playbackState safely —
    // nothing playback-related to do here beyond the view itself.
    deletePlaylist(id);
    closePlaylistDeleteModal();
    if (currentDetailPlaylistId === id) {
      openPlaylistLibrary(); // was open in detail — never leave it pointing at a deleted playlist
    } else if (currentBodyView === "playlists") {
      renderPlaylistLibrary();
    }
  }

  playlistDeleteConfirmBtn?.addEventListener("click", commitPlaylistDelete);
  playlistDeleteCancelBtn?.addEventListener("click", closePlaylistDeleteModal);
  playlistDeleteModal?.addEventListener("click", (e) => {
    if (e.target === playlistDeleteModal) closePlaylistDeleteModal(); // backdrop click
  });

  /* ----------------------------------------------------------------------
     PLAYLIST EXPORT / IMPORT (Playlist Part 5, spec #10-#12) — a local
     JSON backup, entirely separate from the Drive sync feature elsewhere
     in this app (that syncs vocabulary entries, never playlists). See
     "PLAYLIST PART 5 NOTES" in the file-header comment for the full
     design writeup; short version: export writes exactly the fields
     needed to reconstruct playlists (never the API key), import is
     read-only until the person explicitly confirms merge/replace in
     #yw-playlist-import-modal, and every field from the parsed file is
     copied individually onto a fresh object literal — nothing is ever
     spread/Object.assign'd from untrusted JSON onto a real object, so a
     crafted "__proto__" key in the file can't reach anything.
  ---------------------------------------------------------------------- */
  const YW_PLAYLIST_EXPORT_VERSION = 1;

  function buildPlaylistExportPayload() {
    // Deliberately NOT `JSON.stringify(playlists)` directly — an explicit
    // field list means a future internal-only field added to the item/
    // playlist shape doesn't leak into exports (or, worse, into someone
    // else's import) without a conscious decision to include it here.
    return {
      app: "vocabRegister-youtube-playlists",
      version: YW_PLAYLIST_EXPORT_VERSION,
      exportedAt: Date.now(),
      playlists: playlists.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        items: p.items.map((it) => ({
          id: it.id,
          videoId: it.videoId,
          title: it.title,
          channelTitle: it.channelTitle,
          thumbnailUrl: it.thumbnailUrl,
          duration: it.duration,
          addedAt: it.addedAt,
        })),
      })),
    };
  }

  function downloadPlaylistExport() {
    if (!playlists.length) {
      showStatus("No playlists to export yet.", 3000);
      return;
    }
    const payload = buildPlaylistExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `youtube-playlists-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url); // Playlist Part 5 (spec #17) — don't leak the object URL past the download
  }

  // An 11-char YouTube video ID's real alphabet is narrower than this,
  // but this is deliberately just a shape check (not a full validator) —
  // enough to reject obvious garbage/injected strings before they're
  // stored or ever handed to loadVideo() to build an /embed/ URL from.
  function isPlausibleVideoId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{10,12}$/.test(id);
  }

  // Cleans one raw parsed playlist record into this file's own internal
  // shape, or returns null if it's unusable — mirrors
  // loadPlaylistsFromStorage()'s own defensive cleaning (Playlist Part 1)
  // so imported data is held to exactly the same standard as anything
  // already saved locally. Item ids are ALWAYS regenerated (spec #12):
  // an id that happens to collide with something already in this
  // browser's storage must never cause two distinct items to silently
  // merge into one.
  function sanitizeImportedPlaylistItem(raw) {
    if (!raw || typeof raw !== "object" || !isPlausibleVideoId(raw.videoId)) return null;
    return {
      id: genId("item"),
      videoId: raw.videoId,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled",
      channelTitle: typeof raw.channelTitle === "string" ? raw.channelTitle : "",
      thumbnailUrl: typeof raw.thumbnailUrl === "string" ? raw.thumbnailUrl : "",
      duration: typeof raw.duration === "string" ? raw.duration : null,
      addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
    };
  }

  function sanitizeImportedPlaylist(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    const items = rawItems.map(sanitizeImportedPlaylistItem).filter(Boolean);
    if (!items.length) return null; // spec #11 — a malformed/empty record is skipped, not imported as an empty shell
    return {
      id: genId("pl"), // final uniqueness against THIS browser's existing playlists is still re-checked at commit time, below
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Imported playlist",
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: Date.now(),
      items,
    };
  }

  // Read-only parse+validate step — never mutates `playlists`. Accepts
  // either this app's own `{ playlists: [...] }` export shape or a bare
  // array, so a hand-edited or differently-sourced JSON file with the
  // same item shape still imports.
  function parsePlaylistImportFile(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: "That file isn't valid JSON." };
    }
    const rawList = Array.isArray(json) ? json : Array.isArray(json?.playlists) ? json.playlists : null;
    if (!rawList) return { error: "That file doesn't look like a playlist export." };
    const cleaned = rawList.map(sanitizeImportedPlaylist).filter(Boolean);
    if (!cleaned.length) return { error: "No usable playlists were found in that file." };
    return { playlists: cleaned };
  }

  let pendingImportPlaylists = null;

  function openPlaylistImportModal(cleanedPlaylists) {
    pendingImportPlaylists = cleanedPlaylists;
    const totalItems = cleanedPlaylists.reduce((sum, p) => sum + p.items.length, 0);
    if (playlistImportSummaryEl) {
      playlistImportSummaryEl.textContent = `Found ${cleanedPlaylists.length} playlist${cleanedPlaylists.length === 1 ? "" : "s"} (${totalItems} video${totalItems === 1 ? "" : "s"} total).`;
    }
    if (playlistImportErrorEl) {
      playlistImportErrorEl.textContent = "";
      playlistImportErrorEl.classList.add("hidden");
    }
    const mergeRadio = playlistImportModal?.querySelector('input[value="merge"]');
    if (mergeRadio) mergeRadio.checked = true;
    playlistImportModal?.classList.remove("hidden");
  }

  function closePlaylistImportModal() {
    playlistImportModal?.classList.add("hidden");
    pendingImportPlaylists = null;
  }

  // Playlist Part 5 (spec #16) — large imports are pushed onto `playlists`
  // in chunks with a yield (setTimeout 0) between them, rather than one
  // long synchronous loop, so dropping a many-thousand-item export in
  // doesn't freeze the tab for the length of the whole import. Each
  // chunk still goes through the same id-collision check a single add
  // would.
  async function commitPlaylistImport() {
    const cleaned = pendingImportPlaylists;
    if (!cleaned || !cleaned.length) {
      closePlaylistImportModal();
      return;
    }
    const mode = playlistImportModal?.querySelector('input[name="yw-playlist-import-mode"]:checked')?.value || "merge";
    closePlaylistImportModal();
    if (mode === "replace") {
      playlists = [];
      stopPlaylist(); // clears playbackState so nothing points at a playlist that's about to be gone
    }
    const existingIds = new Set(playlists.map((p) => p.id));
    const CHUNK = 25; // playlists per chunk, not items — a playlist's own item count is unbounded either way
    for (let i = 0; i < cleaned.length; i += CHUNK) {
      const chunk = cleaned.slice(i, i + CHUNK);
      for (const p of chunk) {
        // spec #12 — never merge distinct playlists just because an id
        // collided; items were already given fresh ids in
        // sanitizeImportedPlaylistItem() above.
        if (existingIds.has(p.id)) p.id = genId("pl");
        existingIds.add(p.id);
        playlists.push(p);
      }
      if (i + CHUNK < cleaned.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    persistPlaylistsDebounced();
    showStatus(`Imported ${cleaned.length} playlist${cleaned.length === 1 ? "" : "s"}.`, 3500);
    if (currentBodyView === "playlists") renderPlaylistLibrary();
  }

  function handlePlaylistImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = parsePlaylistImportFile(String(reader.result || ""));
      if (result.error) {
        showStatus(result.error, 4000);
        return;
      }
      openPlaylistImportModal(result.playlists);
    };
    reader.onerror = () => showStatus("Couldn't read that file.", 3500);
    reader.readAsText(file);
  }

  playlistImportFileInput?.addEventListener("change", () => {
    const file = playlistImportFileInput.files?.[0];
    handlePlaylistImportFile(file);
    playlistImportFileInput.value = ""; // spec: allow re-selecting the exact same file again later
  });
  playlistImportConfirmBtn?.addEventListener("click", commitPlaylistImport);
  playlistImportCancelBtn?.addEventListener("click", closePlaylistImportModal);
  playlistImportModal?.addEventListener("click", (e) => {
    if (e.target === playlistImportModal) closePlaylistImportModal(); // backdrop click — same convention as every other modal here
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (playlistDeleteModal && !playlistDeleteModal.classList.contains("hidden")) closePlaylistDeleteModal();
      // Playlist Part 5 — same Escape-closes convention as every other
      // modal/popover in this file.
      if (playlistImportModal && !playlistImportModal.classList.contains("hidden")) closePlaylistImportModal();
      // Playlist Part 2B1 — same Escape-closes convention as every other
      // popover/modal in this file (spec #21).
      if (addToPlaylistMenuState) closeAddToPlaylistMenu();
      // Playlist Part 2B2 — the per-item ⋮ menu follows the same convention.
      if (openPlaylistItemMenuId) closePlaylistItemMenu();
      return;
    }
    handleTransportShortcut(e);
  });

  // Playlist Part 4B (spec #14-#17) — music-player keyboard shortcuts,
  // folded into this file's own single document-level keydown listener
  // (the Escape handling right above) rather than a second competing
  // listener. This is deliberately separate from script.js's
  // CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM: that system is a per-field,
  // click-to-record rebinding architecture built for the host app's own
  // controls, and its defaults are intentionally never bare letters "so
  // plain word/book typing is never affected" — bare N/P/S/R would be
  // exactly the kind of binding that system avoids by design. Instead
  // isTypingTarget() below reimplements that same guarantee the plain
  // way: any input/textarea/contenteditable/select always wins, letters
  // never fire while one is focused (spec #15/#16), matching how every
  // other shortcut in the host app already behaves around text fields.
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function handleTransportShortcut(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // leave modified combos alone
    if (!isActive) return; // window isn't open — never steal keys from the rest of the app
    if (isTypingTarget(e.target)) return; // spec #15 — never hijack typing, "playlist" must type P/S/R untouched
    // Space additionally backs off for any focused button/control that
    // already uses Space itself (spec #16) — e.g. the volume slider's
    // native thumb, or any other focusable control mid-interaction.
    const onControl = !!(e.target && e.target.closest && e.target.closest('button, [role="button"], [role="slider"], a[href]'));
    switch (e.code) {
      case "Space":
        if (onControl || !player) return;
        e.preventDefault();
        handlePlayPauseClick();
        break;
      case "KeyN":
        if (onControl || !playbackState.activePlaylistId) return;
        e.preventDefault();
        handleNextClick();
        break;
      case "KeyP":
        if (onControl || !playbackState.activePlaylistId) return;
        e.preventDefault();
        handlePreviousClick();
        break;
      case "KeyS":
        if (onControl || !playbackState.activePlaylistId) return;
        e.preventDefault();
        handleShuffleClick();
        break;
      case "KeyR":
        if (onControl || !playbackState.activePlaylistId) return;
        e.preventDefault();
        handleRepeatClick();
        break;
      default:
        break;
    }
  }

  /* ----------------------------------------------------------------------
     PLAYBACK ENGINE (Playlist Part 3 — full playback engine & continuous
     music playback). See "PLAYLIST PART 3 NOTES" in the file-header
     comment for the full design writeup. Short version: this block adds
     the video-view transport bar (Now Playing + Previous/Play-Pause/
     Next/Repeat + a progress bar), a bounded unavailable-video skip on
     player errors, a lightweight autoplay-restriction watchdog, and the
     "playlist finished" state — all built on top of the queue math and
     hooks Parts 1/2 already established (getActivePlaylist/
     getCurrentQueueItem/getNextQueueIndex/buildPlaybackQueue/
     playPlaylistItem/playNextInQueue/playPreviousInQueue/setRepeatMode/
     notifyPlaylistUIOfPlaybackChange). Nothing here calls YTApi.* or
     touches localStorage — this is all reused-player-instance state.
  ---------------------------------------------------------------------- */

  // Set of playlist ITEM ids (not videoIds — two items can share a
  // videoId) that failed to play during the current playback pass. Never
  // persisted — see PLAYLIST PART 3 NOTES.
  let unavailableItemIds = new Set();
  // True once repeat=off has run out of a next item after the last
  // track ended — cleared by any fresh play (see playPlaylistItem/
  // startPlaylist above).
  let playlistFinished = false;
  // True once armAutoplayWatchdog()'s timer fires without the player
  // ever having reached PLAYING/BUFFERING — cleared the moment it does.
  let playbackBlocked = false;
  let autoplayWatchdogTimer = null;
  let progressTickerTimer = null;

  function mmss(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  /* ---- Autoplay-restriction watchdog (spec #11) --------------------- */
  function clearAutoplayWatchdog() {
    if (autoplayWatchdogTimer) {
      clearTimeout(autoplayWatchdogTimer);
      autoplayWatchdogTimer = null;
    }
  }

  function armAutoplayWatchdog() {
    clearAutoplayWatchdog();
    autoplayWatchdogTimer = setTimeout(() => {
      autoplayWatchdogTimer = null;
      if (!player || !window.YT) return;
      let state = null;
      try {
        state = player.getPlayerState();
      } catch {
        return;
      }
      const playing = state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING;
      if (!playing) {
        playbackBlocked = true;
        showStatus("Your browser blocked autoplay — press ▶ Play to continue.", 6000);
        updateTransportUI();
      }
    }, 1800);
  }

  /* ---- Progress ticker (spec #8 — modest interval, stopped when idle) */
  function startProgressTicker() {
    if (progressTickerTimer) return; // already running
    progressTickerTimer = setInterval(updateProgressUI, 1000);
    updateProgressUI();
  }

  function stopProgressTicker() {
    if (progressTickerTimer) {
      clearInterval(progressTickerTimer);
      progressTickerTimer = null;
    }
  }

  /* ---- Unavailable-video skip on error (spec #12/#13) --------------- */
  // Walks the same play-order Next/Previous already use (respects
  // shuffle) starting just after `fromIndex`, wrapping only if
  // repeat=playlist, and returns the first index whose item id isn't in
  // `unavailableItemIds`. Bounded to one lap of the queue.
  function findNextPlayableIndex(fromIndex) {
    const playlist = getActivePlaylist();
    if (!playlist || !playlist.items.length) return -1;
    const order = buildPlaybackQueue(playlist);
    if (!order.length) return -1;
    const startPos = order.indexOf(fromIndex);
    const wrap = playbackState.repeatMode === "playlist";
    for (let step = 1; step <= order.length; step++) {
      let pos = startPos + step;
      if (pos >= order.length) {
        if (!wrap) break;
        pos %= order.length;
      }
      const idx = order[pos];
      const candidate = playlist.items[idx];
      if (candidate && !unavailableItemIds.has(candidate.id)) return idx;
    }
    return -1;
  }

  function skipToNextPlayableAfterError() {
    const playlist = getActivePlaylist();
    const failed = getCurrentQueueItem();
    if (failed) unavailableItemIds.add(failed.id);
    if (!playlist || !playlist.items.length) return;

    if (unavailableItemIds.size >= playlist.items.length) {
      // Spec #13 — every item in the playlist has now failed at least
      // once this pass; stop instead of cycling through errors again.
      showPlaylistFinished({ reason: "No playable videos remain in this playlist." });
      return;
    }
    const nextIdx = findNextPlayableIndex(playbackState.currentIndex);
    if (nextIdx === -1) {
      showPlaylistFinished({ reason: "No playable videos remain in this playlist." });
      return;
    }
    showStatus("That video isn't available — skipping to the next one…", 2500);
    playPlaylistItem(playlist.id, nextIdx);
  }

  /* ---- "Playlist finished" state (spec #3) --------------------------- */
  function showPlaylistFinished({ reason } = {}) {
    playlistFinished = true;
    stopProgressTicker();
    if (reason) showStatus(reason, 6000);
    updateTransportUI();
  }

  function replayActivePlaylist() {
    const pid = playbackState.activePlaylistId;
    if (!pid) return;
    startPlaylist(pid, { fromIndex: 0 });
  }

  /* ---- Previous-with-threshold (spec #6) ----------------------------- */
  function handlePreviousClick() {
    if (playlistFinished) {
      replayActivePlaylist();
      return;
    }
    let currentTime = 0;
    try {
      currentTime = player ? player.getCurrentTime() : 0;
    } catch {
      currentTime = 0;
    }
    if (currentTime > 3) {
      try {
        player.seekTo(0, true);
      } catch {
        /* non-fatal */
      }
      return;
    }
    playPreviousInQueue();
  }

  function handleNextClick() {
    if (playlistFinished) {
      replayActivePlaylist();
      return;
    }
    if (!playNextInQueue()) {
      // Nothing to advance to (repeat=off, already at the end) — same
      // ended state the natural ENDED event would have shown.
      showPlaylistFinished();
    }
  }

  function handlePlayPauseClick() {
    if (!player) return;
    if (playlistFinished) {
      replayActivePlaylist();
      return;
    }
    if (playbackBlocked) {
      try {
        player.playVideo();
      } catch {
        /* non-fatal */
      }
      return;
    }
    let state = null;
    try {
      state = player.getPlayerState();
    } catch {
      return;
    }
    try {
      if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING) player.pauseVideo();
      else player.playVideo();
    } catch {
      /* non-fatal */
    }
  }

  // 📺 Skip Ad — the app's "Skip YouTube Ad" shortcut (skipYoutubeAd in
  // script.js's CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM). The Skip Ad
  // button YouTube shows during an ad lives inside this player's own
  // iframe — a genuinely different origin from the app's page, so
  // script.js/this file can't reach into that iframe's DOM directly
  // (the browser blocks cross-origin DOM access outright, try/catch or
  // not). postMessage is the one channel that's allowed to cross that
  // boundary: this posts straight to the iframe's own window, and the
  // companion extension's content-youtube.js — injected into every
  // youtube.com frame as of manifest.json's "all_frames": true, not
  // just top-level tabs — is what's actually listening on the other
  // side and does the real work of finding + clicking whatever Skip Ad
  // button is currently showing. A silent no-op if there's no player
  // yet, if getIframe() isn't available for some reason, if the
  // extension isn't installed, or if no ad happens to be playing right
  // now — there's nothing useful to show the person for any of those,
  // same restraint as the transport handlers above.
  // TEMP DEBUG: console.log calls below trace whether skipAd() is even
  // being invoked, whether a player/iframe exists at the moment it's
  // called, and whether the postMessage actually goes out — safe to
  // remove once Skip Ad is confirmed working end-to-end.
  function skipAd() {
    console.log("[VocabBridge:youtube-window] skipAd() called. player:", !!player);
    if (!player) return;
    let iframe = null;
    try {
      iframe = player.getIframe?.();
    } catch {
      iframe = null;
    }
    console.log("[VocabBridge:youtube-window] skipAd() iframe:", iframe, "contentWindow:", iframe && !!iframe.contentWindow);
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "VOCAB_SKIP_YOUTUBE_AD" }, "https://www.youtube.com");
      console.log("[VocabBridge:youtube-window] skipAd() postMessage sent to iframe.");
    } catch (err) {
      console.log("[VocabBridge:youtube-window] skipAd() postMessage threw:", err);
      /* non-fatal — extension not installed, or the iframe isn't ready yet */
    }
  }

  function handleRepeatClick() {
    const order = ["off", "playlist", "one"];
    const next = order[(order.indexOf(playbackState.repeatMode) + 1) % order.length];
    setRepeatMode(next);
    updateTransportUI();
    // Keep the playlist-detail view's own repeat button (if open) in
    // sync — same control, two places it can be toggled from.
    if (currentBodyView === "playlist-detail") renderPlaylistDetail();
  }

  // Playlist Part 4B (spec #9/#10) — Shuffle toggle for the compact
  // transport bar. Calls straight into Part 1/4A's setShuffleEnabled(),
  // exactly like the playlist-detail view's own Shuffle button already
  // does (see renderPlaylistDetail() above) — no second shuffle
  // implementation, just a second place to flip the same state.
  function handleShuffleClick() {
    setShuffleEnabled(!playbackState.shuffleEnabled);
    updateTransportUI();
    // Keep the playlist-detail view's own shuffle button (if open) in
    // sync — same control, two places it can be toggled from.
    if (currentBodyView === "playlist-detail") renderPlaylistDetail();
  }

  /* ---- Transport bar DOM (built once, lazily) ------------------------ */
  let transportBarEl = null;
  function ensureTransportBar() {
    if (transportBarEl || !body) return transportBarEl;
    transportBarEl = document.createElement("div");
    transportBarEl.id = "yw-transport-bar";
    transportBarEl.className = "yw-transport-bar hidden";
    transportBarEl.innerHTML = `
      <div class="yw-np-info">
        <div class="yw-np-title" id="yw-np-title"></div>
        <div class="yw-np-sub" id="yw-np-sub"></div>
      </div>
      <div class="yw-np-progress-row">
        <span class="yw-np-time" id="yw-np-elapsed">0:00</span>
        <div class="yw-np-progress-track" id="yw-np-progress-track">
          <div class="yw-np-progress-fill" id="yw-np-progress-fill"></div>
        </div>
        <span class="yw-np-time" id="yw-np-duration">0:00</span>
      </div>
      <div class="yw-np-controls">
        <button type="button" class="yw-transport-btn yw-transport-shuffle-btn" id="yw-transport-shuffle-btn" title="Shuffle" aria-label="Shuffle" aria-pressed="false">🔀</button>
        <button type="button" class="yw-transport-btn" id="yw-transport-prev-btn" title="Previous" aria-label="Previous">⏮</button>
        <button type="button" class="yw-transport-btn yw-transport-btn-main" id="yw-transport-playpause-btn" title="Play/Pause" aria-label="Play or pause">⏸</button>
        <button type="button" class="yw-transport-btn" id="yw-transport-next-btn" title="Next" aria-label="Next">⏭</button>
        <button type="button" class="yw-transport-btn yw-transport-repeat-btn" id="yw-transport-repeat-btn" title="Repeat" aria-label="Change repeat mode">🔁</button>
      </div>
    `;
    // Mounted on #yw-body (not #yw-video-wrap) so it stays visible — and
    // playlist controls stay reachable — regardless of which content
    // panel (video / results / playlist library / playlist detail) is
    // currently shown. This is what makes "Playlist-focused" layout mode
    // (see layoutMode below) actually usable: browsing the playlist list
    // doesn't lose the transport controls the way it would if this were
    // still a child of #yw-video-wrap, which setView() hides outright.
    body.appendChild(transportBarEl);
    transportBarEl.querySelector("#yw-transport-shuffle-btn").addEventListener("click", handleShuffleClick);
    transportBarEl.querySelector("#yw-transport-prev-btn").addEventListener("click", handlePreviousClick);
    transportBarEl.querySelector("#yw-transport-next-btn").addEventListener("click", handleNextClick);
    transportBarEl.querySelector("#yw-transport-playpause-btn").addEventListener("click", handlePlayPauseClick);
    transportBarEl.querySelector("#yw-transport-repeat-btn").addEventListener("click", handleRepeatClick);
    transportBarEl.querySelector("#yw-np-progress-track").addEventListener("click", (e) => {
      // Seeking is a nice-to-have on top of spec #8's "display progress
      // where practical" — reuses the already-known duration, no new API
      // call, and is a plain player.seekTo(), same category as Previous's
      // seekTo(0) above.
      if (!player || playbackBlocked || playlistFinished) return;
      let duration = 0;
      try {
        duration = player.getDuration();
      } catch {
        return;
      }
      if (!duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      try {
        player.seekTo(duration * ratio, true);
      } catch {
        /* non-fatal */
      }
    });
    return transportBarEl;
  }

  function hideTransportBar() {
    if (transportBarEl) transportBarEl.classList.add("hidden");
    body?.classList.remove("yw-has-transport-bar");
  }

  // True only when the currently-loaded video IS the active playlist's
  // current queue item — a standalone video (or a playlist item played
  // once but since superseded) never shows the transport bar. See
  // PLAYLIST PART 3 NOTES: "THE TRANSPORT BAR IS PLAYLIST-ONLY".
  function isPlayingActivePlaylistItem() {
    return !!(playbackState.activePlaylistId && currentVideoId && getCurrentQueueItem()?.videoId === currentVideoId);
  }

  function updateTransportUI() {
    if (!body) return;
    if (!isPlayingActivePlaylistItem()) {
      hideTransportBar();
      return;
    }
    const bar = ensureTransportBar();
    if (!bar) return;
    const playlist = getActivePlaylist();
    const item = getCurrentQueueItem();
    if (!playlist || !item) {
      hideTransportBar();
      return;
    }
    bar.classList.remove("hidden");
    body.classList.add("yw-has-transport-bar");

    const titleEl2 = bar.querySelector("#yw-np-title");
    const subEl = bar.querySelector("#yw-np-sub");
    // Spec #7 — graceful fallback with no extra API call: currentVideoMeta
    // already carries whatever the playlist item itself stored, and
    // loadVideo() already defaults an empty title to "YouTube Video".
    const title = (currentVideoMeta && currentVideoMeta.title) || item.title || "YouTube video";
    const channel = (currentVideoMeta && currentVideoMeta.channelTitle) || item.channelTitle || "";
    if (titleEl2) titleEl2.textContent = title;
    if (subEl) {
      const trackPos = `Track ${playbackState.currentIndex + 1} of ${playlist.items.length}`;
      subEl.textContent = [channel, playlist.name, trackPos].filter(Boolean).join(" • ");
    }

    const shuffleBtn = bar.querySelector("#yw-transport-shuffle-btn");
    const prevBtn = bar.querySelector("#yw-transport-prev-btn");
    const nextBtn = bar.querySelector("#yw-transport-next-btn");
    const playPauseBtn = bar.querySelector("#yw-transport-playpause-btn");
    const repeatBtn = bar.querySelector("#yw-transport-repeat-btn");

    if (playlistFinished) {
      bar.classList.add("yw-transport-ended");
      if (playPauseBtn) {
        playPauseBtn.textContent = "↺";
        playPauseBtn.title = "Replay playlist";
        playPauseBtn.setAttribute("aria-label", "Replay playlist");
      }
      if (subEl) subEl.textContent = `Playlist finished • ${playlist.name}`;
    } else {
      bar.classList.remove("yw-transport-ended");
      if (playPauseBtn) {
        let state = null;
        try {
          state = player ? player.getPlayerState() : null;
        } catch {
          state = null;
        }
        const showPause = !playbackBlocked && window.YT && (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING);
        playPauseBtn.textContent = playbackBlocked ? "▶" : showPause ? "⏸" : "▶";
        playPauseBtn.title = playbackBlocked ? "Autoplay was blocked — click to play" : showPause ? "Pause" : "Play";
        playPauseBtn.setAttribute("aria-label", playPauseBtn.title);
      }
    }
    // Previous is always available while a playlist track is loaded
    // (it either restarts the current track or moves back — see
    // handlePreviousClick); Next is disabled only when there's
    // genuinely nowhere to go (repeat=off, last item, nothing queued).
    if (prevBtn) prevBtn.disabled = false;
    if (nextBtn) nextBtn.disabled = !playlistFinished && getNextQueueIndex() === -1 && !playbackState.upNext.length;

    if (repeatBtn) {
      const mode = playbackState.repeatMode;
      repeatBtn.textContent = mode === "one" ? "🔂" : "🔁";
      repeatBtn.classList.toggle("yw-transport-repeat-active", mode !== "off");
      repeatBtn.title = mode === "one" ? "Repeat: one song — click to change" : mode === "playlist" ? "Repeat: whole playlist — click to change" : "Repeat: off — click to change";
      repeatBtn.setAttribute("aria-label", repeatBtn.title);
    }

    // Playlist Part 4B (spec #9/#10/#21) — active state is never color-only:
    // the button also gets the accent "active" treatment shared with the
    // repeat button, plus aria-pressed and a dynamic label/title.
    if (shuffleBtn) {
      const on = playbackState.shuffleEnabled;
      shuffleBtn.classList.toggle("yw-transport-shuffle-active", on);
      shuffleBtn.setAttribute("aria-pressed", String(on));
      shuffleBtn.title = on ? "Shuffle: on — click to turn off" : "Shuffle: off — click to turn on";
      shuffleBtn.setAttribute("aria-label", shuffleBtn.title);
    }

    updateProgressUI();
  }

  function updateProgressUI() {
    if (!transportBarEl || transportBarEl.classList.contains("hidden")) return;
    const fill = transportBarEl.querySelector("#yw-np-progress-fill");
    const elapsedEl = transportBarEl.querySelector("#yw-np-elapsed");
    const durationEl = transportBarEl.querySelector("#yw-np-duration");
    if (!fill || !elapsedEl || !durationEl) return;
    if (!player || playlistFinished) {
      fill.style.width = "0%";
      elapsedEl.textContent = "0:00";
      durationEl.textContent = "0:00";
      return;
    }
    let current = 0;
    let duration = 0;
    try {
      current = player.getCurrentTime() || 0;
      duration = player.getDuration() || 0;
    } catch {
      return;
    }
    fill.style.width = `${duration ? Math.min(100, (current / duration) * 100) : 0}%`;
    elapsedEl.textContent = mmss(current);
    durationEl.textContent = mmss(duration);
  }

  /* ----------------------------------------------------------------------
     SEARCH (Part 3) — renders results as a clickable list right here in
     the window (via the centralized YTApi.searchVideos(), see the file
     header for why a key is needed). A pasted link/ID skips the API
     entirely and just plays (see search() below).

     SEARCH STATE — an explicit object (per the ARCHITECTURE MAP's
     component 2) rather than loose closure vars, since paging needs to
     remember more than "was there a pending query": the query text
     itself, the token for the *next* page, and — critically — every
     video ID already shown, so a "Load more" click (or, in principle, a
     YouTube API page overlap) can never render the same result twice.
     A brand-new search (typing a different query and hitting Enter)
     always starts this over; only the explicit "Load more" action
     extends it.
  ---------------------------------------------------------------------- */
  const searchState = {
    query: "",
    order: "relevance", // "relevance" | "date" | "viewCount" — YouTube's own search.list `order` values (Part 6)
    sortable: true, // false for the single-item channel oldest/newest mini-result (via renderResults())
    pageToken: null, // the pageToken that produced the CURRENTLY-shown page (null for page 1)
    nextPageToken: null, // token to request the next page; null once exhausted
    prevPageToken: null, // kept for completeness (Part 7 spec) — no "back a page" UI consumes this yet
    items: [], // enriched, render-ready result rows, in display order
    loadedIds: new Set(), // every video ID already fetched this search — dedup guard
    loadingMore: false, // a "Load more" / infinite-scroll request is in flight
    // Bumped by every resetSearchState() call (new query OR new sort).
    // Any in-flight request captures this value before its first await and
    // compares it after — a mismatch means a newer search/sort superseded
    // it, so its (now-stale) response must be discarded rather than
    // applied on top of whatever is on screen now. This is what prevents
    // "search A, then search B, then A's slow response arrives" from
    // clobbering B's results (Part 7 spec — RACE CONDITIONS).
    requestId: 0,
  };

  // `order` persists across calls unless explicitly overridden (defaults
  // to the previous search's choice, or "relevance" the very first time)
  // — mirrors how the channel video browser's chosen sort persists across
  // channels. `sortable: false` hides the sort row entirely; used only by
  // the single-item "channel oldest/newest" mini-tool result.
  // Returns the new requestId so callers can capture it for the race guard.
  function resetSearchState(query, opts = {}) {
    searchState.query = query;
    searchState.order = opts.order || searchState.order || "relevance";
    searchState.sortable = opts.sortable !== false;
    searchState.pageToken = null;
    searchState.nextPageToken = null;
    searchState.prevPageToken = null;
    searchState.items = [];
    searchState.loadedIds.clear();
    searchState.loadingMore = false;
    searchState.requestId += 1;
    return searchState.requestId;
  }

  // ---- formatting helpers for the richer result cards ----
  function formatIsoDuration(iso) {
    // ISO 8601 duration, e.g. "PT1H2M10S" -> "1:02:10". Live streams and
    // some premieres omit contentDetails.duration entirely (or return
    // "P0D") — callers treat a null return as "no duration to show".
    if (!iso) return null;
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    const h = parseInt(m[1] || "0", 10);
    const mm = parseInt(m[2] || "0", 10);
    const s = parseInt(m[3] || "0", 10);
    if (h > 0) return `${h}:${String(mm).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${mm}:${String(s).padStart(2, "0")}`;
  }
  function formatViewCount(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return null;
    try {
      return `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(num)} views`;
    } catch {
      return `${num.toLocaleString()} views`;
    }
  }
  // Same compact notation as formatViewCount but without the " views"
  // suffix, since Part 4 needs it for three different labels (subscriber
  // count, video count, total views). Returns null for anything that
  // isn't a usable number so callers can render "—" consistently.
  function formatCompactNumber(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return null;
    try {
      return new Intl.NumberFormat(undefined, { notation: "compact" }).format(num);
    } catch {
      return num.toLocaleString();
    }
  }
  function formatPublished(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function truncate(text, max) {
    const t = (text || "").trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max).trimEnd()}…`;
  }

  // search.list already returns snippet.publishedAt/description/
  // liveBroadcastContent for free — no extra request needed for those.
  // Only duration + view count require a follow-up videos.list call,
  // and that call is batched once per page (up to 8 IDs here), never
  // once per card. See getVideoDetails()'s doc comment for why
  // "contentDetails,statistics" together is one request, not two.
  async function enrichWithDetails(searchItems) {
    const ids = searchItems.map((item) => item.id?.videoId).filter(Boolean);
    if (!ids.length) return new Map();
    try {
      const data = await YTApi.getVideoDetails(ids, { parts: "contentDetails,statistics" });
      const map = new Map();
      (data.items || []).forEach((v) => {
        map.set(v.id, {
          duration: formatIsoDuration(v.contentDetails?.duration),
          views: formatViewCount(v.statistics?.viewCount),
        });
      });
      return map;
    } catch {
      // Non-fatal: cards still render fine with title/channel/date/desc
      // alone if the follow-up details call fails for any reason.
      return new Map();
    }
  }

  function shapeResultRow(item, details) {
    const id = item.id?.videoId;
    if (!id) return null;
    const snippet = item.snippet || {};
    const live = snippet.liveBroadcastContent; // "live" | "upcoming" | "none"
    return {
      id,
      title: snippet.title || "Untitled",
      channelTitle: snippet.channelTitle || "",
      publishedAt: snippet.publishedAt || null,
      description: snippet.description || "",
      thumb: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
      live: live === "live" || live === "upcoming" ? live : null,
      duration: details?.duration || null,
      views: details?.views || null,
    };
  }

  // ---- rendering: one function per state (loading / error / no-results
  // / results), all writing into the same #yw-results container ----
  function renderResultsLoading(query) {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="yw-results-head"><span>Searching “${escapeHtml(query)}”…</span></div>
      <p class="yw-results-message">Loading…</p>
    `;
    setView("results");
  }

  function renderResultsError(query, message, { retry } = {}) {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="yw-results-head">
        <span>Search for “${escapeHtml(query)}”</span>
        <button type="button" class="yw-results-clear-btn" id="yw-results-clear-inline">✕</button>
      </div>
      <p class="yw-results-message">${escapeHtml(message)}</p>
      ${retry ? `<button type="button" class="yw-results-clear-btn yw-results-retry-btn" id="yw-results-retry-inline">Try again</button>` : ""}
    `;
    setView("results");
    document.getElementById("yw-results-clear-inline")?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      setView(currentVideoId ? "video" : "empty");
    });
    document.getElementById("yw-results-retry-inline")?.addEventListener("click", retry || (() => {}));
  }

  function renderResultCard(row) {
    const metaBits = [];
    if (row.live === "live") metaBits.push(`<span class="yw-live-badge yw-live-badge-live">🔴 LIVE</span>`);
    else if (row.live === "upcoming") metaBits.push(`<span class="yw-live-badge yw-live-badge-upcoming">🕒 Upcoming</span>`);
    if (row.duration) metaBits.push(`<span class="yw-result-duration">${escapeHtml(row.duration)}</span>`);
    if (row.views) metaBits.push(`<span>${escapeHtml(row.views)}</span>`);
    const published = formatPublished(row.publishedAt);
    if (published) metaBits.push(`<span>${escapeHtml(published)}</span>`);
    const desc = truncate(row.description, 130);
    // Playlist Part 2B1 — the card itself is untouched (still the same
    // full play button); a sibling "+ Add" pill is wrapped alongside it
    // in `.yw-result-row` rather than redesigning the card, per spec.
    // The whole thing never re-fetches anything: every field the add
    // button needs (videoId/title/channelTitle/thumb/duration) is
    // already sitting in `row`, from this same already-completed search.
    return `
      <div class="yw-result-row">
        <button type="button" class="yw-result-item" data-video-id="${escapeHtml(row.id)}">
          <img class="yw-result-thumb" src="${escapeHtml(row.thumb)}" alt="" loading="lazy" draggable="false">
          <span class="yw-result-text">
            <span class="yw-result-title">${escapeHtml(row.title)}</span>
            <span class="yw-result-channel">${escapeHtml(row.channelTitle)}</span>
            <span class="yw-result-meta">${metaBits.join('<span class="yw-result-meta-dot">·</span>')}</span>
            ${desc ? `<span class="yw-result-desc">${escapeHtml(desc)}</span>` : ""}
          </span>
        </button>
        <div class="yw-result-add-wrap">
          <button type="button" class="yw-add-btn" data-add-video-id="${escapeHtml(row.id)}" aria-haspopup="true" aria-expanded="false" aria-label="Add ${escapeHtml(row.title)} to a playlist">+ Add</button>
        </div>
      </div>
    `;
  }

  // Labels/order values for the video-search sort row (Part 6). No
  // "Oldest" entry on purpose — see PART 6 NOTES in the file header for
  // why general search can't honestly offer one.
  const SEARCH_SORT_OPTIONS = [
    { order: "relevance", label: "Relevance" },
    { order: "date", label: "Newest" },
    { order: "viewCount", label: "Most popular" },
  ];

  function renderResultsList() {
    if (!resultsEl) return;
    const { query, items, nextPageToken, loadingMore, order, sortable } = searchState;

    if (!items.length) {
      renderResultsError(query, "No results found — try a different search.");
      return;
    }

    const rows = items.map(renderResultCard).join("");
    const footer = loadingMore
      ? `<p class="yw-results-message">Loading…</p>`
      : nextPageToken
      ? `<button type="button" class="yw-results-loadmore-btn" id="yw-results-loadmore">Load more results</button>`
      : `<p class="yw-results-end">No more results</p>`;

    const sortControl = sortable
      ? `
      <div class="yw-search-sort" id="yw-search-sort" role="group" aria-label="Sort video results">
        ${SEARCH_SORT_OPTIONS.map(
          (opt) =>
            `<button type="button" class="yw-channel-sort-btn${order === opt.order ? " active" : ""}" data-sort="${opt.order}" aria-pressed="${order === opt.order}">${escapeHtml(opt.label)}</button>`
        ).join("")}
      </div>`
      : "";

    resultsEl.innerHTML = `
      <div class="yw-results-head">
        <span>Results for “${escapeHtml(query)}”</span>
        <button type="button" class="yw-results-clear-btn" id="yw-results-clear-inline">✕</button>
      </div>
      ${sortControl}
      ${rows}
      <div class="yw-results-footer">${footer}</div>
    `;
    setView("results");

    resultsEl.querySelectorAll(".yw-result-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        lastResultsContext = "search";
        // Playlist Part 2B1 — pass along whatever's already known about
        // this row (title/channel/thumb/duration) so the current-video
        // "+ Add to Playlist" button has real metadata to work with too,
        // without any extra request (searchState.items is the same list
        // already rendered here).
        const row = searchState.items.find((r) => r.id === btn.dataset.videoId);
        loadVideo(btn.dataset.videoId, row ? { meta: row } : undefined);
      });
    });
    // Playlist Part 2B1 — "+ Add" never touches the network: `row` here
    // is the exact same already-fetched search-result item the card
    // above renders from, just reshaped to the {videoId, ...} field
    // names addItemToPlaylist()/playlist items use (see
    // playlistSourceFromResultRow()).
    resultsEl.querySelectorAll("[data-add-video-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = searchState.items.find((r) => r.id === btn.dataset.addVideoId);
        if (!row) return;
        openAddToPlaylistMenu(btn, playlistSourceFromResultRow(row));
      });
    });
    document.getElementById("yw-results-clear-inline")?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      setView(currentVideoId ? "video" : "empty");
    });
    document.getElementById("yw-results-loadmore")?.addEventListener("click", () => loadMoreResults());
    document.getElementById("yw-search-sort")?.querySelectorAll(".yw-channel-sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => changeSearchSort(btn.dataset.sort));
    });
  }

  // Shim for the channel oldest/newest finder below (findChannelVideo()),
  // which calls this with a single already-fetched item shaped like a
  // search.list row (see playlistItemToSearchShape()). Fixes a
  // pre-existing bug — see the PART 4 NOTES in the file header — where
  // this function was called but never defined.
  function renderResults(items, label) {
    resetSearchState(label, { order: "relevance", sortable: false });
    const rows = items.map((item) => shapeResultRow(item, null)).filter(Boolean);
    rows.forEach((r) => searchState.loadedIds.add(r.id));
    searchState.items = rows;
    searchState.nextPageToken = null;
    renderResultsList();
  }

  // Renders whatever is currently on screen (video or results) without
  // re-fetching — used by the "back to results" affordance in the video
  // view, so results found earlier stay available after a click plays
  // one of them (per the spec's "keep search results available").
  function backToResults() {
    if (!searchState.items.length) return;
    renderResultsList();
  }

  // `order`: "relevance" | "date" | "viewCount" (Part 6). Omitted/undefined
  // falls back to whatever searchState.order already holds, so a plain
  // re-search (typing a new query) keeps the person's last-chosen sort
  // instead of silently reverting to Relevance.
  async function runApiSearch(query, order) {
    if (!isActive) open();
    else show();
    const useOrder = order || searchState.order || "relevance";
    // resetSearchState() bumps searchState.requestId — capture the value
    // for THIS search so the response handler below can tell whether a
    // newer search (or sort change) has since superseded it.
    const myRequestId = resetSearchState(query, { order: useOrder, sortable: true });
    renderResultsLoading(query);
    try {
      const opts = { maxResults: 8 };
      if (useOrder !== "relevance") opts.order = useOrder;
      const data = await perfTimeAsync("YouTube Video Search", () => YTApi.searchVideos(query, opts));
      // A later search (or sort change) already reset this state while we
      // were waiting — this response is stale; drop it silently rather
      // than clobbering whatever is now on screen (Part 7 — RACE CONDITIONS).
      if (searchState.requestId !== myRequestId) return;
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const freshItems = rawItems.filter((item) => item.id?.videoId && !searchState.loadedIds.has(item.id.videoId));
      freshItems.forEach((item) => searchState.loadedIds.add(item.id.videoId));
      const detailsMap = await enrichWithDetails(freshItems);
      if (searchState.requestId !== myRequestId) return; // superseded during the details enrichment await, too
      const rows = freshItems.map((item) => shapeResultRow(item, detailsMap.get(item.id.videoId))).filter(Boolean);
      searchState.items = rows;
      searchState.pageToken = null;
      searchState.nextPageToken = data.nextPageToken || null;
      searchState.prevPageToken = data.prevPageToken || null;
      renderResultsList();
    } catch (err) {
      if (searchState.requestId !== myRequestId) return; // superseded — don't show a stale error either
      renderResultsError(query, err?.message || "Couldn't reach YouTube — check your connection and try again.", {
        retry: () => runApiSearch(query, useOrder),
      });
    }
  }

  // Re-runs the current search with a different `order` — a fresh search
  // (resetSearchState clears items/loadedIds/nextPageToken), not a
  // client-side resort, so a sort change can never mix results from two
  // different orderings together.
  function changeSearchSort(order) {
    if (!searchState.query || !searchState.sortable) return;
    if (searchState.order === order && searchState.items.length) return;
    runApiSearch(searchState.query, order);
  }

  async function loadMoreResults() {
    if (searchState.loadingMore || !searchState.nextPageToken || !searchState.query) return;
    // Not a reset, so requestId isn't bumped here — but a NEW search or
    // sort change (which does bump it) could still start and finish while
    // this page request is in flight. Capture the generation now so the
    // response handler can detect that and bail out instead of appending
    // this (now-orphaned) page onto an unrelated search's results.
    const myRequestId = searchState.requestId;
    const tokenForThisPage = searchState.nextPageToken;
    searchState.loadingMore = true;
    renderResultsList();
    try {
      const opts = { maxResults: 8, pageToken: tokenForThisPage };
      if (searchState.order && searchState.order !== "relevance") opts.order = searchState.order;
      const data = await perfTimeAsync("YouTube Video Search — Load More", () => YTApi.searchVideos(searchState.query, opts));
      if (searchState.requestId !== myRequestId) return; // superseded — a newer search/sort owns the state now
      const rawItems = Array.isArray(data.items) ? data.items : [];
      // Dedup against every ID already shown this search, not just this
      // page — YouTube's paged results can occasionally overlap by one
      // or two items around a page boundary.
      const freshItems = rawItems.filter((item) => item.id?.videoId && !searchState.loadedIds.has(item.id.videoId));
      freshItems.forEach((item) => searchState.loadedIds.add(item.id.videoId));
      const detailsMap = await enrichWithDetails(freshItems);
      if (searchState.requestId !== myRequestId) return;
      const newRows = freshItems.map((item) => shapeResultRow(item, detailsMap.get(item.id.videoId))).filter(Boolean);
      searchState.items = searchState.items.concat(newRows);
      searchState.pageToken = tokenForThisPage;
      searchState.nextPageToken = data.nextPageToken || null;
      searchState.prevPageToken = data.prevPageToken || null;
    } catch (err) {
      if (searchState.requestId !== myRequestId) return;
      showStatus(err?.message || "Couldn't load more results — check your connection and try again.", 4000);
      // Keep nextPageToken as-is so the "Load more" button/infinite-scroll
      // reappears and the person (or the scroll trigger) can retry,
      // instead of silently stranding pagination.
    } finally {
      if (searchState.requestId === myRequestId) {
        searchState.loadingMore = false;
        renderResultsList();
      }
    }
  }

  /* ----------------------------------------------------------------------
     CHANNEL SEARCH (Part 4) — the "Channels" tab. Mirrors the video
     search block above almost exactly (own state object, own
     loading/error/list renderers, own load-more), deliberately kept as a
     parallel structure rather than a generalized "search either kind"
     function — see the PART 4 NOTES in the file header for why that
     separation matters (it's what guarantees switching tabs can't
     corrupt either search).
  ---------------------------------------------------------------------- */
  const channelSearchState = {
    query: "",
    pageToken: null, // the pageToken that produced the CURRENTLY-shown page (null for page 1)
    nextPageToken: null,
    prevPageToken: null, // kept for completeness (Part 7 spec) — no "back a page" UI consumes this yet
    items: [], // shaped rows: { id, title, description, thumb, subscriberCount, hiddenSubs, videoCount, viewCount }
    loadedIds: new Set(),
    loadingMore: false,
    requestId: 0, // same race-condition guard pattern as searchState — see its comment
  };

  function resetChannelSearchState(query) {
    channelSearchState.query = query;
    channelSearchState.pageToken = null;
    channelSearchState.nextPageToken = null;
    channelSearchState.prevPageToken = null;
    channelSearchState.items = [];
    channelSearchState.loadedIds.clear();
    channelSearchState.loadingMore = false;
    channelSearchState.requestId += 1;
    return channelSearchState.requestId;
  }

  // The channel currently open in detail view, if any — independent of
  // both search states, per the spec's "maintain separate state" list.
  let selectedChannel = null;

  // search.list(type=channel) returns no statistics — only channels.list
  // does — so every fresh page of results gets one batched
  // YTApi.getChannelsDetails() call (up to 50 IDs) rather than a request
  // per card, same pattern as enrichWithDetails() for videos.
  async function enrichChannelsWithStats(searchItems) {
    const ids = searchItems.map((item) => item.id?.channelId).filter(Boolean);
    if (!ids.length) return new Map();
    try {
      const data = await YTApi.getChannelsDetails(ids, { parts: "statistics" });
      const map = new Map();
      (data.items || []).forEach((ch) => {
        const stats = ch.statistics || {};
        map.set(ch.id, {
          subscriberCount: stats.hiddenSubscriberCount ? null : formatCompactNumber(stats.subscriberCount),
          hiddenSubs: !!stats.hiddenSubscriberCount,
          videoCount: formatCompactNumber(stats.videoCount),
          viewCount: formatCompactNumber(stats.viewCount),
        });
      });
      return map;
    } catch {
      // Non-fatal — cards still render fine with thumb/name/id/description
      // alone if this follow-up call fails for any reason.
      return new Map();
    }
  }

  function shapeChannelRow(item, stats) {
    const id = item.id?.channelId;
    if (!id) return null;
    const snippet = item.snippet || {};
    return {
      id,
      title: snippet.title || "Untitled channel",
      description: snippet.description || "",
      thumb: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
      subscriberCount: stats?.subscriberCount ?? null,
      hiddenSubs: stats?.hiddenSubs || false,
      videoCount: stats?.videoCount ?? null,
      viewCount: stats?.viewCount ?? null,
    };
  }

  function renderChannelResultsLoading(query) {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="yw-results-head"><span>Searching channels for “${escapeHtml(query)}”…</span></div>
      <p class="yw-results-message">Loading…</p>
    `;
    setView("results");
  }

  function renderChannelResultsError(query, message, { retry } = {}) {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="yw-results-head">
        <span>Channel search for “${escapeHtml(query)}”</span>
        <button type="button" class="yw-results-clear-btn" id="yw-channel-results-clear-inline">✕</button>
      </div>
      <p class="yw-results-message">${escapeHtml(message)}</p>
      ${retry ? `<button type="button" class="yw-results-clear-btn yw-results-retry-btn" id="yw-channel-results-retry-inline">Try again</button>` : ""}
    `;
    setView("results");
    document.getElementById("yw-channel-results-clear-inline")?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      setView(currentVideoId ? "video" : "empty");
    });
    document.getElementById("yw-channel-results-retry-inline")?.addEventListener("click", retry || (() => {}));
  }

  function renderChannelResultCard(row) {
    const statBits = [];
    statBits.push(`<span>${row.hiddenSubs ? "Subscribers hidden" : row.subscriberCount != null ? `${escapeHtml(row.subscriberCount)} subscribers` : "— subscribers"}</span>`);
    statBits.push(`<span>${row.videoCount != null ? `${escapeHtml(row.videoCount)} videos` : "— videos"}</span>`);
    statBits.push(`<span>${row.viewCount != null ? `${escapeHtml(row.viewCount)} views` : "— views"}</span>`);
    const desc = truncate(row.description, 130);
    return `
      <button type="button" class="yw-result-item" data-channel-id="${escapeHtml(row.id)}">
        <img class="yw-channel-thumb" src="${escapeHtml(row.thumb)}" alt="" loading="lazy" draggable="false">
        <span class="yw-result-text">
          <span class="yw-channel-result-name">${escapeHtml(row.title)}</span>
          <span class="yw-channel-result-id">${escapeHtml(row.id)}</span>
          <span class="yw-channel-result-stats">${statBits.join("")}</span>
          ${desc ? `<span class="yw-channel-result-desc">${escapeHtml(desc)}</span>` : ""}
        </span>
      </button>
    `;
  }

  function renderChannelResultsList() {
    if (!resultsEl) return;
    const { query, items, nextPageToken, loadingMore } = channelSearchState;

    if (!items.length) {
      renderChannelResultsError(query, "No channels found — try a different search.");
      return;
    }

    const rows = items.map(renderChannelResultCard).join("");
    const footer = loadingMore
      ? `<p class="yw-results-message">Loading…</p>`
      : nextPageToken
      ? `<button type="button" class="yw-results-loadmore-btn" id="yw-channel-results-loadmore">Load more channels</button>`
      : `<p class="yw-results-end">No more results</p>`;

    resultsEl.innerHTML = `
      <div class="yw-results-head">
        <span>Channels for “${escapeHtml(query)}”</span>
        <button type="button" class="yw-results-clear-btn" id="yw-channel-results-clear-inline">✕</button>
      </div>
      ${rows}
      <div class="yw-results-footer">${footer}</div>
    `;
    setView("results");

    resultsEl.querySelectorAll(".yw-result-item").forEach((btn) => {
      btn.addEventListener("click", () => openChannelDetail(btn.dataset.channelId, channelSearchState.items.find((r) => r.id === btn.dataset.channelId)));
    });
    document.getElementById("yw-channel-results-clear-inline")?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      setView(currentVideoId ? "video" : "empty");
    });
    document.getElementById("yw-channel-results-loadmore")?.addEventListener("click", () => loadMoreChannelResults());
  }

  async function runChannelSearch(query) {
    if (!isActive) open();
    else show();
    const myRequestId = resetChannelSearchState(query);
    renderChannelResultsLoading(query);
    try {
      const data = await perfTimeAsync("YouTube Channel Search", () => YTApi.searchChannels(query, { maxResults: 8 }));
      if (channelSearchState.requestId !== myRequestId) return; // superseded by a newer channel search
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const freshItems = rawItems.filter((item) => item.id?.channelId && !channelSearchState.loadedIds.has(item.id.channelId));
      freshItems.forEach((item) => channelSearchState.loadedIds.add(item.id.channelId));
      const statsMap = await enrichChannelsWithStats(freshItems);
      if (channelSearchState.requestId !== myRequestId) return;
      const rows = freshItems.map((item) => shapeChannelRow(item, statsMap.get(item.id.channelId))).filter(Boolean);
      channelSearchState.items = rows;
      channelSearchState.pageToken = null;
      channelSearchState.nextPageToken = data.nextPageToken || null;
      channelSearchState.prevPageToken = data.prevPageToken || null;
      renderChannelResultsList();
    } catch (err) {
      if (channelSearchState.requestId !== myRequestId) return;
      renderChannelResultsError(query, err?.message || "Couldn't reach YouTube — check your connection and try again.", {
        retry: () => runChannelSearch(query),
      });
    }
  }

  async function loadMoreChannelResults() {
    if (channelSearchState.loadingMore || !channelSearchState.nextPageToken || !channelSearchState.query) return;
    const myRequestId = channelSearchState.requestId;
    const tokenForThisPage = channelSearchState.nextPageToken;
    channelSearchState.loadingMore = true;
    renderChannelResultsList();
    try {
      const data = await perfTimeAsync("YouTube Channel Search — Load More", () =>
        YTApi.searchChannels(channelSearchState.query, { maxResults: 8, pageToken: tokenForThisPage })
      );
      if (channelSearchState.requestId !== myRequestId) return; // superseded — a newer channel search owns the state now
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const freshItems = rawItems.filter((item) => item.id?.channelId && !channelSearchState.loadedIds.has(item.id.channelId));
      freshItems.forEach((item) => channelSearchState.loadedIds.add(item.id.channelId));
      const statsMap = await enrichChannelsWithStats(freshItems);
      if (channelSearchState.requestId !== myRequestId) return;
      const newRows = freshItems.map((item) => shapeChannelRow(item, statsMap.get(item.id.channelId))).filter(Boolean);
      channelSearchState.items = channelSearchState.items.concat(newRows);
      channelSearchState.pageToken = tokenForThisPage;
      channelSearchState.nextPageToken = data.nextPageToken || null;
      channelSearchState.prevPageToken = data.prevPageToken || null;
    } catch (err) {
      if (channelSearchState.requestId !== myRequestId) return;
      showStatus(err?.message || "Couldn't load more channels — check your connection and try again.", 4000);
    } finally {
      if (channelSearchState.requestId === myRequestId) {
        channelSearchState.loadingMore = false;
        renderChannelResultsList();
      }
    }
  }

  // Infinite scroll for BOTH search modes (Part 7) — #yw-results is the one
  // scrollable region either mode renders into (`.yw-results { overflow-y:
  // auto }`), so a single listener here, routed by `activeSearchMode`,
  // covers both video search and channel search without a second
  // container or a second listener. Falls back gracefully to the existing
  // "Load more" button for anyone who never scrolls (or whose results fit
  // without scrolling at all) — both paths call the exact same
  // loadMoreResults()/loadMoreChannelResults(), so they can never race
  // each other into firing the same request twice (guarded by
  // `loadingMore` inside each).
  resultsEl?.addEventListener("scroll", () => {
    if (currentBodyView !== "results") return;
    const nearBottom = resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 150;
    if (!nearBottom) return;
    if (activeSearchMode === "videos") {
      if (searchState.loadingMore || !searchState.nextPageToken || !searchState.query) return;
      loadMoreResults();
    } else {
      if (channelSearchState.loadingMore || !channelSearchState.nextPageToken || !channelSearchState.query) return;
      loadMoreChannelResults();
    }
  });

  function searchChannelsQuery(query) {
    const q = (query || "").trim();
    if (!q) {
      showStatus("Type a channel name to search for.", 2500);
      searchInput?.focus();
      return false;
    }
    hideFooterSearchAreaOnSearch();
    if (!apiKey) {
      if (!isActive) open();
      else show();
      pendingChannelSearchTerm = q;
      openSettingsPanel(`channel search: “${q}”`);
      return true;
    }
    runChannelSearch(q);
    return true;
  }

  /* ----------------------------------------------------------------------
     CHANNEL DETAIL VIEW (Part 4) — opens inside the window when a
     channel result card is clicked. `fallback` is the already-fetched
     result row (thumb/name/description/counts already in hand from the
     search results), rendered immediately so the view isn't blank while
     the full channels.list lookup (for the handle, and to confirm the
     freshest stats) completes.
  ---------------------------------------------------------------------- */
  function renderChannelDetail() {
    if (!channelDetailEl || !selectedChannel) return;
    const ch = selectedChannel;
    const statRow = (label, value) => `<div class="yw-channel-detail-stat"><strong>${value != null ? escapeHtml(value) : "—"}</strong>${escapeHtml(label)}</div>`;
    channelDetailEl.innerHTML = `
      <button type="button" class="yw-channel-detail-back-btn" id="yw-channel-detail-back-btn">◀ Back to channels</button>
      <div class="yw-channel-detail-header">
        <img class="yw-channel-detail-avatar" src="${escapeHtml(ch.thumb || "")}" alt="${escapeHtml(ch.title || "Channel")} avatar" loading="lazy" draggable="false">
        <div>
          <div class="yw-channel-detail-name">${escapeHtml(ch.title || "Untitled channel")}</div>
          ${ch.handle ? `<div class="yw-channel-detail-handle">${escapeHtml(ch.handle)}</div>` : ""}
          <div class="yw-channel-detail-id">${escapeHtml(ch.id)}</div>
        </div>
      </div>
      <div class="yw-channel-detail-stats">
        ${statRow("subscribers", ch.hiddenSubs ? "Hidden" : ch.subscriberCount)}
        ${statRow("videos", ch.videoCount)}
        ${statRow("total views", ch.viewCount)}
      </div>
      ${ch.description ? `<div class="yw-channel-detail-desc">${escapeHtml(ch.description)}</div>` : ""}
      <div class="yw-channel-videos">
        <div class="yw-channel-videos-head">
          <h4>Videos</h4>
          <div class="yw-channel-sort" id="yw-channel-sort" role="group" aria-label="Sort channel videos">
            <button type="button" class="yw-channel-sort-btn${channelVideosState.sortOrder === "newest" ? " active" : ""}" data-sort="newest" aria-pressed="${channelVideosState.sortOrder === "newest"}">Newest</button>
            <button type="button" class="yw-channel-sort-btn${channelVideosState.sortOrder === "oldest" ? " active" : ""}" data-sort="oldest" aria-pressed="${channelVideosState.sortOrder === "oldest"}">Oldest</button>
            <button type="button" class="yw-channel-sort-btn${channelVideosState.sortOrder === "popular" ? " active" : ""}" data-sort="popular" aria-pressed="${channelVideosState.sortOrder === "popular"}">Most popular</button>
          </div>
        </div>
        <div id="yw-channel-videos-section"></div>
      </div>
    `;
    setView("channel-detail");
    document.getElementById("yw-channel-detail-back-btn")?.addEventListener("click", backToChannelResults);
    document.getElementById("yw-channel-sort")?.querySelectorAll(".yw-channel-sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => changeChannelSort(btn.dataset.sort));
    });
    renderChannelVideosSection();
  }

  function renderChannelDetailLoading(fallback) {
    if (!channelDetailEl) return;
    channelDetailEl.innerHTML = `
      <button type="button" class="yw-channel-detail-back-btn" id="yw-channel-detail-back-btn">◀ Back to channels</button>
      <p class="yw-channel-detail-loading">${fallback ? `Loading ${escapeHtml(fallback.title)}…` : "Loading channel…"}</p>
    `;
    setView("channel-detail");
    document.getElementById("yw-channel-detail-back-btn")?.addEventListener("click", backToChannelResults);
  }

  function renderChannelDetailError(message) {
    if (!channelDetailEl) return;
    channelDetailEl.innerHTML = `
      <button type="button" class="yw-channel-detail-back-btn" id="yw-channel-detail-back-btn">◀ Back to channels</button>
      <p class="yw-channel-detail-message">${escapeHtml(message)}</p>
    `;
    setView("channel-detail");
    document.getElementById("yw-channel-detail-back-btn")?.addEventListener("click", backToChannelResults);
  }

  function shapeChannelDetail(ch) {
    const stats = ch.statistics || {};
    return {
      id: ch.id,
      title: ch.snippet?.title || "Untitled channel",
      description: ch.snippet?.description || "",
      thumb: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || "",
      handle: ch.snippet?.customUrl ? (ch.snippet.customUrl.startsWith("@") ? ch.snippet.customUrl : `@${ch.snippet.customUrl}`) : null,
      subscriberCount: stats.hiddenSubscriberCount ? null : formatCompactNumber(stats.subscriberCount),
      hiddenSubs: !!stats.hiddenSubscriberCount,
      videoCount: formatCompactNumber(stats.videoCount),
      viewCount: formatCompactNumber(stats.viewCount),
      // Kept for Part 5's channel video browser — not used by this part.
      uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads || null,
    };
  }

  function openChannelDetail(channelId, fallbackRow) {
    if (!channelId) return;
    if (!isActive) open();
    else show();
    selectedChannel = fallbackRow ? { ...fallbackRow, handle: null } : { id: channelId };
    renderChannelDetailLoading(fallbackRow);
    YTApi.getChannel({ id: channelId }, "snippet,statistics,contentDetails")
      .then((data) => {
        const ch = data.items?.[0];
        if (!ch) {
          renderChannelDetailError("Couldn't find that channel — it may have been removed.");
          return;
        }
        selectedChannel = shapeChannelDetail(ch);
        renderChannelDetail();
        startChannelVideosForSelected();
      })
      .catch((err) => {
        renderChannelDetailError(err?.message || "Couldn't load that channel — check your connection and try again.");
      });
  }

  // Returns to the channel search results without re-fetching — same
  // "keep results available" pattern as the video search's backToResults().
  // Deliberately does NOT touch `channelVideosState` — see PART 5 NOTES.
  function backToChannelResults() {
    selectedChannel = null;
    if (channelSearchState.items.length) {
      renderChannelResultsList();
    } else {
      setView(currentVideoId ? "video" : "empty");
    }
  }

  /* ----------------------------------------------------------------------
     CHANNEL VIDEO BROWSER (Part 5) — the "Videos" list inside channel
     detail. Data path, per the spec: the uploads playlist ID Part 4
     already resolved (`selectedChannel.uploadsPlaylistId`, itself cached)
     → YTApi.getPlaylistVideos() for a page of items → one batched
     YTApi.getVideoDetails() call for that page's IDs. No search.list
     anywhere in this path — playlistItems.list costs 1 unit vs.
     search.list's 100, which is the whole point.
  ---------------------------------------------------------------------- */
  const channelVideosState = {
    channelId: null,
    playlistId: null,
    sortOrder: "newest", // "newest" | "oldest" | "popular" (Part 6) — persists across channels, like searchState.order
    pageToken: null, // "newest" mode only — the pageToken that produced the CURRENTLY-shown page (null for page 1)
    nextPageToken: null, // "newest" mode only — server-side incremental paging
    prevPageToken: null, // "newest" mode only — kept for completeness (Part 7 spec), no "back a page" UI yet
    items: [], // shaped, render-ready rows currently displayed, in display order
    loadedIds: new Set(),
    loadingMore: false,
    status: "idle", // "idle" | "loading" | "loading-full" | "loaded" | "error" | "no-playlist"
    errorMessage: null,
    // "oldest"/"popular" only — the whole uploads playlist, sorted, fetched
    // once, then paged through locally (see loadFullChannelPlaylist() /
    // revealMoreFromFullList() in the PART 6 sorting block below).
    fullList: null,
    fullListEnriched: false, // true once fullList rows already carry duration/views (popular mode)
    revealCount: 0, // how many of fullList are currently sliced into `items`
    truncated: false, // hit the pagination guard before reaching the real end of the playlist
    // Same race-condition guard pattern as searchState/channelSearchState
    // (Part 7). startFullListSort() already re-checked channelId/sortOrder
    // by hand after its await (Part 6) — this generalizes that into the
    // same requestId scheme everything else uses, and closes the one gap
    // that old check didn't cover: loadChannelVideosPage()'s "newest" path
    // had no such guard at all before this.
    requestId: 0,
  };

  // `sortOrder` is intentionally NOT reset to a fixed default here unless
  // explicitly passed — it persists across channels (pass a 3rd arg to
  // change it), same as searchState.order persists across searches.
  function resetChannelVideosState(channelId, playlistId, sortOrder) {
    channelVideosState.channelId = channelId;
    channelVideosState.playlistId = playlistId;
    channelVideosState.sortOrder = sortOrder || channelVideosState.sortOrder || "newest";
    channelVideosState.pageToken = null;
    channelVideosState.nextPageToken = null;
    channelVideosState.prevPageToken = null;
    channelVideosState.items = [];
    channelVideosState.loadedIds.clear();
    channelVideosState.loadingMore = false;
    channelVideosState.status = "idle";
    channelVideosState.errorMessage = null;
    channelVideosState.fullList = null;
    channelVideosState.fullListEnriched = false;
    channelVideosState.revealCount = 0;
    channelVideosState.truncated = false;
    channelVideosState.requestId += 1;
    return channelVideosState.requestId;
  }

  // playlistItems.list's snippet carries title/description/publishedAt/
  // thumbnails/resourceId.videoId directly — no extra request needed for
  // those. Only duration + view count need a follow-up videos.list call,
  // batched once per page (same pattern as the video search's
  // enrichWithDetails(), adapted here since playlist items are shaped
  // differently than search.list items — resourceId.videoId, not
  // id.videoId).
  async function enrichPlaylistItemsWithDetails(playlistItems) {
    const ids = playlistItems.map((item) => item.snippet?.resourceId?.videoId).filter(Boolean);
    if (!ids.length) return new Map();
    try {
      const data = await YTApi.getVideoDetails(ids, { parts: "contentDetails,statistics" });
      const map = new Map();
      (data.items || []).forEach((v) => {
        map.set(v.id, {
          duration: formatIsoDuration(v.contentDetails?.duration),
          views: formatViewCount(v.statistics?.viewCount),
        });
      });
      return map;
    } catch {
      // Non-fatal — cards still render fine with title/date/description
      // alone if this follow-up call fails for any reason.
      return new Map();
    }
  }

  function shapeChannelVideoRow(item, details) {
    const snippet = item.snippet || {};
    const id = snippet.resourceId?.videoId;
    if (!id) return null;
    return {
      id,
      title: snippet.title || "Untitled",
      publishedAt: snippet.publishedAt || null,
      description: snippet.description || "",
      thumb: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
      duration: details?.duration || null,
      views: details?.views || null,
    };
  }

  function renderChannelVideoCard(row) {
    const metaBits = [];
    if (row.duration) metaBits.push(`<span class="yw-result-duration">${escapeHtml(row.duration)}</span>`);
    if (row.views) metaBits.push(`<span>${escapeHtml(row.views)}</span>`);
    const published = formatPublished(row.publishedAt);
    if (published) metaBits.push(`<span>${escapeHtml(published)}</span>`);
    const desc = truncate(row.description, 130);
    return `
      <button type="button" class="yw-result-item" data-video-id="${escapeHtml(row.id)}">
        <img class="yw-result-thumb" src="${escapeHtml(row.thumb)}" alt="" loading="lazy" draggable="false">
        <span class="yw-result-text">
          <span class="yw-result-title">${escapeHtml(row.title)}</span>
          <span class="yw-result-meta">${metaBits.join('<span class="yw-result-meta-dot">·</span>')}</span>
          ${desc ? `<span class="yw-result-desc">${escapeHtml(desc)}</span>` : ""}
        </span>
      </button>
    `;
  }

  // Renders ONLY the `#yw-channel-videos-section` sub-container, not the
  // whole channel detail view — paging a list nested inside a scrolling
  // panel must never reset that panel's scroll position back to the top.
  function renderChannelVideosSection() {
    const section = document.getElementById("yw-channel-videos-section");
    if (!section) return;
    // Guards against a stale flash of a *different* channel's videos:
    // renderChannelDetail() (header/back-button/stats) can repaint before
    // startChannelVideosForSelected() has decided whether to resume or
    // reset channelVideosState for the channel now open.
    if (channelVideosState.channelId !== null && channelVideosState.channelId !== selectedChannel?.id) {
      section.innerHTML = `<p class="yw-results-message">Loading videos…</p>`;
      return;
    }
    const { status, items, nextPageToken, loadingMore, errorMessage, sortOrder, fullList, revealCount, truncated } = channelVideosState;

    if (status === "no-playlist") {
      section.innerHTML = `<p class="yw-results-message">This channel doesn't have a public uploads list.</p>`;
      return;
    }
    if (status === "loading") {
      section.innerHTML = `<p class="yw-results-message">Loading videos…</p>`;
      return;
    }
    if (status === "loading-full") {
      // Oldest/Most popular can't render a single correct row until the
      // whole uploads playlist has been paged through — see PART 6 NOTES.
      section.innerHTML = `<p class="yw-results-message">Reading this channel's full upload list to sort ${
        sortOrder === "popular" ? "by views" : "oldest-first"
      } — this can take a moment for channels with a lot of videos…</p>`;
      return;
    }
    if (status === "error" && !items.length) {
      section.innerHTML = `
        <p class="yw-results-message">${escapeHtml(errorMessage || "Couldn't load this channel's videos.")}</p>
        <button type="button" class="yw-results-clear-btn yw-results-retry-btn" id="yw-channel-videos-retry">Try again</button>
      `;
      document.getElementById("yw-channel-videos-retry")?.addEventListener("click", () => runChannelVideosForSort(sortOrder));
      return;
    }
    if (status === "loaded" && !items.length) {
      section.innerHTML = `<p class="yw-results-message">This channel doesn't seem to have any public uploads.</p>`;
      return;
    }

    // Oldest/Most popular: if the full-catalog traversal hit the
    // pagination guard before actually reaching the end of the playlist,
    // the ordering is only established over what WAS scanned — say so
    // plainly rather than presenting it as complete (per the spec's
    // "don't claim globally accurate results the implementation can't
    // guarantee").
    const truncationNotice =
      sortOrder !== "newest" && truncated
        ? `<p class="yw-results-message yw-channel-sort-truncated">This channel has more uploads than could be fully scanned — the ${
            sortOrder === "popular" ? "popularity" : "oldest-first"
          } order above only covers the first ${fullList ? fullList.length.toLocaleString() : ""} videos found, not guaranteed to include every upload.</p>`
        : "";

    const rows = items.map(renderChannelVideoCard).join("");
    const hasMoreLocal = sortOrder !== "newest" && !!fullList && revealCount < fullList.length;
    const footer =
      status === "error"
        ? `<p class="yw-results-message">${escapeHtml(errorMessage || "Couldn't load more videos.")}</p><button type="button" class="yw-results-clear-btn yw-results-retry-btn" id="yw-channel-videos-retry-more">Try again</button>`
        : loadingMore
        ? `<p class="yw-results-message">Loading…</p>`
        : sortOrder === "newest"
        ? nextPageToken
          ? `<button type="button" class="yw-results-loadmore-btn" id="yw-channel-videos-loadmore">Load more videos</button>`
          : `<p class="yw-results-end">No more results</p>`
        : hasMoreLocal
        ? `<button type="button" class="yw-results-loadmore-btn" id="yw-channel-videos-loadmore">Load more videos</button>`
        : `<p class="yw-results-end">No more results</p>`;

    section.innerHTML = `${truncationNotice}${rows}<div class="yw-results-footer">${footer}</div>`;

    section.querySelectorAll(".yw-result-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        lastResultsContext = "channel";
        loadVideo(btn.dataset.videoId);
      });
    });
    const advance = () => (sortOrder === "newest" ? loadChannelVideosPage({ more: true }) : revealMoreFromFullList());
    document.getElementById("yw-channel-videos-loadmore")?.addEventListener("click", advance);
    document.getElementById("yw-channel-videos-retry-more")?.addEventListener("click", advance);
  }

  async function loadChannelVideosPage({ reset = false, more = false } = {}) {
    // Capture the generation this request belongs to BEFORE any await —
    // for `reset`, resetChannelVideosState() already bumped it earlier in
    // this same synchronous call chain (runChannelVideosForSort ->
    // loadChannelVideosPage), so reading it here is exactly the value that
    // change produced (Part 7 — RACE CONDITIONS, closes the one gap
    // startFullListSort()'s hand-rolled channelId/sortOrder check didn't
    // cover: this "newest" path had no such guard at all before).
    const myRequestId = channelVideosState.requestId;
    if (reset) {
      channelVideosState.status = "loading";
      renderChannelVideosSection();
    } else if (more) {
      // Never request the same page twice, and never while already mid-request.
      if (channelVideosState.loadingMore || !channelVideosState.nextPageToken) return;
      channelVideosState.loadingMore = true;
      renderChannelVideosSection();
    } else {
      return;
    }

    const { playlistId } = channelVideosState;
    if (!playlistId) {
      if (channelVideosState.requestId !== myRequestId) return;
      channelVideosState.status = "no-playlist";
      channelVideosState.loadingMore = false;
      renderChannelVideosSection();
      return;
    }

    try {
      const pageToken = more ? channelVideosState.nextPageToken : undefined;
      const data = await perfTimeAsync("YouTube Channel Videos", () => YTApi.getPlaylistVideos(playlistId, { maxResults: 10, pageToken }));
      // A different channel, a sort change, or a fresh reset already took
      // over this state while we were waiting — drop this stale response.
      if (channelVideosState.requestId !== myRequestId) return;
      const rawItems = Array.isArray(data.items) ? data.items : [];
      // Dedup against every ID already shown this browse — playlist pages
      // can, like search pages, occasionally overlap by an item or two.
      const freshItems = rawItems.filter(
        (item) => item.snippet?.resourceId?.videoId && !channelVideosState.loadedIds.has(item.snippet.resourceId.videoId)
      );
      freshItems.forEach((item) => channelVideosState.loadedIds.add(item.snippet.resourceId.videoId));
      const detailsMap = await enrichPlaylistItemsWithDetails(freshItems);
      if (channelVideosState.requestId !== myRequestId) return;
      const newRows = freshItems.map((item) => shapeChannelVideoRow(item, detailsMap.get(item.snippet.resourceId.videoId))).filter(Boolean);
      channelVideosState.items = more ? channelVideosState.items.concat(newRows) : newRows;
      // The uploads playlist normally arrives newest-first already, but
      // "Newest" must reflect actual publication dates, not card arrival
      // order (Part 6 spec) — so every fetched page is explicitly
      // resorted on `publishedAt` rather than trusted at face value.
      channelVideosState.items.sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
      channelVideosState.pageToken = pageToken || null;
      channelVideosState.nextPageToken = data.nextPageToken || null;
      channelVideosState.prevPageToken = data.prevPageToken || null;
      channelVideosState.status = "loaded";
    } catch (err) {
      if (channelVideosState.requestId !== myRequestId) return;
      channelVideosState.status = "error";
      channelVideosState.errorMessage = err?.message || "Couldn't load this channel's videos — check your connection and try again.";
      // On a failed "load more", keep whatever was already loaded and
      // leave nextPageToken as-is so retry can pick up the same page —
      // never silently strand pagination or duplicate a page already in.
    } finally {
      if (channelVideosState.requestId === myRequestId) {
        channelVideosState.loadingMore = false;
        renderChannelVideosSection();
      }
    }
  }

  /* ----------------------------------------------------------------------
     OLDEST / MOST POPULAR CHANNEL SORTING (Part 6) — unlike "Newest",
     neither ordering can be established from a single page: "oldest"
     needs to know there's nothing further down the playlist, and
     "popular" needs every video's view count to rank them at all. Both
     therefore fetch the channel's ENTIRE uploads playlist once
     (`loadFullChannelPlaylist()`, same page-to-the-end approach — and
     the same 400-page/20,000-video guard — as the existing channel
     oldest/newest finder below), sort it fully client-side, and then
     page through that already-sorted local list on every subsequent
     "Load more" (`revealMoreFromFullList()`) — never a new network page,
     so the established order can never drift.
  ---------------------------------------------------------------------- */
  const CHANNEL_FULL_LIST_PAGE_GUARD = 400; // 400 × 50 = 20,000 videos — matches findChannelVideo()'s cap
  const CHANNEL_REVEAL_PAGE_SIZE = 10; // matches loadChannelVideosPage()'s page size, for a consistent feel

  async function loadFullChannelPlaylist(playlistId) {
    return perfTimeAsync("YouTube Channel Videos — Full Sort Scan", async () => {
      let pageToken = "";
      let guard = 0;
      const all = [];
      while (guard < CHANNEL_FULL_LIST_PAGE_GUARD) {
        guard += 1;
        const data = await YTApi.getPlaylistVideos(playlistId, { maxResults: 50, pageToken: pageToken || undefined });
        const items = Array.isArray(data.items) ? data.items : [];
        all.push(...items);
        if (!data.nextPageToken) return { items: all, truncated: false };
        pageToken = data.nextPageToken;
      }
      return { items: all, truncated: true };
    });
  }

  async function startFullListSort(order) {
    const channelId = selectedChannel?.id;
    const playlistId = selectedChannel?.uploadsPlaylistId;
    if (!channelId || !playlistId) return;
    // Same requestId generation captured at entry as loadChannelVideosPage
    // (Part 7) — supplements the pre-existing channelId/sortOrder checks
    // below (Part 6) rather than replacing them, so both a plain
    // channel/sort switch AND a same-channel/same-sort reset (e.g. mashing
    // "Try again") are caught.
    const myRequestId = channelVideosState.requestId;
    channelVideosState.status = "loading-full";
    renderChannelVideosSection();
    try {
      const { items: rawItems, truncated } = await loadFullChannelPlaylist(playlistId);
      // The person may have switched channels or sort modes again while
      // this (potentially long) traversal was in flight — a stale result
      // must never land on top of whatever is showing now.
      if (channelVideosState.channelId !== channelId || channelVideosState.sortOrder !== order || channelVideosState.requestId !== myRequestId)
        return;

      const withIds = rawItems.filter((item) => item.snippet?.resourceId?.videoId);

      if (order === "oldest") {
        // publishedAt is already free from playlistItems.list's snippet —
        // no extra request needed just to establish this ordering.
        withIds.sort((a, b) => new Date(a.snippet?.publishedAt || 0).getTime() - new Date(b.snippet?.publishedAt || 0).getTime());
        channelVideosState.fullList = withIds; // raw playlist items — duration/views enriched lazily per reveal
        channelVideosState.fullListEnriched = false;
      } else {
        // "popular" needs a view count for every single video before any
        // of them can be ranked — one batched pass (videos.list, chunked
        // 50 IDs per request internally, never one request per video)
        // for contentDetails+statistics together, which also covers
        // duration for free so reveal-time never needs a second call.
        const ids = withIds.map((item) => item.snippet.resourceId.videoId);
        const data = await YTApi.getVideoDetails(ids, { parts: "contentDetails,statistics" });
        if (channelVideosState.channelId !== channelId || channelVideosState.sortOrder !== order || channelVideosState.requestId !== myRequestId)
          return;
        const detailsMap = new Map();
        (data.items || []).forEach((v) => {
          detailsMap.set(v.id, {
            duration: formatIsoDuration(v.contentDetails?.duration),
            views: formatViewCount(v.statistics?.viewCount),
            viewsRaw: Number(v.statistics?.viewCount || 0),
          });
        });
        const shaped = withIds
          .map((item) => {
            const id = item.snippet.resourceId.videoId;
            const details = detailsMap.get(id);
            const row = shapeChannelVideoRow(item, details);
            if (row) row._viewsRaw = details?.viewsRaw || 0;
            return row;
          })
          .filter(Boolean);
        shaped.sort((a, b) => b._viewsRaw - a._viewsRaw);
        channelVideosState.fullList = shaped; // already fully shaped + enriched — reveal needs no further requests
        channelVideosState.fullListEnriched = true;
      }

      channelVideosState.truncated = truncated;
      channelVideosState.revealCount = 0;
      channelVideosState.items = [];
      channelVideosState.status = "loaded";
      await revealMoreFromFullList();
    } catch (err) {
      if (channelVideosState.channelId !== channelId || channelVideosState.sortOrder !== order || channelVideosState.requestId !== myRequestId)
        return;
      channelVideosState.status = "error";
      channelVideosState.errorMessage = err?.message || "Couldn't load this channel's full video list — check your connection and try again.";
      renderChannelVideosSection();
    }
  }

  // "Load more" for oldest/popular: slices the next chunk out of the
  // already-fetched, already-sorted `fullList` — no network request for
  // ordering purposes, only (for "oldest") a small batched enrichment
  // call for the 10 rows about to actually be shown.
  async function revealMoreFromFullList() {
    // Guard against re-entry — without this, rapid/repeated scrolling could
    // call this again before the first slice finishes revealing, double-
    // advancing `revealCount` and skipping rows (Part 7 — repeated/rapid
    // scrolling must never fire concurrent "next page" requests for the
    // same state). Mirrors the `loadingMore` check loadChannelVideosPage's
    // "more" branch already had.
    if (channelVideosState.loadingMore) return;
    const { fullList, revealCount, fullListEnriched, channelId: stateChannelId, sortOrder } = channelVideosState;
    const myRequestId = channelVideosState.requestId;
    if (!fullList || revealCount >= fullList.length) {
      renderChannelVideosSection();
      return;
    }
    const nextSlice = fullList.slice(revealCount, revealCount + CHANNEL_REVEAL_PAGE_SIZE);

    channelVideosState.loadingMore = true;
    renderChannelVideosSection();

    let newRows;
    if (fullListEnriched) {
      // "popular" — fullList entries are already complete shaped rows.
      newRows = nextSlice;
    } else {
      // "oldest" — fullList entries are still raw playlist items; enrich
      // only this chunk's IDs, batched, since these are the only rows
      // about to actually be displayed.
      const ids = nextSlice.map((item) => item.snippet?.resourceId?.videoId).filter(Boolean);
      let detailsMap = new Map();
      try {
        const data = await perfTimeAsync("YouTube Channel Videos — Reveal", () => YTApi.getVideoDetails(ids, { parts: "contentDetails,statistics" }));
        (data.items || []).forEach((v) => {
          detailsMap.set(v.id, { duration: formatIsoDuration(v.contentDetails?.duration), views: formatViewCount(v.statistics?.viewCount) });
        });
      } catch {
        /* non-fatal — cards still render with title/date/description alone */
      }
      if (
        channelVideosState.channelId !== stateChannelId ||
        channelVideosState.sortOrder !== sortOrder ||
        channelVideosState.requestId !== myRequestId
      ) {
        return; // superseded while enriching — leave loadingMore/items alone, the newer request owns them now
      }
      newRows = nextSlice.map((item) => shapeChannelVideoRow(item, detailsMap.get(item.snippet?.resourceId?.videoId))).filter(Boolean);
    }

    if (channelVideosState.requestId !== myRequestId) return; // superseded during the "popular" synchronous branch too
    newRows.forEach((r) => channelVideosState.loadedIds.add(r.id));
    channelVideosState.items = channelVideosState.items.concat(newRows);
    channelVideosState.revealCount += nextSlice.length;
    channelVideosState.loadingMore = false;
    renderChannelVideosSection();
  }

  // Single entry point both startChannelVideosForSelected() and
  // changeChannelSort() call to actually kick off fetching for whichever
  // sort is now active.
  function runChannelVideosForSort(order) {
    if (order === "newest") loadChannelVideosPage({ reset: true });
    else startFullListSort(order);
  }

  // Keeps the sort row's active-button highlight in sync without
  // re-running renderChannelDetail() (which would repaint the channel
  // header/stats and reset the panel's scroll position — the same
  // restraint Part 5 already applied to plain pagination).
  function reflectChannelSortUI() {
    document.getElementById("yw-channel-sort")?.querySelectorAll(".yw-channel-sort-btn").forEach((btn) => {
      const isActive = btn.dataset.sort === channelVideosState.sortOrder;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  }

  function changeChannelSort(order) {
    if (!selectedChannel || !["newest", "oldest", "popular"].includes(order)) return;
    if (
      channelVideosState.sortOrder === order &&
      channelVideosState.channelId === selectedChannel.id &&
      (channelVideosState.items.length || channelVideosState.status === "loaded" || channelVideosState.status === "no-playlist")
    ) {
      return; // already showing this sort for this channel — no-op
    }
    if (!selectedChannel.uploadsPlaylistId) return; // no-playlist case is handled by startChannelVideosForSelected
    resetChannelVideosState(selectedChannel.id, selectedChannel.uploadsPlaylistId, order);
    reflectChannelSortUI();
    runChannelVideosForSort(order);
  }

  // Called once a channel's full detail (including uploadsPlaylistId) is
  // in hand. Resumes an existing browse in place if this is the same
  // channel already browsed this session (the "reopening the channel"
  // case — instant, no refetch); starts fresh for any other channel. The
  // sort mode itself carries over from whatever was last chosen (Part 6),
  // same persistence pattern as searchState.order.
  function startChannelVideosForSelected() {
    if (!selectedChannel) return;
    if (!selectedChannel.uploadsPlaylistId) {
      resetChannelVideosState(selectedChannel.id, null);
      channelVideosState.status = "no-playlist";
      renderChannelVideosSection();
      return;
    }
    if (channelVideosState.channelId === selectedChannel.id && channelVideosState.items.length) {
      renderChannelVideosSection();
      return;
    }
    const order = channelVideosState.sortOrder || "newest";
    resetChannelVideosState(selectedChannel.id, selectedChannel.uploadsPlaylistId, order);
    runChannelVideosForSort(order);
  }

  // Infinite scroll on the channel-detail panel — it's already the one
  // scrollable region in this view, so no new scroll container is
  // needed. Guarded the same way the "Load more" button is
  // (loadingMore/nextPageToken inside loadChannelVideosPage itself), so
  // a fast scroll and a button click can never both fire a duplicate
  // request.
  channelDetailEl?.addEventListener("scroll", () => {
    if (currentBodyView !== "channel-detail") return;
    if (channelVideosState.loadingMore || channelVideosState.status === "error" || channelVideosState.status === "loading-full") return;
    const isNewest = channelVideosState.sortOrder === "newest";
    const hasMore = isNewest
      ? !!channelVideosState.nextPageToken
      : !!channelVideosState.fullList && channelVideosState.revealCount < channelVideosState.fullList.length;
    if (!hasMore) return;
    const nearBottom = channelDetailEl.scrollTop + channelDetailEl.clientHeight >= channelDetailEl.scrollHeight - 150;
    if (nearBottom) (isNewest ? loadChannelVideosPage({ more: true }) : revealMoreFromFullList());
  });

  /* ----------------------------------------------------------------------
     SEARCH-MODE TABS (Part 4) — Videos ↔ Channels. Switching tabs only
     changes what the search form does next and which state gets
     re-rendered; it never touches `searchState` or `channelSearchState`,
     so results already found in either mode are always still there when
     you tab back. A currently-playing video is left alone either way —
     tabbing to Channels doesn't stop or hide playback.
  ---------------------------------------------------------------------- */
  function reflectTabsUI() {
    const onVideos = activeSearchMode === "videos";
    tabVideosBtn?.classList.toggle("active", onVideos);
    tabVideosBtn?.setAttribute("aria-selected", String(onVideos));
    tabChannelsBtn?.classList.toggle("active", !onVideos);
    tabChannelsBtn?.setAttribute("aria-selected", String(!onVideos));
    if (searchInput) {
      searchInput.placeholder = onVideos ? "Search YouTube…" : "Search for a channel…";
      searchInput.setAttribute("aria-label", onVideos ? "Search YouTube or paste a video link" : "Search for a channel");
    }
  }

  function switchSearchMode(mode) {
    if (mode === activeSearchMode) return;
    activeSearchMode = mode;
    reflectTabsUI();
    // Don't disturb a video that's actively playing — tabs only affect
    // search, not playback. Otherwise, show whatever this mode already
    // has: its own results, an open channel detail, or its empty state.
    if (currentBodyView === "video") return;
    if (mode === "channels") {
      if (selectedChannel) renderChannelDetail();
      else if (channelSearchState.items.length) renderChannelResultsList();
      else setView("empty");
    } else {
      if (searchState.items.length) renderResultsList();
      else setView("empty");
    }
  }

  tabVideosBtn?.addEventListener("click", () => switchSearchMode("videos"));
  tabChannelsBtn?.addEventListener("click", () => switchSearchMode("channels"));

  // NOTE: this only opens the panel and shows a status message — it does
  // NOT set any pending-action variable itself. That's on purpose (fixed
  // as part of Part 4): three different callers now use this (a pending
  // video search, a pending channel lookup, a pending channel search),
  // each with its own pending* variable, and each sets its own before
  // calling here. If this function set pendingQuery unconditionally like
  // it used to, every one of those callers would also fire a video
  // search when the key was saved, alongside whatever it actually meant
  // to do.
  // Places the (now body-level) settings panel under the ⚙ button using
  // real fixed-viewport coordinates, and caps its own max-height to
  // whatever vertical space is actually left in the viewport below it —
  // so it always gets an internal scrollbar instead of being cut off
  // with no way to reach the rest of its content.
  function positionSettingsPanel() {
    if (!settingsPanel || !settingsBtn) return;
    const btnRect = settingsBtn.getBoundingClientRect();
    const margin = 6;
    const top = btnRect.bottom + margin;
    const right = Math.max(8, window.innerWidth - btnRect.right);
    const availableHeight = window.innerHeight - top - 12;
    settingsPanel.style.top = `${Math.max(8, top)}px`;
    settingsPanel.style.right = `${right}px`;
    settingsPanel.style.left = "auto";
    settingsPanel.style.maxHeight = `${Math.max(140, availableHeight)}px`;
  }

  function openSettingsPanel(prefillQuery) {
    settingsPanel?.classList.remove("hidden");
    positionSettingsPanel();
    settingsBtn?.setAttribute("aria-expanded", "true");
    // Compact Mode — keep the header revealed while its own settings
    // panel is open, even once the mouse drifts off the header itself
    // (the panel lives under <body>, not inside .yw-header — see the
    // reparenting note above dragHandle's declaration).
    dragHandle?.classList.add("yw-panel-open");
    if (apiKeyStatusEl) {
      apiKeyStatusEl.textContent = prefillQuery
        ? `Add a key to search for “${prefillQuery}” right here.`
        : "";
      apiKeyStatusEl.classList.toggle("hidden", !prefillQuery);
    }
    apiKeyInput?.focus();
  }

  function closeSettingsPanel() {
    settingsPanel?.classList.add("hidden");
    settingsBtn?.setAttribute("aria-expanded", "false");
    dragHandle?.classList.remove("yw-panel-open");
  }

  function search(query) {
    const q = (query || "").trim();
    if (!q) {
      // Empty-query state: don't silently no-op — say so, briefly.
      showStatus("Type something to search, or paste a video link.", 2500);
      searchInput?.focus();
      return false;
    }
    hideFooterSearchAreaOnSearch();

    // Direct-URL fast path (Part 8): classify the input BEFORE any API
    // work happens. A recognized video URL/ID plays immediately with zero
    // Data API quota (loadVideo() only ever builds a trusted /embed/<id>
    // URL from an already-validated ID — no search.list, no videos.list).
    // A YouTube URL that looked like a video link but didn't validate
    // gets a clear on-screen error and stops right here — it must NOT
    // silently fall through and get sent to search.list as literal query
    // text (that would both waste quota and return junk results). Only
    // genuine search text reaches the runApiSearch() call below.
    const parsed = parseVideoUrlInput(q);
    if (parsed.kind === "id") return loadVideo(parsed.videoId, { source: "paste" });
    if (parsed.kind === "invalid") {
      showStatus("That looks like a YouTube video link, but the video ID couldn't be read from it. Double-check the URL and try again.", 5000);
      return false;
    }

    if (!apiKey) {
      if (!isActive) open();
      else show();
      pendingQuery = q;
      openSettingsPanel(q);
      return true;
    }

    runApiSearch(q);
    return true;
  }

  function isOpen() {
    return isActive;
  }

  /* ----------------------------------------------------------------------
     CHANNEL OLDEST / NEWEST VIDEO FINDER — accepts a channel name,
     @handle, or any youtube.com/channel(@handle|c|user) URL, resolves it
     to a channel ID via the Data API, then reads that channel's uploads
     playlist (every channel has one, and it's already sorted by upload
     time). "Newest" is just the first item; "oldest" means paging all
     the way to the end, since the API has no "sort ascending" option.
  ---------------------------------------------------------------------- */
  function parseChannelInput(raw) {
    const input = (raw || "").trim();
    if (!input) return null;
    if (/^UC[A-Za-z0-9_-]{22}$/.test(input)) return { kind: "id", value: input };

    let url = null;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      url = null;
    }

    if (url && /(^|\.)youtube\.com$/.test(url.hostname.replace(/^www\.|^m\./, ""))) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel" && parts[1]) return { kind: "id", value: parts[1] };
      if (parts[0] && parts[0].startsWith("@")) return { kind: "handle", value: parts[0] };
      if (parts[0] === "c" && parts[1]) return { kind: "username", value: parts[1] };
      if (parts[0] === "user" && parts[1]) return { kind: "username", value: parts[1] };
      // Any other youtube.com channel-ish path — fall through to search.
    }

    if (input.startsWith("@")) return { kind: "handle", value: input };
    return { kind: "query", value: input };
  }

  // NOTE: the old apiGet()/resolveUploadsPlaylistId() pair that used to
  // live here has been folded into the centralized YTApi layer above
  // (getChannel / getChannelUploadsPlaylist) — see the ARCHITECTURE MAP
  // and the Part 2 risk note for why. Every call site below now goes
  // through YTApi instead of building its own request.

  function playlistItemToSearchShape(item) {
    const snip = item.snippet || {};
    return {
      id: { videoId: snip.resourceId?.videoId || "" },
      snippet: {
        title: snip.title,
        channelTitle: snip.videoOwnerChannelTitle || snip.channelTitle,
        thumbnails: snip.thumbnails,
      },
    };
  }

  async function findChannelVideo(order) {
    const raw = channelInput?.value || "";
    const parsed = parseChannelInput(raw);
    if (!parsed) return;
    hideFooterSearchAreaOnSearch();

    if (!apiKey) {
      if (!isActive) open();
      else show();
      pendingChannelQuery = { raw, order };
      openSettingsPanel(`channel lookup: “${raw}”`);
      return;
    }

    if (!isActive) open();
    else show();
    renderResultsLoading(`${order === "oldest" ? "oldest" : "newest"} video · ${raw}`);

    try {
      const resolved = await YTApi.getChannelUploadsPlaylist(parsed);
      if (!resolved) {
        renderResultsError(raw, "Couldn't find that channel — try pasting its full youtube.com URL instead.");
        return;
      }

      let item = null;
      if (order === "newest") {
        const data = await YTApi.getPlaylistVideos(resolved.uploadsId, { maxResults: 1 });
        item = data.items?.[0] || null;
      } else {
        // No "sort ascending" exists on this endpoint — page all the way
        // to the last page and take its last item.
        let pageToken = "";
        let guard = 0;
        while (guard < 400) {
          // 400 pages × 50 = 20,000 videos ceiling, generous for any channel
          guard += 1;
          const data = await YTApi.getPlaylistVideos(resolved.uploadsId, { maxResults: 50, pageToken: pageToken || undefined });
          const items = data.items || [];
          if (items.length) item = items[items.length - 1];
          if (!data.nextPageToken) break;
          pageToken = data.nextPageToken;
        }
      }

      if (!item || !item.snippet?.resourceId?.videoId) {
        renderResultsError(raw, "That channel doesn't seem to have any public uploads.");
        return;
      }
      renderResults([playlistItemToSearchShape(item)], `${order === "oldest" ? "Oldest" : "Newest"} upload from ${resolved.channelTitle}`);
    } catch (err) {
      renderResultsError(raw, err?.message || "Couldn't look that channel up — check your connection and try again.");
    }
  }

  /* ----------------------------------------------------------------------
     COMPACT MODE WIRING
  ---------------------------------------------------------------------- */
  compactModeToggle?.addEventListener("change", () => {
    compactSettings.enabled = !!compactModeToggle.checked;
    saveCompactSettings();
    applyCompactMode();
    reflectCompactSettingsUI();
  });

  compactHeaderBarToggle?.addEventListener("change", () => {
    compactSettings.headerBarMode = !!compactHeaderBarToggle.checked;
    saveCompactSettings();
    applyCompactMode();
  });

  // Playback-controls overlay: on = never show it at all; off (default) =
  // hover-to-reveal only, handled entirely in CSS (see
  // .yw-transport-permanent-hide / .yw-transport-bar:hover rules).
  transportHideToggle?.addEventListener("change", () => {
    transportPermanentlyHidden = !!transportHideToggle.checked;
    saveJson(YW_TRANSPORT_HIDE_STORAGE, transportPermanentlyHidden);
    applyTransportHideSetting();
  });

  compactTickInputs.forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.compactTick;
      if (!key) return;
      compactSettings.allowed[key] = !!input.checked;
      saveCompactSettings();
      applyCompactMode();
    });
  });

  compactHideModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      compactSettings.hideMode = radio.value === "onlyAfterSearch" ? "onlyAfterSearch" : "timer";
      saveCompactSettings();
      reflectCompactSettingsUI();
      // Switching to "Only after search" while the area happens to be
      // showing (and a timer is ticking) should stop that timer — it
      // now only hides once an actual search runs.
      if (compactSettings.hideMode === "onlyAfterSearch") clearFooterHideTimer();
    });
  });

  compactDelaySlider?.addEventListener("input", () => {
    compactSettings.hideSeconds = Math.min(
      YW_COMPACT_DELAY_MAX,
      Math.max(YW_COMPACT_DELAY_MIN, Number(compactDelaySlider.value) || YW_COMPACT_DELAY_MIN)
    );
    if (compactDelayValueEl) compactDelayValueEl.textContent = formatCompactDelayLabel(compactSettings.hideSeconds);
    saveCompactSettings();
    // Live-adjust an already-running timer to the newly chosen delay,
    // rather than waiting for the next reveal to pick it up.
    if (footerHideTimer && compactSettings.hideMode === "timer") showFooterSearchArea();
  });

  // Quick-action fallback buttons — always work in Compact Mode
  // regardless of what's ticked in the header tick-list above, so Hide
  // and Close are never accidentally locked out of reach.
  compactQuickHideBtn?.addEventListener("click", () => hide());
  compactQuickCloseBtn?.addEventListener("click", () => close());

  /* ----------------------------------------------------------------------
     SETTINGS PANEL WIRING (API key)
  ---------------------------------------------------------------------- */
  settingsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const willShow = settingsPanel?.classList.contains("hidden");
    if (willShow) openSettingsPanel();
    else closeSettingsPanel();
  });

  document.addEventListener("click", (e) => {
    if (
      settingsPanel &&
      !settingsPanel.classList.contains("hidden") &&
      !e.target.closest("#yw-settings-panel") &&
      !e.target.closest("#yw-settings-btn")
    ) {
      closeSettingsPanel();
    }
  });

  if (apiKeyInput) apiKeyInput.value = apiKey;

  apiKeySaveBtn?.addEventListener("click", () => {
    const value = (apiKeyInput?.value || "").trim();
    apiKey = value;
    try {
      if (value) localStorage.setItem(YW_API_KEY_STORAGE, value);
      else localStorage.removeItem(YW_API_KEY_STORAGE);
    } catch {
      /* non-fatal */
    }
    if (apiKeyStatusEl) {
      apiKeyStatusEl.textContent = value ? "Saved." : "Cleared.";
      apiKeyStatusEl.classList.remove("hidden");
    }
    closeSettingsPanel();
    if (value && pendingQuery) {
      const q = pendingQuery;
      pendingQuery = null;
      runApiSearch(q);
    }
    if (value && pendingChannelQuery) {
      const { order } = pendingChannelQuery;
      pendingChannelQuery = null;
      findChannelVideo(order);
    }
    if (value && pendingChannelSearchTerm) {
      const term = pendingChannelSearchTerm;
      pendingChannelSearchTerm = null;
      runChannelSearch(term);
    }
  });

  /* ----------------------------------------------------------------------
     SEARCH BAR WIRING
  ---------------------------------------------------------------------- */
  searchForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (activeSearchMode === "channels") searchChannelsQuery(searchInput?.value || "");
    else search(searchInput?.value || "");
  });

  /* ----------------------------------------------------------------------
     ENTER IN THE SEARCH BAR -> "Search this on YouTube.com" (🌐), not the
     in-window search. A form's native Enter-to-submit behavior always
     resolves to its default submit button (here, the 🔎 button — that's
     what "submit" fired above would have run), so the redirect has to
     happen at keydown, before that default fires, not inside the submit
     handler itself (by the time a submit event exists, the browser has
     already picked 🔎, and there's no way to tell "Enter" apart from an
     actual click on it from inside that handler).
     Capture phase + stopImmediatePropagation so the form's own submit
     listener above never runs for this keypress — the in-window search
     stays reachable, just only via an explicit click on 🔎 now. The 🌐
     button gets a brief orange flash (see .yw-key-triggered in
     youtube-window.css) so what just fired is visually obvious.
  ---------------------------------------------------------------------- */
  searchInput?.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      searchExternalBtn?.classList.remove("yw-key-triggered");
      void searchExternalBtn?.offsetWidth; // restart the flash animation on repeat presses
      searchExternalBtn?.classList.add("yw-key-triggered");
      searchExternalBtn?.click();
    },
    { capture: true }
  );
  searchExternalBtn?.addEventListener("animationend", (e) => {
    if (e.animationName === "yw-external-key-flash") searchExternalBtn.classList.remove("yw-key-triggered");
  });

  /* ----------------------------------------------------------------------
     SEARCH ON YOUTUBE.COM (Gemini Bridge extension) — sends whatever is
     currently typed in the search bar to the extension, which opens/
     reuses a real youtube.com tab and shows actual search results there
     (thumbnails, channel branding, live badges — everything the in-
     window API-key results can't replicate). The moment a video is
     picked on that tab, the extension relays its URL back here (see the
     YOUTUBE_VIDEO_SELECTED listener in script.js), the tab closes
     itself, and focus returns to this app automatically — no manual
     copy/paste, no manual tab-switching. Entirely inert with no error
     if the extension isn't installed; this only ever talks over
     window.postMessage, same as the Search Gemini button.

     Whether that tab actually closes itself afterward — and whether the
     video plays there at all before it does — depends on the "Keep
     YouTube tab open" toggle in this window's ⚙ settings panel: off
     (default) is the flow described above; on, the extension never lets
     the tab navigate to the video at all, just relays its link and
     leaves the tab sitting on the results page so it can be reused for
     the next pick too. See syncStayOnTabToExtension() and the ⚙ panel
     markup for that toggle.
  ---------------------------------------------------------------------- */
  searchExternalBtn?.addEventListener("click", () => {
    const q = (searchInput?.value || "").trim();
    if (!q) {
      showStatus("Type something to search first.", 2000);
      searchInput?.focus();
      return;
    }
    window.postMessage({ type: "YOUTUBE_SEARCH_EXTERNAL", query: q }, window.location.origin);
    showStatus(`Opening YouTube.com for “${escapeHtml(q)}”… pick a video there and you'll land right back here.`, 4000);
  });

  /* ----------------------------------------------------------------------
     CHANNEL FINDER WIRING
  ---------------------------------------------------------------------- */
  channelToggleBtn?.addEventListener("click", () => {
    const nowHidden = channelForm?.classList.toggle("hidden");
    if (channelToggleBtn) channelToggleBtn.textContent = nowHidden ? "📺 Channel: oldest / newest video ▾" : "📺 Channel: oldest / newest video ▴";
    if (!nowHidden) channelInput?.focus();
  });
  channelOldestBtn?.addEventListener("click", () => findChannelVideo("oldest"));
  channelNewestBtn?.addEventListener("click", () => findChannelVideo("newest"));
  channelInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findChannelVideo("newest");
    }
  });

  /* ----------------------------------------------------------------------
     LOOP / OPEN-ON-YOUTUBE WIRING
  ---------------------------------------------------------------------- */
  loopBtn?.addEventListener("click", () => {
    loopEnabled = !loopEnabled;
    saveJson(YW_LOOP_STORAGE, loopEnabled);
    reflectLoopUI();
    showStatus(loopEnabled ? "Looping this video." : "Loop turned off.", 2000);
  });

  stayOnTabToggle?.addEventListener("change", () => {
    stayOnYoutubeTab = !!stayOnTabToggle.checked;
    saveJson(YW_STAY_ON_TAB_STORAGE, stayOnYoutubeTab);
    syncStayOnTabToExtension();
    showStatus(
      stayOnYoutubeTab
        ? "Picking a video will now just copy its link back here — the YouTube tab stays open."
        : "Picking a video will open it on the YouTube tab, then bring you back here as before.",
      3000
    );
  });

  // Part 6 — layout mode toggle. Display-only: never touches playback,
  // the saved playlist, or playbackState. If the mode just switched to
  // "playlist" and a playlist track is already playing, jump straight to
  // that playlist's detail view so the effect is immediately visible
  // rather than only applying on the *next* track change.
  layoutToggleBtn?.addEventListener("click", () => {
    layoutMode = layoutMode === "player" ? "playlist" : "player";
    saveJson(YW_LAYOUT_MODE_STORAGE, layoutMode);
    reflectLayoutModeUI();
    if (layoutMode === "playlist" && playbackState.activePlaylistId) {
      openPlaylistDetail(playbackState.activePlaylistId);
    }
    showStatus(layoutMode === "playlist" ? "Playlist-focused layout." : "Player-focused layout.", 2000);
  });

  openExternalBtn?.addEventListener("click", () => {
    if (!currentVideoId) return;
    window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(currentVideoId)}`, "_blank", "noopener,noreferrer");
  });

  // Playlist Part 2B1 — "+ Add to Playlist" for the current video (spec
  // #8). Uses currentVideoMeta exactly as loadVideo() last set it —
  // whether that came from a search result, a playlist item, or a bare
  // pasted ID/URL (fallback title "YouTube Video", per spec #9) — so
  // this never performs a search or any other API call.
  addCurrentBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!currentVideoId || !currentVideoMeta) return;
    openAddToPlaylistMenu(addCurrentBtn, currentVideoMeta);
  });

  /* ----------------------------------------------------------------------
     HEADER BUTTONS
  ---------------------------------------------------------------------- */
  hideBtn?.addEventListener("click", () => hide());
  closeBtn?.addEventListener("click", () => close());
  toggleBtn.addEventListener("click", () => toggle());

  /* ----------------------------------------------------------------------
     DRAG (from the header bar) — same mousedown/mousemove/mouseup pattern
     as the Map Window's drag handle.
  ---------------------------------------------------------------------- */
  (function initDrag() {
    if (!dragHandle) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".yw-drag-grip")) return;
      closeSettingsPanel();
      dragging = true;
      moved = false;
      const rect = win.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      win.style.left = `${startLeft}px`;
      win.style.top = `${startTop}px`;
      win.style.right = "auto";
      win.style.bottom = "auto";
      dragHandle.classList.add("yw-dragging");
      // Also on the window itself — .yw-header and #yw-body (parent of
      // the transport bar) are siblings, so the transport bar's own
      // hover-reveal rules in youtube-window.css key off this rather
      // than dragHandle's class directly.
      win.classList.add("yw-dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) moved = true;
      const maxLeft = Math.max(0, window.innerWidth - win.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - win.offsetHeight);
      win.style.left = `${Math.min(Math.max(0, startLeft + (e.clientX - startX)), maxLeft)}px`;
      win.style.top = `${Math.min(Math.max(0, startTop + (e.clientY - startY)), maxTop)}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      dragHandle.classList.remove("yw-dragging");
      win.classList.remove("yw-dragging");
      persistState();
    });

    // Compact Mode — the grip is the only always-present hover target,
    // which leaves touch users with no way to reveal the header pill at
    // all (no :hover on touch). A tap that wasn't the tail end of a
    // drag toggles it open/closed instead; tapping anywhere else in the
    // window closes it again, same as the header simply losing :hover
    // does for a mouse.
    dragGrip?.addEventListener("click", (e) => {
      if (!compactSettings.enabled || moved) return;
      e.stopPropagation();
      dragHandle.classList.toggle("yw-revealed");
    });
    win.addEventListener("click", (e) => {
      if (!compactSettings.enabled || !dragHandle.classList.contains("yw-revealed")) return;
      if (e.target.closest(".yw-header")) return;
      dragHandle.classList.remove("yw-revealed");
    });
  })();

  /* ----------------------------------------------------------------------
     RESIZE (bottom-right corner handle) — Pointer Events so mouse,
     trackpad, touch, and pen all work identically, same as the Map
     Window's resize handle. Sets width AND height directly, clamped to
     the YW_MIN_WIDTH×YW_MIN_HEIGHT – 900×700 box (see those constants
     above).
  ---------------------------------------------------------------------- */
  (function initResize() {
    if (!resizeHandle) return;
    let resizing = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    function maxW() {
      return Math.min(YW_MAX_WIDTH, window.innerWidth - 32);
    }
    function maxH() {
      return Math.min(YW_MAX_HEIGHT, window.innerHeight - 32);
    }

    function showTooltip(w, h) {
      if (!resizeTooltip) return;
      resizeTooltip.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      resizeTooltip.classList.remove("hidden");
    }
    function hideTooltip() {
      resizeTooltip?.classList.add("hidden");
    }

    resizeHandle.addEventListener("pointerdown", (e) => {
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
      startHeight = win.offsetHeight;
      resizeHandle.classList.add("yw-resizing");
      showTooltip(startWidth, startHeight);
      e.preventDefault();
      e.stopPropagation();
    });

    resizeHandle.addEventListener("pointermove", (e) => {
      if (!resizing || e.pointerId !== pointerId) return;
      const nextWidth = Math.min(maxW(), Math.max(YW_MIN_WIDTH, startWidth + (e.clientX - startX)));
      const nextHeight = Math.min(maxH(), Math.max(YW_MIN_HEIGHT, startHeight + (e.clientY - startY)));
      win.style.width = `${nextWidth}px`;
      win.style.height = `${nextHeight}px`;
      showTooltip(nextWidth, nextHeight);
    });

    function endResize(e) {
      if (!resizing || (e && e.pointerId !== pointerId)) return;
      resizing = false;
      resizeHandle.classList.remove("yw-resizing");
      hideTooltip();
      try {
        resizeHandle.releasePointerCapture(pointerId);
      } catch {
        /* non-fatal */
      }
      pointerId = null;
      persistState();
    }

    resizeHandle.addEventListener("pointerup", endResize);
    resizeHandle.addEventListener("pointercancel", endResize);
  })();

  // Keep the window on-screen if the browser itself is resized.
  window.addEventListener("resize", () => {
    if (!isActive || isMinimized) return;
    const capW = Math.min(YW_MAX_WIDTH, window.innerWidth - 32);
    const capH = Math.min(YW_MAX_HEIGHT, window.innerHeight - 32);
    if (win.offsetWidth > capW) win.style.width = `${Math.max(YW_MIN_WIDTH, capW)}px`;
    if (win.offsetHeight > capH) win.style.height = `${Math.max(YW_MIN_HEIGHT, capH)}px`;
    clampToViewport();
    if (settingsPanel && !settingsPanel.classList.contains("hidden")) positionSettingsPanel();
  });

  /* ----------------------------------------------------------------------
     PUBLIC SURFACE
  ---------------------------------------------------------------------- */
  window.YouTubeWindow = {
    open,
    close,
    hide,
    show,
    toggle,
    focusSearch,
    loadVideo,
    search,
    isOpen,
    skipAd,
    getApiUsage: () => YTApi.getUsageSnapshot(),
    // Exposed for script.js's CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM so
    // the transport bar's Previous/Play-Pause/Next actions (the same
    // handlers the transport bar's own buttons call) can be triggered
    // by a mapped key, not just a click.
    transport: {
      previous: handlePreviousClick,
      playPause: handlePlayPauseClick,
      next: handleNextClick,
    },
    // Playlist Part 1 — data/CRUD + playback-queue entry points for
    // later UI parts (and manual console testing) to build on. See
    // PLAYLIST FOUNDATION NOTES near the top of this file.
    playlists: {
      getAll: getAllPlaylists,
      get: getPlaylist,
      create: createPlaylist,
      rename: renamePlaylist,
      remove: deletePlaylist,
      addItem: addItemToPlaylist,
      removeItem: removeItemFromPlaylist,
      reorderItem: reorderPlaylistItem,
      // YouTube Playlist Import (Bridge) — see the block above stopPlaylist().
      importFromYoutube: importYoutubePlaylist,
      loadMoreFromYoutube,
    },
    playback: {
      getState: () => ({ ...playbackState }),
      getActivePlaylist,
      getCurrentItem: getCurrentQueueItem,
      buildQueue: buildPlaybackQueue,
      play: playPlaylistItem,
      start: startPlaylist,
      stop: stopPlaylist,
      next: playNextInQueue,
      previous: playPreviousInQueue,
      setRepeatMode,
      setShuffleEnabled,
      // Playlist Part 4A additions — see PLAYLIST PART 4A NOTES.
      reshuffle: reshuffleActivePlaylist,
      getShuffleHistory,
    },
    // Playlist Part 2A — UI entry points (mainly for manual console
    // testing; the header 🎵 button and in-window clicks are the normal
    // path). No new state — these just call the same render/CRUD
    // functions the UI itself uses.
    playlistUI: {
      openLibrary: openPlaylistLibrary,
      openDetail: openPlaylistDetail,
    },
  };

  /* ----------------------------------------------------------------------
     INIT — restore persisted position/size, and whether the window was
     open last session (its video is never auto-resumed/auto-played on
     load — only its position, size, and open/closed chrome are restored,
     the same restraint the Audio Window shows around autoplay).
  ---------------------------------------------------------------------- */
  (function initPersisted() {
    restoreState();
    reflectLoopUI();
    reflectLayoutModeUI();
    reflectStayOnTabUI();
    applyCompactMode();
    reflectCompactSettingsUI();
    applyTransportHideSetting();
    syncStayOnTabToExtension();
    reflectOpenExternalUI();
    reflectQuotaUI();
    reflectTabsUI();
    setView("empty");
    let savedActive = false;
    try {
      savedActive = localStorage.getItem(YW_ACTIVE_STORAGE) === "true";
    } catch {
      savedActive = false;
    }
    if (savedActive) {
      win.classList.remove("hidden");
      win.classList.add("yw-open");
      win.setAttribute("aria-hidden", "false");
      isActive = true;
      reflectToggleUI();
    }
  })();
})();
