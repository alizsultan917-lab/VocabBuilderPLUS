/* =========================================================================
   PERFORMANCE MONITOR
   =========================================================================
   Real, measured performance data for the app — not simulated numbers.

   Two halves:
   1. THE ENGINE (window.PerfMonitor) — a tiny, dependency-free timing
      utility. script.js calls PerfMonitor.time()/timeAsync() around a
      handful of real hotspots (the fish/bubble animation loop, dictionary
      + image lookups, the AI enhancement flow, local/disk/Drive saves,
      table rendering, PDF export) so every number shown below reflects
      actual work this session, not a guess. It also listens to the
      browser's own PerformanceObserver for long tasks and network
      requests, and samples requestAnimationFrame for FPS/frame timing.
   2. THE UI — wires up the 📊 header button added in index.html. A
      "simple" section (one health score + four plain numbers) that
      anyone can read at a glance, and a "Detailed Report" toggle that
      reveals a per-feature time breakdown plus frame/network/system
      stats. Live values only refresh once a second, and only while the
      panel is actually open, so watching your own performance doesn't
      become a performance cost of its own.
   ========================================================================= */

(function () {
  "use strict";

  // ----------------------------------------------------------------------
  // ENGINE
  // ----------------------------------------------------------------------
  const WINDOW_MS = 20000; // "share of time" stats look at the trailing 20s
  const MAX_SAMPLES_PER_CATEGORY = 4000; // hard cap so nothing grows unbounded

  const categories = new Map(); // name -> { samples: [{t, ms}] }
  const sessionStart = performance.now();

  function getCategory(name) {
    let c = categories.get(name);
    if (!c) {
      c = { samples: [] };
      categories.set(name, c);
    }
    return c;
  }

  function record(name, ms) {
    const c = getCategory(name);
    const now = performance.now();
    c.samples.push({ t: now, ms });
    if (c.samples.length > MAX_SAMPLES_PER_CATEGORY) {
      c.samples.splice(0, c.samples.length - MAX_SAMPLES_PER_CATEGORY);
    }
    const cutoff = now - WINDOW_MS;
    while (c.samples.length && c.samples[0].t < cutoff) c.samples.shift();
  }

  function time(name, fn) {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      record(name, performance.now() - t0);
    }
  }

  async function timeAsync(name, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      record(name, performance.now() - t0);
    }
  }

  // Per-feature breakdown for the Detailed Report: how many calls, average
  // cost, and share of all measured time in the trailing window.
  function snapshotCategories() {
    const now = performance.now();
    const cutoff = now - WINDOW_MS;
    let grandTotal = 0;
    const rows = [];
    categories.forEach((c, name) => {
      const inWindow = c.samples.filter((s) => s.t >= cutoff);
      if (inWindow.length === 0) return;
      const totalMs = inWindow.reduce((sum, s) => sum + s.ms, 0);
      grandTotal += totalMs;
      rows.push({ name, calls: inWindow.length, totalMs, avgMs: totalMs / inWindow.length });
    });
    rows.forEach((r) => (r.share = grandTotal > 0 ? r.totalMs / grandTotal : 0));
    rows.sort((a, b) => b.totalMs - a.totalMs);
    return { rows, grandTotal };
  }

  // ---- FPS / frame timing (always-on rAF counter; the loop itself is
  // essentially free — one push/shift per frame) ----
  let lastFrameT = null;
  let frameTimes = [];
  const FRAME_SAMPLE_MAX = 120;

  function frameLoop(t) {
    if (lastFrameT != null) {
      const dt = t - lastFrameT;
      if (dt > 0 && dt < 2000) {
        frameTimes.push(dt);
        if (frameTimes.length > FRAME_SAMPLE_MAX) frameTimes.shift();
      }
    }
    lastFrameT = t;
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  function currentFps() {
    if (frameTimes.length < 2) return null;
    const avgDt = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    return avgDt > 0 ? 1000 / avgDt : null;
  }

  function frameStats() {
    if (!frameTimes.length) return null;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    return {
      avg,
      min: Math.min(...frameTimes),
      max: Math.max(...frameTimes),
      samples: frameTimes.length,
    };
  }

  // ---- Long tasks (real main-thread blocking, via the browser's own
  // PerformanceObserver — not every browser supports this) ----
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  if ("PerformanceObserver" in window) {
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          longTaskCount += 1;
          longTaskTotalMs += entry.duration;
        });
      }).observe({ entryTypes: ["longtask"] });
    } catch (err) {
      /* longtask entry type not supported in this browser — skip silently */
    }
  }

  // ---- Network (resource timing, auto-classified by hostname) ----
  const networkStats = new Map(); // category -> {count, totalMs, totalBytes}
  function recordNetwork(cat, durationMs, bytes) {
    let n = networkStats.get(cat);
    if (!n) {
      n = { count: 0, totalMs: 0, totalBytes: 0 };
      networkStats.set(cat, n);
    }
    n.count += 1;
    n.totalMs += durationMs;
    n.totalBytes += bytes || 0;
  }
  function classifyResource(url) {
    if (url.includes("dictionaryapi.dev")) return "Dictionary Lookups";
    if (url.includes("api.openverse.org")) return "Image Search";
    if (url.includes("googleapis.com") || url.includes("accounts.google.com")) return "Folder / Drive Sync";
    if (url.includes("cdnjs.cloudflare.com")) return "App Assets";
    return null; // the AI server is user-configured (often localhost) —
    // that traffic is already captured by the "AI Enhancement" time wrap.
  }
  if ("PerformanceObserver" in window) {
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const cat = classifyResource(entry.name);
          if (cat) recordNetwork(cat, entry.duration, entry.transferSize || 0);
        });
      }).observe({ entryTypes: ["resource"] });
    } catch (err) {
      /* resource timing not supported — skip silently */
    }
  }

  // ---- Composite health score: simple enough for anyone to read ----
  function healthScore() {
    const fps = currentFps();
    const fpsScore = fps == null ? 100 : Math.max(0, Math.min(100, (fps / 60) * 100));

    const fstats = frameStats();
    const frameBudgetScore = fstats
      ? Math.max(0, 100 - Math.max(0, (fstats.avg - 16.7) / 16.7) * 100)
      : 100;

    let memScore = 100;
    if (performance.memory && performance.memory.jsHeapSizeLimit) {
      const ratio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
      memScore = Math.max(0, 100 - ratio * 140);
    }

    const longTaskPenalty = Math.min(30, longTaskCount * 3);

    const raw = fpsScore * 0.4 + frameBudgetScore * 0.3 + memScore * 0.2 + (100 - longTaskPenalty) * 0.1;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  function healthLabel(score) {
    if (score >= 90) return { label: "Excellent", tone: "great" };
    if (score >= 75) return { label: "Good", tone: "good" };
    if (score >= 55) return { label: "Fair", tone: "fair" };
    return { label: "Needs Attention", tone: "poor" };
  }

  function reset() {
    categories.clear();
    networkStats.clear();
    longTaskCount = 0;
    longTaskTotalMs = 0;
    frameTimes = [];
  }

  window.PerfMonitor = {
    time,
    timeAsync,
    record,
    reset,
    snapshotCategories,
    currentFps,
    frameStats,
    getLongTaskStats: () => ({ count: longTaskCount, totalMs: longTaskTotalMs }),
    getNetworkStats: () => networkStats,
    healthScore,
    healthLabel,
    sessionStart: () => sessionStart,
  };

  // ----------------------------------------------------------------------
  // UI
  // ----------------------------------------------------------------------
  const toggleBtn = document.getElementById("performance-toggle-btn");
  const panel = document.getElementById("performance-panel");
  if (!toggleBtn || !panel) return; // markup not present — nothing to wire up

  const scoreValueEl = document.getElementById("perf-score-value");
  const scoreRingEl = document.getElementById("perf-score-ring");
  const scoreLabelEl = document.getElementById("perf-score-label");
  const fpsValueEl = document.getElementById("perf-fps-value");
  const memValueEl = document.getElementById("perf-mem-value");
  const storageValueEl = document.getElementById("perf-storage-value");
  const uptimeValueEl = document.getElementById("perf-uptime-value");

  const detailToggleBtn = document.getElementById("perf-detail-toggle-btn");
  const detailBody = document.getElementById("perf-detail-body");
  const featureTbody = document.getElementById("perf-feature-tbody");
  const frameDetailEl = document.getElementById("perf-frame-detail");
  const networkDetailEl = document.getElementById("perf-network-detail");
  const systemDetailEl = document.getElementById("perf-system-detail");
  const resetBtn = document.getElementById("perf-reset-btn");

  let refreshTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function fmtMs(ms) {
    if (ms == null || Number.isNaN(ms)) return "—";
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  }
  function fmtBytes(b) {
    if (!b) return "0 KB";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }
  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m > 0 ? `${m}m ${rs}s` : `${rs}s`;
  }

  function renderSimple() {
    const score = PerfMonitor.healthScore();
    const { label, tone } = PerfMonitor.healthLabel(score);
    scoreValueEl.textContent = score;
    scoreLabelEl.textContent = label;
    scoreRingEl.dataset.tone = tone;
    scoreRingEl.style.setProperty("--perf-score-deg", `${(score / 100) * 360}deg`);

    const fps = PerfMonitor.currentFps();
    fpsValueEl.textContent = fps == null ? "—" : Math.round(fps);

    memValueEl.textContent = performance.memory
      ? fmtBytes(performance.memory.usedJSHeapSize)
      : "n/a";

    let storageBytes = 0;
    let entryCount = 0;
    try {
      storageBytes = (localStorage.getItem(typeof STORAGE_KEY !== "undefined" ? STORAGE_KEY : "litVocabEntries") || "").length;
    } catch (err) {
      /* localStorage unavailable — leave at 0 */
    }
    try {
      entryCount = typeof entries !== "undefined" ? entries.length : 0;
    } catch (err) {
      /* entries not defined yet — leave at 0 */
    }
    storageValueEl.textContent = `${entryCount} · ${fmtBytes(storageBytes)}`;

    uptimeValueEl.textContent = fmtUptime(performance.now() - PerfMonitor.sessionStart());
  }

  function renderDetail() {
    const { rows } = PerfMonitor.snapshotCategories();
    featureTbody.innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.name)}</td><td>${r.calls}</td><td>${fmtMs(r.avgMs)}</td><td>${Math.round(r.share * 100)}%</td></tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="perf-empty">Nothing measured in the last 20s — try adding a word, searching, or turning on the fish tank.</td></tr>`;

    const fstats = PerfMonitor.frameStats();
    const longTasks = PerfMonitor.getLongTaskStats();
    frameDetailEl.innerHTML = fstats
      ? `<p>Avg frame: ${fmtMs(fstats.avg)} (≈${Math.round(1000 / fstats.avg)} fps) · fastest ${fmtMs(fstats.min)} · slowest ${fmtMs(fstats.max)}, over the last ${fstats.samples} frames</p>
         <p>Long tasks (main-thread blocks over 50ms): ${longTasks.count}, totaling ${fmtMs(longTasks.totalMs)}</p>`
      : `<p>Collecting frame data…</p>`;

    const netStats = PerfMonitor.getNetworkStats();
    if (netStats.size === 0) {
      networkDetailEl.innerHTML = `<p>No network requests observed yet.</p>`;
    } else {
      let html = "";
      netStats.forEach((n, cat) => {
        html += `<p>${escapeHtml(cat)}: ${n.count} request${n.count === 1 ? "" : "s"}, ${fmtMs(n.totalMs)} total, ${fmtBytes(n.totalBytes)} transferred</p>`;
      });
      networkDetailEl.innerHTML = html;
    }

    let domCount = "—";
    try {
      domCount = document.getElementsByTagName("*").length;
    } catch (err) {
      /* ignore */
    }
    let fishCount = "—";
    try {
      fishCount = typeof fishEngine !== "undefined" ? fishEngine.state.fishes.length : "—";
    } catch (err) {
      /* fishEngine not ready yet */
    }
    systemDetailEl.innerHTML = `
      <p>DOM elements on page: ${domCount}</p>
      <p>Active fish/shark entities: ${fishCount}</p>
      <p>${
        performance.memory
          ? `JS heap in use: ${fmtBytes(performance.memory.usedJSHeapSize)} of ${fmtBytes(performance.memory.jsHeapSizeLimit)} available`
          : "JS heap size isn't exposed by this browser (Chrome/Edge only)."
      }</p>
    `;
  }

  function refreshAll() {
    renderSimple();
    if (!detailBody.classList.contains("hidden")) renderDetail();
  }

  function startRefresh() {
    refreshAll();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshAll, 1000);
  }
  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (wasHidden) startRefresh();
    else stopRefresh();
  });

  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("hidden") && !e.target.closest("#performance-widget")) {
      panel.classList.add("hidden");
      stopRefresh();
    }
  });

  detailToggleBtn.addEventListener("click", () => {
    const nowHidden = detailBody.classList.toggle("hidden");
    detailToggleBtn.textContent = nowHidden ? "Show Detailed Report ▾" : "Hide Detailed Report ▴";
    if (!nowHidden) renderDetail();
  });

  resetBtn.addEventListener("click", () => {
    PerfMonitor.reset();
    refreshAll();
  });
})();
