// The caption style panel, plus the caption box on the player that moves and resizes captions.
// Edits apply to every caption, or with "Selected" only to the captions selected on the timeline,
// which then keep a look and animation of their own. Presets and animations can also be dragged
// straight onto captions on the timeline.

import { api } from "./api.js";
import { displayText, groupLines, lineTimes, lineStyle, lockLine, readableOn } from "./captions.js";
import { editableValue } from "./scrub.js";
import { GLOBAL_ONLY, PRESETS, animation, lookOf, normalizeStyle, presetStyle } from "./styles.js";
import { getPlugin, listPlugins, onPluginsChanged, pluginParams } from "./plugins/registry.js";
import { makeDraggable } from "./dragdrop.js";

const $ = (id) => document.getElementById(id);

const SAMPLES = {
  pop: `<span class="s-pop s-out">SO <span class="w">GOOD</span></span>`,
  loud: `<span class="s-loud s-out">SO <span class="w">GOOD</span></span>`,
  clean: `<span class="s-clean">So good, right?</span>`,
  karaoke: `<span class="s-karaoke">So good, right</span>`,
  outline: `<span class="s-outline">so <span class="w">good</span> right</span>`,
  box: `<span class="s-box s-out">SO <span class="w">GOOD</span></span>`,
  oneword: `<span class="s-one s-out">GOOD</span>`,
  subtitle: `<span class="s-sub">So good, right?</span>`,
  glow: `<span class="s-glow">SO <span class="w">GOOD</span></span>`,
  apple: `<span class="s-apple">So good, <span class="w">right</span></span>`,
  lyrics: `<span class="s-lyrics">So good, <span class="w">right</span></span>`,
  popup: `<span class="s-pop s-out">SO <span class="w s-spring">GOOD</span></span>`,
  sunset: `<span class="s-pop s-out"><span class="s-grad s-sunset">SO GOOD</span></span>`,
  chrome: `<span class="s-loud s-out"><span class="s-grad s-chrome">SO GOOD</span></span>`,
  gold: `<span class="s-serif"><span class="s-grad s-gold">So good</span></span>`,
  realestate: `<span class="s-invert">EVERY DAY</span>`,
  luxe: `<span class="s-estate">Just <span class="w">listed</span></span>`,
  listing: `<span class="s-listing">JUST LISTED</span>`,
  wide: `<span class="s-wide s-out">SO <span class="w">GOOD</span></span>`,
  script: `<span class="s-script">So good</span>`,
};

// Open-licensed fonts Halo includes in place of commercial ones people ask for by name.
const LOOKALIKES = {
  "Inter SemiBold": "Helvetica style",
  "Inter ExtraBold": "Helvetica style",
  "Unbounded ExtraBold": "Tactic style",
  "Great Vibes": "Shelley style",
  "Yellowtail": "SignPainter style",
};

/** The colour halfway between two "#rrggbb" colours. */
function mixHex(a, b) {
  const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round((c(a, i) + c(b, i)) / 2).toString(16).padStart(2, "0")).join("");
}

const HIGHLIGHT_LABELS = { color: "Spoken word", box: "Box", glow: "Glow", karaoke: "Fill to", reveal: "Spoken word", none: "Spoken word" };

// Approximate on-screen areas covered by each app's buttons and text, as fractions of the frame.
const SAFE_ZONES = {
  tiktok: [[0, 0, 1, 0.1], [0, 0.8, 1, 1], [0.84, 0.36, 1, 0.8]],
  reels: [[0, 0, 1, 0.12], [0, 0.82, 1, 1], [0.86, 0.45, 1, 0.82]],
  shorts: [[0, 0, 1, 0.1], [0, 0.8, 1, 1], [0.86, 0.45, 1, 0.8]],
};

