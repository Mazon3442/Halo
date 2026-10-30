// Caption motion: turns an animation plugin's transforms into libass events.
//
// libass can't ease a position or follow an arbitrary curve, so animated stretches are baked a
// frame at a time: the caption's events are cut at every frame of the in and out (and of the hold,
// when a hold effect is on), and each piece is positioned, scaled, rotated, faded and blurred for
// its frame. Still stretches stay as single events, so files stay small. The same events go to the
// live preview and to ffmpeg, so what plays is what exports.

import { getPlugin, pluginParams } from "./plugins/registry.js";

export function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const round1 = (v) => Math.round(v * 10) / 10;
const hex2 = (a) => Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).toUpperCase().padStart(2, "0");

/** The plugin and complete settings a caption animates with, or null when it doesn't. */
export function resolveMotion(motion) {
  const plugin = motion?.plugin ? getPlugin(motion.plugin) : null;
  if (!plugin) return null;
  return { plugin, params: pluginParams(plugin, motion.params) };
}

/** The letters of a caption's text that animate one after another: everything but spaces. */
export function letterCount(text) {
  return [...text].filter((c) => !/\s/.test(c)).length;
}

/**
 * In and out lengths in seconds, squeezed to fit a caption of `duration`. When the animation
 * goes letter by letter, `tin` and `tout` cover every letter, `each` is one letter's share and
 * `gap` is how long each letter waits after the one before.
 */
export function phaseLengths(resolved, duration, fps, letters = 1) {
  if (!resolved) return { tin: 0, tout: 0, each: { tin: 0, tout: 0 }, gap: 0 };
  const d = resolved.plugin.durations(resolved.params) ?? {};
  let ein = Math.max(0, Number(d.in) || 0) / fps;
  let eout = Math.max(0, Number(d.out) || 0) / fps;
  let gap = letters > 1 ? Math.max(0, Number(resolved.plugin.stagger?.(resolved.params)) || 0) / fps : 0;
  let tin = ein > 0 ? ein + (letters - 1) * gap : 0;
  let tout = eout > 0 ? eout + (letters - 1) * gap : 0;
  if (tin + tout > duration) {
    const k = duration / (tin + tout);
    tin *= k;
    tout *= k;
    ein *= k;
    eout *= k;
    gap *= k;
  }
  return { tin, tout, each: { tin: ein, tout: eout }, gap: tin || tout ? gap : 0 };
}

/**
 * Moves the times of \t transitions back by `ms`, for a piece cut out of an event after its start.
 * Transitions already over are pinned at their end (libass reads an end of 0 as "the whole event").
 */
export function shiftTransitions(text, ms) {
  if (!ms) return text;
  return text.replace(/\\t\((-?\d+),(-?\d+),/g, (_, a, b) => {
    const t2 = Number(b) - ms;
    return t2 <= 0 ? "\\t(-2,-1," : `\\t(${Number(a) - ms},${t2},`;
  });
}

/** Fades, scales and blurs the override tags a caption's text carries, to match its frame. */
function adjustBody(text, { sx, sy, opacity, blur }) {
  let out = text;
  if (sx !== 1 || sy !== 1) {
    out = out.replace(/\\fsc([xy])(-?\d+(?:\.\d+)?)/g, (_, axis, v) => `\\fsc${axis}${round1(Number(v) * (axis === "x" ? sx : sy))}`);
  }
  if (opacity < 1) {
    out = out.replace(/\\(alpha|[1-4]a)&H([0-9A-F]{2})&/gi, (_, tag, v) => `\\${tag}&H${hex2(1 - (1 - parseInt(v, 16) / 255) * opacity)}&`);
  }
  if (blur > 0) out = out.replace(/\\blur(\d+(?:\.\d+)?)/g, (_, v) => `\\blur${round1(Number(v) + blur)}`);
  return out;
}

const ALPHA_TAG = /\\t\([^)]*\)|\\(?:alpha|[1-4]a)&H[0-9A-F]{2}&/gi;
const HIDE = "{\\alpha&HFF&}";

