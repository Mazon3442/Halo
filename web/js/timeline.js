// The timeline: a ruler with the playhead, a caption track you edit directly, a colour track of
// graded sections, and the video and audio tracks for reference. Caption blocks are DOM elements; the ruler, thumbnails and waveform
// are canvases drawn only for the visible stretch, so long videos stay cheap at any zoom.

import { api } from "./api.js";
import {
  MIN_WORD, deleteLines, editLine, groupLines, insertLine, lineTimes, lockLine, mergeLines, moveLines,
  retimeLine, setWordBoundary, splitLine,
} from "./captions.js";

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

/** Keeps a drag going when the pointer leaves the element. */
function capture(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* not a live pointer; the drag still works inside */ }
}

function label(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return step < 1 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(s)).padStart(2, "0")}`;
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

  constructor({ store, video, toast, onSelectionChange, onSeek, onGradeSelect }) {
    this.store = store;
    this.onGradeSelect = onGradeSelect;
    this.grades = $("tl-grades");
    this.video = video;
    this.toast = toast;
    this.onSelectionChange = onSelectionChange;
    this.onSeek = onSeek;
    this.scroll = $("tl-scroll");
    this.content = $("tl-content");
    this.track = $("tl-captions");
    this.playhead = $("tl-playhead");
    this.canvases = { ruler: $("tl-ruler"), video: $("tl-video"), audio: $("tl-audio") };
    this.#bind();
    new ResizeObserver(() => {
      if (this.#fitted) this.fit();
      else { this.#layout(); this.draw(); }
    }).observe(this.scroll);
  }

  get #captions() { return this.store.doc?.captions; }

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
    this.track.replaceChildren();
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

  /* ---------- caption blocks ---------- */

  renderBlocks() {
    this.renderGrades();
    const cap = this.#captions;
    this.track.replaceChildren();
    if (!cap || !this.#media) { this.#lines = []; return; }
    const { words } = cap;
    this.#lines = groupLines(words, cap.perLine);
    const ids = new Set(this.#lines.map((l) => words[l.from].id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);

    this.#lines.forEach((line, k) => {
      const { start, end } = lineTimes(words, this.#lines, k);
      const id = words[line.from].id;
      const el = document.createElement("div");
      el.className = "tl-clip";
      el.dataset.k = k;
      el.style.left = `${start * this.px}px`;
      el.style.width = `${Math.max(2, (end - start) * this.px)}px`;
      const selected = this.selection.has(id);
      el.classList.toggle("selected", selected);
      el.title = words.slice(line.from, line.to).map((w) => w.text).join(" ");
      const placed = words[line.from].group != null ? cap.overrides?.[words[line.from].group]?.y : null;
      if (placed != null) {
        // Captions moved on their own show where they sit.
        el.dataset.place = placed < 0.4 ? "↑" : placed < 0.68 ? "•" : "↓";
        el.title += placed < 0.4 ? " (top)" : placed < 0.68 ? " (middle)" : " (bottom)";
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
        text.textContent = el.title;
        el.append(text);
      }
      for (const side of ["left", "right"]) {
        const h = document.createElement("div");
        h.className = `tl-trim ${side}`;
        h.dataset.side = side;
        el.append(h);
      }
      this.track.append(el);
    });
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

  selectAll() { this.select(this.#lines.map((l) => this.#captions.words[l.from].id)); }

  /** Selected lines as index ranges, in time order. */
  #selectedLines() {
    const words = this.#captions.words;
    return this.#lines.filter((l) => this.selection.has(words[l.from].id));
  }

  #lineTimes(k) { return lineTimes(this.#captions.words, this.#lines, k); }

  /* ---------- edits ---------- */

  #commit(mutate, coalesce) { this.store.update((d) => mutate(d.captions), { coalesce }); }

  splitAtPlayhead() {
    const t = this.video.currentTime;
    const words = this.#captions?.words ?? [];
    const k = this.#lines.findIndex((l) => t > words[l.from].start && t < words[l.to - 1].end);
    if (k < 0) return this.toast("Move the playhead over a caption to split it.");
    const line = this.#lines[k];
    let ok = false;
    this.#commit((c) => { ok = splitLine(c, line, t); });
    if (!ok) this.toast("That caption is one word, so there's nothing to split.");
  }

  mergeSelected() {
    const lines = this.#selectedLines();
    if (lines.length < 2) return this.toast("Select two or more neighbouring captions to merge.");
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

  /** Adds an empty-ish caption at time t in the gap it falls in, then opens it for typing. */
  addAt(t) {
    if (!this.#captions) return;
    const words = this.#captions.words;
    if (this.#lines.some((l) => t >= words[l.from].start && t < words[l.to - 1].end)) {
      return this.toast("There's already a caption here. Move the playhead to a gap.");
    }
    const next = this.#lines.find((l) => words[l.from].start > t);
    const end = Math.min(t + NEW_CAPTION_SECS, next ? words[next.from].start : this.#duration);
    if (end - t < 0.3) return this.toast("There isn't room for a caption here.");
    let id;
    this.#commit((c) => { id = insertLine(c, t, end, "New caption"); });
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
    const step = frames / (this.#media?.fps || 30);
    const delta = this.#clampMove(lines, step);
    if (delta !== 0) this.#commit((c) => moveLines(c, lines, delta), "nudge");
  }

  /** Limits a move so the selection stays inside the video and clear of other captions. */
  #clampMove(lines, delta) {
    const words = this.#captions.words;
    const selected = new Set(lines.map((l) => l.from));
    let min = -Infinity;
    let max = Infinity;
    for (const line of lines) {
      const k = this.#lines.indexOf(line);
      const start = words[line.from].start;
      const end = words[line.to - 1].end;
      let prev = k - 1;
      while (prev >= 0 && selected.has(this.#lines[prev].from)) prev--;
      let next = k + 1;
      while (next < this.#lines.length && selected.has(this.#lines[next].from)) next++;
      const lo = prev >= 0 ? words[this.#lines[prev].to - 1].end : 0;
      const hi = next < this.#lines.length ? words[this.#lines[next].from].start : this.#duration;
      min = Math.max(min, lo - start);
      max = Math.min(max, hi - end);
    }
    return Math.min(max, Math.max(min, delta));
  }

  /** Inline text editing on a block. */
  editText(k) {
    const el = this.track.querySelector(`.tl-clip[data-k="${k}"]`);
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
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (save && text && text !== words.slice(line.from, line.to).map((w) => w.text).join(" ")) {
        this.#commit((c) => editLine(c, line, text));
      } else {
        this.renderBlocks();
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  /* ---------- snapping ---------- */

  /** Times a dragged edge may snap to: the playhead, other captions' edges, and the ends. */
  #snapTargets(excludeFroms) {
    const words = this.#captions.words;
    const targets = [0, this.#duration, this.video.currentTime];
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
    $("tl-split").addEventListener("click", () => this.splitAtPlayhead());
    $("tl-merge").addEventListener("click", () => this.mergeSelected());
    $("tl-delete").addEventListener("click", () => this.deleteSelected());
    $("tl-add").addEventListener("click", () => this.addAt(this.video.currentTime));
    for (const id of ["tl-top", "tl-middle", "tl-bottom"]) $(id).addEventListener("click", () => this.place($(id).dataset.place));

    this.scroll.addEventListener("scroll", () => this.draw());
    this.scroll.addEventListener("wheel", (ev) => {
      if (ev.ctrlKey) {
        ev.preventDefault();
        const r = this.scroll.getBoundingClientRect();
        this.zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, this.#timeAt(ev.clientX), ev.clientX - r.left);
      } else if (!ev.shiftKey && Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        ev.preventDefault();
        this.scroll.scrollLeft += ev.deltaY;
      }
    }, { passive: false });

    // Scrub by dragging on the ruler, or click the video and audio tracks to jump.
    for (const id of ["tl-ruler-row", "tl-video-row", "tl-audio-row"]) {
      $(id).addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        const el = ev.currentTarget;
        capture(el, ev.pointerId);
        this.video.pause();
        this.onSeek(this.#timeAt(ev.clientX));
        const move = (e) => this.onSeek(this.#timeAt(e.clientX));
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", () => el.removeEventListener("pointermove", move), { once: true });
      });
    }

    this.track.addEventListener("pointerdown", (ev) => this.#pointerDown(ev));
    this.grades.addEventListener("pointerdown", (ev) => this.#gradeDown(ev));
    this.track.addEventListener("dblclick", (ev) => {
      const clip = ev.target.closest(".tl-clip");
      if (clip) this.editText(Number(clip.dataset.k));
      else this.addAt(this.#timeAt(ev.clientX));
    });
  }

  toggleSnapping() {
    this.snapping = !this.snapping;
    $("tl-snap").setAttribute("aria-pressed", String(this.snapping));
    this.toast(this.snapping ? "Snapping on" : "Snapping off");
  }

  #pointerDown(ev) {
    if (ev.button !== 0 || !this.#captions) return;
    if (ev.target.closest(".tl-clip-input")) return;
    const clip = ev.target.closest(".tl-clip");
    const startX = ev.clientX;
    capture(this.track, ev.pointerId);

    if (!clip) {
      // Empty track: click clears the selection, drag draws a selection box.
      this.#drag = { kind: "marquee", startX, additive: ev.shiftKey || ev.ctrlKey, base: new Set(this.selection) };
    } else {
      const k = Number(clip.dataset.k);
      const line = this.#lines[k];
      const words = this.#captions.words;
      const id = words[line.from].id;
      const edge = ev.target.closest(".tl-word-edge");
      const trim = ev.target.closest(".tl-trim");
      if (edge) {
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
        this.#drag = { kind: "move", startX, lines: this.#selectedLines() };
      }
    }
    const move = (e) => this.#pointerMove(e);
    const up = (e) => {
      this.track.removeEventListener("pointermove", move);
      this.#pointerUp(e);
    };
    this.track.addEventListener("pointermove", move);
    this.track.addEventListener("pointerup", up, { once: true });
    this.track.addEventListener("pointercancel", up, { once: true });
  }

  #pointerMove(ev) {
    const d = this.#drag;
    if (!d) return;
    const dx = ev.clientX - d.startX;
    if (!d.active && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.active = true;
    const dt = dx / this.px;
    const words = this.#captions.words;

    if (d.kind === "move") {
      const froms = new Set(d.lines.map((l) => l.from));
      const edges = d.lines.flatMap((l) => [words[l.from].start + dt, words[l.to - 1].end + dt]);
      const snap = this.#snapOffset(edges, this.#snapTargets(froms));
      d.delta = this.#clampMove(d.lines, dt + snap.offset);
      this.#showSnap(snap.offset && d.delta === dt + snap.offset ? snap.at : null);
      for (const el of this.track.querySelectorAll(".tl-clip.selected")) el.style.transform = `translateX(${d.delta * this.px}px)`;
    } else if (d.kind === "trim") {
      const line = this.#lines[d.k];
      const count = line.to - line.from;
      const prev = this.#lines[d.k - 1];
      const next = this.#lines[d.k + 1];
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
      const el = this.track.querySelector(`.tl-clip[data-k="${d.k}"]`);
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
      const box = $("tl-marquee");
      box.hidden = false;
      box.style.left = `${lo * this.px}px`;
      box.style.width = `${(hi - lo) * this.px}px`;
      const hits = this.#lines
        .filter((l) => words[l.to - 1].end > lo && words[l.from].start < hi)
        .map((l) => words[l.from].id);
      this.selection = new Set([...(d.additive ? d.base : []), ...hits]);
      for (const el of this.track.querySelectorAll(".tl-clip")) {
        el.classList.toggle("selected", this.selection.has(words[this.#lines[Number(el.dataset.k)].from].id));
      }
    }
  }

  #pointerUp(ev) {
    const d = this.#drag;
    this.#drag = null;
    this.#showSnap(null);
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
    if (d.kind === "move" && d.delta) this.#commit((c) => moveLines(c, d.lines, d.delta));
    else if (d.kind === "trim" && d.newStart != null) {
      const line = this.#lines[d.k];
      this.#commit((c) => retimeLine(c, line, d.newStart, d.newEnd));
    } else if (d.kind === "word" && d.t != null) this.#commit((c) => setWordBoundary(c, d.i, d.t));
    else if (d.kind === "marquee") { this.renderBlocks(); this.onSelectionChange?.(this.selection); return; }
    this.renderBlocks();
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
      const name = document.createElement("span");
      name.className = "tl-clip-text";
      name.textContent = s.name || "Graded";
      el.title = `${s.name || "Graded"}. Drag to move, drag an edge to change where it starts or ends.`;
      el.append(name);
      for (const side of ["left", "right"]) {
        const h = document.createElement("div");
        h.className = `tl-trim ${side}`;
        h.dataset.side = side;
        el.append(h);
      }
      this.grades.append(el);
    }
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
      // Empty track: deselect and move the playhead there.
      this.selectGrade(null);
      this.onSeek(this.#timeAt(ev.clientX));
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
