import JASSUB from "/vendor/jassub/jassub.js";
import { api } from "./api.js";
import { Store, newDocument } from "./store.js";
import {
  buildAss, buildMask, editLine, ensureIds, ensureTracks, findFillers, findIndexes, groupLines, lineTimes, parseSrt, replaceIndexes,
  sortWords, stripFillers, trackOf, usedFonts,
} from "./captions.js";
import { createExporter } from "./export.js";
import { Timeline } from "./timeline.js";
import { createInspector } from "./inspector.js";
import { createColorPanel } from "./color.js";
import { bakeSections, needsTransform } from "./grade.js";
import { normalizeStyle } from "./styles.js";
import { loadUserPlugins } from "./plugins/registry.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const store = new Store();
let media = null;
let prefs = {};
let tab = "background";

const MODE_HINTS = {
  none: "The background stays as filmed.",
  blur: "Keeps you sharp and blurs everything behind you.",
  remove: "Makes the background transparent. Export as ProRes or WebM to keep it.",
  color: "Puts a solid color behind you, like a green screen.",
};

/* ---------- small helpers ---------- */

let toastTimer = null;
function toast(message, { action, onAction } = {}) {
  const el = $("toast");
  el.replaceChildren(message);
  if (action) {
    const b = document.createElement("button");
    b.className = "btn ghost";
    b.style.marginLeft = "8px";
    b.textContent = action;
    b.addEventListener("click", () => { el.hidden = true; onAction(); });
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function relativeTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

function timecode(t, fps) {
  const f = Math.max(1, Math.round(fps || 30));
  const total = Math.max(0, Math.floor(t * f + 1e-6));
  const frames = total % f;
  const secs = Math.floor(total / f);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(frames)}`;
}

function shortTime(t) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}

/** Form controls keep their own keys (text undo, slider and radio arrows). */
function isTyping(el) {
  return !!el?.closest?.("input, textarea, select");
}

const savePrefs = () => api.put("/prefs", prefs).catch(() => {});
const exporter = createExporter({
  store, getMedia: () => media, getPrefs: () => prefs, savePrefs, toast, bakeGrades: () => bakeSections(store.doc.grade, media?.duration ?? 0),
});
const timeline = new Timeline({
  store,
  video,
  toast,
  onSelectionChange: () => { markSelectedRows(); inspector.render(); },
  onSeek: (t) => seekTo(t),
  onGradeSelect: (id) => { if (id != null && tab !== "color") setTab("color"); else color.render(); },
});
const inspector = createInspector({ store, timeline, video, toast });
const color = createColorPanel({ store, timeline, video, toast, getPrefs: () => prefs, savePrefs, isComparing: () => comparing });
timeline.onSplitRequest = () => splitAtPlayhead();

/* ---------- start screen ---------- */

async function showHome() {
  await store.flush();
  store.close();
  media = null;
  exporter.reset();
  timeline.close();
  inspector.setVisible(false);
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("editor").hidden = true;
  $("home").hidden = false;
  for (const id of ["tabs", "undo", "redo", "export-btn"]) $(id).hidden = true;
  $("doc-name").textContent = "";
  $("save-state").textContent = "";
  document.title = "Halo";
  renderRecents();
}

async function renderRecents() {
  const list = $("recent-list");
  let recents = [];
  try { recents = await api.get("/projects"); } catch { /* the list just stays empty */ }
  list.replaceChildren();
  if (recents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-recents";
    empty.textContent = "Videos you open show up here, with their captions and settings.";
    list.append(empty);
    return;
  }
  for (const r of recents) {
    const row = document.createElement("div");
    row.className = "recent";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = r.exists ? `Open ${r.video_path}` : "This video was moved or deleted";

    const text = document.createElement("div");
    text.style.minWidth = "0";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = r.name;
    const path = document.createElement("div");
    path.className = "path";
    path.textContent = r.video_path;
    text.append(name, path);

    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("span");
    when.className = r.exists ? "" : "missing";
    when.textContent = r.exists ? relativeTime(r.updated) : "File missing";
    const forget = document.createElement("button");
    forget.className = "btn ghost icon-only forget";
    forget.title = "Remove from recent";
    forget.setAttribute("aria-label", `Remove ${r.name} from recent`);
    forget.innerHTML = `<svg class="icon"><use href="#i-x"/></svg>`;
    forget.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api.del(`/projects/${r.id}`).catch(() => {});
      renderRecents();
    });
    meta.append(when, forget);
    row.append(text, meta);

    const openIt = () => (r.exists ? openPath(r.video_path) : toast("That video was moved or deleted. Open it from its new location."));
    row.addEventListener("click", openIt);
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter") openIt(); });
    list.append(row);
  }
}

async function chooseVideo() {
  try {
    const { path } = await api.post("/dialog/open");
    if (path) openPath(path);
  } catch (err) {
    toast(err.message);
  }
}

/** Opens a video by path, restoring its saved project if there is one. */
async function openPath(path) {
  dragging(false);
  let opened;
  try {
    opened = await api.post("/media", { path });
  } catch (err) {
    toast(err.message);
    return;
  }
  await store.flush();
  let doc;
  try {
    doc = await api.get(`/projects/${opened.project_id}`);
  } catch {
    doc = newDocument(opened);
  }
  doc.name = opened.name;
  doc.video_path = opened.path;
  ensureIds(doc.captions);
  ensureTracks(doc.captions);
  doc.captions.style = normalizeStyle(doc.captions.style);
  doc.captions.overrides ??= {};
  doc.grade ??= { sections: [], nextId: 1 };
  media = opened;
  exporter.reset();
  store.load(opened.project_id, doc);
  store.saveSoon(); // puts the video in the recent list

  document.documentElement.style.setProperty("--ar", `${media.width} / ${media.height}`);
  document.documentElement.style.setProperty("--arn", String(media.width / media.height || 16 / 9));
  document.title = `${media.name} · Halo`;
  $("doc-name").textContent = media.name;
  $("doc-name").title = media.path;
  $("home").hidden = true;
  $("editor").hidden = false;
  for (const id of ["tabs", "undo", "redo", "export-btn"]) $(id).hidden = false;
  hideEffect();
  video.src = api.mediaUrl(media.id);
  setTab(doc.captions.words.length && doc.background.mode === "none" ? "captions" : "background");
  timeline.open(media);
  timeline.renderBlocks();
}

function dragging(on) {
  $("drop-veil").hidden = !on || !$("home").hidden;
  document.body.classList.toggle("dragging", on);
}

// Called from the Rust side, which sees the file path of anything dropped on the window.
window.halo = { openPath, dragging };

$("open-card").addEventListener("click", chooseVideo);
$("home-btn").addEventListener("click", showHome);

/* ---------- tabs ---------- */

function setTab(name) {
  tab = name;
  $("editor").classList.toggle("on-color", name === "color");
  color.setActive(name === "color");
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  $("panel-background").hidden = name !== "background";
  $("panel-captions").hidden = name !== "captions";
  $("panel-color").hidden = name !== "color";
  inspector.setVisible(name === "captions" && !!store.doc);
  if (name === "captions") refreshSpeech();
  updateEffect();
  if (name === "color") color.render();
}

for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setTab(t.dataset.tab));
$("tabs").addEventListener("keydown", (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  const order = ["background", "captions", "color"];
  const next = order[(order.indexOf(tab) + (ev.key === "ArrowRight" ? 1 : 2)) % 3];
  ev.stopPropagation();
  ev.preventDefault();
  setTab(next);
  $(`tab-${next}`).focus();
});

/* ---------- rendering the document ---------- */

let lastAss = null;

function render() {
  const doc = store.doc;
  if (!doc) return;
  const bg = doc.background;
  const cap = doc.captions;

  for (const r of document.querySelectorAll("input[name=mode]")) r.checked = r.value === bg.mode;
  $("mode-hint").textContent = MODE_HINTS[bg.mode];
  $("blur-group").hidden = bg.mode !== "blur";
  $("color-group").hidden = bg.mode !== "color";
  $("preview-note").hidden = bg.mode === "none";
  $("blur").value = bg.blur;
  $("blur-value").textContent = bg.blur;
  $("color").value = bg.color;
  if (document.activeElement !== $("color-hex")) $("color-hex").value = bg.color;
  for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-pressed", String(s.dataset.color === bg.color));
  $("background-dot").hidden = bg.mode === "none";

  $("language").value = cap.language;
  $("per-line").value = cap.perLine;
  $("per-line-value").textContent = cap.perLine;
  $("captions-dot").hidden = cap.words.length === 0;
  $("captions-empty-hint").hidden = cap.words.length > 0;
  $("transcribe-label").textContent = cap.words.length ? "Transcribe again" : "Generate captions";
  renderLines();
  timeline.renderBlocks();
  inspector.render();
  color.render();

  $("undo").disabled = !store.canUndo;
  $("redo").disabled = !store.canRedo;
  updateSubtitles();
}

store.addEventListener("change", () => {
  render();
  scheduleEffect();
});

store.addEventListener("save", ({ detail }) => {
  const el = $("save-state");
  el.classList.toggle("error", detail.state === "error");
  el.textContent = { pending: "", saving: "Saving…", saved: "Saved", error: "Couldn't save" }[detail.state];
  el.title = detail.error ?? "";
});

/* ---------- background controls ---------- */

for (const r of document.querySelectorAll("input[name=mode]")) {
  r.addEventListener("change", () => store.update((d) => (d.background.mode = r.value)));
}
$("blur").addEventListener("input", () => store.update((d) => (d.background.blur = Number($("blur").value)), { coalesce: "blur" }));
$("color").addEventListener("input", () => store.update((d) => (d.background.color = $("color").value), { coalesce: "color" }));
$("color-hex").addEventListener("change", () => {
  let v = $("color-hex").value.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-f]{6}$/i.test(v)) store.update((d) => (d.background.color = v.toLowerCase()));
  else $("color-hex").value = store.doc.background.color;
});
for (const s of document.querySelectorAll(".swatch")) {
  s.addEventListener("click", () => store.update((d) => (d.background.color = s.dataset.color)));
}

/* ---------- effect preview on the paused frame ---------- */

let effectTimer = null;
let effectBusy = false;
let effectDirty = false;
let comparing = false;

function badge(text, spinning = false) {
  const el = $("badge");
  el.hidden = !text;
  el.innerHTML = spinning ? `<span class="spin" aria-hidden="true"></span>` : "";
  el.append(text ?? "");
}

function hideEffect() {
  $("effect").hidden = true;
  badge(null);
}

function wantsEffect() {
  return store.doc && media && tab === "background" && store.doc.background.mode !== "none" && video.paused && !comparing;
}

/** Compare is offered where there's something to compare: an effect, or a grade. */
function canCompare() {
  const doc = store.doc;
  if (!doc) return false;
  if (tab === "background") return doc.background.mode !== "none";
  return tab === "color" && (doc.grade.sections.length > 0 || needsTransform(doc.grade));
}

function updateEffect() {
  $("compare").hidden = !canCompare();
  if (!wantsEffect()) {
    $("effect").hidden = true;
    if (!effectBusy) badge(null);
    return;
  }
  scheduleEffect(0);
}

function scheduleEffect(delay = 220) {
  clearTimeout(effectTimer);
  if (!wantsEffect()) return updateEffectVisibility();
  effectTimer = setTimeout(requestEffect, delay);
}

function updateEffectVisibility() {
  $("effect").hidden = !wantsEffect() || !$("effect").src;
  $("compare").hidden = !canCompare();
}

async function requestEffect() {
  if (!wantsEffect()) return;
  if (effectBusy) { effectDirty = true; return; }
  effectBusy = true;
  effectDirty = false;
  const bg = store.doc.background;
  const t = video.currentTime;
  const params = new URLSearchParams({ t: t.toFixed(3), mode: bg.mode, blur: bg.blur, color: bg.color });
  badge("Rendering effect…", true);
  try {
    const blob = await api.get(`/media/${media.id}/preview?${params}`);
    const img = $("effect");
    const old = img.src;
    img.src = URL.createObjectURL(blob);
    if (old) URL.revokeObjectURL(old);
    img.classList.toggle("checker", bg.mode === "remove");
    badge(null);
  } catch (err) {
    badge(err.message);
  } finally {
    effectBusy = false;
    if (effectDirty) requestEffect();
    else updateEffectVisibility();
  }
}

function setComparing(on) {
  comparing = on;
  $("compare").classList.toggle("primary", on);
  updateEffectVisibility();
  if (on) badge("Original");
  else { badge(null); if (wantsEffect() && !$("effect").src) scheduleEffect(0); }
}

$("compare").addEventListener("pointerdown", () => setComparing(true));
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) $("compare").addEventListener(ev, () => comparing && setComparing(false));

/* ---------- player ---------- */

function updateTime() {
  const d = video.duration || media?.duration || 0;
  const t = video.currentTime;
  $("timecode").innerHTML = `<b>${timecode(t, media?.fps)}</b> / ${timecode(d, media?.fps)}`;
  const pct = d ? (t / d) * 100 : 0;
  $("seek-fill").style.width = `${pct}%`;
  $("seek-knob").style.left = `${pct}%`;
  $("seekbar").setAttribute("aria-valuemax", d.toFixed(2));
  $("seekbar").setAttribute("aria-valuenow", t.toFixed(2));
  $("seekbar").setAttribute("aria-valuetext", timecode(t, media?.fps));
  timeline.updatePlayhead(t, !video.paused);
  highlightLine(t);
}

function tick() {
  updateTime();
  if (!video.paused) requestAnimationFrame(tick);
}

function togglePlay() {
  if (!media) return;
  if (video.paused) { video.playbackRate = 1; video.play(); } else video.pause();
}

function seekTo(t) {
  const d = video.duration || 0;
  video.currentTime = Math.min(Math.max(0, t), d);
}

function stepFrames(n) {
  video.pause();
  seekTo(video.currentTime + n / (media?.fps || 30));
}

video.addEventListener("play", () => {
  $("play").innerHTML = `<svg class="icon"><use href="#i-pause"/></svg>`;
  $("play").setAttribute("aria-label", "Pause");
  $("effect").hidden = true;
  requestAnimationFrame(tick);
});
video.addEventListener("pause", () => {
  $("play").innerHTML = `<svg class="icon"><use href="#i-play"/></svg>`;
  $("play").setAttribute("aria-label", "Play");
  scheduleEffect(0);
});
video.addEventListener("seeking", () => { $("effect").hidden = true; });
video.addEventListener("seeked", () => { updateTime(); scheduleEffect(120); });
video.addEventListener("loadedmetadata", () => { updateTime(); updateSubtitles(); scheduleEffect(0); });
video.addEventListener("timeupdate", () => { if (video.paused) updateTime(); });
video.addEventListener("click", togglePlay);
$("play").addEventListener("click", togglePlay);
$("frame-back").addEventListener("click", () => stepFrames(-1));
$("frame-next").addEventListener("click", () => stepFrames(1));

const seekbar = $("seekbar");
function seekFromPointer(ev) {
  const r = seekbar.getBoundingClientRect();
  seekTo(((ev.clientX - r.left) / r.width) * (video.duration || 0));
}
seekbar.addEventListener("pointerdown", (ev) => {
  seekbar.setPointerCapture(ev.pointerId);
  seekFromPointer(ev);
  const move = (e) => seekFromPointer(e);
  seekbar.addEventListener("pointermove", move);
  seekbar.addEventListener("pointerup", () => seekbar.removeEventListener("pointermove", move), { once: true });
});

/* ---------- speech model and transcription ---------- */

async function refreshSpeech() {
  let s;
  try { s = await api.get("/speech"); } catch { return; }
  $("speech-missing").hidden = !(s.state === "missing" || s.state === "failed");
  $("speech-downloading").hidden = s.state !== "downloading";
  $("speech-ready").hidden = s.state !== "ready";
  const note = $("speech-missing-text");
  note.classList.toggle("error", s.state === "failed");
  note.textContent = s.state === "failed"
    ? `The download didn't finish: ${s.error}`
    : "Captions use two models that run on this PC: one hears the words, one times each word exactly. It's a one-time download of up to 670 MB.";
  $("speech-download").textContent = s.state === "failed" ? "Try again" : "Download speech models";
  if (s.state === "downloading") {
    const pct = s.total ? s.received / s.total : 0;
    $("speech-bar").style.width = `${pct * 100}%`;
    $("speech-progress-text").textContent = s.total
      ? `Downloading speech model · ${Math.round(s.received / 1e6)} of ${Math.round(s.total / 1e6)} MB`
      : "Starting download…";
    setTimeout(refreshSpeech, 500);
  }
}

$("speech-download").addEventListener("click", async () => {
  await api.post("/speech/download").catch((e) => toast(e.message));
  refreshSpeech();
});

$("language").addEventListener("change", () => store.update((d) => (d.captions.language = $("language").value)));

let transcribing = false;
$("transcribe").addEventListener("click", async () => {
  if (!media || transcribing) return;
  transcribing = true;
  const button = $("transcribe");
  const status = $("transcribe-status");
  button.disabled = true;
  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "Listening… the first run takes a few extra seconds to load the model.";
  const forId = media.id;
  try {
    const words = await api.post(`/media/${forId}/transcribe`, { language: store.doc.captions.language });
    if (media?.id !== forId) return;
    const replacing = store.doc.captions.words.length > 0;
    store.update((d) => replaceMainTrack(d.captions, words));
    status.textContent = words.length ? `${words.length} words transcribed.` : "No speech found in this video.";
    if (replacing) toast("Captions replaced", { action: "Undo", onAction: () => store.undo() });
  } catch (err) {
    status.classList.add("error");
    status.textContent = err.message;
  } finally {
    transcribing = false;
    button.disabled = false;
  }
});

$("per-line").addEventListener("input", () => store.update((d) => (d.captions.perLine = Number($("per-line").value)), { coalesce: "perLine" }));

/**
 * Puts new words (a transcription or an imported SRT) on the first caption track, in place of the
 * ones there. Captions stacked on the other tracks, and their styles, stay as they are.
 */
function replaceMainTrack(cap, words) {
  const main = cap.tracks[0].id;
  const kept = cap.words.filter((w) => trackOf(w) !== main);
  const keptGroups = new Set(kept.map((w) => w.group).filter((g) => g != null));
  for (const g of Object.keys(cap.overrides ?? {})) if (!keptGroups.has(Number(g))) delete cap.overrides[g];
  cap.words = [...words.map((w) => ({ ...w, track: main })), ...kept];
  // New groups have to number past the ones the kept captions use.
  cap.edits = Math.max(0, ...keptGroups);
  ensureIds(cap);
  sortWords(cap);
}

/* ---------- caption cleanup: filler words, find and replace, SRT import ---------- */

function captionWords() { return store.doc?.captions?.words ?? []; }

function updateFindCount() {
  const find = $("fr-find").value.trim();
  const n = find ? findIndexes(captionWords(), find).length : 0;
  $("fr-count").textContent = find ? (n ? `${n} match${n === 1 ? "" : "es"}` : "No matches") : "";
}

$("fr-find").addEventListener("input", updateFindCount);
$("fr-replace").addEventListener("input", updateFindCount);

$("fr-replace-all").addEventListener("click", () => {
  const find = $("fr-find").value.trim();
  const replace = $("fr-replace").value;
  const indexes = findIndexes(captionWords(), find);
  if (!indexes.length) return toast("No matches to replace.");
  store.update((d) => { d.captions.words = replaceIndexes(d.captions.words, indexes, replace); });
  toast(`Replaced ${indexes.length} word${indexes.length === 1 ? "" : "s"}.`, { action: "Undo", onAction: () => store.undo() });
});

$("clean-filler").addEventListener("click", () => {
  const cap = store.doc?.captions;
  if (!cap || !cap.words.length) return toast("No captions yet. Generate or import some first.");
  const { words: next, removed } = stripFillers(cap);
  if (!removed) return toast("No filler words found.");
  const found = findFillers(cap.words).map((i) => cap.words[i].text.trim());
  store.update((d) => { d.captions.words = next; });
  const list = found.slice(0, 10).map((w) => `"${w}"`).join(", ");
  toast(`Removed ${removed} filler word${removed === 1 ? "" : "s"}${found.length > 10 ? ", …" : ""}${list ? `: ${list}` : "."}`, { action: "Undo", onAction: () => store.undo() });
});

$("import-srt").addEventListener("click", () => $("import-srt-file").click());
$("import-srt-file").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const words = parseSrt(await file.text());
    if (!words.length) return toast("Couldn't find any captions in that file.");
    store.update((d) => replaceMainTrack(d.captions, words.map((w) => ({ ...w, id: null, group: null }))));
    toast(`Imported ${words.length} captions.`, { action: "Undo", onAction: () => store.undo() });
  } catch {
    toast("Couldn't read that file.");
  }
});

