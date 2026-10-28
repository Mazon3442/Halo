// Colour grading. A look is a handful of sliders plus an optional LUT; every look is baked into
// one 3D LUT, which the player applies on the GPU and the export hands to ffmpeg's lut3d, so
// both run the same numbers.

import { api } from "./api.js";

/** The size of baked LUTs: 33 points a side, the common size for .cube files. */
const BAKE_SIZE = 33;

export const DEFAULT_LOOK = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  /** Split-toning, like Premiere and Lightroom's colour wheels: shadows and highlights each drift
      toward their own hue. The sliders never touch these; only looks set them. */
  shadowHue: 0,
  shadowSat: 0,
  highlightHue: 0,
  highlightSat: 0,
  /** Per-colour hue, saturation and luminance, like Lightroom's HSL panel: null, or an object of
      bands (`HSL_BANDS`) to { h: degrees, s: -1..1, l: -1..1 }. Only looks set it. */
  hsl: null,
  /** An imported LUT, { id, name }, from Halo's LUT library. */
  lut: null,
  lutAmount: 1,
};

export const LOOKS = [
  { id: "natural", name: "Natural", look: { contrast: 0.12, vibrance: 0.25, saturation: 0.04 } },
  { id: "warm", name: "Warm", look: { temperature: 0.35, tint: 0.05, vibrance: 0.1 } },
  { id: "cool", name: "Cool", look: { temperature: -0.35, contrast: 0.1 } },
  { id: "punchy", name: "Punchy", look: { contrast: 0.35, saturation: 0.18, highlights: -0.15, shadows: -0.05 } },
  { id: "golden", name: "Golden hour", look: { temperature: 0.5, tint: 0.08, highlights: -0.2, shadows: 0.15, saturation: 0.08, highlightHue: 40, highlightSat: 0.25, hsl: { orange: { s: 0.1 }, yellow: { h: -10, s: 0.15 }, green: { h: -25, s: -0.15 }, blue: { s: -0.25 } } } },
  { id: "faded", name: "Faded", look: { fade: 0.5, contrast: -0.15, saturation: -0.2 } },
  { id: "moody", name: "Moody", look: { exposure: -0.2, contrast: 0.25, temperature: -0.15, saturation: -0.25, shadows: -0.15, hsl: { orange: { s: -0.05 }, yellow: { s: -0.3 }, green: { h: 15, s: -0.4, l: -0.2 }, blue: { s: -0.3, l: -0.15 } } } },
  { id: "mono", name: "Black & white", look: { saturation: -1, contrast: 0.2 } },
  { id: "orangeblue", name: "Orange & Blue", look: { contrast: 0.22, vibrance: 0.12, saturation: 0.04, highlights: -0.12, shadows: -0.04, shadowHue: 195, shadowSat: 0.32, highlightHue: 30, highlightSat: 0.32, hsl: { red: { h: 8 }, orange: { s: 0.15 }, yellow: { h: -22, s: -0.1 }, green: { h: 55, s: -0.25 }, aqua: { h: 8, s: 0.2 }, blue: { h: -20, s: 0.1 }, purple: { h: -30, s: -0.3 }, magenta: { h: 40, s: -0.2 } } } },
  { id: "speakeasy", name: "Speakeasy", look: { exposure: -0.2, contrast: 0.28, temperature: 0.25, saturation: -0.1, highlights: -0.15, shadows: -0.12, fade: 0.1, shadowHue: 30, shadowSat: 0.25, highlightHue: 38, highlightSat: 0.4, hsl: { red: { h: 10, s: -0.1 }, orange: { s: 0.05 }, yellow: { h: -10 }, green: { h: -35, s: -0.45 }, aqua: { h: -20, s: -0.5 }, blue: { s: -0.6 }, purple: { s: -0.6 }, magenta: { s: -0.5 } } } },
  { id: "indoorvintage", name: "Indoor Vintage", look: { temperature: 0.2, tint: -0.02, contrast: 0.06, fade: 0.32, saturation: -0.15, highlights: -0.2, shadows: 0.05, shadowHue: 55, shadowSat: 0.16, highlightHue: 40, highlightSat: 0.3, hsl: { red: { s: -0.15 }, orange: { s: 0.05 }, green: { h: -20, s: -0.3 }, aqua: { s: -0.3 }, blue: { h: -15, s: -0.4 }, magenta: { s: -0.4 } } } },
  { id: "journey", name: "Journey", look: { contrast: 0.18, vibrance: 0.15, saturation: -0.08, temperature: 0.05, highlights: -0.18, shadows: 0.08, fade: 0.1, shadowHue: 190, shadowSat: 0.22, highlightHue: 38, highlightSat: 0.25, hsl: { orange: { s: 0.1, l: 0.05 }, yellow: { h: -12, s: -0.15 }, green: { h: 25, s: -0.25, l: -0.15 }, aqua: { s: 0.1 }, blue: { h: -15, s: 0.1, l: -0.1 } } } },
  { id: "sicily", name: "Sicily", look: { exposure: 0.08, temperature: 0.3, tint: 0.06, contrast: 0.12, saturation: 0.08, vibrance: 0.2, highlights: -0.15, shadows: 0.15, fade: 0.08, shadowHue: 25, shadowSat: 0.2, highlightHue: 42, highlightSat: 0.28, hsl: { red: { h: 6 }, orange: { s: 0.12, l: 0.05 }, yellow: { h: -8, s: 0.1 }, green: { h: -25, s: -0.15 }, aqua: { s: 0.15 }, blue: { h: -25, s: 0.2 } } } },
  { id: "noir", name: "Noir", look: { saturation: -1, contrast: 0.35, fade: 0.15, shadows: -0.1, exposure: -0.05 } },
  { id: "pastel", name: "Pastel", look: { contrast: -0.18, saturation: -0.15, fade: 0.35, highlights: -0.15, vibrance: 0.1 } },
  { id: "film", name: "Film", look: { contrast: 0.08, saturation: -0.1, fade: 0.18, temperature: -0.05, shadowHue: 210, shadowSat: 0.12, highlightHue: 45, highlightSat: 0.12, hsl: { orange: { s: 0.05 }, yellow: { h: -10, s: -0.15 }, green: { h: 20, s: -0.3 }, blue: { s: -0.2 } } } },
  { id: "teal", name: "Teal", look: { temperature: -0.3, tint: -0.05, saturation: 0.06, contrast: 0.1, shadowHue: 200, shadowSat: 0.22, hsl: { orange: { s: 0.1 }, yellow: { h: -15 }, green: { h: 40, s: -0.2 }, blue: { h: -25 } } } },
  { id: "ember", name: "Ember", look: { temperature: 0.4, saturation: 0.15, contrast: 0.18, highlights: -0.2, fade: 0.08, shadowHue: 25, shadowSat: 0.2 } },
  { id: "bloom", name: "Bloom", look: { exposure: 0.12, highlights: -0.2, contrast: -0.08, vibrance: 0.25, fade: 0.1, temperature: 0.05 } },
  { id: "bleach", name: "Bleach Bypass", look: { saturation: -0.75, contrast: 0.45, highlights: -0.12, shadows: -0.08, exposure: 0.05, fade: 0.06 } },
  { id: "blockbuster", name: "Blockbuster", look: { contrast: 0.28, saturation: 0.1, vibrance: 0.15, temperature: 0.08, highlights: -0.1, shadowHue: 205, shadowSat: 0.25, highlightHue: 30, highlightSat: 0.28, hsl: { red: { h: 12, s: -0.15 }, orange: { s: 0.05 }, green: { h: 50, s: -0.2 }, blue: { h: -20 } } } },
  { id: "moonrise", name: "Moonrise", look: { temperature: 0.3, tint: 0.04, saturation: 0.2, vibrance: 0.1, contrast: 0.14, highlights: -0.1, fade: 0.04, shadowHue: 40, shadowSat: 0.14, highlightHue: 35, highlightSat: 0.12 } },
  { id: "matrix", name: "Matrix", look: { temperature: -0.15, tint: -0.18, saturation: 0.04, contrast: 0.18, highlights: -0.08, fade: 0.06, shadowHue: 140, shadowSat: 0.2, highlightHue: 120, highlightSat: 0.08 } },
  { id: "her", name: "Her", look: { temperature: 0.22, tint: 0.16, saturation: -0.12, vibrance: 0.08, contrast: -0.04, fade: 0.2, highlights: -0.12, shadowHue: 25, shadowSat: 0.08, highlightHue: 330, highlightSat: 0.12 } },
  { id: "kodak", name: "Kodak", look: { temperature: 0.26, tint: 0.04, saturation: 0.12, vibrance: 0.1, contrast: 0.12, fade: 0.1, highlights: -0.08, shadowHue: 35, shadowSat: 0.12, highlightHue: 40, highlightSat: 0.14, hsl: { red: { s: 0.1 }, orange: { s: 0.1 }, yellow: { h: -8, s: 0.1 }, green: { h: -20, s: -0.1 }, blue: { h: -15 } } } },
  { id: "fuji", name: "Fuji", look: { temperature: -0.2, tint: -0.05, saturation: 0.06, vibrance: 0.08, contrast: 0.1, fade: 0.08, shadowHue: 210, shadowSat: 0.1, highlightHue: 45, highlightSat: 0.06, hsl: { red: { h: -5, s: -0.1 }, orange: { s: -0.05 }, green: { h: 15, s: 0.05 }, aqua: { s: 0.1 }, blue: { h: -10, s: 0.1 } } } },
  { id: "polaroid", name: "Polaroid", look: { temperature: 0.1, tint: 0.03, saturation: -0.16, contrast: -0.14, fade: 0.28, highlights: -0.12, vibrance: 0.06, shadowHue: 30, shadowSat: 0.06, highlightHue: 50, highlightSat: 0.15, hsl: { green: { h: -15, s: -0.25 }, aqua: { h: -20 }, blue: { h: -20, s: -0.2 } } } },
];

