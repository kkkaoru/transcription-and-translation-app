use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const CUSTOM_DICTIONARY_PATH_KEY: &str = "azookey-user-dictionary";
const CUSTOM_DICTIONARY_JSON: &str = "custom_dictionary.json";
const CUSTOM_DICTIONARY_TSV: &str = "custom_dictionary.tsv";
const CUSTOM_DICTIONARY_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 10_000;
const MAX_ID_CHARS: usize = 128;
const MAX_READING_CHARS: usize = 256;
const MAX_WORD_CHARS: usize = 512;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomDictionaryEntry {
    pub id: String,
    pub reading: String,
    pub word: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomDictionaryFile {
    version: u32,
    entries: Vec<CustomDictionaryEntry>,
}

pub fn load(app: &AppHandle) -> Result<Vec<CustomDictionaryEntry>, String> {
    let directory = config_directory(app)?;
    load_from_directory(&directory)
}

pub fn save(
    app: &AppHandle,
    entries: Vec<CustomDictionaryEntry>,
) -> Result<(Vec<CustomDictionaryEntry>, Option<PathBuf>), String> {
    let directory = config_directory(app)?;
    save_to_directory(&directory, entries)
}

pub fn set_config_path(config: &mut AppConfig, dictionary_path: Option<&Path>) {
    match dictionary_path {
        Some(path) => {
            config.models.paths.insert(
                CUSTOM_DICTIONARY_PATH_KEY.to_string(),
                path.to_string_lossy().into_owned(),
            );
        }
        None => {
            config.models.paths.remove(CUSTOM_DICTIONARY_PATH_KEY);
        }
    }
}

fn config_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))
}

fn load_from_directory(directory: &Path) -> Result<Vec<CustomDictionaryEntry>, String> {
    let path = directory.join(CUSTOM_DICTIONARY_JSON);
    let body = match std::fs::read_to_string(&path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("could not read custom dictionary: {error}")),
    };
    let document: CustomDictionaryFile = serde_json::from_str(&body)
        .map_err(|error| format!("custom dictionary JSON is invalid: {error}"))?;
    if document.version != CUSTOM_DICTIONARY_VERSION {
        return Err(format!("unsupported custom dictionary version: {}", document.version));
    }
    validate_entries(document.entries)
}

fn save_to_directory(
    directory: &Path,
    entries: Vec<CustomDictionaryEntry>,
) -> Result<(Vec<CustomDictionaryEntry>, Option<PathBuf>), String> {
    let entries = validate_entries(entries)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("could not create custom dictionary directory: {error}"))?;

    let document =
        CustomDictionaryFile { version: CUSTOM_DICTIONARY_VERSION, entries: entries.clone() };
    let json = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("could not serialize custom dictionary: {error}"))?;
    std::fs::write(directory.join(CUSTOM_DICTIONARY_JSON), json)
        .map_err(|error| format!("could not write custom dictionary JSON: {error}"))?;

    let tsv_path = directory.join(CUSTOM_DICTIONARY_TSV);
    if entries.is_empty() {
        match std::fs::remove_file(&tsv_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not remove custom dictionary TSV: {error}")),
        }
        return Ok((entries, None));
    }

    let tsv = entries
        .iter()
        .map(|entry| format!("{}\t{}", entry.reading, entry.word))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&tsv_path, tsv)
        .map_err(|error| format!("could not write custom dictionary TSV: {error}"))?;
    Ok((entries, Some(tsv_path)))
}

fn validate_entries(
    entries: Vec<CustomDictionaryEntry>,
) -> Result<Vec<CustomDictionaryEntry>, String> {
    if entries.len() > MAX_ENTRIES {
        return Err(format!("custom dictionary supports at most {MAX_ENTRIES} entries"));
    }
    let mut ids = HashSet::with_capacity(entries.len());
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            let id = entry.id.trim().to_string();
            let reading = entry.reading.trim().to_string();
            let word = entry.word.trim().to_string();
            let number = index + 1;
            if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
                return Err(format!("entry {number} has an invalid id"));
            }
            if !ids.insert(id.clone()) {
                return Err(format!("entry {number} has a duplicate id"));
            }
            validate_field(number, "reading", &reading, MAX_READING_CHARS)?;
            validate_field(number, "word", &word, MAX_WORD_CHARS)?;
            if reading.starts_with('#') {
                return Err(format!("entry {number} reading cannot start with #"));
            }
            Ok(CustomDictionaryEntry { id, reading, word })
        })
        .collect()
}

