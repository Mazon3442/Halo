// Colour grading, done the way a colorist works in Resolve, and baked into one 3D LUT per look so the
// player (WebGL) and the export (ffmpeg's lut3d) run the same numbers:
//
//   1. Input transform. Log footage (Apple Log, S-Log3, V-Log, LogC3, Canon Log 3, D-Log) is decoded
//      from its log curve and camera gamut to scene light, like a colour space transform (CST).
//      Standard video is decoded from its display gamma.
//   2. Exposure and white balance on light. White balance is a chromatic adaptation (Bradford), as a
//      camera's is, rather than a colour cast laid over the picture.
//   3. Grading in a log working space (the ACEScct curve), where contrast pivots on mid grey and
//      shadows, midtones and highlights each have a colour wheel, weighted by brightness. Skin tones
//      can be held back from the wheels, the way a colorist keys them out.
//   4. Print film emulation: per-channel density curves, the slight differences between which give
//      film its colour crossover (cooler shadows and warmer highlights on Kodak, greener shadows on
//      Fuji), with a soft toe and shoulder, and the darker, denser saturated colours of a print.
//   5. Saturation and vibrance on light, the HSL mixer, then the output transform: a filmic tone map
//      for log footage, and for all footage, out-of-range colours pulled in along their own hue
//      rather than clipped channel by channel (which turns skin yellow and skies cyan).

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
  /** Colour wheels, like Resolve's and Lightroom's: null, or { shadows, midtones, highlights }, each
      { h: degrees, s: 0..1, l: -1..1 }. */
  wheels: null,
  /** How much skin tones are kept out of the wheels' colour, 0 to 1. */
  skinProtect: 0.5,
  /** A print film emulation (`FILM_STOCKS`) and how much of it. */
  film: "none",
  filmAmount: 1,
  /** Per-colour hue, saturation and luminance, like Lightroom's HSL panel: null, or an object of
      bands (`HSL_BANDS`) to { h: degrees, s: -1..1, l: -1..1 }. */
  hsl: null,
  /** Custom curves, like Resolve's and Lightroom's: null, or { master, red, green, blue }, each a
      list of [input, output] points from 0 to 1 including both ends. Master moves all three channels. */
  curves: null,
  /** An imported LUT, { id, name }, from Halo's LUT library. */
  lut: null,
  lutAmount: 1,
  /** How much of the whole grade shows, 0 to 1, like a node's key output gain in Resolve. */
  mix: 1,
};

export const CURVE_CHANNELS = ["master", "red", "green", "blue"];

export const WHEELS = ["shadows", "midtones", "highlights"];

/**
 * Film emulation. Each channel has its own density curve in the log working space: `slope` is its
 * contrast and `shift` its offset at mid grey. A channel with less contrast sits higher in the
 * shadows and lower in the highlights, so differences between channels tint the shadows and the
 * highlights in opposite directions, the way print stocks do. `black` is the print's black point,
 * `density` how much saturated colours darken, and `hsl` the stock's own colour response.
 */
export const FILM_STOCKS = [
  { id: "none", name: "None" },
  {
    id: "kodak2383", name: "Kodak 2383 print",
    slope: [1.14, 1.08, 1.0], shift: [0.002, -0.002, -0.007], black: 0.003, density: 0.16, sat: 0.02,
    hsl: { red: { s: 0.05 }, yellow: { h: -6 }, green: { h: 18, s: -0.2 }, aqua: { s: -0.05 }, blue: { h: -6, s: -0.05, l: -0.05 } },
  },
  {
    id: "kodak2393", name: "Kodak 2393 print",
    slope: [1.22, 1.15, 1.07], shift: [0.003, -0.002, -0.006], black: 0.002, density: 0.22, sat: 0.07,
    hsl: { red: { s: 0.08, l: -0.03 }, orange: { s: 0.04 }, green: { h: 15, s: -0.15 }, blue: { h: -8, l: -0.08 } },
  },
  {
    id: "fuji3513", name: "Fuji 3513 print",
    slope: [1.1, 1.04, 1.12], shift: [-0.004, 0.001, 0.003], black: 0.003, density: 0.12, sat: 0,
    hsl: { red: { h: -4, s: -0.06 }, green: { h: 8, s: -0.04 }, aqua: { s: 0.08 }, blue: { h: -4, s: 0.06 } },
  },
  {
    id: "vision3", name: "Kodak Vision3 negative",
    slope: [0.93, 0.91, 0.89], shift: [0.002, 0, -0.004], black: 0, density: 0.05, sat: -0.05,
    hsl: { orange: { s: 0.04 }, green: { h: 10, s: -0.12 } },
  },
  { id: "bleach", name: "Bleach bypass", slope: [1.32, 1.32, 1.3], shift: [0, 0, 0], black: 0.004, density: 0, sat: -0.6 },
  { id: "bw", name: "Black & white", slope: [1.2, 1.2, 1.2], shift: [0, 0, 0], black: 0.003, density: 0, mono: [0.36, 0.52, 0.12] },
  { id: "bwred", name: "Black & white, red filter", slope: [1.3, 1.3, 1.3], shift: [0, 0, 0], black: 0.004, density: 0, mono: [0.62, 0.32, 0.06] },
];