export function makeLook(partial = {}) {
  return { ...DEFAULT_LOOK, ...partial };
}

export function isNeutral(look) {
  return Object.keys(DEFAULT_LOOK).every((k) => k === "lutAmount" || (look[k] ?? DEFAULT_LOOK[k]) === DEFAULT_LOOK[k]);
}

/* ---------- the colour math ---------- */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (c) => Math.min(1, Math.max(0, c));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A fully saturated colour for a hue in degrees, in display values 0 to 1. */
function hueColor(h) {
  h = ((h % 360) + 360) % 360;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  return h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : h < 300 ? [x, 0, 1] : [1, 0, x];
}

/** Where each HSL band sits on the hue wheel, in degrees; colours between two bands blend them. */
export const HSL_BANDS = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 225, purple: 270, magenta: 315 };
const BAND_ORDER = Object.entries(HSL_BANDS);

/**
 * The HSL mixer: each colour takes the adjustments of the two bands either side of its hue,
 * blended by how close it is to each. Greys have no hue and are left alone.
 */
function mixHsl([r, g, b], hsl) {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 1e-5) return [r, g, b];
  let h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  h = ((h * 60) + 360) % 360;
  let i = BAND_ORDER.length - 1;
  while (i > 0 && BAND_ORDER[i][1] > h) i--;
  const [nameA, at] = BAND_ORDER[i];
  const [nameB, next] = BAND_ORDER[(i + 1) % BAND_ORDER.length];
  const span = (next - at + 360) % 360 || 360;
  const t = smooth(0, 1, ((h - at + 360) % 360) / span);
  const a = hsl[nameA] ?? {};
  const bb = hsl[nameB] ?? {};
  const mix = (k) => (a[k] ?? 0) * (1 - t) + (bb[k] ?? 0) * t;
  const [dh, ds, dl] = [mix("h"), mix("s"), mix("l")];
  // Rotate the colour's chroma around its own grey, so a hue shift keeps its brightness.
  const l = luma(r, g, b);
  const s = max > 0 ? chroma / max : 0;
  const shifted = hueColor(h + dh);
  const sl = luma(...shifted);
  const amount = chroma * Math.max(0, 1 + ds);
  // Luminance moves coloured pixels only, in proportion to how coloured they are.
  const lum = l * (1 + dl * 0.5 * s);
  return shifted.map((c) => lum + (c - sl) * amount);
}