/**
 * The text with only the letters in `show` (counted without spaces) visible. The rest are made
 * transparent rather than removed, so the line lays out exactly as it does whole. `restore` is the
 * opacity the event starts with; the text's own opacity tags are replayed after it.
 */
function showOnly(text, show, restore) {
  let out = "";
  let replay = "";
  let hidden = false;
  let k = 0;
  for (const part of text.match(/\{[^}]*\}|[^{]+/g) ?? []) {
    if (part[0] === "{") {
      out += part;
      const tags = (part.match(ALPHA_TAG) ?? []).filter((t) => !t.startsWith("\\t") || /\\(alpha|[1-4]a)&H/i.test(t));
      replay += tags.join("");
      if (hidden && tags.length) out += HIDE;
      continue;
    }
    for (const ch of part) {
      if (!/\s/.test(ch)) {
        const visible = show.has(k++);
        if (visible && hidden) out += `{${restore}${replay}}`;
        else if (!visible && !hidden) out += HIDE;
        hidden = !visible;
      }
      out += ch;
    }
  }
  return out;
}

/**
 * Writes one caption line's events into `out`.
 *
 * `events` are the line's pieces as captions.js builds them: { layer, from, to, style, head, body,
 * alpha: { c1, c3, c4 } resting opacities, clip, kind: "text" | "box" }, where body(ms) gives the
 * text for a piece starting `ms` into the event. `anchor` is the bottom-centre of the resting
 * caption, `box` its rough size, and `spacing` its letter spacing in pixels. `letters` is how many
 * letters the line has, for animations that go letter by letter.
 */
