// The Color tab: what the footage was shot in (log profiles are transformed first), then graded
// sections of the video, each with its own look: sliders, film emulation, colour wheels and an
// optional LUT. Built-in and saved looks preview on the video's own frame, and LUTs and Lightroom
// presets can be imported. Sections show on the timeline's Color track, where they're moved and
// trimmed; the player draws them live.

import {
  CHUNK_SECS, DEFAULT_LOOK, FILM_STOCKS, LOOKS, SOURCES, WHEELS, createGradePlayer, freeSpan, importLut, isNeutral, loadLut,
  makeLook, needsTransform, paintFrame, parseXmp, sectionAt,
} from "./grade.js";
import { createScopes } from "./scopes.js";

const $ = (id) => document.getElementById(id);
const SLIDERS = ["exposure", "contrast", "highlights", "shadows", "fade", "temperature", "tint", "saturation", "vibrance", "lutAmount", "filmAmount", "skinProtect"];
/** A look that only transforms log footage, for the stretches nothing grades. */
const TRANSFORM_ONLY = makeLook();
const SOURCE_HINTS = {
  rec709: "Phones and cameras record this unless you chose a log profile.",
  log: "Log footage looks flat and grey. Halo converts it from the camera's log curve and color gamut to normal contrast and color before grading, like a color space transform in Resolve, across the whole video.",
};

function fileStem(name) {
  return name.replace(/\.[^.]+$/, "");
}

