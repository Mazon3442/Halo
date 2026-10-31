//! Video processing: ffmpeg decodes frames, Robust Video Matting (ONNX, on the GPU through
//! DirectML on Windows and CoreML on macOS, on the CPU on Linux) predicts a per-pixel alpha
//! matte, we composite, and ffmpeg encodes the result.

use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc, OnceLock};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use ort::{ep, session::Session, value::{DynValue, Tensor, TensorRef}};
use rayon::prelude::*;
use serde::Serialize;

use crate::speech::filter_path;

/// Frames run before the previewed one so the recurrent model has settled, like it would mid-video.
const PREVIEW_WARMUP_SECS: f64 = 0.4;

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    /// Leave the background alone (e.g. captions only); the matting model doesn't run.
    None,
    /// Keep the person sharp, blur everything else.
    Blur,
    /// Transparent background (WebM with alpha).
    Remove,
    /// Replace the background with a solid color.
    Color,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Self::None),
            "blur" => Some(Self::Blur),
            "remove" => Some(Self::Remove),
            "color" => Some(Self::Color),
            _ => None,
        }
    }

    fn channels(self) -> usize {
        if self == Self::Remove { 4 } else { 3 }
    }

    fn pix_fmt(self) -> &'static str {
        if self == Self::Remove { "rgba" } else { "rgb24" }
    }
}

#[derive(Clone, Copy)]
pub struct Settings {
    pub mode: Mode,
    pub blur: f32,
    pub color: [u8; 3],
    /// Moves the matte's edge out (positive) or in (negative), -1 to 1, like After Effects' Shift Edge.
    pub edge: f32,
    /// How sharply the matte goes from background to subject, 0 (as the model gives it) to 1 (hard).
    pub hardness: f32,
    /// Darkens a blurred background, 0 to 1, so the subject stands out more.
    pub dim: f32,
}

impl Settings {
    /// The matte's ramp after shifting and hardening it: `alpha' = (alpha - low) / width`. With the
    /// edge and hardness at 0 it's the model's matte as it is.
    fn ramp(self) -> (f32, f32) {
        let width = 1.0 - 0.95 * self.hardness.clamp(0.0, 1.0);
        let centre = 0.5 - 0.4 * self.edge.clamp(-1.0, 1.0);
        (centre - width / 2.0, width)
    }
}