/** Built-in looks, each a recipe a colorist would recognise, made from the steps above. */
export const LOOKS = [
  { id: "clean", name: "Clean", look: { contrast: 0.12, vibrance: 0.2, saturation: 0.04, highlights: -0.1 } },
  { id: "kodak", name: "Kodak 2383", look: { film: "kodak2383", contrast: 0.06, vibrance: 0.05 } },
  { id: "fuji", name: "Fuji 3513", look: { film: "fuji3513", contrast: 0.04 } },
  {
    id: "orangeteal", name: "Teal & Orange", look: {
      film: "kodak2383", contrast: 0.14, vibrance: 0.1, highlights: -0.12, skinProtect: 0.85,
      wheels: { shadows: { h: 195, s: 0.42, l: -0.04 }, midtones: { h: 200, s: 0.08, l: 0 }, highlights: { h: 34, s: 0.22, l: 0 } },
      hsl: { orange: { s: 0.1 }, yellow: { h: -18, s: -0.15 }, green: { h: 55, s: -0.35 }, aqua: { s: 0.15 }, blue: { h: -15 } },
    },
  },
  {
    id: "golden", name: "Golden hour", look: {
      temperature: 0.28, film: "kodak2383", filmAmount: 0.7, highlights: -0.2, shadows: 0.1, vibrance: 0.1, skinProtect: 0.3,
      wheels: { shadows: { h: 25, s: 0.08, l: 0.02 }, midtones: { h: 32, s: 0.1, l: 0 }, highlights: { h: 42, s: 0.3, l: 0.03 } },
      hsl: { orange: { s: 0.08 }, yellow: { h: -10, s: 0.12 }, green: { h: -20, s: -0.2 }, blue: { s: -0.2 } },
    },
  },
  {
    id: "moody", name: "Moody", look: {
      exposure: -0.25, contrast: 0.2, saturation: -0.22, shadows: -0.1, film: "fuji3513", skinProtect: 0.7,
      wheels: { shadows: { h: 170, s: 0.28, l: -0.05 }, midtones: { h: 190, s: 0.06, l: 0 }, highlights: { h: 48, s: 0.12, l: 0 } },
      hsl: { yellow: { s: -0.3 }, green: { h: 20, s: -0.45, l: -0.15 }, blue: { s: -0.3, l: -0.1 } },
    },
  },
  {
    id: "portra", name: "Portra", look: {
      temperature: 0.1, contrast: -0.1, saturation: -0.08, vibrance: 0.1, fade: 0.15, film: "kodak2383", filmAmount: 0.45,
      wheels: { midtones: { h: 30, s: 0.06, l: 0.02 }, highlights: { h: 45, s: 0.1, l: 0 } },
      hsl: { orange: { s: -0.04, l: 0.06 }, green: { h: -15, s: -0.28 }, aqua: { s: -0.15 }, blue: { h: -10, s: -0.18, l: 0.05 } },
    },
  },
  {
    id: "kodachrome", name: "Kodachrome", look: {
      contrast: 0.2, saturation: 0.14, film: "kodak2393", filmAmount: 0.7, shadows: -0.06,
      wheels: { shadows: { h: 25, s: 0.1, l: -0.04 } },
      hsl: { red: { s: 0.15, l: -0.06 }, yellow: { h: -6, s: 0.08 }, green: { h: -10, s: -0.1, l: -0.08 }, blue: { s: 0.18, l: -0.15 } },
    },
  },
  {
    id: "cinestill", name: "Tungsten 800", look: {
      temperature: -0.32, tint: 0.04, film: "vision3", contrast: 0.08, highlights: -0.1, skinProtect: 0.4,
      wheels: { shadows: { h: 205, s: 0.15, l: 0 }, highlights: { h: 18, s: 0.14, l: 0 } },
      hsl: { red: { s: 0.1 }, orange: { h: -4, s: 0.08 }, green: { h: 25, s: -0.25 } },
    },
  },
  {
    id: "faded", name: "Faded film", look: {
      film: "vision3", fade: 0.45, contrast: -0.05, saturation: -0.12,
      wheels: { shadows: { h: 215, s: 0.14, l: 0.02 }, highlights: { h: 45, s: 0.1, l: 0 } },
      hsl: { green: { h: -15, s: -0.25 }, blue: { h: -10, s: -0.15 } },
    },
  },
  { id: "bleach", name: "Bleach bypass", look: { film: "bleach", contrast: 0.06, highlights: -0.1, exposure: 0.05 } },
  {
    id: "nordic", name: "Nordic", look: {
      temperature: -0.2, contrast: 0.06, saturation: -0.3, fade: 0.12, highlights: -0.08, film: "fuji3513", filmAmount: 0.6,
      wheels: { shadows: { h: 205, s: 0.12, l: 0.02 }, highlights: { h: 195, s: 0.06, l: 0 } },
      hsl: { orange: { s: 0.06 }, green: { h: 15, s: -0.3 }, blue: { s: -0.15, l: 0.05 } },
    },
  },
  {
    id: "matrix", name: "Matrix", look: {
      contrast: 0.2, saturation: -0.15, film: "fuji3513", skinProtect: 0.35,
      wheels: { shadows: { h: 150, s: 0.3, l: -0.04 }, midtones: { h: 115, s: 0.18, l: 0 }, highlights: { h: 90, s: 0.08, l: 0 } },
    },
  },
  {
    id: "night", name: "Day for night", look: {
      exposure: -1.3, temperature: -0.45, contrast: 0.18, saturation: -0.45, highlights: -0.2, skinProtect: 0.2,
      wheels: { shadows: { h: 220, s: 0.3, l: -0.05 }, midtones: { h: 215, s: 0.15, l: 0 }, highlights: { h: 205, s: 0.12, l: 0 } },
    },
  },
  { id: "noir", name: "Noir", look: { film: "bwred", contrast: 0.12, shadows: -0.08 } },
  { id: "silver", name: "Silver", look: { film: "bw", contrast: -0.04, fade: 0.12, highlights: -0.1 } },
];

