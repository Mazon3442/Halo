// Captions are a list of timed words. These helpers group them into lines, apply edits, and write
// the ASS subtitle file (rendered live by libass in the page and burned in by ffmpeg) and SRT.


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
      // Otherwise break on the word limit, sentence ends, pauses, and lines running long.
      while (j < words.length && words[j].group == null && j - i < perLine) {
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
  if (next && words[next.from].start - end < 0.3) end = words[next.from].start;
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

/** SRT timestamp, HH:MM:SS,mmm (or HH:MM:SS.mmm), to seconds. */
function parseSrtTime(s) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[4].padEnd(3, "0"));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/**
 * Brings captions in from an SRT file (YouTube, Premiere, anywhere): one block per caption,
 * timing lines skipped, words spread over the line's span the way live transcription does.
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
    const tokens = lines.slice(t + 1).join(" ").split(/\s+/).filter(Boolean);
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
function spread(captions, tokens, start, end, group) {
  const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
  let t = start;
  return tokens.map((text) => {
    const d = ((end - start) * text.length) / total;
    const w = { id: nextId(captions), text, start: t, end: t + d, group };
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
    : spread(captions, tokens, old[0].start, old[old.length - 1].end, group);
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

/** Adds a new caption line; returns the id of its first word. */
export function insertLine(captions, start, end, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const added = spread(captions, tokens, start, end, nextGroup(captions));
  const at = captions.words.findIndex((w) => w.start >= start);
  captions.words.splice(at < 0 ? captions.words.length : at, 0, ...added);
  return added[0].id;
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

function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
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
  return override ? { ...captions.style, ...override } : captions.style;
}

/**
 * The subtitle file used both for the live overlay (libass in the page) and for burning into
 * the export (libass in ffmpeg). Each caption is one event per spoken word, showing the whole
 * line with that word styled; karaoke and outline are one event per line using libass's own fill timing.
 */
export function buildAss(captions, width, height) {
  if (!captions.style.invert) return buildTrack(captions, width, height);
  // Inverted captions keep their outline, shadow and box as ordinary drawing under the
  // letters, with the letters themselves left empty for the inverted video (see buildMask).
  const { outline, shadow, box } = captions.style;
  if (!(outline > 0 || shadow > 0 || box)) return null;
  return buildTrack({ ...captions, style: { ...captions.style, gradient: "none" } }, width, height)
    .replace(/^(Style: Default,[^,]*,[^,]*,)&H..(\w{6}&),&H..(\w{6}&)/m, "$1&HFF$2,&HFF$3")
    // Animations fade with \alpha, which would bring the letters back; fade the rest only.
    .replace(/\\alpha(&H[0-9A-F]{2}&)/gi, "\\3a$1\\4a$1");
}

/**
 * For inverted captions, the letters alone in plain white: the mask through which the video
 * shows with its brightness flipped. Null when the captions aren't inverted.
 */
export function buildMask(captions, width, height) {
  if (!captions.style.invert) return null;
  const plain = { fill: "#ffffff", highlight: "#ffffff" };
  return buildTrack({
    ...captions,
    style: { ...captions.style, ...plain, outline: 0, shadow: 0, box: false, gradient: "none" },
    overrides: Object.fromEntries(Object.entries(captions.overrides ?? {}).map(([g, o]) => [g, { ...o, ...plain }])),
    words: captions.words.map(({ color, ...w }) => w),
  }, width, height);
}

