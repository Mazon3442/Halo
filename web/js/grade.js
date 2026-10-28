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
  /** An imported LUT, { id, name }, from Halo's LUT library. */
  lut: null,
  lutAmount: 1,
};

export const LOOKS = [
  { id: "natural", name: "Natural", look: { contrast: 0.12, vibrance: 0.25, saturation: 0.04 } },
  { id: "warm", name: "Warm", look: { temperature: 0.35, tint: 0.05, vibrance: 0.1 } },
  { id: "cool", name: "Cool", look: { temperature: -0.35, contrast: 0.1 } },
  { id: "punchy", name: "Punchy", look: { contrast: 0.35, saturation: 0.18, highlights: -0.15, shadows: -0.05 } },
  { id: "golden", name: "Golden hour", look: { temperature: 0.5, tint: 0.08, highlights: -0.2, shadows: 0.15, saturation: 0.08 } },
  { id: "faded", name: "Faded", look: { fade: 0.5, contrast: -0.15, saturation: -0.2 } },
  { id: "moody", name: "Moody", look: { exposure: -0.2, contrast: 0.25, temperature: -0.15, saturation: -0.25, shadows: -0.15 } },
  { id: "mono", name: "Black & white", look: { saturation: -1, contrast: 0.2 } },
];

export function makeLook(partial = {}) {
  return { ...DEFAULT_LOOK, ...partial };
}

export function isNeutral(look) {
  return Object.keys(DEFAULT_LOOK).every((k) => k === "lutAmount" || look[k] === DEFAULT_LOOK[k]);
}

/* ---------- the colour math ---------- */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (c) => Math.min(1, Math.max(0, c));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

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
 * Reads a Lightroom or Camera Raw preset (.xmp) into a look. Halo's sliders are simpler than
 * Lightroom's, so this brings over the basics: exposure, contrast, highlights, shadows, white
 * balance, saturation and vibrance.
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
