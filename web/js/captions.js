// Captions are a list of timed words. These helpers group them into lines, apply edits, and write
// the ASS subtitle file (rendered live by libass in the page and burned in by ffmpeg) and SRT.
//
// Words sit on caption tracks (C1, C2, ...), which stack like video tracks in an editor. The words
// array is kept in track order and then time order, so every line is a run of neighbouring words.

import { letterCount, phaseLengths, resolveMotion, shiftTransitions, writeLine } from "./motion.js";
import { GLOBAL_ONLY, defaultTracks } from "./styles.js";

/** The track a word is on. Words from before tracks existed are on the first. */
export const trackOf = (w) => w.track ?? 1;

/** Makes sure there are tracks, and that every word is on one of them. */
export function ensureTracks(captions) {
  if (!captions.tracks?.length) captions.tracks = defaultTracks();
  const ids = new Set(captions.tracks.map((t) => t.id));
  for (const w of captions.words) if (!ids.has(trackOf(w))) w.track = captions.tracks[0].id;
  sortWords(captions);
}

/** Puts words back in track order, then time order. Call after anything moves words between tracks. */
export function sortWords(captions) {
  const rank = new Map((captions.tracks ?? []).map((t, i) => [t.id, i]));
  captions.words.sort((a, b) => (rank.get(trackOf(a)) ?? 0) - (rank.get(trackOf(b)) ?? 0) || a.start - b.start);
}

/** A new track id, one past the highest. */
export function nextTrackId(captions) {
  return Math.max(0, ...(captions.tracks ?? []).map((t) => t.id)) + 1;
}


/** Groups words into caption lines: [{ from, to }] index ranges into `words`. */
export function groupLines(words, perLine) {
  const lines = [];
  let i = 0;
  while (i < words.length) {
    let j = i + 1;
    if (words[i].group != null) {
      // Lines the user has edited keep exactly the words they typed.
      while (j < words.length && words[j].group === words[i].group) j++;
    } else {
      // Otherwise break on the word limit, sentence ends, pauses, lines running long, and tracks.
      while (j < words.length && words[j].group == null && j - i < perLine && trackOf(words[j]) === trackOf(words[i])) {
        const prev = words[j - 1];
        if (/[.!?]$/.test(prev.text) || words[j].start - prev.end > 0.6 || words[j].end - words[i].start > 2.6) break;
        j++;
      }
    }
    lines.push({ from: i, to: j });
    i = j;
  }
  return lines;
}

/** Start and end of a line, closing tiny gaps to the next one so captions don't flicker. */
export function lineTimes(words, lines, k) {
  const { from, to } = lines[k];
  const start = words[from].start;
  let end = words[to - 1].end;
  const next = lines[k + 1];
  if (next && trackOf(words[next.from]) === trackOf(words[from]) && words[next.from].start - end < 0.3) end = words[next.from].start;
  return { start, end };
}

/* ---------- caption text tools ----------

   Filler words, find and replace, and SRT import all work on the words themselves; the lines and
   styles built from them pick the edits up without any extra wiring. */

/** Words that mean nothing once spoken; transcription keeps them in, captions shouldn't. */
export const FILLER_WORDS = new Set([
  "um", "uh", "umm", "uhh", "erm", "em", "hmm", "er", "like", "well", "so", "actually", "basically",
  "literally", "just", "maybe", "ok", "okay", "whoa", "huh",
]);

