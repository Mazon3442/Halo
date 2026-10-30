// The timeline: a ruler with the playhead, stacked caption tracks you edit directly, a colour
// track of graded sections, and the video and audio tracks for reference. It behaves like the
// timeline of an editor: drag captions in time or up and down the tracks, Alt-drag to copy, copy and
// paste, right-click for more, lock and hide tracks, and drag a selected caption's top corners to
// set how long it animates in and out. Caption blocks are DOM elements; the ruler, thumbnails and
// waveform are canvases drawn only for the visible stretch, so long videos stay cheap at any zoom.

import { api } from "./api.js";
import {
  MIN_WORD, copyLines, deleteLines, editLine, groupLines, insertLine, lineStyle, lineTimes, lockLine, mergeLines,
  moveLines, nextTrackId, pasteLines, readingSpeed, retimeLine, rippleDelete, setWordBoundary, shiftTracks, splitLine, trackOf,
} from "./captions.js";
import { freeSpan } from "./grade.js";
import { phaseLengths, resolveMotion } from "./motion.js";

const $ = (id) => document.getElementById(id);
const MAX_PX_PER_SEC = 800;
const SNAP_PX = 8;
const EDGE_PX = 6;
const DRAG_THRESHOLD_PX = 3;
const NEW_CAPTION_SECS = 1.5;
/** The shortest a graded section may be. */
const MIN_GRADE_SECS = 0.2;
/** Where Top, Middle and Bottom put a caption, as the height of its baseline. */
const PLACES = { top: 0.24, middle: 0.56, bottom: 0.8 };
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
/** Marker colours, as in Resolve's marker menu. */
export const MARKER_COLORS = { blue: "#5aa9ff", green: "#5fd38d", yellow: "#ffd43b", red: "#ff6b6b", purple: "#b18cff", orange: "#ff9f43" };

/** A time as YouTube writes chapter times: m:ss, or h:mm:ss past an hour. */
function chapterTime(t) {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Keeps a drag going when the pointer leaves the element. */
function capture(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* not a live pointer; the drag still works inside */ }
}

