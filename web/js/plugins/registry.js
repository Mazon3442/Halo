// Plugins: self-contained modules that add to what captions can do. A caption animation plugin
// describes its settings (the inspector draws them) and says where a caption is on any frame of
// its in, hold and out phases; motion.js turns that into libass tags, so the live preview and the
// export animate identically. Halo ships Easy Motion; more can be dropped into the plugins folder
// (%APPDATA%\com.mazon.halo\plugins) as .js files. See docs/plugins.md.

import easyMotion from "./easy-motion.js";

const plugins = new Map();
const listeners = new Set();

/* ---------- the toolkit handed to plugins ---------- */

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const C1 = 1.70158;
const C3 = C1 + 1;

function bounceOut(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** Easing curves over 0 to 1. Back and elastic overshoot past 1 before settling. */
export const EASINGS = {
  linear: (t) => t,
  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  expoIn: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  expoOut: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  backIn: (t) => C3 * t * t * t - C1 * t * t,
  backOut: (t) => 1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2),
  elasticOut: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  elasticIn: (t) => (t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  bounceOut,
  bounceIn: (t) => 1 - bounceOut(1 - t),
};

/** Repeatable noise in -1 to 1 for a seed and step, so shakes look the same every render. */
function noise(seed, step) {
  const s = Math.sin(seed * 127.1 + step * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

export const toolkit = {
  easings: EASINGS,
  clamp01,
  lerp: (a, b, t) => a + (b - a) * t,
  noise,
  /** Unit vectors for the five direction buttons, in screen space (y grows downward). */
  directions: { none: [0, 0], up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] },
};

/* ---------- registry ---------- */

const KINDS = ["caption-animation"];

function validate(p) {
  if (!p || typeof p !== "object") throw new Error("a plugin must export an object");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(p.id ?? "")) throw new Error("a plugin needs an id like \"my-plugin\"");
  if (!KINDS.includes(p.kind)) throw new Error(`${p.id}: kind must be one of ${KINDS.join(", ")}`);
  if (typeof p.frame !== "function") throw new Error(`${p.id}: frame(params, ctx) is missing`);
  if (typeof p.durations !== "function") throw new Error(`${p.id}: durations(params) is missing`);
  p.name ??= p.id;
  p.defaults ??= {};
  p.sections ??= [];
  p.presets ??= [];
  return p;
}

export function registerPlugin(p, { builtIn = false } = {}) {
  const plugin = validate(p);
  plugin.builtIn = builtIn;
  plugins.set(plugin.id, plugin);
  for (const fn of listeners) fn();
  return plugin;
}

export function getPlugin(id) { return plugins.get(id) ?? null; }

export function listPlugins(kind = "caption-animation") {
  return [...plugins.values()].filter((p) => p.kind === kind);
}

/** Called when plugins are added, so panels showing them can redraw. */
export function onPluginsChanged(fn) { listeners.add(fn); }

/** A plugin's settings with its defaults filled in, so saved projects survive new settings. */
export function pluginParams(plugin, params) {
  return { ...plugin.defaults, ...(params ?? {}) };
}

/**
 * Loads the user's plugins from Halo's plugins folder. Each file is an ES module whose default
 * export is a plugin object, or a function that takes the toolkit and returns one. A broken
 * plugin is reported and skipped; it never stops Halo from starting.
 */
export async function loadUserPlugins(api) {
  let files = [];
  try { files = await api.get("/plugins"); } catch { return []; }
  const failed = [];
  for (const file of files) {
    try {
      const res = await api.raw(`/plugins/${encodeURIComponent(file.name)}`);
      const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
      try {
        const mod = await import(url);
        const made = typeof mod.default === "function" ? mod.default(toolkit) : mod.default;
        registerPlugin(made);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  return failed;
}

registerPlugin(easyMotion(toolkit), { builtIn: true });