/** Lowercases and strips punctuation, so "Um," and "UM" are the same filler. */
function normalizeWord(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a word is a filler the user would rather not hear. */
export function isFiller(text) {
  const w = normalizeWord(text);
  return w.length > 0 && FILLER_WORDS.has(w);
}

/** Indexes of every word that is a filler, in order. */
export function findFillers(words) {
  const out = [];
  words.forEach((w, i) => { if (isFiller(w.text)) out.push(i); });
  return out;
}

/**
 * Drops the filler words. Returns the new words array and how many were removed; callers stage the
 * whole result through one document update, so cleanup is a single undo step.
 */
export function stripFillers(captions) {
  const drop = new Set(findFillers(captions.words));
  if (!drop.size) return { words: captions.words, removed: 0 };
  return { words: captions.words.filter((_, i) => !drop.has(i)), removed: drop.size };
}

/** Indexes of the words that are a whole-word, case-insensitive match for `find`. */
export function findIndexes(words, find) {
  const f = find.trim().toLowerCase();
  if (!f) return [];
  const re = new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const out = [];
  words.forEach((w, i) => { if (re.test(w.text.trim())) out.push(i); });
  return out;
}

/**
 * Replaces the words at `indexes` with `replace` (dropping them when it's empty). Returns a new
 * array, so callers can stage the whole edit before putting it in the document.
 */
export function replaceIndexes(words, indexes, replace) {
  const drop = new Set(indexes);
  const tokens = replace.trim().split(/\s+/).filter(Boolean);
  const next = [];
  words.forEach((w, i) => {
    if (drop.has(i)) {
      if (tokens.length) next.push({ ...w, text: tokens[0] });
      return;
    }
    next.push(w);
  });
  return next;
}

/**
 * SRT or WebVTT timestamp to seconds: HH:MM:SS,mmm or HH:MM:SS.mmm, and WebVTT's MM:SS.mmm. Cue
 * settings after the time ("align:start") are ignored.
 */
function parseSrtTime(s) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[4].padEnd(3, "0"));
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/**
 * Brings captions in from an SRT or WebVTT file (YouTube, Premiere, anywhere): one block per
 * caption, timing lines skipped, words spread over the line's span the way live transcription does.
 * WebVTT's header, notes and inline tags (<i>, <c.yellow>, <00:00:01.000>) are dropped.
 */
export function parseSrt(text) {
  const words = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const t = lines.findIndex((l) => l.includes("-->"));
    if (t < 0) continue;
    const [startStr, endStr] = lines[t].split("-->");
    const start = parseSrtTime(startStr);
    const end = parseSrtTime(endStr);
    if (start == null || end == null) continue;
    const tokens = lines.slice(t + 1).join(" ").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .split(/\s+/).filter(Boolean);
    const span = Math.max(0.04, end - start);
    const total = tokens.reduce((n, tk) => n + tk.length, 0) || 1;
    let cursor = start;
    for (const tk of tokens) {
      const d = (span * tk.length) / total;
      words.push({ text: tk, start: cursor, end: cursor + d });
      cursor += d;
    }
  }
  return words;
}

/* ---------- editing ----------
   A "group" pins words into one caption line regardless of the words-per-caption setting. Lines
   the user edits in any way get one, so later changes to that setting don't regroup their work. */

/** The shortest a word may be squeezed to by trimming or retiming. */
export const MIN_WORD = 0.04;

function nextGroup(captions) {
  captions.edits = (captions.edits ?? 0) + 1;
  return captions.edits;
}

/** Gives a new group the same per-caption style as an old one, so restructuring keeps it. */
function carryOverride(captions, from, to) {
  const o = from != null ? captions.overrides?.[from] : null;
  if (o) captions.overrides[to] = { ...o };
}

function nextId(captions) {
  captions.nextId = (captions.nextId ?? 1) + 1;
  return captions.nextId - 1;
}

/** Gives every word a stable id, so selections survive edits. Older projects predate ids. */
export function ensureIds(captions) {
  let max = 0;
  for (const w of captions.words) if (w.id != null) max = Math.max(max, w.id);
  captions.nextId = Math.max(captions.nextId ?? 1, max + 1);
  for (const w of captions.words) if (w.id == null) w.id = nextId(captions);
}

/** Words spread over [start, end] in proportion to their length. */
function spread(captions, tokens, start, end, group, track = 1) {
  const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
  let t = start;
  return tokens.map((text) => {
    const d = ((end - start) * text.length) / total;
    const w = { id: nextId(captions), text, start: t, end: t + d, group, track };
    t += d;
    return w;
  });
}

/** Pins a line's words together; returns the line's group. */
export function lockLine(captions, { from, to }) {
  const { words } = captions;
  if (words[from].group != null) return words[from].group;
  const group = nextGroup(captions);
  for (let i = from; i < to; i++) words[i].group = group;
  return group;
}

/**
 * Replaces a line's words with new text in place, keeping timings when the word count is
 * unchanged and otherwise spreading the line's time over the new words by length.
 */
export function editLine(captions, { from, to }, text) {
  const { words } = captions;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const old = words.slice(from, to);
  // An edited line keeps its group, and with it any style of its own.
  const group = old[0].group ?? nextGroup(captions);
  const replacement = tokens.length === old.length
    ? old.map((w, i) => ({ ...w, text: tokens[i], group }))
    : spread(captions, tokens, old[0].start, old[old.length - 1].end, group, trackOf(old[0]));
  words.splice(from, to - from, ...replacement);
}

/** Shifts whole lines in time. The caller keeps them clear of their neighbours. */
export function moveLines(captions, lines, delta) {
  for (const line of lines) {
    lockLine(captions, line);
    for (let i = line.from; i < line.to; i++) {
      captions.words[i].start += delta;
      captions.words[i].end += delta;
    }
  }
}