/* ---------- caption list ---------- */

let lineRows = [];

function renderLines() {
  const cap = store.doc.captions;
  const has = cap.words.length > 0;
  $("layout-group").hidden = !has;
  $("lines-group").hidden = !has;
  if (!has) { lineRows = []; $("lines").replaceChildren(); return; }

  // Keep focus on the row being edited across re-renders.
  const focused = document.activeElement?.closest?.(".line");
  const focusIndex = focused ? lineRows.indexOf(focused) : -1;

  const words = cap.words;
  const lines = groupLines(words, cap.perLine);
  $("lines-count").textContent = `${lines.length}`;
  const list = $("lines");
  list.replaceChildren();
  lineRows = lines.map((line, k) => {
    const { start, end } = lineTimes(words, lines, k);
    const row = document.createElement("div");
    row.className = "line";
    row.dataset.start = start;
    row.dataset.end = end;

    row.dataset.id = words[line.from].id;
    const time = document.createElement("button");
    time.className = "time";
    time.textContent = shortTime(start);
    time.title = `${shortTime(start)} – ${shortTime(end)}. Select and jump here.`;
    time.addEventListener("click", (ev) => {
      video.pause();
      seekTo(start + 0.01);
      if (ev.shiftKey || ev.ctrlKey) timeline.toggle(words[line.from].id);
      else timeline.select([words[line.from].id]);
    });

    const input = document.createElement("input");
    input.type = "text";
    input.value = words.slice(line.from, line.to).map((w) => w.text).join(" ");
    input.spellcheck = true;
    input.setAttribute("aria-label", `Caption at ${shortTime(start)}`);
    const commit = () => {
      const current = words.slice(line.from, line.to).map((w) => w.text).join(" ");
      if (input.value.trim() === current) return;
      store.update((d) => editLine(d.captions, line, input.value));
    };
    input.addEventListener("change", commit);
    input.addEventListener("focus", () => { video.pause(); seekTo(start + 0.01); });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || (ev.key === "ArrowDown" && !ev.shiftKey) || ev.key === "ArrowUp") {
        ev.preventDefault();
        commit();
        const step = ev.key === "ArrowUp" ? -1 : 1;
        lineRows[Math.min(lineRows.length - 1, Math.max(0, k + step))]?.querySelector("input").focus();
      }
      if (ev.key === "Escape") { input.value = words.slice(line.from, line.to).map((w) => w.text).join(" "); input.blur(); }
    });

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.title = "Delete caption";
    remove.setAttribute("aria-label", `Delete caption at ${shortTime(start)}`);
    remove.innerHTML = `<svg class="icon" style="width:14px;height:14px"><use href="#i-x"/></svg>`;
    remove.addEventListener("click", () => store.update((d) => editLine(d.captions, line, "")));

    row.append(time, input, remove);
    list.append(row);
    return row;
  });
  if (focusIndex >= 0) lineRows[Math.min(focusIndex, lineRows.length - 1)]?.querySelector("input").focus();
  markSelectedRows();
  highlightLine(video.currentTime);
}

