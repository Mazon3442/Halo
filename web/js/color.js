// The Color tab: what the footage was shot in (log profiles are transformed first), then graded
// sections of the video, each with its own look: sliders, film emulation, colour wheels and an
// optional LUT. Built-in and saved looks preview on the video's own frame, and LUTs and Lightroom
// presets can be imported. Sections show on the timeline's Color track, where they're moved and
// trimmed; the player draws them live.

import {
  CHUNK_SECS, CURVE_CHANNELS, DEFAULT_LOOK, FILM_STOCKS, HSL_BANDS, LOOKS, SOURCES, WHEELS, activeLook, bakeLook, createGradePlayer,
  curveFn, freeSpan, gradeColor, importLut, isNeutral, isStraight, loadLut, makeLook, needsTransform, neutralBalance, paintFrame,
  parseXmp, sectionAt, toCube,
} from "./grade.js";
import { api } from "./api.js";
import { createScopes } from "./scopes.js";
import { editableValue } from "./scrub.js";

const $ = (id) => document.getElementById(id);
const SLIDERS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "fade", "temperature", "tint", "saturation", "vibrance", "lutAmount", "filmAmount", "skinProtect", "mix"];
const CURVE_COLORS = { master: "#e9eaec", red: "#ff6b6b", green: "#5fd38d", blue: "#6aa8ff" };
const BAND_COLORS = { red: "#ff4d4d", orange: "#ff9a3c", yellow: "#f5d63b", green: "#4cd964", aqua: "#3fd4d4", blue: "#4d8dff", purple: "#9b6bff", magenta: "#ff5ad1" };
/** A grade copied with Ctrl+C on the Color tab, kept across videos for this session. */
let gradeClipboard = null;
/** A look that only transforms log footage, for the stretches nothing grades. */
const TRANSFORM_ONLY = makeLook();
const SOURCE_HINTS = {
  rec709: "Phones and cameras record this unless you chose a log profile.",
  log: "Log footage looks flat and grey. Halo converts it from the camera's log curve and color gamut to normal contrast and color before grading, like a color space transform in Resolve, across the whole video.",
};
const HDR_NAMES = { hlg: "HDR (HLG)", pq: "HDR10 (PQ)" };

function fileStem(name) {
  return name.replace(/\.[^.]+$/, "");
}

