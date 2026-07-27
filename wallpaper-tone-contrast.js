/* =========================================================================
   wallpaper-tone-contrast.js
   -------------------------------------------------------------------------
   Complements — does NOT replace — the existing accent pipeline in
   script.js (sampleWallpaperAccentColor / adjustAccentForContrast /
   applySmartAccentColors). That logic answers "what hue should buttons
   be". This module answers a different question: "is this wallpaper, on
   average, light or dark", which is what page-level text color and card
   border visibility actually need — a vivid-but-dark photo and a
   pale-but-bright one can pick the same accent hue while needing opposite
   text treatment.

   relativeLuminance/contrastRatio are intentionally re-implemented here
   (rather than imported from script.js) so this file can be dropped in
   standalone. If you're merging into script.js directly, delete this
   file's copies and reuse the ones already there — same formulas.
   ========================================================================= */

(function () {
"use strict";

const TONE_SAMPLE_SIZE = 32;       // px — luminance only needs a coarse sample
const TONE_DARK_THRESHOLD = 0.4;   // relative luminance below this reads as "dark wallpaper"
const MIN_TEXT_CONTRAST = 4.5;     // WCAG AA, normal-size body text
const MIN_BORDER_CONTRAST = 1.5;   // borders need to stay visually distinct, not AA-legible

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

// Average relative luminance across the whole (downscaled) image —
// deliberately ignores hue/saturation; that's the accent sampler's job.
// Resolves null on decode failure so callers can fall back to "no
// wallpaper" styling.
function sampleWallpaperLuminance(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) { resolve(null); return; }
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const w = TONE_SAMPLE_SIZE;
        const h = Math.max(1, Math.round(w * (img.naturalHeight / img.naturalWidth || 1)));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let sum = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 32) continue; // skip near-transparent pixels
          sum += relativeLuminance(data[i], data[i + 1], data[i + 2]);
          count++;
        }
        resolve(count ? sum / count : null);
      } catch {
        resolve(null); // canvas can throw on an undecodable source in some browsers
      }
    };
    img.src = imageUrl;
  });
}

// Picks whichever of "ink" (the app's own --ink) or white text clears
// WCAG AA against a background of the given luminance — preferring --ink
// so wallpaper mode still reads as the same app rather than switching to
// generic black/white.
function pickReadableTextColor(bgLuminance, inkRgb = [28, 43, 58], whiteRgb = [255, 255, 255]) {
  const inkLum = relativeLuminance(...inkRgb);
  const whiteLum = relativeLuminance(...whiteRgb);
  const inkRatio = contrastRatio(bgLuminance, inkLum);
  const whiteRatio = contrastRatio(bgLuminance, whiteLum);
  if (inkRatio >= MIN_TEXT_CONTRAST && inkRatio >= whiteRatio) return { color: "ink", ratio: inkRatio };
  if (whiteRatio >= MIN_TEXT_CONTRAST) return { color: "white", ratio: whiteRatio };
  // Neither clears AA outright (mid-tone photo) — the dimming scrim
  // (--wallpaper-dim) is what's expected to carry the rest; just return
  // whichever is closer.
  return inkRatio > whiteRatio ? { color: "ink", ratio: inkRatio } : { color: "white", ratio: whiteRatio };
}

// Orchestrator: samples the wallpaper, classifies tone, and writes the
// result onto <html> as data-wallpaper-tone plus a couple of raw-number
// CSS vars — see wallpaper-enhancements.css for the rules that read them.
// Call this alongside (not instead of) applySmartAccent() in script.js,
// e.g. from applyWallpaperPrefs():
//
//   applyWallpaperPrefs();
//   applySmartAccent();
//   applyWallpaperTone(getWallpaperImage());   // <-- add this line
//
async function applyWallpaperTone(imageUrl) {
  const root = document.documentElement;
  if (!imageUrl) {
    delete root.dataset.wallpaperTone;
    root.style.removeProperty("--wallpaper-luminance");
    root.style.removeProperty("--wallpaper-border-alpha");
    return null;
  }
  const lum = await sampleWallpaperLuminance(imageUrl);
  if (lum == null) {
    delete root.dataset.wallpaperTone;
    root.style.removeProperty("--wallpaper-luminance");
    root.style.removeProperty("--wallpaper-border-alpha");
    return null;
  }
  const tone = lum < TONE_DARK_THRESHOLD ? "dark" : "light";
  root.dataset.wallpaperTone = tone;
  root.style.setProperty("--wallpaper-luminance", lum.toFixed(3));
  // Very light or very dark photos need a slightly stronger border than a
  // mid-gray photo does to stay visually distinct from the backdrop.
  const distanceFromMid = Math.abs(lum - 0.5) * 2; // 0 (mid-gray) .. 1 (near-black/near-white)
  const borderAlpha = Math.min(0.9, Math.max(0.35, MIN_BORDER_CONTRAST / 4 + distanceFromMid * 0.5));
  root.style.setProperty("--wallpaper-border-alpha", borderAlpha.toFixed(2));
  return { tone, luminance: lum, borderAlpha };
}

// ---- Public surface, attached to window (plain classic script) ---------
window.WallpaperTone = {
  sampleWallpaperLuminance,
  pickReadableTextColor,
  applyWallpaperTone,
};

})();
