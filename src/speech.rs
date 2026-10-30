//! Speech to text with whisper.cpp, with word-level timings for captions.
//!
//! On Windows it runs inside the ffmpeg Halo ships (its `whisper` filter, on the GPU through
//! Vulkan). Linux and macOS builds of ffmpeg seldom have that filter, so there Halo runs
//! whisper.cpp itself, on audio ffmpeg decodes. Both give one segment per word, read the same way.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::{align, aligner};
use crate::pipeline::tool;

pub const MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";

#[derive(Serialize, Clone)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ModelStatus {
    Missing,
    Downloading { received: u64, total: u64 },
    Ready,
    Failed { error: String },
}

/// The Whisper model file, downloaded on first use into the app's data folder.
pub struct SpeechModel {
    dir: PathBuf,
    download: Mutex<Option<ModelStatus>>,
}

impl SpeechModel {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, download: Mutex::new(None) }
    }

    fn path(&self) -> PathBuf {
        self.dir.join(MODEL_FILE)
    }

    /// The models captions need, as (file, URL): Whisper to hear the words, wav2vec2 to time them.
    fn files() -> [(&'static str, &'static str); 2] {
        [(MODEL_FILE, MODEL_URL), (aligner::MODEL_FILE, aligner::MODEL_URL)]
    }

    fn missing(&self) -> Vec<(&'static str, &'static str)> {
        Self::files().into_iter().filter(|(file, _)| !self.dir.join(file).exists()).collect()
    }

    pub fn status(&self) -> ModelStatus {
        if let Some(status) = self.download.lock().unwrap().clone() {
            return status;
        }
        if self.missing().is_empty() { ModelStatus::Ready } else { ModelStatus::Missing }
    }

    /// Starts downloading the models in the background unless they're present or already downloading.
    pub fn start_download(self: &Arc<Self>) {
        {
            let mut download = self.download.lock().unwrap();
            if matches!(*download, Some(ModelStatus::Downloading { .. })) || self.missing().is_empty() {
                return;
            }
            *download = Some(ModelStatus::Downloading { received: 0, total: 0 });
        }
        let model = self.clone();
        std::thread::spawn(move || {
            let result = model.download();
            *model.download.lock().unwrap() = match result {
                Ok(()) => None,
                Err(e) => Some(ModelStatus::Failed { error: format!("{e:#}") }),
            };
        });
    }

    fn download(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let missing = self.missing();
        let sizes = missing.iter().map(|(_, url)| content_length(url)).collect::<Result<Vec<u64>>>()?;
        let total: u64 = sizes.iter().sum();
        let mut done = 0;
        for ((file, url), size) in missing.into_iter().zip(sizes) {
            let part = self.dir.join(format!("{file}.part"));
            // curl comes with Windows, macOS and nearly every Linux; it handles redirects and TLS.
            let mut child = tool("curl")
                .args(["-fsSL", "--retry", "3", "-o"])
                .arg(&part)
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .context("failed to start curl")?;
            let status = loop {
                if let Some(status) = child.try_wait()? {
                    break status;
                }
                let received = done + std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                *self.download.lock().unwrap() = Some(ModelStatus::Downloading { received, total });
                std::thread::sleep(Duration::from_millis(300));
            };
            if !status.success() || std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) != size {
                let _ = std::fs::remove_file(&part);
                bail!("download failed; check your internet connection and try again");
            }
            std::fs::rename(&part, self.dir.join(file))?;
            done += size;
        }
        Ok(())
    }

    /// Transcribes the audio track into words with start and end times in seconds.
    pub fn transcribe(&self, input: &Path, language: &str) -> Result<Vec<Word>> {
        if !self.path().exists() {
            bail!("the speech model isn't downloaded yet");
        }
        let language: String = language.chars().filter(|c| c.is_ascii_alphabetic()).take(8).collect();
        let language = if language.is_empty() { "auto".to_string() } else { language };
        let (mut words, audio) = recognize(&self.path(), input, &language)?;
        // Without the audio the words keep Whisper's own times, which are still usable.
        if let Some(samples) = audio.or_else(|| samples(input).ok()) {
            let aligner = self.dir.join(aligner::MODEL_FILE);
            // The alignment model knows English letters; other languages get the rougher timing.
            let english = language == "en" || (language == "auto" && mostly_english(&words));
            let aligned = english && aligner.exists() && aligner::align(&aligner, &mut words, &samples).is_ok();
            if !aligned {
                align::refine(&mut words, &samples);
            }
        }
        Ok(words)
    }
}

/// Whether nearly all the letters are plain A to Z, as English text is.
fn mostly_english(words: &[Word]) -> bool {
    let letters = words.iter().flat_map(|w| w.text.chars()).filter(|c| c.is_alphabetic());
    let (ascii, all) = letters.fold((0, 0), |(a, n), c| (a + c.is_ascii() as usize, n + 1));
    all > 0 && ascii * 100 >= all * 98
}

/// A video with no audio track has nothing for whisper to hear.
fn no_audio(stderr: &str) -> bool {
    stderr.contains("does not contain any stream") || stderr.contains("Output file does not contain")
}