export function createColorPanel({ store, timeline, video, toast, getPrefs, savePrefs, isComparing, getMedia = () => null }) {
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
    const hdr = getMedia()?.hdr;
    $("grade-source-hint").textContent = !hdr
      ? SOURCE_HINTS[source === "rec709" ? "rec709" : "log"]
      : source === "rec709"
        ? `This video is ${HDR_NAMES[hdr] ?? "HDR"}, as phones record by default. Halo shows and exports it in standard range with HDR's reference white as white, the way browsers and most apps show HDR on an ordinary screen. Highlights brighter than that clip, so check them with false colour (Alt+F).`
        : `This video is ${HDR_NAMES[hdr] ?? "HDR"}, not log. It's already converted to standard range, so choose Rec.709 / standard here or the colours will be wrong.`;
    $("grade-source-hint").classList.toggle("warn", !!hdr && source !== "rec709");
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
    $("grade-look-name").textContent = s.bypass ? `${s.name ?? ""} · bypassed` : s.name ?? "";
    $("grade-bypass").setAttribute("aria-pressed", String(!!s.bypass));
    $("grade-bypass").classList.toggle("primary", !!s.bypass);
    $("grade-editor").classList.toggle("bypassed", !!s.bypass);
    $("grade-paste").disabled = !gradeClipboard;
    $("grade-apply-all").disabled = sections.length < 2;
    $("grade-film").value = look.film ?? "none";
    $("grade-film-amount-row").hidden = (look.film ?? "none") === "none";
    renderWheels(makeLook(s.look));
    renderCurves();
    renderHsl(look);
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

  /* ---------- curves ---------- */

  const curveCanvas = $("curve-canvas");
  let curveChannel = "master";
  /** The point being dragged or last touched, as an index into the shown channel's points. */
  let curvePoint = null;
  let curveHist = { key: "", bins: null };
  const PAD = 8;

  function curvePoints(ch, look = makeLook(current()?.look)) {
    return (look.curves?.[ch] ?? [[0, 0], [1, 1]]).map((p) => [...p]);
  }

  function setCurve(ch, points, coalesce) {
    edit((s) => {
      const curves = { ...(makeLook(s.look).curves ?? {}), [ch]: points.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]) };
      s.look = makeLook({ ...s.look, curves });
      s.preset = null;
    }, coalesce);
  }

  /** This frame's histogram for the shown channel, through the grade up to the curves, so it shows what they act on. */
  function histogram(look) {
    if (!frame) return null;
    const source = store.doc?.grade.source ?? "rec709";
    const before = { ...makeLook(look), curves: null, lut: null };
    const key = `${frameKey}|${curveChannel}|${JSON.stringify(before)}`;
    if (curveHist.key === key) return curveHist.bins;
    const bins = new Float32Array(64);
    const d = frame.data;
    for (let i = 0; i < d.length; i += 4) {
      const c = gradeColor([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255], before, null, source);
      const v = curveChannel === "master" ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : c[["red", "green", "blue"].indexOf(curveChannel)];
      bins[Math.min(63, Math.floor(v * 64))]++;
    }
    const peak = Math.max(...bins) || 1;
    for (let i = 0; i < 64; i++) bins[i] = Math.sqrt(bins[i] / peak);
    curveHist = { key, bins };
    return bins;
  }

  function renderCurves() {
    const s = current();
    if (!s) return;
    const look = makeLook(s.look);
    for (const r of document.querySelectorAll("input[name=curve-ch]")) r.checked = r.value === curveChannel;
    for (const ch of CURVE_CHANNELS) {
      document.querySelector(`label[for=curve-${ch}]`).classList.toggle("edited", !isStraight(look.curves?.[ch]));
    }
    const dpr = window.devicePixelRatio || 1;
    const w = curveCanvas.clientWidth || 280;
    const h = w;
    if (curveCanvas.width !== Math.round(w * dpr)) {
      curveCanvas.width = Math.round(w * dpr);
      curveCanvas.height = Math.round(h * dpr);
      curveCanvas.style.height = `${h}px`;
    }
    const ctx = curveCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const size = w - PAD * 2;
    const X = (x) => PAD + x * size;
    const Y = (y) => PAD + (1 - y) * size;
    ctx.fillStyle = "#0e0f12";
    ctx.fillRect(PAD, PAD, size, size);
    const bins = histogram(look);
    if (bins) {
      ctx.fillStyle = curveChannel === "master" ? "#ffffff14" : `${CURVE_COLORS[curveChannel]}22`;
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      bins.forEach((v, i) => { ctx.lineTo(X(i / 64), Y(v * 0.9)); ctx.lineTo(X((i + 1) / 64), Y(v * 0.9)); });
      ctx.lineTo(X(1), Y(0));
      ctx.fill();
    }
    ctx.strokeStyle = "#ffffff12";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(X(i / 4) + 0.5, Y(0)); ctx.lineTo(X(i / 4) + 0.5, Y(1)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(0), Y(i / 4) + 0.5); ctx.lineTo(X(1), Y(i / 4) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "#ffffff26";
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
    ctx.setLineDash([]);
    const drawCurve = (ch, strong) => {
      const pts = curvePoints(ch, look);
      const f = curveFn(pts);
      ctx.strokeStyle = strong ? CURVE_COLORS[ch] : `${CURVE_COLORS[ch]}55`;
      ctx.lineWidth = strong ? 1.75 : 1;
      ctx.beginPath();
      for (let i = 0; i <= size; i++) {
        const x = i / size;
        if (i === 0) ctx.moveTo(X(x), Y(f(x))); else ctx.lineTo(X(x), Y(f(x)));
      }
      ctx.stroke();
      return pts;
    };
    for (const ch of CURVE_CHANNELS) if (ch !== curveChannel && !isStraight(look.curves?.[ch])) drawCurve(ch, false);
    const pts = drawCurve(curveChannel, true);
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(X(x), Y(y), i === curvePoint ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === curvePoint ? CURVE_COLORS[curveChannel] : "#131417";
      ctx.fill();
      ctx.strokeStyle = CURVE_COLORS[curveChannel];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    curveCanvas.setAttribute("aria-label", `${curveChannel} curve with ${pts.length} points`);
  }

  function curveAt(ev) {
    const r = curveCanvas.getBoundingClientRect();
    const size = r.width - PAD * 2;
    return [(ev.clientX - r.left - PAD) / size, 1 - (ev.clientY - r.top - PAD) / size, size];
  }

  function readout(x, y) {
    $("curve-readout").textContent = x == null ? "" : `In ${Math.round(x * 255)} → Out ${Math.round(y * 255)}`;
  }

  curveCanvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !current()) return;
    const [x, y, size] = curveAt(ev);
    let pts = curvePoints(curveChannel);
    const near = 9 / size;
    let i = pts.findIndex(([px, py]) => Math.abs(px - x) < near && Math.abs(py - y) < near);
    if (i < 0) {
      // A new point, where the pointer is, between the points either side of it.
      if (x <= 0.01 || x >= 0.99) return;
      pts.push([x, Math.min(1, Math.max(0, y))]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex((p) => p[0] === x);
    }
    curvePoint = i;
    const key = `curve-${performance.now()}`;
    setCurve(curveChannel, pts, key);
    try { curveCanvas.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    const ends = i === 0 || i === pts.length - 1;
    let removing = false;
    const move = (e) => {
      const [mx, my] = curveAt(e);
      pts = curvePoints(curveChannel);
      const lo = ends ? (i === 0 ? 0 : 1) : pts[i - 1][0] + 0.01;
      const hi = ends ? (i === 0 ? 0 : 1) : pts[i + 1][0] - 0.01;
      // Middle points dragged well off the graph are removed when let go, as in Lightroom.
      removing = !ends && (my < -0.08 || my > 1.08 || mx < lo - 0.1 || mx > hi + 0.1);
      curveCanvas.classList.toggle("removing", removing);
      pts[i] = [Math.min(hi, Math.max(lo, mx)), Math.min(1, Math.max(0, my))];
      readout(...pts[i]);
      setCurve(curveChannel, pts, key);
    };
    const up = () => {
      curveCanvas.removeEventListener("pointermove", move);
      curveCanvas.classList.remove("removing");
      readout(null);
      if (removing) {
        pts.splice(i, 1);
        curvePoint = null;
        setCurve(curveChannel, pts, key);
      }
    };
    curveCanvas.addEventListener("pointermove", move);
    curveCanvas.addEventListener("pointerup", up, { once: true });
    curveCanvas.addEventListener("pointercancel", up, { once: true });
  });
  curveCanvas.addEventListener("dblclick", (ev) => {
    const [x, y, size] = curveAt(ev);
    const pts = curvePoints(curveChannel);
    const i = pts.findIndex(([px, py]) => Math.abs(px - x) < 9 / size && Math.abs(py - y) < 9 / size);
    if (i > 0 && i < pts.length - 1) {
      pts.splice(i, 1);
      curvePoint = null;
      setCurve(curveChannel, pts);
    }
  });
  curveCanvas.addEventListener("pointermove", (ev) => {
    if (ev.buttons) return;
    const [x, y, size] = curveAt(ev);
    const near = curvePoints(curveChannel).some(([px, py]) => Math.abs(px - x) < 9 / size && Math.abs(py - y) < 9 / size);
    curveCanvas.style.cursor = near ? "grab" : "crosshair";
  });
  curveCanvas.addEventListener("keydown", (ev) => {
    const pts = curvePoints(curveChannel);
    if (curvePoint == null || curvePoint >= pts.length) curvePoint = Math.min(1, pts.length - 1);
    const i = curvePoint;
    const step = (ev.shiftKey ? 10 : 1) / 255;
    if (ev.key === "Tab" && !ev.ctrlKey) return;
    if (ev.key === "[" || ev.key === "]") { curvePoint = (i + (ev.key === "]" ? 1 : pts.length - 1)) % pts.length; renderCurves(); ev.preventDefault(); return; }
    const d = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[ev.key];
    if (d) {
      ev.preventDefault();
      const ends = i === 0 || i === pts.length - 1;
      const lo = ends ? pts[i][0] : pts[i - 1][0] + 0.01;
      const hi = ends ? pts[i][0] : pts[i + 1][0] - 0.01;
      pts[i] = [Math.min(hi, Math.max(lo, pts[i][0] + d[0])), Math.min(1, Math.max(0, pts[i][1] + d[1]))];
      readout(...pts[i]);
      setCurve(curveChannel, pts, "curve-key");
    } else if ((ev.key === "Delete" || ev.key === "Backspace") && i > 0 && i < pts.length - 1) {
      ev.preventDefault();
      pts.splice(i, 1);
      curvePoint = null;
      setCurve(curveChannel, pts);
    }
  });
  for (const r of document.querySelectorAll("input[name=curve-ch]")) {
    r.addEventListener("change", () => { curveChannel = r.value; curvePoint = null; renderCurves(); });
  }
  $("curve-reset").addEventListener("click", () => { curvePoint = null; setCurve(curveChannel, [[0, 0], [1, 1]]); });
  new ResizeObserver(() => { if (current()) renderCurves(); }).observe(curveCanvas);

  /* ---------- HSL ---------- */

  let hslProp = "h";
  const hslEls = {};
  for (const band of Object.keys(HSL_BANDS)) {
    const row = document.createElement("div");
    row.className = "slider-row";
    const label = document.createElement("label");
    label.htmlFor = `hsl-${band}`;
    label.innerHTML = `<span class="band-dot" style="background:${BAND_COLORS[band]}"></span>`;
    label.append(band[0].toUpperCase() + band.slice(1));
    const range = document.createElement("input");
    range.type = "range";
    range.id = `hsl-${band}`;
    range.className = "hsl-range";
    const value = document.createElement("span");
    value.className = "value";
    row.append(label, range, value);
    $("hsl-rows").append(row);
    hslEls[band] = { range, value };
    range.addEventListener("input", () => {
      const v = Number(range.value) / (hslProp === "h" ? 1 : 100);
      edit((s) => {
        const hsl = structuredClone(s.look.hsl ?? {});
        const b = { ...(hsl[band] ?? {}), [hslProp]: v };
        if (!b[hslProp]) delete b[hslProp];
        if (Object.keys(b).length) hsl[band] = b; else delete hsl[band];
        s.look = { ...s.look, hsl: Object.keys(hsl).length ? hsl : null };
        s.preset = null;
      }, `hsl-${band}-${hslProp}`);
    });
    range.addEventListener("dblclick", () => { range.value = "0"; range.dispatchEvent(new Event("input")); });
    editableValue(value, range);
  }

  function renderHsl(look) {
    const hueRange = hslProp === "h";
    for (const r of document.querySelectorAll("input[name=hsl-prop]")) r.checked = r.value === hslProp;
    for (const [band, { range, value }] of Object.entries(hslEls)) {
      Object.assign(range, hueRange ? { min: -30, max: 30, step: 1 } : { min: -100, max: 100, step: 1 });
      const v = look.hsl?.[band]?.[hslProp] ?? 0;
      const shown = hueRange ? Math.round(v) : Math.round(v * 100);
      if (document.activeElement !== range || Number(range.value) !== shown) range.value = String(shown);
      value.textContent = hueRange ? `${shown > 0 ? "+" : ""}${shown}°` : `${shown > 0 ? "+" : ""}${shown}`;
      const hue = HSL_BANDS[band];
      range.style.setProperty("--track", hueRange
        ? `linear-gradient(90deg, hsl(${hue - 30} 75% 55%), hsl(${hue} 75% 55%), hsl(${hue + 30} 75% 55%))`
        : hslProp === "s"
          ? `linear-gradient(90deg, hsl(${hue} 0% 50%), hsl(${hue} 85% 52%))`
          : `linear-gradient(90deg, hsl(${hue} 70% 18%), hsl(${hue} 75% 50%), hsl(${hue} 80% 82%))`);
    }
  }
  for (const r of document.querySelectorAll("input[name=hsl-prop]")) {
    r.addEventListener("change", () => { hslProp = r.value; render(); });
  }
  $("hsl-reset").addEventListener("click", () => edit((s) => { s.look = { ...s.look, hsl: null }; s.preset = null; }));

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

  /** The section keyboard trims work on: the selected one, else the one under the playhead. */
  function trimTarget(t) {
    return current() ?? sectionAt(store.doc.grade, t) ?? null;
  }

  /**
   * Moves the start or end of a section to the playhead, as [ and ] (or Q and W) do on the
   * timeline: shorter if the playhead's inside it, longer into free time if it's outside.
   */
  function trimToPlayhead(side) {
    const t = video.currentTime;
    const s = trimTarget(t);
    if (!s) return toast("Select a graded section, or move the playhead into one, to trim it.");
    const list = store.doc.grade.sections;
    const k = list.findIndex((x) => x.id === s.id);
    const lo = list[k - 1]?.end ?? 0;
    const hi = list[k + 1]?.start ?? (video.duration || s.end);
    const at = side === "start" ? Math.max(lo, Math.min(t, s.end - 0.1)) : Math.min(hi, Math.max(t, s.start + 0.1));
    if (Math.abs(at - (side === "start" ? s.start : s.end)) < 1e-4) return;
    timeline.selectGrade(s.id);
    store.update((d) => {
      const x = d.grade.sections.find((g) => g.id === s.id);
      if (x) x[side] = at;
    });
  }

  /**
   * Moves the selected section's edge nearest the playhead to it. Where it meets the next section,
   * both move, a roll edit, so the cut between two grades lands on the playhead.
   */
  function rollToPlayhead() {
    const t = video.currentTime;
    const s = trimTarget(t);
    if (!s) return toast("Select a graded section to move its nearest edge to the playhead.");
    const list = store.doc.grade.sections;
    const k = list.findIndex((x) => x.id === s.id);
    const side = Math.abs(t - s.start) <= Math.abs(t - s.end) ? "start" : "end";
    const other = side === "start" ? list[k - 1] : list[k + 1];
    const touching = other && Math.abs((side === "start" ? other.end : other.start) - s[side]) < 1e-3;
    const lo = side === "start" ? (touching ? other.start + 0.1 : other?.end ?? 0) : s.start + 0.1;
    const hi = side === "start" ? s.end - 0.1 : touching ? other.end - 0.1 : other?.start ?? (video.duration || s.end);
    const at = Math.max(lo, Math.min(hi, t));
    store.update((d) => {
      const x = d.grade.sections.find((g) => g.id === s.id);
      if (!x) return;
      x[side] = at;
      const y = touching && d.grade.sections.find((g) => g.id === other.id);
      if (y) y[side === "start" ? "end" : "start"] = at;
    });
  }

  /** Saves the selected section's grade as a .cube, for Premiere, Resolve, Final Cut, a camera monitor... */
  async function exportLut() {
    const s = current();
    if (!s) return toast("Select a graded section to export its grade as a LUT.");
    const name = s.name && s.name !== "Graded" ? s.name : "Halo grade";
    const source = store.doc.grade.source ?? "rec709";
    try {
      const { path } = await api.post("/dialog/save", {
        file_name: `${name.replace(/[\\/:*?"<>|]/g, "")}.cube`,
        extension: "cube",
        directory: getPrefs().lutDir ?? null,
        title: "Export LUT",
      });
      if (!path) return;
      const text = toCube(await bakeLook(activeLook(s) ?? makeLook(), source), name);
      await api.post("/files/text", { path, text, overwrite: true });
      const prefs = getPrefs();
      prefs.lutDir = path.replace(/[\\/][^\\/]*$/, "");
      savePrefs();
      toast(source === "rec709"
        ? `Saved “${name}” as a LUT.`
        : `Saved “${name}” as a LUT. It includes the conversion from log, so put it on the original log clip.`);
    } catch (err) {
      toast(`Couldn't save the LUT: ${err.message}`);
    }
  }
  $("grade-export-lut").addEventListener("click", exportLut);

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
  timeline.onGradeTrim = (side) => trimToPlayhead(side);
  timeline.onGradeExportLut = () => exportLut();

  for (const key of SLIDERS) {
    const el = $(`grade-${key}`);
    const scale = Number(el.dataset.scale ?? 0.01);
    el.addEventListener("input", () => edit((s) => { s.look = { ...s.look, [key]: Number(el.value) * scale }; s.preset = null; }, `grade-${key}`));
    el.addEventListener("dblclick", () => edit((s) => { s.look = { ...s.look, [key]: DEFAULT_LOOK[key] }; }));
    // The readout shows exposure in stops and everything else as the slider's own number.
    editableValue($(`grade-${key}-v`), el, { toRange: (v) => (key === "exposure" ? v / scale : v) });
  }

  /* ---------- bypass, copy and paste, and applying a grade elsewhere ---------- */

  function toggleBypass(id = timeline.gradeSelection) {
    const s = store.doc?.grade.sections.find((x) => x.id === id);
    if (!s) return toast("Select a graded section on the Color track first.");
    store.update((d) => {
      const x = d.grade.sections.find((g) => g.id === id);
      if (x) { if (x.bypass) delete x.bypass; else x.bypass = true; }
    });
    toast(s.bypass ? `“${s.name || "Graded"}” is on again.` : `“${s.name || "Graded"}” bypassed. It's left out of the export too.`);
  }

  /** Switches every section off, or back on if they're all off already, like Resolve's Shift+D. */
  function toggleBypassAll() {
    const sections = store.doc?.grade.sections ?? [];
    if (!sections.length) return;
    const off = !sections.every((x) => x.bypass);
    store.update((d) => { for (const x of d.grade.sections) { if (off) x.bypass = true; else delete x.bypass; } });
    toast(off ? "All grades bypassed." : "All grades on.");
  }

  function copyGrade(id = timeline.gradeSelection) {
    const s = store.doc?.grade.sections.find((x) => x.id === id);
    if (!s) return false;
    gradeClipboard = { look: structuredClone(s.look), name: s.name, preset: s.preset ?? null };
    toast(`Copied the grade of “${s.name || "Graded"}”.`);
    render();
    return true;
  }

  /** Pastes the copied grade onto the selected section, or the section at the playhead, or a new one there. */
  function pasteGrade() {
    if (!gradeClipboard) return toast("Copy a grade first: select a section and press Ctrl+C.");
    const { look, name, preset } = gradeClipboard;
    applyLook(structuredClone(look), name, preset);
  }

  /** Gives the selected section the grade of the section before it, as "=" does in Resolve. */
  function applyPrevious() {
    const s = current() ?? sectionAt(store.doc.grade, video.currentTime);
    const list = store.doc.grade.sections;
    const k = s ? list.findIndex((x) => x.id === s.id) : -1;
    if (k <= 0) return toast("There's no graded section before this one.");
    const prev = list[k - 1];
    timeline.selectGrade(s.id);
    edit((x) => { x.look = structuredClone(prev.look); x.name = prev.name; x.preset = prev.preset ?? null; });
    toast(`Applied “${prev.name || "Graded"}” from the section before.`);
  }

  function applyToAll() {
    const s = current();
    if (!s) return;
    const n = store.doc.grade.sections.length - 1;
    store.update((d) => {
      for (const x of d.grade.sections) {
        if (x.id === s.id) continue;
        x.look = structuredClone(s.look);
        x.name = s.name;
        x.preset = s.preset ?? null;
      }
    });
    toast(`Applied “${s.name || "Graded"}” to ${n === 1 ? "the other section" : `${n} other sections`}.`, { action: "Undo", onAction: () => store.undo() });
  }

  function renameSection(id, name) {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    store.update((d) => {
      const x = d.grade.sections.find((g) => g.id === id);
      if (x) x.name = clean;
    });
  }

  $("grade-bypass").addEventListener("click", () => toggleBypass());
  $("grade-copy").addEventListener("click", () => copyGrade());
  $("grade-paste").addEventListener("click", () => pasteGrade());
  $("grade-apply-all").addEventListener("click", () => applyToAll());
  timeline.onGradeBypass = toggleBypass;
  timeline.onGradeCopy = copyGrade;
  timeline.onGradePaste = (id) => { timeline.selectGrade(id); pasteGrade(); };
  timeline.onGradeRename = renameSection;
  timeline.onGradeMatchPrevious = (id) => { timeline.selectGrade(id); applyPrevious(); };
  timeline.hasGradeClipboard = () => !!gradeClipboard;

  /* ---------- white balance picker ---------- */

  /**
   * Click on something that should be white or grey: the colour under the pointer (averaged over a
   * few pixels, from the footage itself) sets the temperature and tint that make it neutral.
   */
  function pickNeutral() {
    if (!current()) return;
    const screen = $("screen");
    if (screen.classList.contains("picking")) return stopPicking();
    screen.classList.add("picking");
    $("grade-wb-pick").classList.add("active");
    toast("Click something white or grey in the video. Esc cancels.");
    const pick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      stopPicking();
      const r = screen.getBoundingClientRect();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const c = document.createElement("canvas");
      c.width = vw;
      c.height = vh;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, vw, vh);
      const x = Math.round(((ev.clientX - r.left) / r.width) * vw);
      const y = Math.round(((ev.clientY - r.top) / r.height) * vh);
      const k = Math.max(2, Math.round(Math.min(vw, vh) / 270));
      let px;
      try { px = ctx.getImageData(Math.max(0, x - k), Math.max(0, y - k), k * 2 + 1, k * 2 + 1).data; } catch { return toast("Couldn't read that frame."); }
      const avg = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) for (let ch = 0; ch < 3; ch++) avg[ch] += px[i + ch] / 255;
      const n = px.length / 4;
      const rgb = avg.map((v) => v / n);
      if (Math.max(...rgb) < 0.04) return toast("That's too dark to balance from. Pick a lighter grey or white.");
      const source = store.doc.grade.source ?? "rec709";
      const wb = neutralBalance(rgb, current().look, source);
      edit((s) => { s.look = { ...s.look, ...wb }; s.preset = null; });
      toast(`Balanced: temperature ${Math.round(wb.temperature * 100)}, tint ${Math.round(wb.tint * 100)}.`, { action: "Undo", onAction: () => store.undo() });
    };
    const key = (ev) => { if (ev.key === "Escape") stopPicking(); };
    function stopPicking() {
      screen.classList.remove("picking");
      $("grade-wb-pick").classList.remove("active");
      screen.removeEventListener("click", pick, true);
      document.removeEventListener("keydown", key, true);
    }
    screen.addEventListener("click", pick, true);
    document.addEventListener("keydown", key, true);
  }
  $("grade-wb-pick").addEventListener("click", pickNeutral);

  /* ---------- split wipe ---------- */

  // The original on the left of a line dragged across the picture, the grade on the right, like
  // the split-screen wipe in Resolve's viewer.
  let wipe = null;
  const wipeEl = document.createElement("div");
  wipeEl.className = "wipe-handle";
  wipeEl.hidden = true;
  wipeEl.innerHTML = `<span class="wipe-label left">Original</span><span class="wipe-label right">Graded</span><span class="wipe-grip" title="Drag to move the wipe"></span>`;
  $("screen").append(wipeEl);

  function setWipe(on) {
    wipe = on ? (wipe ?? 0.5) : null;
    wipeEl.hidden = !on;
    $("wipe-toggle")?.setAttribute("aria-pressed", String(!!on));
    $("wipe-toggle")?.classList.toggle("primary", !!on);
    placeWipe();
  }

  function placeWipe() {
    if (wipe == null) { layer.style.clipPath = ""; return; }
    wipeEl.style.left = `${wipe * 100}%`;
    layer.style.clipPath = `inset(0 0 0 ${wipe * 100}%)`;
  }

  const grip = wipeEl.querySelector(".wipe-grip");
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { grip.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    const r = $("screen").getBoundingClientRect();
    const move = (e) => { wipe = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width)); placeWipe(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => grip.removeEventListener("pointermove", move), { once: true });
  });
  grip.addEventListener("click", (ev) => ev.stopPropagation());
  $("wipe-toggle")?.addEventListener("click", () => setWipe(wipe == null));
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
    const look = activeLook(sectionAt(doc.grade, t));
    if (look && !isNeutral(look)) return look;
    return needsTransform(doc.grade) ? TRANSFORM_ONLY : null;
  }

  /** False colour, for judging exposure: a view of the graded picture, never exported. */
  let falseColor = false;
  function setFalseColor(on) {
    falseColor = !!on;
    drawn = "";
    $("false-color-toggle")?.setAttribute("aria-pressed", String(falseColor));
    $("false-color-toggle")?.classList.toggle("primary", falseColor);
    $("false-color-key").hidden = !falseColor;
  }
  $("false-color-toggle")?.addEventListener("click", () => setFalseColor(!falseColor));

  function draw() {
    const doc = store.doc;
    const look = doc && player && !isComparing() ? lookAt(doc, video.currentTime) ?? (falseColor ? TRANSFORM_ONLY : null) : null;
    if (!look || !video.videoWidth) {
      layer.hidden = true;
      drawn = "";
      return;
    }
    const colorSource = doc.grade.source ?? "rec709";
    const effect = $("effect");
    const source = !effect.hidden && effect.complete && effect.naturalWidth ? effect : video;
    const key = `${video.currentTime}|${colorSource}|${falseColor}|${JSON.stringify(look)}|${source === video ? "v" : effect.src}`;
    if (key === drawn && video.paused) return;
    if (player.draw(source, look, colorSource, { falseColor })) {
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
    toggleBypass: () => toggleBypass(),
    toggleBypassAll,
    copyGrade: () => copyGrade(),
    pasteGrade,
    applyPrevious,
    toggleWipe: () => setWipe(wipe == null),
    toggleFalseColor: () => setFalseColor(!falseColor),
    trimToPlayhead,
    rollToPlayhead,
    exportLut,
    toggleScopes: () => setScopes(scopeOverlay.hidden),
    setScopes,
    /** Called when the Color tab opens or closes, so scopes only appear where they belong. */
    setActive(on) {
      scopeToggle.hidden = !on;
      $("wipe-toggle").hidden = !on;
      $("false-color-toggle").hidden = !on;
      if (!on) { setScopes(false); setWipe(false); setFalseColor(false); }
    },
  };
}
