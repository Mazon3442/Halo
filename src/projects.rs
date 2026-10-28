//! Saved projects: one JSON document per video, kept in the app's data folder.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;

const RECENT_LIMIT: usize = 30;

pub struct Projects {
    dir: PathBuf,
}

#[derive(Serialize)]
pub struct Summary {
    id: String,
    name: String,
    video_path: String,
    updated: u64,
    /// False when the video has been moved or deleted since.
    exists: bool,
}

impl Projects {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The project for a video is found by its path, so reopening a file brings its work back.
    pub fn id_for(video: &Path) -> String {
        // FNV-1a over the lowercased path; Windows paths are case-insensitive.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in video.to_string_lossy().to_lowercase().bytes() {
            hash = (hash ^ byte as u64).wrapping_mul(0x0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("invalid project id");
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    pub fn get(&self, id: &str) -> Result<Option<Value>> {
        match std::fs::read(self.path(id)?) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, id: &str, project: &Value) -> Result<()> {
        if project["video_path"].as_str().is_none() {
            bail!("a project needs a video_path");
        }
        std::fs::create_dir_all(&self.dir)?;
        // Write then rename, so a crash mid-save never leaves a half-written project.
        let path = self.path(id)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(project)?)?;
        std::fs::rename(&tmp, &path).context("couldn't save the project")?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        match std::fs::remove_file(self.path(id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    pub fn recent(&self) -> Vec<Summary> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut list: Vec<Summary> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| {
                let id = e.path().file_stem()?.to_str()?.to_string();
                let project: Value = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
                let video_path = project["video_path"].as_str()?.to_string();
                Some(Summary {
                    id,
                    name: project["name"].as_str().unwrap_or("Untitled").to_string(),
                    exists: Path::new(&video_path).exists(),
                    video_path,
                    updated: project["updated"].as_u64().unwrap_or(0),
                })
            })
            .collect();
        list.sort_by(|a, b| b.updated.cmp(&a.updated));
        list.truncate(RECENT_LIMIT);
        list
    }
}
