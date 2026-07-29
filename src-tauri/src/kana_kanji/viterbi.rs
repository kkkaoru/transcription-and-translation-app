use super::dictionary::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
use super::normalization::{contains_kanji, is_boundary, numeric_surface, to_hiragana};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConversionOptions {
    pub n_best: usize,
    pub max_dictionary_word_chars: usize,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        Self { n_best: 5, max_dictionary_word_chars: 24 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversionCandidate {
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone)]
struct PathState {
    text: String,
    score: f32,
    last: Option<DictionaryEntry>,
}

pub fn convert_kana_to_kanji(input: &str) -> String {
    convert_with_dictionary(input, &AzooKeyDictionary::default(), ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .unwrap_or_else(|| input.trim().to_string())
}

pub fn convert_kana_to_kanji_with_dictionary(input: &str, path: &str) -> Result<String, String> {
    convert_kana_to_kanji_with_paths(
        input,
        DictionaryPaths { system: Some(path.into()), ..DictionaryPaths::default() },
    )
}

pub fn convert_kana_to_kanji_with_paths(
    input: &str,
    paths: DictionaryPaths,
) -> Result<String, String> {
    let dictionary = AzooKeyDictionary::from_paths(&paths)?;
    Ok(convert_with_dictionary(input, &dictionary, ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .unwrap_or_else(|| input.trim().to_string()))
}

pub fn convert_with_dictionary(
    input: &str,
    dictionary: &AzooKeyDictionary,
    options: ConversionOptions,
) -> Vec<ConversionCandidate> {
    let trimmed = input.trim();
    if trimmed.is_empty() || contains_kanji(trimmed) {
        return vec![ConversionCandidate { text: trimmed.to_string(), score: 0.0 }];
    }
    let chars = to_hiragana(trimmed).chars().collect::<Vec<_>>();
    let width = options.n_best.clamp(1, 32);
    let mut states = vec![Vec::<PathState>::new(); chars.len() + 1];
    states[0].push(PathState { text: String::new(), score: 0.0, last: None });

    for start in 0..chars.len() {
        let current = states[start].clone();
        if current.is_empty() {
            continue;
        }
        let entries = dictionary
            .entries_starting_at(&chars, start, options.max_dictionary_word_chars.clamp(1, 128))
            .unwrap_or_default();
        for state in current {
            let numeric_length = chars[start..]
                .iter()
                .take_while(|character| {
                    character.is_ascii_digit() || ('０'..='９').contains(character)
                })
                .count();
            if numeric_length > 0 {
                let numeric_reading: String = chars[start..start + numeric_length].iter().collect();
                if let Some(surface) = numeric_surface(&numeric_reading) {
                    push_state(
                        &mut states[start + numeric_length],
                        PathState {
                            text: format!("{}{}", state.text, surface),
                            score: state.score - 1.0,
                            last: None,
                        },
                        width,
                    );
                }
            }
            push_state(
                &mut states[start + 1],
                PathState {
                    text: format!("{}{}", state.text, chars[start]),
                    score: state.score - 0.8,
                    last: None,
                },
                width,
            );
            if is_boundary(chars[start]) {
                push_state(
                    &mut states[start + 1],
                    PathState {
                        text: format!("{}{}", state.text, chars[start]),
                        score: state.score,
                        last: None,
                    },
                    width,
                );
            }
            for entry in &entries {
                let entry_len = entry.reading.chars().count();
                let end = start + entry_len;
                if end > chars.len()
                    || chars[start..end].iter().collect::<String>() != entry.reading
                {
                    continue;
                }
                let connection = state
                    .last
                    .as_ref()
                    .map(|former| dictionary.connection_cost(former, entry))
                    .unwrap_or(0.0);
                push_state(
                    &mut states[end],
                    PathState {
                        text: format!("{}{}", state.text, entry.surface),
                        score: state.score + entry.value + connection,
                        last: Some(entry.clone()),
                    },
                    width,
                );
            }
        }
    }
    let mut results = states[chars.len()]
        .iter()
        .map(|state| ConversionCandidate { text: state.text.clone(), score: state.score })
        .collect::<Vec<_>>();
    if results.is_empty() {
        results.push(ConversionCandidate { text: trimmed.to_string(), score: 0.0 });
    }
    results
}

fn push_state(states: &mut Vec<PathState>, candidate: PathState, width: usize) {
    states.push(candidate);
    states.sort_by(|left, right| left.score.total_cmp(&right.score));
    states.dedup_by(|left, right| left.text == right.text);
    states.truncate(width);
}

#[cfg(test)]
mod tests {
    use super::{convert_kana_to_kanji, convert_with_dictionary, ConversionOptions};
    use crate::kana_kanji::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
    use std::fs;

    #[test]
    fn converts_known_readings_with_the_builtin_dictionary() {
        assert_eq!(convert_kana_to_kanji("きょうははいしんです"), "今日は配信です");
    }

    #[test]
    fn preserves_existing_kanji() {
        assert_eq!(convert_kana_to_kanji("今日は配信です"), "今日は配信です");
    }

    #[test]
    fn normalizes_fullwidth_numeric_special_conversion() {
        assert_eq!(convert_kana_to_kanji("１２３"), "123");
    }

    #[test]
    fn selects_user_dictionary_entry_and_returns_n_best() {
        let root = std::env::temp_dir().join(format!("caption-bridge-{}", std::process::id()));
        fs::write(&root, "はいしん\t配信中\t-99\n").expect("fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("TSV dictionary should load");
        let results = convert_with_dictionary(
            "はいしん",
            &dictionary,
            ConversionOptions { n_best: 2, ..ConversionOptions::default() },
        );
        assert_eq!(results[0].text, "配信中");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn dictionary_entry_metadata_is_available_to_callers() {
        let entry = DictionaryEntry::plain("はいしん", "配信", -10.0);
        assert_eq!(entry.mid, 501);
    }
}