function markSelectedRows() {
  let first = null;
  for (const row of lineRows) {
    const on = timeline.selection.has(Number(row.dataset.id));
    row.classList.toggle("selected", on);
    first ??= on ? row : null;
  }
  if (first && !first.contains(document.activeElement)) first.scrollIntoView({ block: "nearest" });
}

let activeRow = null;
function highlightLine(t) {
  const row = lineRows.find((r) => t >= Number(r.dataset.start) && t < Number(r.dataset.end)) ?? null;
  if (row === activeRow) return;
  activeRow?.classList.remove("active");
  row?.classList.add("active");
  activeRow = row;
  // Follow playback through the list unless the user is typing in it.
  if (row && !video.paused && !row.contains(document.activeElement)) row.scrollIntoView({ block: "nearest" });
}

/* ---------- live captions over the player (libass in WebAssembly) ---------- */

let subtitles = null;
// The letters of inverted captions, rendered unseen; drawInverted turns them into the effect.
let maskSubs = null;
const NO_CAPTIONS = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

/** A libass renderer over the player, showing `ass`. */
function createRenderer(ass, fonts) {
  const r = new JASSUB({
    video,
    subContent: ass,
    workerUrl: "/vendor/jassub/worker/worker.js",
    wasmUrl: "/vendor/jassub/wasm/jassub-worker.wasm",
    modernWasmUrl: "/vendor/jassub/wasm/jassub-worker-modern.wasm",
  });
  r.loadedFonts = new Set();
  // Draw the paused frame's captions right away instead of waiting for playback or a seek,
  // and again once the fonts have arrived (jassub doesn't redraw by itself when they do).
  r.ready.then(async () => {
    r.resize(true);
    await loadFonts(r, fonts);
    r.resize(true);
  });
  return r;
}