/// The audio as 16 kHz mono samples.
fn samples(input: &Path) -> Result<Vec<i16>> {
    let rate = align::SAMPLE_RATE.to_string();
    let output = tool("ffmpeg")
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(input)
        .args(["-vn", "-ac", "1", "-ar", &rate, "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .output()
        .context("failed to start ffmpeg")?;
    if !output.status.success() {
        if no_audio(&String::from_utf8_lossy(&output.stderr)) {
            bail!("this video has no audio to transcribe");
        }
        bail!("couldn't read the audio");
    }
    Ok(output.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// Speech to words with ffmpeg's whisper filter. The audio isn't decoded here, so none comes back.
#[cfg(windows)]
fn recognize(model: &Path, input: &Path, language: &str) -> Result<(Vec<Word>, Option<Vec<i16>>)> {
    // max_len=1 makes whisper.cpp emit one segment per word. The queue is whisper's own
    // 30 s window, so each chunk is transcribed with as much context as the model takes.
    let filter = format!(
        "aresample=16000,whisper=model='{}':language={language}:queue=30:max_len=1:format=json:destination='pipe\\:1'",
        filter_path(model),
    );
    let output = tool("ffmpeg")
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(input)
        .args(["-vn", "-af", &filter, "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .context("failed to start ffmpeg")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if no_audio(&stderr) {
            bail!("this video has no audio to transcribe");
        }
        bail!("transcription failed: {}", stderr.trim());
    }
    Ok((parse_words(&String::from_utf8_lossy(&output.stdout)), None))
}

/// Speech to words with whisper.cpp in Halo itself, on the audio ffmpeg decodes. The same
/// settings as ffmpeg's filter: greedy decoding, and one segment per word.
#[cfg(not(windows))]
fn recognize(model: &Path, input: &Path, language: &str) -> Result<(Vec<Word>, Option<Vec<i16>>)> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // whisper.cpp logs every step to stderr; leave the terminal to Halo.
    static QUIET: std::sync::Once = std::sync::Once::new();
    QUIET.call_once(whisper_rs::install_logging_hooks);

    let samples = samples(input)?;
    if samples.is_empty() {
        bail!("this video has no audio to transcribe");
    }
    let audio: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
    let model = model.to_str().context("the speech model's folder has an unreadable name")?;
    let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .map_err(|e| anyhow::anyhow!("couldn't load the speech model: {e}"))?;
    let mut state = context.create_state().map_err(|e| anyhow::anyhow!("couldn't start the speech model: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_token_timestamps(true);
    params.set_max_len(1);
    params.set_split_on_word(true);
    params.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as i32);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, &audio).map_err(|e| anyhow::anyhow!("transcription failed: {e}"))?;
    // Segment times are in hundredths of a second.
    let segments = state.as_iter().filter_map(|segment| {
        let text = segment.to_str_lossy().ok()?.into_owned();
        Some((segment.start_timestamp() as f64 / 100.0, segment.end_timestamp() as f64 / 100.0, text))
    });
    Ok((collect_words(segments), Some(samples)))
}

/// The whisper filter writes one JSON object per segment per line, with times in milliseconds.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_words(output: &str) -> Vec<Word> {
    collect_words(output.lines().filter_map(|line| {
        let segment = serde_json::from_str::<serde_json::Value>(line.trim().trim_end_matches(',')).ok()?;
        let (start, end, text) = (segment["start"].as_f64()?, segment["end"].as_f64()?, segment["text"].as_str()?);
        Some((start / 1000.0, end / 1000.0, text.to_string()))
    }))
}

/// Words from whisper's one-word segments, as (start, end, text) with times in seconds.
fn collect_words(segments: impl Iterator<Item = (f64, f64, String)>) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for (start, end, text) in segments {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        // Punctuation sometimes arrives as its own segment, so it's glued onto the previous word.
        let is_punctuation = text.chars().all(|c| c.is_ascii_punctuation());
        match words.last_mut() {
            Some(last) if is_punctuation => {
                last.text.push_str(text);
                last.end = last.end.max(end);
            }
            _ => words.push(Word { text: text.to_string(), start, end: end.max(start) }),
        }
    }
    words
}

/// A path as an ffmpeg filter option value inside single quotes.
pub fn filter_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "")
}

fn content_length(url: &str) -> Result<u64> {
    let output = tool("curl").args(["-fsIL", url]).output().context("failed to start curl")?;
    if !output.status.success() {
        bail!("couldn't reach the model server; check your internet connection");
    }
    // With redirects curl prints several header blocks; the last length is the file's.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string()))
        .filter_map(|v| v.parse().ok())
        .last()
        .context("model server didn't report a file size")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn punctuation_joins_the_word_before() {
        let words = collect_words(
            [(0.0, 0.4, " Hello".to_string()), (0.4, 0.5, ",".to_string()), (0.6, 1.0, " world".to_string()), (1.0, 1.1, "".to_string())]
                .into_iter(),
        );
        let texts: Vec<_> = words.iter().map(|w| (w.text.as_str(), w.end)).collect();
        assert_eq!(texts, [("Hello,", 0.5), ("world", 1.0)]);
    }

    /// Hears real speech with whisper.cpp. Needs a model and a recording, which CI downloads:
    /// HALO_TEST_WHISPER_MODEL (ggml-tiny.en.bin) and HALO_TEST_SPEECH (whisper.cpp's jfk.wav).
    #[test]
    #[ignore = "needs a whisper model and a speech recording"]
    fn transcribes_speech() {
        let model = PathBuf::from(std::env::var_os("HALO_TEST_WHISPER_MODEL").expect("HALO_TEST_WHISPER_MODEL"));
        let speech = PathBuf::from(std::env::var_os("HALO_TEST_SPEECH").expect("HALO_TEST_SPEECH"));
        let (words, _) = recognize(&model, &speech, "en").expect("transcription");
        let text = words.iter().map(|w| w.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        println!("{text}");
        assert!(text.contains("country"), "heard: {text}");
        assert!(words.windows(2).all(|w| w[0].start <= w[1].start), "words out of order");
        assert!(words.len() > 15, "expected one segment per word, got {}", words.len());
    }
}
