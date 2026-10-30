<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/banner-light.svg">
  <img alt="Halo: background blur, captions and color grading for your videos, on your own GPU" src="docs/assets/brand/banner-dark.svg" width="100%">
</picture>

**Blur or remove the background behind you, caption every word, and color grade the result.<br>A desktop video editor for Windows that runs on your own GPU. Nothing leaves your computer.**

[![Release](https://img.shields.io/github/v/release/Mazon3442/Halo?style=flat-square&color=7cc4ff&label=release)](https://github.com/Mazon3442/Halo/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-555?style=flat-square)](#install)
[![Built with Tauri 2 and Rust](https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Using Halo](#using-halo) · [How it works](#how-it-works) · [Build from source](#build-from-source) · [Privacy](#privacy)

<br>

<img src="docs/assets/screens/captions.png" alt="Halo's Captions tab: the transcript on the left, a word-by-word caption over the video, caption style presets on the right, and the timeline with caption, color, video and audio tracks" width="900">

</div>

## Features

| Feature | What it does |
| --- | --- |
| **Background blur and removal** | A matting model separates you from the room on every frame. Blur what's behind you, replace it with a solid color, or remove it and export with transparency. |
| **Word-timed captions** | Whisper transcribes the speech on your machine, and every word gets its own timing. Pick how many words show at once and how the spoken word stands out. |
<<<<<<< HEAD
| **20 caption styles** | Pop, Loud, Karaoke, Outline, Box, One word, Glow and more, each one a starting point for font, color, outline, shadow, box and entrance animation. Save your own next to them. |
=======
| **19 caption styles** | Pop, Loud, Karaoke, Box, One word, Glow and more, each one a starting point for font, color, outline, shadow, box and animation. Save your own next to them, and drag any of them onto single captions on the timeline. |
| **Easy Motion and plugins** | Caption animations come from plugins. The built-in Easy Motion gives each caption an in and an out (direction, style, distance, frames), extras (scale, rotation, 3D tilt, blur, tracking, fade), a hold effect (float, slow push, pulse, swing, shake) and motion blur, with 17 presets. Add your own plugins as .js files. |
>>>>>>> 8e5afa8b4b89c874f2a6ceb74b7b641c407701ce
| **Clean up in one pass** | Remove filler words ("um", "uh", "like") across the whole video, fix a misheard name everywhere with find and replace, or import an SRT you already have. |
| **Color grading** | Graded the way a colorist works: log footage (Apple Log, S-Log3, V-Log, LogC3, Canon Log 3, D-Log) converted first, then grading in log with real white balance, pivoted contrast, shadow/midtone/highlight color wheels that keep skin tones clean, and print film emulation (Kodak 2383 and 2393, Fuji 3513, Vision3, bleach bypass, black and white). 16 looks built from those, previewed on your own frame. Grade the whole video or just a stretch of it, add a .cube LUT or a Lightroom preset, and check the result on a waveform, RGB parade, vectorscope or histogram. |
| **A real timeline** | Stacked caption tracks, plus color, video and audio tracks with thumbnails, a waveform and snapping. Drag captions in time or between tracks, Alt-drag to copy, copy and paste, trim, split and merge, retime single words, lock and hide tracks, and draw color grades straight onto the track. |
| **Exports that match the preview** | MP4 (H.264 or H.265, on NVENC when there is one), ProRes or WebM, with captions burned in or saved alongside as SRT. Transparent backgrounds export as ProRes 4444 or WebM with alpha. |
| **Projects that keep themselves** | Every video gets an autosaved project, so reopening it brings your edits back. Everything is undoable. |
| **Updates itself** | Halo checks for a new release when it starts and offers to install it. |

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screens/blur.png" alt="Halo's Background tab with Blur on: the speaker stays sharp while the monitor and neon light behind are blurred"></td>
    <td width="50%"><img src="docs/assets/screens/color.png" alt="Halo's Color tab: a grid of looks with Golden hour selected, applied to the section of the video selected on the Color track"></td>
  </tr>
  <tr>
    <td align="center"><sub>Background blur</sub></td>
    <td align="center"><sub>Color looks, per section of the video</sub></td>
  </tr>
</table>

## Install

Download `Halo_<version>_x64-setup.exe` from the [latest release](https://github.com/Mazon3442/Halo/releases/latest) and run it. Halo is for Windows 10 and 11, and uses any GPU with DirectX 12 for the background model. ffmpeg comes with the app, so there's nothing else to install.

Installed copies update themselves: when a new release is out, Halo asks when it starts.

## Quick start

1. Open a video with **Ctrl+O**, or drop it on the window.
2. **Background:** pick **Blur** and pause anywhere to see it on that frame. Hold **C** to compare with the original.
3. **Captions:** press **Generate captions**. The first time, press **Download speech models** before that (about 670 MB, once).
4. **Color:** drag along the Color track to mark where a grade goes, then pick a look.
5. Press **Ctrl+E** to export.

Press **?** in the app for every shortcut.

## Using Halo

Halo reads your video in place and keeps a project per video in `%APPDATA%\com.mazon.halo\projects`, autosaved, so reopening a file brings its edits back. Recent videos are listed on the start screen. Everything is undoable (Ctrl+Z / Ctrl+Shift+Z).

**Background tab:** None, Blur, Remove or Color. Pause anywhere to see the effect on that frame,
rendered with the exact model and blur the export uses; hold C to compare with the original.

**Captions tab:** the first time, Halo downloads the speech models (Whisper large-v3-turbo, 574 MB, and a 95 MB word aligner) into
`%APPDATA%\com.mazon.halo\models`. Generate captions to get word-timed lines. Edit text in place
(Enter moves to the next line), delete lines, and pick how many words each caption shows; lines you
edit keep exactly what you typed. Captions play live over the video.

**Clean up:** remove filler words in one pass ("um", "uh", "like" and friends). Halo finds them all,
you review the list through the captions, and one undo takes the whole cleanup back out. Find and
replace (Ctrl+H) fixes a name Whisper misheard everywhere at once, with the match count before you
replace. Import an SRT file (YouTube, Premiere, anywhere) and it comes in styled like a transcription.

**Caption style (Captions tab, right panel):** 20 presets, plus any you save from your own edits
("Save current as…" puts the edited style next to the built-ins). Then font (bundled or any installed),
size, case, spacing, colors, how the spoken word stands out, entrance animation, outline, shadow and
background box. Drag the caption box on the video to place captions, or its corner to resize; safe-zone
guides show roughly where TikTok, Reels and Shorts put their buttons. Switch to "Selected" to give the
captions selected on the timeline a style and animation of their own, or drag a style or animation preset
straight onto captions on the timeline. Select a single caption to color individual words.

**Animation:** pick a preset (Pop, Slide up, Mask up, Whip, Zoom blur, Float and more), or open Easy
Motion's sections to set the in and out yourself: a direction, a style (Slide, Mask, Whip, Glide, Spring,
Bounce), distance and duration in frames, then extras, a hold effect and motion blur. Hover a preset to
see it move, and press Preview to play the caption. On the timeline, each caption shows its in and out
as shaded ramps; drag a selected caption's top corners to lengthen or shorten them. Animations are baked
a frame at a time into the subtitle file, so the export moves exactly as the preview does.

**Plugins:** animations are plugins, and Easy Motion is the built-in one. Drop more plugins (.js files)
in `%APPDATA%\com.mazon.halo\plugins` (the Plugins folder button opens it) and they show up in the
Animation menu next time Halo starts. [docs/plugins.md](docs/plugins.md) explains how to write one.

**Color tab:** first, say what the footage was shot in. Log footage (Apple Log on iPhone, Sony S-Log3,
Panasonic V-Log, ARRI LogC3, Canon Log 3, DJI D-Log) looks flat and grey. Halo converts it from the
camera's log curve and gamut across the whole video before any grading, as a color space transform does
in Resolve. Grades live on the Color track. Drag along an empty stretch of it to draw a grade of
that length, or double-click it (or press "Add a 5s grade at the playhead") for a five-second one;
drag a grade or its edges to move it, and split it at the playhead. Each grade takes a look, light and
color sliders, a print film emulation, three color wheels (shadows, midtones, highlights) with skin
protection, and optionally a LUT: import a .cube file from Premiere, Resolve, Final Cut or CapCut,
or a Lightroom preset (.xmp). Save a look you like to use it again. Scopes (Ctrl+Shift+S) show a
waveform, RGB parade, vectorscope and histogram of the graded frame.

**Timeline:** caption, color, video and audio tracks with a ruler and playhead. Caption tracks stack
like video tracks in Premiere or Resolve: C1 holds the transcript, and captions on C2 and up show at the
same time, drawn over it. Use them for a hook title over the subtitles, or for two speakers. Drag
captions to move them, and drag them up or down to change tracks; dropping on the "New track" strip makes
one. Alt-drag copies. Drag edges to trim, split at the playhead (Ctrl+K), merge (M), add (A, or
double-click a gap; when the playhead is over a caption, the new one stacks on the next track), delete,
nudge a frame at a time (Alt+arrows), box-select across tracks, and retime individual words by zooming
in on a selected caption. Cut, copy and paste with Ctrl+X/C/V (pasting at the playhead), Ctrl+D
duplicates onto the track above, and right-click a caption or track for more. Each track can be renamed,
hidden or locked. Snapping (S) catches the playhead and neighbouring captions, and scrubbing the ruler
stops on edit points. Up and Down jump between edit points; J, K and L shuttle.

**Export (Ctrl+E):** pick the file name and folder (Windows' Save As dialog), format (H.264 or H.265
MP4, ProRes MOV, WebM), resolution and quality, whether to burn in captions, and whether to save an
.srt alongside. Transparent backgrounds export as ProRes 4444 or WebM with alpha. "Captions only"
exports a styled caption overlay with transparency, or the text as SRT or WebVTT. Exports run in the
background with progress in the top bar, can be cancelled, and are written under a temporary name so
a failed or cancelled export never replaces an existing file. Audio is kept.

## How it works

A Rust backend runs [Robust Video Matting](https://github.com/PeterL1n/RobustVideoMatting) through
ONNX Runtime on your GPU (DirectML), transcribes speech with ffmpeg's built-in whisper.cpp (Vulkan),
and uses ffmpeg for decoding, blurring, caption burn-in and encoding (NVENC when available). The
window is a Tauri 2 webview talking to that backend over a local API, which requires a per-launch
token that only Halo's window receives.

**Captions** are kept as a list of timed words. The page groups them into lines and writes one ASS
subtitle file, which libass renders both in the page (jassub, WebAssembly) and in ffmpeg at export, so
the live preview matches the output. In Remove mode the captions are also rendered over black and
white to recover their alpha, so text stays visible over the transparent background.

**Color grades** follow a colorist's pipeline, baked into a 33×33×33 3D LUT: the input transform (log
curve and camera gamut to light), exposure and white balance as a Bradford chromatic adaptation,
then grading in the ACEScct log space (contrast around mid grey, tone, color wheels weighted by
brightness with skin tones keyed out), print film emulation (a density curve per channel, whose small
differences give film its color crossover), saturation on light, the HSL mixer, a filmic tone map
for log footage, and out-of-range colors pulled in along their own hue rather than clipped per
channel. Any imported LUT comes last. The preview applies it to the video with WebGL, and the export applies the same
LUT with ffmpeg's `lut3d`, so what you see is what you get.

**Exports** run as three overlapping stages: ffmpeg decoding, GPU inference, and compositing plus
encoding. The matting model runs at up to 1920px on the long side and its matte is scaled back up. The
background blur is computed at quarter resolution. Pixel work is spread across all CPU cores.

## Build from source

Needs Rust and Node (for the Tauri CLI). The matting model goes in `models/rvm_mobilenetv3_fp32.onnx`
(from the RVM v1.0.0 release), and `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` (the
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) full build) are bundled by the installer, so nothing
has to be on PATH.

```bash
cargo build --release                    # DirectML.dll is copied next to the exe, which the bundle needs
npx @tauri-apps/cli@2 build              # installer in target/release/bundle/nsis
```

`web/vendor/jassub` is [jassub](https://github.com/ThaUnknown/jassub) 2.5.23, bundled with esbuild into
standalone files. `web/fonts` holds the caption fonts, each under its own open license (the license
files sit next to them).

### Release

Push an annotated version tag and GitHub Actions (`.github/workflows/release.yml`) builds the installer,
signs it for in-app updates and publishes a release; the tag's message becomes the release notes. The
version comes from the tag, so there's nothing to bump.

```bash
git tag -a v0.3.0 -F notes.md
git push origin v0.3.0
```

Installed copies check the latest release's `latest.json` on launch and offer to update. Updates are
signed with the `TAURI_SIGNING_PRIVATE_KEY` repository secret, the private half of the `pubkey` in
`tauri.conf.json` (kept locally in `~/.tauri/halo-updater.key`). Tags with a hyphen (`v1.0.0-beta.1`)
become pre-releases, which installed copies don't update to.

## Privacy

Halo has no accounts and no telemetry. Your videos, captions and projects stay on your computer, and
all processing runs on it. Halo connects to the internet only to check GitHub for a new version when
it starts, and to download the speech models from Hugging Face the first time you generate captions.
Those services see the usual request details, such as your IP address.

## License

Halo's code is released under the [MIT License](LICENSE). The bundled ffmpeg, fonts and models keep
their own licenses.

<div align="center">
<br>
<img src="icons/source.svg" alt="" width="40">
</div>
