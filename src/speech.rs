//! Speech to text through ffmpeg's built-in whisper.cpp filter, with word-level timings for captions.

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
            // Windows ships curl.exe; it handles the redirects and TLS for us.
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
        // max_len=1 makes whisper.cpp emit one segment per word. The queue is whisper's own
        // 30 s window, so each chunk is transcribed with as much context as the model takes.
        let filter = format!(
            "aresample=16000,whisper=model='{}':language={}:queue=30:max_len=1:format=json:destination='pipe\\:1'",
            filter_path(&self.path()),
            if language.is_empty() { "auto" } else { &language },
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
            // A video with no audio track has nothing for whisper to hear.
            if stderr.contains("does not contain any stream") || stderr.contains("Output file does not contain") {
                bail!("this video has no audio to transcribe");
            }
            bail!("transcription failed: {}", stderr.trim());
        }
        let mut words = parse_words(&String::from_utf8_lossy(&output.stdout));
        // Without the audio the words keep Whisper's own times, which are still usable.
        if let Ok(samples) = samples(input) {
            let aligner = self.dir.join(aligner::MODEL_FILE);
            // The alignment model knows English letters; other languages get the rougher timing.
            let english = language == "en" || ((language.is_empty() || language == "auto") && mostly_english(&words));
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
        bail!("couldn't read the audio");
    }
    Ok(output.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// The whisper filter writes one JSON object per segment per line.
fn parse_words(output: &str) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for line in output.lines() {
        let Ok(segment) = serde_json::from_str::<serde_json::Value>(line.trim().trim_end_matches(',')) else {
            continue;
        };
        let (Some(start), Some(end), Some(text)) =
            (segment["start"].as_f64(), segment["end"].as_f64(), segment["text"].as_str())
        else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        // Times are in milliseconds. Punctuation sometimes arrives as its own segment, so it's
        // glued onto the previous word.
        let (start, end) = (start / 1000.0, end / 1000.0);
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