/**
 * One colour through a look's sliders, on display values from 0 to 1. Exposure and white balance
 * work on light (linear values), the way a camera would; the rest on what the eye sees.
 */
function adjust([r, g, b], look) {
  // Exposure in stops, then white balance as gains: warmer lifts red and cuts blue, a magenta
  // tint cuts green.
  const gain = 2 ** look.exposure;
  const t = look.temperature * 0.32;
  r = toLinear(r) * gain * 2 ** t;
  g = toLinear(g) * gain * 2 ** (-look.tint * 0.25);
  b = toLinear(b) * gain * 2 ** -t;
  [r, g, b] = [r, g, b].map((c) => toGamma(clamp01(c)));

  // Highlights and shadows move the bright and dark parts of the picture.
  const l = luma(r, g, b);
  const lifted = l + look.highlights * 0.25 * smooth(0.45, 1, l) * (look.highlights < 0 ? l : 1 - l) * 2
    + look.shadows * 0.25 * (1 - smooth(0, 0.55, l)) * (look.shadows > 0 ? 1 - l : l) * 2;
  if (l > 1e-4) [r, g, b] = [r, g, b].map((c) => c * (lifted / l));
  else [r, g, b] = [lifted, lifted, lifted];

  // Contrast: an S-curve around the middle, or a flattening towards it.
  const k = look.contrast;
  [r, g, b] = [r, g, b].map((c0) => {
    const c = clamp01(c0);
    return k >= 0 ? c + (c * c * (3 - 2 * c) - c) * k * 1.2 : 0.5 + (c - 0.5) * (1 + k * 0.6);
  });

  // Saturation for every colour; vibrance mostly for the muted ones.
  const l2 = luma(r, g, b);
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const s = Math.max(0, (1 + look.saturation) * (1 + look.vibrance * (1 - sat) * 0.9));
  [r, g, b] = [r, g, b].map((c) => l2 + (c - l2) * s);

  if (look.hsl) [r, g, b] = mixHsl([r, g, b].map(clamp01), look.hsl);

  // Split-toning: shadows take on one hue, highlights another, weighted by how dark or bright
  // they are. Only the colour moves, not the brightness, so it tints rather than washes; the
  // tint fades out toward pure black and white so those stay clean.
  const ss = look.shadowSat ?? 0;
  const hs = look.highlightSat ?? 0;
  if (ss > 0 || hs > 0) {
    const l3 = clamp01(luma(r, g, b));
    const wSh = (1 - smooth(0.25, 0.7, l3)) * smooth(0, 0.12, l3) * ss * 0.6;
    const wHi = smooth(0.3, 0.75, l3) * (1 - smooth(0.9, 1, l3) * 0.6) * hs * 0.6;
    const st = hueColor(look.shadowHue ?? 0);
    const ht = hueColor(look.highlightHue ?? 0);
    const stl = luma(...st);
    const htl = luma(...ht);
    [r, g, b] = [0, 1, 2].map((i) => clamp01([r, g, b][i] + (st[i] - stl) * wSh + (ht[i] - htl) * wHi));
  }

  // Fade lifts the blacks and softens the whites, like old film.
  const f = look.fade * 0.16;
  return [r, g, b].map((c) => clamp01(f + clamp01(c) * (1 - f * 1.4)));
}

