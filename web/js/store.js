// The open project: one document per video, with undo/redo and autosave.

import { api } from "./api.js";
import { presetStyle } from "./styles.js";

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1200;
const SAVE_DELAY_MS = 700;

export function newDocument(media) {
  return {
    version: 1,
    name: media.name,
    video_path: media.path,
    updated: Date.now(),
    background: { mode: "none", model: "standard", blur: 20, color: "#00b140" },
    captions: { language: "auto", perLine: 3, words: [], edits: 0, style: presetStyle("pop"), overrides: {} },
    grade: { sections: [], nextId: 1 },
  };
}

export class Store extends EventTarget {
  doc = null;
  projectId = null;
  #undo = [];
  #redo = [];
  #lastKey = null;
  #lastAt = 0;
  #saveTimer = null;

  load(projectId, doc) {
    this.projectId = projectId;
    this.doc = doc;
    this.#undo = [];
    this.#redo = [];
    this.#lastKey = null;
    this.#emit();
  }

  close() {
    this.flush();
    this.doc = null;
    this.projectId = null;
  }

  /**
   * Changes the document. Changes sharing a `coalesce` key within a moment of each other (a slider
   * being dragged, typing) become one undo step.
   */
  update(mutate, { coalesce = null } = {}) {
    if (!this.doc) return;
    const before = JSON.stringify(this.doc);
    mutate(this.doc);
    if (JSON.stringify(this.doc) === before) return;
    const now = performance.now();
    const merge = coalesce && coalesce === this.#lastKey && now - this.#lastAt < COALESCE_MS;
    if (!merge) {
      this.#undo.push(before);
      if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
    }
    this.#lastKey = coalesce;
    this.#lastAt = now;
    this.#redo = [];
    this.#changed();
  }

  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }

  undo() { this.#step(this.#undo, this.#redo); }
  redo() { this.#step(this.#redo, this.#undo); }

  #step(from, to) {
    if (!this.doc || from.length === 0) return;
    to.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(from.pop());
    this.#lastKey = null;
    this.#changed();
  }

  #changed() {
    this.#emit();
    this.saveSoon();
  }

  /** Schedules a save without recording an undo step. */
  saveSoon() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.#status("pending");
  }

  /** Saves now if anything is waiting to be saved. */
  async flush() {
    if (this.#saveTimer === null || !this.doc) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const id = this.projectId;
    this.doc.updated = Date.now();
    this.#status("saving");
    try {
      await api.put(`/projects/${id}`, this.doc);
      if (id === this.projectId) this.#status("saved");
    } catch (err) {
      this.#status("error", err.message);
    }
  }

  #emit() { this.dispatchEvent(new Event("change")); }
  #status(state, error) { this.dispatchEvent(new CustomEvent("save", { detail: { state, error } })); }
}
