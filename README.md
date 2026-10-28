# Halo

Local video background effects and captions, as a desktop app. A Rust backend runs
[Robust Video Matting](https://github.com/PeterL1n/RobustVideoMatting) through ONNX Runtime on your
GPU (DirectML), transcribes speech with ffmpeg's built-in whisper.cpp (Vulkan), and uses ffmpeg for
decoding, blurring, caption burn-in and encoding (NVENC when available). Nothing leaves your machine.

## Use

Install with `target/release/bundle/nsis/Halo_<version>_x64-setup.exe` and open **Halo** from the
Start menu. ffmpeg ships with the app (about 100 MB bigger in the installer, but no PATH setup), and
the speech model downloads on first use into `%APPDATA%\com.mazon.halo\models`.

Open a video (Ctrl+O, or drop it on the window). Halo reads it in place and keeps a project per
video in `%APPDATA%\com.mazon.halo\projects`, autosaved, so reopening a file brings its edits back.
Recent videos are listed on the start screen. Everything is undoable (Ctrl+Z / Ctrl+Shift+Z); press ?
for all shortcuts.

**Background tab:** None, Blur, Remove or Color. Pause anywhere to see the effect on that frame,
rendered with the exact model and blur the export uses; hold C to compare with the original.

**Captions tab:** the first time, Halo downloads the Whisper large-v3-turbo model (574 MB) into
`%APPDATA%\com.mazon.halo\models`. Generate captions to get word-timed lines. Edit text in place
(Enter moves to the next line), delete lines, and pick how many words each caption shows; lines you
edit keep exactly what you typed. Captions play live over the video.

**Clean up:** remove filler words in one pass ("um", "uh", "like" and friends) — Halo finds them all,
you review the list through the captions, and one undo takes the whole cleanup back out. Find and
replace (Ctrl+H) fixes a name Whisper misheard everywhere at once, with the match count before you
replace. Import an SRT file (YouTube, Premiere, anywhere) and it comes in styled like a transcription.

**Timeline:** caption, video and audio tracks with a ruler and playhead. Drag captions to move them,
drag their edges to trim, split at the playhead (Ctrl+K), merge (M), add (A or double-click a gap),
delete, nudge a frame at a time (Alt+arrows), box-select, and retime individual words by zooming in
on a selected caption. Snapping (S) catches the playhead and neighbouring captions.

**Caption style (Captions tab, right panel):** eight presets (Pop, Loud, Clean, Karaoke, Box,
One word, Subtitle, Glow), plus any you save from your own edits ("Save current as…" puts the edited
style next to the built-ins). Then font (bundled or any installed), size, case, spacing, colours, how the
spoken word stands out, entrance animation, outline, shadow and background box. Drag the caption box
on the video to place captions, or its corner to resize; safe-zone guides show roughly where TikTok,
Reels and Shorts put their buttons. Switch to "Selected caption" to give one caption its own
position, size and colours, and to colour individual words.

**Export (Ctrl+E):** pick the file name and folder (Windows' Save As dialog), format (H.264 or H.265
MP4, ProRes MOV, WebM), resolution and quality, whether to burn in captions, and whether to save an
.srt alongside. Transparent backgrounds export as ProRes 4444 or WebM with alpha. Exports run in the
background with progress in the top bar, can be cancelled, and are written under a temporary name
so a failed or cancelled export never replaces an existing file. Audio is kept.

The engine's local API requires a per-launch token that only Halo's window receives.

## Build

Needs Rust and Node (for the Tauri CLI). The matting model goes in `models/rvm_mobilenetv3_fp32.onnx`
(from the RVM v1.0.0 release).

```bash
cargo build --release                    # DirectML.dll is copied next to the exe, which the bundle needs
npx @tauri-apps/cli@2 build              # installer in target/release/bundle/nsis
```

## Release

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

`web/vendor/jassub` is [jassub](https://github.com/ThaUnknown/jassub) 2.5.23, bundled with esbuild into
standalone files. `web/fonts` holds Poppins and Anton (SIL Open Font License). The ffmpeg binaries
Halo ships with (`ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe`, the gyan.dev full build) are bundled by
the installer, so nothing has to be on PATH.

## How it works

**Captions** are kept as a list of timed words. The page groups them into lines and writes one ASS
subtitle file, which libass renders both in the page (jassub, WebAssembly) and in ffmpeg at export, so
the live preview matches the output. In Remove mode the captions are also rendered over black and
white to recover their alpha, so text stays visible over the transparent background.

**Exports** run as three overlapping stages: ffmpeg decoding, GPU inference, and compositing plus
encoding. The matting model runs at up to 1920px on the long side and its matte is scaled back up. The
background blur is computed at quarter resolution. Pixel work is spread across all CPU cores.