function label(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return step < 1 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(s)).padStart(2, "0")}`;
}

function newTrack(captions) {
  return { id: nextTrackId(captions), name: `Captions ${captions.tracks.length + 1}`, hidden: false, locked: false };
}

export class Timeline {
  px = 50;
  snapping = true;
  /** Selected lines, by the id of their first word. */
  selection = new Set();
  /** The selected graded section's id, or null. */
  gradeSelection = null;
  #media = null;
  #duration = 0;
  #lines = [];
  #waveform = null;
  #thumbs = null;
  #drawQueued = false;
  #drag = null;
  /** True while showing the whole video, so resizing the window keeps it fitted. */
  #fitted = true;
  /** Caption rows by track id, and the track list they were built for. */
  #rows = new Map();
  #trackKey = null;
  /** Copied captions, for pasting at the playhead or onto a track. */
  #clipboard = null;
  /** The caption being typed into: its text field and first word's id, kept across redraws. */
  #editing = null;

  constructor({ store, video, toast, onSelectionChange, onSeek, onGradeSelect }) {
    this.store = store;
    this.onGradeSelect = onGradeSelect;
    /** Colour-track actions the panel fills in: add a grade (at a time, optionally drawn out to
        another), split at the playhead, remove a grade, reset a look. */
    this.onGradeAdd = null;
    this.onGradeSplit = null;
    this.onGradeDelete = null;
    this.onGradeReset = null;
    this.onGradeBypass = null;
    this.onGradeCopy = null;
    this.onGradePaste = null;
    this.onGradeRename = null;
    this.onGradeMatchPrevious = null;
    this.hasGradeClipboard = () => false;
    /** Set by the app to make the toolbar's Split button context-aware. */
    this.onSplitRequest = null;
    this.grades = $("tl-grades");
    this.video = video;
    this.toast = toast;
    this.onSelectionChange = onSelectionChange;
    this.onSeek = onSeek;
    this.scroll = $("tl-scroll");
    this.content = $("tl-content");
    this.tracksBox = $("tl-caption-rows");
    this.heads = $("tl-caption-heads");
    this.newTrackRow = $("tl-new-track");
    this.playhead = $("tl-playhead");
    this.markerLayer = $("tl-markers");
    this.rangeBand = $("tl-range");
    this.canvases = { ruler: $("tl-ruler"), video: $("tl-video"), audio: $("tl-audio") };
    this.#bind();
    new ResizeObserver(() => {
      if (this.#fitted) this.fit();
      else { this.#layout(); this.draw(); }
    }).observe(this.scroll);
  }

  get #captions() { return this.store.doc?.captions; }
  get #fps() { return this.#media?.fps || 30; }

  /* ---------- opening ---------- */

  async open(media) {
    this.#media = media;
    this.#duration = media.duration || 0;
    this.#waveform = null;
    this.#thumbs = null;
    this.selection.clear();
    this.fit();
    const forId = media.id;
    api.get(`/media/${media.id}/waveform`).then((w) => {
      if (this.#media?.id !== forId) return;
      this.#waveform = w;
      this.draw();
    }).catch(() => {});
    const count = Math.min(300, Math.max(24, Math.ceil(this.#duration * 2)));
    api.raw(`/media/${media.id}/thumbnails?count=${count}&height=48`).then(async (res) => {
      const columns = Number(res.headers.get("x-thumb-columns"));
      const width = Number(res.headers.get("x-thumb-width"));
      const image = await createImageBitmap(await res.blob());
      if (this.#media?.id !== forId) return;
      this.#thumbs = { image, columns, width, count };
      this.draw();
    }).catch(() => {});
  }

  close() {
    this.#media = null;
    this.selection.clear();
    this.gradeSelection = null;
    for (const row of this.#rows.values()) row.replaceChildren();
    this.grades.replaceChildren();
  }

  /* ---------- zoom and scroll ---------- */

  get #viewWidth() { return this.scroll.clientWidth; }
  get #minPx() { return this.#duration ? (this.#viewWidth - 24) / this.#duration : 50; }

  fit() {
    this.setZoom(this.#minPx, 0, 0);
    this.scroll.scrollLeft = 0;
    this.#fitted = true;
  }

  /** Zooms keeping `anchorTime` under the same x position in the view. */
  setZoom(px, anchorTime = this.video.currentTime, anchorX = null) {
    const min = this.#minPx;
    this.px = Math.min(MAX_PX_PER_SEC, Math.max(min, px));
    this.#fitted = this.px <= min + 1e-6;
    const x = anchorX ?? anchorTime * this.px - this.scroll.scrollLeft;
    this.#layout();
    this.scroll.scrollLeft = anchorTime * this.px - x;
    const zoom = $("tl-zoom");
    zoom.value = String(Math.round((Math.log(this.px / min) / Math.log(MAX_PX_PER_SEC / min)) * 100) || 0);
    this.renderBlocks();
    this.draw();
  }

  zoomBy(factor, anchorTime, anchorX) { this.setZoom(this.px * factor, anchorTime, anchorX); }

  #layout() {
    const width = Math.max(this.#viewWidth, this.#duration * this.px + 24);
    this.content.style.width = `${width}px`;
    this.updatePlayhead(this.video.currentTime);
  }

  #timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return Math.min(this.#duration, Math.max(0, (clientX - r.left + this.scroll.scrollLeft) / this.px));
  }

  /* ---------- playhead ---------- */

  updatePlayhead(t, follow = false) {
    const x = t * this.px;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (!follow) return;
    // Page along with playback, the way Premiere does.
    const left = this.scroll.scrollLeft;
    if (x > left + this.#viewWidth - 24 || x < left) this.scroll.scrollLeft = Math.max(0, x - 24);
  }

  /** Times the playhead stops at on the way past: caption and grade edges. */
  #editPoints() {
    const words = this.#captions?.words ?? [];
    const points = [0, this.#duration];
    for (const l of this.#lines) points.push(words[l.from].start, words[l.to - 1].end);
    for (const s of this.store.doc?.grade?.sections ?? []) points.push(s.start, s.end);
    return points.sort((a, b) => a - b);
  }

  /** The previous or next edit point from the playhead, for Up and Down. */
  editPoint(dir) {
    const t = this.video.currentTime;
    const points = this.#editPoints();
    const found = dir > 0 ? points.find((p) => p > t + 1e-3) : points.reverse().find((p) => p < t - 1e-3);
    return found ?? null;
  }

  /* ---------- tracks ---------- */

  #tracks() { return this.#captions?.tracks ?? []; }
  #rankOf(id) { return this.#tracks().findIndex((t) => t.id === id); }
  #trackById(id) { return this.#tracks().find((t) => t.id === id) ?? null; }
  #isLocked(id) { return !!this.#trackById(id)?.locked; }
  #lineTrack(line) { return trackOf(this.#captions.words[line.from]); }

  /** Rebuilds the caption rows and their headers when the track list changes. */
  #renderTracks() {
    const tracks = this.#tracks();
    const key = JSON.stringify(tracks);
    if (key === this.#trackKey && this.#rows.size) return;
    this.#trackKey = key;
    this.#rows.clear();
    this.heads.replaceChildren();
    this.tracksBox.replaceChildren();
    // The top track first, as video tracks stack in an editor: higher tracks draw over lower ones.
    for (let r = tracks.length - 1; r >= 0; r--) {
      const t = tracks[r];
      const head = document.createElement("div");
      head.className = "tl-head captions";
      head.dataset.track = t.id;
      head.classList.toggle("is-hidden", !!t.hidden);
      head.classList.toggle("is-locked", !!t.locked);
      const tag = document.createElement("b");
      tag.textContent = `C${r + 1}`;
      const name = document.createElement("span");
      name.className = "tl-track-name";
      name.textContent = t.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", () => this.#renameTrack(t.id, name));
      const button = (icon, pressed, title, onClick) => {
        const b = document.createElement("button");
        b.className = "tl-track-btn";
        b.setAttribute("aria-pressed", String(pressed));
        b.title = title;
        b.setAttribute("aria-label", `${title}: C${r + 1}`);
        b.innerHTML = `<svg class="icon"><use href="${icon}"/></svg>`;
        b.addEventListener("click", onClick);
        return b;
      };
      const eye = button(t.hidden ? "#i-eye-off" : "#i-eye", !!t.hidden, t.hidden ? "Show this track" : "Hide this track", () => this.setTrack(t.id, { hidden: !t.hidden }));
      const lock = button(t.locked ? "#i-lock" : "#i-unlock", !!t.locked, t.locked ? "Unlock this track" : "Lock this track", () => this.setTrack(t.id, { locked: !t.locked }));
      head.append(tag, name, eye, lock);
      head.addEventListener("contextmenu", (ev) => this.#trackContext(ev, t.id));
      this.heads.append(head);

      const row = document.createElement("div");
      row.className = "tl-row captions";
      row.dataset.track = t.id;
      row.classList.toggle("is-hidden", !!t.hidden);
      row.classList.toggle("is-locked", !!t.locked);
      row.title = t.locked ? `${t.name} is locked` : "Double-click empty space to add a caption";
      this.tracksBox.append(row);
      this.#rows.set(t.id, row);
    }
  }

  setTrack(id, patch) {
    this.store.update((d) => {
      const t = d.captions.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
    if (patch.locked) {
      // Captions on a locked track can't be edited, so they can't stay selected either.
      const words = this.#captions.words;
      this.select(this.#lines.filter((l) => this.selection.has(words[l.from].id) && trackOf(words[l.from]) !== id).map((l) => words[l.from].id));
    }
  }

  /** Adds an empty track on top and returns its id. */
  addTrack() {
    let id = null;
    this.store.update((d) => {
      const t = newTrack(d.captions);
      d.captions.tracks.push(t);
      id = t.id;
    });
    return id;
  }

  deleteTrack(id) {
    const tracks = this.#tracks();
    if (tracks.length < 2) return this.toast("There has to be at least one caption track.");
    const t = this.#trackById(id);
    this.store.update((d) => {
      d.captions.words = d.captions.words.filter((w) => trackOf(w) !== id);
      d.captions.tracks = d.captions.tracks.filter((x) => x.id !== id);
    });
    this.toast(`Deleted the track “${t?.name}” and its captions.`, { action: "Undo", onAction: () => this.store.undo() });
  }

  #renameTrack(id, nameEl) {
    const t = this.#trackById(id);
    if (!t) return;
    const input = document.createElement("input");
    input.className = "tl-track-input";
    input.value = t.name;
    input.setAttribute("aria-label", "Track name");
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== t.name) this.setTrack(id, { name: v.slice(0, 40) });
      else { this.#trackKey = null; this.renderBlocks(); }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  /** Which track row is at a height on screen; one past the top is the "new track" strip. */
  #rankAt(clientY) {
    const tracks = this.#tracks();
    if (clientY < this.newTrackRow.getBoundingClientRect().bottom) return tracks.length;
    for (const [id, row] of this.#rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return this.#rankOf(id);
    }
    return 0;
  }

  #rowTop(rank) {
    const tracks = this.#tracks();
    const el = rank >= tracks.length ? this.newTrackRow : this.#rows.get(tracks[rank].id);
    return el.getBoundingClientRect().top;
  }

  /**
   * Whether spans ({ rank, start, end }) fit where they'd go: inside the video, clear of the captions
   * already on their tracks (apart from the lines in `ignore`), and not on a locked track.
   */
  #fits(spans, ignore = new Set()) {
    const tracks = this.#tracks();
    const words = this.#captions.words;
    for (const s of spans) {
      if (s.start < -1e-6 || s.end > this.#duration + 1e-6) return false;
      if (s.rank >= tracks.length) continue;
      const id = tracks[s.rank].id;
      if (tracks[s.rank].locked) return false;
      for (const l of this.#lines) {
        if (ignore.has(l.from) || trackOf(words[l.from]) !== id) continue;
        if (words[l.to - 1].end > s.start + 1e-6 && words[l.from].start < s.end - 1e-6) return false;
      }
    }
    return true;
  }

  /* ---------- caption blocks ---------- */

  renderBlocks() {
    this.renderGrades();
    this.#renderMarkers();
    const cap = this.#captions;
    this.#renderTracks();
    // A redraw while a caption's being typed into (the timeline refitting as a new track
    // appears, say) moves its text field to the new block instead of ending the edit.
    const editing = this.#editing;
    if (editing) editing.moving = true;
    for (const row of this.#rows.values()) row.replaceChildren();
    if (editing) editing.moving = false;
    if (!cap || !this.#media) { this.#lines = []; this.#status(); return; }
    const { words } = cap;
    this.#lines = groupLines(words, cap.perLine);
    const ids = new Set(this.#lines.map((l) => words[l.from].id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    const fps = this.#fps;

    this.#lines.forEach((line, k) => {
      const { start, end } = lineTimes(words, this.#lines, k);
      const id = words[line.from].id;
      const track = trackOf(words[line.from]);
      const row = this.#rows.get(track);
      if (!row) return;
      const el = document.createElement("div");
      el.className = "tl-clip";
      el.dataset.k = k;
      el.dataset.track = track;
      el.style.left = `${start * this.px}px`;
      el.style.width = `${Math.max(2, (end - start) * this.px)}px`;
      const selected = this.selection.has(id);
      el.classList.toggle("selected", selected);
      el.title = words.slice(line.from, line.to).map((w) => w.text).join(" ");
      const speed = readingSpeed(el.title, start, end);
      if (speed.fast) {
        el.classList.add("fast");
        el.title += ` · ${Math.round(speed.cps)} characters a second, faster than most people read`;
      }
      const group = words[line.from].group;
      const own = group != null ? cap.overrides?.[group] : null;
      const placed = own?.y;
      if (placed != null) {
        // Captions moved on their own show where they sit.
        el.dataset.place = placed < 0.4 ? "↑" : placed < 0.68 ? "•" : "↓";
        el.title += placed < 0.4 ? " (top)" : placed < 0.68 ? " (middle)" : " (bottom)";
      }
      // Like Premiere's fx badge: this caption has a look or animation of its own.
      if (own && Object.keys(own).some((key) => key !== "x" && key !== "y")) {
        el.classList.add("has-fx");
        el.title += " · its own style";
      }

      const count = line.to - line.from;
      const wide = (end - start) * this.px > count * 34;
      if (selected && this.selection.size === 1 && wide && count > 1) {
        // Word view: each word at its own time, with draggable boundaries between them.
        el.classList.add("words");
        for (let i = line.from; i < line.to; i++) {
          const w = words[i];
          const span = document.createElement("span");
          span.className = "tl-word";
          span.style.left = `${(w.start - start) * this.px}px`;
          span.style.width = `${Math.max(1, (w.end - w.start) * this.px)}px`;
          span.textContent = w.text;
          el.append(span);
          if (i < line.to - 1) {
            const edge = document.createElement("div");
            edge.className = "tl-word-edge";
            edge.dataset.word = i;
            edge.style.left = `${(words[i + 1].start - start) * this.px}px`;
            edge.title = "Drag to retime these words";
            el.append(edge);
          }
        }
      } else {
        const text = document.createElement("span");
        text.className = "tl-clip-text";
        text.textContent = words.slice(line.from, line.to).map((w) => w.text).join(" ");
        el.append(text);
      }

      // The animation in and out, shaded like fades on a clip, with handles to drag their length.
      const motion = resolveMotion(lineStyle(cap, words, line).motion);
      const { tin, tout } = phaseLengths(motion, end - start, fps);
      for (const [side, secs] of [["in", tin], ["out", tout]]) {
        if (secs > 0) {
          const ramp = document.createElement("div");
          ramp.className = `tl-ramp ${side}`;
          ramp.style.width = `${secs * this.px}px`;
          el.append(ramp);
        }
        if (selected && motion?.plugin.durationKeys?.[side] && !this.#isLocked(track) && (end - start) * this.px > 24) {
          const h = document.createElement("div");
          h.className = `tl-fade ${side}`;
          h.dataset.side = side;
          h.style[side === "in" ? "left" : "right"] = `${secs * this.px}px`;
          h.title = side === "in" ? "Drag to change how long it animates in" : "Drag to change how long it animates out";
          el.append(h);
        }
      }
      for (const side of ["left", "right"]) {
        const h = document.createElement("div");
        h.className = `tl-trim ${side}`;
        h.dataset.side = side;
        el.append(h);
      }
      row.append(el);
    });
    if (editing && this.#editing === editing) {
      const k = this.#lines.findIndex((l) => words[l.from].id === editing.id);
      const el = this.tracksBox.querySelector(`.tl-clip[data-k="${k}"]`);
      if (el) {
        el.replaceChildren(editing.input);
        el.classList.add("editing");
        editing.input.focus({ preventScroll: true });
      } else {
        this.#editing = null;
      }
    }
    this.#status();
  }

  #status() {
    const n = this.selection.size;
    $("tl-status").textContent = n === 0 ? "" : n === 1 ? "1 caption selected" : `${n} captions selected`;
    $("tl-merge").disabled = n < 2;
    $("tl-delete").disabled = n === 0;
    for (const id of ["tl-top", "tl-middle", "tl-bottom"]) $(id).disabled = n === 0;
  }

  select(ids, { additive = false } = {}) {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.renderBlocks();
    this.onSelectionChange?.(this.selection);
  }

  toggle(id) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.renderBlocks();
    this.onSelectionChange?.(this.selection);
  }

  clearSelection() { this.select([]); }

  /** Every caption on tracks that aren't locked. */
  selectAll() {
    const words = this.#captions.words;
    this.select(this.#lines.filter((l) => !this.#isLocked(trackOf(words[l.from]))).map((l) => words[l.from].id));
  }

  /** Selected lines as index ranges, in track order then time order. */
  #selectedLines() {
    const words = this.#captions.words;
    return this.#lines.filter((l) => this.selection.has(words[l.from].id));
  }

  #lineTimes(k) { return lineTimes(this.#captions.words, this.#lines, k); }

  /* ---------- edits ---------- */

  #commit(mutate, coalesce) { this.store.update((d) => mutate(d.captions), { coalesce }); }

  /**
   * Splits at the playhead: the selected captions under it, or else every caption under it on
   * tracks that aren't locked, as Ctrl+K cuts through all targeted tracks in Premiere.
   */
  splitAtPlayhead({ all = false } = {}) {
    const t = this.video.currentTime;
    const words = this.#captions?.words ?? [];
    const under = this.#underPlayhead(t);
    if (!under.length) return this.toast("Move the playhead over a caption to split it.");
    const chosen = all ? [] : under.filter((l) => this.selection.has(words[l.from].id));
    let split = 0;
    this.#commit((c) => { for (const line of chosen.length ? chosen : under) if (splitLine(c, line, t)) split++; });
    if (!split) this.toast("That caption is one word, so there's nothing to split.");
  }

  /** Captions under the playhead on tracks that aren't locked. */
  #underPlayhead(t = this.video.currentTime) {
    const words = this.#captions?.words ?? [];
    return this.#lines.filter((l) => t > words[l.from].start && t < words[l.to - 1].end && !this.#isLocked(trackOf(words[l.from])));
  }

  /** The captions keyboard trims work on: the selected ones, else those under the playhead. */
  #trimTargets(t) {
    const words = this.#captions?.words ?? [];
    const chosen = this.#selectedLines().filter((l) => !this.#isLocked(trackOf(words[l.from])));
    return chosen.length ? chosen : this.#underPlayhead(t);
  }

  /** A line's neighbours on its own track, and the free time either side of it. */
  #neighbours(line) {
    const words = this.#captions.words;
    const k = this.#lines.indexOf(line);
    const track = trackOf(words[line.from]);
    const near = (j) => (this.#lines[j] && trackOf(words[this.#lines[j].from]) === track ? this.#lines[j] : null);
    const prev = near(k - 1);
    const next = near(k + 1);
    return { prev, next, lo: prev ? words[prev.to - 1].end : 0, hi: next ? words[next.from].start : this.#duration };
  }

  /** Applies new [start, end] times to lines, rescaling their words, as one undo step. */
  #retime(plan, coalesce) {
    if (!plan.size) return false;
    this.#commit((c) => { for (const { line, start, end } of plan.values()) retimeLine(c, line, start, end); }, coalesce);
    return true;
  }

  /**
   * Moves the start or end of captions to the playhead, as Q and W do in Premiere and Shift+[ and
   * Shift+] in Resolve: shorter when the playhead's inside, longer into free time when it's out.
   * Nothing later moves, since the video under the captions doesn't change.
   */
  trimToPlayhead(side) {
    const t = this.video.currentTime;
    const lines = this.#trimTargets(t);
    if (!lines.length) return this.toast("Select a caption, or move the playhead over one, to trim it.");
    const words = this.#captions.words;
    const plan = new Map();
    for (const line of lines) {
      const min = (line.to - line.from) * MIN_WORD;
      const start = words[line.from].start;
      const end = words[line.to - 1].end;
      const { lo, hi } = this.#neighbours(line);
      const at = side === "start" ? Math.max(lo, Math.min(t, end - min)) : Math.min(hi, Math.max(t, start + min));
      if (Math.abs(at - (side === "start" ? start : end)) > 1e-4) {
        plan.set(line.from, { line, start: side === "start" ? at : start, end: side === "end" ? at : end });
      }
    }
    if (!this.#retime(plan)) this.toast("There's no room to trim that way.");
  }

  /**
   * Moves the edge nearest the playhead there, like Premiere's Extend Edit (E). Where a caption
   * meets the next one, both move (a roll edit), so the cut between them lands on the playhead.
   * Without a selection it takes the nearest caption edge on any unlocked track.
   */
  extendToPlayhead() {
    const t = this.video.currentTime;
    const words = this.#captions?.words ?? [];
    const open = this.#lines.filter((l) => !this.#isLocked(trackOf(words[l.from])));
    let picks = this.#selectedLines().filter((l) => open.includes(l))
      .map((line) => ({ line, side: Math.abs(t - words[line.from].start) <= Math.abs(t - words[line.to - 1].end) ? "start" : "end" }));
    if (!picks.length) {
      let best = null;
      for (const line of open) {
        for (const side of ["start", "end"]) {
          const d = Math.abs(t - (side === "start" ? words[line.from].start : words[line.to - 1].end));
          if (!best || d < best.d) best = { line, side, d };
        }
      }
      if (!best) return this.toast("There are no captions to extend.");
      picks = [best];
    }
    const touch = 0.5 / this.#fps;
    const plan = new Map();
    const span = (line) => plan.get(line.from) ?? { line, start: words[line.from].start, end: words[line.to - 1].end };
    for (const { line, side } of picks) {
      const { prev, next, lo, hi } = this.#neighbours(line);
      const own = span(line);
      const min = (l) => (l.to - l.from) * MIN_WORD;
      if (side === "start") {
        const roll = prev && own.start - words[prev.to - 1].end < touch;
        const at = Math.max(roll ? words[prev.from].start + min(prev) : lo, Math.min(t, own.end - min(line)));
        plan.set(line.from, { ...own, start: at });
        if (roll) plan.set(prev.from, { ...span(prev), end: at });
      } else {
        const roll = next && words[next.from].start - own.end < touch;
        const at = Math.min(roll ? words[next.to - 1].end - min(next) : hi, Math.max(t, own.start + min(line)));
        plan.set(line.from, { ...own, end: at });
        if (roll) plan.set(next.from, { ...span(next), start: at });
      }
    }
    for (const [k, p] of plan) if (Math.abs(p.start - words[p.line.from].start) < 1e-4 && Math.abs(p.end - words[p.line.to - 1].end) < 1e-4) plan.delete(k);
    this.#retime(plan);
  }

  /** Lengthens (or with a negative count shortens) the selected captions' ends by `frames` frames. */
  trimEnd(frames) {
    const lines = this.#selectedLines().filter((l) => !this.#isLocked(this.#lineTrack(l)));
    if (!lines.length) return this.toast("Select captions to trim.");
    const words = this.#captions.words;
    const plan = new Map();
    for (const line of lines) {
      const start = words[line.from].start;
      const end = words[line.to - 1].end;
      const { hi } = this.#neighbours(line);
      const at = Math.min(hi, Math.max(start + (line.to - line.from) * MIN_WORD, end + frames / this.#fps));
      if (Math.abs(at - end) > 1e-4) plan.set(line.from, { line, start, end: at });
    }
    this.#retime(plan, "trim-end");
  }

  /** Selects the captions under the playhead, like D in Premiere. */
  selectAtPlayhead() {
    const words = this.#captions?.words ?? [];
    const ids = this.#underPlayhead().map((l) => words[l.from].id);
    if (!ids.length) return this.toast("There's no caption under the playhead.");
    this.select(ids);
  }

  /**
   * Selects the next or previous caption on the selected caption's track (C1 when nothing's
   * selected) and returns its start, for stepping through captions one at a time.
   */
  selectStep(dir) {
    const words = this.#captions?.words ?? [];
    const current = this.#selectedLines();
    const track = current.length ? this.#lineTrack(current[0]) : this.#tracks()[0]?.id;
    const mine = this.#lines.filter((l) => trackOf(words[l.from]) === track);
    if (!mine.length) return null;
    let k;
    if (current.length) {
      k = mine.indexOf(dir > 0 ? current.at(-1) : current[0]) + dir;
    } else {
      const t = this.video.currentTime;
      k = dir > 0 ? mine.findIndex((l) => words[l.from].start > t - 1e-3) : mine.findLastIndex((l) => words[l.from].start < t - 1e-3);
    }
    const line = mine[k];
    if (!line) return null;
    this.select([words[line.from].id]);
    this.#scrollTo(words[line.from].start);
    return words[line.from].start;
  }

  /** The span of the selected captions, or else of those under the playhead, for Mark Clip (X). */
  clipSpan() {
    const words = this.#captions?.words ?? [];
    const lines = this.#selectedLines().length ? this.#selectedLines() : this.#underPlayhead();
    if (!lines.length) return null;
    return { start: Math.min(...lines.map((l) => words[l.from].start)), end: Math.max(...lines.map((l) => words[l.to - 1].end)) };
  }

  /** Gives the selected captions the style of the first copied caption, like Paste Attributes in Premiere. */
  pasteStyle() {
    const style = this.#clipboard?.lines[0]?.override;
    const lines = this.#selectedLines().filter((l) => !this.#isLocked(this.#lineTrack(l)));
    if (!this.#clipboard) return this.toast("Copy a caption first (Ctrl+C), then select the captions to give its style.");
    if (!lines.length) return this.toast("Select the captions to give the copied style.");
    this.#commit((c) => {
      c.overrides ??= {};
      for (const line of lines) {
        const group = lockLine(c, line);
        if (style) c.overrides[group] = structuredClone(style);
        else delete c.overrides[group];
      }
    });
    this.toast(lines.length === 1 ? "Pasted the style onto 1 caption." : `Pasted the style onto ${lines.length} captions.`);
  }

  /** Opens the selected caption's text for typing, as Enter or F2 does. */
  editSelected() {
    const words = this.#captions?.words ?? [];
    const k = this.#lines.findIndex((l) => this.selection.has(words[l.from].id));
    if (k < 0) return false;
    this.editText(k);
    return true;
  }

  mergeSelected() {
    const lines = this.#selectedLines();
    if (lines.length < 2) return this.toast("Select two or more neighbouring captions to merge.");
    if (new Set(lines.map((l) => this.#lineTrack(l))).size > 1) return this.toast("Captions can only be merged with others on the same track.");
    // Merging spans everything between the first and last selected caption.
    this.#commit((c) => mergeLines(c, lines));
    this.select([this.#captions.words[lines[0].from].id]);
  }

  deleteSelected() {
    const lines = this.#selectedLines();
    if (!lines.length) return;
    this.#commit((c) => deleteLines(c, lines));
    this.clearSelection();
    this.toast(lines.length === 1 ? "Caption deleted" : `${lines.length} captions deleted`, { action: "Undo", onAction: () => this.store.undo() });
  }

  /** Deletes the selected captions and closes the gaps they leave on their tracks (Shift+Delete). */
  rippleDeleteSelected() {
    const lines = this.#selectedLines();
    if (!lines.length) return;
    this.#commit((c) => rippleDelete(c, lines));
    this.clearSelection();
    this.toast(`${lines.length === 1 ? "Caption" : `${lines.length} captions`} deleted, and the later ones moved up to close the gap.`, { action: "Undo", onAction: () => this.store.undo() });
  }

  /** Selects every caption from the playhead on, across tracks that aren't locked, like Resolve's Y. */
  selectForward() {
    const words = this.#captions?.words ?? [];
    const t = this.video.currentTime;
    const ids = this.#lines
      .filter((l) => words[l.to - 1].end > t + 1e-3 && !this.#isLocked(trackOf(words[l.from])))
      .map((l) => words[l.from].id);
    this.select(ids);
    this.toast(ids.length ? `Selected ${ids.length} caption${ids.length === 1 ? "" : "s"} from the playhead on.` : "No captions after the playhead.");
  }

  /** Selects the captions with these first-word ids, and shows the first of them. */
  reveal(ids) {
    this.select(ids);
    const words = this.#captions.words;
    const first = this.#lines.find((l) => ids.includes(words[l.from].id));
    if (first) this.#scrollTo(words[first.from].start);
  }

  #scrollTo(t) {
    const x = t * this.px;
    const left = this.scroll.scrollLeft;
    if (x < left || x > left + this.#viewWidth - 40) this.scroll.scrollLeft = Math.max(0, x - this.#viewWidth / 3);
  }

  /**
   * Adds a caption at time t, then opens it for typing. With no track given it goes on the first
   * track with room at t, so adding over an existing caption stacks a new one above it.
   */
  addAt(t, track = null) {
    const cap = this.#captions;
    if (!cap) return;
    const words = cap.words;
    const tracks = this.#tracks();
    const roomOn = (rank) => {
      if (rank < tracks.length && tracks[rank].locked) return null;
      const id = rank < tracks.length ? tracks[rank].id : null;
      const mine = this.#lines.filter((l) => trackOf(words[l.from]) === id);
      if (mine.some((l) => t >= words[l.from].start && t < words[l.to - 1].end)) return null;
      const next = mine.find((l) => words[l.from].start > t);
      const end = Math.min(t + NEW_CAPTION_SECS, next ? words[next.from].start : this.#duration);
      return end - t >= 0.3 ? end : null;
    };
    let rank = track != null ? this.#rankOf(track) : 0;
    let end = roomOn(rank);
    if (end == null && track != null) {
      return this.toast(this.#isLocked(track) ? "That track is locked." : "There's already a caption here, or no room for one.");
    }
    while (end == null && rank < tracks.length) end = roomOn(++rank);
    if (end == null) return this.toast("There isn't room for a caption here.");
    let id;
    this.#commit((c) => {
      if (rank >= c.tracks.length) c.tracks.push(newTrack(c));
      id = insertLine(c, t, end, "New caption", c.tracks[rank].id);
      if (rank > 0) {
        // Stacked captions start clear of the transcript: at the top, or the bottom if it's up there.
        const group = c.words.find((w) => w.id === id).group;
        c.overrides ??= {};
        c.overrides[group] = { y: c.style.y < 0.4 ? PLACES.bottom : PLACES.top };
      }
    });
    if (track == null && rank > 0) this.toast(`Added on C${rank + 1}, above the caption already here.`);
    this.select([id]);
    const k = this.#lines.findIndex((l) => this.#captions.words[l.from].id === id);
    if (k >= 0) this.editText(k);
  }

  /**
   * Puts the selected captions at the top, middle or bottom of the frame, leaving the rest where
   * the overall style has them. A place matching the overall style clears the caption's own.
   */
  place(where) {
    const lines = this.#selectedLines();
    if (!lines.length) return this.toast("Select captions on the timeline first.");
    const base = this.#captions.style.y;
    const y = where === "bottom" && base >= 0.6 ? base : PLACES[where];
    this.#commit((c) => {
      c.overrides ??= {};
      for (const line of lines) {
        const group = lockLine(c, line);
        const own = { ...(c.overrides[group] ?? {}) };
        if (Math.abs(y - base) < 0.02) delete own.y;
        else own.y = y;
        if (Object.keys(own).length) c.overrides[group] = own;
        else delete c.overrides[group];
      }
    });
  }

  /** Moves the selected captions one place up or down: bottom, middle, top. */
  placeStep(dir) {
    const lines = this.#selectedLines();
    if (!lines.length) return;
    const c = this.#captions;
    const group = c.words[lines[0].from].group;
    const y = (group != null ? c.overrides?.[group]?.y : null) ?? c.style.y;
    const order = ["top", "middle", "bottom"];
    const now = y < 0.4 ? 0 : y < 0.68 ? 1 : 2;
    this.place(order[Math.min(2, Math.max(0, now + dir))]);
  }

  /** Nudges the selected captions by `frames` frames. */
  nudge(frames) {
    const lines = this.#selectedLines();
    if (!lines.length) return;
    const step = frames / this.#fps;
    const delta = this.#clampMove(lines, step);
    if (delta !== 0) this.#commit((c) => moveLines(c, lines, delta), "nudge");
  }

  /** Limits a move along their tracks so the selection stays inside the video and clear of other captions. */
  #clampMove(lines, delta) {
    const words = this.#captions.words;
    const selected = new Set(lines.map((l) => l.from));
    const sameTrack = (a, b) => trackOf(words[this.#lines[a].from]) === trackOf(words[this.#lines[b].from]);
    let min = -Infinity;
    let max = Infinity;
    for (const line of lines) {
      const k = this.#lines.indexOf(line);
      const start = words[line.from].start;
      const end = words[line.to - 1].end;
      let prev = k - 1;
      while (prev >= 0 && sameTrack(prev, k) && selected.has(this.#lines[prev].from)) prev--;
      let next = k + 1;
      while (next < this.#lines.length && sameTrack(next, k) && selected.has(this.#lines[next].from)) next++;
      const lo = prev >= 0 && sameTrack(prev, k) ? words[this.#lines[prev].to - 1].end : 0;
      const hi = next < this.#lines.length && sameTrack(next, k) ? words[this.#lines[next].from].start : this.#duration;
      min = Math.max(min, lo - start);
      max = Math.min(max, hi - end);
    }
    return Math.min(max, Math.max(min, delta));
  }

  /** Inline text editing on a block. */
  editText(k) {
    const el = this.tracksBox.querySelector(`.tl-clip[data-k="${k}"]`);
    const line = this.#lines[k];
    if (!el || !line) return;
    const words = this.#captions.words;
    const input = document.createElement("input");
    input.className = "tl-clip-input";
    input.value = words.slice(line.from, line.to).map((w) => w.text).join(" ");
    input.setAttribute("aria-label", "Caption text");
    el.replaceChildren(input);
    el.classList.add("editing");
    input.focus();
    input.select();
    const editing = { input, id: words[line.from].id, moving: false };
    this.#editing = editing;
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.#editing = null;
      const text = input.value.trim();
      // Found again by its first word, in case the lines were regrouped while typing.
      const now = this.#lines.find((l) => this.#captions.words[l.from]?.id === editing.id) ?? line;
      const old = this.#captions.words.slice(now.from, now.to).map((w) => w.text).join(" ");
      if (save && text && text !== old) {
        this.#commit((c) => editLine(c, now, text));
      } else {
        this.renderBlocks();
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => { if (!editing.moving) finish(true); });
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  /* ---------- copy, cut, paste, duplicate ---------- */

  copySelected() {
    const lines = this.#selectedLines();
    if (!lines.length) return false;
    this.#clipboard = copyLines(this.#captions, lines);
    this.toast(lines.length === 1 ? "Copied 1 caption" : `Copied ${lines.length} captions`);
    return true;
  }

  cutSelected() {
    const lines = this.#selectedLines();
    if (!lines.length) return;
    this.#clipboard = copyLines(this.#captions, lines);
    this.#commit((c) => deleteLines(c, lines));
    this.clearSelection();
    this.toast(lines.length === 1 ? "Cut 1 caption" : `Cut ${lines.length} captions`, { action: "Undo", onAction: () => this.store.undo() });
  }

  /** Pastes at the playhead (or `at`), on the copied captions' tracks or the first ones above with room. */
  paste(at = this.video.currentTime, track = null) {
    if (!this.#clipboard) return this.toast("Copy captions first (Ctrl+C).");
    this.#pasteClip(this.#clipboard, at, track != null ? this.#rankOf(track) : null);
  }

  /** Copies the selected captions onto the tracks above them, at the same time, for stacking. */
  duplicateSelected() {
    const lines = this.#selectedLines();
    if (!lines.length) return this.toast("Select captions to duplicate.");
    const clip = copyLines(this.#captions, lines);
    const words = this.#captions.words;
    const at = Math.min(...lines.map((l) => words[l.from].start));
    const lowest = Math.min(...lines.map((l) => this.#rankOf(this.#lineTrack(l))));
    this.#pasteClip(clip, at, lowest + 1);
  }

  #pasteClip(clip, at, startRank) {
    const tracks = this.#tracks();
    const t0 = Math.max(0, Math.min(at, this.#duration - clip.duration));
    const first = startRank ?? Math.min(...clip.lines.map((l) => Math.max(0, this.#rankOf(l.track))));
    for (let base = Math.max(0, first); base <= tracks.length; base++) {
      const spans = clip.lines.map((item) => ({
        rank: base + item.trackOffset, start: t0 + item.words[0].start, end: t0 + item.words[item.words.length - 1].end,
      }));
      if (!this.#fits(spans)) continue;
      let ids = [];
      this.#commit((c) => {
        const top = Math.max(...spans.map((s) => s.rank));
        while (c.tracks.length <= top) c.tracks.push(newTrack(c));
        ids = pasteLines(c, clip, t0, (item) => c.tracks[base + item.trackOffset].id);
      });
      this.select(ids);
      return;
    }
    this.toast("There isn't room to paste there.");
  }

  /* ---------- snapping ---------- */

  /** Times a dragged edge may snap to: the playhead, other captions' edges, and the ends. */
  #snapTargets(excludeFroms) {
    const words = this.#captions.words;
    const targets = [0, this.#duration, this.video.currentTime, ...this.#markTimes()];
    for (const l of this.#lines) {
      if (excludeFroms.has(l.from)) continue;
      targets.push(words[l.from].start, words[l.to - 1].end);
    }
    return targets;
  }

  /** The nearest snap within reach of any of `edges`, as an offset to apply, or 0. */
  #snapOffset(edges, targets) {
    if (!this.snapping) return { offset: 0, at: null };
    let best = { offset: 0, at: null, dist: SNAP_PX / this.px };
    for (const e of edges) {
      for (const t of targets) {
        const d = Math.abs(t - e);
        if (d < best.dist) best = { offset: t - e, at: t, dist: d };
      }
    }
    return best;
  }

  #showSnap(at) {
    const line = $("tl-snapline");
    line.hidden = at == null;
    if (at != null) line.style.transform = `translateX(${at * this.px}px)`;
  }

  /** Scrubbing catches caption and grade edges while snapping is on. */
  #scrubTime(clientX) {
    const t = this.#timeAt(clientX);
    if (!this.snapping) return t;
    let best = t;
    let dist = SNAP_PX / this.px;
    for (const p of [...this.#editPoints(), ...this.#markTimes()]) {
      if (Math.abs(p - t) < dist) { best = p; dist = Math.abs(p - t); }
    }
    return best;
  }

  /* ---------- dropping presets from the panel ---------- */

  /**
   * Lights up the captions a preset dragged to (x, y) would land on, and returns their first-word
   * ids: the selection if it's dropped on a selected caption, or just the one under the pointer.
   * Call with no position to clear the highlight.
   */
  dropHover(x, y) {
    for (const el of this.tracksBox.querySelectorAll(".tl-clip.drop-target")) el.classList.remove("drop-target");
    if (x == null || !this.#captions) return null;
    const el = document.elementFromPoint(x, y)?.closest?.(".tl-clip");
    if (!el || !this.tracksBox.contains(el)) return null;
    const words = this.#captions.words;
    const line = this.#lines[Number(el.dataset.k)];
    if (!line || this.#isLocked(trackOf(words[line.from]))) return null;
    const id = words[line.from].id;
    const ids = this.selection.has(id) ? [...this.selection] : [id];
    for (const c of this.tracksBox.querySelectorAll(".tl-clip")) {
      if (ids.includes(words[this.#lines[Number(c.dataset.k)].from].id)) c.classList.add("drop-target");
    }
    return ids;
  }

  /* ---------- pointer interactions ---------- */

  #bind() {
    $("tl-zoom").addEventListener("input", () => {
      const min = this.#minPx;
      const v = Number($("tl-zoom").value) / 100;
      this.setZoom(min * Math.pow(MAX_PX_PER_SEC / min, v));
    });
    $("tl-zoom-in").addEventListener("click", () => this.zoomBy(1.5));
    $("tl-zoom-out").addEventListener("click", () => this.zoomBy(1 / 1.5));
    $("tl-fit").addEventListener("click", () => this.fit());
    $("tl-snap").addEventListener("click", () => this.toggleSnapping());
    $("tl-split").addEventListener("click", () => (this.onSplitRequest ? this.onSplitRequest() : this.splitAtPlayhead()));
    $("tl-merge").addEventListener("click", () => this.mergeSelected());
    $("tl-delete").addEventListener("click", () => this.deleteSelected());
    $("tl-add").addEventListener("click", () => this.addAt(this.video.currentTime));
    $("tl-add-track").addEventListener("click", () => this.addTrack());
    this.newTrackRow.addEventListener("dblclick", () => this.addTrack());
    for (const id of ["tl-top", "tl-middle", "tl-bottom"]) $(id).addEventListener("click", () => this.place($(id).dataset.place));

    this.scroll.addEventListener("scroll", () => this.draw());
    this.scroll.addEventListener("wheel", (ev) => {
      if (ev.ctrlKey || ev.altKey) {
        // Ctrl or Alt and the wheel zoom around the pointer, as in Premiere and Resolve.
        ev.preventDefault();
        const r = this.scroll.getBoundingClientRect();
        this.zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, this.#timeAt(ev.clientX), ev.clientX - r.left);
      } else if (!ev.shiftKey && Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && !this.#canScrollY(ev.deltaY)) {
        ev.preventDefault();
        this.scroll.scrollLeft += ev.deltaY;
      }
    }, { passive: false });

    // Scrub by dragging on the ruler (catching edit points while snapping), or click the video
    // and audio tracks to jump.
    this.markerLayer.addEventListener("dblclick", (ev) => {
      const el = ev.target.closest(".tl-marker");
      if (el) { ev.stopPropagation(); this.renameMarker(Number(el.dataset.id)); }
    });
    $("tl-ruler-row").addEventListener("contextmenu", (ev) => {
      if (this.#markerContext(ev)) return;
      ev.preventDefault();
      const t = this.#timeAt(ev.clientX);
      const r = this.#range;
      this.openMenu(ev.clientX, ev.clientY, [
        { label: "Add marker here", icon: "#i-marker", hint: "M", action: () => this.addMarker(t) },
        { label: "Set In here", icon: "#i-in", hint: "I", action: () => this.setRange("in", t) },
        { label: "Set Out here", icon: "#i-out", hint: "O", action: () => this.setRange("out", t) },
        { label: "Clear In and Out", icon: "#i-x", hint: "Alt+X", disabled: !r, action: () => this.clearRange() },
        { sep: true },
        { label: "Copy markers as YouTube chapters", icon: "#i-copy", disabled: !this.#markers.length, action: () => this.copyChapters() },
      ]);
    });
    for (const id of ["tl-ruler-row", "tl-video-row", "tl-audio-row"]) {
      $(id).addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        if (id === "tl-ruler-row" && this.#markerDown(ev)) return;
        const el = ev.currentTarget;
        capture(el, ev.pointerId);
        this.video.pause();
        const at = (x) => (id === "tl-ruler-row" ? this.#scrubTime(x) : this.#timeAt(x));
        this.onSeek(at(ev.clientX));
        const move = (e) => this.onSeek(at(e.clientX));
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", () => el.removeEventListener("pointermove", move), { once: true });
      });
    }

    this.tracksBox.addEventListener("pointerdown", (ev) => this.#pointerDown(ev));
    this.tracksBox.addEventListener("contextmenu", (ev) => this.#captionContext(ev));
    this.grades.addEventListener("pointerdown", (ev) => this.#gradeDown(ev));
    this.grades.addEventListener("contextmenu", (ev) => this.#gradeContext(ev));
    // Pointer capture during the clicks retargets the double-click to the track itself, so the
    // block is found from where the pointer is.
    const under = (ev, selector) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(selector) ?? null;
    this.grades.addEventListener("dblclick", (ev) => {
      const block = under(ev, ".tl-grade");
      if (!block) this.onGradeAdd?.(this.#timeAt(ev.clientX), null);
      else this.renameGrade(Number(block.dataset.id));
    });
    document.addEventListener("pointerdown", (ev) => {
      if (!$("context-menu").hidden && !ev.target.closest("#context-menu")) this.closeMenu();
    }, true);
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.closeMenu(); });
    this.tracksBox.addEventListener("dblclick", (ev) => {
      const clip = under(ev, ".tl-clip");
      const row = under(ev, ".tl-row.captions");
      if (clip) this.editText(Number(clip.dataset.k));
      else if (row) this.addAt(this.#timeAt(ev.clientX), Number(row.dataset.track));
    });
  }

  /** True when the tracks area can scroll vertically in that direction, so the wheel scrolls it. */
  #canScrollY(dy) {
    const body = this.scroll.parentElement;
    return body.scrollHeight > body.clientHeight && (dy < 0 ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight);
  }

  toggleSnapping() {
    this.snapping = !this.snapping;
    $("tl-snap").setAttribute("aria-pressed", String(this.snapping));
    this.toast(this.snapping ? "Snapping on" : "Snapping off");
  }

  #pointerDown(ev) {
    if (ev.button !== 0 || !this.#captions) return;
    if (ev.target.closest(".tl-clip-input")) return;
    const row = ev.target.closest(".tl-row.captions");
    if (!row) return;
    const clip = ev.target.closest(".tl-clip");
    const startX = ev.clientX;
    const startY = ev.clientY;

    if (!clip) {
      // Empty track: click clears the selection, drag draws a selection box across tracks.
      this.#drag = { kind: "marquee", startX, startY, additive: ev.shiftKey || ev.ctrlKey, base: new Set(this.selection) };
    } else {
      const k = Number(clip.dataset.k);
      const line = this.#lines[k];
      const words = this.#captions.words;
      const id = words[line.from].id;
      const track = trackOf(words[line.from]);
      if (this.#isLocked(track)) {
        this.toast(`“${this.#trackById(track)?.name}” is locked. Unlock it to edit its captions.`);
        return;
      }
      const edge = ev.target.closest(".tl-word-edge");
      const trim = ev.target.closest(".tl-trim");
      const fade = ev.target.closest(".tl-fade");
      if (fade) {
        const targets = this.selection.has(id) ? this.#selectedLines() : [line];
        const motion = resolveMotion(lineStyle(this.#captions, words, line).motion);
        const { start, end } = lineTimes(words, this.#lines, k);
        const lengths = phaseLengths(motion, end - start, this.#fps);
        const secs = fade.dataset.side === "in" ? lengths.tin : lengths.tout;
        this.#drag = { kind: "fade", side: fade.dataset.side, startX, k, clip, targets, frames0: Math.round(secs * this.#fps), span: end - start };
      } else if (edge) {
        this.#drag = { kind: "word", startX, k, i: Number(edge.dataset.word), clip };
      } else if (trim) {
        if (!this.selection.has(id)) this.select([id]);
        const { start, end } = lineTimes(words, this.#lines, k);
        this.#drag = { kind: "trim", side: trim.dataset.side, startX, k, start, end };
      } else {
        if (ev.shiftKey || ev.ctrlKey) {
          this.toggle(id);
          this.#drag = null;
          return;
        }
        if (!this.selection.has(id)) this.select([id]);
        // Alt at the start of a drag copies instead of moving, as in Premiere.
        this.#drag = { kind: "move", startX, startY, k, alt: ev.altKey, lines: this.#selectedLines() };
      }
    }
    capture(this.tracksBox, ev.pointerId);
    const move = (e) => this.#pointerMove(e);
    const up = (e) => {
      this.tracksBox.removeEventListener("pointermove", move);
      this.#pointerUp(e);
    };
    this.tracksBox.addEventListener("pointermove", move);
    this.tracksBox.addEventListener("pointerup", up, { once: true });
    this.tracksBox.addEventListener("pointercancel", up, { once: true });
  }

  #pointerMove(ev) {
    const d = this.#drag;
    if (!d) return;
    const dx = ev.clientX - d.startX;
    const dy = ev.clientY - (d.startY ?? ev.clientY);
    if (!d.active && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    const starting = !d.active;
    d.active = true;
    const dt = dx / this.px;
    const words = this.#captions.words;

    if (d.kind === "move") {
      const tracks = this.#tracks();
      const froms = new Set(d.lines.map((l) => l.from));
      const ranks = d.lines.map((l) => this.#rankOf(trackOf(words[l.from])));
      const anchor = this.#rankOf(trackOf(words[this.#lines[d.k].from]));
      // Up and down the stack, one past the top making a new track, never below C1.
      const shift = Math.min(tracks.length - Math.max(...ranks), Math.max(-Math.min(...ranks), this.#rankAt(ev.clientY) - anchor));
      const edges = d.lines.flatMap((l) => [words[l.from].start + dt, words[l.to - 1].end + dt]);
      const snap = this.#snapOffset(edges, this.#snapTargets(d.alt ? new Set() : froms));
      let delta = dt + snap.offset;
      if (!shift && !d.alt) {
        delta = this.#clampMove(d.lines, delta);
      } else {
        const lo = Math.min(...d.lines.map((l) => words[l.from].start));
        const hi = Math.max(...d.lines.map((l) => words[l.to - 1].end));
        delta = Math.min(this.#duration - hi, Math.max(-lo, delta));
      }
      const spans = d.lines.map((l, i) => ({ rank: ranks[i] + shift, start: words[l.from].start + delta, end: words[l.to - 1].end + delta }));
      d.valid = !shift && !d.alt ? true : this.#fits(spans, d.alt ? new Set() : froms);
      d.delta = delta;
      d.shift = shift;
      this.#showSnap(snap.offset && Math.abs(delta - (dt + snap.offset)) < 1e-9 ? snap.at : null);
      if (starting) {
        // A copy drags ghosts and leaves the originals where they are.
        const originals = [...this.tracksBox.querySelectorAll(".tl-clip.selected")];
        d.els = d.alt ? originals.map((el) => { const g = el.cloneNode(true); g.classList.add("dup"); el.after(g); return g; }) : originals;
        d.rowTops = d.els.map((el) => el.parentElement.getBoundingClientRect().top);
      }
      d.els.forEach((el, i) => {
        const rank = this.#rankOf(Number(el.dataset.track));
        const y = shift ? this.#rowTop(Math.min(tracks.length, rank + shift)) - d.rowTops[i] : 0;
        el.style.transform = `translate(${delta * this.px}px, ${y}px)`;
        el.classList.toggle("invalid", !d.valid);
      });
      this.newTrackRow.classList.toggle("target", shift > 0 && Math.max(...ranks) + shift >= tracks.length);
    } else if (d.kind === "fade") {
      // Dragging a handle inward lengthens the animation; it can't pass the caption's middle.
      const max = Math.floor(d.span * this.#fps);
      d.frames = Math.max(0, Math.min(max, Math.round(d.frames0 + ((d.side === "in" ? dx : -dx) / this.px) * this.#fps)));
      const px = (d.frames / this.#fps) * this.px;
      const handle = d.clip.querySelector(`.tl-fade.${d.side}`);
      handle.style[d.side === "in" ? "left" : "right"] = `${px}px`;
      handle.dataset.frames = `${d.frames}f`;
      let ramp = d.clip.querySelector(`.tl-ramp.${d.side}`);
      if (!ramp) {
        ramp = document.createElement("div");
        ramp.className = `tl-ramp ${d.side}`;
        d.clip.append(ramp);
      }
      ramp.style.width = `${px}px`;
    } else if (d.kind === "trim") {
      const line = this.#lines[d.k];
      const count = line.to - line.from;
      const track = trackOf(words[line.from]);
      const prev = this.#lines[d.k - 1] && trackOf(words[this.#lines[d.k - 1].from]) === track ? this.#lines[d.k - 1] : null;
      const next = this.#lines[d.k + 1] && trackOf(words[this.#lines[d.k + 1].from]) === track ? this.#lines[d.k + 1] : null;
      const exclude = new Set([line.from]);
      let start = d.start;
      let end = d.end;
      if (d.side === "left") {
        const snap = this.#snapOffset([d.start + dt], this.#snapTargets(exclude));
        const lo = prev ? words[prev.to - 1].end : 0;
        start = Math.min(d.end - count * MIN_WORD, Math.max(lo, d.start + dt + snap.offset));
        this.#showSnap(snap.at != null && start === d.start + dt + snap.offset ? snap.at : null);
      } else {
        const snap = this.#snapOffset([d.end + dt], this.#snapTargets(exclude));
        const hi = next ? words[next.from].start : this.#duration;
        end = Math.max(d.start + count * MIN_WORD, Math.min(hi, d.end + dt + snap.offset));
        this.#showSnap(snap.at != null && end === d.end + dt + snap.offset ? snap.at : null);
      }
      d.newStart = start;
      d.newEnd = end;
      const el = this.tracksBox.querySelector(`.tl-clip[data-k="${d.k}"]`);
      el.style.left = `${start * this.px}px`;
      el.style.width = `${(end - start) * this.px}px`;
    } else if (d.kind === "word") {
      const a = words[d.i];
      const b = words[d.i + 1];
      const lineStart = words[this.#lines[d.k].from].start;
      const snap = this.#snapOffset([b.start + dt], [this.video.currentTime]);
      d.t = Math.min(b.end - MIN_WORD, Math.max(a.start + MIN_WORD, b.start + dt + snap.offset));
      const edge = d.clip.querySelector(`.tl-word-edge[data-word="${d.i}"]`);
      edge.style.left = `${(d.t - lineStart) * this.px}px`;
      const spans = d.clip.querySelectorAll(".tl-word");
      const ia = d.i - this.#lines[d.k].from;
      spans[ia].style.width = `${(d.t - a.start) * this.px}px`;
      spans[ia + 1].style.left = `${(d.t - lineStart) * this.px}px`;
      spans[ia + 1].style.width = `${(b.end - d.t) * this.px}px`;
    } else if (d.kind === "marquee") {
      const t0 = this.#timeAt(d.startX);
      const t1 = this.#timeAt(ev.clientX);
      const lo = Math.min(t0, t1);
      const hi = Math.max(t0, t1);
      const y0 = Math.min(d.startY, ev.clientY);
      const y1 = Math.max(d.startY, ev.clientY);
      const top = this.content.getBoundingClientRect().top;
      const box = $("tl-marquee");
      box.hidden = false;
      box.style.left = `${lo * this.px}px`;
      box.style.width = `${(hi - lo) * this.px}px`;
      box.style.top = `${y0 - top}px`;
      box.style.height = `${Math.max(2, y1 - y0)}px`;
      // Tracks the box reaches, unless they're locked.
      const reached = new Set();
      for (const [id, row] of this.#rows) {
        const r = row.getBoundingClientRect();
        if (r.bottom > y0 && r.top < y1 && !this.#isLocked(id)) reached.add(id);
      }
      const hits = this.#lines
        .filter((l) => reached.has(trackOf(words[l.from])) && words[l.to - 1].end > lo && words[l.from].start < hi)
        .map((l) => words[l.from].id);
      this.selection = new Set([...(d.additive ? d.base : []), ...hits]);
      for (const el of this.tracksBox.querySelectorAll(".tl-clip")) {
        el.classList.toggle("selected", this.selection.has(words[this.#lines[Number(el.dataset.k)].from].id));
      }
    }
  }

  #pointerUp(ev) {
    const d = this.#drag;
    this.#drag = null;
    this.#showSnap(null);
    this.newTrackRow.classList.remove("target");
    $("tl-marquee").hidden = true;
    if (!d) return;
    if (!d.active) {
      // A plain click: empty space clears the selection and jumps the playhead there.
      if (d.kind === "marquee") {
        if (!d.additive) this.clearSelection();
        this.onSeek(this.#timeAt(ev.clientX));
      }
      return;
    }
    if (d.kind === "move") {
      if (!d.valid) {
        this.toast("There's a caption in the way there, or the track is locked.");
        this.renderBlocks();
        return;
      }
      if (d.alt) {
        const clip = copyLines(this.#captions, d.lines);
        const words = this.#captions.words;
        const at = Math.min(...d.lines.map((l) => words[l.from].start)) + d.delta;
        const lowest = Math.min(...d.lines.map((l) => this.#rankOf(this.#lineTrack(l))));
        let ids = [];
        this.#commit((c) => {
          const top = Math.max(...clip.lines.map((item) => lowest + d.shift + item.trackOffset));
          while (c.tracks.length <= top) c.tracks.push(newTrack(c));
          ids = pasteLines(c, clip, at, (item) => c.tracks[lowest + d.shift + item.trackOffset].id);
        });
        this.select(ids);
        return;
      }
      if (d.delta || d.shift) {
        this.#commit((c) => {
          if (d.shift > 0) {
            const top = Math.max(...d.lines.map((l) => c.tracks.findIndex((t) => t.id === trackOf(c.words[l.from])))) + d.shift;
            while (c.tracks.length <= top) c.tracks.push(newTrack(c));
          }
          moveLines(c, d.lines, d.delta);
          shiftTracks(c, d.lines, d.shift);
        });
      }
    } else if (d.kind === "fade" && d.frames != null && d.frames !== d.frames0) {
      this.#commit((c) => {
        for (const line of d.targets) {
          const m = resolveMotion(lineStyle(c, c.words, line).motion);
          const key = m?.plugin.durationKeys?.[d.side];
          if (!key) continue;
          const group = lockLine(c, line);
          c.overrides ??= {};
          c.overrides[group] = { ...(c.overrides[group] ?? {}), motion: { plugin: m.plugin.id, preset: null, params: { ...m.params, [key]: d.frames } } };
        }
      });
    } else if (d.kind === "trim" && d.newStart != null) {
      const line = this.#lines[d.k];
      this.#commit((c) => retimeLine(c, line, d.newStart, d.newEnd));
    } else if (d.kind === "word" && d.t != null) this.#commit((c) => setWordBoundary(c, d.i, d.t));
    else if (d.kind === "marquee") { this.renderBlocks(); this.onSelectionChange?.(this.selection); return; }
    this.renderBlocks();
  }

  /* ---------- caption and track context menus ---------- */

  #captionContext(ev) {
    ev.preventDefault();
    const row = ev.target.closest(".tl-row.captions");
    if (!row || !this.#captions) return;
    const track = Number(row.dataset.track);
    const t = this.#timeAt(ev.clientX);
    const clip = ev.target.closest(".tl-clip");
    const locked = this.#isLocked(track);
    if (!clip) {
      this.openMenu(ev.clientX, ev.clientY, [
        { label: "Paste here", icon: "#i-paste", disabled: !this.#clipboard || locked, action: () => this.paste(t, track) },
        { label: "Add a caption here", icon: "#i-plus", disabled: locked, action: () => this.addAt(t, track) },
        { sep: true },
        { label: "Add a track", icon: "#i-layers", action: () => this.addTrack() },
      ]);
      return;
    }
    const words = this.#captions.words;
    const line = this.#lines[Number(clip.dataset.k)];
    const id = words[line.from].id;
    if (!locked && !this.selection.has(id)) this.select([id]);
    const lines = this.#selectedLines();
    const n = lines.length;
    const own = lines.some((l) => words[l.from].group != null && this.#captions.overrides?.[words[l.from].group]);
    const tPlay = this.video.currentTime;
    const splittable = lines.some((l) => tPlay > words[l.from].start && tPlay < words[l.to - 1].end && l.to - l.from > 1);
    this.openMenu(ev.clientX, ev.clientY, locked ? [
      { label: "Unlock this track", icon: "#i-unlock", action: () => this.setTrack(track, { locked: false }) },
    ] : [
      { label: "Edit text", icon: "#i-type", disabled: n !== 1, action: () => this.editText(this.#lines.indexOf(lines[0])) },
      { sep: true },
      { label: "Cut", icon: "#i-scissors", hint: "Ctrl+X", action: () => this.cutSelected() },
      { label: "Copy", icon: "#i-copy", hint: "Ctrl+C", action: () => this.copySelected() },
      { label: "Paste at playhead", icon: "#i-paste", hint: "Ctrl+V", disabled: !this.#clipboard, action: () => this.paste() },
      { label: "Paste style", icon: "#i-paste", hint: "Ctrl+Alt+V", disabled: !this.#clipboard, action: () => this.pasteStyle() },
      { label: "Duplicate onto the track above", icon: "#i-layers", hint: "Ctrl+D", action: () => this.duplicateSelected() },
      { sep: true },
      { label: "Split at playhead", icon: "#i-scissors", hint: "Ctrl+K", disabled: !splittable, action: () => this.splitAtPlayhead() },
      { label: "Trim start to playhead", icon: "#i-in", hint: "Q", action: () => this.trimToPlayhead("start") },
      { label: "Trim end to playhead", icon: "#i-out", hint: "W", action: () => this.trimToPlayhead("end") },
      { label: "Merge", icon: "#i-merge", hint: "Shift+M", disabled: n < 2, action: () => this.mergeSelected() },
      { label: "Show at the top", icon: "#i-arrow-up", disabled: !n, action: () => this.place("top") },
      { label: "Show at the bottom", icon: "#i-arrow-down", disabled: !n, action: () => this.place("bottom") },
      { label: "Reset to the overall style", icon: "#i-undo", disabled: !own, action: () => this.#resetStyle(lines) },
      { sep: true },
      { label: n === 1 ? "Delete caption" : `Delete ${n} captions`, icon: "#i-trash", hint: "Del", danger: true, action: () => this.deleteSelected() },
      { label: "Ripple delete", icon: "#i-trash", hint: "Shift+Del", danger: true, action: () => this.rippleDeleteSelected() },
    ]);
  }

  #resetStyle(lines) {
    this.#commit((c) => {
      for (const line of lines) {
        const group = c.words[line.from].group;
        if (group != null) delete c.overrides?.[group];
      }
    });
  }

  #trackContext(ev, id) {
    ev.preventDefault();
    const t = this.#trackById(id);
    if (!t) return;
    const words = this.#captions.words;
    this.openMenu(ev.clientX, ev.clientY, [
      { label: "Rename", icon: "#i-type", action: () => this.#renameTrack(id, this.heads.querySelector(`.tl-head[data-track="${id}"] .tl-track-name`)) },
      { label: t.hidden ? "Show" : "Hide", icon: t.hidden ? "#i-eye" : "#i-eye-off", action: () => this.setTrack(id, { hidden: !t.hidden }) },
      { label: t.locked ? "Unlock" : "Lock", icon: t.locked ? "#i-unlock" : "#i-lock", action: () => this.setTrack(id, { locked: !t.locked }) },
      { label: "Select all on this track", icon: "#i-check", disabled: t.locked, action: () => this.select(this.#lines.filter((l) => trackOf(words[l.from]) === id).map((l) => words[l.from].id)) },
      { sep: true },
      { label: "Add a track", icon: "#i-layers", action: () => this.addTrack() },
      { label: "Delete track", icon: "#i-trash", danger: true, disabled: this.#tracks().length < 2, action: () => this.deleteTrack(id) },
    ]);
  }

  /* ---------- markers and In / Out ---------- */

  get #markers() { return this.store.doc?.markers ?? []; }
  get #range() { return this.store.doc?.range ?? null; }

  /** Marker times and the In and Out points, for snapping to. */
  #markTimes() {
    const r = this.#range;
    return [...this.#markers.map((m) => m.t), ...(r ? [r.in, r.out].filter((v) => v != null) : [])];
  }

  /** Adds a marker at `t`, or opens the one already on that frame for naming, as pressing M twice does in Premiere. */
  addMarker(t = this.video.currentTime) {
    const frame = 0.5 / this.#fps;
    const there = this.#markers.find((m) => Math.abs(m.t - t) < frame);
    if (there) return this.renameMarker(there.id);
    let id;
    this.store.update((d) => {
      d.markers ??= [];
      id = Math.max(0, ...d.markers.map((m) => m.id)) + 1;
      d.markers.push({ id, t, name: "", color: this.lastMarkerColor ?? "blue" });
      d.markers.sort((a, b) => a.t - b.t);
    });
    return id;
  }

  /** The marker before or after the playhead, for Shift+Up and Shift+Down. */
  markerStep(dir) {
    const t = this.video.currentTime;
    const times = this.#markers.map((m) => m.t);
    const found = dir > 0 ? times.find((m) => m > t + 1e-3) : times.reverse().find((m) => m < t - 1e-3);
    return found ?? null;
  }

  setMarker(id, patch) {
    this.store.update((d) => {
      const m = d.markers?.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      d.markers?.sort((a, b) => a.t - b.t);
    });
  }

  deleteMarker(id) {
    this.store.update((d) => { d.markers = (d.markers ?? []).filter((m) => m.id !== id); });
  }

  renameMarker(id) {
    const el = this.markerLayer.querySelector(`.tl-marker[data-id="${id}"]`);
    const m = this.#markers.find((x) => x.id === id);
    if (!el || !m) return;
    const input = document.createElement("input");
    input.className = "tl-marker-input";
    input.value = m.name;
    input.placeholder = "Marker name";
    input.maxLength = 80;
    input.setAttribute("aria-label", "Marker name");
    el.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      input.remove();
      if (save && input.value.trim() !== m.name) this.setMarker(id, { name: input.value.trim() });
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  /** The markers as YouTube chapters: "0:00 Intro" lines, starting at 0:00 as YouTube requires. */
  chapters() {
    const marks = this.#markers.filter((m) => m.t < this.#duration);
    const rows = marks.map((m, i) => `${chapterTime(m.t)} ${m.name || `Chapter ${i + 1}`}`);
    if (!marks.length || marks[0].t >= 1) rows.unshift("0:00 Intro");
    return rows.join("\n");
  }

  /** Sets the In or Out point (null clears it), keeping In before Out. */
  setRange(which, t) {
    this.store.update((d) => {
      const r = { in: d.range?.in ?? null, out: d.range?.out ?? null, [which]: t };
      if (r.in != null && r.out != null && r.out - r.in < 1 / this.#fps) {
        // Setting one past the other moves the other out of the way, as in Premiere.
        if (which === "in") r.out = null; else r.in = null;
      }
      d.range = r.in == null && r.out == null ? null : r;
    });
  }

  clearRange() {
    if (this.#range) this.store.update((d) => { d.range = null; });
  }

  #renderMarkers() {
    const layer = this.markerLayer;
    layer.replaceChildren();
    const r = this.#range;
    this.rangeBand.hidden = !r || !this.#media;
    if (r && this.#media) {
      const a = r.in ?? 0;
      const b = r.out ?? this.#duration;
      this.rangeBand.style.left = `${a * this.px}px`;
      this.rangeBand.style.width = `${Math.max(1, (b - a) * this.px)}px`;
      this.rangeBand.classList.toggle("has-in", r.in != null);
      this.rangeBand.classList.toggle("has-out", r.out != null);
      this.rangeBand.title = `In ${r.in != null ? chapterTime(r.in) : "start"} to Out ${r.out != null ? chapterTime(r.out) : "end"}. Exports and looped playback use this range.`;
    }
    if (!this.#media) return;
    for (const m of this.#markers) {
      const el = document.createElement("div");
      el.className = "tl-marker";
      el.dataset.id = m.id;
      el.style.left = `${m.t * this.px}px`;
      el.style.setProperty("--mk", MARKER_COLORS[m.color] ?? MARKER_COLORS.blue);
      el.title = `${m.name || "Marker"} · ${chapterTime(m.t)}. Click to jump, drag to move, double-click to name, right-click for more.`;
      if (m.name) {
        const label = document.createElement("span");
        label.className = "tl-marker-name";
        label.textContent = m.name;
        el.append(label);
      }
      layer.append(el);
    }
  }

  #markerDown(ev) {
    const el = ev.target.closest(".tl-marker");
    if (!el || ev.button !== 0) return false;
    ev.stopPropagation();
    const id = Number(el.dataset.id);
    const m = this.#markers.find((x) => x.id === id);
    if (!m) return true;
    capture(el, ev.pointerId);
    const startX = ev.clientX;
    let t = m.t;
    let moved = false;
    const targets = [0, this.#duration, this.video.currentTime, ...this.#editPoints()];
    const move = (e) => {
      if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
      moved = true;
      const raw = Math.min(this.#duration, Math.max(0, m.t + (e.clientX - startX) / this.px));
      const snap = this.#snapOffset([raw], targets);
      t = raw + snap.offset;
      this.#showSnap(snap.at);
      el.style.left = `${t * this.px}px`;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      this.#showSnap(null);
      if (moved) this.setMarker(id, { t });
      else { this.video.pause(); this.onSeek(m.t); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
    return true;
  }

  #markerContext(ev) {
    const el = ev.target.closest(".tl-marker");
    if (!el) return false;
    ev.preventDefault();
    ev.stopPropagation();
    const id = Number(el.dataset.id);
    const m = this.#markers.find((x) => x.id === id);
    if (!m) return true;
    this.openMenu(ev.clientX, ev.clientY, [
      { label: "Name…", icon: "#i-type", action: () => this.renameMarker(id) },
      ...Object.entries(MARKER_COLORS).map(([color, hex]) => ({
        label: color[0].toUpperCase() + color.slice(1), swatch: hex, checked: m.color === color,
        action: () => { this.lastMarkerColor = color; this.setMarker(id, { color }); },
      })),
      { sep: true },
      { label: "Copy markers as YouTube chapters", icon: "#i-copy", action: () => this.copyChapters() },
      { sep: true },
      { label: "Delete marker", icon: "#i-trash", danger: true, action: () => this.deleteMarker(id) },
      { label: "Delete all markers", icon: "#i-trash", danger: true, disabled: this.#markers.length < 2, action: () => {
        this.store.update((d) => { d.markers = []; });
        this.toast("Markers deleted", { action: "Undo", onAction: () => this.store.undo() });
      } },
    ]);
    return true;
  }

  async copyChapters() {
    const text = this.chapters();
    try {
      await navigator.clipboard.writeText(text);
      this.toast("Chapters copied. Paste them into your YouTube description.");
    } catch {
      this.toast("Couldn't copy to the clipboard.");
    }
  }

  /* ---------- graded sections ---------- */

  get #sections() { return this.store.doc?.grade?.sections ?? []; }

  renderGrades() {
    this.grades.replaceChildren();
    if (!this.#media) return;
    if (this.gradeSelection != null && !this.#sections.some((s) => s.id === this.gradeSelection)) this.gradeSelection = null;
    for (const s of this.#sections) {
      const el = document.createElement("div");
      el.className = "tl-grade";
      el.dataset.id = s.id;
      el.style.left = `${s.start * this.px}px`;
      el.style.width = `${Math.max(2, (s.end - s.start) * this.px)}px`;
      el.classList.toggle("selected", s.id === this.gradeSelection);
      el.classList.toggle("bypassed", !!s.bypass);
      const name = document.createElement("span");
      name.className = "tl-clip-text";
      name.textContent = s.name || "Graded";
      el.title = `${s.name || "Graded"}${s.bypass ? " (bypassed)" : ""}. Drag to move, drag an edge to change where it starts or ends, double-click to rename.`;
      el.append(name);
      const remove = document.createElement("button");
      remove.className = "tl-remove";
      remove.title = "Remove this section's grade";
      remove.setAttribute("aria-label", `Remove the grade on ${s.name || "this section"}`);
      remove.innerHTML = `<svg class="icon"><use href="#i-x"/></svg>`;
      remove.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.selectGrade(s.id);
        this.onGradeDelete?.(s.id);
      });
      el.append(remove);
      for (const side of ["left", "right"]) {
        const h = document.createElement("div");
        h.className = `tl-trim ${side}`;
        h.dataset.side = side;
        el.append(h);
      }
      this.grades.append(el);
    }
  }

  /** Inline renaming on a graded section's block. */
  renameGrade(id) {
    const el = this.grades.querySelector(`.tl-grade[data-id="${id}"]`);
    const s = this.#sections.find((x) => x.id === id);
    if (!el || !s) return;
    const input = document.createElement("input");
    input.className = "tl-clip-input";
    input.value = s.name || "Graded";
    input.maxLength = 40;
    input.setAttribute("aria-label", "Section name");
    el.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== s.name) this.onGradeRename?.(id, input.value);
      else this.renderGrades();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  selectGrade(id) {
    this.gradeSelection = id;
    this.renderGrades();
    this.onGradeSelect?.(id);
  }

  /** The free time either side of a section: from the end of the one before to the start of the next. */
  #gradeRoom(id) {
    const list = this.#sections;
    const k = list.findIndex((s) => s.id === id);
    return { lo: k > 0 ? list[k - 1].end : 0, hi: k < list.length - 1 ? list[k + 1].start : this.#duration };
  }

  #gradeDown(ev) {
    if (ev.button !== 0) return;
    const block = ev.target.closest(".tl-grade");
    if (!block) {
      // Empty track: deselect and move the playhead there; dragging draws out a new section.
      this.selectGrade(null);
      const t0 = this.#timeAt(ev.clientX);
      this.onSeek(t0);
      if (!freeSpan(this.store.doc?.grade, this.#duration, t0)) return;
      this.#drawGrade(ev, t0);
      return;
    }
    const id = Number(block.dataset.id);
    const s = this.#sections.find((x) => x.id === id);
    if (!s) return;
    if (this.gradeSelection !== id) this.selectGrade(id);
    const trim = ev.target.closest(".tl-trim");
    const room = this.#gradeRoom(id);
    const startX = ev.clientX;
    const el = this.grades.querySelector(`.tl-grade[data-id="${id}"]`);
    capture(this.grades, ev.pointerId);
    const drag = { start: s.start, end: s.end };
    let active = false;
    const targets = [0, this.#duration, this.video.currentTime];
    const move = (e) => {
      const dx = e.clientX - startX;
      if (!active && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      active = true;
      const dt = dx / this.px;
      if (!trim) {
        const span = s.end - s.start;
        const snap = this.#snapOffset([s.start + dt, s.end + dt], targets);
        drag.start = Math.min(room.hi - span, Math.max(room.lo, s.start + dt + snap.offset));
        drag.end = drag.start + span;
      } else if (trim.dataset.side === "left") {
        const snap = this.#snapOffset([s.start + dt], targets);
        drag.start = Math.min(s.end - MIN_GRADE_SECS, Math.max(room.lo, s.start + dt + snap.offset));
      } else {
        const snap = this.#snapOffset([s.end + dt], targets);
        drag.end = Math.max(s.start + MIN_GRADE_SECS, Math.min(room.hi, s.end + dt + snap.offset));
      }
      el.style.left = `${drag.start * this.px}px`;
      el.style.width = `${(drag.end - drag.start) * this.px}px`;
    };
    const up = () => {
      this.grades.removeEventListener("pointermove", move);
      if (!active) return;
      this.store.update((d) => {
        const x = d.grade.sections.find((g) => g.id === id);
        if (x) { x.start = drag.start; x.end = drag.end; }
      });
    };
    this.grades.addEventListener("pointermove", move);
    this.grades.addEventListener("pointerup", up, { once: true });
    this.grades.addEventListener("pointercancel", up, { once: true });
  }

  /** Draws a new section from `t0` to wherever the pointer is let go, kept to the free time there. */
  #drawGrade(ev, t0) {
    const startX = ev.clientX;
    capture(this.grades, ev.pointerId);
    let span = null;
    let ghost = null;
    const move = (e) => {
      if (!ghost && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "tl-grade drawing";
        this.grades.append(ghost);
      }
      span = freeSpan(this.store.doc.grade, this.#duration, t0, this.#timeAt(e.clientX));
      ghost.style.left = `${span[0] * this.px}px`;
      ghost.style.width = `${(span[1] - span[0]) * this.px}px`;
    };
    const up = () => {
      this.grades.removeEventListener("pointermove", move);
      this.grades.removeEventListener("pointerup", up);
      this.grades.removeEventListener("pointercancel", up);
      ghost?.remove();
      if (span && span[1] - span[0] >= MIN_GRADE_SECS) this.onGradeAdd?.(span[0], span[1]);
    };
    this.grades.addEventListener("pointermove", move);
    this.grades.addEventListener("pointerup", up, { once: true });
    this.grades.addEventListener("pointercancel", up, { once: true });
  }

  /* ---------- grade context menu ---------- */

  #gradeContext(ev) {
    ev.preventDefault();
    const block = ev.target.closest(".tl-grade");
    const t = this.#timeAt(ev.clientX);
    const underCursor = block
      ? this.#sections.find((s) => s.id === Number(block.dataset.id))
      : this.#sections.find((s) => t >= s.start && t < s.end);
    if (underCursor && this.gradeSelection !== underCursor.id) this.selectGrade(underCursor.id);
    const selected = this.#sections.find((s) => s.id === this.gradeSelection) ?? underCursor ?? null;
    const splittable = this.#sections.some((s) => this.video.currentTime > s.start + 0.1 && this.video.currentTime < s.end - 0.1);
    this.openMenu(ev.clientX, ev.clientY, [
      { label: "Rename", icon: "#i-type", disabled: !selected, action: () => this.renameGrade(selected.id) },
      { label: selected?.bypass ? "Turn grade on" : "Bypass grade", icon: "#i-power", hint: "Ctrl+D", disabled: !selected, action: () => this.onGradeBypass?.(selected.id) },
      { sep: true },
      { label: "Copy grade", icon: "#i-copy", hint: "Ctrl+C", disabled: !selected, action: () => this.onGradeCopy?.(selected.id) },
      { label: "Paste grade", icon: "#i-paste", hint: "Ctrl+V", disabled: !selected || !this.hasGradeClipboard(), action: () => this.onGradePaste?.(selected.id) },
      { label: "Use the grade before this one", icon: "#i-prev", disabled: !selected || this.#sections[0]?.id === selected.id, action: () => this.onGradeMatchPrevious?.(selected.id) },
      { sep: true },
      { label: "Split at playhead", icon: "#i-scissors", hint: "Ctrl+K", disabled: !splittable, action: () => this.onGradeSplit?.() },
      { label: "Trim start to playhead", icon: "#i-in", hint: "[", disabled: !selected, action: () => this.onGradeTrim?.("start") },
      { label: "Trim end to playhead", icon: "#i-out", hint: "]", disabled: !selected, action: () => this.onGradeTrim?.("end") },
      { label: "Export as LUT…", icon: "#i-download", disabled: !selected, action: () => this.onGradeExportLut?.() },
      { label: "Reset look", icon: "#i-undo", disabled: !selected, action: () => this.onGradeReset?.(selected.id) },
      { label: "Remove grade", icon: "#i-trash", hint: "Del", danger: true, disabled: !selected, action: () => this.onGradeDelete?.(selected.id) },
    ]);
  }

  openMenu(x, y, items) {
    const menu = $("context-menu");
    menu.replaceChildren();
    for (const it of items) {
      if (it.sep) {
        const d = document.createElement("div");
        d.className = "menu-sep";
        menu.append(d);
        continue;
      }
      const b = document.createElement("button");
      b.className = `menu-item${it.danger ? " danger" : ""}`;
      b.setAttribute("role", "menuitem");
      if (it.icon) b.innerHTML = `<svg class="icon"><use href="${it.icon}"/></svg>`;
      else if (it.swatch) b.innerHTML = `<span class="menu-swatch" style="background:${it.swatch}"></span>`;
      else if (it.checked != null) b.innerHTML = `<span class="menu-check">${it.checked ? "✓" : ""}</span>`;
      if (it.checked != null) b.setAttribute("aria-checked", String(!!it.checked));
      if (it.checked != null) b.setAttribute("role", "menuitemcheckbox");
      b.append(document.createTextNode(it.label));
      if (it.hint) {
        const hint = document.createElement("span");
        hint.className = "menu-hint";
        hint.textContent = it.hint;
        b.append(hint);
      }
      b.disabled = !!it.disabled;
      if (!it.disabled) b.addEventListener("click", () => { this.closeMenu(); it.action(); });
      menu.append(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }

  closeMenu() {
    $("context-menu").hidden = true;
  }

  /* ---------- canvases ---------- */

  draw() {
    if (this.#drawQueued) return;
    this.#drawQueued = true;
    requestAnimationFrame(() => {
      this.#drawQueued = false;
      this.#drawRuler();
      this.#drawThumbs();
      this.#drawWaveform();
    });
  }

  #prepare(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.#viewWidth;
    const h = canvas.parentElement.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, left: this.scroll.scrollLeft };
  }

  #drawRuler() {
    const { ctx, w, h, left } = this.#prepare(this.canvases.ruler);
    if (!this.#duration) return;
    const step = TICK_STEPS.find((s) => s * this.px >= 80) ?? TICK_STEPS.at(-1);
    const minor = step / 5;
    const t0 = Math.floor(left / this.px / minor) * minor;
    const t1 = Math.min(this.#duration, (left + w) / this.px);
    ctx.font = "11px 'Cascadia Mono', Consolas, monospace";
    ctx.textBaseline = "top";
    for (let t = t0; t <= t1 + 1e-9; t += minor) {
      const x = Math.round(t * this.px - left) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.strokeStyle = major ? "#5a606a" : "#33373e";
      ctx.beginPath();
      ctx.moveTo(x, major ? h - 12 : h - 6);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = "#8b9098";
        ctx.fillText(label(Math.max(0, t), step), x + 4, 4);
      }
    }
    // Past the end of the video.
    const end = this.#duration * this.px - left;
    if (end < w) {
      ctx.fillStyle = "#0b0c0e";
      ctx.fillRect(Math.max(0, end), 0, w - end, h);
    }
  }

  #drawThumbs() {
    const { ctx, w, h, left } = this.#prepare(this.canvases.video);
    const thumbs = this.#thumbs;
    const span = Math.min(w, this.#duration * this.px - left);
    ctx.fillStyle = "#1c2433";
    ctx.fillRect(0, 0, Math.max(0, span), h);
    if (!thumbs || span <= 0) return;
    const tw = thumbs.width;
    const th = 48;
    const y = Math.round((h - th) / 2);
    const first = Math.floor(left / tw) * tw;
    for (let x = first; x < left + span; x += tw) {
      const t = (x + tw / 2) / this.px;
      const i = Math.min(thumbs.count - 1, Math.max(0, Math.floor((t / this.#duration) * thumbs.count)));
      const sx = (i % thumbs.columns) * tw;
      const sy = Math.floor(i / thumbs.columns) * th;
      const dw = Math.min(tw, left + span - x);
      ctx.drawImage(thumbs.image, sx, sy, dw, th, x - left, y, dw, th);
    }
  }

  #drawWaveform() {
    const { ctx, w, h, left } = this.#prepare(this.canvases.audio);
    const span = Math.min(w, this.#duration * this.px - left);
    ctx.fillStyle = "#16261f";
    ctx.fillRect(0, 0, Math.max(0, span), h);
    const wave = this.#waveform;
    if (!wave?.peaks?.length || span <= 0) return;
    const mid = h / 2;
    ctx.fillStyle = "#5fc995";
    for (let x = 0; x < span; x++) {
      const a = Math.floor(((left + x) / this.px) * wave.rate);
      const b = Math.max(a + 1, Math.floor(((left + x + 1) / this.px) * wave.rate));
      let peak = 0;
      for (let i = a; i < b && i < wave.peaks.length; i++) peak = Math.max(peak, wave.peaks[i]);
      const half = Math.max(0.5, (peak / 255) * (mid - 3));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }
}