export function createColorPanel({ store, timeline, video, toast, getPrefs, savePrefs, isComparing }) {
  /** The section the panel edits: the one selected on the timeline. */
  function current(doc = store.doc) {
    const id = timeline.gradeSelection;
    return id == null ? null : doc?.grade?.sections.find((s) => s.id === id) ?? null;
  }

  /** Changes the selected section. */
  function edit(mutate, coalesce) {
    store.update((d) => {
      const s = current(d);
      if (s) mutate(s, d);
    }, { coalesce });
  }

  /**
   * Adds a section at `t` (the playhead by default): `CHUNK_SECS` long, or out to `to` when it was
   * drawn on the Color track, either way kept to the free time there.
   */
  function addSection(look = makeLook(), name = "Graded", preset = null, t = video.currentTime, to = null) {
    const span = freeSpan(store.doc.grade, video.duration || 0, t, to);
    if (!span) {
      toast("The playhead is in a graded section already. Select it on the Color track, or split it.");
      return null;
    }
    const [start, end] = span;
    if (end - start < 0.2) { toast("There isn't room for a section here."); return null; }
    let id;
    store.update((d) => {
      id = d.grade.nextId++;
      d.grade.sections.push({ id, start, end, name, preset, look });
      d.grade.sections.sort((a, b) => a.start - b.start);
    });
    timeline.selectGrade(id);
    return id;
  }

  /** Puts a look on the selected section, adding one for the video if nothing's selected. */
  function applyLook(look, name, preset) {
    if (!current()) {
      const free = !sectionAt(store.doc.grade, video.currentTime);
      if (free) return addSection(makeLook(look), name, preset);
      const under = sectionAt(store.doc.grade, video.currentTime);
      timeline.selectGrade(under.id);
    }
    edit((s) => { s.look = makeLook(look); s.name = name; s.preset = preset; });
  }

  /* ---------- rendering ---------- */

  function render() {
    const doc = store.doc;
    if (!doc) return;
    const sections = doc.grade.sections;
    const s = current();
    const source = doc.grade.source ?? "rec709";
    $("grade-source").value = source;
    $("grade-source-hint").textContent = SOURCE_HINTS[source === "rec709" ? "rec709" : "log"];
    $("color-dot").hidden = !needsTransform(doc.grade) && !sections.some((x) => !isNeutral(x.look));
    $("grade-editor").hidden = !s;
    $("grade-tools").hidden = !s;
    $("grade-add").parentElement.hidden = !!s;
    $("grade-add-label").textContent = `Add a ${CHUNK_SECS}s grade at the playhead`;
    $("grade-where").textContent = s ? `${clock(s.start)} – ${clock(s.end)}` : "";
    $("grade-hint").textContent = s
      ? "Changes apply to this section. Drag it or its edges on the Color track to change where it starts and ends."
      : sections.length
        ? "Select a section on the Color track to edit it, or drag along an empty stretch of the track to grade just that part."
        : `Drag along the Color track to grade just that stretch, or double-click it for a ${CHUNK_SECS}-second grade. Drag a grade's edges to resize it.`;
    if (!s) return;
    const look = { ...DEFAULT_LOOK, ...s.look };
    for (const key of SLIDERS) {
      const el = $(`grade-${key}`);
      const scale = Number(el.dataset.scale ?? 0.01);
      const v = look[key] / scale;
      if (document.activeElement !== el || Number(el.value) !== v) el.value = String(v);
      $(`grade-${key}-v`).textContent = key === "exposure" ? `${look.exposure > 0 ? "+" : ""}${look.exposure.toFixed(2)}` : `${Math.round(look[key] * 100)}`;
    }
    $("grade-look-name").textContent = s.name ?? "";
    $("grade-film").value = look.film ?? "none";
    $("grade-film-amount-row").hidden = (look.film ?? "none") === "none";
    renderWheels(makeLook(s.look));
    renderLuts(look);
    renderLooks(s);
  }

  /* ---------- colour wheels ---------- */

  const wheelEls = {};
  // The hue ring runs counter-clockwise from red at 3 o'clock, as hue angles do.
  const ring = `conic-gradient(from 90deg, ${Array.from({ length: 13 }, (_, i) => `hsl(${(360 - i * 30) % 360} 75% 52%) ${i * 30}deg`).join(", ")})`;

  function setWheel(name, value, coalesce) {
    edit((s) => {
      const wheels = { ...(makeLook(s.look).wheels ?? {}) };
      wheels[name] = { h: 0, s: 0, l: 0, ...wheels[name], ...value };
      s.look = makeLook({ ...s.look, wheels });
      s.preset = null;
    }, coalesce);
  }

  for (const name of WHEELS) {
    const wrap = document.createElement("div");
    wrap.className = "wheel";
    const label = document.createElement("span");
    label.className = "wheel-name";
    label.textContent = name[0].toUpperCase() + name.slice(1);
    const disc = document.createElement("div");
    disc.className = "wheel-disc";
    disc.style.background = ring;
    disc.title = "Drag toward a color. Double-click to reset.";
    disc.setAttribute("role", "slider");
    disc.setAttribute("aria-label", `${label.textContent} color`);
    disc.tabIndex = 0;
    const puck = document.createElement("div");
    puck.className = "wheel-puck";
    disc.append(puck);
    const lum = document.createElement("input");
    lum.type = "range";
    Object.assign(lum, { min: -100, max: 100, step: 1 });
    lum.setAttribute("aria-label", `${label.textContent} brightness`);
    const value = document.createElement("span");
    value.className = "wheel-value";
    wrap.append(label, disc, lum, value);
    $("grade-wheels").append(wrap);
    wheelEls[name] = { disc, puck, lum, value };

    const pick = (ev, key) => {
      const r = disc.getBoundingClientRect();
      const dx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = -(ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const sat = Math.min(1, Math.hypot(dx, dy));
      const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      setWheel(name, { h: Math.round(h), s: Math.round(sat * 100) / 100 }, key);
    };
    disc.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      try { disc.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      const key = `wheel-${name}-${performance.now()}`;
      pick(ev, key);
      const move = (e) => pick(e, key);
      disc.addEventListener("pointermove", move);
      disc.addEventListener("pointerup", () => disc.removeEventListener("pointermove", move), { once: true });
    });
    disc.addEventListener("dblclick", () => setWheel(name, { s: 0, l: 0 }));
    disc.addEventListener("keydown", (ev) => {
      const w = makeLook(current()?.look).wheels?.[name] ?? { h: 0, s: 0 };
      const step = { ArrowRight: [0, 0.02], ArrowLeft: [0, -0.02], ArrowUp: [5, 0], ArrowDown: [-5, 0] }[ev.key];
      if (!step) return;
      ev.preventDefault();
      setWheel(name, { h: (w.h + step[0] + 360) % 360, s: Math.min(1, Math.max(0, w.s + step[1])) }, `wheel-key-${name}`);
    });
    lum.addEventListener("input", () => setWheel(name, { l: Number(lum.value) / 100 }, `wheel-l-${name}`));
    lum.addEventListener("dblclick", () => setWheel(name, { l: 0 }));
  }

  function renderWheels(look) {
    for (const name of WHEELS) {
      const w = look.wheels?.[name] ?? { h: 0, s: 0, l: 0 };
      const { puck, lum, value, disc } = wheelEls[name];
      const a = (w.h * Math.PI) / 180;
      puck.style.left = `${50 + Math.cos(a) * w.s * 50}%`;
      puck.style.top = `${50 - Math.sin(a) * w.s * 50}%`;
      puck.style.background = w.s ? `hsl(${w.h} 80% ${55 + w.l * 20}%)` : "#fff";
      if (document.activeElement !== lum) lum.value = String(Math.round(w.l * 100));
      value.textContent = w.s || w.l ? `${Math.round(w.s * 100)}% · ${w.l > 0 ? "+" : ""}${Math.round(w.l * 100)}` : "—";
      disc.setAttribute("aria-valuetext", w.s ? `hue ${Math.round(w.h)}°, ${Math.round(w.s * 100)}%` : "neutral");
    }
  }

  function clock(t) {
    return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  }

  function renderLuts(look) {
    const select = $("grade-lut");
    const library = getPrefs().luts ?? [];
    select.replaceChildren(new Option("None", ""));
    for (const l of library) select.append(new Option(l.name, l.id));
    if (look.lut && !library.some((l) => l.id === look.lut.id)) select.append(new Option(look.lut.name, look.lut.id));
    select.value = look.lut?.id ?? "";
    $("grade-lut-amount-row").hidden = !look.lut;
  }

  function lookTile(name, look, checked, onPick) {
    const b = document.createElement("button");
    b.className = "preset";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(checked));
    const sample = document.createElement("div");
    sample.className = "sample";
    sample.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 34;
    sample.append(canvas);
    paintTile(canvas, makeLook(look));
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    b.append(sample, label);
    b.addEventListener("click", onPick);
    return b;
  }

  /* Look tiles show the video's own frame through each look, cached until the frame or look changes. */
  let frame = null;
  let frameKey = "";
  const tiles = new Map();

  function grabFrame() {
    const s = current();
    const key = `${s?.id}|${Math.round(video.currentTime * 2)}|${store.doc?.grade.source}`;
    if (key === frameKey && frame) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const w = 96;
    const h = 54;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    // A centred 16:9 crop, so tall and wide videos both fill the tile.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(vw / w, vh / h);
    ctx.drawImage(video, (vw - w * scale) / 2, (vh - h * scale) / 2, w * scale, h * scale, 0, 0, w, h);
    try {
      frame = ctx.getImageData(0, 0, w, h);
      frameKey = key;
      tiles.clear();
    } catch { frame = null; }
  }

  function paintTile(canvas, look) {
    const source = store.doc?.grade.source ?? "rec709";
    const key = `${JSON.stringify(look)}|${frame ? frameKey : "swatch"}`;
    const cached = tiles.get(key);
    if (cached) {
      canvas.width = cached.width;
      canvas.height = cached.height;
      canvas.getContext("2d").putImageData(cached, 0, 0);
      return;
    }
    const keep = (lut) => {
      paintFrame(canvas, frame, look, lut, source);
      if (tiles.size > 120) tiles.delete(tiles.keys().next().value);
      tiles.set(key, canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height));
    };
    if (look.lut) loadLut(look.lut.id).then(keep).catch(() => keep(null));
    else keep(null);
  }

  function renderLooks(s) {
    grabFrame();
    const box = $("looks");
    box.replaceChildren();
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "Looks");
    const lut = s.look.lut ? { lut: s.look.lut, lutAmount: s.look.lutAmount } : {};
    // Built-in looks change the sliders and keep the section's LUT.
    for (const l of LOOKS) {
      box.append(lookTile(l.name, { ...l.look, ...lut }, s.preset === l.id, () => applyLook({ ...l.look, ...lut }, l.name, l.id)));
    }
    for (const p of getPrefs().gradePresets ?? []) {
      const tile = document.createElement("div");
      tile.className = "preset-tile";
      const remove = document.createElement("button");
      remove.className = "preset-delete";
      remove.setAttribute("aria-label", `Delete ${p.name}`);
      remove.title = "Delete this look";
      remove.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>`;
      remove.addEventListener("click", () => {
        const prefs = getPrefs();
        const at = prefs.gradePresets.findIndex((x) => x.id === p.id);
        if (at < 0) return;
        const [gone] = prefs.gradePresets.splice(at, 1);
        savePrefs();
        render();
        toast(`Deleted “${p.name}”.`, {
          action: "Undo",
          onAction: () => { prefs.gradePresets.splice(at, 0, gone); savePrefs(); render(); },
        });
      });
      tile.append(lookTile(p.name, p.look, s.preset === p.id, () => applyLook(p.look, p.name, p.id)), remove);
      box.append(tile);
    }
  }

  /* ---------- controls ---------- */

  $("grade-add").addEventListener("click", () => addSection());
  $("grade-split").addEventListener("click", () => splitAtPlayhead());
  $("grade-delete").addEventListener("click", () => deleteSection());
  $("grade-reset").addEventListener("click", () => resetSection());

  /* Splitting and deleting a section, exposed to the timeline (right-click, the × button, the
     razor) and to the keyboard. */

  function splitAtPlayhead() {
    const t = video.currentTime;
    const s = sectionAt(store.doc.grade, t) ?? current();
    if (!s || t <= s.start + 0.1 || t >= s.end - 0.1) return toast("Move the playhead inside a graded section to split it.");
    timeline.selectGrade(s.id);
    store.update((d) => {
      const x = d.grade.sections.find((g) => g.id === s.id);
      if (!x) return;
      const id = d.grade.nextId++;
      d.grade.sections.push({ ...structuredClone(x), id, start: t });
      x.end = t;
      d.grade.sections.sort((a, b) => a.start - b.start);
    });
    render();
  }

  function deleteSection(id = null) {
    const s = id != null ? store.doc.grade.sections.find((x) => x.id === id) : current();
    if (!s) return;
    store.update((d) => { d.grade.sections = d.grade.sections.filter((x) => x.id !== s.id); });
    timeline.selectGrade(null);
    toast("Grade removed", { action: "Undo", onAction: () => store.undo() });
  }

  function deleteSelected() {
    if (timeline.gradeSelection != null) deleteSection(timeline.gradeSelection);
  }

  function resetSection(id = null) {
    const target = id != null ? store.doc.grade.sections.find((x) => x.id === id) : current();
    if (!target) return;
    store.update((d) => {
      const s = d.grade.sections.find((x) => x.id === target.id);
      if (s) { s.look = makeLook(); s.name = "Graded"; s.preset = null; }
    });
  }

  timeline.onGradeAdd = (t, to) => addSection(makeLook(), "Graded", null, t, to);
  timeline.onGradeSplit = splitAtPlayhead;
  timeline.onGradeDelete = deleteSection;
  timeline.onGradeReset = resetSection;

  for (const key of SLIDERS) {
    const el = $(`grade-${key}`);
    const scale = Number(el.dataset.scale ?? 0.01);
    el.addEventListener("input", () => edit((s) => { s.look = { ...s.look, [key]: Number(el.value) * scale }; s.preset = null; }, `grade-${key}`));
    el.addEventListener("dblclick", () => edit((s) => { s.look = { ...s.look, [key]: DEFAULT_LOOK[key] }; }));
  }
  $("grade-source").append(...SOURCES.map((x) => new Option(x.name, x.id)));
  $("grade-source").addEventListener("change", () => {
    const source = $("grade-source").value;
    store.update((d) => { d.grade.source = source; });
    if (source !== "rec709") toast("Converting from log across the whole video. Grades and looks now start from normal contrast and color.");
  });
  $("grade-film").append(...FILM_STOCKS.map((f) => new Option(f.name, f.id)));
  $("grade-film").addEventListener("change", () => edit((s) => { s.look = { ...s.look, film: $("grade-film").value, filmAmount: s.look.filmAmount ?? 1 }; s.preset = null; }));
  $("grade-lut").addEventListener("change", () => {
    const id = $("grade-lut").value;
    const entry = (getPrefs().luts ?? []).find((l) => l.id === id) ?? null;
    edit((s) => { s.look = { ...s.look, lut: entry ? { id: entry.id, name: entry.name } : null, lutAmount: s.look.lutAmount ?? 1 }; s.preset = null; });
  });

  $("grade-save").addEventListener("click", () => {
    const s = current();
    $("look-name").value = s?.name && s.name !== "Graded" ? `My ${s.name}` : "";
    $("look-dialog").showModal();
  });
  $("look-save-btn").addEventListener("click", () => {
    const s = current();
    if (!s) return;
    const name = $("look-name").value.trim() || "My look";
    const id = `look-${Date.now().toString(36)}`;
    const prefs = getPrefs();
    prefs.gradePresets = [...(prefs.gradePresets ?? []), { id, name, look: { ...s.look } }];
    savePrefs();
    $("look-dialog").close();
    edit((x) => { x.name = name; x.preset = id; });
    toast(`Saved “${name}”. It's under Looks in every video.`);
  });

  $("grade-import").addEventListener("click", () => $("grade-import-file").click());
  $("grade-import-file").addEventListener("change", async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = "";
    let last = null;
    const added = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const prefs = getPrefs();
        if (/\.xmp$/i.test(file.name)) {
          const { name, look } = parseXmp(text, fileStem(file.name));
          const id = `look-${Date.now().toString(36)}-${added.length}`;
          prefs.gradePresets = [...(prefs.gradePresets ?? []), { id, name, look }];
          last = { look, name, preset: id };
          added.push(name);
        } else {
          const { id, parsed } = await importLut(text);
          const name = parsed.title || fileStem(file.name);
          prefs.luts = [...(prefs.luts ?? []).filter((l) => l.id !== id), { id, name }];
          // A LUT goes onto the section as it is, keeping its sliders.
          const base = current()?.look ?? makeLook();
          last = { look: { ...base, lut: { id, name }, lutAmount: 1 }, name, preset: null };
          added.push(name);
        }
        savePrefs();
      } catch (err) {
        toast(`${file.name}: ${err.message}`);
      }
    }
    if (last) {
      applyLook(last.look, last.name, last.preset);
      toast(added.length === 1 ? `Imported “${added[0]}”.` : `Imported ${added.length} looks.`);
    }
    render();
  });

  /* ---------- the player ---------- */

  const layer = $("grade-layer");
  let player = null;
  try { player = createGradePlayer(layer); } catch (err) { console.error("grading preview unavailable", err); }
  let drawn = "";

  /**
   * Runs every frame: grades the picture the player shows (the video, or the processed still
   * on the Background tab) for the section under the playhead, and hides itself elsewhere.
   */
  /** The look under the playhead: its section's, the log transform alone between sections, or none. */
  function lookAt(doc, t) {
    const s = sectionAt(doc.grade, t);
    if (s && !isNeutral(s.look)) return s.look;
    return needsTransform(doc.grade) ? TRANSFORM_ONLY : null;
  }

  function draw() {
    const doc = store.doc;
    const look = doc && player && !isComparing() ? lookAt(doc, video.currentTime) : null;
    if (!look || !video.videoWidth) {
      layer.hidden = true;
      drawn = "";
      return;
    }
    const colorSource = doc.grade.source ?? "rec709";
    const effect = $("effect");
    const source = !effect.hidden && effect.complete && effect.naturalWidth ? effect : video;
    const key = `${video.currentTime}|${colorSource}|${JSON.stringify(look)}|${source === video ? "v" : effect.src}`;
    if (key === drawn && video.paused) return;
    if (player.draw(source, look, colorSource)) {
      drawn = key;
      layer.hidden = false;
    } else {
      layer.hidden = true;
    }
  }

  // currentTime changes as soon as a seek starts, before the new frame is decoded; draw again once it is,
  // or a paused, slow-decoding video keeps the stale (often black) frame.
  video.addEventListener("seeked", () => { drawn = ""; });

  /* ---------- scopes ---------- */

  const scopeOverlay = $("scopes");
  const scopeToggle = $("scopes-toggle");
  const scopes = createScopes({ frame: () => video });
  let scopeLut = null;
  let scopeLutId = null;

  function setScopes(on) {
    scopeOverlay.hidden = !on;
    scopeToggle.setAttribute("aria-pressed", String(on));
    scopes.setVisible(on);
  }

  scopeToggle.addEventListener("click", () => setScopes(scopeOverlay.hidden));

  /** Feeds the scopes the section under the playhead, resolving its LUT once and caching it. */
  function updateScopeGrade() {
    const doc = store.doc;
    const look = doc ? lookAt(doc, video.currentTime) : null;
    const lutId = look?.lut?.id ?? null;
    if (lutId !== scopeLutId) {
      scopeLutId = lutId;
      scopeLut = null;
      if (lutId) loadLut(lutId).then((l) => { if (scopeLutId === lutId) scopeLut = l; }).catch(() => {});
    }
    scopes.setGrade(look, look?.lut ? scopeLut : null, doc?.grade.source ?? "rec709");
  }

  (function loop() {
    draw();
    updateScopeGrade();
    requestAnimationFrame(loop);
  })();

  return {
    render,
    /** The graded picture, when it's showing, for layers that use the frame (inverted captions). */
    get layer() { return layer.hidden ? null : layer; },
    splitAtPlayhead,
    deleteSelected,
    resetSelected: () => resetSection(),
    toggleScopes: () => setScopes(scopeOverlay.hidden),
    setScopes,
    /** Called when the Color tab opens or closes, so scopes only appear where they belong. */
    setActive(on) {
      scopeToggle.hidden = !on;
      if (!on) setScopes(false);
    },
  };
}
