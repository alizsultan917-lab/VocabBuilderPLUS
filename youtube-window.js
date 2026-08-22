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
       loadVideo, search, isOpen }

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

  const YW_MIN_WIDTH = 320;
  const YW_MIN_HEIGHT = 220;
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
  const titleEl = document.getElementById("yw-title");
  const playDotEl = document.getElementById("yw-play-dot");
  const loopBtn = document.getElementById("yw-loop-btn");
  const volumeSlider = document.getElementById("yw-volume-slider");
  const muteBtn = document.getElementById("yw-mute-btn");
  const openExternalBtn = document.getElementById("yw-open-external-btn");
  const settingsBtn = document.getElementById("yw-settings-btn");
  const settingsPanel = document.getElementById("yw-settings-panel");
  // Escape the youtube window's `overflow: hidden` (and its transform,
  // which would otherwise pin `position: fixed` right back to it too) by
  // parking the panel directly under <body>. positionSettingsPanel()
  // below then places it with real fixed coordinates every time it opens.
  if (settingsPanel && settingsPanel.parentElement !== document.body) {
    document.body.appendChild(settingsPanel);
  }
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
  const channelOldestBtn = document.getElementById("yw-channel-oldest-btn");
  const channelNewestBtn = document.getElementById("yw-channel-newest-btn");

  let isActive = false; // window is open (visible OR minimized-but-playing)
  let isMinimized = false; // hidden-but-playing
  let currentVideoId = null;
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
  let playerReady = false; // true once the current YT.Player has fired onReady
  let playerVolume = (() => {
    const v = loadJson(YW_VOLUME_STORAGE, 100);
    return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
  })();
  let playerMuted = loadJson(YW_MUTED_STORAGE, false) === true;

  // Part 4: which search mode the footer's tabs are on. Purely a UI/routing
  // flag — it never owns any results itself, so switching it back and forth
  // can't corrupt either `searchState` (videos) or `channelSearchState`.
  let activeSearchMode = "videos"; // "videos" | "channels"

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
    if (statusTimer) clearTimeout(statusTimer);
    if (autoHideMs) {
      statusTimer = setTimeout(() => statusEl.classList.add("hidden"), autoHideMs);
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
    } else if (event.data === window.YT.PlayerState.ENDED) {
      if (loopEnabled) {
        try {
          player.seekTo(0, true);
          player.playVideo();
        } catch {
          /* non-fatal */
        }
      } else {
        setPlayingIndicator(false);
      }
    } else if (event.data === window.YT.PlayerState.PAUSED) {
      setPlayingIndicator(false);
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
    if (view === "empty") updateEmptyStateText();
    reflectBackToResultsUI(view);
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

  function reflectOpenExternalUI() {
    if (!openExternalBtn) return;
    openExternalBtn.disabled = !currentVideoId;
    openExternalBtn.title = currentVideoId
      ? "Open on YouTube.com — for Like, Subscribe, Save, Download, and everything else only Google's own site can do"
      : "Load a video first";
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
    if (!currentVideoId) searchInput?.focus();
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
    destroyPlayer();
    if (resultsEl) resultsEl.innerHTML = "";
    if (channelDetailEl) channelDetailEl.innerHTML = "";
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
      setView("empty");
      reflectOpenExternalUI();
      showStatus("Playback needs the page served over http:// (not file://) — that's what Error 153 was.");
      if (searchInput) searchInput.value = "";
      return true;
    }

    currentVideoId = id;
    mountPlayer(id);
    setView("video");
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
    return `
      <button type="button" class="yw-result-item" data-video-id="${escapeHtml(row.id)}">
        <img class="yw-result-thumb" src="${escapeHtml(row.thumb)}" alt="" loading="lazy" draggable="false">
        <span class="yw-result-text">
          <span class="yw-result-title">${escapeHtml(row.title)}</span>
          <span class="yw-result-channel">${escapeHtml(row.channelTitle)}</span>
          <span class="yw-result-meta">${metaBits.join('<span class="yw-result-meta-dot">·</span>')}</span>
          ${desc ? `<span class="yw-result-desc">${escapeHtml(desc)}</span>` : ""}
        </span>
      </button>
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
        loadVideo(btn.dataset.videoId);
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
  }

  function search(query) {
    const q = (query || "").trim();
    if (!q) {
      // Empty-query state: don't silently no-op — say so, briefly.
      showStatus("Type something to search, or paste a video link.", 2500);
      searchInput?.focus();
      return false;
    }

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

  openExternalBtn?.addEventListener("click", () => {
    if (!currentVideoId) return;
    window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(currentVideoId)}`, "_blank", "noopener,noreferrer");
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
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".yw-drag-grip")) return;
      closeSettingsPanel();
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
      dragHandle.classList.add("yw-dragging");
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
      dragHandle.classList.remove("yw-dragging");
      persistState();
    });
  })();

  /* ----------------------------------------------------------------------
     RESIZE (bottom-right corner handle) — Pointer Events so mouse,
     trackpad, touch, and pen all work identically, same as the Map
     Window's resize handle. Sets width AND height directly, clamped to
     the 320×220 – 900×700 box from the spec.
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
    loadVideo,
    search,
    isOpen,
    getApiUsage: () => YTApi.getUsageSnapshot(),
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
