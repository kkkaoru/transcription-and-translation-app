//! Allocation-conscious Japanese text primitives shared by Native and WebAssembly targets.

/// Return one field from a CSV-style morphological feature record without allocating.
///
/// UniDic fields can contain quoted commas (for example `"B,B4WB7G9G"`). A
/// plain `split(',')` shifts every later field and can turn the kana field into
/// an unrelated value. Escaped quotes are skipped while scanning; surrounding
/// quotes are removed from the returned field.
pub fn comma_separated_feature_field(feature: &str, target_index: usize) -> Option<&str> {
    let bytes = feature.as_bytes();
    let mut field_index = 0;
    let mut field_start = 0;
    let mut cursor = 0;
    let mut in_quotes = false;

    while cursor < bytes.len() {
        match bytes[cursor] {
            b'"' if in_quotes && bytes.get(cursor + 1) == Some(&b'"') => {
                cursor += 2;
                continue;
            }
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                if field_index == target_index {
                    return Some(trim_feature_field(&feature[field_start..cursor]));
                }
                field_index += 1;
                field_start = cursor + 1;
            }
            _ => {}
        }
        cursor += 1;
    }
    (field_index == target_index).then(|| trim_feature_field(&feature[field_start..]))
}

fn trim_feature_field(field: &str) -> &str {
    let field = field.trim();
    field.strip_prefix('"').and_then(|field| field.strip_suffix('"')).unwrap_or(field)
}

/// Parsed POS head from an IPADIC/UniDic comma-separated feature record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MorphFeatureHead<'a> {
    pub pos1: &'a str,
    pub pos2: &'a str,
}

impl<'a> MorphFeatureHead<'a> {
    /// Parse both split fields (`名詞,普通名詞,...`) and UniDic's combined
    /// first field (`名詞-普通名詞,...`) without allocating or scanning the tail.
    pub fn parse(feature: &'a str) -> Self {
        let first = comma_separated_feature_field(feature, 0).unwrap_or("");
        let second = comma_separated_feature_field(feature, 1).unwrap_or("");
        let (pos1, combined_pos2) = first.split_once('-').unwrap_or((first, ""));
        Self {
            pos1: pos1.trim(),
            pos2: if combined_pos2.trim().is_empty() { second } else { combined_pos2.trim() },
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MorphFeature<'a> {
    pub pos1: &'a str,
    pub pos2: &'a str,
    pub conjugation_form: &'a str,
}

impl<'a> MorphFeature<'a> {
    pub fn parse(feature: &'a str) -> Self {
        let head = MorphFeatureHead::parse(feature);
        Self {
            pos1: head.pos1,
            pos2: head.pos2,
            conjugation_form: comma_separated_feature_field(feature, 5).unwrap_or(""),
        }
    }
}

/// Return whether a scalar is in the CJK Extension A, Unified Ideographs, or
/// Compatibility Ideographs ranges used by both conversion pipelines.
pub fn is_kanji(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

pub fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_kanji)
}

pub fn is_basic_katakana(character: char) -> bool {
    ('ァ'..='ヶ').contains(&character)
}

/// Return whether every scalar is kana that can appear in a morphological
/// reading. Rejecting unrelated fields provides a lossless surface fallback if
/// a future dictionary schema moves the configured reading column.
pub fn is_japanese_kana_text(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|character| matches!(character, 'ぁ'..='ゖ' | 'ァ'..='ヺ' | 'ー'))
}

pub fn katakana_to_hiragana_char(character: char) -> char {
    if is_basic_katakana(character) {
        char::from_u32(character as u32 - ('ァ' as u32 - 'ぁ' as u32)).unwrap_or(character)
    } else {
        character
    }
}

pub fn hiragana_to_katakana_char(character: char) -> char {
    if ('ぁ'..='ゖ').contains(&character) {
        char::from_u32(character as u32 + ('ァ' as u32 - 'ぁ' as u32)).unwrap_or(character)
    } else {
        character
    }
}

/// Compare a completion suffix without materializing `existing + incoming`.
pub fn completion_appended_suffix_is_repeated(existing: &str, incoming: &str) -> bool {
    let suffix = incoming.trim();
    existing.starts_with(suffix) || suffix.starts_with(existing)
}

/// Remove surrounding whitespace and trailing ASR sentence-noise punctuation
/// without allocating. This is the canonical Native turn-comparison surface.
pub fn strip_turn_surface_noise(text: &str) -> &str {
    text.trim().trim_end_matches(['.', '。', '…', '⋯']).trim_end_matches("...").trim()
}

#[cfg(test)]
mod tests {
    use super::{
        comma_separated_feature_field, completion_appended_suffix_is_repeated, contains_kanji,
        hiragana_to_katakana_char, is_japanese_kana_text, is_kanji, katakana_to_hiragana_char,
        strip_turn_surface_noise, MorphFeature,
    };

    #[test]
    fn parses_ipadic_and_unidic_feature_heads_without_allocating() {
        let ipadic = MorphFeature::parse("名詞,固有名詞,地名,一般,*,終止形");
        assert_eq!(
            (ipadic.pos1, ipadic.pos2, ipadic.conjugation_form),
            ("名詞", "固有名詞", "終止形")
        );

        let unidic = MorphFeature::parse("名詞-普通名詞,一般,*,*,*,終止形-一般");
        assert_eq!(
            (unidic.pos1, unidic.pos2, unidic.conjugation_form),
            ("名詞", "普通名詞", "終止形-一般")
        );
    }

    #[test]
    fn parses_feature_fields_after_quoted_commas_without_shifting() {
        let feature =
            "名詞,普通名詞,助数詞可能,*,*,*,ド,度,度,ド,度,ド,漢,*,*,*,*,*,\"B,B4WB7G9G\",体,ド,ド";

        assert_eq!(comma_separated_feature_field(feature, 18), Some("B,B4WB7G9G"));
        assert_eq!(comma_separated_feature_field(feature, 19), Some("体"));
        assert_eq!(comma_separated_feature_field(feature, 20), Some("ド"));
        assert_eq!(comma_separated_feature_field(feature, 21), Some("ド"));
        assert_eq!(comma_separated_feature_field(feature, 22), None);
    }

    #[test]
    fn shares_script_ranges_and_kana_offsets() {
        assert!(is_kanji('晴'));
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
        assert!(is_japanese_kana_text("ロクジュウド"));
        assert!(is_japanese_kana_text("ろくじゅうど"));
        assert!(!is_japanese_kana_text("体"));
        assert!(!is_japanese_kana_text(""));
        assert_eq!(katakana_to_hiragana_char('キ'), 'き');
        assert_eq!(hiragana_to_katakana_char('き'), 'キ');
        assert_eq!(katakana_to_hiragana_char('ー'), 'ー');
    }

    #[test]
    fn compares_appended_suffixes_without_building_candidates() {
        assert!(completion_appended_suffix_is_repeated("字幕", "字幕の続き"));
        assert!(completion_appended_suffix_is_repeated("字幕の続き", "字幕"));
        assert!(!completion_appended_suffix_is_repeated("字幕", "追加"));
    }

    #[test]
    fn strips_only_the_canonical_turn_surface_noise() {
        assert_eq!(strip_turn_surface_noise(" こんにちは... "), "こんにちは");
        assert_eq!(strip_turn_surface_noise("こんにちは！？"), "こんにちは！？");
    }
}
