// Video scopes, drawn live from the current frame so a grade can be judged the way colourists do
// in Premiere, Resolve and After Effects. Four readouts — a luma waveform, an RGB parade, a
// vectorscope and an RGB histogram — are all sampled from the same small copy of the frame, run
// through the current grade, then traced. Everything is client-side and throttled to ~10 fps.

import { gradeColor } from "./grade.js";

const W = 160;           // the frame is sampled at this width
const THROTTLE_MS = 100; // playback updates, ~10 fps

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function createScopes({ frame }) {
  const src = document.createElement("canvas");
  const sctx = src.getContext("2d", { willReadFrequently: true });

  const views = {};
  for (const id of ["scope-wave", "scope-parade", "scope-vector", "scope-hist"]) {
    const canvas = document.getElementById(id);
    views[id] = { canvas, ctx: canvas.getContext("2d") };
  }

  let visible = false;
  let look = null;
  let source = "rec709";
  let lut = null;
  let pending = false;
  let lastAt = 0;

  function setVisible(v) {
    visible = v;
    if (v) analyze();
  }

  /** Grades the scope readout: `look` is the section's look, `lut` its resolved LUT (or null). */
  function setGrade(nextLook, nextLut, nextSource = "rec709") {
    if (nextLook === look && nextLut === lut && nextSource === source) return;
    look = nextLook;
    source = nextSource;
    lut = nextLut;
    requestAnalyze();
  }

  function refresh() {
    requestAnalyze();
  }

  function requestAnalyze() {
    if (pending || !visible) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      analyze();
    });
  }

  (function loop(now) {
    requestAnimationFrame(loop);
    if (!visible || now - lastAt < THROTTLE_MS) return;
    lastAt = now;
    analyze();
  })(0);

  /* ---------- sampling ---------- */

  function analyze() {
    const el = frame();
    const w = el?.videoWidth || el?.naturalWidth;
    const h = el?.videoHeight || el?.naturalHeight;
    if (!w || !h) return;
    const sh = Math.max(1, Math.round((W * h) / w));
    if (src.width !== W || src.height !== sh) {
      src.width = W;
      src.height = sh;
    }
    sctx.drawImage(el, 0, 0, W, sh);
    const data = sctx.getImageData(0, 0, W, sh).data;

    // Grade the sample the way the player does, so the scopes read the graded picture.
    const graded = new Float32Array(W * sh * 3);
    const apply = look ? (r, g, b) => gradeColor([r, g, b], look, lut, source) : null;
    for (let i = 0, k = 0; i < data.length; i += 4, k += 3) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (apply) {
        const out = apply(r / 255, g / 255, b / 255);
        r = out[0] * 255;
        g = out[1] * 255;
        b = out[2] * 255;
      }
      graded[k] = r;
      graded[k + 1] = g;
      graded[k + 2] = b;
    }

    drawWave(graded, W, sh);
    drawParade(graded, W, sh);
    drawVector(graded, W, sh);
    drawHist(graded, W, sh);
  }

  /* ---------- waveform ---------- */

  function drawWave(rgb, w, h) {
    const cols = 160;
    const rows = 96;
    const acc = new Float32Array(cols * rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 3;
        const v = luma(rgb[k], rgb[k + 1], rgb[k + 2]) / 255;
        const px = Math.min(cols - 1, Math.round((x + 0.5) * cols / w));
        const py = Math.min(rows - 1, Math.round((1 - v) * (rows - 1)));
        acc[py * cols + px] += 1;
      }
    }
    renderTrace(views["scope-wave"], acc, cols, rows, () => [232, 240, 248], ireGrid);
  }

  function drawParade(rgb, w, h) {
    const cols = 160;
    const rows = 96;
    const pane = 52;
    const gap = 2;
    const starts = [0, pane + gap, (pane + gap) * 2];
    const tints = [[255, 116, 116], [116, 255, 148], [116, 170, 255]];
    const acc = new Float32Array(cols * rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 3;
        const px = Math.min(pane - 1, Math.round((x + 0.5) * pane / w));
        for (let c = 0; c < 3; c++) {
          const py = Math.min(rows - 1, Math.round((1 - rgb[k + c] / 255) * (rows - 1)));
          acc[py * cols + starts[c] + px] += 1;
        }
      }
    }
    renderTrace(views["scope-parade"], acc, cols, rows, (i) => tints[i % cols < 54 ? 0 : i % cols < 108 ? 1 : 2], paradeGrid);
  }

  /* ---------- vectorscope ---------- */

  function drawVector(rgb, w, h) {
    const size = 128;
    const cx = size / 2;
    const cy = size / 2;
    const scale = size * 0.9; // U, V span roughly ±0.5

    const accR = new Float32Array(size * size);
    const accG = new Float32Array(size * size);
    const accB = new Float32Array(size * size);
    const accN = new Float32Array(size * size);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 3;
        const r = rgb[k] / 255;
        const g = rgb[k + 1] / 255;
        const b = rgb[k + 2] / 255;
        const Y = luma(r, g, b);
        const U = (b - Y) / 1.8556;
        const V = (r - Y) / 1.5748;
        const px = Math.round(cx - U * scale);
        const py = Math.round(cy - V * scale);
        if (px < 0 || px >= size || py < 0 || py >= size) continue;
        const i = py * size + px;
        accR[i] += r;
        accG[i] += g;
        accB[i] += b;
        accN[i] += 1;
      }
    }

    const { canvas, ctx } = views["scope-vector"];
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const img = ctx.createImageData(size, size);
    let mx = 1;
    for (let i = 0; i < accN.length; i++) if (accN[i] > mx) mx = accN[i];
    const k = 1 / Math.sqrt(mx);
    for (let i = 0, p = 0; i < accN.length; i++, p += 4) {
      const n = accN[i];
      if (!n) continue;
      img.data[p] = Math.min(255, (accR[i] / n) * 255 * 1.35);
      img.data[p + 1] = Math.min(255, (accG[i] / n) * 255 * 1.35);
      img.data[p + 2] = Math.min(255, (accB[i] / n) * 255 * 1.35);
      img.data[p + 3] = Math.min(255, Math.sqrt(n) * k * 255);
    }
    ctx.putImageData(img, 0, 0);
    vectorGrid(ctx, size);
  }

  function vectorGrid(ctx, size) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const pt = (deg) => {
      const a = (deg * Math.PI) / 180;
      return [cx + Math.cos(a) * r * 0.82, cy - Math.sin(a) * r * 0.82];
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    for (const [deg, color] of [
      [90, [255, 84, 84]],     // red, top
      [45, [255, 255, 84]],    // yellow
      [315, [88, 255, 88]],    // green
      [270, [84, 255, 255]],   // cyan
      [225, [88, 88, 255]],    // blue
      [135, [255, 88, 255]],   // magenta
    ]) {
      const [x, y] = pt(deg);
      ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }
    // Skin-tone line, just right of red.
    const [sx, sy] = pt(70);
    ctx.strokeStyle = "rgba(255,214,170,0.35)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  /* ---------- histogram ---------- */

  function drawHist(rgb, w, h) {
    const bins = 256;
    const rows = 96;
    const hist = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
    for (let i = 0; i < rgb.length; i += 3) {
      for (let c = 0; c < 3; c++) hist[c][Math.min(bins - 1, Math.floor(rgb[i + c]))]++;
    }
    const { canvas, ctx } = views["scope-hist"];
    if (canvas.width !== bins || canvas.height !== rows) {
      canvas.width = bins;
      canvas.height = rows;
    }
    ctx.clearRect(0, 0, bins, rows);
    const colors = ["255,90,90", "90,255,140", "90,150,255"];
    for (let c = 0; c < 3; c++) {
      let mx = 1;
      for (let i = 0; i < bins; i++) if (hist[c][i] > mx) mx = hist[c][i];
      ctx.fillStyle = `rgba(${colors[c]},0.5)`;
      ctx.beginPath();
      ctx.moveTo(0, rows);
      for (let x = 0; x < bins; x++) {
        ctx.lineTo(x, rows - Math.sqrt(hist[c][x] / mx) * rows);
      }
      ctx.lineTo(bins - 1, rows);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, rows - 1);
    ctx.lineTo(bins, rows - 1);
    ctx.stroke();
  }

  /* ---------- shared trace rendering ---------- */

  /** `colorAt(i)` returns the trace colour for accumulation cell i; `grid` draws the graticule. */
  function renderTrace(view, acc, cols, rows, colorAt, grid) {
    const { canvas, ctx } = view;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    const img = ctx.createImageData(cols, rows);
    let mx = 1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > mx) mx = acc[i];
    const k = 1 / Math.sqrt(mx);
    for (let i = 0, p = 0; i < acc.length; i++, p += 4) {
      const c = colorAt(i);
      img.data[p] = c[0];
      img.data[p + 1] = c[1];
      img.data[p + 2] = c[2];
      img.data[p + 3] = Math.min(255, Math.sqrt(acc[i]) * k * 230);
    }
    ctx.putImageData(img, 0, 0);
    grid(ctx, cols, rows);
  }

  function ireGrid(ctx, cols, rows) {
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of [0, 25, 50, 75, 100]) {
      const y = rows - 1 - (p / 100) * (rows - 1);
      ctx.moveTo(0, y);
      ctx.lineTo(cols, y);
    }
    ctx.stroke();
  }

  function paradeGrid(ctx, cols, rows) {
    ireGrid(ctx, cols, rows);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("R", 27, rows - 3);
    ctx.fillText("G", 81, rows - 3);
    ctx.fillText("B", 135, rows - 3);
  }

  return { setVisible, setGrade, refresh, analyze, get visible() { return visible; } };
}
