// The colour picker every colour well opens: a saturation and brightness square with a hue strip,
// as in Photoshop, Premiere and Resolve, plus a hex field, an eyedropper for picking from the screen,
// a row of common caption colours, and colours you've saved, kept across videos.
//
// The wells stay ordinary <input type="color"> elements. The picker sets their value and fires
// `input` as you drag and `change` when you're done, so the code listening to them doesn't change.

const $ = (id) => document.getElementById(id);

const PRESETS = ["#ffffff", "#000000", "#ffd43b", "#ff922b", "#ff6b6b", "#f06595", "#cc5de8", "#5c7cfa", "#22b8cf", "#51cf66"];
const MAX_SAVED = 30;

/* ---------- colour maths ---------- */

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToRgb({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}

/** Text that reads on top of a colour: black on light ones, white on dark. */
function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex) ?? [0, 0, 0];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#000" : "#fff";
}

/* ---------- the picker ---------- */

/**
 * Makes every colour well under `root` open the picker. `getPrefs` and `savePrefs` hold the saved
 * colours (`prefs.savedColors`).
 */
export function createColorPicker({ root = document, getPrefs, savePrefs }) {
  const pop = document.createElement("div");
  pop.className = "color-pop";
  pop.id = "color-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose a colour");
  pop.innerHTML = `
    <div class="cp-sv" id="cp-sv" tabindex="0" role="slider" aria-label="Saturation and brightness"><div class="cp-sv-knob" id="cp-sv-knob"></div></div>
    <div class="cp-hue" id="cp-hue" tabindex="0" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><div class="cp-hue-knob" id="cp-hue-knob"></div></div>
    <div class="cp-row">
      <div class="cp-compare" title="Before and after"><span id="cp-old"></span><span id="cp-new"></span></div>
      <input class="cp-hex" id="cp-hex" spellcheck="false" maxlength="7" aria-label="Hex colour">
      <button class="btn ghost icon-only" id="cp-drop" title="Pick a colour from anywhere on screen" aria-label="Pick a colour from the screen"><svg class="icon"><use href="#i-pipette"/></svg></button>
    </div>
    <div class="cp-title">Presets</div>
    <div class="cp-swatches" id="cp-presets"></div>
    <div class="cp-title"><span>Saved</span><button class="link-btn" id="cp-save" title="Save this colour to use again in any video">+ Save colour</button></div>
    <div class="cp-swatches" id="cp-saved"></div>
    <p class="cp-empty" id="cp-saved-empty">Colours you save show here, in every video. Right-click one to remove it.</p>`;
  document.body.append(pop);

  const sv = $("cp-sv");
  const hue = $("cp-hue");
  const hexField = $("cp-hex");
  let well = null; // the <input type="color"> being edited
  let original = "#ffffff";
  let hsv = { h: 0, s: 0, v: 1 };

  const current = () => rgbToHex(hsvToRgb(hsv));

  function paint() {
    const hex = current();
    sv.style.setProperty("--hue", `hsl(${hsv.h} 100% 50%)`);
    $("cp-sv-knob").style.left = `${hsv.s * 100}%`;
    $("cp-sv-knob").style.top = `${(1 - hsv.v) * 100}%`;
    $("cp-sv-knob").style.background = hex;
    $("cp-hue-knob").style.left = `${(hsv.h / 360) * 100}%`;
    $("cp-new").style.background = hex;
    sv.setAttribute("aria-valuetext", `saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    hue.setAttribute("aria-valuenow", String(Math.round(hsv.h)));
    if (document.activeElement !== hexField) hexField.value = hex;
    for (const b of pop.querySelectorAll(".cp-swatch")) b.setAttribute("aria-pressed", String(b.dataset.color === hex));
  }

  /** Puts the colour in the well, as the native picker does while you drag. */
  function apply() {
    if (!well) return;
    const hex = current();
    paint();
    if (well.value === hex) return;
    well.value = hex;
    well.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setHex(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return false;
    const next = rgbToHsv(rgb);
    // Greys and black have no hue of their own; keep the strip where it was.
    if (next.s === 0 || next.v === 0) next.h = hsv.h;
    if (next.v === 0) next.s = hsv.s;
    hsv = next;
    apply();
    return true;
  }

  function renderSwatches() {
    const swatch = (hex, saved) => {
      const b = document.createElement("button");
      b.className = "cp-swatch";
      b.dataset.color = hex;
      b.style.background = hex;
      b.style.color = inkFor(hex);
      b.title = saved ? `${hex} · right-click to remove` : hex;
      b.setAttribute("aria-label", saved ? `Saved colour ${hex}` : `Preset ${hex}`);
      b.addEventListener("click", () => setHex(hex));
      if (saved) {
        const remove = (ev) => {
          ev.preventDefault();
          const prefs = getPrefs();
          prefs.savedColors = (prefs.savedColors ?? []).filter((c) => c !== hex);
          savePrefs();
          renderSwatches();
          // The swatch that had focus is gone; keep the keyboard in the picker.
          sv.focus({ preventScroll: true });
        };
        b.addEventListener("contextmenu", remove);
        b.addEventListener("keydown", (ev) => { if (ev.key === "Delete" || ev.key === "Backspace") remove(ev); });
      }
      return b;
    };
    $("cp-presets").replaceChildren(...PRESETS.map((c) => swatch(c, false)));
    const saved = getPrefs().savedColors ?? [];
    $("cp-saved").replaceChildren(...saved.map((c) => swatch(c, true)));
    $("cp-saved-empty").hidden = saved.length > 0;
    paint();
  }

  $("cp-save").addEventListener("click", () => {
    const hex = current();
    const prefs = getPrefs();
    prefs.savedColors = [hex, ...(prefs.savedColors ?? []).filter((c) => c !== hex)].slice(0, MAX_SAVED);
    savePrefs();
    renderSwatches();
  });

  /** Dragging inside the square or along the strip, and the arrow keys on either. */
  function drag(el, onPoint) {
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      el.focus();
      try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      const at = (e) => {
        const r = el.getBoundingClientRect();
        onPoint(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        apply();
      };
      at(ev);
      el.addEventListener("pointermove", at);
      el.addEventListener("pointerup", () => el.removeEventListener("pointermove", at), { once: true });
    });
  }
  drag(sv, (x, y) => { hsv = { ...hsv, s: x, v: 1 - y }; });
  drag(hue, (x) => { hsv = { ...hsv, h: Math.min(359.9, x * 360) }; });

  sv.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 0.1 : 0.01;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[ev.key];
    if (!m) return;
    ev.preventDefault();
    hsv = { ...hsv, s: Math.min(1, Math.max(0, hsv.s + m[0])), v: Math.min(1, Math.max(0, hsv.v + m[1])) };
    apply();
  });
  hue.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 10 : 1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[ev.key];
    if (d == null) return;
    ev.preventDefault();
    hsv = { ...hsv, h: (hsv.h + d + 360) % 360 };
    apply();
  });

  hexField.addEventListener("input", () => {
    const v = hexField.value.trim();
    if (/^#?([0-9a-f]{6})$/i.test(v)) setHex(v.startsWith("#") ? v : `#${v}`);
  });
  hexField.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); if (setHex(hexField.value.startsWith("#") ? hexField.value : `#${hexField.value}`)) close(true); }
  });
  hexField.addEventListener("blur", () => { hexField.value = current(); });

  const dropper = $("cp-drop");
  dropper.hidden = !("EyeDropper" in window);
  dropper.addEventListener("click", async () => {
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      setHex(sRGBHex);
    } catch { /* cancelled */ }
  });

  function place() {
    const r = well.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;
  }

  function open(input) {
    if (well === input) return close(true);
    if (well) close(true);
    well = input;
    original = input.value;
    hsv = rgbToHsv(hexToRgb(original) ?? [255, 255, 255]);
    $("cp-old").style.background = original;
    pop.hidden = false;
    well.classList.add("picking");
    renderSwatches();
    place();
    sv.focus({ preventScroll: true });
  }

  /** Closes the picker, keeping the colour, or with `keep` false putting the old one back. */
  function close(keep = true) {
    if (!well) return;
    const input = well;
    if (!keep && input.value !== original) {
      input.value = original;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    well = null;
    pop.hidden = true;
    input.classList.remove("picking");
    if (input.value !== original) input.dispatchEvent(new Event("change", { bubbles: true }));
    if (pop.contains(document.activeElement) || document.activeElement === document.body) input.focus({ preventScroll: true });
  }

  pop.addEventListener("keydown", (ev) => {
    // The editor's shortcuts don't fire while picking.
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); close(false); }
    if (ev.key === "Enter" && ev.target !== hexField && !ev.target.closest("button")) { ev.preventDefault(); close(true); }
  });
  document.addEventListener("pointerdown", (ev) => {
    if (well && !pop.contains(ev.target) && ev.target !== well) close(true);
  }, true);
  window.addEventListener("resize", () => { if (well) place(); });
  document.addEventListener("scroll", (ev) => { if (well && !pop.contains(ev.target)) place(); }, true);

  // The wells: a click or Enter opens this picker instead of the system's.
  root.addEventListener("click", (ev) => {
    const input = ev.target.closest?.("input[type=color]");
    if (!input || input.disabled) return;
    ev.preventDefault();
    open(input);
  });
  root.addEventListener("keydown", (ev) => {
    const input = ev.target.closest?.("input[type=color]");
    if (!input || input.disabled || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    ev.stopPropagation();
    open(input);
  }, true);

  return { open, close, get isOpen() { return !!well; } };
}