/**
 * jassub's on-demand font lookup mangles names that contain a weight ("Poppins ExtraBold"
 * becomes "Poppins Extra"), so the fonts the captions use are loaded up front instead.
 */
async function loadFonts(r, families) {
  const urls = [];
  for (const family of families) {
    const url = inspector.fontUrl(family);
    if (url && !r.loadedFonts.has(family)) {
      r.loadedFonts.add(family);
      urls.push(url);
    }
  }
  if (urls.length) await r.renderer.addFonts(urls);
}

async function showTrack(r, ass, fonts) {
  await r.ready;
  await loadFonts(r, fonts);
  await r.renderer.setTrack(ass ?? NO_CAPTIONS);
  r.resize(true);
}

async function updateSubtitles() {
  if (!store.doc || !video.videoWidth) return;
  const cap = store.doc.captions;
  const opts = { fps: media?.fps || 30 };
  const ass = buildAss(cap, video.videoWidth, video.videoHeight, opts);
  const mask = buildMask(cap, video.videoWidth, video.videoHeight, opts);
  const key = `${ass}\n${mask}`;
  if (key === lastAss) return;
  lastAss = key;
  const fonts = usedFonts(cap);
  if (!subtitles) subtitles = createRenderer(ass ?? NO_CAPTIONS, fonts);
  else await showTrack(subtitles, ass, fonts);
  if (mask && !maskSubs) {
    maskSubs = createRenderer(mask, fonts);
    maskSubs._canvas.style.opacity = "0";
  } else if (maskSubs) {
    await showTrack(maskSubs, mask, fonts);
  }
}

