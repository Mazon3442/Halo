// The export window: where to save, format, size, quality and captions, then progress and result.

import { api } from "./api.js";
import { buildAss, buildMask, buildSrt, buildVtt, usedFonts } from "./captions.js";

const $ = (id) => document.getElementById(id);
const EXTENSIONS = { h264: "mp4", h265: "mp4", prores: "mov", webm: "webm", srt: "srt", vtt: "vtt" };
const FORMAT_NAMES = { h264: "H.264 MP4", h265: "H.265 MP4", prores: "ProRes", webm: "WebM", srt: "SRT", vtt: "WebVTT" };
/** Caption formats saved as text, with no video to render. */
const TEXT_FORMATS = ["srt", "vtt"];
// Named by the short side, so "1080p" is 1080 wide for portrait video and 1080 tall for landscape.
const SIZES = [
  { short: 2160, name: "4K" },
  { short: 1440, name: "1440p" },
  { short: 1080, name: "1080p" },
  { short: 720, name: "720p" },
];
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

function splitPath(path) {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return { dir: path.slice(0, cut), file: path.slice(cut + 1) };
}

function stripExtension(file) {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Output size for a short-side target (0 keeps the original). */
function scaled(media, short) {
  const current = Math.min(media.width, media.height);
  if (!short || short >= current) return { w: media.width, h: media.height };
  const k = short / current;
  return { w: Math.round((media.width * k) / 2) * 2, h: Math.round((media.height * k) / 2) * 2 };
}

export function createExporter({ store, getMedia, getPrefs, savePrefs, toast, bakeGrades }) {
  const dialog = $("export-dialog");
  const form = $("export-form");
  let dir = "";
  /** A path the user confirmed in the Save As dialog, which already asked about replacing. */
  let confirmedPath = null;
  let overwrite = false;
  /** Set after the engine reported the file exists, so the button asks to replace it. */
  let askReplace = false;
  let running = null;
  let finished = null;

  function view(name) {
    form.hidden = name !== "form";
    $("export-running").hidden = name !== "running";
    $("export-done").hidden = name !== "done";
    $("export-title").textContent = name === "running" ? "Exporting" : name === "done" ? "Export finished" : "Export";
  }

  function format() { return form.querySelector("input[name=format]:checked")?.value ?? "h264"; }
  function what() { return form.querySelector("input[name=what]:checked")?.value ?? "video"; }
  const textOnly = () => what() === "captions" && TEXT_FORMATS.includes(format());
  function quality() { return form.querySelector("input[name=quality]:checked")?.value ?? "high"; }
  function ext() { return EXTENSIONS[format()]; }
  function outputPath() { return `${dir}\\${$("export-name").value.trim()}.${ext()}`; }

  function open() {
    const media = getMedia();
    if (!media || !store.doc) return;
    if (running) {
      view("running");
    } else if (finished) {
      view("done");
    } else {
      fillForm(media);
      view("form");
    }
    if (!dialog.open) dialog.showModal();
  }

  function fillForm(media) {
    const prefs = getPrefs();
    const doc = store.doc;
    const transparent = doc.background.mode === "remove";
    const videoDir = splitPath(doc.video_path).dir;
    dir = prefs.exportDir || videoDir;
    confirmedPath = null;
    overwrite = false;
    askReplace = false;
    form.querySelector("input[name=what][value=video]").checked = true;
    showWhat();
    form.querySelector(`input[name=quality][value=${prefs.quality ?? "high"}]`).checked = true;

    const size = $("export-size");
    size.replaceChildren();
    const short = Math.min(media.width, media.height);
    const options = [{ side: 0, label: `Original (${media.width} × ${media.height})` }];
    for (const s of SIZES) {
      if (s.short >= short) continue;
      const { w, h } = scaled(media, s.short);
      options.push({ side: s.short, label: `${s.name} (${w} × ${h})` });
    }
    for (const o of options) size.append(new Option(o.label, String(o.side)));
    const preferred = String(prefs.maxSide ?? 0);
    size.value = options.some((o) => String(o.side) === preferred) ? preferred : "0";

    const hasCaptions = doc.captions.words.length > 0;
    $("what-captions").disabled = !hasCaptions;
    $("export-captions-field").hidden = !hasCaptions;
    $("export-burn").checked = hasCaptions;
    $("export-srt").checked = !!prefs.srt;
    $("export-error").hidden = true;
    syncForm();
  }

  /**
   * Sets up the form for a video or for captions alone: which formats are offered (captions can
   * be text, or a styled overlay in a format that keeps transparency) and the file's name.
   */
  function showWhat() {
    const doc = store.doc;
    const prefs = getPrefs();
    const captions = what() === "captions";
    const transparent = doc.background.mode === "remove";
    const fmt = captions ? (prefs.captionFormat ?? "srt") : transparent ? (prefs.alphaFormat ?? "prores") : (prefs.format ?? "h264");
    for (const label of form.querySelectorAll(".format")) {
      const input = label.querySelector("input");
      label.hidden = !!label.dataset.for && label.dataset.for !== what();
      input.disabled = label.hidden || (!captions && transparent && (input.value === "h264" || input.value === "h265"));
      input.checked = input.value === fmt;
      const d = label.querySelector(".d");
      if (d.dataset.video) d.textContent = captions ? d.dataset.captions : d.dataset.video;
    }
    $("export-name").value = `${stripExtension(doc.name)}-${captions ? "captions" : "halo"}`;
  }

  function syncForm() {
    const media = getMedia();
    const doc = store.doc;
    if (!media || !doc) return;
    const transparent = doc.background.mode === "remove";
    $("export-ext").textContent = `.${ext()}`;
    $("export-dir").textContent = dir;
    $("export-dir").title = dir;
    const notes = {
      h264: "Works in every player, phone, and social app.",
      h265: "Smaller files at the same quality. Older devices may not play it.",
      prores: transparent
        ? "ProRes 4444 keeps the transparent background. Large files, made for editing."
        : "ProRes 422 HQ. Large files, made for editing.",
      webm: transparent ? "VP9 with transparency. Plays in browsers; slow to encode." : "VP9. Plays in browsers.",
    };
    const captions = what() === "captions";
    $("export-picture").hidden = textOnly();
    $("export-captions-field").hidden = captions || !doc.captions.words.length;
    $("format-note").textContent = captions
      ? textOnly()
        ? "Plain text with timings. Import it into Premiere, Resolve, Filmora or CapCut and style it there."
        : "Just the captions, with their style and animation, on a transparent background. Put it on the track above your video in any editor. Inverted captions need the video, so they come out plain."
      : transparent && (format() === "prores" || format() === "webm")
      ? notes[format()]
      : transparent
        ? "MP4 can't keep a transparent background. Choose ProRes or WebM."
        : notes[format()];
    const { w, h } = scaled(media, Number($("export-size").value));
    const parts = textOnly() ? ["Captions", FORMAT_NAMES[format()]] : [`${w} × ${h}`, FORMAT_NAMES[format()]];
    if (captions && !textOnly()) parts.push("captions only");
    else if (!$("export-captions-field").hidden && $("export-burn").checked) parts.push("captions");
    $("export-summary").textContent = parts.join(" · ");
    // Replacing is only agreed for the exact path it was agreed for.
    if (confirmedPath !== outputPath()) {
      overwrite = false;
      askReplace = false;
    }
    $("export-start").innerHTML = `<svg class="icon"><use href="#i-export"/></svg>${askReplace ? "Replace and export" : "Export"}`;
  }

  form.addEventListener("input", () => { $("export-error").hidden = true; syncForm(); });
  form.addEventListener("change", (ev) => {
    if (ev.target.name === "what") showWhat();
    syncForm();
  });

  $("export-browse").addEventListener("click", async () => {
    try {
      const { path } = await api.post("/dialog/save", {
        file_name: `${$("export-name").value.trim() || "video"}.${ext()}`,
        extension: ext(),
        directory: dir,
      });
      if (!path) return;
      const parts = splitPath(path);
      dir = parts.dir;
      $("export-name").value = stripExtension(parts.file);
      // The Save As dialog already asked about replacing an existing file.
      confirmedPath = path;
      overwrite = true;
      askReplace = false;
      $("export-error").hidden = true;
      syncForm();
    } catch (err) {
      showError(err.message);
    }
  });

  function showError(message) {
    $("export-error").textContent = message;
    $("export-error").hidden = false;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const media = getMedia();
    const doc = store.doc;
    const name = $("export-name").value.trim();
    if (!name) return showError("Enter a file name.");
    if (INVALID_NAME.test(name)) return showError("File names can't contain < > : \" / \\ | ? or *.");
    const output = outputPath();
    const captionsOnly = what() === "captions";
    if (textOnly()) return saveText(output, name);
    const burn = captionsOnly || (!$("export-captions-field").hidden && $("export-burn").checked);
    const srt = !captionsOnly && !$("export-captions-field").hidden && $("export-srt").checked;
    let grades = [];
    try {
      if (!captionsOnly) grades = await bakeGrades();
    } catch (err) {
      return showError(err.message);
    }
    if (!captionsOnly && doc.background.mode === "none" && !burn && !grades.length) {
      return showError("There's nothing to change yet. Add a background effect, a colour grade, or burn in captions.");
    }
    const size = scaled(media, Number($("export-size").value));
    // An overlay has no video under it to invert, so inverted captions come out as plain ones.
    const cap = captionsOnly ? { ...doc.captions, style: { ...doc.captions.style, invert: false } } : doc.captions;
    const body = {
      media: media.id,
      ...(captionsOnly ? { mode: "none" } : doc.background),
      captions: burn ? buildAss(cap, size.w, size.h) : null,
      caption_mask: burn ? buildMask(cap, size.w, size.h) : null,
      srt: srt ? buildSrt(doc.captions) : null,
      fonts: burn ? usedFonts(doc.captions) : [],
      grades,
      captions_only: captionsOnly,
      output,
      overwrite,
      format: format(),
      quality: quality(),
      // The engine caps the long side.
      max_side: Number($("export-size").value) ? Math.max(size.w, size.h) : null,
    };
    try {
      const { id } = await api.post("/jobs", body);
      const prefs = getPrefs();
      if (captionsOnly) prefs.captionFormat = format();
      else if (doc.background.mode === "remove") prefs.alphaFormat = format();
      else prefs.format = format();
      Object.assign(prefs, { exportDir: dir, quality: quality(), maxSide: Number($("export-size").value), srt });
      savePrefs();
      running = { id, output };
      finished = null;
      $("run-path").textContent = output;
      $("run-percent").textContent = "0%";
      $("run-bar").style.width = "0";
      $("run-detail").textContent = "Starting…";
      view("running");
      $("export-pill").hidden = false;
      poll();
    } catch (err) {
      if (/already exists/i.test(err.message)) {
        overwrite = true;
        askReplace = true;
        confirmedPath = output;
        syncForm();
        showError(`${name}.${ext()} already exists in this folder. Export again to replace it, or change the name.`);
      } else {
        showError(err.message);
      }
    }
  });

  /** Saves the captions as an SRT or WebVTT file; there's nothing to render. */
  async function saveText(output, name) {
    const doc = store.doc;
    try {
      await api.post("/files/text", { path: output, text: format() === "vtt" ? buildVtt(doc.captions) : buildSrt(doc.captions), overwrite });
    } catch (err) {
      if (!/already exists/i.test(err.message)) return showError(err.message);
      overwrite = true;
      askReplace = true;
      confirmedPath = output;
      syncForm();
      return showError(`${name}.${ext()} already exists in this folder. Export again to replace it, or change the name.`);
    }
    const prefs = getPrefs();
    Object.assign(prefs, { exportDir: dir, captionFormat: format() });
    savePrefs();
    finished = { id: null, output };
    $("done-path").textContent = output;
    $("done-detail").textContent = `${FORMAT_NAMES[format()]} captions, ready to import into your editor.`;
    $("done-open").hidden = true;
    view("done");
  }

  async function poll() {
    if (!running) return;
    let job;
    try {
      job = await api.get(`/jobs/${running.id}`);
    } catch {
      setTimeout(poll, 1000);
      return;
    }
    const pct = job.total ? Math.min(1, job.frames / job.total) : 0;
    const left = job.fps && job.total > job.frames ? Math.ceil((job.total - job.frames) / job.fps) : null;
    if (job.state === "queued") {
      $("run-detail").textContent = "Waiting for the previous export to finish…";
    } else if (job.state === "processing") {
      $("run-percent").textContent = `${Math.round(pct * 100)}%`;
      $("run-bar").style.width = `${pct * 100}%`;
      $("run-detail").textContent =
        `Frame ${job.frames} of ${job.total || "?"} · ${job.fps.toFixed(1)} fps` + (left != null ? ` · about ${formatSeconds(left)} left` : "");
      $("pill-text").textContent = `Exporting ${Math.round(pct * 100)}%`;
      $("pill-bar").style.width = `${pct * 100}%`;
    }
    if (job.state === "done") {
      finished = { id: running.id, output: running.output };
      running = null;
      $("export-pill").hidden = true;
      $("done-path").textContent = finished.output;
      $("done-detail").textContent = `${job.frames} frames.`;
      $("done-open").hidden = false;
      if (dialog.open) view("done");
      else toast("Export finished", { action: "Show", onAction: open });
      return;
    }
    if (job.state === "error" || job.state === "cancelled") {
      const cancelled = job.state === "cancelled";
      running = null;
      $("export-pill").hidden = true;
      fillForm(getMedia());
      view("form");
      if (!cancelled) showError(job.error || "The export failed.");
      if (!dialog.open && !cancelled) toast("Export failed", { action: "Details", onAction: open });
      return;
    }
    setTimeout(poll, 400);
  }

  $("run-cancel").addEventListener("click", () => {
    if (running) api.post(`/jobs/${running.id}/cancel`).catch(() => {});
    $("run-detail").textContent = "Cancelling…";
  });
  $("done-reveal").addEventListener("click", () => {
    if (!finished) return;
    const shown = finished.id == null ? api.post("/reveal", { path: finished.output }) : api.post(`/jobs/${finished.id}/reveal`);
    shown.catch((e) => toast(e.message));
  });
  $("done-open").addEventListener("click", () => finished && api.post(`/jobs/${finished.id}/open`).catch((e) => toast(e.message)));
  $("export-pill").addEventListener("click", open);
  for (const b of dialog.querySelectorAll("[data-close]")) {
    b.addEventListener("click", () => {
      dialog.close();
      // After a finished export, the next Export click starts fresh.
      if (!running && finished && !$("export-done").hidden) finished = null;
    });
  }

  return {
    open,
    get busy() { return running !== null; },
    /** Forget a finished export, e.g. when switching videos. */
    reset() { if (!running) finished = null; },
  };
}

function formatSeconds(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
