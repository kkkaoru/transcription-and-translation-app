//! Allocation-conscious Japanese text primitives shared by Native and WebAssembly targets.

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
        let mut fields = feature.split(',').map(str::trim);
        let first = fields.next().unwrap_or("");
        let second = fields.next().unwrap_or("");
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
            conjugation_form: feature.split(',').nth(5).unwrap_or("").trim(),
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
        completion_appended_suffix_is_repeated, contains_kanji, hiragana_to_katakana_char,
        is_kanji, katakana_to_hiragana_char, strip_turn_surface_noise, MorphFeature,
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
    fn shares_script_ranges_and_kana_offsets() {
        assert!(is_kanji('晴'));
        assert!(contains_kanji("きょうは晴れ"));
        assert!(!contains_kanji("きょうははれ"));
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
