/* =========================================================================
   wallpaper-adaptive-text.js
   -------------------------------------------------------------------------
   wallpaper-tone-contrast.js answers "is the wallpaper, ON AVERAGE, light
   or dark" — one number for the whole photo. That's the right question
   for a few global things (the Audio Window, card borders), but it's the
   wrong tool for a busy photo like flowing water, where a light patch of
   foam can sit two inches from a dark patch of water and one average
   can't describe both.

   This module answers a narrower, more useful question per text element:
   "what's actually behind THIS specific label/word right now", and sets
   that element's own text color to whichever of dark-ink or light clears
   the best contrast against that exact patch. Same underlying idea as a
   subtitle renderer picking white-or-black captions frame by frame based
   on what's under them — just applied to fixed UI text over a fixed
   photo instead of a video.

   Load this AFTER wallpaper-tone-contrast.js and BEFORE script.js (see
   index.html) — it wraps window.WallpaperTone.applyWallpaperTone so it
   piggybacks on the same imageUrl argument script.js already passes in
   every time the wallpaper changes, with no edits to script.js needed.
   ========================================================================= */

(function () {
"use strict";

// Elements whose text color gets adapted. Kept to short, discrete text
// runs (not whole paragraphs/cards) — sampling a small rect behind a
// label is meaningful; sampling a huge rect behind a multi-line block
// would just wash back out to roughly the same average this module
// exists to avoid.
const TEXT_SELECTORS = [
  ".card h2",
  ".card label",
  ".link-btn",
  ".pron-text",
  "#vaw-pending-tag",
  ".definition-text",
  // .definition-text was briefly excluded here while wallpaper-
  // enhancements.css gave .definition-card a guaranteed-opaque
  // background and forced a fixed --ink color. That card is back to
  // thin glass (matching every other panel under a wallpaper), so the
  // background behind each definition is the real photo again and
  // needs the same per-element sampling every other label gets.
];

// Every Nth pixel when averaging a sampled rect — a label is small enough
// that even a coarse stride gives a stable average without reading every
// pixel.
const SAMPLE_STRIDE = 24; // in Uint8ClampedArray indices (6 px * 4 channels)

let wallpaperCanvas = null;
let wallpaperCtx = null;
let currentImageUrl = null;
let refreshHandle = null;

// ---- shared color math (same formulas as wallpaper-tone-contrast.js,
// re-implemented here so this file can be dropped in standalone) --------
function relativeLuminance(r, g, b) {
  const toLinear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(lumA, lumB) {
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

const INK_LUM = relativeLuminance(28, 43, 58);       // matches --ink
const LIGHT_LUM = relativeLuminance(245, 248, 251);  // matches --on-wallpaper-text

function bestTextColorFor(bgLuminance) {
  const inkRatio = contrastRatio(bgLuminance, INK_LUM);
  const lightRatio = contrastRatio(bgLuminance, LIGHT_LUM);
  return lightRatio > inkRatio ? "#f5f8fb" : "#1c2b3a";
}

// wallpaper-enhancements.css also carries a fallback text-shadow halo,
// but that one is keyed to data-wallpaper-tone — a single light/dark
// classification for the WHOLE photo. On a busy, high-variance photo
// (foam next to open water, specular highlights) individual elements
// routinely land on the opposite side of that classification from the
// page-wide average — exactly the case right where a text run sits on
// a bright splash inside an overall "light"-toned photo. When that
// happens the CSS halo ends up the same color as the text it's meant to
// outline, so it adds nothing, or actively flattens the text further into
// the background instead of separating it. Deriving the halo from the
// color THIS function just picked (rather than the global tone) keeps
// the two always paired correctly, element by element.
// Tight near-outline (four 1px-blur offsets + one small low-blur lift
// shadow) instead of a wide soft glow — matches the fallback halo in
// wallpaper-enhancements.css. A wide blur radius reads as haze around
// the letterforms on a detailed photo; keeping every component shadow
// short and low-blur keeps the glyph edges themselves crisp while still
// clearing contrast against whatever's directly behind them.
function haloForTextColor(hex) {
  return hex === "#f5f8fb"
    ? "0 1px 1px rgba(0, 0, 0, 0.85), 0 -1px 1px rgba(0, 0, 0, 0.85), 1px 0 1px rgba(0, 0, 0, 0.85), -1px 0 1px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.5)"
    : "0 1px 1px rgba(255, 255, 255, 0.9), 0 -1px 1px rgba(255, 255, 255, 0.9), 1px 0 1px rgba(255, 255, 255, 0.9), -1px 0 1px rgba(255, 255, 255, 0.9), 0 1px 3px rgba(255, 255, 255, 0.55)"
}

function readVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readPercentVar(name, fallback) {
  const v = readVar(name, null);
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n / 100 : fallback;
}

// Rebuilds a viewport-sized canvas that mirrors what body::before is
// actually showing: same image, same cover-fit + focal-point math CSS
// uses for background-position, and the same flat dimming scrim (which
// measurably lightens the photo, so skipping it would under-correct on a
// heavily-dimmed wallpaper). Vignette/grain/blur are cosmetic enough to
// leave out of the contrast estimate.
function buildCanvas(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) { resolve(null); return; }
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const vw = Math.max(1, window.innerWidth);
        const vh = Math.max(1, window.innerHeight);
        const canvas = document.createElement("canvas");
        canvas.width = vw;
        canvas.height = vh;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        const focalX = readPercentVar("--wallpaper-focal-x", 0.5);
        const focalY = readPercentVar("--wallpaper-focal-y", 0.5);

        const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        // Same distribution CSS background-position uses for a percentage
        // keyword: the overflow left/right and top/bottom is split
        // proportionally to the focal percentage rather than always
        // centered.
        const dx = (vw - dw) * focalX;
        const dy = (vh - dh) * focalY;
        ctx.drawImage(img, dx, dy, dw, dh);

        const dim = parseFloat(readVar("--wallpaper-dim", "0")) || 0;
        if (dim > 0) {
          ctx.fillStyle = `rgba(255, 255, 255, ${dim})`;
          ctx.fillRect(0, 0, vw, vh);
        }

        resolve(canvas);
      } catch {
        resolve(null); // e.g. a tainted canvas from a cross-origin image without CORS
      }
    };
    img.src = imageUrl;
  });
}

