//! Fonts for captions: Halo's bundled fonts plus the ones installed on this PC.
//!
//! libass matches fonts by family name, so each file is listed under the family name stored in
//! the font itself. The page loads the files it needs for the live preview, and exports copy them
//! next to the subtitle file so ffmpeg finds exactly the same font.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct FontEntry {
    pub id: usize,
    pub family: String,
    pub bundled: bool,
    #[serde(skip)]
    pub path: PathBuf,
}

pub struct Fonts {
    bundled_dir: PathBuf,
    list: OnceLock<Vec<FontEntry>>,
}

impl Fonts {
    pub fn new(bundled_dir: PathBuf) -> Self {
        Self { bundled_dir, list: OnceLock::new() }
    }

    /// Scans on first use; reading a few hundred font headers takes a moment.
    pub fn list(&self) -> &[FontEntry] {
        self.list.get_or_init(|| {
            let mut by_family: BTreeMap<String, FontEntry> = BTreeMap::new();
            let mut add = |dir: &Path, bundled: bool| {
                let Ok(entries) = std::fs::read_dir(dir) else { return };
                for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
                    let is_font = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf"));
                    if !is_font {
                        continue;
                    }
                    let Some(family) = family_name(&path) else { continue };
                    // Bundled fonts win over installed ones with the same name; otherwise the
                    // first file found for a family (usually its regular weight) is used.
                    let key = family.to_lowercase();
                    if bundled || !by_family.contains_key(&key) {
                        by_family.insert(key, FontEntry { id: 0, family, bundled, path });
                    }
                }
            };
            add(&self.bundled_dir, true);
            if let Some(windir) = std::env::var_os("WINDIR") {
                add(&Path::new(&windir).join("Fonts"), false);
            }
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                add(&Path::new(&local).join("Microsoft").join("Windows").join("Fonts"), false);
            }
            by_family.into_values().enumerate().map(|(id, f)| FontEntry { id, ..f }).collect()
        })
    }

    pub fn get(&self, id: usize) -> Option<&FontEntry> {
        self.list().get(id)
    }

    pub fn by_family(&self, family: &str) -> Option<&FontEntry> {
        self.list().iter().find(|f| f.family.eq_ignore_ascii_case(family))
    }
}

/// The family name libass looks fonts up by (name ID 1), preferring the English record.
fn family_name(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let face = ttf_parser::Face::parse(&data, 0).ok()?;
    let names: Vec<_> = face
        .names()
        .into_iter()
        .filter(|n| n.name_id == ttf_parser::name_id::FAMILY && n.is_unicode())
        .collect();
    let english = names.iter().find(|n| n.language() == ttf_parser::Language::English_UnitedStates);
    english.or(names.first()).and_then(|n| n.to_string()).filter(|s| !s.trim().is_empty())
}
