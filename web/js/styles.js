// Caption looks. A style is plain data saved in the project; captions.js turns it into ASS tags.
// Sizes and positions are fractions of the frame, so a style looks the same at any resolution.

import { getPlugin } from "./plugins/registry.js";

/**
 * A caption animation: which plugin, which of its presets it started from, and its settings.
 * Every style animates through a plugin; Easy Motion is the one Halo ships.
 */
export function animation(presetId, pluginId = "easy-motion") {
  const plugin = getPlugin(pluginId);
  const preset = plugin?.presets.find((p) => p.id === presetId) ?? null;
  return { plugin: pluginId, preset: preset?.id ?? null, params: { ...(plugin?.defaults ?? {}), ...(preset?.params ?? {}) } };
}

/** Earlier versions picked from a fixed list of entrances; each one is an Easy Motion preset now. */
const ENTRANCE_PRESETS = { pop: "pop", bounce: "bounce", slide: "slide-up", fade: "fade", "pop-up": "spring-up", none: "none" };

export const DEFAULT_STYLE = {
  preset: "pop",
  font: "Poppins ExtraBold",
  size: 0.085,         // text height, as a fraction of the frame's short side
  uppercase: true,
  spacing: 0,          // letter spacing, as a fraction of the text size
  fill: "#ffffff",
  highlight: "#ffd43b",
  wordStyle: "color",  // how the spoken word stands out: color, box, glow, karaoke, reveal, blur, dim, pop-up, none
  wordPop: true,       // the spoken word grows slightly
  motion: animation("pop"), // how each caption comes and goes, through an animation plugin
  outline: 0.09,       // as a fraction of the text size
  outlineColor: "#000000",
  shadow: 0,           // drop shadow distance, as a fraction of the text size
  shadowColor: "#000000",
  shadowOpacity: 0.6,
  box: false,          // a solid box behind each whole caption
  boxColor: "#000000",
  boxOpacity: 0.6,
  x: 0.5,              // the bottom-centre of the caption, as a fraction of the frame
  y: 0.74,
  width: 0.84,         // longest a line may get before wrapping, as a fraction of the frame width
  gradient: "none",    // paints the text through gradientColors: none, across (left to right), down (top to bottom)
  gradientColors: ["#ffffff", "#9aa4b2"],
  invert: false,       // the text shows the video beneath it with its brightness flipped
};

