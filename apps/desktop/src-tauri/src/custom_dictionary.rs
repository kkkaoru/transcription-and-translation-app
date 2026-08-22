use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const CUSTOM_DICTIONARY_PATH_KEY: &str = "azookey-user-dictionary";
const CUSTOM_DICTIONARY_JSON: &str = "custom_dictionary.json";
const CUSTOM_DICTIONARY_TSV: &str = "custom_dictionary.tsv";
const CUSTOM_DICTIONARY_VERSION: u32 = 1;
const CUSTOM_DICTIONARY_CATALOG_VERSION: u32 = 2;
const DEFAULT_DICTIONARY_ID: &str = "default";
const DEFAULT_DICTIONARY_NAME: &str = "Custom";
const MAX_ENTRIES: usize = 100_000;
const MAX_ID_CHARS: usize = 128;
const MIN_READING_CHARS: usize = 2;
const MAX_READING_CHARS: usize = 256;
const MAX_WORD_CHARS: usize = 512;
const DEFAULT_SAMPLE_ID: &str = "sample-vrchat-vrc";
const DEFAULT_SAMPLE_READING: &str = "ぶいあーるちゃっと";
const DEFAULT_SAMPLE_WORD: &str = "VRC";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomDictionaryEntry {
    pub id: String,
    pub reading: String,
    pub word: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomDictionaryBook {
    pub id: String,
    pub name: String,
    pub entries: Vec<CustomDictionaryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomDictionaryCatalog {
    pub version: u32,
    pub active_id: String,
    pub dictionaries: Vec<CustomDictionaryBook>,
}

#[derive(Debug, Deserialize, Serialize)]
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

/// Seed the documented sample only when no dictionary file has ever existed.
/// An existing empty file means the user intentionally deleted every entry.
pub fn initialize(app: &AppHandle, config: &mut AppConfig) -> Result<(), String> {
    initialize_in_directory(&config_directory(app)?, config)
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

fn initialize_in_directory(directory: &Path, config: &mut AppConfig) -> Result<(), String> {
    let json_path = directory.join(CUSTOM_DICTIONARY_JSON);
    let tsv_path = directory.join(CUSTOM_DICTIONARY_TSV);
    if !json_path.exists()
        && (tsv_path.exists() || config.models.paths.contains_key(CUSTOM_DICTIONARY_PATH_KEY))
    {
        // A legacy/external user dictionary predates the JSON manager. Never
        // overwrite or replace its configured path with the sample.
        if tsv_path.exists() && !config.models.paths.contains_key(CUSTOM_DICTIONARY_PATH_KEY) {
            set_config_path(config, Some(&tsv_path));
        }
        return Ok(());
    }
    let entries = if json_path.exists() {
        load_from_directory(directory)?
    } else {
        vec![CustomDictionaryEntry {
            id: DEFAULT_SAMPLE_ID.to_string(),
            reading: DEFAULT_SAMPLE_READING.to_string(),
            word: DEFAULT_SAMPLE_WORD.to_string(),
        }]
    };
    let (_, dictionary_path) = save_to_directory(directory, entries)?;
    set_config_path(config, dictionary_path.as_deref());
    Ok(())
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
    active_entries_from_document(document)
}

fn active_entries_from_document(
    document: CustomDictionaryFile,
) -> Result<Vec<CustomDictionaryEntry>, String> {
    if document.version == CUSTOM_DICTIONARY_CATALOG_VERSION {
        let catalog = catalog_from_document(document)?;
        let active = catalog
            .dictionaries
            .iter()
            .find(|book| book.id == catalog.active_id)
            .or_else(|| catalog.dictionaries.first());
        return match active {
            Some(book) => validate_entries(book.entries.clone()),
            None => Ok(Vec::new()),
        };
    }
    if document.version != CUSTOM_DICTIONARY_VERSION {
        return Err(format!("unsupported custom dictionary version: {}", document.version));
    }
    validate_entries(document.entries)
}

fn catalog_from_document(
    document: CustomDictionaryFile,
) -> Result<CustomDictionaryCatalog, String> {
    if let Some(dictionaries) = document.dictionaries {
        let validated = dictionaries
            .into_iter()
            .map(|book| {
                Ok(CustomDictionaryBook {
                    id: book.id.trim().to_string(),
                    name: book.name.trim().to_string(),
                    entries: validate_entries(book.entries)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if validated.is_empty() {
            return Err("custom dictionary catalog has no dictionaries".to_string());
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
            entries: validate_entries(document.entries)?,
        }],
    })
}

pub fn search_entries(
    entries: &[CustomDictionaryEntry],
    query: &str,
    limit: usize,
) -> Vec<CustomDictionaryEntry> {
    let needle = query.trim();
    entries
        .iter()
        .filter(|entry| {
            needle.is_empty() || entry.reading.starts_with(needle) || entry.word.starts_with(needle)
        })
        .take(limit.clamp(1, 50))
        .cloned()
        .collect()
}

fn save_to_directory(
    directory: &Path,
    entries: Vec<CustomDictionaryEntry>,
) -> Result<(Vec<CustomDictionaryEntry>, Option<PathBuf>), String> {
    let entries = validate_entries(entries)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("could not create custom dictionary directory: {error}"))?;

    let document = CustomDictionaryFile {
        version: CUSTOM_DICTIONARY_VERSION,
        active_id: None,
        dictionaries: None,
        entries: entries.clone(),
    };
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
    if name == "reading" && value.chars().count() < MIN_READING_CHARS {
        return Err(format!(
            "entry {number} {name} must be at least {MIN_READING_CHARS} characters"
        ));
    }
    if value.chars().count() > max_chars {
        return Err(format!("entry {number} {name} exceeds {max_chars} characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        initialize_in_directory, load_from_directory, save_to_directory, set_config_path,
        CustomDictionaryEntry, CUSTOM_DICTIONARY_JSON, CUSTOM_DICTIONARY_PATH_KEY,
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
    fn first_initialization_seeds_vrc_sample_and_generates_conversion_tsv() {
        let directory = temporary_directory("default-sample");
        let mut config = AppConfig::default();
        initialize_in_directory(&directory, &mut config).expect("initialization should succeed");
        let tsv_path = PathBuf::from(
            config
                .models
                .paths
                .get(CUSTOM_DICTIONARY_PATH_KEY)
                .expect("sample should configure TSV"),
        );
        assert_eq!(
            load_from_directory(&directory).expect("sample should load"),
            vec![entry("sample-vrchat-vrc", "ぶいあーるちゃっと", "VRC")]
        );
        assert_eq!(
            std::fs::read_to_string(tsv_path).expect("sample TSV should read"),
            "ぶいあーるちゃっと\tVRC\n"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn initialization_respects_an_existing_intentionally_empty_dictionary() {
        let directory = temporary_directory("existing-empty");
        save_to_directory(&directory, Vec::new()).expect("empty dictionary should save");
        let mut config = AppConfig::default();
        initialize_in_directory(&directory, &mut config).expect("initialization should succeed");
        assert!(load_from_directory(&directory).expect("dictionary should load").is_empty());
        assert!(!config.models.paths.contains_key(CUSTOM_DICTIONARY_PATH_KEY));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn initialization_preserves_a_configured_external_user_dictionary() {
        let directory = temporary_directory("external-path");
        let external = directory.join("external.tsv");
        std::fs::create_dir_all(&directory).expect("directory should exist");
        std::fs::write(&external, "おりじなる\tOriginal\n").expect("external TSV should write");
        let mut config = AppConfig::default();
        set_config_path(&mut config, Some(&external));

        initialize_in_directory(&directory, &mut config).expect("initialization should succeed");

        assert_eq!(
            config.models.paths.get(CUSTOM_DICTIONARY_PATH_KEY).map(String::as_str),
            Some(external.to_string_lossy().as_ref())
        );
        assert!(!directory.join(CUSTOM_DICTIONARY_JSON).exists());
        assert_eq!(
            std::fs::read_to_string(&external).expect("external TSV should read"),
            "おりじなる\tOriginal\n"
        );
        let _ = std::fs::remove_dir_all(directory);
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
    fn search_entries_filters_by_reading_or_word_prefix() {
        let entries = vec![entry("one", "あい", "愛"), entry("two", "ぶいあーるちゃっと", "VRC")];
        assert_eq!(
            super::search_entries(&entries, "ぶい", 50),
            vec![entry("two", "ぶいあーるちゃっと", "VRC")]
        );
        assert_eq!(
            super::search_entries(&entries, "VRC", 50),
            vec![entry("two", "ぶいあーるちゃっと", "VRC")]
        );
        assert_eq!(super::search_entries(&entries, "か", 50), Vec::new());
    }

    #[test]
    fn validation_rejects_one_character_reading() {
        let directory = temporary_directory("short-reading");
        assert_eq!(
            save_to_directory(&directory, vec![entry("short", "あ", "亜")])
                .expect_err("one-character reading should fail"),
            "entry 1 reading must be at least 2 characters"
        );
        let (saved, _) = save_to_directory(&directory, vec![entry("ok", "あい", "愛")])
            .expect("two-character reading should save");
        assert_eq!(saved, vec![entry("ok", "あい", "愛")]);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn validation_rejects_more_than_one_hundred_thousand_entries() {
        let directory = temporary_directory("too-many");
        let too_many = vec![entry("one", "よみ", "単語"); 100_001];
        assert_eq!(
            save_to_directory(&directory, too_many).expect_err("over-limit dictionary should fail"),
            "custom dictionary supports at most 100000 entries"
        );
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
