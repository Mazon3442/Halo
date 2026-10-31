//! Model files too big to ship with Halo, downloaded on first use into the app's data folder.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::pipeline::tool;

#[derive(Serialize, Clone)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ModelStatus {
    Missing,
    Downloading { received: u64, total: u64 },
    Ready,
    Failed { error: String },
}

/// A set of model files, as (file, URL), downloaded together.
pub struct Download {
    dir: PathBuf,
    files: &'static [(&'static str, &'static str)],
    download: Mutex<Option<ModelStatus>>,
}

impl Download {
    pub fn new(dir: PathBuf, files: &'static [(&'static str, &'static str)]) -> Self {
        Self { dir, files, download: Mutex::new(None) }
    }

    /// Where `file` is (or will be) once downloaded.
    pub fn path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    fn missing(&self) -> Vec<(&'static str, &'static str)> {
        self.files.iter().copied().filter(|(file, _)| !self.dir.join(file).exists()).collect()
    }

    pub fn status(&self) -> ModelStatus {
        if let Some(status) = self.download.lock().unwrap().clone() {
            return status;
        }
        if self.missing().is_empty() { ModelStatus::Ready } else { ModelStatus::Missing }
    }

    /// Starts downloading the files in the background unless they're present or already downloading.
    pub fn start(self: &Arc<Self>) {
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
