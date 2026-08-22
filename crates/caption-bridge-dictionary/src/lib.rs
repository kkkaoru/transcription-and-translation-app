#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Shared custom-dictionary storage and search for the caption-bridge apps.
//!
//! This crate owns load, save, search, and TSV export of user-defined
//! kana-to-word entries. It has no GUI-framework dependencies and accepts a
//! plain [`std::path::Path`] directory, so it can be used from the Tauri
//! desktop app, the future GPUI native app, or tests.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// On-disk filename for the JSON representation of a custom dictionary.
pub const CUSTOM_DICTIONARY_JSON: &str = "custom_dictionary.json";

/// On-disk filename for the generated two-column TSV export.
pub const CUSTOM_DICTIONARY_TSV: &str = "custom_dictionary.tsv";

const CUSTOM_DICTIONARY_VERSION: u32 = 1;
const CUSTOM_DICTIONARY_CATALOG_VERSION: u32 = 2;

const DEFAULT_DICTIONARY_ID: &str = "default";
const DEFAULT_DICTIONARY_NAME: &str = "Custom";

const DEFAULT_SAMPLE_ID: &str = "sample-vrchat-vrc";
const DEFAULT_SAMPLE_READING: &str = "ぶいあーるちゃっと";
const DEFAULT_SAMPLE_WORD: &str = "VRC";

const MAX_ENTRIES: usize = 100_000;
const MAX_ID_CHARS: usize = 128;
const MIN_READING_CHARS: usize = 2;
const MAX_READING_CHARS: usize = 256;
const MAX_WORD_CHARS: usize = 512;

/// A single custom-dictionary entry mapping a reading to a word.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomDictionaryEntry {
    /// Stable identifier for this entry.
    pub id: String,
    /// Kana or other input reading that can be converted to `word`.
    pub reading: String,
    /// The output word or phrase for the reading.
    pub word: String,
}

/// Errors that can occur when loading, saving, or validating a dictionary.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    /// Filesystem or directory operation failed.
    #[error("{0}")]
    Io(String),
    /// JSON serialization or deserialization failed.
    #[error("{0}")]
    Json(String),
    /// One or more entries failed validation.
    #[error("{0}")]
    Validation(String),
}

