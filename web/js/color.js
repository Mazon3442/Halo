// The Color tab: graded sections of the video, each with its own look (sliders and an optional
// LUT), built-in and saved looks, and importing LUTs and Lightroom presets. Sections show on the
// timeline's Color track, where they're moved and trimmed; the player draws them live.

import { CHUNK_SECS, DEFAULT_LOOK, LOOKS, createGradePlayer, freeSpan, importLut, isNeutral, loadLut, makeLook, paintSwatch, parseXmp, sectionAt } from "./grade.js";
import { createScopes } from "./scopes.js";

const $ = (id) => document.getElementById(id);
const SLIDERS = ["exposure", "contrast", "highlights", "shadows", "fade", "temperature", "tint", "saturation", "vibrance", "lutAmount"];

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
    $("color-dot").hidden = !sections.some((x) => !isNeutral(x.look));
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
    renderLuts(look);
    renderLooks(s);
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
    const full = makeLook(look);
    if (full.lut) loadLut(full.lut.id).then((lut) => paintSwatch(canvas, full, lut)).catch(() => paintSwatch(canvas, full, null));
    else paintSwatch(canvas, full, null);
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    b.append(sample, label);
    b.addEventListener("click", onPick);
    return b;
  }

  function renderLooks(s) {
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
  function draw() {
    const doc = store.doc;
    const s = doc && player && !isComparing() ? sectionAt(doc.grade, video.currentTime) : null;
    if (!s || isNeutral(s.look) || !video.videoWidth) {
      layer.hidden = true;
      drawn = "";
      return;
    }
    const effect = $("effect");
    const source = !effect.hidden && effect.complete && effect.naturalWidth ? effect : video;
    const key = `${video.currentTime}|${JSON.stringify(s.look)}|${source === video ? "v" : effect.src}`;
    if (key === drawn && video.paused) return;
    if (player.draw(source, s.look)) {
      drawn = key;
      layer.hidden = false;
    } else {
      layer.hidden = true;
    }
  }

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
    const s = doc ? sectionAt(doc.grade, video.currentTime) : null;
    const look = s && !isNeutral(s.look) ? s.look : null;
    const lutId = look?.lut?.id ?? null;
    if (lutId !== scopeLutId) {
      scopeLutId = lutId;
      scopeLut = null;
      if (lutId) loadLut(lutId).then((l) => { if (scopeLutId === lutId) scopeLut = l; }).catch(() => {});
    }
    scopes.setGrade(look, look?.lut ? scopeLut : null);
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