export function writeLine(out, { events, start, end, anchor, size, box, frame, fps, motion, seed, spacing, letters = 1 }) {
  const lengths = phaseLengths(motion, end - start, fps, letters);
  const pieces = plan(start, end, fps, motion, lengths);
  const ctxBase = { size, box, frame, fps, seed, lineDuration: end - start };
  const byLetter = lengths.gap > 0;
  const holdDuration = Math.max(0, end - start - lengths.tin - lengths.tout);
  const stateAt = (t) => {
    const { tin, tout } = lengths;
    const holdTime = Math.min(holdDuration, Math.max(0, t - start - tin));
    if (tin > 0 && t < start + tin) return { phase: "in", progress: Math.max(0, (t - start) / tin), holdTime };
    if (tout > 0 && t > end - tout) return { phase: "out", progress: Math.min(1, (t - (end - tout)) / tout), holdTime };
    return { phase: "hold", progress: 0, holdTime };
  };
  const transformAt = (t) => (motion ? motion.plugin.frame(motion.params, { ...ctxBase, ...stateAt(t), holdDuration }) ?? {} : {});
  // Letter by letter, each letter runs its own in and out, `gap` after the letter before it. Only
  // moves, fades, blurs and masks apply to single letters; the rest would need each letter's place.
  const letterAt = (t, i) => {
    const { each, gap, tout } = lengths;
    const line = stateAt(t);
    const a = start + i * gap;
    const b = end - tout + i * gap;
    let state = { ...line, phase: "hold", progress: 0 };
    if (each.tin > 0 && t < a + each.tin) state = { ...line, phase: "in", progress: Math.min(1, Math.max(0, (t - a) / each.tin)) };
    else if (each.tout > 0 && t > b) state = { ...line, phase: "out", progress: Math.min(1, Math.max(0, (t - b) / each.tout)) };
    const f = motion.plugin.frame(motion.params, { ...ctxBase, ...state, holdDuration }) ?? {};
    return { x: round1(f.x ?? 0), y: round1(f.y ?? 0), opacity: Math.round(Math.min(1, Math.max(0, f.opacity ?? 1)) * 255) / 255, blur: round1(f.blur ?? 0), mask: f.mask };
  };
  const blurSpec = byLetter ? null : motion?.plugin.motionBlur?.(motion.params) ?? null;

  for (const piece of pieces) {
    const tf = piece.still ? {} : transformAt(piece.at);
    let mbBlur = 0;
    const ghosts = [];
    if (blurSpec && !piece.still) {
      // Motion blur: soften by how far the caption moves while the shutter is open, and leave
      // fading copies along the path it came from.
      const open = (blurSpec.shutter / 360) / fps;
      const a = transformAt(Math.max(start, piece.at - open / 2));
      const b = transformAt(Math.min(end, piece.at + open / 2));
      const travel = Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0))
        + Math.abs((b.scale ?? 1) - (a.scale ?? 1)) * box.h
        + (Math.abs((b.rotate ?? 0) - (a.rotate ?? 0)) * Math.PI / 180) * box.w * 0.5;
      mbBlur = Math.min(size * 0.6, blurSpec.strength * travel * 0.5);
      for (let k = 1; k <= blurSpec.samples && travel > 1; k++) {
        const g = transformAt(Math.max(start, piece.at - (open * k) / blurSpec.samples));
        if (Math.hypot((g.x ?? 0) - (tf.x ?? 0), (g.y ?? 0) - (tf.y ?? 0)) < 0.5) continue;
        ghosts.push({ tf: g, alpha: 0.5 * blurSpec.strength * (1 - k / (blurSpec.samples + 1)) });
      }
    }
    for (const ev of events) {
      const from = Math.max(piece.t0, ev.from);
      const to = Math.min(piece.t1, ev.to);
      const t0 = assTime(from);
      const t1 = assTime(to);
      if (to <= from || t0 === t1) continue;
      const body = ev.body(Math.round((from - ev.from) * 1000));
      const write = (f, alphaMul, extraBlur, show = null) => {
        const { tags, adjust } = transformTags(f, ev, { anchor, box, size, frame, spacing, alphaMul, blur: extraBlur });
        let text = adjust ? adjustBody(body, adjust) : body;
        if (show) text = showOnly(text, show, alphaTags(ev.alpha, Math.min(1, Math.max(0, f.opacity ?? 1)) * alphaMul));
        out.push(`Dialogue: ${ev.layer},${t0},${t1},${ev.style},,0,0,0,,{\\an2${tags.pos}${ev.head}${tags.rest}}${text}`);
      };
      if (byLetter && !piece.still) {
        // The box fades with the line as a whole. Letters that share a frame share an event.
        if (ev.kind === "box") { write({ opacity: tf.opacity }, 1, 0); continue; }
        const groups = new Map();
        for (let i = 0; i < letters; i++) {
          const f = letterAt(piece.at, i);
          if (f.opacity <= 0) continue;
          const key = JSON.stringify(f);
          if (!groups.has(key)) groups.set(key, { f, show: new Set() });
          groups.get(key).show.add(i);
        }
        for (const { f, show } of groups.values()) write(f, 1, 0, show.size === letters ? null : show);
        continue;
      }
      if (ev.kind !== "box") for (const g of ghosts.slice().reverse()) write(g.tf, g.alpha, mbBlur);
      write(tf, 1, mbBlur);
    }
  }
}

/** The cut points of a line: one still piece, or a piece per frame wherever it moves. */
function plan(start, end, fps, motion, { tin, tout }) {
  if (!motion) return [{ t0: start, t1: end, at: start, still: true }];
  const holds = !!motion.plugin.animatesHold?.(motion.params);
  const pieces = [];
  const cut = (a, b, n, evalAtEnd) => {
    for (let i = 0; i < n; i++) {
      const t0 = a + ((b - a) * i) / n;
      const t1 = a + ((b - a) * (i + 1)) / n;
      pieces.push({ t0, t1, at: evalAtEnd ? t1 : t0 });
    }
  };
  if (tin > 0) cut(start, start + tin, Math.max(1, Math.round(tin * fps)), false);
  const h0 = start + tin;
  const h1 = end - tout;
  if (h1 > h0) {
    if (holds) cut(h0, h1, Math.max(1, Math.ceil((h1 - h0) * fps)), false);
    else pieces.push({ t0: h0, t1: h1, at: h0, still: !tin && !tout });
  }
  // Out pieces show the end of their frame, so the last one is fully gone.
  if (tout > 0) cut(h1, end, Math.max(1, Math.round(tout * fps)), true);
  return pieces;
}

