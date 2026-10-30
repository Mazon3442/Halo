// Easy Motion: Halo's built-in caption animation, laid out the way motion plugins in Resolve and
// Premiere are. A base animation in and out (a direction, a style, how far and how many frames),
// extras that ride along with it (scale, rotation, 3D tilt, blur, tracking, fade), an effect that
// plays while the caption holds on screen, motion blur, and the option to run it letter by letter.
//
// Every value is a function of where the caption is in its life, so the same numbers give the same
// frame in the live preview and in the export.

export default function easyMotion(halo) {
  const { easings: E, clamp01, lerp, noise, directions } = halo;

  const STYLES = [
    { value: "slide", label: "Slide" },
    { value: "mask", label: "Mask" },
    { value: "whip", label: "Whip" },
    { value: "glide", label: "Glide" },
    { value: "spring", label: "Spring" },
    { value: "bounce", label: "Bounce" },
  ];
  /** How each style accelerates in (arriving) and out (leaving). */
  const STYLE_EASE = {
    slide: ["cubicOut", "cubicIn"],
    mask: ["expoOut", "expoIn"],
    whip: ["expoOut", "expoIn"],
    glide: ["sineInOut", "sineInOut"],
    spring: ["backOut", "backIn"],
    bounce: ["bounceOut", "backIn"],
  };
  const EASES = [
    { value: "auto", label: "From style" },
    { value: "linear", label: "Linear" },
    { value: "smooth", label: "Smooth" },
    { value: "snappy", label: "Snappy" },
    { value: "gentle", label: "Gentle" },
    { value: "overshoot", label: "Overshoot" },
    { value: "elastic", label: "Elastic" },
    { value: "bounce", label: "Bounce" },
  ];
  const NAMED_EASE = {
    linear: ["linear", "linear"],
    smooth: ["cubicOut", "cubicIn"],
    snappy: ["expoOut", "expoIn"],
    gentle: ["sineInOut", "sineInOut"],
    overshoot: ["backOut", "backIn"],
    elastic: ["elasticOut", "elasticIn"],
    bounce: ["bounceOut", "bounceIn"],
  };
  const EFFECTS = [
    { value: "none", label: "None" },
    { value: "float", label: "Float" },
    { value: "drift", label: "Drift (slow zoom)" },
    { value: "pulse", label: "Pulse" },
    { value: "swing", label: "Swing" },
    { value: "shake", label: "Shake" },
    { value: "wiggle", label: "Wiggle" },
  ];

  /** The base and extra controls, identical for in and out apart from their prefix. */
  const base = (p) => [
    { key: `${p}Direction`, label: "Direction", type: "direction" },
    { key: `${p}Style`, label: "Style", type: "select", options: STYLES },
    { key: `${p}Distance`, label: "Distance", type: "slider", min: 0, max: 0.5, step: 0.005, decimals: 3, show: (v) => v[`${p}Direction`] !== "none" && v[`${p}Style`] !== "mask" },
    { key: `${p}Duration`, label: "Duration (frames)", type: "slider", min: 0, max: 60, step: 1, decimals: 0 },
  ];
  const extra = (p) => [
    { key: `${p}Ease`, label: "Ease", type: "select", options: EASES },
    { key: `${p}Fade`, label: "Fade", type: "toggle" },
    { key: `${p}Scale`, label: p === "in" ? "Scale from (%)" : "Scale to (%)", type: "slider", min: 0, max: 300, step: 1, decimals: 0 },
    { key: `${p}Rotation`, label: "Rotation (°)", type: "slider", min: -180, max: 180, step: 1, decimals: 0 },
    { key: `${p}Tilt`, label: "3D tilt (°)", type: "slider", min: -90, max: 90, step: 1, decimals: 0 },
    { key: `${p}Blur`, label: "Blur", type: "slider", min: 0, max: 100, step: 1, decimals: 0 },
    { key: `${p}Tracking`, label: "Tracking", type: "slider", min: -0.5, max: 1.5, step: 0.01, decimals: 2 },
  ];

  const defaults = {
    inDirection: "up", inStyle: "slide", inDistance: 0.05, inDuration: 8,
    inEase: "auto", inFade: true, inScale: 100, inRotation: 0, inTilt: 0, inBlur: 0, inTracking: 0,
    outDirection: "none", outStyle: "slide", outDistance: 0.05, outDuration: 0,
    outEase: "auto", outFade: true, outScale: 100, outRotation: 0, outTilt: 0, outBlur: 0, outTracking: 0,
    effect: "none", effectAmount: 40, effectSpeed: 1,
    mbEnabled: false, mbStrength: 60, mbSamples: 3, mbShutter: 180,
    letters: false, letterGap: 1,
  };

  /** One preset is a handful of settings over the defaults. */
  const preset = (id, name, params) => ({ id, name, params: { ...defaults, ...params } });
  const still = { inDuration: 0, outDuration: 0 };
  const presets = [
    preset("none", "None", { ...still, inDirection: "none" }),
    preset("pop", "Pop", { inDirection: "none", inFade: false, inScale: 80, inDuration: 4 }),
    preset("bounce", "Bounce", { inDirection: "none", inStyle: "spring", inFade: false, inScale: 55, inDuration: 7 }),
    preset("slide-up", "Slide up", { inDirection: "up", inDistance: 0.05, inDuration: 5 }),
    preset("fade", "Fade", { inDirection: "none", inDuration: 4, outDuration: 4 }),
    preset("spring-up", "Spring up", { inDirection: "up", inStyle: "spring", inDistance: 0.03, inScale: 40, inDuration: 8 }),
    preset("letter-rise", "Rise by letter", { inDirection: "up", inDistance: 0.05, inDuration: 12, letters: true, letterGap: 1.2 }),
    preset("rise", "Rise and fall", { inDirection: "up", inDistance: 0.05, inDuration: 8, outDirection: "down", outDistance: 0.05, outDuration: 6 }),
    preset("mask-up", "Mask up", { inDirection: "up", inStyle: "mask", inFade: false, inDuration: 9, outDirection: "up", outStyle: "mask", outFade: false, outDuration: 7 }),
    preset("drop", "Drop in", { inDirection: "down", inStyle: "bounce", inDistance: 0.12, inFade: false, inDuration: 14 }),
    preset("whip", "Whip", { inDirection: "left", inStyle: "whip", inDistance: 0.35, inDuration: 7, outDirection: "left", outStyle: "whip", outDistance: 0.35, outDuration: 6, mbEnabled: true, mbStrength: 80 }),
    preset("zoom-blur", "Zoom blur", { inDirection: "none", inStyle: "whip", inScale: 170, inBlur: 60, inDuration: 8, outDirection: "none", outStyle: "whip", outScale: 60, outBlur: 40, outDuration: 6 }),
    preset("swing", "Swing in", { inDirection: "up", inStyle: "spring", inDistance: 0.02, inRotation: -14, inScale: 70, inDuration: 10 }),
    preset("flip", "Flip up", { inDirection: "none", inStyle: "spring", inTilt: 85, inDuration: 10, inFade: true }),
    preset("track", "Tracking in", { inDirection: "none", inStyle: "glide", inTracking: 0.6, inBlur: 30, inDuration: 14, outDuration: 5 }),
    preset("float", "Float", { inDirection: "up", inDistance: 0.03, inDuration: 8, effect: "float", effectAmount: 35, effectSpeed: 0.6 }),
    preset("drift", "Slow push", { inDirection: "none", inStyle: "glide", inDuration: 6, outDuration: 6, effect: "drift", effectAmount: 50 }),
    preset("shake", "Shake", { inDirection: "none", inFade: false, inScale: 120, inStyle: "whip", inDuration: 4, effect: "shake", effectAmount: 30, effectSpeed: 2 }),
  ];

  function curve(params, phase) {
    const name = params[`${phase}Ease`];
    const pair = name && name !== "auto" ? NAMED_EASE[name] : STYLE_EASE[params[`${phase}Style`]];
    return E[(pair ?? STYLE_EASE.slide)[phase === "in" ? 0 : 1]];
  }

  /** How far a caption travels: the set distance, or for Mask, just far enough to hide behind the edge. */
  function distance(params, phase, ctx) {
    const dir = params[`${phase}Direction`];
    if (params[`${phase}Style`] === "mask") {
      const across = dir === "left" || dir === "right";
      return (across ? ctx.box.w : ctx.box.h) * 1.08 + ctx.size * 0.12;
    }
    return params[`${phase}Distance`] * Math.min(ctx.frame.w, ctx.frame.h);
  }

  /** The hold effect at `t` seconds into the hold. */
  function effect(params, t, ctx) {
    const a = params.effectAmount / 100;
    const w = 2 * Math.PI * params.effectSpeed * t;
    const s = ctx.size;
    switch (params.effect) {
      case "float": return { y: -a * s * 0.18 * Math.sin(w) };
      case "drift": return { scale: 1 + a * 0.14 * clamp01(t / Math.max(0.01, ctx.holdDuration)) };
      case "pulse": return { scale: 1 + a * 0.09 * (0.5 - 0.5 * Math.cos(w)) };
      case "swing": return { rotate: a * 7 * Math.sin(w) };
      case "shake": {
        const step = Math.floor(t * params.effectSpeed * 14);
        return { x: a * s * 0.07 * noise(ctx.seed, step), y: a * s * 0.07 * noise(ctx.seed + 17, step) };
      }
      case "wiggle": {
        const step = Math.floor(t * params.effectSpeed * 6);
        const k = (t * params.effectSpeed * 6) % 1;
        return { rotate: a * 5 * lerp(noise(ctx.seed, step), noise(ctx.seed, step + 1), E.sineInOut(k)) };
      }
      default: return {};
    }
  }

  /** In or out: `amount` is how far from resting the caption is, 0 at rest and 1 at the far end. */
  function phaseTransform(params, phase, progress, ctx) {
    const ease = curve(params, phase);
    const amount = phase === "in" ? 1 - ease(progress) : ease(progress);
    const settled = clamp01(phase === "in" ? 1 - progress : progress);
    const [dx, dy] = directions[params[`${phase}Direction`]] ?? [0, 0];
    // Arriving comes from the far side of the direction; leaving heads toward it.
    const sign = phase === "in" ? -1 : 1;
    const d = distance(params, phase, ctx) * amount * sign;
    const scaleEnd = params[`${phase}Scale`] / 100;
    const tf = {
      x: dx * d,
      y: dy * d,
      scale: lerp(1, scaleEnd, amount),
      rotate: params[`${phase}Rotation`] * amount,
      rotateX: params[`${phase}Tilt`] * amount,
      blur: (params[`${phase}Blur`] / 100) * ctx.size * 0.35 * clamp01(Math.abs(amount)),
      tracking: params[`${phase}Tracking`] * amount,
      // Fades follow time rather than the curve, so springs don't flicker past fully opaque.
      opacity: params[`${phase}Fade`] ? 1 - E.cubicIn(settled) : 1,
    };
    if (params[`${phase}Style`] === "mask" && (dx || dy)) {
      // Hidden past the resting edge the caption slides out of (or into).
      const toward = phase === "in" ? [-dx, -dy] : [dx, dy];
      tf.mask = toward[1] > 0 ? "bottom" : toward[1] < 0 ? "top" : toward[0] < 0 ? "left" : "right";
    }
    return tf;
  }

  return {
    id: "easy-motion",
    name: "Easy Motion",
    version: "1.0.0",
    author: "Halo",
    kind: "caption-animation",
    description: "In and out animations with a direction and style, extras, a hold effect and motion blur.",
    defaults,
    presets,
    sections: [
      { id: "in", title: "In base animation", open: true, fields: base("in") },
      { id: "in-extra", title: "In extra", fields: extra("in") },
      { id: "out", title: "Out base animation", open: true, fields: base("out") },
      { id: "out-extra", title: "Out extra", fields: extra("out") },
      {
        id: "effects", title: "Effects", fields: [
          { key: "effect", label: "While on screen", type: "select", options: EFFECTS },
          { key: "effectAmount", label: "Amount", type: "slider", min: 0, max: 100, step: 1, decimals: 0, show: (v) => v.effect !== "none" },
          { key: "effectSpeed", label: "Speed", type: "slider", min: 0.1, max: 5, step: 0.1, decimals: 1, show: (v) => v.effect !== "none" && v.effect !== "drift" },
        ],
      },
      {
        id: "letters", title: "Letter by letter", fields: [
          { key: "letters", label: "Animate each letter", type: "toggle" },
          { key: "letterGap", label: "Offset (frames)", type: "slider", min: 0.2, max: 6, step: 0.1, decimals: 1, show: (v) => v.letters },
        ],
      },
      {
        id: "motion-blur", title: "Motion blur", fields: [
          { key: "mbEnabled", label: "Motion blur", type: "toggle" },
          { key: "mbStrength", label: "Strength", type: "slider", min: 0, max: 100, step: 1, decimals: 0, show: (v) => v.mbEnabled },
          { key: "mbShutter", label: "Shutter angle (°)", type: "slider", min: 45, max: 360, step: 15, decimals: 0, show: (v) => v.mbEnabled },
          { key: "mbSamples", label: "Trail samples", type: "slider", min: 0, max: 6, step: 1, decimals: 0, show: (v) => v.mbEnabled },
        ],
      },
    ],
    /** Which settings hold the in and out lengths, so the timeline's fade handles can drag them. */
    durationKeys: { in: "inDuration", out: "outDuration" },
    durations: (p) => ({ in: p.inDuration, out: p.outDuration }),
    animatesHold: (p) => p.effect !== "none" && p.effectAmount > 0,
    /** Letter by letter: how many frames each letter starts after the one before. */
    stagger: (p) => (p.letters ? p.letterGap : 0),
    motionBlur: (p) => (p.mbEnabled && p.mbStrength > 0 ? { strength: p.mbStrength / 100, shutter: p.mbShutter, samples: p.mbSamples } : null),
    /**
     * The caption's transform on one frame. ctx.phase is "in", "hold" or "out", ctx.progress runs
     * 0 to 1 through in and out, and ctx.holdTime is seconds into the hold (frozen during in and out).
     */
    frame(params, ctx) {
      const hold = params.effect !== "none" ? effect(params, ctx.holdTime, ctx) : {};
      const tf = ctx.phase === "hold" ? { scale: 1, opacity: 1 } : phaseTransform(params, ctx.phase, ctx.progress, ctx);
      return {
        ...tf,
        x: (tf.x ?? 0) + (hold.x ?? 0),
        y: (tf.y ?? 0) + (hold.y ?? 0),
        scale: (tf.scale ?? 1) * (hold.scale ?? 1),
        rotate: (tf.rotate ?? 0) + (hold.rotate ?? 0),
      };
    },
  };
}