/** A LUT's colour for `rgb`, interpolated between its points. */
function sampleLut(lut, [r, g, b]) {
  const n = lut.size;
  const [lo, hi] = [lut.min, lut.max];
  const p = [r, g, b].map((c, i) => clamp01((c - lo[i]) / (hi[i] - lo[i])) * (n - 1));
  const i0 = p.map((v) => Math.min(n - 2, Math.floor(v)));
  const f = p.map((v, i) => v - i0[i]);
  const out = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const w = d.reduce((acc, on, i) => acc * (on ? f[i] : 1 - f[i]), 1);
    if (!w) continue;
    const at = ((i0[2] + d[2]) * n * n + (i0[1] + d[1]) * n + (i0[0] + d[0])) * 3;
    for (let c = 0; c < 3; c++) out[c] += lut.data[at + c] * w;
  }
  return out;
}

/** One colour through a whole look: the sliders, then the LUT at its intensity. */
export function gradeColor(rgb, look, lut) {
  let out = adjust(rgb, look);
  if (lut && look.lutAmount > 0) {
    const graded = sampleLut(lut, out);
    out = out.map((c, i) => clamp01(c + (graded[i] - c) * look.lutAmount));
  }
  return out;
}

/** A look as a LUT: `BAKE_SIZE`³ RGB triples, red changing fastest (the .cube order). */
export function bake(look, lut) {
  const n = BAKE_SIZE;
  const data = new Float32Array(n * n * n * 3);
  let k = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const out = gradeColor([r / (n - 1), g / (n - 1), b / (n - 1)], look, lut);
        data[k++] = out[0];
        data[k++] = out[1];
        data[k++] = out[2];
      }
    }
  }
  return { size: n, data };
}