fn validate_field(number: usize, name: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("entry {number} {name} is required"));
    }
    if value.contains(['\t', '\n', '\r']) {
        return Err(format!("entry {number} {name} cannot contain tabs or newlines"));
    }
    if value.chars().count() > max_chars {
        return Err(format!("entry {number} {name} exceeds {max_chars} characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        load_from_directory, save_to_directory, set_config_path, CustomDictionaryEntry,
        CUSTOM_DICTIONARY_PATH_KEY,
    };
    use crate::config::AppConfig;
    use std::path::PathBuf;

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "caption-bridge-custom-dictionary-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn entry(id: &str, reading: &str, word: &str) -> CustomDictionaryEntry {
        CustomDictionaryEntry {
            id: id.to_string(),
            reading: reading.to_string(),
            word: word.to_string(),
        }
    }

    #[test]
    fn missing_dictionary_loads_as_empty() {
        let directory = temporary_directory("missing");
        assert_eq!(load_from_directory(&directory).expect("missing file is empty"), Vec::new());
    }

    #[test]
    fn save_round_trips_json_and_generates_two_column_tsv() {
        let directory = temporary_directory("round-trip");
        let entries = vec![
            entry("one", "ことばびーこん", "Kotoba Beacon"),
            entry("two", "とうきょう", "東京"),
        ];
        let (saved, tsv_path) =
            save_to_directory(&directory, entries.clone()).expect("dictionary should save");

        assert_eq!(saved, entries);
        assert_eq!(load_from_directory(&directory).expect("dictionary should load"), entries);
        let tsv = std::fs::read_to_string(tsv_path.expect("non-empty dictionary has TSV"))
            .expect("TSV should read");
        assert_eq!(tsv, "ことばびーこん\tKotoba Beacon\nとうきょう\t東京\n");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn empty_save_removes_generated_tsv() {
        let directory = temporary_directory("empty");
        save_to_directory(&directory, vec![entry("one", "よみ", "単語")])
            .expect("seed should save");
        let (_, tsv_path) = save_to_directory(&directory, Vec::new()).expect("empty should save");
        assert!(tsv_path.is_none());
        assert!(!directory.join("custom_dictionary.tsv").exists());
        assert!(load_from_directory(&directory).expect("empty should load").is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn validation_rejects_tsv_breakage_but_allows_duplicate_readings() {
        let directory = temporary_directory("validation");
        let duplicate_readings =
            vec![entry("one", "こうしょう", "交渉"), entry("two", "こうしょう", "工廠")];
        save_to_directory(&directory, duplicate_readings)
            .expect("duplicate readings are candidates");

        for invalid in [
            entry("empty-reading", "", "単語"),
            entry("empty-word", "よみ", ""),
            entry("tab", "よ\tみ", "単語"),
            entry("newline", "よみ", "単\n語"),
            entry("comment", "#よみ", "単語"),
        ] {
            assert!(save_to_directory(&directory, vec![invalid]).is_err());
        }
        assert!(save_to_directory(
            &directory,
            vec![entry("same", "よみ", "一"), entry("same", "よみ", "二")]
        )
        .is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn config_path_update_preserves_unrelated_model_paths() {
        let mut config = AppConfig::default();
        config.models.paths.insert("other".into(), "/models/other".into());
        let path = PathBuf::from("/tmp/custom_dictionary.tsv");
        set_config_path(&mut config, Some(&path));
        assert_eq!(
            config.models.paths.get(CUSTOM_DICTIONARY_PATH_KEY).map(String::as_str),
            Some("/tmp/custom_dictionary.tsv")
        );
        assert_eq!(config.models.paths.get("other").map(String::as_str), Some("/models/other"));
        set_config_path(&mut config, None);
        assert!(!config.models.paths.contains_key(CUSTOM_DICTIONARY_PATH_KEY));
        assert!(config.models.paths.contains_key("other"));
    }
}
