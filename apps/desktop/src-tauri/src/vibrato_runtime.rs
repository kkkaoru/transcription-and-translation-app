//! Vibrato IPADIC pre-pass: kanji → hiragana readings before AzooKey.
//!
//! Shared conversion lives in `caption-bridge-vibrato-core`. This module keeps
//! desktop dictionary discovery and the cached reader used by the pipeline.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

pub use caption_bridge_vibrato_core::{contains_kanji, tokenizer_from_zstd, Tokenizer};

use caption_bridge_vibrato_core::{reading_for_azookey, tokenize};

/// Cached Vibrato tokenizer for the desktop AzooKey pre-pass.
#[derive(Clone)]
pub struct VibratoReader {
    tokenizer: Arc<Tokenizer>,
}

impl std::fmt::Debug for VibratoReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VibratoReader")
    }
}

#[allow(dead_code)]
impl VibratoReader {
    pub fn new(tokenizer: Tokenizer) -> Self {
        Self { tokenizer: Arc::new(tokenizer) }
    }

    /// Return `text` unchanged when it has no kanji; otherwise hiragana readings.
    pub fn reading_for_azookey(&self, text: &str) -> String {
        reading_for_azookey(&self.tokenizer, text)
    }

    /// Tokenize with IPADIC and return `(surface, feature, exclusive char end)`.
    pub fn tokenize(&self, text: &str) -> Vec<(String, String, usize)> {
        tokenize(&self.tokenizer, text)
            .into_iter()
            .map(|token| (token.surface, token.feature, token.char_end))
            .collect()
    }

    /// Vibrato IPADIC sentence-end offsets for caption paging.
    ///
    /// POS combinations are the source of truth. Surface copula/punctuation
    /// ends are unioned in so messy kana ASR (where IPADIC emits one unknown
    /// noun blob) still pages after です/ます.
    pub fn sentence_end_offsets(&self, text: &str) -> Vec<usize> {
        caption_bridge_vibrato_core::sentence_end_offsets(&self.tokenizer, text)
    }

    /// Mid-sentence POS wrap points so captions break before maxChars.
    pub fn soft_break_offsets(&self, text: &str) -> Vec<usize> {
        caption_bridge_vibrato_core::soft_break_offsets(&self.tokenizer, text)
    }

    /// Tokenize once and return sentence-end plus soft-break offsets.
    pub fn caption_boundary_offsets(
        &self,
        text: &str,
    ) -> caption_bridge_vibrato_core::CaptionBoundaryOffsets {
        caption_bridge_vibrato_core::caption_boundary_offsets(&self.tokenizer, text)
    }
}

/// Candidate paths for the bundled / source-tree IPADIC dictionary.
pub fn resolve_ipadic_path() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = vec![
        manifest.join("resources/vibrato/system.dic.zst"),
        manifest.join("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst"),
    ];
    // Packaged Tauri apps: Resources/vibrato/system.dic.zst next to the binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            candidates.push(macos_dir.join("../Resources/vibrato/system.dic.zst"));
            candidates.push(macos_dir.join("resources/vibrato/system.dic.zst"));
            candidates.push(macos_dir.join("vibrato/system.dic.zst"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Load a Vibrato reader from a zstd dictionary file.
pub fn load_from_path(path: &Path) -> Result<VibratoReader, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("vibrato dictionary read failed ({}): {error}", path.display()))?;
    let tokenizer = tokenizer_from_zstd(&bytes)?;
    Ok(VibratoReader::new(tokenizer))
}

/// Load from the first existing IPADIC candidate path, if any.
pub fn try_default() -> Option<VibratoReader> {
    static CACHED: OnceLock<VibratoReader> = OnceLock::new();
    if let Some(reader) = CACHED.get() {
        return Some(reader.clone());
    }
    let path = resolve_ipadic_path()?;
    match load_from_path(&path) {
        Ok(reader) => {
            let _ = CACHED.set(reader.clone());
            Some(reader)
        }
        Err(error) => {
            log::warn!(
                target: "pipeline_vibrato",
                "vibrato dictionary at {} failed to load: {error}",
                path.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{contains_kanji, try_default};

    #[test]
    fn contains_kanji_detects_cjk_ideographs() {
        assert!(contains_kanji("東京"));
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
        assert!(!contains_kanji("abc123"));
        assert!(!contains_kanji(""));
    }

    #[test]
    fn bundled_ipadic_passthrough_pure_kana() {
        let Some(reader) = try_default() else {
            return;
        };
        assert_eq!(reader.reading_for_azookey("きょうははれ"), "きょうははれ");
    }
}