export function toCube({ size, data }) {
  const rows = ["TITLE \"Halo grade\"", `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let i = 0; i < data.length; i += 3) rows.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return rows.join("\n") + "\n";
}

/* ---------- importing from other software ---------- */

/**
 * Reads a 3D .cube LUT, the format Premiere, Resolve, Final Cut, CapCut and Photoshop all export.
 * Throws with a readable message for anything else.
 */
export function parseCube(text) {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let title = "";
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "");
    else if (key === "LUT_3D_SIZE") size = Number(rest[0]);
    else if (key === "LUT_1D_SIZE") throw new Error("That's a 1D LUT, which only adjusts brightness curves. Halo uses 3D .cube LUTs.");
    else if (key === "DOMAIN_MIN") min = rest.map(Number);
    else if (key === "DOMAIN_MAX") max = rest.map(Number);
    else if (/^[-+.\d]/.test(key)) values.push(Number(key), Number(rest[0]), Number(rest[1]));
  }
  if (!(size >= 2 && size <= 256)) throw new Error("That file isn't a 3D .cube LUT.");
  if (values.length !== size ** 3 * 3 || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`That LUT should have ${size ** 3} colours but its data doesn't match.`);
  }
  if (min.length !== 3 || max.length !== 3 || max.some((v, i) => !(v > min[i]))) throw new Error("That LUT's DOMAIN lines don't make sense.");
  return { title, size, min, max, data: Float32Array.from(values) };
}

/**
 * Reads a Lightroom or Camera Raw preset (.xmp) into a look: exposure, contrast, highlights,
 * shadows, white balance, saturation, vibrance, split toning and the HSL panel. Curves, grain
 * and the rest have no equivalent in Halo and are skipped.
 */
