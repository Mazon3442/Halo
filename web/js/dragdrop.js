// Dragging things from the panels onto captions on the timeline, the way effects and presets are
// dragged onto clips in Premiere or Resolve. Pointer events rather than HTML drag and drop, which
// the window's own file drop (for opening videos) takes over on Windows.

const THRESHOLD_PX = 5;

/**
 * Makes `el` draggable onto timeline captions. A plain click still calls `onClick`; a drag shows
 * `label` under the pointer, lights up the captions it would land on, and calls `onDrop(ids)` with
 * their first-word ids when let go over them.
 */
export function makeDraggable(el, { timeline, label, onDrop, onClick }) {
  let justDragged = false;
  el.addEventListener("click", (ev) => {
    if (justDragged) { justDragged = false; ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    onClick?.(ev);
  });
  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".preset-delete")) return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    let ghost = null;
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD_PX) return;
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = typeof label === "function" ? label() : label;
        document.body.append(ghost);
        document.body.classList.add("dragging-preset");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      const ids = timeline.dropHover(e.clientX, e.clientY);
      ghost.classList.toggle("over", !!ids?.length);
    };
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("dragging-preset");
      justDragged = true;
      // A click doesn't follow a drag that ends elsewhere, so don't leave the flag set.
      setTimeout(() => { justDragged = false; }, 0);
      const ids = e.type === "pointerup" ? timeline.dropHover(e.clientX, e.clientY) : null;
      timeline.dropHover(null);
      if (ids?.length) onDrop(ids);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}