function buildTrack(captions, width, height) {
  const { words, perLine } = captions;
  const base = captions.style;
  const W = width || 1920;
  const H = height || 1080;
  const short = Math.min(W, H);
  const fs = (st) => Math.max(8, Math.round(st.size * short));
  const size = fs(base);
  const marginH = Math.round(((1 - base.width) / 2) * W);
  const outlinePx = (st) => Math.round(st.outline * fs(st) * 10) / 10;
  const karaoke = base.wordStyle === "karaoke";
  const outline = base.wordStyle === "outline";

  const style = [
    "Default",
    base.font,
    size,
    outline ? assColor(base.fill, base.fillOpacity ?? 1) : karaoke ? assColor(base.highlight) : assColor(base.fill),
    outline ? assColor(base.fill, 0) : assColor(base.fill),
    assColor(base.outlineColor),
    assColor(base.shadowColor, base.shadowOpacity),
    0, 0, 0, 0, 100, 100,
    Math.round(base.spacing * size * 10) / 10,
    0, 1,
    outlinePx(base),
    Math.round(base.shadow * size * 10) / 10,
    2, marginH, marginH, 0, 1,
  ].join(",");
  // The background box is its own layer of invisible text in one run, so libass draws one box
  // per row. Boxes drawn behind each styled word would overlap and darken where words meet.
  const boxStyle = [
    "Box", base.font, size, assColor("#ffffff", 0), assColor("#ffffff", 0),
    assColor(base.boxColor, base.boxOpacity), assColor(base.boxColor, base.boxOpacity),
    0, 0, 0, 0, 100, 100, Math.round(base.spacing * size * 10) / 10, 0, 3,
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
    ...(base.box ? [`Style: ${boxStyle}`] : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const lines = groupLines(words, perLine);
  lines.forEach((line, k) => {
    const { start, end } = lineTimes(words, lines, k);
    const st = lineStyle(captions, words, line);
    const lineWords = words.slice(line.from, line.to);
    const x = Math.round(st.x * W);
    const y = Math.round(st.y * H);
    const size = fs(st);
    const ob = outlinePx(st);
    const display = (w) => assEscape(base.uppercase ? w.text.toLocaleUpperCase() : w.text);
    // Per-line overrides of size and colour come first so the whole line picks them up.
    const lineTags = (st.size !== base.size ? `\\fs${size}` : "");
    const box = (from, to, head) => {
      if (!base.box) return;
      // Entrances fade with \alpha, which would also show the hidden text and make the box
      // opaque, so the box fades only its own colours, up to its set opacity.
      const shown = assColor(base.boxColor, base.boxOpacity).slice(0, 4) + "&";
      const fades = head.replace(/\\alpha&H00&/g, `\\3a${shown}\\4a${shown}`).replace(/\\alpha&HFF&/g, "\\3a&HFF&\\4a&HFF&");
      out.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Box,,0,0,0,,${fades}${lineWords.map(display).join(" ")}`);
    };
    const layer = base.box ? 1 : 0;

    const entrance = (first, last) => {
      let tags = "";
      if (first && st.entrance === "slide") {
        const d = Math.round(size * 0.6);
        tags += `\\move(${x},${y + d},${x},${y},0,160)\\alpha&HFF&\\t(0,160,\\alpha&H00&)`;
      } else {
        tags += `\\pos(${x},${y})`;
      }
      if (first && st.entrance === "pop") tags += "\\fscx80\\fscy80\\t(0,110,\\fscx100\\fscy100)";
      if (first && st.entrance === "pop-up") {
        // Springs up from below: overshoots, then settles at full size.
        tags = tags.replace(/\\pos\([^)]*\)/, `\\move(${x},${y + Math.round(size * 0.35)},${x},${y},0,150)`);
        tags += "\\fscx40\\fscy40\\alpha&HFF&\\t(0,90,\\alpha&H00&)\\t(0,150,\\fscx110\\fscy110)\\t(150,240,\\fscx100\\fscy100)";
      }
      if (first && st.entrance === "bounce") tags += "\\fscx55\\fscy55\\t(0,120,\\fscx112\\fscy112)\\t(120,200,\\fscx100\\fscy100)";
      if (st.entrance === "fade") tags += `\\fad(${first ? 140 : 0},${last ? 120 : 0})`;
      return tags;
    };

    if (karaoke || outline) {
      // One event; libass sweeps each word from the secondary colour to the primary as it's spoken
      // (outline fills transparent words to a frosted fill; karaoke sweeps fill to highlight).
      const parts = lineWords.map((w, i) => {
        const next = i < lineWords.length - 1 ? lineWords[i + 1].start : end;
        const cs = Math.max(1, Math.round((next - w.start) * 100));
        return `{\\kf${cs}}${display(w)}`;
      });
      const head = `{\\an2${entrance(true, true)}${lineTags}}`;
      box(start, end, head);
      out.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},Default,,0,0,0,,${head}${parts.join(" ")}`);
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
      const first = i === 0;
      const last = i === lineWords.length - 1;
      // An entrance that scales the line already makes the first word pop.
      const scaleEntrance = first && (st.entrance === "pop" || st.entrance === "bounce" || st.entrance === "pop-up");
      box(from, to, `{\\an2${entrance(first, last)}${lineTags}}`);
      bands.forEach((band, b) => {
        const colorOf = (w) => band?.color ?? w.color ?? st.fill;
        const segments = lineWords.map((w, j) => {
          // Words after this one only ever follow it, so their opacity needs no reset.
          if (hidesAhead && j > i) return `{\\alpha&HFF&}${display(w)}`;
          if (st.wordStyle === "dim" && j > i) return `{\\c${tagColor(colorOf(w))}\\alpha&H99&}${text(w, j)}`;
          if (j !== i || st.wordStyle === "none" || st.wordStyle === "dim") return `{\\c${tagColor(colorOf(w))}}${text(w, j)}`;
          // A gradient is the colour, so the spoken word stands out by its animation instead.
          const painted = band || across;
          let tags = painted ? `\\c${tagColor(colorOf(w))}` : "";
          let reset = "";
          if (st.wordStyle === "color" || st.wordStyle === "reveal") {
            if (!painted) tags += `\\c${tagColor(st.highlight)}`;
          } else if (st.wordStyle === "box") {
            // A thick outline in the highlight colour reads as a rounded box behind the word.
            tags += `\\c${tagColor(painted ? colorOf(w) : readableOn(st.highlight))}\\3c${tagColor(st.highlight)}\\bord${Math.round(size * 0.2)}`;
            reset += `\\3c${tagColor(base.outlineColor)}\\bord${ob}`;
          } else if (st.wordStyle === "glow") {
            tags += `\\c${tagColor(colorOf(w))}\\3c${tagColor(st.highlight)}\\bord${Math.round(size * 0.1)}\\blur${Math.round(size * 0.12)}`;
            reset += `\\3c${tagColor(base.outlineColor)}\\bord${ob}\\blur0`;
          } else if (st.wordStyle === "blur") {
            // Comes into focus as it fades in, the way Apple's captions do.
            tags += `\\c${tagColor(colorOf(w))}\\alpha&HFF&\\blur${Math.round(size * 0.18)}\\t(0,240,\\alpha&H00&\\blur0)`;
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
        const head = `{\\an2${entrance(first, last)}${lineTags}${band ? band.clip : ""}}`;
        out.push(`Dialogue: ${layer + b},${assTime(from)},${assTime(to)},Default,,0,0,0,,${head}${segments.join(" ")}`);
      });
    });
  });
  return out.join("\n") + "\n";
}

/** Font families the captions use, for loading in the page and handing to the export. */
export function usedFonts(captions) {
  return [captions.style.font];
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function buildSrt(captions) {
  const { words, perLine } = captions;
  const lines = groupLines(words, perLine);
  return lines
    .map((line, k) => {
      const { start, end } = lineTimes(words, lines, k);
      const text = words.slice(line.from, line.to).map((w) => w.text).join(" ");
      return `${k + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`;
    })
    .join("\n");
}

/** WebVTT: SRT's timing with a dot before the milliseconds, under a header. */
export function buildVtt(captions) {
  const cues = buildSrt(captions).split("\n\n").filter(Boolean);
  return "WEBVTT\n\n" + cues.map((c) => c.replace(/^\d+\n/, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")).join("\n\n") + "\n";
}