export function parseXmp(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That preset file couldn't be read.");
  const values = {};
  for (const el of doc.getElementsByTagName("*")) {
    for (const attr of el.attributes) if (attr.name.startsWith("crs:")) values[attr.name.slice(4)] = attr.value;
    if (el.tagName.startsWith("crs:") && el.children.length === 0) values[el.tagName.slice(4)] = el.textContent.trim();
  }
  const num = (k) => (values[k] != null && Number.isFinite(Number(values[k])) ? Number(values[k]) : null);
  const pct = (k) => (num(k) == null ? undefined : Math.max(-1, Math.min(1, num(k) / 100)));
  const look = {
    exposure: num("Exposure2012") ?? num("Exposure") ?? undefined,
    contrast: pct("Contrast2012") ?? pct("Contrast"),
    highlights: pct("Highlights2012"),
    shadows: pct("Shadows2012"),
    saturation: pct("Saturation"),
    vibrance: pct("Vibrance"),
    temperature: pct("IncrementalTemperature")
      ?? (num("Temperature") != null ? Math.max(-1, Math.min(1, (num("Temperature") - 5500) / 3000)) : undefined),
    tint: pct("IncrementalTint") ?? (num("Tint") != null ? Math.max(-1, Math.min(1, num("Tint") / 100)) : undefined),
  };
  // Split toning (or the newer colour grading wheels, which store the same thing).
  for (const [part, key] of [["Shadow", "shadow"], ["Highlight", "highlight"]]) {
    const hue = num(`SplitToning${part}Hue`) ?? num(`ColorGrade${part}Hue`);
    const sat = num(`SplitToning${part}Saturation`) ?? num(`ColorGrade${part}Sat`);
    if (hue != null && sat) Object.assign(look, { [`${key}Hue`]: hue, [`${key}Sat`]: Math.min(1, sat / 100) });
  }
  // The HSL panel. Lightroom's hue slider at ±100 turns a colour about 30° toward its neighbour.
  const hsl = {};
  for (const band of Object.keys(HSL_BANDS)) {
    const name = band[0].toUpperCase() + band.slice(1);
    const h = num(`HueAdjustment${name}`);
    const s = pct(`SaturationAdjustment${name}`);
    const l = pct(`LuminanceAdjustment${name}`);
    if (h || s || l) hsl[band] = { h: (h ?? 0) * 0.3, s: s ?? 0, l: l ?? 0 };
  }
  if (Object.keys(hsl).length) look.hsl = hsl;
  for (const k of Object.keys(look)) if (look[k] === undefined) delete look[k];
  if (!Object.keys(look).length) throw new Error("That preset has no settings Halo can use.");
  if (look.exposure != null) look.exposure = Math.max(-3, Math.min(3, look.exposure));
  const nameEl = doc.getElementsByTagName("crs:Name")[0];
  const name = nameEl?.textContent.trim() || values.Name || fallbackName;
  return { name, look };
}

/* ---------- the LUT library ---------- */

const luts = new Map();

/** An imported LUT by id, parsed; fetched once from Halo's library. */
export function loadLut(id) {
  if (!luts.has(id)) {
    luts.set(id, api.raw(`/luts/${id}`).then((r) => r.text()).then(parseCube).catch((err) => { luts.delete(id); throw err; }));
  }
  return luts.get(id);
}

/** Saves a .cube file's text into the library and returns its id. */
export async function importLut(text) {
  const parsed = parseCube(text);
  const { id } = await api.postText("/luts", text);
  luts.set(id, Promise.resolve(parsed));
  return { id, parsed };
}

/** A look baked with its LUT loaded. */
export async function bakeLook(look) {
  const lut = look.lut ? await loadLut(look.lut.id) : null;
  return bake(look, lut);
}

/* ---------- sections ---------- */

/** The graded section at time t, if any. Sections never overlap. */
export function sectionAt(grade, t) {
  return grade?.sections?.find((s) => t >= s.start && t < s.end) ?? null;
}

/** How long a new graded section is when it isn't drawn out on the timeline. */
export const CHUNK_SECS = 5;

/**
 * Where a new section anchored at `t` goes, as [start, end], kept inside the free time around `t`.
 * With `to` it spans from `t` to there (either direction); without, it's `CHUNK_SECS` long from `t`,
 * slid back if the next section or the end of the video is closer. Null when `t` is in a section.
 */