/** Stretches a line to a new start and end, scaling its words' timings to match. */
export function retimeLine(captions, line, start, end) {
  lockLine(captions, line);
  const { words } = captions;
  const oldStart = words[line.from].start;
  const oldSpan = Math.max(1e-6, words[line.to - 1].end - oldStart);
  const k = (end - start) / oldSpan;
  for (let i = line.from; i < line.to; i++) {
    words[i].start = start + (words[i].start - oldStart) * k;
    words[i].end = start + (words[i].end - oldStart) * k;
  }
}

/**
 * Splits a line at time `t`, between the words either side of it. Returns false when there's
 * no word boundary to split at (a one-word line, or `t` outside the line).
 */
export function splitLine(captions, line, t) {
  const { words } = captions;
  let cut = -1;
  for (let i = line.from + 1; i < line.to; i++) {
    // The boundary nearest to t.
    if (cut < 0 || Math.abs(words[i].start - t) < Math.abs(words[cut].start - t)) cut = i;
  }
  if (cut < 0 || t < words[line.from].start || t > words[line.to - 1].end) return false;
  const old = words[line.from].group;
  const a = nextGroup(captions);
  const b = nextGroup(captions);
  carryOverride(captions, old, a);
  carryOverride(captions, old, b);
  for (let i = line.from; i < line.to; i++) words[i].group = i < cut ? a : b;
  return true;
}

/** Joins consecutive lines into one. */
export function mergeLines(captions, lines) {
  if (lines.length < 2) return false;
  const group = nextGroup(captions);
  const from = Math.min(...lines.map((l) => l.from));
  const to = Math.max(...lines.map((l) => l.to));
  carryOverride(captions, captions.words[from].group, group);
  for (let i = from; i < to; i++) captions.words[i].group = group;
  return true;
}

export function deleteLines(captions, lines) {
  for (const line of [...lines].sort((a, b) => b.from - a.from)) captions.words.splice(line.from, line.to - line.from);
}

/**
 * Deletes lines and closes the time they took on their tracks: later captions on the same track
 * move earlier by that much, keeping the gaps between them, as a ripple delete does in Premiere.
 */
export function rippleDelete(captions, lines) {
  const { words } = captions;
  const spans = lines.map((l) => ({ track: trackOf(words[l.from]), start: words[l.from].start, end: words[l.to - 1].end }));
  deleteLines(captions, lines);
  for (const w of captions.words) {
    let shift = 0;
    for (const s of spans) if (s.track === trackOf(w) && s.end <= w.start + 1e-6) shift += s.end - s.start;
    if (shift) { w.start -= shift; w.end -= shift; }
  }
  sortWords(captions);
}

/**
 * Moves lines (every line when `lines` is null) by `delta` seconds, to fix captions that run early
 * or late against the speech. Never before the start of the video. Returns how far they moved.
 */
export function shiftTiming(captions, lines, delta) {
  const { words } = captions;
  const ranges = lines ?? [{ from: 0, to: words.length }];
  const first = Math.min(...ranges.map((l) => words[l.from]?.start ?? Infinity));
  const d = Math.max(-first, delta);
  if (!Number.isFinite(d) || !d) return 0;
  for (const l of ranges) for (let i = l.from; i < l.to; i++) { words[i].start += d; words[i].end += d; }
  sortWords(captions);
  return d;
}

/** The captions from `start` to `end` seconds, retimed to begin at 0, for exporting just that stretch. */
export function sliceCaptions(captions, start, end) {
  const words = captions.words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ ...w, start: Math.max(0, w.start - start), end: Math.min(end, w.end) - start }));
  return { ...captions, words };
}

/** Adds a new caption line on a track; returns the id of its first word. */
export function insertLine(captions, start, end, text, track = captions.tracks?.[0]?.id ?? 1) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const added = spread(captions, tokens, start, end, nextGroup(captions), track);
  captions.words.push(...added);
  sortWords(captions);
  return added[0].id;
}

/**
 * Copies lines (as `clip` from copyLines) onto a track starting at `at`; returns the first word id
 * of each new line. Each copy gets its own group, carrying the original's style.
 */