/**
 * A complete look from part of one. Looks saved before the colour wheels kept split toning as
 * shadowHue/shadowSat and highlightHue/highlightSat; those become the shadow and highlight wheels.
 */
export function makeLook(partial = {}) {
  const { shadowHue, shadowSat, highlightHue, highlightSat, ...rest } = partial;
  const look = { ...DEFAULT_LOOK, ...rest };
  if ((shadowSat || highlightSat) && !rest.wheels) {
    look.wheels = {
      ...(shadowSat ? { shadows: { h: shadowHue ?? 0, s: Math.min(1, shadowSat * 0.8), l: 0 } } : {}),
      ...(highlightSat ? { highlights: { h: highlightHue ?? 0, s: Math.min(1, highlightSat * 0.8), l: 0 } } : {}),
    };
  }
  if (look.wheels && WHEELS.every((w) => !look.wheels[w]?.s && !look.wheels[w]?.l)) look.wheels = null;
  if (look.curves && CURVE_CHANNELS.every((c) => isStraight(look.curves[c]))) look.curves = null;
  return look;
}

/** True when a look leaves the picture as it is. */
export function isNeutral(look) {
  const l = makeLook(look);
  const ignore = ["lutAmount", "filmAmount", "skinProtect", "mix"];
  return Object.keys(DEFAULT_LOOK).every((k) => ignore.includes(k) || JSON.stringify(l[k]) === JSON.stringify(DEFAULT_LOOK[k]));
}

