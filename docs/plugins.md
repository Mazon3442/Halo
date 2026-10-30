# Writing a Halo plugin

Halo's caption animations come from plugins. **Easy Motion** is built in (`web/js/plugins/easy-motion.js`),
and you can add your own. A plugin describes its settings, and Halo draws the controls for them in the
Animation panel. The plugin then says where a caption is on any frame. Halo turns those frames into
libass events, so the live preview and the export animate the same way.

## Where plugins go

Put `.js` files in Halo's plugins folder. The **Plugins folder** button in the Animation panel opens it:

| System | Plugins folder |
| --- | --- |
| Windows | `%APPDATA%\com.mazon.halo\plugins` |
| macOS | `~/Library/Application Support/com.mazon.halo/plugins` |
| Linux | `~/.local/share/com.mazon.halo/plugins` (or `$XDG_DATA_HOME/com.mazon.halo/plugins`) |

Halo loads every plugin there when it starts. A plugin that fails to load is reported and skipped,
and Halo starts anyway.

A file name may contain letters, digits, `-`, `_` and `.`, and must end in `.js`. A plugin is a single
file: it can't `import` other files. It gets the helpers it needs from the toolkit (see below).

## The shape of a plugin

A plugin is an ES module. Its default export is the plugin object, or a function that takes the toolkit
and returns one:

```js
export default ({ easings, lerp }) => ({
  id: "spin-in",                 // unique, lowercase letters, digits and dashes
  name: "Spin In",
  kind: "caption-animation",
  description: "Spins each caption into place.",
  defaults: { turns: 1, duration: 12 },
  sections: [
    { id: "spin", title: "Spin", open: true, fields: [
      { key: "turns", label: "Turns", type: "slider", min: -3, max: 3, step: 0.25, decimals: 2 },
      { key: "duration", label: "Duration (frames)", type: "slider", min: 1, max: 40, step: 1, decimals: 0 },
    ] },
  ],
  presets: [
    { id: "one", name: "One turn", params: { turns: 1 } },
    { id: "half", name: "Half turn", params: { turns: 0.5, duration: 8 } },
  ],
  durationKeys: { in: "duration" },
  durations: (p) => ({ in: p.duration, out: 0 }),
  frame(p, ctx) {
    if (ctx.phase !== "in") return {};
    const e = easings.backOut(ctx.progress);
    return { rotate: lerp(360 * p.turns, 0, e), scale: lerp(0.3, 1, e), opacity: Math.min(1, ctx.progress * 2) };
  },
});
```

### Fields

Each field in a section becomes one row in the panel. The diamond at the end of a row resets that field
to its default.

| `type` | Control | Extra keys |
| --- | --- | --- |
| `direction` | The five buttons: none, up, down, left, right. The value is `"none"`, `"up"`, `"down"`, `"left"` or `"right"`. | |
| `select` | A drop-down. | `options: [{ value, label }]` |
| `slider` | A slider and a number box. Drag the number box sideways to scrub it. | `min`, `max`, `step`, `decimals` |
| `toggle` | A checkbox. | |

Any field can have `show: (params) => boolean` to hide it when it doesn't apply.

### Timing

- `durations(params)` returns `{ in, out }` in frames. When a caption is shorter than both together,
  Halo shortens them in proportion.
- `durationKeys` (optional) names the settings that hold those lengths. With it, the handles on a
  selected caption's top corners on the timeline drag them.
- `animatesHold(params)` (optional) returns true when the caption also moves between its in and out.
  Halo then bakes the hold frame by frame, so leave it false when nothing moves there.
- `motionBlur(params)` (optional) returns `{ strength: 0 to 1, shutter: degrees, samples }` or null.
  Halo adds the blur and the trailing copies from how far the caption moves on each frame.

### `frame(params, ctx)`

This is called for each frame that's baked. `params` are the caption's settings, with your defaults
filled in. `ctx` holds:

| Key | Meaning |
| --- | --- |
| `phase` | `"in"`, `"hold"` or `"out"` |
| `progress` | 0 to 1 through the in or out (0 in the hold) |
| `holdTime`, `holdDuration` | Seconds into the hold, and its length. `holdTime` is held at 0 during the in, and at the hold's end during the out. |
| `lineDuration` | The caption's length in seconds |
| `size` | The text height in pixels |
| `box` | `{ w, h }`, the caption's rough size in pixels |
| `frame` | `{ w, h }`, the video's size in pixels |
| `fps`, `seed` | The frame rate, and a number per caption for repeatable randomness |

It returns a transform. Every key is optional, and anything left out stays at rest:

| Key | Meaning |
| --- | --- |
| `x`, `y` | Offset in pixels (y grows downward) |
| `scale`, `scaleX`, `scaleY` | Size, where 1 is at rest. Scaling is around the caption's centre. |
| `rotate` | Degrees clockwise, around the centre |
| `rotateX`, `rotateY` | 3D tilt in degrees |
| `skew` | Horizontal shear (libass `\fax`) |
| `opacity` | 0 to 1 |
| `blur` | Pixels |
| `tracking` | Extra letter spacing, as a fraction of the text size |
| `mask` | `"top"`, `"bottom"`, `"left"` or `"right"`: hides everything past that edge of the resting caption, for reveals |

### The toolkit

The toolkit is the argument your default export receives when it's a function.

- `easings`: `linear`, `sineIn/Out/InOut`, `cubicIn/Out/InOut`, `expoIn/Out`, `backIn/Out`,
  `elasticIn/Out`, `bounceIn/Out`, each mapping 0–1 to 0–1. Back and elastic overshoot.
- `lerp(a, b, t)` and `clamp01(t)`
- `noise(seed, step)`: repeatable noise from −1 to 1
- `directions`: unit vectors for the direction buttons, such as `directions.up` → `[0, -1]`

## How captions use a plugin

A style's `motion` is `{ plugin, preset, params }`. It's saved in the project, for every caption or for
captions given their own style. When a project uses a plugin that isn't installed, those captions don't
animate, and the panel says so. Reinstall the plugin and they animate again.