/** Override tags for the four opacities of an event at rest, times `opacity`. */
function alphaTags({ c1, c3, c4 }, opacity) {
  const a1 = hex2(1 - c1 * opacity);
  return `\\1a&H${a1}&\\2a&H${a1}&\\3a&H${hex2(1 - c3 * opacity)}&\\4a&H${hex2(1 - c4 * opacity)}&`;
}

/**
 * Tags for one frame of a transform. Scale grows from the caption's centre (libass scales from the
 * anchor, so the position makes up the difference) and rotation turns around the centre too.
 */
function transformTags(tf, ev, { anchor, box, size, frame, spacing, alphaMul, blur }) {
  const scale = tf.scale ?? 1;
  const sx = scale * (tf.scaleX ?? 1);
  const sy = scale * (tf.scaleY ?? 1);
  const x = anchor.x + (tf.x ?? 0);
  const y = anchor.y + (tf.y ?? 0) + ((1 - sy) * box.h) / 2;
  const pos = `\\pos(${round1(x)},${round1(y)})`;
  let rest = "";
  if (tf.rotate || tf.rotateX || tf.rotateY) {
    rest += `\\org(${round1(x)},${round1(y - (box.h * sy) / 2)})`;
    if (tf.rotate) rest += `\\frz${round1(-tf.rotate)}`;
    if (tf.rotateX) rest += `\\frx${round1(tf.rotateX)}`;
    if (tf.rotateY) rest += `\\fry${round1(tf.rotateY)}`;
  }
  if (tf.skew) rest += `\\fax${Math.round(tf.skew * 100) / 100}`;
  if (sx !== 1) rest += `\\fscx${round1(sx * 100)}`;
  if (sy !== 1) rest += `\\fscy${round1(sy * 100)}`;
  if (tf.tracking) rest += `\\fsp${round1(spacing + tf.tracking * size)}`;
  const totalBlur = Math.max(0, (tf.blur ?? 0) + (blur ?? 0));
  if (totalBlur > 0.05) rest += `\\blur${round1(totalBlur)}`;
  const opacity = Math.min(1, Math.max(0, tf.opacity ?? 1)) * alphaMul;
  if (opacity < 1) rest += alphaTags(ev.alpha, opacity);
  if (ev.clip) rest += ev.clip;
  else if (tf.mask) rest += maskClip(tf.mask, anchor, box, size, frame);
  const adjust = sx !== 1 || sy !== 1 || opacity < 1 || totalBlur > 0.05 ? { sx, sy, opacity, blur: totalBlur } : null;
  return { tags: { pos, rest }, adjust };
}

/** A clip that hides everything past one edge of the resting caption. */
function maskClip(side, anchor, box, size, frame) {
  const pad = Math.round(size * 0.18);
  const W = frame.w;
  const H = frame.h;
  const top = Math.round(anchor.y - box.h - pad);
  const bottom = Math.round(anchor.y + pad);
  const left = Math.round(anchor.x - box.w / 2 - pad);
  const right = Math.round(anchor.x + box.w / 2 + pad);
  if (side === "bottom") return `\\clip(0,${-H},${W * 2},${bottom})`;
  if (side === "top") return `\\clip(0,${top},${W * 2},${H * 2})`;
  if (side === "left") return `\\clip(${left},${-H},${W * 2},${H * 2})`;
  return `\\clip(${-W},${-H},${right},${H * 2})`;
}