export function pasteLines(captions, clip, at, trackFor) {
  const ids = [];
  for (const item of clip.lines) {
    const group = nextGroup(captions);
    if (item.override) {
      captions.overrides ??= {};
      captions.overrides[group] = structuredClone(item.override);
    }
    const added = item.words.map((w) => ({ id: nextId(captions), text: w.text, start: at + w.start, end: at + w.end, group, track: trackFor(item), ...(w.color ? { color: w.color } : {}) }));
    captions.words.push(...added);
    ids.push(added[0].id);
  }
  sortWords(captions);
  return ids;
}

/** A copy of lines, timed from the earliest one's start, for pasting elsewhere. */
export function copyLines(captions, lines) {
  const { words } = captions;
  const t0 = Math.min(...lines.map((l) => words[l.from].start));
  const minRank = Math.min(...lines.map((l) => (captions.tracks ?? []).findIndex((t) => t.id === trackOf(words[l.from]))));
  return {
    lines: lines.map((l) => {
      const group = words[l.from].group;
      return {
        track: trackOf(words[l.from]),
        trackOffset: (captions.tracks ?? []).findIndex((t) => t.id === trackOf(words[l.from])) - minRank,
        override: group != null && captions.overrides?.[group] ? structuredClone(captions.overrides[group]) : null,
        words: words.slice(l.from, l.to).map((w) => ({ text: w.text, start: w.start - t0, end: w.end - t0, color: w.color })),
      };
    }),
    duration: Math.max(...lines.map((l) => words[l.to - 1].end)) - t0,
  };
}

/** Moves lines up or down the track stack by `shift` places. The caller checks there's room. */
export function shiftTracks(captions, lines, shift) {
  if (!shift) return;
  const tracks = captions.tracks;
  for (const line of lines) {
    lockLine(captions, line);
    const rank = tracks.findIndex((t) => t.id === trackOf(captions.words[line.from]));
    const target = tracks[Math.min(tracks.length - 1, Math.max(0, rank + shift))].id;
    for (let i = line.from; i < line.to; i++) captions.words[i].track = target;
  }
  sortWords(captions);
}

/** Moves the boundary between word i and the next one, keeping both words a sensible length. */
export function setWordBoundary(captions, i, t) {
  const { words } = captions;
  const a = words[i];
  const b = words[i + 1];
  const clamped = Math.min(Math.max(t, a.start + MIN_WORD), b.end - MIN_WORD);
  a.end = clamped;
  b.start = clamped;
}

/* ---------- how a caption's words are written out ---------- */

// Common English swear words, matched on the word with its punctuation and case stripped. Roots
// catch their forms (fucking, shitty); whole words are only matched exactly (so "class" is safe).
const SWEAR_ROOTS = ["fuck", "shit", "bitch", "cunt", "motherf"];
const SWEAR_WORDS = new Set(["ass", "asshole", "arse", "bastard", "bollocks", "cock", "dick", "dickhead", "goddamn", "piss", "pissed", "prick", "pussy", "slut", "twat", "wanker", "whore", "damn"]);

function isSwear(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  return w.length > 2 && (SWEAR_WORDS.has(w) || SWEAR_ROOTS.some((r) => w.includes(r)));
}

/** Keeps a swear word's first letter and stars the rest, leaving its punctuation alone: "f***!". */
function bleep(text) {
  let seen = false;
  return text.replace(/[a-z]/gi, (ch) => (seen ? "*" : ((seen = true), ch)));
}