/* ---------- curves ---------- */

/** True for a curve that leaves its channel alone: none, or a straight line from black to white. */
export function isStraight(points) {
  return !points || (points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1);
}

/**
 * A curve through `points` as a function from 0..1 to 0..1: a monotone cubic (Fritsch–Carlson), so
 * it passes through every point without the overshoot a plain spline makes between close points.
 * Sampled into a table, since grading calls it for every colour of every LUT.
 */
export function curveFn(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, p[i + 1][0] - p[i][0]));
    m.push((p[i + 1][1] - p[i][1]) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  const at = (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (x > p[i + 1][0]) i++;
    const s = (x - p[i][0]) / dx[i];
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p[i][1] + (s3 - 2 * s2 + s) * dx[i] * t[i] + (-2 * s3 + 3 * s2) * p[i + 1][1] + (s3 - s2) * dx[i] * t[i + 1];
  };
  const N = 1024;
  const table = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) table[i] = Math.min(1, Math.max(0, at(i / N)));
  return (x) => {
    const f = Math.min(1, Math.max(0, x)) * N;
    const i = Math.min(N - 1, Math.floor(f));
    return table[i] + (table[i + 1] - table[i]) * (f - i);
  };
}

/* ---------- colour science ---------- */

const clamp01 = (c) => Math.min(1, Math.max(0, c));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const mul3 = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const matmul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
function inverse(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const D65 = [0.3127, 0.329];

/** RGB to XYZ for a set of primaries, from their chromaticities and white point. */
function rgbToXYZ(primaries, white = D65) {
  const cols = primaries.map(xyToXYZ);
  const m = [0, 1, 2].map((i) => cols.map((c) => c[i]));
  const s = mul3(inverse(m), xyToXYZ(white));
  return m.map((row) => row.map((v, j) => v * s[j]));
}

const REC709 = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
const REC709_TO_XYZ = rgbToXYZ(REC709);
const XYZ_TO_REC709 = inverse(REC709_TO_XYZ);
/** A camera gamut to Rec.709, both on D65. */
const gamutTo709 = (primaries) => matmul(XYZ_TO_REC709, rgbToXYZ(primaries));

/** Camera log curves, from code value (full range, 0 to 1) to scene light, where 0.18 is mid grey. */
const LOG_CURVES = {
  slog3: (v) => (v >= 171.2102946929 / 1023 ? 10 ** ((v * 1023 - 420) / 261.5) * 0.19 - 0.01 : ((v * 1023 - 95) * 0.01125) / (171.2102946929 - 95)),
  vlog: (v) => (v < 0.181 ? (v - 0.125) / 5.6 : 10 ** ((v - 0.598206) / 0.241514) - 0.00873),
  logc3: (v) => (v > 0.149658 ? (10 ** ((v - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (v - 0.092809) / 5.367655),
  clog3: (v) => 0.9 * (v < 0.097465473
    ? -(10 ** ((0.12783901 - v) / 0.36726845) - 1) / 14.98325
    : v <= 0.15277891 ? (v - 0.12512219) / 1.9754798 : (10 ** ((v - 0.12240537) / 0.36726845) - 1) / 14.98325),
  dlog: (v) => (v <= 0.14 ? (v - 0.0929) / 6.025 : (10 ** (3.89616 * v - 2.27752) - 0.0108) / 0.9892),
  applelog: (v) => (v >= 0.20851 ? 2 ** ((v - 0.69336945) / 0.08550479) - 0.00964052 : v >= 0 ? Math.sqrt(v / 47.28711236) - 0.05641088 : -0.05641088),
};

/**
 * What the footage was shot in. Log footage looks flat and grey until it's transformed; picking
 * the camera's profile does that before any grading, like a CST node in Resolve.
 */
export const SOURCES = [
  { id: "rec709", name: "Standard video (Rec.709)" },
  { id: "applelog", name: "Apple Log (iPhone)", curve: "applelog", gamut: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]] },
  { id: "slog3", name: "Sony S-Log3 · S-Gamut3.Cine", curve: "slog3", gamut: [[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]] },
  { id: "vlog", name: "Panasonic V-Log · V-Gamut", curve: "vlog", gamut: [[0.73, 0.28], [0.165, 0.84], [0.1, -0.03]] },
  { id: "logc3", name: "ARRI LogC3 · Wide Gamut 3", curve: "logc3", gamut: [[0.684, 0.313], [0.221, 0.848], [0.0861, -0.102]] },
  { id: "clog3", name: "Canon Log 3 · Cinema Gamut", curve: "clog3", gamut: [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]] },
  { id: "dlog", name: "DJI D-Log · D-Gamut", curve: "dlog", gamut: [[0.71, 0.31], [0.21, 0.88], [0.09, -0.08]] },
];

/** The ACEScct curve: the log working space grading happens in. Mid grey sits at 0.4136. */
const toLog = (l) => (l <= 0.0078125 ? 10.5402377416545 * l + 0.0729055341958355 : (Math.log2(l) + 9.72) / 17.52);
const fromLog = (x) => (x <= 0.155251141552511 ? (x - 0.0729055341958355) / 10.5402377416545 : 2 ** (x * 17.52 - 9.72));
const PIVOT = toLog(0.18);

/** A colour temperature's white on the Planckian locus (Kim et al.'s fit, 1667 K to 25000 K). */
function planckXy(T) {
  const t = Math.min(25000, Math.max(1667, T));
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t <= 2222
    ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000
      ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = inverse(BRADFORD);

/**
 * White balance as a camera does it: the picture is adapted as if its white had been a different
 * colour temperature (warmer means correcting for a bluer light) and tint (green or magenta).
 */
function whiteBalance(temperature, tint) {
  if (!temperature && !tint) return null;
  const ref = planckXy(6504);
  const src = planckXy(6504 * 2 ** (temperature * 0.9));
  src[1] += tint * 0.02;
  const from = mul3(BRADFORD, xyToXYZ(src));
  const to = mul3(BRADFORD, xyToXYZ(ref));
  const scale = [[to[0] / from[0], 0, 0], [0, to[1] / from[1], 0], [0, 0, to[2] / from[2]]];
  const adapt = matmul(BRADFORD_INV, matmul(scale, BRADFORD));
  return matmul(XYZ_TO_REC709, matmul(adapt, REC709_TO_XYZ));
}

/** A fully saturated colour for a hue in degrees, in display values 0 to 1. */
function hueColor(h) {
  h = ((h % 360) + 360) % 360;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  return h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : h < 300 ? [x, 0, 1] : [1, 0, x];
}

/** The direction a wheel pushes colour in, with no change in brightness. */
function wheelVector(h) {
  const c = hueColor(h);
  const l = luma(...c);
  return c.map((v) => v - l);
}

function hueOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 1e-6) return { h: 0, s: 0, v: max };
  let h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return { h: ((h * 60) + 360) % 360, s: max > 0 ? chroma / max : 0, v: max };
}