/// Output container and codec.
#[derive(Clone, Copy, PartialEq)]
pub enum Format {
    H264,
    H265,
    /// ProRes in a .mov: 4444 with alpha for transparent exports, 422 HQ otherwise.
    ProRes,
    /// VP9 WebM, with alpha for transparent exports.
    WebM,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "h264" => Some(Self::H264),
            "h265" => Some(Self::H265),
            "prores" => Some(Self::ProRes),
            "webm" => Some(Self::WebM),
            _ => None,
        }
    }

    pub fn supports_alpha(self) -> bool {
        matches!(self, Self::ProRes | Self::WebM)
    }

    fn muxer(self) -> &'static str {
        match self {
            Self::H264 | Self::H265 => "mp4",
            Self::ProRes => "mov",
            Self::WebM => "webm",
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Quality {
    High,
    Balanced,
    Small,
}

impl Quality {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "high" => Some(Self::High),
            "balanced" => Some(Self::Balanced),
            "small" => Some(Self::Small),
            _ => None,
        }
    }

    /// Picks the value for this quality from [high, balanced, small].
    fn pick(self, values: [&'static str; 3]) -> &'static str {
        values[self as usize]
    }
}

#[derive(Clone, Copy)]
pub struct ExportSettings {
    pub format: Format,
    pub quality: Quality,
    /// Scale down so the long side is at most this many pixels; None keeps the original size.
    pub max_side: Option<usize>,
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub state: &'static str,
    pub frames: u64,
    pub total: u64,
    pub fps: f32,
    pub error: Option<String>,
}

pub struct Job {
    pub input: PathBuf,
    /// Where the finished file goes. It's written next to it under a temporary name and only
    /// renamed into place once complete, so a failed or cancelled export never clobbers a file.
    pub output: PathBuf,
    /// ASS subtitles to burn in. Fonts are loaded from a `fonts` folder next to the file.
    pub captions: Option<PathBuf>,
    /// Letters, as ASS, through which the video shows with its brightness flipped. Burned after
    /// `captions`, which then holds only their outlines, shadows and boxes.
    pub caption_mask: Option<PathBuf>,
    /// SRT captions to save next to the video.
    pub srt: Option<String>,
    /// Colour grades, each a 3D LUT (.cube) applied from `start` to `end` seconds, under the captions.
    pub grades: Vec<Grade>,
    /// Render only the captions, on a transparent background, to lay over the video in another editor.
    pub captions_only: bool,
    /// Export only this stretch, as (start, end) seconds; None for the whole video. Captions and
    /// grades arrive already shifted to start at 0.
    pub range: Option<(f64, f64)>,
    pub settings: Settings,
    pub export: ExportSettings,
    pub status: Arc<Mutex<Status>>,
    pub cancel: Arc<AtomicBool>,
}

pub struct Grade {
    pub lut: PathBuf,
    pub start: f64,
    pub end: f64,
}

impl Job {
    /// Where the export starts in the original (None from the beginning) and how long it runs.
    fn span(&self, info: &VideoInfo) -> (Option<f64>, f64) {
        match self.range {
            Some((start, end)) => {
                let start = start.clamp(0.0, info.duration.max(0.0));
                (Some(start), (end.min(info.duration) - start).max(0.05))
            }
            None => (None, info.duration),
        }
    }

    fn partial_path(&self) -> PathBuf {
        let mut name = self.output.file_name().unwrap_or_default().to_os_string();
        name.push(".halo-partial");
        self.output.with_file_name(name)
    }
}

pub struct Preview {
    pub image: Vec<u8>,
    pub content_type: &'static str,
}

pub struct Engine {
    /// Locked per frame, so previews can slip in between frames of a running export.
    session: Mutex<Session>,
    /// The GPU's video encoder, when ffmpeg can use one here.
    hardware: Option<HardwareEncoder>,
}

#[derive(Clone, Copy, Debug)]
enum HardwareEncoder {
    /// NVIDIA's, on Windows and Linux.
    Nvenc,
    /// Apple's, on macOS.
    VideoToolbox,
}

/// Where ONNX Runtime runs the models: the GPU through DirectML on Windows and CoreML on Macs,
/// the CPU on Linux (and anywhere the GPU backend won't load, which ONNX Runtime falls back
/// from on its own). HALO_CPU=1 forces the CPU, to rule out a GPU driver when something's off.
fn execution_providers() -> Vec<ep::ExecutionProviderDispatch> {
    if std::env::var_os("HALO_CPU").is_some() {
        return Vec::new();
    }
    #[cfg(windows)]
    return vec![ep::DirectML::default().build()];
    // ML Programs take the model's changing frame sizes; the older format would leave most of
    // it on the CPU.
    #[cfg(target_os = "macos")]
    return vec![ep::CoreML::default().with_model_format(ep::coreml::ModelFormat::MLProgram).build()];
    #[allow(unreachable_code)]
    Vec::new()
}

impl Engine {
    pub fn new(model: &Path) -> Result<Self> {
        if !model.exists() {
            bail!(
                "model not found at {}. Download rvm_mobilenetv3_fp32.onnx from \
                 https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0 into models/",
                model.display()
            );
        }
        let session = Session::builder(&ort_env()?)?
            .with_execution_providers(execution_providers())
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .commit_from_file(model)?;
        let hardware = hardware_encoder();
        println!("model loaded; hardware encoder: {hardware:?}");
        Ok(Self { session: Mutex::new(session), hardware })
    }

    /// Runs queued exports one at a time.
    pub fn run_worker(self: Arc<Self>, jobs: mpsc::Receiver<Job>) {
        for job in jobs {
            if job.cancel.load(Ordering::Relaxed) {
                job.status.lock().unwrap().state = "cancelled";
                continue;
            }
            job.status.lock().unwrap().state = "processing";
            let rendered = if job.captions_only { overlay(&job) } else { self.process(&job) };
            let result = rendered.and_then(|()| {
                std::fs::rename(job.partial_path(), &job.output).context("couldn't save to the chosen location")?;
                if let Some(srt) = &job.srt {
                    std::fs::write(job.output.with_extension("srt"), srt).context("couldn't save the captions file")?;
                }
                Ok(())
            });
            let mut status = job.status.lock().unwrap();
            match result {
                Ok(()) => status.state = "done",
                Err(_) if job.cancel.load(Ordering::Relaxed) => status.state = "cancelled",
                Err(e) => {
                    status.state = "error";
                    status.error = Some(format!("{e:#}"));
                }
            }
            if status.state != "done" {
                let _ = std::fs::remove_file(job.partial_path());
            }
        }
    }

    /// Renders the frame at `at` seconds exactly as the export would, as a JPEG (PNG when transparent).
    /// With `matte`, it's the matte itself instead: the subject white, the background black.
    pub fn preview(&self, input: &Path, at: f64, settings: Settings, matte: bool) -> Result<Preview> {
        let info = probe(input)?;
        let start = (at - PREVIEW_WARMUP_SECS).max(0.0);
        let mut decoder = Decoder::spawn(input, &info, Some(start), Some(at - start))?;
        let (mut matting, compositor) = Matting::new(&info, settings)?;
        let mut stdout = decoder.stdout.take().unwrap();
        let (mut frame, mut last) = (decoder.empty_frame(), decoder.empty_frame());
        let mut pha = Vec::new();
        let mut frames = 0;
        // Warm-up frames only feed the model; just the last one gets composited.
        while read_frame(&mut stdout, &mut frame)? {
            matting.infer(self, &frame, &mut pha)?;
            std::mem::swap(&mut frame, &mut last);
            frames += 1;
        }
        drop(stdout);
        decoder.finish()?;
        if frames == 0 {
            bail!("no frame at {at:.2}s");
        }
        let mut out = Vec::new();
        let matte = matte && settings.mode != Mode::None;
        if matte {
            compositor.matte(&pha, &mut out);
        } else {
            compositor.composite(&last, &pha, &mut out);
        }

        let (codec, content_type) =
            if settings.mode == Mode::Remove && !matte { ("png", "image/png") } else { ("mjpeg", "image/jpeg") };
        let pix_fmt = if matte { "rgb24" } else { settings.mode.pix_fmt() };
        let mut encoder = tool("ffmpeg")
            .args(["-v", "error", "-f", "rawvideo", "-pix_fmt", pix_fmt])
            .args(["-s", &format!("{}x{}", info.width, info.height), "-i", "-"])
            .args(["-frames:v", "1", "-c:v", codec, "-q:v", "3", "-f", "image2pipe", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to start ffmpeg")?;
        // Feed stdin from another thread so a large image can't deadlock the pipes.
        let mut stdin = encoder.stdin.take().unwrap();
        let writer = std::thread::spawn(move || stdin.write_all(&out));
        let output = encoder.wait_with_output()?;
        let _ = writer.join();
        if !output.status.success() {
            bail!("preview encoding failed: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        Ok(Preview { image: output.stdout, content_type })
    }

    fn process(&self, job: &Job) -> Result<()> {
        let settings = job.settings;
        let mode = settings.mode;
        let ExportSettings { format, quality, max_side } = job.export;
        let alpha = mode == Mode::Remove;
        if alpha && !format.supports_alpha() {
            bail!("transparent backgrounds need ProRes or WebM");
        }
        // Scaling at decode time means the whole pipeline runs at the export size.
        let info = export_info(&job.input, max_side)?;
        let (start, duration) = job.span(&info);
        job.status.lock().unwrap().total = info.frames_in(duration);

        let mut decoder = Decoder::spawn(&job.input, &info, start, start.map(|_| duration))?;
        let mut encode = tool("ffmpeg");
        encode
            .args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", mode.pix_fmt()])
            .args(["-s", &format!("{}x{}", info.width, info.height), "-framerate", &info.fps, "-i", "-"]);
        // The audio comes from the same stretch of the original.
        if let Some(start) = start {
            encode.args(["-ss", &format!("{start:.3}"), "-t", &format!("{duration:.3}")]);
        }
        encode.arg("-i").arg(&job.input).arg("-shortest");
        let subs_of = |path: &PathBuf| {
            let fonts = path.with_file_name("fonts");
            format!("subtitles=filename='{}':fontsdir='{}'", filter_path(path), filter_path(&fonts))
        };
        let tracks: Vec<String> = job.captions.iter().chain(&job.caption_mask).map(subs_of).collect();
        // Grading comes first, so it colours the video and not the captions drawn over it.
        let grade = grade_filters(&job.grades);
        if tracks.is_empty() {
            encode.args(["-filter_complex", &format!("[0:v]{grade}{ENCODE_709}[out]"), "-map", "[out]"]);
        } else {
            // Without a mask (or with a transparent background, where there's no video to
            // invert) every track is simply drawn.
            let subs = tracks.join(",");
            let graph = if alpha {
                // libass draws colour but leaves alpha alone, so text over the transparent
                // background would vanish. Render the captions over black and over white: they
                // match where the text is opaque and differ by its transparency, which gives
                // the captions' own alpha to merge with the subject's.
                let canvas = |c: &str| {
                    format!("format=rgb24,drawbox=x=0:y=0:w=iw:h=ih:c={c}:t=fill,{subs},format=gbrp")
                };
                format!(
                    "[0:v]{grade}split=3[v][b][w];[v]{subs},split[rgb][s];[s]alphaextract[va];\
                     [b]{}[cb];[w]{}[cw];[cb][cw]blend=all_mode=difference,extractplanes=g,negate[ca];\
                     [va][ca]blend=all_mode=lighten[alpha];[rgb][alpha]alphamerge,{ENCODE_709}[out]",
                    canvas("black"),
                    canvas("white"),
                )
            } else if let Some(mask) = &job.caption_mask {
                // Outlines, shadows and boxes are drawn first. The letters then become a mask
                // (white over black, stretched back from video levels to 0-255) that swaps in
                // the frame with its brightness flipped. Only brightness changes, so colours
                // keep their hue: dark brown shows as light tan.
                let frame = job.captions.as_ref().map(|c| format!("{},", subs_of(c))).unwrap_or_default();
                format!(
                    "[0:v]{grade}{frame}scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,split=3[v][n][m];[n]lutyuv=y=negval[inv];\
                     [m]drawbox=x=0:y=0:w=iw:h=ih:c=black:t=fill,{},lutyuv=y='clip((val-16)*255/219,0,255)'[mask];\
                     [v][inv][mask]maskedmerge=planes=1,{ENCODE_709}[out]",
                    subs_of(mask)
                )
            } else {
                format!("[0:v]{grade}{subs},{ENCODE_709}[out]")
            };
            encode.args(["-filter_complex", &graph, "-map", "[out]"]);
        }
        encode.args(["-map", "1:a?"]).args(TAGS_709);
        match format {
            Format::H264 | Format::H265 => {
                let hevc = format == Format::H265;
                match self.hardware {
                    Some(HardwareEncoder::Nvenc) => {
                        let cq = if hevc { quality.pick(["21", "25", "30"]) } else { quality.pick(["19", "23", "28"]) };
                        encode.args(["-c:v", if hevc { "hevc_nvenc" } else { "h264_nvenc" }]);
                        encode.args(["-preset", "p5", "-rc", "vbr", "-cq", cq, "-b:v", "0"]);
                    }
                    Some(HardwareEncoder::VideoToolbox) => {
                        // Constant quality, 1 to 100 (higher is better), which Apple Silicon supports.
                        let q = if hevc { quality.pick(["65", "55", "45"]) } else { quality.pick(["70", "60", "50"]) };
                        encode.args(["-c:v", if hevc { "hevc_videotoolbox" } else { "h264_videotoolbox" }, "-q:v", q]);
                    }
                    None => {
                        let crf = if hevc { quality.pick(["20", "24", "29"]) } else { quality.pick(["18", "22", "27"]) };
                        encode.args(["-c:v", if hevc { "libx265" } else { "libx264" }, "-preset", "medium", "-crf", crf]);
                    }
                }
                if hevc {
                    // Lets Apple players and Premiere recognise HEVC in MP4.
                    encode.args(["-tag:v", "hvc1"]);
                }
                encode.args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
            }
            Format::ProRes => {
                let (profile, pix_fmt) = if alpha { ("4", "yuva444p10le") } else { ("3", "yuv422p10le") };
                encode.args(["-c:v", "prores_ks", "-profile:v", profile, "-pix_fmt", pix_fmt]);
                encode.args(["-qscale:v", quality.pick(["6", "9", "13"]), "-vendor", "apl0"]);
                if alpha {
                    encode.args(["-alpha_bits", "16"]);
                }
                encode.args(["-c:a", "pcm_s16le"]);
            }
            Format::WebM => {
                encode.args(["-c:v", "libvpx-vp9", "-pix_fmt", if alpha { "yuva420p" } else { "yuv420p" }]);
                encode.args(["-b:v", "0", "-crf", quality.pick(["28", "33", "38"])]);
                encode.args(["-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-c:a", "libopus"]);
            }
        }
        let mut encoder = encode
            .args(["-f", format.muxer()])
            .arg(job.partial_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to start ffmpeg encoder")?;
        let encode_err = drain_stderr(&mut encoder);

        let (mut matting, compositor) = Matting::new(&info, settings)?;
        let stdout = decoder.stdout.take().unwrap();
        let stdin = encoder.stdin.take().unwrap();
        let started = Instant::now();

        // Three stages run at once, handing buffers along channels and recycling them:
        // reading decoded frames, GPU inference (this thread), and compositing + encoding.
        // When any stage stops, its channels close and the others wind down.
        let mut done = 0u64;
        let loop_result: Result<()> = std::thread::scope(|s| {
            let (full_tx, full_rx) = mpsc::sync_channel::<Vec<u8>>(PIPELINE_DEPTH);
            let (empty_tx, empty_rx) = mpsc::channel::<Vec<u8>>();
            let (work_tx, work_rx) = mpsc::sync_channel::<(Vec<u8>, Vec<f32>)>(PIPELINE_DEPTH);
            let (pha_tx, pha_rx) = mpsc::channel::<Vec<f32>>();
            for _ in 0..PIPELINE_DEPTH * 2 + 2 {
                let _ = empty_tx.send(decoder.empty_frame());
                let _ = pha_tx.send(Vec::new());
            }

            let reader = s.spawn(move || -> Result<()> {
                let mut stdout = stdout;
                for mut frame in empty_rx {
                    if !read_frame(&mut stdout, &mut frame)? || full_tx.send(frame).is_err() {
                        break;
                    }
                }
                Ok(())
            });

            // Owns its channel ends so that if encoding fails, the reader stops waiting for buffers.
            let compositor = &compositor;
            let writer = s.spawn(move || -> Result<u64> {
                let mut stdin = stdin;
                let mut out = Vec::new();
                let mut done = 0u64;
                for (frame, pha) in work_rx {
                    compositor.composite(&frame, &pha, &mut out);
                    let _ = empty_tx.send(frame);
                    let _ = pha_tx.send(pha);
                    stdin.write_all(&out).context("encoder stopped accepting frames")?;
                    done += 1;
                    let mut status = job.status.lock().unwrap();
                    status.frames = done;
                    status.total = status.total.max(done);
                    status.fps = done as f32 / started.elapsed().as_secs_f32();
                }
                Ok(done)
            });

            let inferred: Result<()> = (|| {
                for frame in full_rx {
                    if job.cancel.load(Ordering::Relaxed) {
                        bail!("export cancelled");
                    }
                    let mut pha = pha_rx.recv()?;
                    matting.infer(self, &frame, &mut pha)?;
                    if work_tx.send((frame, pha)).is_err() {
                        break;
                    }
                }
                Ok(())
            })();
            drop(work_tx);
            done = writer.join().unwrap()?;
            reader.join().unwrap()?;
            inferred
        });
        let decoded = decoder.finish();
        let encoded = encoder.wait()?;
        let encode_err = encode_err.join().unwrap_or_default();
        if !encoded.success() {
            bail!("encoding failed: {}", encode_err.trim());
        }
        loop_result?;
        decoded?;
        if done == 0 {
            bail!("video has no frames");
        }
        Ok(())
    }
}

/// The video's details at the size it's exported at: the long side capped at `max_side`.
fn export_info(input: &Path, max_side: Option<usize>) -> Result<VideoInfo> {
    let mut info = probe(input)?;
    if let Some(max) = max_side.filter(|&m| info.width.max(info.height) > m) {
        let scale = max as f64 / info.width.max(info.height) as f64;
        info.width = ((info.width as f64 * scale).round() as usize & !1).max(2);
        info.height = ((info.height as f64 * scale).round() as usize & !1).max(2);
    }
    Ok(info)
}

/// The last step before encoding: frames become YUV with the Rec.709 matrix, in video range.
/// Left to itself ffmpeg would use the Rec.601 matrix and tag nothing, and players reading
/// untagged HD as Rec.709 would show the colours shifted (reds orange, greens yellow).
const ENCODE_709: &str = "scale=in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv";
/// Says so in the file, so every player decodes it the same way.
const TAGS_709: [&str; 8] = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/// One `lut3d` per graded section, each switched on for its own stretch of time; empty or ending
/// in a comma, so it can lead a filter chain.
fn grade_filters(grades: &[Grade]) -> String {
    grades
        .iter()
        .map(|g| {
            format!(
                "lut3d=file='{}':interp=tetrahedral:enable='gte(t,{:.4})*lt(t,{:.4})',",
                filter_path(&g.lut),
                g.start,
                g.end
            )
        })
        .collect()
}

/// Renders the captions alone over transparency, at the video's size, rate and length.
fn overlay(job: &Job) -> Result<()> {
    let ExportSettings { format, quality, max_side } = job.export;
    if !format.supports_alpha() {
        bail!("caption overlays need ProRes or WebM to stay transparent");
    }
    let captions = job.captions.as_ref().context("there are no captions to export")?;
    let info = export_info(&job.input, max_side)?;
    let (_, duration) = job.span(&info);
    job.status.lock().unwrap().total = info.frames_in(duration);
    let fonts = captions.with_file_name("fonts");
    let subs = format!("subtitles=filename='{}':fontsdir='{}'", filter_path(captions), filter_path(&fonts));
    // As with transparent exports, libass leaves alpha alone: drawn over black and over white,
    // the captions differ by their transparency, and the colour over black is the colour times
    // that alpha, so it's divided back out.
    let graph = format!(
        "[0:v]format=rgb24,split[b][w];[w]drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill,{subs},format=gbrp[cw];         [b]{subs},format=gbrp,split[cb][c];[cb][cw]blend=all_mode=difference,extractplanes=g,negate[a];         [c][a]alphamerge,unpremultiply=inplace=1,{ENCODE_709}[out]"
    );
    let source = format!("color=c=black:s={}x{}:r={}:d={:.3}", info.width, info.height, info.fps, duration);
    let mut encode = tool("ffmpeg");
    encode
        .args(["-v", "error", "-y", "-nostats", "-progress", "pipe:1", "-f", "lavfi", "-i", &source])
        .args(["-filter_complex", &graph, "-map", "[out]"])
        .args(TAGS_709);
    match format {
        Format::ProRes => {
            encode.args(["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16"]);
            encode.args(["-qscale:v", quality.pick(["6", "9", "13"]), "-vendor", "apl0"]);
        }
        _ => {
            encode.args(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0"]);
            encode.args(["-crf", quality.pick(["28", "33", "38"]), "-row-mt", "1", "-deadline", "good", "-cpu-used", "4"]);
        }
    }
    let mut child = encode
        .args(["-f", format.muxer()])
        .arg(job.partial_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start ffmpeg")?;
    let errors = drain_stderr(&mut child);
    let started = Instant::now();
    let progress = std::io::BufReader::new(child.stdout.take().unwrap());
    for line in std::io::BufRead::lines(progress) {
        if job.cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            bail!("export cancelled");
        }
        if let Some(frames) = line?.strip_prefix("frame=").and_then(|n| n.trim().parse::<u64>().ok()) {
            let mut status = job.status.lock().unwrap();
            status.frames = frames;
            status.total = status.total.max(frames);
            status.fps = frames as f32 / started.elapsed().as_secs_f32();
        }
    }
    let done = child.wait()?;
    if !done.success() {
        bail!("rendering the captions failed: {}", errors.join().unwrap_or_default().trim());
    }
    Ok(())
}

/// Longest side the model runs at. Bigger frames are scaled down for it and the matte is scaled
/// back up, which costs little detail but keeps 4K from moving ~100 MB per frame to and from the GPU.
const MODEL_MAX_SIDE: usize = 1920;

/// The background is blurred on a grid of cells, each this many times smaller than the blur's
/// sigma: a blurred image loses nothing from that, and the blur costs the same however strong it is.
const BLUR_SIGMA_IN_CELLS: f32 = 2.5;

/// Smallest cell, in pixels, so light blurs aren't run at full resolution.
const MIN_BLUR_CELL: usize = 4;

/// Frames buffered between export stages, so decoding, inference and encoding overlap.
const PIPELINE_DEPTH: usize = 2;

/// Frame layout produced by the decoder: `w`x`h` RGB.
#[derive(Clone, Copy)]
struct Layout {
    w: usize,
    h: usize,
}

impl Layout {
    fn new(info: &VideoInfo) -> Self {
        Self { w: info.width, h: info.height }
    }

    fn frame_len(self) -> usize {
        self.w * self.h * 3
    }
}

/// An ffmpeg process emitting raw RGB frames in the shape described by `Layout`.
struct Decoder {
    child: Child,
    stdout: Option<ChildStdout>,
    stderr: std::thread::JoinHandle<String>,
    layout: Layout,
}

impl Decoder {
    fn spawn(input: &Path, info: &VideoInfo, start: Option<f64>, duration: Option<f64>) -> Result<Self> {
        let layout = Layout::new(info);
        let Layout { w, h } = layout;
        // Constant frame rate so the re-muxed audio stays in sync.
        let mut vf = format!("fps={},scale={w}:{h}", info.fps);
        if let Some(hdr) = info.hdr {
            vf += ",";
            vf += hdr.filters()?.trim_end_matches(',');
        }
        let mut cmd = tool("ffmpeg");
        cmd.args(["-v", "error"]);
        if let Some(start) = start {
            cmd.args(["-ss", &format!("{start:.3}")]);
        }
        cmd.arg("-i").arg(input);
        if let Some(duration) = duration {
            // Long enough for at least one frame, even when previewing the very first instant.
            cmd.args(["-t", &format!("{:.3}", duration.max(0.05))]);
        }
        let mut child = cmd
            .args(["-an", "-sn", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to start ffmpeg")?;
        let stderr = drain_stderr(&mut child);
        Ok(Self { stdout: child.stdout.take(), child, stderr, layout })
    }

    /// A buffer sized for one decoded frame.
    fn empty_frame(&self) -> Vec<u8> {
        vec![0; self.layout.frame_len()]
    }

    /// Waits for ffmpeg to exit; the caller must have dropped `stdout` (taken or not) first.
    fn finish(mut self) -> Result<()> {
        drop(self.stdout.take());
        let status = self.child.wait()?;
        let stderr = self.stderr.join().unwrap_or_default();
        if !status.success() {
            bail!("could not decode video: {}", stderr.trim());
        }
        Ok(())
    }
}

/// Reads one decoded frame into `frame`; false at end of stream.
fn read_frame(stdout: &mut ChildStdout, frame: &mut [u8]) -> Result<bool> {
    match stdout.read_exact(frame) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Bilinear sampling positions for resizing a line of `from` pixels to `to` pixels:
/// for each output pixel, the two source pixels and the weight of the second.
fn taps(to: usize, from: usize) -> Vec<(usize, usize, f32)> {
    taps_scaled(to, from, from as f32 / to as f32)
}

/// Like `taps`, with output pixels `scale` source pixels apart.
fn taps_scaled(to: usize, from: usize, scale: f32) -> Vec<(usize, usize, f32)> {
    (0..to)
        .map(|i| {
            let f = ((i as f32 + 0.5) * scale - 0.5).clamp(0.0, (from - 1) as f32);
            let i0 = f as usize;
            (i0, (i0 + 1).min(from - 1), f - i0 as f32)
        })
        .collect()
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// An sRGB-encoded value, 0 to 1, as linear light.
fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// Linear light for each 8-bit sRGB code value.
fn linear_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| std::array::from_fn(|i| srgb_to_linear(i as f32 / 255.0)))
}

/// Steps in `srgb_lut`, fine enough that the darkest code values (where sRGB is steepest) don't band.
const SRGB_STEPS: usize = 1 << 14;

/// The 8-bit sRGB code value for linear light 0 to 1, in `SRGB_STEPS` steps.
fn srgb_lut() -> &'static [u8] {
    static LUT: OnceLock<Vec<u8>> = OnceLock::new();
    LUT.get_or_init(|| {
        (0..SRGB_STEPS)
            .map(|i| {
                let v = i as f32 / (SRGB_STEPS - 1) as f32;
                let e = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
                (e * 255.0 + 0.5) as u8
            })
            .collect()
    })
}

#[inline]
fn encode_srgb(lut: &[u8], v: f32) -> u8 {
    lut[(v.clamp(0.0, 1.0) * (SRGB_STEPS - 1) as f32 + 0.5) as usize]
}

/// Per-video model state. RVM is recurrent: each frame's hidden state feeds the next,
/// which keeps the matte stable over time.
struct Matting {
    /// No background effect, so the model never runs.
    skip: bool,
    layout: Layout,
    /// Model input size.
    mw: usize,
    mh: usize,
    src: Vec<f32>,
    rec: Vec<DynValue>,
    ratio: Tensor<f32>,
    // Frame -> model input resampling.
    down_x: Vec<(usize, usize, f32)>,
    down_y: Vec<(usize, usize, f32)>,
}

/// Turns a frame plus its matte into the output frame. Separate from `Matting` so it can run
/// on another thread while the GPU works on the next frame.
struct Compositor {
    settings: Settings,
    layout: Layout,
    mw: usize,
    mh: usize,
    /// The matte's ramp, from `Settings::ramp`.
    low: f32,
    width: f32,
    // Matte -> frame resampling.
    up_x: Vec<(usize, usize, f32)>,
    up_y: Vec<(usize, usize, f32)>,
    /// Set in blur mode.
    blur: Option<BlurGrid>,
}

/// The coarse grid the background is blurred on, and how it maps back onto the frame.
struct BlurGrid {
    /// Cell size in frame pixels, and the grid's size in cells.
    cell: usize,
    cw: usize,
    ch: usize,
    /// The Gaussian, centre tap in the middle.
    kernel: Vec<f32>,
    // Grid -> frame resampling.
    up_x: Vec<(usize, usize, f32)>,
    up_y: Vec<(usize, usize, f32)>,
}

impl BlurGrid {
    fn new(w: usize, h: usize, sigma: f32) -> Self {
        // Grids under ~16 cells across would show their blockiness on tiny videos.
        let cell = ((sigma / BLUR_SIGMA_IN_CELLS).round() as usize).max(MIN_BLUR_CELL).min((w.min(h) / 16).max(1));
        let (cw, ch) = (w.div_ceil(cell), h.div_ceil(cell));
        let sigma = sigma / cell as f32;
        let radius = (3.0 * sigma).ceil() as i32;
        let kernel = (-radius..=radius).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
        let scale = 1.0 / cell as f32;
        Self { cell, cw, ch, kernel, up_x: taps_scaled(w, cw, scale), up_y: taps_scaled(h, ch, scale) }
    }
}

impl Matting {
    fn new(info: &VideoInfo, settings: Settings) -> Result<(Self, Compositor)> {
        let layout = Layout::new(info);
        let (w, h) = (layout.w, layout.h);
        let scale = (MODEL_MAX_SIDE as f32 / w.max(h) as f32).min(1.0);
        let mw = ((w as f32 * scale).round() as usize).max(2);
        let mh = ((h as f32 * scale).round() as usize).max(2);
        let rec = (0..4)
            .map(|_| Ok(Tensor::from_array(([1usize, 1, 1, 1], vec![0f32]))?.into_dyn()))
            .collect::<Result<_>>()?;
        // The model's internal resolution; ~512px on the long side is the recommended trade-off.
        let ratio = Tensor::from_array(([1usize], vec![(512.0 / mw.max(mh) as f32).min(1.0)]))?;
        let matting = Self {
            skip: settings.mode == Mode::None,
            layout,
            mw,
            mh,
            src: vec![0.0; 3 * mw * mh],
            rec,
            ratio,
            down_x: taps(mw, w),
            down_y: taps(mh, h),
        };
        let (low, width) = settings.ramp();
        let blur = (settings.mode == Mode::Blur).then(|| BlurGrid::new(w, h, settings.blur));
        let compositor = Compositor { settings, layout, mw, mh, low, width, up_x: taps(w, mw), up_y: taps(h, mh), blur };
        Ok((matting, compositor))
    }

    /// Runs the model on one decoded frame, writing its `mw`x`mh` alpha matte into `pha`, followed
    /// by its estimate of the subject's colour without the background showing through, as three
    /// planes of 0..1 sRGB.
    fn infer(&mut self, engine: &Engine, frame: &[u8], pha: &mut Vec<f32>) -> Result<()> {
        if self.skip {
            return Ok(());
        }
        let (w, mw, mh) = (self.layout.w, self.mw, self.mh);

        // Scale the frame to the model's input size, as planar 0..1 floats.
        let (r, rest) = self.src.split_at_mut(mw * mh);
        let (g, b) = rest.split_at_mut(mw * mh);
        let (down_x, down_y) = (&self.down_x, &self.down_y);
        r.par_chunks_mut(mw).zip(g.par_chunks_mut(mw)).zip(b.par_chunks_mut(mw)).enumerate().for_each(
            |(my, ((r, g), b))| {
                let (y0, y1, ty) = down_y[my];
                let (row0, row1) = (&frame[y0 * w * 3..], &frame[y1 * w * 3..]);
                for (mx, &(x0, x1, tx)) in down_x.iter().enumerate() {
                    let px = |c: usize| {
                        let top = lerp(row0[x0 * 3 + c] as f32, row0[x1 * 3 + c] as f32, tx);
                        let bottom = lerp(row1[x0 * 3 + c] as f32, row1[x1 * 3 + c] as f32, tx);
                        lerp(top, bottom, ty) / 255.0
                    };
                    r[mx] = px(0);
                    g[mx] = px(1);
                    b[mx] = px(2);
                }
            },
        );

        let mut session = engine.session.lock().unwrap();
        let mut outputs = session.run(ort::inputs! {
            "src" => TensorRef::from_array_view(([1usize, 3, mh, mw], &self.src[..]))?,
            "r1i" => &self.rec[0],
            "r2i" => &self.rec[1],
            "r3i" => &self.rec[2],
            "r4i" => &self.rec[3],
            "downsample_ratio" => &self.ratio,
        })?;
        pha.clear();
        pha.extend_from_slice(outputs["pha"].try_extract_tensor::<f32>()?.1);
        pha.extend_from_slice(outputs["fgr"].try_extract_tensor::<f32>()?.1);
        for (slot, name) in self.rec.iter_mut().zip(["r1o", "r2o", "r3o", "r4o"]) {
            *slot = outputs.remove(name).context("model output missing")?;
        }
        Ok(())
    }
}

impl Compositor {
    /// Row `y` of the matte at the frame's size: upscaled, then shifted and hardened. `between`
    /// holds the model's two nearest rows blended, so each pixel only blends across.
    fn alpha_row(&self, pha: &[f32], y: usize, between: &mut Vec<f32>, alpha: &mut [f32]) {
        let (my0, my1, ty) = self.up_y[y];
        let (row0, row1) = (&pha[my0 * self.mw..(my0 + 1) * self.mw], &pha[my1 * self.mw..(my1 + 1) * self.mw]);
        between.clear();
        between.extend(row0.iter().zip(row1).map(|(&a, &b)| lerp(a, b, ty)));
        let scale = 1.0 / self.width;
        for (a, &(mx0, mx1, tx)) in alpha.iter_mut().zip(&self.up_x) {
            *a = ((lerp(between[mx0], between[mx1], tx) - self.low) * scale).clamp(0.0, 1.0);
        }
    }

    /// The subject's colour at an edge pixel, as 0..1 sRGB. The frame's own colour there still
    /// holds some of the room behind (in hair, the sharp room itself), so as the matte thins it
    /// gives way to the model's estimate of the subject alone.
    fn edge_colour(&self, src: &[u8], pha: &[f32], x: usize, y: usize, a: f32) -> [f32; 3] {
        let ((mx0, mx1, tx), (my0, my1, ty)) = (self.up_x[x], self.up_y[y]);
        let t = ((1.0 - a) * 20.0).min(1.0);
        std::array::from_fn(|c| {
            let plane = &pha[(1 + c) * self.mw * self.mh..];
            let (row0, row1) = (&plane[my0 * self.mw..], &plane[my1 * self.mw..]);
            let fgr = lerp(lerp(row0[mx0], row0[mx1], tx), lerp(row1[mx0], row1[mx1], tx), ty);
            lerp(src[c] as f32 / 255.0, fgr.clamp(0.0, 1.0), t)
        })
    }

    /// The background alone, blurred, as 0..255 sRGB on the grid's cells. Each pixel counts by
    /// how surely it's background, and the blur is divided by the blurred weights, so the subject
    /// never smears into the blur around it and what it hides is filled in from around it.
    fn background(&self, grid: &BlurGrid, frame: &[u8], pha: &[f32]) -> Vec<f32> {
        let Layout { w, h } = self.layout;
        let &BlurGrid { cell, cw, ch, ref kernel, .. } = grid;
        let (to_linear, to_srgb) = (linear_lut(), srgb_lut());

        // Each cell's weighted RGB sum and weight. In linear light, so lights keep their strength.
        let mut sums = vec![0f32; cw * ch * 4];
        sums.par_chunks_mut(cw * 4).enumerate().for_each_init(
            || (Vec::new(), vec![0f32; w]),
            |(between, alpha), (cy, sums)| {
                for y in cy * cell..((cy + 1) * cell).min(h) {
                    self.alpha_row(pha, y, between, alpha);
                    let row = &frame[y * w * 3..(y + 1) * w * 3];
                    for (cx, s) in sums.chunks_exact_mut(4).enumerate() {
                        for x in cx * cell..((cx + 1) * cell).min(w) {
                            // Squared, so edge pixels, partly the subject's colour, count for less. The
                            // floor lets the subject fill in only where there's no background within reach.
                            let weight = (1.0 - alpha[x]).powi(2) + 1e-4;
                            for c in 0..3 {
                                s[c] += to_linear[row[x * 3 + c] as usize] * weight;
                            }
                            s[3] += weight;
                        }
                    }
                }
            },
        );

        // Separable Gaussian. Beyond the frame counts as nothing, which dividing by the blurred
        // weights accounts for.
        let r = kernel.len() / 2;
        let mut across = vec![0f32; cw * ch * 4];
        across.par_chunks_mut(cw * 4).zip(sums.par_chunks(cw * 4)).for_each(|(out, row)| {
            for x in 0..cw {
                let mut acc = [0f32; 4];
                for i in x.saturating_sub(r)..(x + r + 1).min(cw) {
                    let k = kernel[i + r - x];
                    for c in 0..4 {
                        acc[c] += row[i * 4 + c] * k;
                    }
                }
                out[x * 4..x * 4 + 4].copy_from_slice(&acc);
            }
        });
        // Dim was always a scale on sRGB values; this is the same in linear light.
        let keep = (1.0 - 0.85 * self.settings.dim.clamp(0.0, 1.0)).powf(2.2);
        let mut background = vec![0f32; cw * ch * 3];
        background.par_chunks_mut(cw * 3).enumerate().for_each(|(y, out)| {
            let mut acc = vec![0f32; cw * 4];
            for i in y.saturating_sub(r)..(y + r + 1).min(ch) {
                let k = kernel[i + r - y];
                for (a, v) in acc.iter_mut().zip(&across[i * cw * 4..(i + 1) * cw * 4]) {
                    *a += v * k;
                }
            }
            for (out, s) in out.chunks_exact_mut(3).zip(acc.chunks_exact(4)) {
                for c in 0..3 {
                    out[c] = encode_srgb(to_srgb, s[c] / s[3] * keep) as f32;
                }
            }
        });
        background
    }

    /// Blends the subject over the new background using the (upscaled) matte `pha`.
    fn composite(&self, frame: &[u8], pha: &[f32], out: &mut Vec<u8>) {
        let Layout { w, h } = self.layout;
        let Settings { mode, color, .. } = self.settings;
        let channels = mode.channels();
        if mode == Mode::None {
            out.clear();
            out.extend_from_slice(&frame[..w * h * 3]);
            return;
        }
        let blurred = self.blur.as_ref().map(|grid| (grid, self.background(grid, frame, pha)));
        out.resize(w * h * channels, 0);
        out.par_chunks_mut(w * channels).enumerate().for_each_init(
            || (Vec::new(), vec![0f32; w], Vec::new()),
            |(between, alpha, background_row), (y, out_row)| {
                self.alpha_row(pha, y, between, alpha);
                // This row's background, blended between the grid's two nearest rows.
                if let Some((grid, background)) = &blurred {
                    let (by0, by1, ty) = grid.up_y[y];
                    let row = |r: usize| &background[r * grid.cw * 3..(r + 1) * grid.cw * 3];
                    background_row.clear();
                    background_row.extend(row(by0).iter().zip(row(by1)).map(|(&a, &b)| lerp(a, b, ty)));
                }
                let row = &frame[y * w * 3..(y + 1) * w * 3];
                for x in 0..w {
                    let a = alpha[x];
                    let src = &row[x * 3..x * 3 + 3];
                    let dst = &mut out_row[x * channels..(x + 1) * channels];
                    // Fully opaque subject pixels are the frame as it is.
                    if a >= 0.999 {
                        dst[..3].copy_from_slice(src);
                        if mode == Mode::Remove {
                            dst[3] = 255;
                        }
                        continue;
                    }
                    let edge = (a > 0.001).then(|| self.edge_colour(src, pha, x, y, a));
                    match mode {
                        Mode::None => unreachable!("handled above"),
                        Mode::Remove => {
                            match edge {
                                Some(fg) => {
                                    for c in 0..3 {
                                        dst[c] = (fg[c] * 255.0 + 0.5) as u8;
                                    }
                                }
                                None => dst[..3].copy_from_slice(src),
                            }
                            dst[3] = (a * 255.0 + 0.5) as u8;
                        }
                        Mode::Color => {
                            for c in 0..3 {
                                let fg = edge.map_or(src[c] as f32, |fg| fg[c] * 255.0);
                                dst[c] = lerp(color[c] as f32, fg, a) as u8;
                            }
                        }
                        // Mixed as the frame is encoded, not in linear light: the model learned its
                        // mattes from pictures mixed that way, and in linear light dark hair over a
                        // bright room would turn hazy.
                        Mode::Blur => {
                            let (grid, _) = blurred.as_ref().expect("blur mode has a grid");
                            let (bx0, bx1, tx) = grid.up_x[x];
                            for c in 0..3 {
                                let background = lerp(background_row[bx0 * 3 + c], background_row[bx1 * 3 + c], tx);
                                let fg = edge.map_or(src[c] as f32, |fg| fg[c] * 255.0);
                                dst[c] = (lerp(background, fg, a) + 0.5) as u8;
                            }
                        }
                    }
                }
            },
        );
    }

    /// The matte as a grey picture at the frame's size, shifted and hardened as the export uses it.
    fn matte(&self, pha: &[f32], out: &mut Vec<u8>) {
        let Layout { w, h } = self.layout;
        out.resize(w * h * 3, 0);
        out.par_chunks_mut(w * 3).enumerate().for_each_init(
            || (Vec::new(), vec![0f32; w]),
            |(between, alpha), (y, out_row)| {
                self.alpha_row(pha, y, between, alpha);
                for (px, a) in out_row.chunks_exact_mut(3).zip(alpha.iter()) {
                    px.fill((a * 255.0 + 0.5) as u8);
                }
            },
        );
    }
}

struct VideoInfo {
    width: usize,
    height: usize,
    /// As ffmpeg reports it, e.g. "30000/1001", for passing back to ffmpeg exactly.
    fps: String,
    fps_value: f64,
    duration: f64,
    frames: u64,
    /// Set for HDR video, which is brought down to standard range as it's decoded.
    hdr: Option<Hdr>,
}

impl VideoInfo {
    /// About how many frames `duration` seconds holds; the whole video's count when that's all of it.
    fn frames_in(&self, duration: f64) -> u64 {
        if duration >= self.duration - 1e-3 { self.frames } else { (duration * self.fps_value).round().max(1.0) as u64 }
    }
}

#[derive(Serialize)]
pub struct MediaSummary {
    pub width: usize,
    pub height: usize,
    pub duration: f64,
    pub fps: f64,
    /// "hlg" or "pq" for HDR video.
    pub hdr: Option<&'static str>,
}

/// What the page needs to know about a video: its displayed size, length and frame rate.
pub fn probe_summary(input: &Path) -> Result<MediaSummary> {
    let info = probe(input)?;
    Ok(MediaSummary { width: info.width, height: info.height, duration: info.duration, fps: info.fps_value, hdr: info.hdr.map(Hdr::name) })
}

fn probe(input: &Path) -> Result<VideoInfo> {
    let output = tool("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
        .args(["stream=width,height,avg_frame_rate,color_transfer:stream_side_data=rotation:format=duration", "-of", "json"])
        .arg(input)
        .output()
        .context("failed to start ffprobe")?;
    if !output.status.success() {
        bail!("not a readable video: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let stream = json["streams"].get(0).context("file has no video stream")?;
    let (mut width, mut height) = (
        stream["width"].as_u64().context("unknown width")? as usize,
        stream["height"].as_u64().context("unknown height")? as usize,
    );
    // ffmpeg auto-rotates phone footage on decode, so swap to the displayed orientation.
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_i64()))
        .unwrap_or(0);
    if rotation.abs() % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    // yuv420p needs even dimensions.
    width &= !1;
    height &= !1;

    let fps = match stream["avg_frame_rate"].as_str() {
        Some(r) if !r.starts_with('0') && r.contains('/') => r.to_string(),
        _ => "30".to_string(),
    };
    let fps_value = fps
        .split_once('/')
        .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
        .unwrap_or(30.0);
    let duration: f64 = json["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let hdr = match stream["color_transfer"].as_str() {
        Some("arib-std-b67") => Some(Hdr::Hlg),
        Some("smpte2084") => Some(Hdr::Pq),
        _ => None,
    };
    Ok(VideoInfo { width, height, fps, fps_value, duration, frames: (duration * fps_value).round() as u64, hdr })
}

/// HDR transfer functions. Phones record HLG by default (iPhones since the 12); PQ is HDR10.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Hdr {
    Hlg,
    Pq,
}

impl Hdr {
    fn name(self) -> &'static str {
        match self {
            Hdr::Hlg => "hlg",
            Hdr::Pq => "pq",
        }
    }

    /// Standard-range light for a pixel of this HDR signal, as Chromium shows it: relative to
    /// HDR reference white (203 nits, ITU-R BT.2408), in BT.2020 primaries. HLG goes through its
    /// display OOTF for a 1000-nit screen; PQ is absolute.
    fn light(self, rgb: [f64; 3]) -> [f64; 3] {
        const REFERENCE_WHITE: f64 = 203.0;
        match self {
            Hdr::Hlg => {
                let (a, b, c) = (0.17883277, 0.28466892, 0.55991073);
                let scene = rgb.map(|e| if e <= 0.5 { e * e / 3.0 } else { (((e - c) / a).exp() + b) / 12.0 });
                let y = 0.2627 * scene[0] + 0.6780 * scene[1] + 0.0593 * scene[2];
                let ootf = 1000.0 * y.max(1e-12).powf(0.2) / REFERENCE_WHITE;
                scene.map(|v| v * ootf)
            }
            Hdr::Pq => {
                let (m1, m2) = (0.1593017578125, 78.84375);
                let (c1, c2, c3) = (0.8359375, 18.8515625, 18.6875);
                rgb.map(|e| {
                    let p = e.powf(1.0 / m2);
                    10000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1) / REFERENCE_WHITE
                })
            }
        }
    }

    /// A .cube taking full-range BT.2020 R'G'B' of this signal to sRGB-encoded Rec.709, clipped,
    /// written once to the temp folder. Chromium shows HDR video exactly this way (measured
    /// against it), so exports look like the player: grades made in the preview carry over.
    fn lut(self) -> Result<PathBuf> {
        const SIZE: usize = 65;
        const TO_709: [[f64; 3]; 3] = [
            [1.660491, -0.587641, -0.072850],
            [-0.124550, 1.132900, -0.008349],
            [-0.018151, -0.100579, 1.118730],
        ];
        let path = std::env::temp_dir().join(format!("halo-{}-to-sdr-v1.cube", self.name()));
        if path.is_file() {
            return Ok(path);
        }
        let srgb = |v: f64| {
            let v = v.clamp(0.0, 1.0);
            if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
        };
        let mut text = format!("TITLE \"Halo {} to SDR\"\nLUT_3D_SIZE {SIZE}\n", self.name().to_uppercase());
        let step = (SIZE - 1) as f64;
        for b in 0..SIZE {
            for g in 0..SIZE {
                for r in 0..SIZE {
                    let light = self.light([r as f64 / step, g as f64 / step, b as f64 / step]);
                    let out = TO_709.map(|row| srgb(row[0] * light[0] + row[1] * light[1] + row[2] * light[2]));
                    text += &format!("{:.6} {:.6} {:.6}\n", out[0], out[1], out[2]);
                }
            }
        }
        // Written aside and moved into place, so a half-written file is never used.
        let partial = path.with_extension(format!("{}.part", std::process::id()));
        std::fs::write(&partial, text)?;
        std::fs::rename(&partial, &path).or_else(|_| if path.is_file() { Ok(()) } else { Err(std::io::Error::other("couldn't save the HDR conversion")) })?;
        Ok(path)
    }

    /// Filters that bring this signal to standard range, ending in a comma. 16-bit RGB in between,
    /// so the conversion doesn't band.
    fn filters(self) -> Result<String> {
        Ok(format!("format=gbrp16le,lut3d=file='{}':interp=tetrahedral,", filter_path(&self.lut()?)))
    }
}

/// The GPU encoder ffmpeg can use here, found by encoding one frame with it.
fn hardware_encoder() -> Option<HardwareEncoder> {
    let works = |codec: &str| {
        tool("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "color=s=256x256", "-frames:v", "1"])
            .args(["-c:v", codec, "-f", "null", "-"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if cfg!(target_os = "macos") {
        works("h264_videotoolbox").then_some(HardwareEncoder::VideoToolbox)
    } else {
        works("h264_nvenc").then_some(HardwareEncoder::Nvenc)
    }
}

/// Collects a child's stderr on a thread so a chatty ffmpeg can never block on a full pipe.
fn drain_stderr(child: &mut Child) -> std::thread::JoinHandle<String> {
    let mut stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    })
}

/// Starts ffmpeg/ffprobe (or curl) without a console window flashing up behind the app on Windows.
///
/// The copy Halo ships with the app takes precedence, so an installed Halo doesn't depend on
/// anything being on PATH; builds without the bundled binaries fall back to the usual lookup.
pub fn tool(name: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(exe(name));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The program to run for `name`: Halo's own copy next to its executable or among its resources,
/// else the first on PATH. Apps opened from the Finder or Dock don't get the PATH a terminal has,
/// so on macOS Homebrew's folders are looked in too.
fn exe(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let beside_exe = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let homebrew = if cfg!(target_os = "macos") { ["/opt/homebrew/bin", "/usr/local/bin"].as_slice() } else { &[] };
    TOOLS_DIR
        .get()
        .cloned()
        .into_iter()
        .chain(beside_exe)
        .chain(std::env::var_os("PATH").iter().flat_map(std::env::split_paths).collect::<Vec<_>>())
        .chain(homebrew.iter().map(PathBuf::from))
        .map(|dir| dir.join(&file))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(file))
}

static TOOLS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// ONNX Runtime allows one environment per process; every model's session shares it.
pub fn ort_env() -> Result<ort::environment::Environment> {
    static ENV: Mutex<Option<ort::environment::Environment>> = Mutex::new(None);
    let mut env = ENV.lock().unwrap();
    if env.is_none() {
        #[cfg(target_os = "linux")]
        let builder = {
            let library = onnxruntime_library();
            ort::init_from(&library).map_err(|e| {
                anyhow::anyhow!("couldn't load ONNX Runtime from {}: {e}. Reinstalling Halo should fix this.", library.display())
            })?
        };
        #[cfg(not(target_os = "linux"))]
        let builder = ort::init();
        *env = Some(builder.with_name("halo").build()?);
    }
    Ok(env.clone().unwrap())
}

/// The ONNX Runtime library to load on Linux: ORT_DYLIB_PATH if it's set, else the copy Halo's
/// package carries, else one the system has.
#[cfg(target_os = "linux")]
fn onnxruntime_library() -> PathBuf {
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let beside_exe = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    RESOURCE_DIR
        .get()
        .cloned()
        .into_iter()
        .chain(beside_exe)
        .map(|dir| dir.join("libonnxruntime.so"))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("libonnxruntime.so"))
}

/// Where the package put Halo's own files, ONNX Runtime among them.
#[cfg(target_os = "linux")]
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the installer put its own ffmpeg and ffprobe (and on Linux ONNX Runtime); set once at startup.
///
/// Some Linux packages lose the files' executable bit on the way. Where the folder can't be
/// fixed (a system folder, or a read-only AppImage), the tools are copied to `cache` and run
/// from there instead.
pub fn use_tools_from(dir: PathBuf, cache: &Path) {
    #[cfg(target_os = "linux")]
    let _ = RESOURCE_DIR.set(dir.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let runnable = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
        let bundled: Vec<PathBuf> = ["ffmpeg", "ffprobe"].iter().map(|n| dir.join(n)).filter(|p| p.is_file()).collect();
        let stuck: Vec<&PathBuf> = bundled
            .iter()
            .filter(|p| !runnable(p) && std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err())
            .collect();
        if !stuck.is_empty() {
            let copied = (|| -> std::io::Result<()> {
                std::fs::create_dir_all(cache)?;
                for path in &bundled {
                    let to = cache.join(path.file_name().unwrap());
                    std::fs::copy(path, &to)?;
                    std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o755))?;
                }
                Ok(())
            })();
            if copied.is_ok() {
                let _ = TOOLS_DIR.set(cache.to_path_buf());
                return;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = cache;
    let _ = TOOLS_DIR.set(dir);
}

/// Peaks per second in `waveform`'s output.
pub const WAVEFORM_RATE: usize = 100;

/// The audio's loudness envelope for the timeline: one peak (0–255) per 1/100 s, empty if the
/// video has no audio.
pub fn waveform(input: &Path) -> Result<Vec<u8>> {
    const SAMPLE_RATE: usize = 8000;
    let output = tool("ffmpeg")
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(input)
        .args(["-vn", "-ac", "1", "-ar", &SAMPLE_RATE.to_string(), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .output()
        .context("failed to start ffmpeg")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not contain any stream") || stderr.contains("Output file does not contain") {
            return Ok(Vec::new());
        }
        bail!("couldn't read the audio: {}", stderr.trim());
    }
    let samples: Vec<i16> = output.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    Ok(samples
        .chunks(SAMPLE_RATE / WAVEFORM_RATE)
        .map(|chunk| {
            let peak = chunk.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
            // Square root lifts quiet speech so it's visible next to loud peaks.
            ((peak as f32 / 32768.0).sqrt() * 255.0).round() as u8
        })
        .collect())
}

pub struct Thumbnails {
    pub jpeg: Vec<u8>,
    pub columns: usize,
    pub thumb_width: usize,
}

/// `count` evenly spaced frames, `height` px tall, tiled into one JPEG grid with `columns` per row.
pub fn thumbnails(input: &Path, count: usize, height: usize) -> Result<Thumbnails> {
    const COLUMNS: usize = 10;
    let info = probe(input)?;
    let count = count.clamp(1, 400);
    let height = height.clamp(16, 160) & !1;
    let thumb_width = ((height * info.width) as f64 / info.height as f64).round() as usize & !1;
    let rows = count.div_ceil(COLUMNS);
    let mut cmd = tool("ffmpeg");
    cmd.args(["-v", "error", "-nostdin"]);
    // Long videos: decode keyframes only, which is far faster and close enough for thumbnails.
    if info.duration > 120.0 {
        cmd.args(["-skip_frame", "nokey"]);
    }
    let rate = count as f64 / info.duration.max(0.1);
    let output = cmd
        .arg("-i")
        .arg(input)
        .args(["-an", "-sn", "-vf"])
        .arg(format!(
            "fps={rate:.6},scale={thumb_width}:{height}:flags=bilinear,{}tile={COLUMNS}x{rows}",
            info.hdr.map(Hdr::filters).transpose()?.unwrap_or_default()
        ))
        .args(["-frames:v", "1", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "-"])
        .stdin(Stdio::null())
        .output()
        .context("failed to start ffmpeg")?;
    if !output.status.success() || output.stdout.is_empty() {
        bail!("couldn't make thumbnails: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(Thumbnails { jpeg: output.stdout, columns: COLUMNS, thumb_width })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdr_reference_white_is_standard_white() {
        // 75% HLG and PQ's 203-nit code value (0.5806) are BT.2408's reference white.
        for (hdr, code) in [(Hdr::Hlg, 0.75), (Hdr::Pq, 0.5806)] {
            let [r, g, b] = hdr.light([code; 3]);
            assert!((r - 1.0).abs() < 0.01 && (g - r).abs() < 1e-9 && (b - r).abs() < 1e-9, "{hdr:?}: {r}");
        }
        // HLG's 40% grey, which Chromium shows as 107 of 255.
        let grey = Hdr::Hlg.light([0.4; 3])[0];
        let shown = 1.055 * grey.powf(1.0 / 2.4) - 0.055;
        assert!((shown * 255.0 - 107.0).abs() < 1.0, "{shown}");
    }

    #[test]
    fn blur_leaves_the_subject_out_of_the_background() {
        // A black subject on a white room: the blurred room right beside it stays white.
        let (w, h) = (256, 128);
        let info = VideoInfo { width: w, height: h, fps: "30".into(), fps_value: 30.0, duration: 1.0, frames: 30, hdr: None };
        let settings = Settings { mode: Mode::Blur, blur: 20.0, color: [0; 3], edge: 0.0, hardness: 0.0, dim: 0.0 };
        let (_, compositor) = Matting::new(&info, settings).unwrap();
        let subject = |i: usize| (96..160).contains(&(i % w)) && (32..96).contains(&(i / w));
        let frame: Vec<u8> = (0..w * h).flat_map(|i| [if subject(i) { 0 } else { 255 }; 3]).collect();
        // The model runs at the frame's size here: its matte, then its subject colour (black).
        let mut pha: Vec<f32> = (0..w * h).map(|i| if subject(i) { 1.0 } else { 0.0 }).collect();
        pha.resize(4 * w * h, 0.0);
        let mut out = Vec::new();
        compositor.composite(&frame, &pha, &mut out);
        assert!(out[(64 * w + 94) * 3] >= 254, "{}", out[(64 * w + 94) * 3]);
        assert_eq!(out[(64 * w + 128) * 3], 0);
    }
}
