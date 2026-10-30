// The numbers beside sliders, made to work the way Resolve's and Premiere's do: drag one sideways to
// scrub it (Shift for fine steps), or click it to type an exact value. Either way the slider beside
// it changes and fires its own `input` event, so the panel's existing handler does the rest.

/**
 * Makes `value`, the readout for `range`, scrubbable and typeable. `toRange` turns a typed number
 * (in the units the readout shows) into the slider's own units.
 */
export function editableValue(value, range, { toRange = (v) => v } = {}) {
  value.classList.add("scrubbable");
  value.tabIndex = 0;
  value.title = "Drag sideways to change, or click to type a value";
  if (range.id) value.setAttribute("aria-controls", range.id);

  const commit = (v) => {
    const min = Number(range.min);
    const max = Number(range.max);
    const clamped = Math.min(max, Math.max(min, v));
    if (Number(range.value) === clamped) return;
    range.value = String(clamped);
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  };

  value.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || range.disabled) return;
    ev.preventDefault();
    try { value.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    const x0 = ev.clientX;
    const v0 = Number(range.value);
    const span = Number(range.max) - Number(range.min);
    const step = Number(range.step) || 1;
    let scrubbing = false;
    const move = (e) => {
      const dx = e.clientX - x0;
      if (!scrubbing && Math.abs(dx) < 3) return;
      if (!scrubbing) { scrubbing = true; document.body.classList.add("scrubbing"); }
      // The whole range over about 240px, a tenth of that with Shift.
      const raw = v0 + (dx / 240) * span * (e.shiftKey ? 0.1 : 1);
      commit(Math.round(raw / step) * step);
    };
    const up = () => {
      value.removeEventListener("pointermove", move);
      document.body.classList.remove("scrubbing");
      if (!scrubbing) type();
    };
    value.addEventListener("pointermove", move);
    value.addEventListener("pointerup", up, { once: true });
    value.addEventListener("pointercancel", up, { once: true });
  });
  value.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); type(); }
  });

  function type() {
    if (range.disabled) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "value-input";
    input.value = value.textContent.trim();
    input.setAttribute("aria-label", `${range.getAttribute("aria-label") ?? range.labels?.[0]?.textContent ?? "Value"}`);
    value.hidden = true;
    value.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const n = Number(input.value.replace(/[^\d.+\-]/g, ""));
      input.remove();
      value.hidden = false;
      if (save && input.value.trim() !== "" && Number.isFinite(n)) commit(toRange(n));
      value.focus();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
}