function titleCase(text) {
  return text.toLocaleLowerCase().replace(/(^|[\s\-"“(])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase());
}

/**
 * A word as a caption style shows it: its case, without punctuation if the style drops it, and
 * bleeped if the style censors swearing. Only the display changes; the words stay as they were.
 */
export function displayText(text, st) {
  let t = text;
  if (st.censor && isSwear(t)) t = bleep(t);
  if (st.punctuation === "remove") t = t.replace(/[.,!?;:…"“”]+/g, "").replace(/^['‘’]+|['‘’]+$/g, "");
  if (st.uppercase) t = t.toLocaleUpperCase();
  else if (st.textCase === "lower") t = t.toLocaleLowerCase();
  else if (st.textCase === "title") t = titleCase(t);
  return t;
}

/** A caption file's text for a line: as spoken, except swearing is bleeped when the style does that. */
function fileText(words, st) {
  return words.map((w) => (st.censor && isSwear(w.text) ? bleep(w.text) : w.text)).join(" ");
}

function assEscape(text) {
  return text.replace(/\\/g, "＼").replace(/\{/g, "(").replace(/\}/g, ")");
}

/** "#rrggbb" plus opacity as an ASS colour, which is &HAABBGGRR& with alpha 00 = opaque. */
function assColor(hex, opacity = 1) {
  const h = /^#[0-9a-f]{6}$/i.test(hex ?? "") ? hex.slice(1) : "ffffff";
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  const hx = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  return `&H${hx(alpha)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

/** Inline colour tags take only &HBBGGRR&. */
function tagColor(hex) {
  return assColor(hex).replace(/^&H00/, "&H");
}

/** Dark text on light highlight boxes, white on dark ones. */
export function readableOn(hex) {
  const h = (hex ?? "#000000").slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#111111" : "#ffffff";
}

/** The colour at t (0 to 1) along evenly spaced "#rrggbb" stops. */
function mixStops(stops, t) {
  const at = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(at));
  const [a, b] = [stops[k], stops[k + 1]].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * (at - k)).toString(16).padStart(2, "0")).join("");
}

/** A word with each letter coloured by where it sits in the line, for left-to-right gradients. */
function paintLetters(word, offset, letters, stops) {
  return [...word].map((ch, k) => `{\\c${tagColor(mixStops(stops, (offset + k) / Math.max(1, letters - 1)))}}${ch}`).join("");
}

/**
 * Horizontal bands for a top-to-bottom gradient, each with its colour and clip. libass stacks
 * wrapped rows one font size apart, so every row gets the same bands; the row count is a guess
 * from the text's length. The outer bands reach past the text to cover outlines and pops.
 */
function gradientBands(text, st, size, y, W, stops) {
  const count = 8;
  const rows = Math.min(3, Math.max(1, Math.ceil(([...text].length * size * (0.56 + st.spacing)) / (st.width * W))));
  const inset = size * 0.14;
  return Array.from({ length: count }, (_, k) => {
    const rects = [];
    for (let r = 0; r < rows; r++) {
      const bottom = y - r * size;
      const top = bottom - size;
      const edge = (n) => top + inset + ((size - inset * 2) * n) / count;
      const y0 = k === 0 ? (r === rows - 1 ? top - size * 0.5 : top) : edge(k);
      const y1 = k === count - 1 ? (r === 0 ? bottom + size * 0.5 : bottom) : edge(k + 1);
      const [t, b] = [Math.round(y0), Math.round(y1)];
      rects.push(`m 0 ${t} l ${W} ${t} ${W} ${b} 0 ${b}`);
    }
    return { color: mixStops(stops, (k + 0.5) / count), clip: `\\clip(${rects.join(" ")})` };
  });
}

/** The style one line uses: the caption style plus that line's own overrides. */
export function lineStyle(captions, words, line) {
  const group = words[line.from].group;
  const override = group != null ? captions.overrides?.[group] : null;
  if (!override) return captions.style;
  const st = { ...captions.style, ...override };
  for (const key of GLOBAL_ONLY) st[key] = captions.style[key];
  return st;
}

/** Ids of the tracks whose captions are hidden from the picture and the export. */
function hiddenTracks(captions) {
  return new Set((captions.tracks ?? []).filter((t) => t.hidden).map((t) => t.id));
}

/** Each track's place in the stack, bottom first. */
function trackRanks(captions) {
  return new Map((captions.tracks ?? []).map((t, i) => [t.id, i]));
}

/**
 * The subtitle file used both for the live overlay (libass in the page) and for burning into
 * the export (libass in ffmpeg). Each caption is one event per spoken word, showing the whole
 * line with that word styled; karaoke is one event per line using libass's own fill timing.
 * Animations are baked frame by frame (see motion.js), so `fps` should be the video's.
 */
export function buildAss(captions, width, height, opts = {}) {
  if (!captions.style.invert) return buildTrack(captions, width, height, opts);
  // Inverted captions keep their outline, shadow and box as ordinary drawing under the
  // letters, with the letters themselves left empty for the inverted video (see buildMask).
  const looks = [captions.style, ...Object.values(captions.overrides ?? {}).map((o) => ({ ...captions.style, ...o }))];
  if (!looks.some((s) => s.outline > 0 || s.shadow > 0 || s.box)) return null;
  const flat = (o) => ({ ...o, gradient: "none" });
  return buildTrack({
    ...captions,
    style: flat(captions.style),
    overrides: Object.fromEntries(Object.entries(captions.overrides ?? {}).map(([g, o]) => [g, flat(o)])),
  }, width, height, { ...opts, hideLetters: true })
    .replace(/^(Style: Default,[^,]*,[^,]*,)&H..(\w{6}&),&H..(\w{6}&)/m, "$1&HFF$2,&HFF$3")
    // Words that hide or dim set \alpha, which would bring the letters back; apply it to the rest only.
    .replace(/\\alpha(&H[0-9A-F]{2}&)/gi, "\\3a$1\\4a$1");
}

/**
 * For inverted captions, the letters alone in plain white: the mask through which the video
 * shows with its brightness flipped. Null when the captions aren't inverted.
 */
export function buildMask(captions, width, height, opts = {}) {
  if (!captions.style.invert) return null;
  const plain = { fill: "#ffffff", highlight: "#ffffff", outline: 0, shadow: 0, box: false, gradient: "none" };
  return buildTrack({
    ...captions,
    style: { ...captions.style, ...plain },
    overrides: Object.fromEntries(Object.entries(captions.overrides ?? {}).map(([g, o]) => [g, { ...o, ...plain }])),
    words: captions.words.map(({ color, ...w }) => w),
  }, width, height, opts);
}

function buildTrack(captions, width, height, { fps = 30, hideLetters = false } = {}) {
  const { words, perLine } = captions;
  const base = captions.style;
  const W = width || 1920;
  const H = height || 1080;
  const short = Math.min(W, H);
  const fs = (st) => Math.max(8, Math.round(st.size * short));
  const size = fs(base);
  const marginH = Math.round(((1 - base.width) / 2) * W);
  const outlinePx = (st) => Math.round(st.outline * fs(st) * 10) / 10;
  const spacingPx = (st) => Math.round(st.spacing * fs(st) * 10) / 10;
  const shadowPx = (st) => Math.round(st.shadow * fs(st) * 10) / 10;
  const rate = fps > 0 ? fps : 30;

  const style = [
    "Default",
    base.font,
    size,
    assColor(base.fill),
    assColor(base.fill),
    assColor(base.outlineColor, base.outlineOpacity ?? 1),
    assColor(base.shadowColor, base.shadowOpacity),
    0, 0, 0, 0, 100, 100,
    spacingPx(base),
    0, 1,
    outlinePx(base),
    shadowPx(base),
    2, marginH, marginH, 0, 1,
  ].join(",");
  // The background box is its own layer of invisible text in one run, so libass draws one box
  // per row. Boxes drawn behind each styled word would overlap and darken where words meet.
  const boxStyle = [
    "Box", base.font, size, assColor("#ffffff", 0), assColor("#ffffff", 0),
    assColor(base.boxColor, base.boxOpacity), assColor(base.boxColor, base.boxOpacity),
    0, 0, 0, 0, 100, 100, spacingPx(base), 0, 3,
    Math.round(size * 0.22), 0, 2, marginH, marginH, 0, 1,
  ].join(",");

  const out = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    `Style: ${boxStyle}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const hidden = hiddenTracks(captions);
  const ranks = trackRanks(captions);
  const lines = groupLines(words, perLine);
  lines.forEach((line, k) => {
    if (hidden.has(trackOf(words[line.from]))) return;
    const { start, end } = lineTimes(words, lines, k);
    const st = lineStyle(captions, words, line);
    const lineWords = words.slice(line.from, line.to);
    const x = Math.round(st.x * W);
    const y = Math.round(st.y * H);
    const size = fs(st);
    const ob = outlinePx(st);
    const display = (w) => assEscape(displayText(w.text, st));
    // Higher tracks draw over lower ones, each with room for its box, text and gradient bands.
    const layerBase = (ranks.get(trackOf(words[line.from])) ?? 0) * 20;

    // Where this caption's look differs from the overall style, the line says so itself.
    let lineTags = "";
    if (st.font !== base.font) lineTags += `\\fn${st.font}`;
    if (size !== fs(base)) lineTags += `\\fs${size}`;
    if (spacingPx(st) !== spacingPx(base)) lineTags += `\\fsp${spacingPx(st)}`;
    if (ob !== outlinePx(base)) lineTags += `\\bord${ob}`;
    if (st.outlineColor !== base.outlineColor) lineTags += `\\3c${tagColor(st.outlineColor)}`;
    const outlineAlpha = `\\3a&H${assColor("#000000", st.outlineOpacity ?? 1).slice(2, 4)}&`;
    if ((st.outlineOpacity ?? 1) !== (base.outlineOpacity ?? 1)) lineTags += outlineAlpha;
    if (shadowPx(st) !== shadowPx(base)) lineTags += `\\shad${shadowPx(st)}`;
    if (st.shadowColor !== base.shadowColor) lineTags += `\\4c${tagColor(st.shadowColor)}`;
    if (st.shadowOpacity !== base.shadowOpacity) lineTags += `\\4a&H${assColor("#000000", st.shadowOpacity).slice(2, 4)}&`;

    const events = [];
    const textAlpha = { c1: hideLetters ? 0 : 1, c3: st.outlineOpacity ?? 1, c4: st.shadowOpacity };
    const layer = layerBase + (st.box ? 1 : 0);
    const box = (from, to) => {
      if (!st.box) return;
      const fill = assColor(st.boxColor, st.boxOpacity);
      const head = `\\fn${st.font}\\fs${size}\\fsp${spacingPx(st)}\\bord${Math.round(size * 0.22)}`
        + `\\3c${tagColor(st.boxColor)}\\4c${tagColor(st.boxColor)}\\3a&H${fill.slice(2, 4)}&\\4a&H${fill.slice(2, 4)}&`;
      const text = lineWords.map(display).join(" ");
      events.push({ layer: layerBase, from, to, style: "Box", head, body: () => text, alpha: { c1: 0, c3: st.boxOpacity, c4: st.boxOpacity }, kind: "box" });
    };

    const motion = resolveMotion(st.motion);
    const chars = [...lineWords.map(display).join(" ")].length;
    const animatedLetters = letterCount(lineWords.map(display).join(" "));
    const textW = chars * size * (0.56 + st.spacing);
    const rows = Math.min(3, Math.max(1, Math.ceil(textW / (base.width * W))));
    const extent = { w: Math.min(textW, base.width * W), h: rows * size };
    const frame = { w: W, h: H };
    // An entrance that scales the line already makes the first word pop. Letter by letter, nothing scales.
    const { tin, gap } = phaseLengths(motion, end - start, rate, animatedLetters);
    const entranceScales = !!motion && tin > 0 && !gap && Math.abs((motion.plugin.frame(motion.params, {
      phase: "in", progress: 0, holdTime: 0, holdDuration: 0, size, box: extent, frame, fps: rate, seed: k, lineDuration: end - start,
    })?.scale ?? 1) - 1) > 0.05;
    const finish = () => writeLine(out, {
      events, start, end, anchor: { x, y }, size, box: extent, frame, fps: rate, motion, seed: k, spacing: spacingPx(st), letters: animatedLetters,
    });

    if (st.wordStyle === "karaoke") {
      // One event; libass sweeps each word from the fill colour to the highlight as it's spoken.
      // A piece cut from partway through starts its sweep timings that much earlier.
      const spans = lineWords.map((w, i) => [w.start - start, (i < lineWords.length - 1 ? lineWords[i + 1].start : end) - start]);
      const body = (ms) => lineWords.map((w, i) => {
        const [a, b] = spans[i].map((s) => Math.max(0, s * 1000 - ms));
        const cs = ms ? Math.round((b - a) / 10) : Math.max(1, Math.round((spans[i][1] - spans[i][0]) * 100));
        return `{\\kf${cs}}${display(w)}`;
      }).join(" ");
      box(start, end);
      events.push({ layer, from: start, to: end, style: "Default", head: `${lineTags}\\1c${tagColor(st.highlight)}\\2c${tagColor(st.fill)}`, body, alpha: textAlpha, kind: "text" });
      finish();
      return;
    }

    // Gradients: "across" colours each letter along the line; "down" can't be done with one fill
    // in libass, so the line is drawn once per horizontal band, each clipped and coloured.
    const stops = st.gradient !== "none" ? (st.gradientColors ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)) : [];
    const across = st.gradient === "across" && stops.length > 1;
    const bands = st.gradient === "down" && stops.length > 1 ? gradientBands(lineWords.map(display).join(" "), st, size, y, W, stops) : [null];
    const offsets = [];
    lineWords.reduce((n, w, j) => { offsets[j] = n; return n + [...display(w)].length + 1; }, 0);
    const letters = offsets.length ? offsets[offsets.length - 1] + [...display(lineWords[lineWords.length - 1])].length : 0;
    const text = (w, j) => across ? paintLetters(display(w), offsets[j], letters, stops) : display(w);
    // Styles where words show up as they're spoken hide the ones still to come.
    const hidesAhead = ["reveal", "blur", "pop-up"].includes(st.wordStyle);

    lineWords.forEach((word, i) => {
      const from = i === 0 ? start : word.start;
      const to = i === lineWords.length - 1 ? end : lineWords[i + 1].start;
      if (to <= from) return;
      const scaleEntrance = i === 0 && entranceScales;
      box(from, to);
      bands.forEach((band, b) => {
        const colorOf = (w) => band?.color ?? w.color ?? st.fill;
        const segments = lineWords.map((w, j) => {
          // Words after this one only ever follow it, so their opacity needs no reset.
          if (hidesAhead && j > i) return `{\\alpha&HFF&}${display(w)}`;
          if (st.wordStyle === "dim" && j > i) return `{\\c${tagColor(colorOf(w))}\\alpha&H99&}${text(w, j)}`;
          // Outline: every word is hollow, drawn by its outline alone, and the spoken word fills in.
          if (st.wordStyle === "outline") {
            const fill = j === i ? assColor("#000000", st.fillOpacity ?? 1).slice(2, 4) : "FF";
            return `{\\c${tagColor(colorOf(w))}\\1a&H${fill}&}${text(w, j)}`;
          }
          if (j !== i || st.wordStyle === "none" || st.wordStyle === "dim") return `{\\c${tagColor(colorOf(w))}}${text(w, j)}`;
          // A gradient is the colour, so the spoken word stands out by its animation instead.
          const painted = band || across;
          let tags = painted ? `\\c${tagColor(colorOf(w))}` : "";
          let reset = "";
          if (st.wordStyle === "color" || st.wordStyle === "reveal") {
            if (!painted) tags += `\\c${tagColor(st.highlight)}`;
          } else if (st.wordStyle === "box") {
            // A thick outline in the highlight colour reads as a rounded box behind the word.
            // It's solid whatever the outline's own opacity.
            tags += `\\c${tagColor(painted ? colorOf(w) : readableOn(st.highlight))}\\3c${tagColor(st.highlight)}\\3a&H00&\\bord${Math.round(size * 0.2)}`;
            reset += `\\3c${tagColor(st.outlineColor)}${outlineAlpha}\\bord${ob}`;
          } else if (st.wordStyle === "glow") {
            tags += `\\c${tagColor(colorOf(w))}\\3c${tagColor(st.highlight)}\\3a&H00&\\bord${Math.round(size * 0.1)}\\blur${Math.round(size * 0.12)}`;
            reset += `\\3c${tagColor(st.outlineColor)}${outlineAlpha}\\bord${ob}\\blur0`;
          } else if (st.wordStyle === "blur") {
            // Comes into focus as it fades in, the way Apple's captions do.
            tags += `\\c${tagColor(colorOf(w))}\\alpha&HFF&\\blur${Math.round(size * 0.18)}\\t(0,240,\\alpha&H00&${outlineAlpha}\\blur0)`;
          } else if (st.wordStyle === "pop-up") {
            tags += `\\c${tagColor(colorOf(w))}\\fscx40\\fscy40\\t(0,100,\\fscx115\\fscy115)\\t(100,170,\\fscx100\\fscy100)`;
            reset += "\\fscx100\\fscy100";
          }
          if (st.wordPop && !scaleEntrance && st.wordStyle !== "pop-up") {
            tags += "\\fscx100\\fscy100\\t(0,90,\\fscx116\\fscy116)";
            reset += "\\fscx100\\fscy100";
          }
          return `{${tags}}${text(w, j)}${reset ? `{${reset}}` : ""}`;
        });
        const joined = segments.join(" ");
        events.push({
          layer: layer + b, from, to, style: "Default", head: lineTags, clip: band ? band.clip : "",
          body: (ms) => shiftTransitions(joined, ms), alpha: textAlpha, kind: "text",
        });
      });
    });
    finish();
  });
  return out.join("\n") + "\n";
}

/** Font families the captions use, for loading in the page and handing to the export. */
export function usedFonts(captions) {
  const fonts = new Set([captions.style.font]);
  for (const o of Object.values(captions.overrides ?? {})) if (o.font) fonts.add(o.font);
  return [...fonts];
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Every visible caption in time order, across all tracks. */
export function buildSrt(captions) {
  const { words, perLine } = captions;
  const hidden = hiddenTracks(captions);
  const lines = groupLines(words, perLine);
  return lines
    .map((line, k) => ({ line, ...lineTimes(words, lines, k) }))
    .filter(({ line }) => !hidden.has(trackOf(words[line.from])))
    .sort((a, b) => a.start - b.start)
    .map(({ line, start, end }, k) => {
      const text = fileText(words.slice(line.from, line.to), lineStyle(captions, words, line));
      return `${k + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`;
    })
    .join("\n");
}

/** WebVTT: SRT's timing with a dot before the milliseconds, under a header. */
export function buildVtt(captions) {
  const cues = buildSrt(captions).split("\n\n").filter(Boolean);
  return "WEBVTT\n\n" + cues.map((c) => c.replace(/^\d+\n/, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")).join("\n\n") + "\n";
}