/// Shorthand result type for this crate.
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CustomDictionaryFile {
    version: u32,
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    dictionaries: Option<Vec<CustomDictionaryBook>>,
    #[serde(default)]
    entries: Vec<CustomDictionaryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CustomDictionaryBook {
    id: String,
    name: String,
    entries: Vec<CustomDictionaryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CustomDictionaryCatalog {
    version: u32,
    active_id: String,
    dictionaries: Vec<CustomDictionaryBook>,
}

/// Load the active entries from `dir`.
///
/// If the directory has never contained a dictionary, the documented
/// `ぶいあーるちゃっと → VRC` sample is written and returned. If an existing
/// JSON file with an empty entry list is present, it is respected and no
/// reseeding occurs.
pub fn load_from_directory(dir: &Path) -> Result<Vec<CustomDictionaryEntry>> {
    let json_path = dir.join(CUSTOM_DICTIONARY_JSON);

    if !json_path.exists() {
        let tsv_path = dir.join(CUSTOM_DICTIONARY_TSV);
        if tsv_path.exists() {
            // An external/legacy TSV predates the JSON manager; do not seed.
            return Ok(Vec::new());
        }

        let sample = vec![CustomDictionaryEntry {
            id: DEFAULT_SAMPLE_ID.to_string(),
            reading: DEFAULT_SAMPLE_READING.to_string(),
            word: DEFAULT_SAMPLE_WORD.to_string(),
        }];
        save_to_directory(dir, &sample)?;
        return Ok(sample);
    }

    let body = std::fs::read_to_string(&json_path)
        .map_err(|error| Error::Io(format!("could not read custom dictionary: {error}")))?;

    if body.trim().is_empty() {
        return Ok(Vec::new());
    }

    let document: CustomDictionaryFile = serde_json::from_str(&body)
        .map_err(|error| Error::Json(format!("custom dictionary JSON is invalid: {error}")))?;

    active_entries_from_document(document)
}

/// Save `entries` to `dir`, returning the validated, trimmed entries.
///
/// Writes `custom_dictionary.json` and, when `entries` is non-empty,
/// `custom_dictionary.tsv`. An empty slice removes any previously generated
/// TSV so the on-disk state matches an intentionally cleared dictionary.
pub fn save_to_directory(
    dir: &Path,
    entries: &[CustomDictionaryEntry],
) -> Result<Vec<CustomDictionaryEntry>> {
    let entries = validate_entries(entries)?;

    std::fs::create_dir_all(dir).map_err(|error| {
        Error::Io(format!("could not create custom dictionary directory: {error}"))
    })?;

    let document = CustomDictionaryFile {
        version: CUSTOM_DICTIONARY_VERSION,
        active_id: None,
        dictionaries: None,
        entries: entries.clone(),
    };
    let json = serde_json::to_vec_pretty(&document)
        .map_err(|error| Error::Json(format!("could not serialize custom dictionary: {error}")))?;

    std::fs::write(json_path(dir), json)
        .map_err(|error| Error::Io(format!("could not write custom dictionary JSON: {error}")))?;

    let tsv_path = dir.join(CUSTOM_DICTIONARY_TSV);
    if entries.is_empty() {
        match std::fs::remove_file(&tsv_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(Error::Io(format!("could not remove custom dictionary TSV: {error}")))
            }
        }
    } else {
        std::fs::write(&tsv_path, to_tsv(&entries)).map_err(|error| {
            Error::Io(format!("could not write custom dictionary TSV: {error}"))
        })?;
    }

    Ok(entries)
}

/// Return at most `limit` entries whose reading or word starts with `query`.
///
/// `limit` is clamped to the inclusive range `1..=50`. An empty query matches
/// every entry and simply truncates to the limit.
pub fn search(
    entries: &[CustomDictionaryEntry],
    query: &str,
    limit: usize,
) -> Vec<CustomDictionaryEntry> {
    let needle = query.trim();
    let limit = limit.clamp(1, 50);

    entries
        .iter()
        .filter(|entry| {
            needle.is_empty() || entry.reading.starts_with(needle) || entry.word.starts_with(needle)
        })
        .take(limit)
        .cloned()
        .collect()
}

/// Render `entries` as a two-column TSV (`reading\tword`).
///
/// Non-empty output ends with a trailing newline; empty input yields an empty
/// string.
pub fn to_tsv(entries: &[CustomDictionaryEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }

    let lines: Vec<String> =
        entries.iter().map(|entry| format!("{}\t{}", entry.reading, entry.word)).collect();

    lines.join("\n") + "\n"
}

/// Validate a single entry without any collection-level checks.
pub fn validate_entry(entry: &CustomDictionaryEntry) -> Result<()> {
    let id = entry.id.trim();
    let reading = entry.reading.trim();
    let word = entry.word.trim();

    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(Error::Validation("id is invalid".to_string()));
    }

    validate_field_constraints(reading, word, None)
}

fn json_path(dir: &Path) -> PathBuf {
    dir.join(CUSTOM_DICTIONARY_JSON)
}

fn active_entries_from_document(
    document: CustomDictionaryFile,
) -> Result<Vec<CustomDictionaryEntry>> {
    if document.version == CUSTOM_DICTIONARY_CATALOG_VERSION {
        let catalog = catalog_from_document(document)?;
        let active = catalog
            .dictionaries
            .iter()
            .find(|book| book.id == catalog.active_id)
            .or_else(|| catalog.dictionaries.first());

        return match active {
            Some(book) => validate_entries(&book.entries),
            None => Ok(Vec::new()),
        };
    }

    if document.version != CUSTOM_DICTIONARY_VERSION {
        return Err(Error::Json(format!(
            "unsupported custom dictionary version: {}",
            document.version
        )));
    }

    validate_entries(&document.entries)
}