export const PRESETS = [
  {
    id: "pop", name: "Pop", perLine: 3,
    style: { font: "Poppins ExtraBold", size: 0.085, uppercase: true, fill: "#ffffff", highlight: "#ffd43b", wordStyle: "color", wordPop: true, motion: animation("pop"), outline: 0.09, shadow: 0, box: false, y: 0.74 },
  },
  {
    id: "loud", name: "Loud", perLine: 2,
    style: { font: "Anton", size: 0.115, uppercase: true, spacing: 0.02, fill: "#ffffff", highlight: "#3be477", wordStyle: "color", wordPop: true, motion: animation("bounce"), outline: 0.12, shadow: 0.06, shadowOpacity: 0.7, box: false, y: 0.72 },
  },
  {
    id: "clean", name: "Clean", perLine: 5,
    style: { font: "Poppins", size: 0.06, uppercase: false, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("fade"), outline: 0, shadow: 0.05, shadowOpacity: 0.55, box: false, y: 0.8 },
  },
  {
    id: "karaoke", name: "Karaoke", perLine: 4,
    style: { font: "Poppins ExtraBold", size: 0.075, uppercase: false, fill: "#ffffff", highlight: "#ffd43b", wordStyle: "karaoke", wordPop: false, motion: animation("fade"), outline: 0.08, shadow: 0, box: false, y: 0.76 },
  },
  {
    id: "box", name: "Box", perLine: 3,
    style: { font: "Poppins ExtraBold", size: 0.08, uppercase: true, fill: "#ffffff", highlight: "#7c5cff", wordStyle: "box", wordPop: false, motion: animation("pop"), outline: 0.08, shadow: 0, box: false, y: 0.74 },
  },
  {
    id: "oneword", name: "One word", perLine: 1,
    style: { font: "Anton", size: 0.16, uppercase: true, spacing: 0.01, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("pop"), outline: 0.1, shadow: 0.05, shadowOpacity: 0.6, box: false, y: 0.58 },
  },
  {
    id: "subtitle", name: "Subtitle", perLine: 8,
    style: { font: "Poppins", size: 0.045, uppercase: false, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("none"), outline: 0, shadow: 0, box: true, boxColor: "#000000", boxOpacity: 0.6, y: 0.9, width: 0.9 },
  },
  {
    id: "glow", name: "Glow", perLine: 3,
    style: { font: "Poppins ExtraBold", size: 0.085, uppercase: true, fill: "#ffffff", highlight: "#22d3ee", wordStyle: "glow", wordPop: false, motion: animation("fade"), outline: 0.05, shadow: 0, box: false, y: 0.74 },
  },
  {
    // Apple's own captions: semibold with tight tracking, each word blurring into focus.
    id: "apple", name: "Apple", perLine: 4,
    style: { font: "Inter SemiBold", size: 0.07, uppercase: false, spacing: -0.02, fill: "#ffffff", highlight: "#ffffff", wordStyle: "blur", wordPop: false, motion: animation("none"), outline: 0, shadow: 0.04, shadowOpacity: 0.45, box: false, y: 0.78 },
  },
  {
    // Like Apple Music's sing-along lyrics: the whole line is up and words light up as they're sung.
    id: "lyrics", name: "Lyrics", perLine: 4,
    style: { font: "Inter ExtraBold", size: 0.075, uppercase: false, spacing: -0.02, fill: "#ffffff", highlight: "#ffffff", wordStyle: "dim", wordPop: false, motion: animation("fade"), outline: 0, shadow: 0.03, shadowOpacity: 0.35, box: false, y: 0.76 },
  },
  {
    id: "popup", name: "Pop up", perLine: 3,
    style: { font: "Poppins ExtraBold", size: 0.09, uppercase: true, spacing: -0.01, fill: "#ffffff", highlight: "#ffffff", wordStyle: "pop-up", wordPop: false, motion: animation("none"), outline: 0.1, shadow: 0.05, shadowOpacity: 0.5, box: false, y: 0.74 },
  },
  {
    id: "sunset", name: "Sunset", perLine: 3,
    style: { font: "Poppins ExtraBold", size: 0.09, uppercase: true, spacing: -0.01, fill: "#ffffff", highlight: "#ffffff", wordStyle: "color", wordPop: true, motion: animation("pop"), outline: 0.09, shadow: 0, box: false, y: 0.74, gradient: "across", gradientColors: ["#ffd43b", "#ff6b6b", "#b46cff"] },
  },
  {
    id: "chrome", name: "Chrome", perLine: 2,
    style: { font: "Anton", size: 0.115, uppercase: true, spacing: 0.01, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("spring-up"), outline: 0.1, shadow: 0.05, shadowOpacity: 0.6, box: false, y: 0.72, gradient: "down", gradientColors: ["#ffffff", "#c9d1dc", "#6b7584"] },
  },
  {
    id: "gold", name: "Gold", perLine: 3,
    style: { font: "DM Serif Display", size: 0.09, uppercase: false, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("fade"), outline: 0.05, outlineColor: "#2a1d05", shadow: 0.04, shadowOpacity: 0.5, box: false, y: 0.76, gradient: "down", gradientColors: ["#fff4c7", "#e2b64e", "#9c6a10"] },
  },
  {
    // The real estate creator look: big bold words that flip the brightness of the video
    // behind them, like a Luma curve dragged from bottom-left to top-left in CapCut.
    id: "realestate", name: "Real estate", perLine: 2,
    style: { font: "Poppins ExtraBold", size: 0.13, uppercase: true, spacing: -0.02, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("pop"), outline: 0, shadow: 0, box: false, y: 0.82, invert: true },
  },
  {
    // Property tours: an elegant serif on a soft dark band, with a gold accent on the spoken word.
    id: "luxe", name: "Luxe", perLine: 4,
    style: { font: "Playfair Display", size: 0.07, uppercase: false, fill: "#ffffff", highlight: "#e3c27a", wordStyle: "color", wordPop: false, motion: animation("fade"), outline: 0, shadow: 0.04, shadowOpacity: 0.5, box: true, boxColor: "#111014", boxOpacity: 0.6, y: 0.8 },
  },
  {
    // The lower-third look of listing videos: small, widely tracked capitals.
    id: "listing", name: "Listing", perLine: 5,
    style: { font: "Inter SemiBold", size: 0.05, uppercase: true, spacing: 0.08, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("slide-up"), outline: 0, shadow: 0.05, shadowOpacity: 0.5, box: false, y: 0.86 },
  },
  {
    id: "wide", name: "Wide", perLine: 2,
    style: { font: "Unbounded ExtraBold", size: 0.07, uppercase: true, spacing: -0.02, fill: "#ffffff", highlight: "#c6ff3d", wordStyle: "color", wordPop: true, motion: animation("spring-up"), outline: 0.09, shadow: 0, box: false, y: 0.74 },
  },
  {
    id: "script", name: "Script", perLine: 3,
    style: { font: "Yellowtail", size: 0.11, uppercase: false, fill: "#ffffff", highlight: "#ffffff", wordStyle: "none", wordPop: false, motion: animation("fade"), outline: 0, shadow: 0.05, shadowOpacity: 0.5, box: false, y: 0.8 },
  },
];

/** A full style for a preset, keeping the caption's current position. */
export function presetStyle(id, current = DEFAULT_STYLE) {
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  return { ...DEFAULT_STYLE, ...preset.style, preset: preset.id, x: current.x ?? DEFAULT_STYLE.x };
}

/** Fills in fields added since a project was saved. */
export function normalizeStyle(style) {
  const st = { ...DEFAULT_STYLE, ...(style ?? {}) };
  // A motion of null means "no animation" and is kept; only styles from before plugins get one.
  if (!style || !("motion" in style)) st.motion = animation(ENTRANCE_PRESETS[style?.entrance] ?? "pop");
  delete st.entrance;
  // Earlier versions stored the gradient as on/off with two colours.
  if (typeof st.gradient === "boolean") {
    st.gradient = st.gradient ? "across" : "none";
    st.gradientColors = [st.gradientFrom ?? "#ffffff", st.gradientTo ?? "#ffd43b"];
  }
  delete st.gradientFrom;
  delete st.gradientTo;
  return st;
}

/** Fields only the overall style has: everything else, a caption may override on its own. */
export const GLOBAL_ONLY = ["preset", "invert", "width"];

/** The look of a style without its place on screen, for applying it to captions that are elsewhere. */
export function lookOf(style) {
  const { preset, x, y, ...look } = style;
  return look;
}

/** Caption tracks: C1 is the transcript; captions on higher tracks stack over it. */
export function defaultTracks() {
  return [{ id: 1, name: "Captions", hidden: false, locked: false }];
}