/*
 * Inverted captions: libass draws the letters unseen (maskSubs), and every frame this copies them
 * onto a canvas of its own, fills the letters with the frame's colours inverted, and blends that
 * as "luminosity". The frame keeps its hue and saturation and takes the inverted brightness,
 * which is what the export's luma flip does.
 */
const invertLayer = document.createElement("canvas");
invertLayer.className = "invert-layer";
invertLayer.hidden = true;
const invertCtx = invertLayer.getContext("2d");

function drawInverted() {
  const on = !!store.doc?.captions.style.invert && !!maskSubs?._canvas;
  invertLayer.hidden = !on;
  if (!on) return;
  const source = maskSubs._canvas;
  // Above the outlines and shadows, which are drawn as usual by the main renderer.
  const above = subtitles?._canvas ?? source;
  if (invertLayer.previousElementSibling !== above) above.after(invertLayer);
  for (const k of ["left", "top", "width", "height", "position", "transform"]) invertLayer.style[k] = source.style[k];
  if (invertLayer.width !== source.width || invertLayer.height !== source.height) {
    invertLayer.width = source.width;
    invertLayer.height = source.height;
  }
  const { width: w, height: h } = invertLayer;
  invertCtx.globalCompositeOperation = "copy";
  invertCtx.filter = "none";
  invertCtx.drawImage(source, 0, 0, w, h);
  invertCtx.globalCompositeOperation = "source-in";
  invertCtx.filter = "invert(1)";
  // While paused the player shows the processed frame, so the letters invert that instead.
  const frame = color.layer ?? ($("effect")?.offsetParent && $("effect").complete && $("effect").naturalWidth ? $("effect") : video);
  invertCtx.drawImage(frame, 0, 0, w, h);
}