export function freeSpan(grade, duration, t, to = null) {
  const sections = grade?.sections ?? [];
  if (sectionAt(grade, t)) return null;
  const lo = sections.filter((s) => s.end <= t).at(-1)?.end ?? 0;
  const hi = sections.find((s) => s.start > t)?.start ?? duration;
  if (to != null) return [Math.max(lo, Math.min(t, to)), Math.min(hi, Math.max(t, to))];
  const end = Math.min(hi, t + CHUNK_SECS);
  return [Math.max(lo, Math.min(t, end - CHUNK_SECS)), end];
}

/** What the export needs: each section with something to do, as a baked .cube. */
export async function bakeSections(grade) {
  const out = [];
  for (const s of grade?.sections ?? []) {
    if (isNeutral(s.look) || s.end <= s.start) continue;
    out.push({ start: s.start, end: s.end, cube: toCube(await bakeLook(s.look)) });
  }
  return out;
}

/* ---------- the player ---------- */

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D frame;
uniform sampler3D lut;
uniform float size;
in vec2 uv;
out vec4 color;
void main() {
  vec4 c = texture(frame, uv);
  // Sample at texel centres, so 0 and 1 land on the LUT's first and last points.
  vec3 at = clamp(c.rgb, 0.0, 1.0) * ((size - 1.0) / size) + 0.5 / size;
  color = vec4(texture(lut, at).rgb, c.a);
}`;

/**
 * Draws the video graded, on a canvas laid over it. Sections' baked LUTs are kept as 3D
 * textures, keyed by their look, so moving between sections costs nothing after the first time.
 */
export function createGradePlayer(canvas) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, "frame"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "lut"), 1);
  const sizeAt = gl.getUniformLocation(program, "size");

  const frame = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frame);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  /** look key -> { texture, size } once baked, or a promise while baking. */
  const textures = new Map();

  function lutTexture(look) {
    const key = JSON.stringify(look);
    if (textures.has(key)) return textures.get(key);
    const pending = bakeLook(look).then(({ size, data }) => {
      const rgba = new Float32Array(size ** 3 * 4);
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        rgba[j] = data[i];
        rgba[j + 1] = data[i + 1];
        rgba[j + 2] = data[i + 2];
        rgba[j + 3] = 1;
      }
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.LINEAR);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
      const ready = { texture, size };
      textures.set(key, ready);
      // Keep the most recent few; slider drags would otherwise pile up textures.
      while (textures.size > 12) {
        const [oldKey, old] = textures.entries().next().value;
        if (old.texture) gl.deleteTexture(old.texture);
        textures.delete(oldKey);
      }
      return ready;
    }).catch(() => { textures.delete(key); });
    textures.set(key, pending);
    return pending;
  }

  return {
    /**
     * Draws `source` (the video, or the processed still) through `look`. Returns false while the
     * look's LUT is still baking, so the caller can show the ungraded video meanwhile.
     */
    draw(source, look) {
      const lut = lutTexture(look);
      if (lut instanceof Promise) return false;
      const w = source.videoWidth || source.naturalWidth;
      const h = source.videoHeight || source.naturalHeight;
      if (!w || !h) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frame);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lut.texture);
      gl.uniform1f(sizeAt, lut.size);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    /** Starts baking a look ahead of time. */
    prepare(look) { lutTexture(look); },
  };
}

/** A small strip of everyday colours (skin, sky, foliage, shadows) through a look, for tiles. */
const SWATCH = ["#2b2420", "#8d5a43", "#d9a283", "#f2d6c0", "#4f7a3a", "#5c8fc4", "#c9d8e6", "#e8c547"];

export function paintSwatch(canvas, look, lut) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width / SWATCH.length;
  SWATCH.forEach((hex, i) => {
    const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
    const [r, g, b] = gradeColor(rgb, makeLook(look), lut).map((c) => Math.round(c * 255));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), canvas.height);
  });
}