export function createInspector({ store, timeline, video, toast }) {
  let fonts = [];
  let scope = "all";
  let selectedWord = null;

  /* ---------- fonts ---------- */

  async function loadFonts() {
    try { fonts = await api.get("/fonts"); } catch { fonts = []; }
    const select = $("st-font");
    select.replaceChildren();
    const groups = [["Included with Halo", fonts.filter((f) => f.bundled)], ["Installed on this computer", fonts.filter((f) => !f.bundled)]];
    for (const [name, list] of groups) {
      if (!list.length) continue;
      const og = document.createElement("optgroup");
      og.label = name;
      for (const f of list) og.append(new Option(f.bundled && LOOKALIKES[f.family] ? `${f.family} · ${LOOKALIKES[f.family]}` : f.family, f.family));
      select.append(og);
    }
  }

  /** Where the page can load a font family's file from. */
  function fontUrl(family) {
    const f = fonts.find((x) => x.family.toLowerCase() === family.toLowerCase());
    return f ? api.fontUrl(f.id) : null;
  }

  /* ---------- the selected captions ---------- */

  /** Lines whose first word has one of `ids`, in time order. */
  function linesByIds(doc, ids) {
    const { words } = doc.captions;
    return groupLines(words, doc.captions.perLine).filter((l) => ids.has(words[l.from].id));
  }

  function selectedLines(doc = store.doc) {
    if (!doc || !timeline.selection.size) return [];
    return linesByIds(doc, timeline.selection);
  }

  /** The one selected caption, for per-word emphasis; null with none or several selected. */
  function selectedLine(doc = store.doc) {
    const lines = selectedLines(doc);
    return lines.length === 1 ? lines[0] : null;
  }

  /** The style the controls show: the overall style, or the first selected caption's. */
  function shownStyle() {
    const cap = store.doc.captions;
    if (scope === "one") {
      const [line] = selectedLines();
      if (line) return lineStyle(cap, cap.words, line);
    }
    return cap.style;
  }

  /**
   * Writes one style field to the overall style or to each selected caption's own style. `value`
   * may be a function of the current value, so each caption changes from where it was.
   */
  function set(key, value, coalesce) {
    const next = (current) => (typeof value === "function" ? value(current) : value);
    store.update((d) => {
      const cap = d.captions;
      if (scope === "one" && !GLOBAL_ONLY.includes(key)) {
        for (const line of selectedLines(d)) {
          const current = lineStyle(cap, cap.words, line)[key];
          const group = lockLine(cap, line);
          cap.overrides ??= {};
          cap.overrides[group] = { ...(cap.overrides[group] ?? {}), [key]: next(current) };
        }
      } else {
        cap.style[key] = next(cap.style[key]);
      }
    }, { coalesce: coalesce ?? `style-${key}` });
  }

  /** Gives the captions with these first-word ids a style of their own, as a drop on the timeline does. */
  function applyTo(ids, patch, what) {
    let count = 0;
    store.update((d) => {
      const cap = d.captions;
      for (const line of linesByIds(d, new Set(ids))) {
        const group = lockLine(cap, line);
        cap.overrides ??= {};
        cap.overrides[group] = { ...(cap.overrides[group] ?? {}), ...structuredClone(patch) };
        count++;
      }
    });
    if (count) toast(`${what} applied to ${count === 1 ? "1 caption" : `${count} captions`}.`, { action: "Undo", onAction: () => store.undo() });
  }

  /* ---------- rendering ---------- */

  function renderPresets() {
    const box = $("presets");
    box.replaceChildren();
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.className = "preset";
      b.setAttribute("role", "radio");
      b.dataset.id = p.id;
      b.innerHTML = `<div class="sample" aria-hidden="true">${SAMPLES[p.id]}</div><span class="name">${p.name}</span>`;
      b.title = "Click to use, or drag onto captions on the timeline";
      makeDraggable(b, {
        timeline,
        label: `${p.name} style`,
        onClick: () => {
          if (scope === "one") return applyTo([...timeline.selection], lookOf(presetStyle(p.id)), `“${p.name}”`);
          store.update((d) => {
            d.captions.style = presetStyle(p.id, d.captions.style);
            d.captions.perLine = p.perLine;
          });
        },
        onDrop: (ids) => applyTo(ids, lookOf(presetStyle(p.id)), `“${p.name}”`),
      });
      box.append(b);
    }
    // Presets the user saved from their own edits, listed under the built-ins.
    const mine = store.doc?.captions?.user_presets ?? [];
    for (const p of mine) {
      const b = document.createElement("button");
      b.className = "preset";
      b.setAttribute("role", "radio");
      b.dataset.id = p.id;
      const sample = document.createElement("div");
      sample.className = "sample";
      sample.setAttribute("aria-hidden", "true");
      sample.append(styleSample(p.style));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      b.append(sample, name);
      b.title = "Click to use, or drag onto captions on the timeline";
      const look = () => lookOf(normalizeStyle(p.style));
      makeDraggable(b, {
        timeline,
        label: `${p.name} style`,
        onClick: () => {
          if (scope === "one") return applyTo([...timeline.selection], look(), `“${p.name}”`);
          store.update((d) => {
            const saved = d.captions.user_presets?.find((x) => x.id === p.id);
            if (!saved) return;
            d.captions.style = normalizeStyle({ ...saved.style, preset: saved.id, x: d.captions.style.x });
            d.captions.perLine = saved.perLine;
          });
        },
        onDrop: (ids) => applyTo(ids, look(), `“${p.name}”`),
      });
      const remove = document.createElement("button");
      remove.className = "preset-delete";
      remove.setAttribute("aria-label", `Delete ${p.name}`);
      remove.title = "Delete this preset";
      remove.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>`;
      remove.addEventListener("click", () => {
        store.update((d) => {
          d.captions.user_presets = (d.captions.user_presets ?? []).filter((x) => x.id !== p.id);
        });
        toast(`Deleted “${p.name}”.`, { action: "Undo", onAction: () => store.undo() });
      });
      const tile = document.createElement("div");
      tile.className = "preset-tile";
      tile.append(b, remove);
      box.append(tile);
    }
  }

  /**
   * A still "So good" in a saved style, built from the style itself so it shows what was
   * changed: font, colours, spacing, outline, shadow, box, gradient and inverted text.
   */
  function styleSample(st) {
    pageFont(st.font);
    const el = document.createElement("span");
    const [first, second] = ["So", "good"].map((w) => displayText(w, st));
    const word = document.createElement("span");
    word.textContent = second;
    el.append(`${first} `, word);
    const s = el.style;
    s.font = `18px "halo-${st.font}", sans-serif`;
    s.letterSpacing = `${st.spacing}em`;
    s.color = st.fill;
    if (st.outline > 0) {
      const a = Math.round((st.outlineOpacity ?? 1) * 255).toString(16).padStart(2, "0");
      s.webkitTextStroke = `${Math.max(1, Math.round(st.outline * 30))}px ${st.outlineColor}${a}`;
      s.paintOrder = "stroke fill";
    }
    if (st.shadow > 0) {
      const a = Math.round(st.shadowOpacity * 255).toString(16).padStart(2, "0");
      s.textShadow = `${Math.max(1, Math.round(st.shadow * 30))}px ${Math.max(1, Math.round(st.shadow * 30))}px 0 ${st.shadowColor}${a}`;
    }
    if (st.box) {
      const a = Math.round(st.boxOpacity * 255).toString(16).padStart(2, "0");
      s.background = `${st.boxColor}${a}`;
      s.padding = "2px 6px";
    }
    const colors = st.gradientColors ?? [];
    if (st.invert) {
      s.color = "#fff";
      s.mixBlendMode = "difference";
    } else if (st.gradient !== "none" && colors.length > 1) {
      // Clipped to the text, the gradient paints the outline too, so it's drawn without one.
      s.backgroundImage = `linear-gradient(${st.gradient === "down" ? 180 : 90}deg, ${colors.join(", ")})`;
      s.backgroundClip = s.webkitBackgroundClip = "text";
      s.color = "transparent";
      s.webkitTextStroke = "";
    } else if (st.wordStyle === "box") {
      word.style.background = st.highlight;
      word.style.color = readableOn(st.highlight);
      word.style.borderRadius = "5px";
      word.style.padding = "0 4px";
    } else if (st.wordStyle === "glow") {
      word.style.textShadow = `0 0 6px ${st.highlight}, 0 0 12px ${st.highlight}`;
    } else if (st.wordStyle === "dim") {
      word.style.opacity = "0.4";
    } else if (st.wordStyle !== "none") {
      word.style.color = st.highlight;
    }
    return el;
  }

  function render() {
    const doc = store.doc;
    if (!doc) return;
    renderPresets();
    const cap = doc.captions;
    const line = selectedLine();
    const chosen = selectedLines().length;
    if (scope === "one" && !chosen) scope = "all";
    $("scope-one").disabled = !chosen;
    $("scope-one-label").textContent = chosen > 1 ? `Selected (${chosen})` : "Selected caption";
    for (const r of document.querySelectorAll("input[name=scope]")) r.checked = r.value === scope;
    $("inspector").classList.toggle("scope-one", scope === "one");
    $("inspector").classList.toggle("single", !!line);
    $("scope-hint").textContent = scope === "one"
      ? (chosen > 1 ? `Changes here apply only to the ${chosen} selected captions.` : "Changes here apply only to the selected caption.")
      : chosen ? "Changes apply to every caption." : "Changes apply to every caption. Select captions on the timeline to style them on their own, or drag a preset onto them.";
    $("preset-save").hidden = scope === "one";

    const preset = PRESETS.find((p) => p.id === cap.style.preset) ?? null;
    const saved = preset ? null : (cap.user_presets ?? []).find((p) => p.id === cap.style.preset) ?? null;
    const active = preset ?? saved;
    const look = (p) => { const o = { ...p.style }; delete o.preset; delete o.x; return o; };
    const pristine = !!active && Object.entries(look(active)).every(([k, v]) => JSON.stringify(cap.style[k]) === JSON.stringify(v));
    $("preset-state").textContent = active ? `${active.name}${pristine ? "" : " · edited"}` : "Custom";
    for (const b of $("presets").querySelectorAll(".preset")) b.setAttribute("aria-checked", String(b.dataset.id === cap.style.preset));

    const st = shownStyle();
    if (![...$("st-font").options].some((o) => o.value === st.font)) $("st-font").append(new Option(st.font, st.font));
    $("st-font").value = st.font;
    const textCase = st.uppercase ? "up" : st.textCase ?? "as";
    for (const r of document.querySelectorAll("input[name=st-case]")) r.checked = r.value === textCase;
    $("st-punct").checked = st.punctuation === "remove";
    $("st-censor").checked = !!st.censor;
    // Shown as a percent of the text size, the same scale as tracking/100 in Premiere or CapCut.
    const spacing = Math.round(st.spacing * 200) / 2;
    $("st-spacing").value = spacing;
    $("st-spacing-v").textContent = `${spacing > 0 ? "+" : ""}${spacing}`;
    $("st-size").value = Math.round(st.size * 1000);
    $("st-size-v").textContent = `${(st.size * 100).toFixed(1)}%`;
    $("st-fill").value = st.fill;
    $("st-highlight").value = st.highlight;
    $("st-highlight-label").textContent = HIGHLIGHT_LABELS[st.wordStyle] ?? "Spoken word";
    $("st-word").value = st.wordStyle;
    // Outline fills to the text colour itself, so the accent colour and word-pop don't apply.
    $("st-highlight-row").hidden = st.wordStyle === "outline";
    $("st-fill-opacity-row").hidden = st.wordStyle !== "outline";
    $("st-fill-opacity").value = Math.round((st.fillOpacity ?? 1) * 100);
    $("st-pop").checked = st.wordPop;
    $("st-pop").disabled = st.wordStyle === "karaoke" || st.wordStyle === "outline";
    const g = st.gradientColors ?? [];
    $("st-gradient").value = st.gradient;
    $("st-gradient-row").hidden = $("st-g-mid-row").hidden = st.gradient === "none";
    $("st-g0").value = g[0] ?? st.fill;
    $("st-g1").value = g.length > 2 ? g[1] : g[0] ?? st.fill;
    $("st-g1").hidden = g.length < 3;
    $("st-g2").value = g[g.length - 1] ?? st.highlight;
    $("st-g-mid").checked = g.length > 2;
    $("st-invert").checked = st.invert;
    // Inverted text takes its colours from the video, so the colour controls have nothing to do.
    $("st-fill").disabled = st.gradient !== "none" || st.invert;
    $("st-highlight").disabled = $("st-gradient").disabled = st.invert;
    // In tenths of a percent of the text size, so a hairline outline is within reach.
    $("st-outline").value = Math.round(st.outline * 1000);
    $("st-outline-color").value = st.outlineColor;
    $("st-outline-opacity-row").hidden = !(st.outline > 0);
    $("st-outline-opacity").value = Math.round((st.outlineOpacity ?? 1) * 100);
    $("st-shadow").value = Math.round(st.shadow * 100);
    $("st-shadow-color").value = st.shadowColor;
    $("st-box").checked = st.box;
    $("st-box-row").hidden = !st.box;
    $("st-box-opacity").value = Math.round(st.boxOpacity * 100);
    $("st-box-color").value = st.boxColor;
    if (document.activeElement !== $("st-x")) $("st-x").value = Math.round(st.x * 100);
    if (document.activeElement !== $("st-y")) $("st-y").value = Math.round(st.y * 100);

    renderAnimation(st);
    renderChips(line);
    placeBox();
  }

  function renderChips(line) {
    const chips = $("word-chips");
    chips.replaceChildren();
    if (scope !== "one" || !line) return;
    const words = store.doc.captions.words;
    for (let i = line.from; i < line.to; i++) {
      const w = words[i];
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.setAttribute("aria-pressed", String(selectedWord === w.id));
      chip.innerHTML = w.color ? `<span class="dot" style="background:${w.color}"></span>` : "";
      chip.append(w.text);
      chip.addEventListener("click", () => { selectedWord = selectedWord === w.id ? null : w.id; renderChips(line); });
      chips.append(chip);
    }
  }

  /* ---------- controls ---------- */

  for (const r of document.querySelectorAll("input[name=scope]")) {
    r.addEventListener("change", () => { scope = r.value; selectedWord = null; render(); });
  }
  $("st-font").addEventListener("change", () => set("font", $("st-font").value));
  for (const r of document.querySelectorAll("input[name=st-case]")) {
    r.addEventListener("change", () => {
      set("uppercase", r.value === "up", "style-case");
      if (r.value !== "up") set("textCase", r.value, "style-case");
    });
  }
  $("st-punct").addEventListener("change", () => set("punctuation", $("st-punct").checked ? "remove" : "keep"));
  $("st-censor").addEventListener("change", () => set("censor", $("st-censor").checked));
  editableValue($("st-size-v"), $("st-size"), { toRange: (v) => v * 10 });
  editableValue($("st-spacing-v"), $("st-spacing"));
  $("st-spacing").addEventListener("input", () => set("spacing", Number($("st-spacing").value) / 100));
  $("st-spacing").addEventListener("dblclick", () => set("spacing", 0));
  $("st-gradient").addEventListener("change", () => set("gradient", $("st-gradient").value));
  $("st-invert").addEventListener("change", () => set("invert", $("st-invert").checked));
  /** The gradient's colours as the pickers show them, with the middle one only when it's on. */
  const gradientColors = () => $("st-g-mid").checked
    ? [$("st-g0").value, $("st-g1").value, $("st-g2").value]
    : [$("st-g0").value, $("st-g2").value];
  for (const id of ["st-g0", "st-g1", "st-g2"]) $(id).addEventListener("input", () => set("gradientColors", gradientColors(), "style-gradientColors"));
  $("st-g-mid").addEventListener("change", () => {
    if ($("st-g-mid").checked) $("st-g1").value = mixHex($("st-g0").value, $("st-g2").value);
    set("gradientColors", gradientColors());
  });
  $("st-size").addEventListener("input", () => set("size", Number($("st-size").value) / 1000));
  $("st-fill").addEventListener("input", () => set("fill", $("st-fill").value));
  $("st-highlight").addEventListener("input", () => set("highlight", $("st-highlight").value));
  $("st-fill-opacity").addEventListener("input", () => set("fillOpacity", Number($("st-fill-opacity").value) / 100));
  $("st-word").addEventListener("change", () => set("wordStyle", $("st-word").value));
  $("st-pop").addEventListener("change", () => set("wordPop", $("st-pop").checked));
  $("st-outline").addEventListener("input", () => set("outline", Number($("st-outline").value) / 1000));
  $("st-outline-color").addEventListener("input", () => set("outlineColor", $("st-outline-color").value));
  $("st-outline-opacity").addEventListener("input", () => set("outlineOpacity", Number($("st-outline-opacity").value) / 100));
  $("st-shadow").addEventListener("input", () => set("shadow", Number($("st-shadow").value) / 100));
  $("st-shadow-color").addEventListener("input", () => set("shadowColor", $("st-shadow-color").value));
  $("st-box").addEventListener("change", () => set("box", $("st-box").checked));
  $("st-box-opacity").addEventListener("input", () => set("boxOpacity", Number($("st-box-opacity").value) / 100));
  $("st-box-color").addEventListener("input", () => set("boxColor", $("st-box-color").value));
  for (const [id, key] of [["st-x", "x"], ["st-y", "y"]]) {
    $(id).addEventListener("change", () => {
      const v = Number($(id).value);
      if (Number.isFinite(v)) set(key, Math.min(100, Math.max(0, v)) / 100);
      else render();
    });
  }
  $("st-center").addEventListener("click", () => set("x", 0.5));
  $("safe-zones").addEventListener("change", drawSafeZones);

  for (const b of $("emphasis-swatches").querySelectorAll("[data-emph]")) {
    b.addEventListener("click", () => {
      if (selectedWord == null) return toast("Pick a word first.");
      const color = b.dataset.emph || null;
      store.update((d) => {
        const w = d.captions.words.find((x) => x.id === selectedWord);
        if (w) { if (color) w.color = color; else delete w.color; }
      });
    });
  }
  $("reset-one").addEventListener("click", () => {
    store.update((d) => {
      for (const line of selectedLines(d)) {
        const group = d.captions.words[line.from].group;
        if (group != null) delete d.captions.overrides?.[group];
        for (let i = line.from; i < line.to; i++) delete d.captions.words[i].color;
      }
    });
  });

  /* ---------- animation: drawn from the chosen plugin's own list of settings ---------- */

  const DIRECTIONS = [["none", "×", "No movement"], ["up", "↑", "Up"], ["down", "↓", "Down"], ["left", "←", "Left"], ["right", "→", "Right"]];
  /** The plugin the controls were built for; they're rebuilt only when it changes. */
  let animBuiltFor = null;
  let pluginsVersion = 0;
  let pluginsShown = -1;
  const fieldEls = new Map();
  let previewTimer = null;
  onPluginsChanged(() => { pluginsVersion++; animBuiltFor = null; if (store.doc) render(); });

  /** Changes one setting of the shown captions' animation, leaving the rest as they are. */
  function setParam(key, value, coalesce) {
    set("motion", (m) => {
      const plugin = getPlugin(m?.plugin);
      if (!plugin) return m;
      return { plugin: plugin.id, preset: null, params: { ...pluginParams(plugin, m.params), [key]: value } };
    }, coalesce ?? `motion-${key}`);
  }

  function renderPluginChoice(m) {
    const select = $("anim-plugin");
    if (pluginsShown !== pluginsVersion || (m?.plugin && ![...select.options].some((o) => o.value === m.plugin))) {
      pluginsShown = pluginsVersion;
      select.replaceChildren(new Option("None", ""));
      for (const p of listPlugins()) select.append(new Option(p.builtIn ? p.name : `${p.name} · plugin`, p.id));
      if (m?.plugin && !getPlugin(m.plugin)) select.append(new Option(`${m.plugin} (not installed)`, m.plugin));
    }
    select.value = m?.plugin ?? "";
  }

  /** Plays a preset on its tile, sampled from the plugin itself, so any plugin's presets preview. */
  function playSample(el, plugin, params) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fps = 30;
    const d = plugin.durations(params) ?? {};
    const nIn = Math.max(0, Math.round(d.in || 0));
    const nOut = Math.max(0, Math.round(d.out || 0));
    const hold = 20;
    const base = { size: 16, box: { w: 34, h: 16 }, frame: { w: 160, h: 90 }, fps, seed: 1, holdDuration: hold / fps, lineDuration: (nIn + hold + nOut) / fps };
    const frames = [];
    for (let i = 0; i <= nIn; i++) frames.push(plugin.frame(params, { ...base, phase: nIn ? "in" : "hold", progress: nIn ? i / nIn : 0, holdTime: 0 }));
    for (let i = 1; i < hold; i++) frames.push(plugin.frame(params, { ...base, phase: "hold", progress: 0, holdTime: i / fps }));
    for (let i = 1; i <= nOut; i++) frames.push(plugin.frame(params, { ...base, phase: "out", progress: i / nOut, holdTime: hold / fps }));
    const keyframes = frames.map((tf = {}) => ({
      transform: `translate(${tf.x ?? 0}px, ${tf.y ?? 0}px) rotate(${tf.rotate ?? 0}deg) rotateX(${tf.rotateX ?? 0}deg) scale(${tf.scale ?? 1})`,
      opacity: Math.max(0, Math.min(1, tf.opacity ?? 1)),
      filter: `blur(${Math.max(0, (tf.blur ?? 0) * 0.4)}px)`,
      letterSpacing: `${(tf.tracking ?? 0) * 0.5}em`,
    }));
    for (const a of el.getAnimations()) a.cancel();
    if (keyframes.length > 1) el.animate(keyframes, { duration: (keyframes.length / fps) * 1000, easing: "linear" });
  }

  function buildField(plugin, field) {
    const row = document.createElement("div");
    row.className = `fx-row fx-type-${field.type}`;
    const id = `fx-${plugin.id}-${field.key}`;
    const label = document.createElement(field.type === "direction" ? "span" : "label");
    label.className = "fx-label";
    label.textContent = field.label;
    if (field.type !== "direction") label.htmlFor = id;
    let update;
    if (field.type === "direction") {
      const group = document.createElement("div");
      group.className = "fx-dirs";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", field.label);
      const buttons = DIRECTIONS.map(([value, glyph, name]) => {
        const b = document.createElement("button");
        b.className = "fx-dir";
        b.dataset.value = value;
        b.textContent = glyph;
        b.title = name;
        b.setAttribute("aria-label", name);
        b.addEventListener("click", () => setParam(field.key, value));
        return b;
      });
      group.append(...buttons);
      row.append(label, group);
      update = (v) => { for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.value === v)); };
    } else if (field.type === "select") {
      const select = document.createElement("select");
      select.id = id;
      for (const o of field.options) select.append(new Option(o.label, o.value));
      select.addEventListener("change", () => setParam(field.key, select.value));
      row.append(label, select);
      update = (v) => { select.value = v; };
    } else if (field.type === "toggle") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = id;
      box.addEventListener("change", () => setParam(field.key, box.checked));
      const sw = document.createElement("span");
      sw.className = "fx-toggle";
      sw.append(box);
      row.append(label, sw);
      update = (v) => { box.checked = !!v; };
    } else {
      const range = document.createElement("input");
      range.type = "range";
      range.id = id;
      Object.assign(range, { min: field.min, max: field.max, step: field.step });
      const num = document.createElement("input");
      num.type = "text";
      num.inputMode = "decimal";
      num.className = "input fx-num";
      num.setAttribute("aria-label", field.label);
      const fmt = (v) => Number(v).toFixed(field.decimals ?? 2);
      const clamp = (v) => Math.min(field.max, Math.max(field.min, v));
      range.addEventListener("input", () => setParam(field.key, Number(range.value)));
      range.addEventListener("dblclick", () => setParam(field.key, plugin.defaults[field.key]));
      num.addEventListener("change", () => {
        const v = Number(num.value);
        if (Number.isFinite(v)) setParam(field.key, clamp(v));
        else render();
      });
      // Drag sideways on the number to scrub it, as in Resolve's inspector; a click types instead.
      num.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || document.activeElement === num) return;
        ev.preventDefault();
        const x0 = ev.clientX;
        const v0 = Number(range.value);
        const key = `scrub-${field.key}-${performance.now()}`;
        let moved = false;
        try { num.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
        const move = (e) => {
          const dx = e.clientX - x0;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          const steps = Math.round(dx / 3) * (e.shiftKey ? 10 : 1);
          setParam(field.key, clamp(v0 + steps * Number(field.step)), key);
        };
        const up = () => {
          num.removeEventListener("pointermove", move);
          if (!moved) { num.focus(); num.select(); }
        };
        num.addEventListener("pointermove", move);
        num.addEventListener("pointerup", up, { once: true });
        num.addEventListener("pointercancel", up, { once: true });
      });
      // Up and Down step the number too (ten steps with Shift).
      num.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
        ev.preventDefault();
        const step = Number(field.step) * (ev.shiftKey ? 10 : 1);
        setParam(field.key, clamp(Number(range.value) + (ev.key === "ArrowUp" ? step : -step)));
      });
      row.append(label, range, num);
      update = (v) => {
        range.value = v;
        if (document.activeElement !== num) num.value = fmt(v);
      };
    }
    // The diamond resets a setting to the plugin's default, and lights up while it differs.
    const reset = document.createElement("button");
    reset.className = "fx-reset";
    reset.title = "Reset to default";
    reset.setAttribute("aria-label", `Reset ${field.label} to default`);
    reset.addEventListener("click", () => setParam(field.key, plugin.defaults[field.key]));
    row.append(reset);
    fieldEls.set(field.key, { field, row, update, reset });
    return row;
  }

  function buildAnimation(plugin) {
    const sections = $("anim-sections");
    const presets = $("anim-presets");
    sections.replaceChildren();
    presets.replaceChildren();
    fieldEls.clear();
    if (!plugin) return;
    for (const p of plugin.presets) {
      const b = document.createElement("button");
      b.className = "fx-preset";
      b.dataset.id = p.id;
      b.setAttribute("role", "radio");
      b.title = `${p.name}. Click to use, or drag onto captions on the timeline.`;
      const sample = document.createElement("span");
      sample.className = "fx-sample";
      sample.setAttribute("aria-hidden", "true");
      sample.textContent = "Aa";
      const name = document.createElement("span");
      name.className = "fx-name";
      name.textContent = p.name;
      b.append(sample, name);
      b.addEventListener("pointerenter", () => playSample(sample, plugin, pluginParams(plugin, p.params)));
      b.addEventListener("focus", () => playSample(sample, plugin, pluginParams(plugin, p.params)));
      makeDraggable(b, {
        timeline,
        label: `${p.name} animation`,
        onClick: () => set("motion", animation(p.id, plugin.id)),
        onDrop: (ids) => applyTo(ids, { motion: animation(p.id, plugin.id) }, `“${p.name}”`),
      });
      presets.append(b);
    }
    for (const section of plugin.sections) {
      const details = document.createElement("details");
      details.className = "fx-section";
      details.open = !!section.open;
      const summary = document.createElement("summary");
      summary.textContent = section.title;
      const body = document.createElement("div");
      body.className = "fx-body";
      for (const field of section.fields) body.append(buildField(plugin, field));
      details.append(summary, body);
      sections.append(details);
    }
  }

  function renderAnimation(st) {
    const m = st.motion ?? null;
    const plugin = m?.plugin ? getPlugin(m.plugin) : null;
    renderPluginChoice(m);
    const key = plugin ? plugin.id : m?.plugin ? `missing:${m.plugin}` : "none";
    if (animBuiltFor !== key) { buildAnimation(plugin); animBuiltFor = key; }
    $("anim-missing").hidden = !(m?.plugin && !plugin);
    $("anim-preview").disabled = !plugin || !store.doc.captions.words.length;
    $("anim-desc").textContent = plugin?.description ?? (m?.plugin ? "" : "Captions appear and disappear on the cut.");
    if (!plugin) { $("anim-state").textContent = m?.plugin ? "Missing" : "None"; return; }
    const params = pluginParams(plugin, m.params);
    for (const { field, row, update, reset } of fieldEls.values()) {
      update(params[field.key]);
      row.hidden = field.show ? !field.show(params) : false;
      reset.classList.toggle("changed", JSON.stringify(params[field.key]) !== JSON.stringify(plugin.defaults[field.key]));
    }
    for (const b of $("anim-presets").querySelectorAll(".fx-preset")) b.setAttribute("aria-checked", String(b.dataset.id === m.preset));
    $("anim-state").textContent = m.preset ? (plugin.presets.find((p) => p.id === m.preset)?.name ?? "") : "Custom";
  }

  $("anim-plugin").addEventListener("change", () => {
    const id = $("anim-plugin").value;
    set("motion", id ? animation(null, id) : null);
  });

  $("anim-plugins-folder").addEventListener("click", () => api.post("/plugins/open").catch((e) => toast(e.message)));

  // Plays the caption the animation is shown for, from just before it starts to just after it ends.
  $("anim-preview").addEventListener("click", () => {
    const cap = store.doc?.captions;
    if (!cap?.words.length) return;
    const lines = groupLines(cap.words, cap.perLine);
    const line = selectedLines()[0] ?? referenceLine();
    const k = line ? lines.findIndex((l) => l.from === line.from) : -1;
    if (k < 0) return;
    const { start, end } = lineTimes(cap.words, lines, k);
    clearTimeout(previewTimer);
    video.currentTime = Math.max(0, start - 0.25);
    video.play();
    previewTimer = setTimeout(() => video.pause(), (Math.min(6, end - start) + 0.5) * 1000);
  });

  /* ---------- saving the current style as a preset ---------- */

  $("preset-save").addEventListener("click", () => {
    const style = store.doc?.captions?.style;
    const base = PRESETS.find((p) => p.id === style?.preset);
    $("preset-name").value = base ? `My ${base.name}` : "";
    $("preset-dialog").showModal();
  });
  $("preset-save-btn").addEventListener("click", () => {
    const name = $("preset-name").value.trim() || "My preset";
    const id = `custom-${Date.now().toString(36)}`;
    store.update((d) => {
      const cap = d.captions;
      cap.user_presets ??= [];
      cap.user_presets.push({ id, name, perLine: cap.perLine, style: { ...cap.style, preset: id } });
      // The captions now use the new preset, so it shows as chosen rather than "Apple · edited".
      cap.style.preset = id;
    });
    $("preset-dialog").close();
    toast(`Saved “${name}” as a preset of its own.`);
  });

  /* ---------- caption box on the player ---------- */

  const box = $("caption-box");
  const screen = $("screen");

  /** The caption showing at the playhead, or the longest one, sizes the box. */
  function referenceLine() {
    const cap = store.doc.captions;
    const lines = groupLines(cap.words, cap.perLine);
    if (scope === "one") return selectedLines()[0] ?? null;
    const t = video.currentTime;
    const k = lines.findIndex((_, i) => { const r = lineTimes(cap.words, lines, i); return t >= r.start && t < r.end; });
    if (k >= 0) return lines[k];
    return lines.reduce((a, l) => (!a || l.to - l.from > a.to - a.from ? l : a), null);
  }

  // Fonts loaded into the page so the box can be sized to the real text.
  const pageFonts = new Map();
  const measure = document.createElement("canvas").getContext("2d");

  function pageFont(family) {
    if (!pageFonts.has(family)) {
      const url = fontUrl(family);
      const face = url ? new FontFace(`halo-${family}`, `url(${url})`) : null;
      pageFonts.set(family, face?.load().then((f) => { document.fonts.add(f); placeBox(); return true; }).catch(() => false));
    }
    return pageFonts.get(family);
  }

  /**
   * Width of a caption line in screen pixels. libass sizes text so the font's ascent plus descent
   * equals the font size, while CSS sizes the em square, so measure in CSS and convert.
   */
  function textWidth(text, st, fontPx) {
    measure.font = `100px "halo-${st.font}", sans-serif`;
    const m = measure.measureText(text);
    const height = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || 120;
    const scale = fontPx / height;
    const spacing = st.spacing * fontPx * text.length;
    return m.width * scale + spacing + st.outline * fontPx * 2;
  }

  function placeBox() {
    const doc = store.doc;
    const visible = doc && !$("inspector").hidden && doc.captions.words.length > 0;
    box.hidden = !visible;
    if (!visible) return;
    const st = shownStyle();
    const cap = doc.captions;
    const line = referenceLine();
    const text = line ? cap.words.slice(line.from, line.to).map((w) => displayText(w.text, st)).join(" ") : displayText("Caption", st);
    const cw = screen.clientWidth;
    const ch = screen.clientHeight;
    const fontPx = st.size * Math.min(cw, ch);
    pageFont(st.font);
    const pad = fontPx * 0.25;
    const w = Math.min(cap.style.width * cw, textWidth(text, st, fontPx)) + pad * 2;
    const h = fontPx * 1.15 + pad;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.left = `${st.x * cw - w / 2}px`;
    box.style.top = `${st.y * ch - h + pad / 2}px`;
    box.querySelector(".caption-box-label").textContent = scope === "one" ? "Drag to move this caption" : "Drag to move all captions";
  }

  new ResizeObserver(placeBox).observe(screen);
  video.addEventListener("seeked", placeBox);
  video.addEventListener("timeupdate", () => { if (!video.paused) placeBox(); });

  box.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try { box.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    const resizing = ev.target === $("caption-box-handle");
    const st = shownStyle();
    const start = { x: ev.clientX, y: ev.clientY, sx: st.x, sy: st.y, size: st.size, h: box.clientHeight };
    const cw = screen.clientWidth;
    const ch = screen.clientHeight;
    const key = `box-${performance.now()}`;
    box.classList.add("dragging");
    const move = (e) => {
      if (resizing) {
        const k = Math.max(0.2, (start.h + (e.clientY - start.y)) / start.h);
        set("size", Math.min(0.25, Math.max(0.02, start.size * k)), key);
        return;
      }
      let x = start.sx + (e.clientX - start.x) / cw;
      const y = Math.min(0.99, Math.max(0.05, start.sy + (e.clientY - start.y) / ch));
      const snapped = Math.abs(x - 0.5) < 0.015;
      if (snapped) x = 0.5;
      $("center-guide").hidden = !snapped;
      store.update((d) => {
        const cap = d.captions;
        const write = (k2, v) => {
          if (scope === "one") {
            for (const line of selectedLines(d)) {
              const group = lockLine(cap, line);
              cap.overrides ??= {};
              cap.overrides[group] = { ...(cap.overrides[group] ?? {}), [k2]: v };
            }
          } else cap.style[k2] = v;
        };
        write("x", Math.min(0.95, Math.max(0.05, x)));
        write("y", y);
      }, { coalesce: key });
    };
    const up = () => {
      box.classList.remove("dragging");
      $("center-guide").hidden = true;
      box.removeEventListener("pointermove", move);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up, { once: true });
    box.addEventListener("pointercancel", up, { once: true });
  });

  function drawSafeZones() {
    const layer = $("safe-zone-layer");
    const zones = SAFE_ZONES[$("safe-zones").value];
    layer.replaceChildren();
    layer.hidden = !zones || $("inspector").hidden;
    if (!zones) return;
    for (const [x0, y0, x1, y1] of zones) {
      const d = document.createElement("div");
      Object.assign(d.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
      layer.append(d);
    }
  }

  return {
    loadFonts,
    fontUrl,
    render,
    /** Shows or hides the panel along with the Captions tab. */
    setVisible(on) {
      $("inspector").hidden = !on;
      document.getElementById("editor").classList.toggle("with-inspector", on);
      drawSafeZones();
      render();
    },
    placeBox,
  };
}