/** How much a colour looks like skin: orange hues of moderate saturation, any brightness but black. */
function skinWeight(rgb) {
  const { h, s, v } = hueOf(rgb.map((c) => toGamma(clamp01(c))));
  const d = Math.min(Math.abs(h - 25), 360 - Math.abs(h - 25));
  return Math.exp(-((d / 20) ** 2)) * smooth(0.08, 0.2, s) * (1 - smooth(0.7, 0.9, s)) * smooth(0.04, 0.15, v);
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

/** Two HSL settings added together, the second scaled by `k`. */
function addHsl(a, b, k) {
  if (!b || !k) return a;
  const out = structuredClone(a ?? {});
  for (const [band, v] of Object.entries(b)) {
    const o = (out[band] ??= {});
    for (const key of ["h", "s", "l"]) if (v[key]) o[key] = (o[key] ?? 0) + v[key] * k;
  }
  return out;
}

/**
 * Pulls a colour that's out of range back in along its own hue, toward its grey, instead of
 * clipping each channel on its own.
 */
function fitGamut(c) {
  const Y = luma(...c);
  if (Y >= 1) return [1, 1, 1];
  if (Y <= 0) return [0, 0, 0];
  let t = 1;
  for (const v of c) {
    if (v > 1) t = Math.min(t, (1 - Y) / (v - Y));
    else if (v < 0) t = Math.min(t, Y / (Y - v));
  }
  return t < 1 ? c.map((v) => Y + (v - Y) * t) : c;
}

/** A filmic tone map (Narkowicz's fit of the ACES curve) from scene light to the display, for log footage. */
const toneMap = (x) => {
  const v = Math.max(0, x) * 0.7;
  return (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
};

/** Shadows, midtones and highlights masks over log brightness, for the wheels and tone sliders. */
function tonalMasks(L) {
  const shadows = 1 - smooth(0.16, 0.42, L);
  const highlights = smooth(0.38, 0.58, L);
  const midtones = smooth(0.12, 0.34, L) * (1 - smooth(0.45, 0.62, L));
  return { shadows, midtones, highlights };
}

/** The grading function for a look and source, with everything that doesn't depend on the colour worked out once. */
function prepare(look, source = "rec709") {
  const l = makeLook(look);
  const src = SOURCES.find((s) => s.id === source) ?? SOURCES[0];
  const decode = src.curve ? LOG_CURVES[src.curve] : null;
  const gamut = src.gamut ? gamutTo709(src.gamut) : null;
  const wb = whiteBalance(l.temperature, l.tint);
  const gain = 2 ** l.exposure;
  const contrast = 2 ** (l.contrast * 0.85);
  const stock = FILM_STOCKS.find((s) => s.id === l.film && s.slope) ?? null;
  const filmAmount = stock ? clamp01(l.filmAmount) : 0;
  const wheels = l.wheels
    ? WHEELS.map((w) => l.wheels[w] && (l.wheels[w].s || l.wheels[w].l) ? { name: w, v: wheelVector(l.wheels[w].h), s: l.wheels[w].s, l: l.wheels[w].l } : null).filter(Boolean)
    : [];
  const hsl = addHsl(l.hsl, stock?.hsl, filmAmount);
  const hasHsl = Object.keys(hsl ?? {}).length > 0;
  const satBase = (1 + l.saturation) * (1 + (stock?.sat ?? 0) * filmAmount);
  const density = (stock?.density ?? 0) * filmAmount;
  const black = (stock?.black ?? 0) * filmAmount;
  const fade = l.fade * 0.14;
  const A = 0.36; // how soft the film curve's toe and shoulder are, in log units
  const T0 = 0.002; // below this much light, crushed blacks roll off instead of clipping
  const shapesTone = contrast !== 1 || l.shadows || l.highlights || l.wheels || stock;
  const curve = (c) => (l.curves && !isStraight(l.curves[c]) ? curveFn(l.curves[c]) : null);
  const curves = l.curves ? { master: curve("master"), rgb: ["red", "green", "blue"].map(curve) } : null;

  return (rgb) => {
    // 1. Input transform, to light in Rec.709 primaries.
    let c;
    if (decode) {
      // Log is recorded in video range; the browser and ffmpeg hand it over stretched to full range.
      c = rgb.map((v) => decode((64 + 876 * v) / 1023));
      c = mul3(gamut, c);
    } else {
      c = rgb.map(toLinear);
    }
    // 2. Exposure and white balance, on light.
    if (wb) c = mul3(wb, c);
    c = c.map((v) => v * gain);
    // How skin-like the colour is, judged once before grading, for the wheels and vibrance.
    const skinness = (wheels.length && l.skinProtect > 0) || l.vibrance ? skinWeight(c) : 0;
    const skin = wheels.length ? skinness * l.skinProtect : 0;

    // 3. Grading in log: contrast around mid grey, tone, then the wheels.
    let x = c.map(toLog);
    if (contrast !== 1) x = x.map((v) => PIVOT + (v - PIVOT) * contrast);
    const m = tonalMasks(luma(...x));
    const tone = l.shadows * 0.1 * m.shadows + l.highlights * 0.07 * m.highlights;
    if (tone) x = x.map((v) => v + tone);
    for (const w of wheels) {
      const k = m[w.name];
      const hold = 1 - skin;
      x = x.map((v, i) => v + k * (w.v[i] * w.s * 0.075 * hold + w.l * 0.08));
    }

    // 4. Print film emulation.
    if (stock) {
      x = x.map((v, i) => {
        const filmed = PIVOT + stock.shift[i] + A * Math.tanh(((v - PIVOT) * stock.slope[i]) / A);
        return v + (filmed - v) * filmAmount;
      });
    }
    c = x.map(fromLog);
    if (shapesTone) c = c.map((v) => (v < T0 ? T0 * Math.exp((v - T0) / T0) : v));
    if (black) c = c.map((v) => Math.max(0, (v - black) / (1 - black)));

    // 5. Saturation and vibrance on light. Vibrance lifts the muted colours and leaves skin be.
    if (stock?.mono) {
      const bw = stock.mono[0] * c[0] + stock.mono[1] * c[1] + stock.mono[2] * c[2];
      c = c.map((v) => v + (bw - v) * filmAmount);
    }
    const Y = luma(...c);
    const max = Math.max(...c);
    const chroma = max > 1e-6 ? (max - Math.min(...c)) / max : 0;
    const vib = 1 + l.vibrance * (1 - chroma) * (1 - 0.7 * skinness);
    const s = Math.max(0, satBase * vib);
    if (s !== 1) c = c.map((v) => Y + (v - Y) * s);
    // Film's saturated colours are denser, so they darken a little rather than glow.
    if (density) c = c.map((v) => v * (1 - density * chroma * 0.4));

    // Output transform.
    if (decode) c = c.map(toneMap);
    c = fitGamut(c).map((v) => toGamma(clamp01(v)));
    if (hasHsl) c = mixHsl(c, hsl).map(clamp01);
    // Custom curves, on the picture as it's shown: master on every channel, then each channel's own.
    if (curves) {
      if (curves.master) c = c.map(curves.master);
      c = c.map((v, i) => (curves.rgb[i] ? curves.rgb[i](v) : v));
    }
    // Fade: a matte black, lifted most at black and hardly at all in the highlights.
    if (fade) c = c.map((v) => (v + fade * (1 - v) ** 2.5) * (1 - fade * 0.2));
    return c.map(clamp01);
  };
}

/** Grading functions by look (as given), then source, so scopes grading every pixel don't redo the setup. */
const prepared = new WeakMap();
function gradeFn(look, source) {
  let bySource = prepared.get(look);
  if (!bySource) prepared.set(look, (bySource = new Map()));
  if (!bySource.has(source)) bySource.set(source, prepare(look, source));
  return bySource.get(source);
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

/** One colour through a whole look: the grade, then the LUT at its intensity. */
export function gradeColor(rgb, look, lut, source = "rec709") {
  let out = gradeFn(look, source)(rgb);
  if (lut && look.lutAmount > 0) {
    const graded = sampleLut(lut, out);
    out = out.map((c, i) => clamp01(c + (graded[i] - c) * look.lutAmount));
  }
  return mixBack(out, rgb, look, source);
}

/** The ungraded picture: log footage transformed to normal contrast and colour, standard footage as it is. */
const UNGRADED = {};
function ungraded(rgb, source) {
  return source === "rec709" ? rgb : gradeFn(UNGRADED, source)(rgb);
}

/** Blends a graded colour back toward the ungraded one by the look's mix. */
function mixBack(out, rgb, look, source) {
  const mix = look.mix ?? 1;
  if (mix >= 1) return out;
  const base = ungraded(rgb, source);
  return out.map((c, i) => base[i] + (c - base[i]) * Math.max(0, mix));
}

/**
 * The temperature and tint that turn `rgb`, a colour straight from the footage, neutral grey
 * through the rest of `look`, for the white balance picker. Solved numerically (Gauss–Newton on
 * the blue–yellow and green–magenta balance), so it holds whatever else the look does.
 */
export function neutralBalance(rgb, look, source = "rec709") {
  const base = makeLook({ ...look, lut: null, mix: 1 });
  const error = (t, n) => {
    const [r, g, b] = prepare({ ...base, temperature: t, tint: n }, source)(rgb).map((v) => Math.max(1e-4, v));
    return [Math.log(b / r), Math.log(g / Math.sqrt(r * b))];
  };
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  let t = base.temperature;
  let n = base.tint;
  for (let i = 0; i < 10; i++) {
    const e = error(t, n);
    if (Math.hypot(e[0], e[1]) < 1e-4) break;
    const h = 1e-3;
    const et = error(t + h, n);
    const en = error(t, n + h);
    const j = [[(et[0] - e[0]) / h, (en[0] - e[0]) / h], [(et[1] - e[1]) / h, (en[1] - e[1]) / h]];
    const det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    if (Math.abs(det) < 1e-9) break;
    t = clamp(t - (j[1][1] * e[0] - j[0][1] * e[1]) / det);
    n = clamp(n - (-j[1][0] * e[0] + j[0][0] * e[1]) / det);
  }
  return { temperature: Math.round(t * 100) / 100, tint: Math.round(n * 100) / 100 };
}

/** A look as a LUT: `BAKE_SIZE`³ RGB triples, red changing fastest (the .cube order). */
export function bake(look, lut, source = "rec709") {
  const n = BAKE_SIZE;
  const data = new Float32Array(n * n * n * 3);
  const fn = prepare(look, source);
  const amount = lut ? look.lutAmount ?? 1 : 0;
  let k = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const rgb = [r / (n - 1), g / (n - 1), b / (n - 1)];
        let out = fn(rgb);
        if (amount > 0) {
          const graded = sampleLut(lut, out);
          out = out.map((c, i) => clamp01(c + (graded[i] - c) * amount));
        }
        out = mixBack(out, rgb, look, source);
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
export async function bakeLook(look, source = "rec709") {
  const lut = look.lut ? await loadLut(look.lut.id) : null;
  return bake(look, lut, source);
}

/** True when the footage needs transforming even where nothing is graded: it was shot in log. */
export function needsTransform(grade) {
  return !!grade?.source && grade.source !== "rec709";
}

/* ---------- sections ---------- */

/** The graded section at time t, if any. Sections never overlap. */
export function sectionAt(grade, t) {
  return grade?.sections?.find((s) => t >= s.start && t < s.end) ?? null;
}

/** The look a section shows: its own, or none while it's bypassed (switched off, as Ctrl+D does in Resolve). */
export function activeLook(section) {
  return section && !section.bypass ? section.look : null;
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

/**
 * What the export needs: each section with something to do, as a baked .cube. Log footage is
 * transformed everywhere, so the stretches between sections get the transform on its own.
 */
export async function bakeSections(grade, duration = 0) {
  const source = grade?.source ?? "rec709";
  const log = needsTransform(grade);
  const spans = [];
  let at = 0;
  for (const s of grade?.sections ?? []) {
    if (s.end <= s.start) continue;
    const look = activeLook(s) ?? makeLook();
    if (log && s.start > at) spans.push({ start: at, end: s.start, look: makeLook() });
    if (log || !isNeutral(look)) spans.push({ start: s.start, end: s.end, look });
    at = Math.max(at, s.end);
  }
  if (log && (duration || Infinity) > at) spans.push({ start: at, end: duration || 1e9, look: makeLook() });
  const out = [];
  for (const s of spans) out.push({ start: s.start, end: s.end, cube: toCube(await bakeLook(s.look, source)) });
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

  function lutTexture(look, source) {
    const key = `${source}|${JSON.stringify(look)}`;
    if (textures.has(key)) return textures.get(key);
    const pending = bakeLook(look, source).then(({ size, data }) => {
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
    draw(source, look, colorSource = "rec709") {
      const lut = lutTexture(look, colorSource);
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
    prepare(look, colorSource = "rec709") { lutTexture(look, colorSource); },
  };
}

/** A small strip of everyday colours (skin, sky, foliage, shadows) through a look, for tiles. */
const SWATCH = ["#2b2420", "#8d5a43", "#d9a283", "#f2d6c0", "#4f7a3a", "#5c8fc4", "#c9d8e6", "#e8c547"];

/**
 * Paints a look's tile from a small copy of the video frame, so looks are judged on the footage
 * itself, as in Resolve's gallery. Falls back to the swatch of everyday colours with no frame.
 */
export function paintFrame(canvas, frame, look, lut, source) {
  if (!frame) return paintSwatch(canvas, look, lut);
  const ctx = canvas.getContext("2d");
  const img = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
  const full = makeLook(look);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const out = gradeColor([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255], full, lut, source);
    d[i] = out[0] * 255;
    d[i + 1] = out[1] * 255;
    d[i + 2] = out[2] * 255;
  }
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  ctx.putImageData(img, 0, 0);
}

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