fn catalog_from_document(document: CustomDictionaryFile) -> Result<CustomDictionaryCatalog> {
    if let Some(dictionaries) = document.dictionaries {
        let validated = dictionaries
            .into_iter()
            .map(|book| {
                Ok(CustomDictionaryBook {
                    id: book.id.trim().to_string(),
                    name: book.name.trim().to_string(),
                    entries: validate_entries(&book.entries)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        if validated.is_empty() {
            return Err(Error::Json("custom dictionary catalog has no dictionaries".to_string()));
        }

        let active_id = document.active_id.unwrap_or_else(|| validated[0].id.clone());

        return Ok(CustomDictionaryCatalog {
            version: CUSTOM_DICTIONARY_CATALOG_VERSION,
            active_id,
            dictionaries: validated,
        });
    }

    Ok(CustomDictionaryCatalog {
        version: CUSTOM_DICTIONARY_CATALOG_VERSION,
        active_id: DEFAULT_DICTIONARY_ID.to_string(),
        dictionaries: vec![CustomDictionaryBook {
            id: DEFAULT_DICTIONARY_ID.to_string(),
            name: DEFAULT_DICTIONARY_NAME.to_string(),
            entries: validate_entries(&document.entries)?,
        }],
    })
}

fn validate_entries(entries: &[CustomDictionaryEntry]) -> Result<Vec<CustomDictionaryEntry>> {
    if entries.len() > MAX_ENTRIES {
        return Err(Error::Validation(format!(
            "custom dictionary supports at most {MAX_ENTRIES} entries"
        )));
    }

    let mut ids = HashSet::with_capacity(entries.len());
    let mut validated = Vec::with_capacity(entries.len());

    for (index, entry) in entries.iter().enumerate() {
        let id = entry.id.trim().to_string();
        let reading = entry.reading.trim().to_string();
        let word = entry.word.trim().to_string();
        let number = index + 1;

        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(Error::Validation(format!("entry {number} has an invalid id")));
        }
        if !ids.insert(id.clone()) {
            return Err(Error::Validation(format!("entry {number} has a duplicate id")));
        }

        validate_field_constraints(&reading, &word, Some(number))?;

        validated.push(CustomDictionaryEntry { id, reading, word });
    }

    Ok(validated)
}

fn validate_field_constraints(reading: &str, word: &str, number: Option<usize>) -> Result<()> {
    let prefix = number.map(|n| format!("entry {n} ")).unwrap_or_default();

    if reading.is_empty() {
        return Err(Error::Validation(format!("{prefix}reading is required")));
    }
    if reading.contains(['\t', '\n', '\r']) {
        return Err(Error::Validation(format!("{prefix}reading cannot contain tabs or newlines")));
    }
    if reading.chars().count() < MIN_READING_CHARS {
        return Err(Error::Validation(format!(
            "{prefix}reading must be at least {MIN_READING_CHARS} characters"
        )));
    }
    if reading.chars().count() > MAX_READING_CHARS {
        return Err(Error::Validation(format!(
            "{prefix}reading exceeds {MAX_READING_CHARS} characters"
        )));
    }
    if reading.starts_with('#') {
        return Err(Error::Validation(format!("{prefix}reading cannot start with #")));
    }

    if word.is_empty() {
        return Err(Error::Validation(format!("{prefix}word is required")));
    }
    if word.contains(['\t', '\n', '\r']) {
        return Err(Error::Validation(format!("{prefix}word cannot contain tabs or newlines")));
    }
    if word.chars().count() > MAX_WORD_CHARS {
        return Err(Error::Validation(format!("{prefix}word exceeds {MAX_WORD_CHARS} characters")));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_ever_empty_directory_seeds_vrc_sample_and_tsv(
    ) -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;

        let loaded = load_from_directory(dir.path())?;

        assert_eq!(
            loaded,
            vec![CustomDictionaryEntry {
                id: "sample-vrchat-vrc".to_string(),
                reading: "ぶいあーるちゃっと".to_string(),
                word: "VRC".to_string(),
            }]
        );

        let tsv = std::fs::read_to_string(dir.path().join(CUSTOM_DICTIONARY_TSV))?;
        assert_eq!(tsv, "ぶいあーるちゃっと\tVRC\n");

        Ok(())
    }

    #[test]
    fn existing_empty_json_is_respected() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;

        save_to_directory(dir.path(), &[])?;
        let loaded = load_from_directory(dir.path())?;

        assert!(loaded.is_empty());
        assert!(!dir.path().join(CUSTOM_DICTIONARY_TSV).exists());

        Ok(())
    }

    #[test]
    fn validation_rejects_tab_newline_short_reading_and_hash_prefix() {
        assert!(validate_entry(&CustomDictionaryEntry {
            id: "empty-reading".to_string(),
            reading: "".to_string(),
            word: "単語".to_string(),
        })
        .is_err());

        assert!(validate_entry(&CustomDictionaryEntry {
            id: "empty-word".to_string(),
            reading: "よみ".to_string(),
            word: "".to_string(),
        })
        .is_err());

        assert!(validate_entry(&CustomDictionaryEntry {
            id: "tab".to_string(),
            reading: "よ\tみ".to_string(),
            word: "単語".to_string(),
        })
        .is_err());

        assert!(validate_entry(&CustomDictionaryEntry {
            id: "newline".to_string(),
            reading: "よみ".to_string(),
            word: "単\n語".to_string(),
        })
        .is_err());

        assert!(validate_entry(&CustomDictionaryEntry {
            id: "comment".to_string(),
            reading: "#よみ".to_string(),
            word: "単語".to_string(),
        })
        .is_err());

        assert!(validate_entry(&CustomDictionaryEntry {
            id: "short".to_string(),
            reading: "あ".to_string(),
            word: "亜".to_string(),
        })
        .is_err());
    }

    #[test]
    fn validation_reports_short_reading_message() {
        let error = validate_entry(&CustomDictionaryEntry {
            id: "short".to_string(),
            reading: "あ".to_string(),
            word: "亜".to_string(),
        })
        .unwrap_err()
        .to_string();

        assert_eq!(error, "reading must be at least 2 characters");
    }

    #[test]
    fn save_rejects_duplicate_ids() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;

        let entries = vec![
            CustomDictionaryEntry {
                id: "same".to_string(),
                reading: "よみ".to_string(),
                word: "一".to_string(),
            },
            CustomDictionaryEntry {
                id: "same".to_string(),
                reading: "よみ".to_string(),
                word: "二".to_string(),
            },
        ];

        assert!(save_to_directory(dir.path(), &entries).is_err());

        Ok(())
    }

    #[test]
    fn save_rejects_more_than_one_hundred_thousand_entries() {
        let entry = CustomDictionaryEntry {
            id: "one".to_string(),
            reading: "よみ".to_string(),
            word: "単語".to_string(),
        };
        let too_many = vec![entry; 100_001];

        assert!(save_to_directory(Path::new("/tmp/not-used"), &too_many).is_err());
    }

    #[test]
    fn tsv_round_trip_and_file_matches_to_tsv(
    ) -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;

        let entries = vec![
            CustomDictionaryEntry {
                id: "one".to_string(),
                reading: "ことばびーこん".to_string(),
                word: "Kotoba Beacon".to_string(),
            },
            CustomDictionaryEntry {
                id: "two".to_string(),
                reading: "とうきょう".to_string(),
                word: "東京".to_string(),
            },
        ];

        let saved = save_to_directory(dir.path(), &entries)?;
        assert_eq!(saved, entries);

        assert_eq!(load_from_directory(dir.path())?, entries);

        let tsv = std::fs::read_to_string(dir.path().join(CUSTOM_DICTIONARY_TSV))?;
        assert_eq!(tsv, "ことばびーこん\tKotoba Beacon\nとうきょう\t東京\n");
        assert_eq!(to_tsv(&entries), tsv);

        Ok(())
    }

    #[test]
    fn empty_save_removes_generated_tsv() -> std::result::Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;

        save_to_directory(
            dir.path(),
            &[CustomDictionaryEntry {
                id: "one".to_string(),
                reading: "よみ".to_string(),
                word: "単語".to_string(),
            }],
        )?;
        save_to_directory(dir.path(), &[])?;

        assert!(!dir.path().join(CUSTOM_DICTIONARY_TSV).exists());
        assert!(load_from_directory(dir.path())?.is_empty());

        Ok(())
    }

    #[test]
    fn to_tsv_empty_entries_is_empty_string() {
        assert_eq!(to_tsv(&[]), "");
    }

    #[test]
    fn search_filters_by_reading_or_word_prefix_and_clamps_limit() {
        let entries = vec![
            CustomDictionaryEntry {
                id: "one".to_string(),
                reading: "あい".to_string(),
                word: "愛".to_string(),
            },
            CustomDictionaryEntry {
                id: "two".to_string(),
                reading: "ぶいあーるちゃっと".to_string(),
                word: "VRC".to_string(),
            },
        ];

        assert_eq!(
            search(&entries, "ぶい", 50),
            vec![CustomDictionaryEntry {
                id: "two".to_string(),
                reading: "ぶいあーるちゃっと".to_string(),
                word: "VRC".to_string(),
            }]
        );

        assert_eq!(
            search(&entries, "VRC", 50),
            vec![CustomDictionaryEntry {
                id: "two".to_string(),
                reading: "ぶいあーるちゃっと".to_string(),
                word: "VRC".to_string(),
            }]
        );

        assert_eq!(search(&entries, "か", 50), Vec::new());
        assert_eq!(search(&entries, "", 0).len(), 1);
        assert_eq!(search(&entries, "", 100).len(), 2);
    }
}