function sampleRectLuminance(rect) {
  if (!wallpaperCanvas || !wallpaperCtx) return null;
  const x = Math.max(0, Math.round(rect.left));
  const y = Math.max(0, Math.round(rect.top));
  const w = Math.max(1, Math.min(Math.round(rect.width), wallpaperCanvas.width - x));
  const h = Math.max(1, Math.min(Math.round(rect.height), wallpaperCanvas.height - y));
  if (w <= 0 || h <= 0 || x >= wallpaperCanvas.width || y >= wallpaperCanvas.height) return null;
  try {
    const { data } = wallpaperCtx.getImageData(x, y, w, h);
    let sum = 0, count = 0;
    for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
      sum += relativeLuminance(data[i], data[i + 1], data[i + 2]);
      count++;
    }
    return count ? sum / count : null;
  } catch {
    return null;
  }
}

function clearAdaptiveColors() {
  document.querySelectorAll(TEXT_SELECTORS.join(",")).forEach((el) => {
    el.style.removeProperty("color");
    el.style.removeProperty("text-shadow");
  });
}

function refresh() {
  if (!document.body.classList.contains("has-wallpaper") || !wallpaperCanvas) {
    clearAdaptiveColors();
    return;
  }
  document.querySelectorAll(TEXT_SELECTORS.join(",")).forEach((el) => {
    // offsetParent is null for display:none elements (and position:fixed
    // ones, which none of these are) — cheap visibility check before
    // paying for a layout read.
    if (el.offsetParent === null) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const lum = sampleRectLuminance(rect);
    if (lum == null) return; // leave the CSS fallback color+shadow in place
    const color = bestTextColorFor(lum);
    el.style.color = color;
    el.style.textShadow = haloForTextColor(color); // overrides the global-tone CSS shadow with one that actually matches this element's color
  });
}

function queueRefresh() {
  if (refreshHandle) return;
  refreshHandle = requestAnimationFrame(() => {
    refreshHandle = null;
    refresh();
  });
}

async function setWallpaper(imageUrl) {
  currentImageUrl = imageUrl || null;
  if (!currentImageUrl) {
    wallpaperCanvas = null;
    wallpaperCtx = null;
    clearAdaptiveColors();
    return;
  }
  wallpaperCanvas = await buildCanvas(currentImageUrl);
  wallpaperCtx = wallpaperCanvas ? wallpaperCanvas.getContext("2d", { willReadFrequently: true }) : null;
  refresh();
}

// ---- Hooks ---------------------------------------------------------------
// Piggyback on the existing applyWallpaperTone(url) call script.js already
// makes every time the wallpaper, dim, or blur changes — same url this
// module needs, so no edits to script.js are required.
if (window.WallpaperTone && typeof window.WallpaperTone.applyWallpaperTone === "function") {
  const originalApply = window.WallpaperTone.applyWallpaperTone;
  window.WallpaperTone.applyWallpaperTone = function (imageUrl) {
    const result = originalApply(imageUrl);
    setWallpaper(imageUrl);
    return result;
  };
}

// Viewport size changes shift the cover-fit math, so the canvas needs a
// full rebuild; a scroll just moves elements relative to the (fixed)
// wallpaper, so a cheap re-sample is enough.
let resizeHandle = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeHandle);
  resizeHandle = setTimeout(() => setWallpaper(currentImageUrl), 150);
});
window.addEventListener("scroll", queueRefresh, { passive: true });

// New definition/image rows, a newly-typed word, etc. all render
// asynchronously into the DOM — catch that generically instead of
// requiring script.js to call this module after every render function.
new MutationObserver(queueRefresh).observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

window.WallpaperAdaptiveText = { refresh, setWallpaper };

})();