(function invertLoop() {
  drawInverted();
  requestAnimationFrame(invertLoop);
})();

/* ---------- undo, export, shortcuts ---------- */

$("undo").addEventListener("click", () => store.undo());
$("redo").addEventListener("click", () => store.redo());
$("export-btn").addEventListener("click", () => { video.pause(); exporter.open(); });
$("shortcuts-btn").addEventListener("click", () => $("shortcuts-dialog").showModal());
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
}

/** Splits whatever the active tab edits: a colour section on the Color tab, else a caption. */
function splitAtPlayhead() {
  if (tab === "color") color.splitAtPlayhead();
  else timeline.splitAtPlayhead();
}

document.addEventListener("keydown", (ev) => {
  if (document.querySelector("dialog[open]") || ev.defaultPrevented) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (ctrl && key === "o") { ev.preventDefault(); chooseVideo(); return; }
  if (ev.key === "?" && !isTyping(ev.target)) { $("shortcuts-dialog").showModal(); return; }
  if (!media) return;
  if (ctrl && key === "w") { ev.preventDefault(); showHome(); return; }
  if (ctrl && key === "e") { ev.preventDefault(); video.pause(); exporter.open(); return; }
  if (ctrl && key === "h") { ev.preventDefault(); $("fr-find")?.focus(); return; }
  if (ctrl && ["1", "2", "3"].includes(key)) { ev.preventDefault(); setTab(["background", "captions", "color"][Number(key) - 1]); return; }
  if (isTyping(ev.target)) return; // text fields keep their own undo and arrow keys
  if (ctrl && key === "z") { ev.preventDefault(); if (ev.shiftKey) store.redo(); else store.undo(); return; }
  if (ctrl && key === "y") { ev.preventDefault(); store.redo(); return; }
  if (ctrl && key === "k") { ev.preventDefault(); splitAtPlayhead(); return; }
  if (ctrl && ev.shiftKey && key === "s") { ev.preventDefault(); if (tab === "color") color.toggleScopes(); return; }
  if (ctrl && key === "a") { ev.preventDefault(); timeline.selectAll(); return; }
  if (ctrl && key === "c") { if (timeline.copySelected()) ev.preventDefault(); return; }
  if (ctrl && key === "x") { ev.preventDefault(); timeline.cutSelected(); return; }
  if (ctrl && key === "v") { ev.preventDefault(); timeline.paste(); return; }
  if (ctrl && key === "d") { ev.preventDefault(); timeline.duplicateSelected(); return; }
  if (ev.altKey && (key === "arrowleft" || key === "arrowright")) {
    ev.preventDefault();
    timeline.nudge((key === "arrowleft" ? -1 : 1) * (ev.shiftKey ? 5 : 1));
    return;
  }
  if (ev.altKey && (key === "arrowup" || key === "arrowdown")) {
    ev.preventDefault();
    timeline.placeStep(key === "arrowup" ? -1 : 1);
    return;
  }
  if (ctrl) return;
  if (key === "delete" || key === "backspace") {
    ev.preventDefault();
    if (tab === "color" && timeline.gradeSelection != null) color.deleteSelected();
    else timeline.deleteSelected();
    return;
  }
  if (key === "escape") { timeline.clearSelection(); return; }
  if (key === "m") { timeline.mergeSelected(); return; }
  if (key === "a") { timeline.addAt(video.currentTime); return; }
  if (key === "s") { timeline.toggleSnapping(); return; }
  if (key === "=" || key === "+") { timeline.zoomBy(1.5); return; }
  if (key === "-") { timeline.zoomBy(1 / 1.5); return; }
  if (key === "\\") { timeline.fit(); return; }
  if (key === " ") { ev.preventDefault(); togglePlay(); }
  else if (key === "arrowleft") { ev.preventDefault(); if (ev.shiftKey) seekTo(video.currentTime - 1); else stepFrames(-1); }
  else if (key === "arrowright") { ev.preventDefault(); if (ev.shiftKey) seekTo(video.currentTime + 1); else stepFrames(1); }
  else if (key === "arrowup" || key === "arrowdown") {
    // Jump between edit points, as Up and Down do in Premiere.
    ev.preventDefault();
    const at = timeline.editPoint(key === "arrowdown" ? 1 : -1);
    if (at != null) { video.pause(); seekTo(at); }
  }
  // J, K and L shuttle. The player can't play backwards, so J steps back a second instead.
  else if (key === "l") {
    if (video.paused) { video.playbackRate = 1; video.play(); } else video.playbackRate = Math.min(4, video.playbackRate * 2);
  }
  else if (key === "k") { video.pause(); video.playbackRate = 1; }
  else if (key === "j") { video.pause(); seekTo(video.currentTime - 1); }
  else if (key === "home") { ev.preventDefault(); seekTo(0); }
  else if (key === "end") { ev.preventDefault(); seekTo(video.duration || 0); }
  else if (key === "c" && !ev.repeat && (tab === "background" || tab === "color")) setComparing(true);
});
document.addEventListener("keyup", (ev) => { if (ev.key.toLowerCase() === "c" && comparing) setComparing(false); });

// Save before the window closes.
window.addEventListener("beforeunload", () => store.flush());

/* ---------- start ---------- */

prefs = await api.get("/prefs").catch(() => ({}));
await inspector.loadFonts();
showHome();
loadUserPlugins(api).then((failed) => {
  if (failed.length) toast(`Couldn't load ${failed.length === 1 ? "a plugin" : `${failed.length} plugins`}: ${failed[0]}`);
});
