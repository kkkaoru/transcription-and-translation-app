use std::borrow::Cow;

const KATAKANA_START: u32 = 0x30a1;
const KATAKANA_END: u32 = 0x30f6;
const HIRAGANA_START: u32 = 0x3041;
const HIRAGANA_END: u32 = 0x3096;
const FULLWIDTH_ASCII_START: u32 = 0xff01;
const FULLWIDTH_ASCII_END: u32 = 0xff5e;
const FULLWIDTH_ASCII_OFFSET: u32 = 0xfee0;
const KANA_SCRIPT_OFFSET: u32 = 0x60;

pub(crate) fn to_hiragana_cow(input: &str) -> Cow<'_, str> {
    let needs_conversion = input.chars().any(|character| {
        let code = character as u32;
        (KATAKANA_START..=KATAKANA_END).contains(&code)
            || (FULLWIDTH_ASCII_START..=FULLWIDTH_ASCII_END).contains(&code)
    });
    if !needs_conversion {
        return Cow::Borrowed(input);
    }
    Cow::Owned(
        input
            .chars()
            .map(|character| {
                let code = character as u32;
                if (KATAKANA_START..=KATAKANA_END).contains(&code) {
                    char::from_u32(code - KANA_SCRIPT_OFFSET).unwrap_or(character)
                } else if (FULLWIDTH_ASCII_START..=FULLWIDTH_ASCII_END).contains(&code) {
                    char::from_u32(code - FULLWIDTH_ASCII_OFFSET).unwrap_or(character)
                } else {
                    character
                }
            })
            .collect(),
    )
}

pub(crate) fn to_hiragana(input: &str) -> String {
    to_hiragana_cow(input).into_owned()
}

pub(crate) fn to_katakana(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            let code = character as u32;
            if (HIRAGANA_START..=HIRAGANA_END).contains(&code) {
                char::from_u32(code + KANA_SCRIPT_OFFSET).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

pub(crate) fn is_boundary(character: char) -> bool {
    character.is_whitespace() || "、。！？,.!?()（）「」『』【】[]{}\"'".contains(character)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NumeralToken {
    Digit(u128),
    SmallUnit(u128),
    LargeUnit(u128),
}

// Japanese spoken numerals are not represented by the ASCII-number edges in
// the compact dictionary. Keep this list lexical (rather than phrase based)
// so inflected/counter forms can be handled by the same parser. The variants
// cover the common sound changes (`さんびゃく`, `さんぜん`, `はっせん`, …).
const JAPANESE_NUMERAL_LEXEMES: &[(&str, NumeralToken)] = &[
    ("ちょう", NumeralToken::LargeUnit(1_000_000_000_000)),
    ("きゅう", NumeralToken::Digit(9)),
    ("ひゃく", NumeralToken::SmallUnit(100)),
    ("ひゃっ", NumeralToken::SmallUnit(100)),
    ("びゃく", NumeralToken::SmallUnit(100)),
    ("ぴゃく", NumeralToken::SmallUnit(100)),
    ("じゅう", NumeralToken::SmallUnit(10)),
    ("じゅっ", NumeralToken::SmallUnit(10)),
    ("せん", NumeralToken::SmallUnit(1_000)),
    ("ぜん", NumeralToken::SmallUnit(1_000)),
    ("まん", NumeralToken::LargeUnit(10_000)),
    ("おく", NumeralToken::LargeUnit(100_000_000)),
    ("けい", NumeralToken::LargeUnit(10_000_000_000_000_000)),
    ("ぜろ", NumeralToken::Digit(0)),
    ("れい", NumeralToken::Digit(0)),
    ("いち", NumeralToken::Digit(1)),
    ("いっ", NumeralToken::Digit(1)),
    ("に", NumeralToken::Digit(2)),
    ("さん", NumeralToken::Digit(3)),
    ("よん", NumeralToken::Digit(4)),
    ("し", NumeralToken::Digit(4)),
    ("ご", NumeralToken::Digit(5)),
    ("ろく", NumeralToken::Digit(6)),
    ("ろっ", NumeralToken::Digit(6)),
    ("なな", NumeralToken::Digit(7)),
    ("しち", NumeralToken::Digit(7)),
    // The shortened 4 reading is used before some counters (`よねん`,
    // `よにん`) and must remain available to the generic counter edge.
    ("よ", NumeralToken::Digit(4)),
    ("はち", NumeralToken::Digit(8)),
    ("はっ", NumeralToken::Digit(8)),
    ("く", NumeralToken::Digit(9)),
];

/// Return the longest valid numeric prefix of a normalized kana span.
///
/// A number can be followed by a counter (`さんびゃくえん`, `いちにち`) or
/// another dictionary edge, so requiring the whole input to be numeric would
/// leave spoken numbers embedded in captions untouched. A bare digit is
/// accepted only when it consumes the whole span, is immediately followed by
/// a known counter, or ends at punctuation. `ほん` is intentionally not a
/// counter prefix here:
/// accepting it would turn the ordinary word `にほん` into `2ほん`.
pub(crate) fn numeric_surface_prefix(reading: &[char]) -> Option<(usize, String)> {
    if reading.is_empty() {
        return None;
    }
    for length in (1..=reading.len()).rev() {
        let candidate: String = reading[..length].iter().collect();
        let Some(surface) = numeric_surface(&candidate).or_else(|| {
            // `よ` is a contracted 4-reading used before counters (`よねん`,
            // `よにん`), not a standalone number. Keep it contextual rather
            // than converting an ordinary one-character `よ`.
            (candidate == "よ" && japanese_counter_starts_at(&reading[length..]))
                .then(|| "4".to_string())
        }) else {
            continue;
        };
        if length == reading.len()
            || japanese_numeral_has_unit(&candidate)
            || japanese_counter_starts_at(&reading[length..])
            || {
                // Pure unit glyphs (°/℃/°C) often interrupt digit→percent
                // attachment in ASR/neural garble. Skip them only when a
                // percent-class counter still follows so `60°わらび` stays
                // numeric without deleting ° before 回/度-class counters.
                let skip = skip_intervening_numeric_unit_noise(&reading[length..]);
                skip > 0 && japanese_percent_counter_starts_at(&reading[length + skip..])
            }
            || reading.get(length).is_some_and(|character| is_boundary(*character))
        {
            return Some((length, surface));
        }
    }
    None
}

/// Glyphs that are temperature/angle unit marks, not kana readings.
///
/// Captions sometimes insert these between an arabic digit span and a spoken
/// percent counter (`60°わらび`, `90℃ぱーせんと`). They are not themselves
/// counters and must not split the digit run into dictionary fragments
/// (`0`→`〇`) before the percent counter can attach.
///
/// Prime marks (`′` / `″`) are intentionally excluded: this repo has no ASR
/// evidence of digit-prime-counter noise, and `5′30″` is digits-prime-digits.
pub(crate) fn is_skippable_numeric_unit_glyph(character: char) -> bool {
    matches!(character, '°' | '℃' | '℉' | '゜' | 'ﾟ')
}

/// Percent-class spoken counters that attach after arabic digits.
///
/// Only these surfaces authorize skipping intervening unit-mark noise. Generic
/// counters such as `かい` / `ど` / `えん` must keep a preceding degree mark.
pub(crate) fn japanese_percent_counter_starts_at(reading: &[char]) -> bool {
    ["ぱーせんと", "わらび", "蕨"].iter().any(|counter| {
        let counter_chars = counter.chars().collect::<Vec<_>>();
        reading.len() >= counter_chars.len()
            && reading[..counter_chars.len()] == counter_chars
            && reading.get(counter_chars.len()).is_none_or(|next| {
                !matches!(next, 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'ゃ' | 'ゅ' | 'ょ' | 'っ')
            })
    })
}

/// Count leading unit-mark noise before a percent counter reading.
///
/// Returns 0 unless a percent-class counter follows the marks, so legitimate
/// degree text (`90°かいてん`, `90°ど`, bare `90°`) keeps its unit glyph.
/// After one or more unit glyphs, an optional ASCII `C`/`F` (as in `°C` /
/// `°F`) is consumed only when that percent counter still follows. Bare
/// temperature letters without a percent counter (`90°Cてんき`, `90°Coffee`)
/// are left untouched.
pub(crate) fn skip_intervening_numeric_unit_noise(reading: &[char]) -> usize {
    let mut index = 0;
    while index < reading.len() && is_skippable_numeric_unit_glyph(reading[index]) {
        index += 1;
    }
    if index == 0 {
        return 0;
    }
    let mut after = index;
    if after < reading.len()
        && matches!(reading[after], 'C' | 'F' | 'c' | 'f')
        && japanese_percent_counter_starts_at(&reading[after + 1..])
    {
        after += 1;
    }
    if japanese_percent_counter_starts_at(&reading[after..]) {
        after
    } else {
        0
    }
}

pub(crate) fn numeric_surface(reading: &str) -> Option<String> {
    let normalized = to_hiragana(reading);
    // `ぜん` is the rendaku form used after a preceding digit (`さんぜん`,
    // `はっせん`), not a standalone numeral in ordinary Japanese.  Treating
    // it as an implicit 1,000 lets a word such as `かいぜん` split into
    // `かい` + `1000`; requiring the preceding numeric token keeps the
    // conversion generic without embedding a phrase-specific exception.
    if normalized == "ぜん" {
        return None;
    }
    if normalized == "よ" {
        return None;
    }
    let digits: String = normalized
        .chars()
        .map(|character| match character {
            '０'..='９' => {
                char::from_u32(character as u32 - FULLWIDTH_ASCII_OFFSET).unwrap_or(character)
            }
            _ => character,
        })
        .collect();
    if !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()) {
        return Some(digits);
    }
    parse_japanese_numeral(&normalized).map(|number| number.to_string())
}

/// Return whether a spoken-numeral span starts with an explicit digit.
///
/// Unit-only spans such as `じゅう` are useful at a sentence boundary, but a
/// unit found in the middle of an ordinary word (`そうじゅう`, `あまん`) must
/// not become a number merely because a counter happens to follow it. This
/// helper lets the lattice apply that boundary rule without exposing the
/// tokenizer itself.
pub(crate) fn numeric_span_starts_with_digit(reading: &str) -> bool {
    let normalized = to_hiragana(reading);
    if normalized
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit() || ('０'..='９').contains(&character))
    {
        return true;
    }
    tokenize_japanese_numeral(&normalized)
        .and_then(|tokens| tokens.first().copied())
        .is_some_and(|token| matches!(token, NumeralToken::Digit(_)))
}

pub(crate) fn japanese_numeral_has_unit(reading: &str) -> bool {
    tokenize_japanese_numeral(reading)
        .map(|tokens| {
            tokens.iter().any(|token| {
                matches!(token, NumeralToken::SmallUnit(_) | NumeralToken::LargeUnit(_))
            })
        })
        .unwrap_or(false)
}

const JAPANESE_NUMERAL_COUNTERS: &[(&str, &str)] = &[
    ("えん", "円"),
    ("にち", "日"),
    ("にん", "人"),
    ("じ", "時"),
    // Spoken clock readings contract `時半` as `じはん`; consume the
    // compound counter so `しちじはん` does not rank `7時` + `反` first.
    ("じはん", "時半"),
    ("ふん", "分"),
    ("ぷん", "分"),
    ("びょう", "秒"),
    ("ねん", "年"),
    ("がつ", "月"),
    ("かい", "回"),
    ("こ", "個"),
    ("つ", "つ"),
    ("だい", "台"),
    ("まい", "枚"),
    ("ひき", "匹"),
    ("びき", "匹"),
    ("ぴき", "匹"),
    ("さつ", "冊"),
    ("さい", "歳"),
    ("そく", "足"),
    ("ぼん", "本"),
    ("ぽん", "本"),
    ("ばん", "番"),
    ("ど", "度"),
    ("かげつ", "か月"),
    ("しゅう", "週"),
    // Percent: spoken パーセント, and ASR / a leftover 1-best often emits
    // わらび or the lexical surface 蕨. Official AzooKey injects numbers via
    // getJapaneseNumberDicdata and never treats 蕨 as a counter, because its
    // convertTarget is kana. Caption convert can receive already-kanji 蕨
    // after Vibrato fail-open or a prior n-best; attach `%` only after a
    // parsed number, same as わらび. Isolated 蕨 stays 蕨.
    ("ぱーせんと", "%"),
    ("わらび", "%"),
    ("蕨", "%"),
];

pub(crate) fn japanese_counter_starts_at(reading: &[char]) -> bool {
    JAPANESE_NUMERAL_COUNTERS.iter().any(|(counter, _)| {
        let counter_chars = counter.chars().collect::<Vec<_>>();
        reading.len() >= counter_chars.len()
            && reading[..counter_chars.len()] == counter_chars
            && reading.get(counter_chars.len()).is_none_or(|next| {
                !matches!(next, 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'ゃ' | 'ゅ' | 'ょ' | 'っ')
            })
    })
}

/// Convert a generic numeric counter to its conventional surface. This is a
/// grammatical edge, not a phrase dictionary: the counter is consumed only
/// when it immediately follows a parsed number, so ordinary homophones such
/// as `えん` (塩) remain available outside numeric context.
pub(crate) fn numeric_counter_surface(reading: &[char]) -> Option<(usize, String)> {
    JAPANESE_NUMERAL_COUNTERS
        .iter()
        .filter_map(|(counter, surface)| {
            let counter_chars = counter.chars().collect::<Vec<_>>();
            if reading.len() < counter_chars.len()
                || reading[..counter_chars.len()] != counter_chars
                || reading.get(counter_chars.len()).is_some_and(|next| {
                    matches!(next, 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'ゃ' | 'ゅ' | 'ょ' | 'っ')
                })
            {
                return None;
            }
            Some((counter_chars.len(), (*surface).to_string()))
        })
        .max_by_key(|(length, _)| *length)
}

fn tokenize_japanese_numeral(reading: &str) -> Option<Vec<NumeralToken>> {
    let chars = reading.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return None;
    }
    let mut tokens = Vec::new();
    let mut offset = 0;
    while offset < chars.len() {
        let matched = JAPANESE_NUMERAL_LEXEMES
            .iter()
            .filter_map(|(lexeme, token)| {
                let lexeme_chars = lexeme.chars().collect::<Vec<_>>();
                (offset + lexeme_chars.len() <= chars.len()
                    && chars[offset..offset + lexeme_chars.len()] == lexeme_chars)
                    .then_some((lexeme_chars.len(), *token))
            })
            .max_by_key(|(length, _)| *length);
        let (length, token) = matched?;
        tokens.push(token);
        offset += length;
    }
    Some(tokens)
}

fn parse_japanese_numeral(reading: &str) -> Option<u128> {
    let tokens = tokenize_japanese_numeral(reading)?;
    // A Japanese large unit needs a numeric component on its left. Treating
    // bare `まん`/`おく`/`ちょう` as numbers makes ordinary words such as
    // `あまん` convert to `あ10000` when the lattice starts at the suffix.
    if matches!(tokens.first(), Some(NumeralToken::LargeUnit(_))) {
        return None;
    }
    // `し` is a standalone reading for four, while the shortened `よ` form is
    // used with counters. Large units use the unambiguous `よん` form
    // (`よんまん`, `よんけい`). This prevents ordinary words such as `しけい`
    // and `よけい` from being interpreted as large numbers.
    let has_large_unit = tokens.iter().any(|token| matches!(token, NumeralToken::LargeUnit(_)));
    if has_large_unit
        && (reading.starts_with('し')
            || (reading.starts_with('よ') && !reading.starts_with("よん")))
    {
        return None;
    }
    let mut total = 0u128;
    let mut section = 0u128;
    let mut pending_digit = None;
    let mut last_small_unit = None;
    let mut last_large_unit = None;
    for token in tokens {
        match token {
            NumeralToken::Digit(digit) => {
                // Japanese cardinal numbers use a digit at most once before
                // each unit (`にじゅういち`, not `にいち`).
                if pending_digit.replace(digit).is_some() {
                    return None;
                }
            }
            NumeralToken::SmallUnit(unit) => {
                if last_small_unit.is_some_and(|previous| unit >= previous) {
                    return None;
                }
                let digit = pending_digit.take().unwrap_or(1);
                if digit == 0 {
                    return None;
                }
                section = section.checked_add(digit.checked_mul(unit)?)?;
                last_small_unit = Some(unit);
            }
            NumeralToken::LargeUnit(unit) => {
                if last_large_unit.is_some_and(|previous| unit >= previous) {
                    return None;
                }
                // A large unit must have a non-zero numeric component on its
                // left; accepting `まん`/`けい` by itself (or `ぜろまん`)
                // creates false positives when the lattice starts at a
                // suffix of an ordinary word.
                if section == 0 && pending_digit.is_none_or(|digit| digit == 0) {
                    return None;
                }
                if let Some(digit) = pending_digit.take() {
                    section = section.checked_add(digit)?;
                }
                let factor = if section == 0 { 1 } else { section };
                total = total.checked_add(factor.checked_mul(unit)?)?;
                section = 0;
                last_small_unit = None;
                last_large_unit = Some(unit);
            }
        }
    }
    if let Some(digit) = pending_digit {
        section = section.checked_add(digit)?;
    }
    let result = total.checked_add(section)?;
    // A sequence containing only a digit is valid (`さん` -> `3`), while an
    // empty sequence is rejected by the tokenizer.
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::{
        numeric_counter_surface, numeric_surface, numeric_surface_prefix, to_hiragana,
        to_hiragana_cow, to_katakana,
    };
    use std::borrow::Cow;

    #[test]
    fn borrows_normalized_hiragana_and_owns_converted_text() {
        assert!(matches!(to_hiragana_cow("ひらがな"), Cow::Borrowed("ひらがな")));
        assert!(matches!(to_hiragana_cow("カタカナ"), Cow::Owned(ref text) if text == "かたかな"));
        assert!(matches!(to_hiragana_cow("ＡＢＣ"), Cow::Owned(ref text) if text == "ABC"));
    }

    #[test]
    fn normalizes_katakana_and_fullwidth_ascii() {
        assert_eq!(to_hiragana("カタカナ ＡＢＣ"), "かたかな ABC");
        assert_eq!(to_katakana("かたかな"), "カタカナ");
    }

    #[test]
    fn normalizes_numeric_surface() {
        assert_eq!(numeric_surface("１２３"), Some("123".to_string()));
    }

    #[test]
    fn converts_spoken_japanese_numerals_to_ascii_digits() {
        for (reading, expected) in [
            ("れい", "0"),
            ("さん", "3"),
            ("じゅう", "10"),
            ("さんびゃく", "300"),
            ("にせん", "2000"),
            ("さんぜん", "3000"),
            ("にせんにじゅうご", "2025"),
            ("いちおくにせんまん", "120000000"),
        ] {
            assert_eq!(numeric_surface(reading).as_deref(), Some(expected), "reading: {reading}");
        }
    }

    #[test]
    fn keeps_expanded_and_contracted_numeral_units_equivalent() {
        for (expanded, contracted, expected) in [
            ("ろくじゅう", "ろくじゅっ", "60"),
            ("よんじゅう", "よんじゅっ", "40"),
            ("ななじゅう", "ななじゅっ", "70"),
            ("はちじゅう", "はちじゅっ", "80"),
            ("きゅうじゅう", "きゅうじゅっ", "90"),
            ("ひゃく", "ひゃっ", "100"),
        ] {
            assert_eq!(numeric_surface(expanded).as_deref(), Some(expected));
            assert_eq!(numeric_surface(contracted).as_deref(), Some(expected));
        }
    }

    #[test]
    fn extracts_unit_terminated_numeral_without_rewriting_ordinary_words() {
        let reading = "さんびゃくえん".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&reading), Some((5, "300".to_string())));
        let ordinary = "にほん".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&ordinary), None);
        let date = "にち".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&date), None);
        let counter = "いちにち".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&counter), Some((2, "1".to_string())));
        let currency = "さんえん".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&currency), Some((2, "3".to_string())));
        let short_four_year = "よねん".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&short_four_year), Some((1, "4".to_string())));
        assert_eq!(numeric_surface("よ"), None);
        let currency_suffix = "えんです".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&currency_suffix), Some((2, "円".to_string())));
        let people_suffix = "にんいる".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&people_suffix), Some((2, "人".to_string())));
        let age_suffix = "さいです".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&age_suffix), Some((2, "歳".to_string())));
        let half_time_suffix = "じはんです".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&half_time_suffix), Some((3, "時半".to_string())));
        let percent = "ぱーせんと".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&percent), Some((5, "%".to_string())));
        let warabi_asr = "わらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_counter_surface(&warabi_asr),
            Some((3, "%".to_string())),
            "ASR percent→わらび must map to % after a number"
        );
        let fern_surface = "蕨".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_counter_surface(&fern_surface),
            Some((1, "%".to_string())),
            "already-kanji 蕨 after a number is the same percent counter as わらび"
        );
        let sixty_fern = "60蕨".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&sixty_fern),
            Some((2, "60".to_string())),
            "digit plus lexical 蕨 must still expose an ASCII numeric prefix"
        );
        let degree_fern = "60°蕨".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&degree_fern),
            Some((2, "60".to_string())),
            "intervening degree plus 蕨 must not block a digit+percent prefix"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°蕨".chars().collect::<Vec<_>>()),
            1,
            "degree before lexical 蕨 is skippable percent-class noise"
        );
        let sixty_warabi = "60わらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&sixty_warabi),
            Some((2, "60".to_string())),
            "digit percent readings must keep an ASCII numeric prefix"
        );
        let degree_warabi = "60°わらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&degree_warabi),
            Some((2, "60".to_string())),
            "intervening degree glyphs must not block a digit+percent prefix"
        );
        let celsius_warabi = "90℃わらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&celsius_warabi),
            Some((2, "90".to_string())),
            "intervening ℃ must not block a digit+percent prefix"
        );
        let degree_c_warabi = "90°Cわらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&degree_c_warabi),
            Some((2, "90".to_string())),
            "intervening °C must not block a digit+percent prefix"
        );
        let mixed_width_degree = "6０°わらび".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&mixed_width_degree),
            Some((2, "60".to_string())),
            "mixed-width digits plus degree must still expose an ASCII prefix"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°わらび".chars().collect::<Vec<_>>()),
            1,
            "degree before percent counter is skippable noise"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°Cわらび".chars().collect::<Vec<_>>()),
            2,
            "°C before percent counter is skippable noise"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°かいてん".chars().collect::<Vec<_>>()),
            0,
            "degree before non-percent counter must not be skipped"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°ど".chars().collect::<Vec<_>>()),
            0,
            "degree before 度 counter must not be skipped"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°".chars().collect::<Vec<_>>()),
            0,
            "bare degree mark is not percent noise"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°Cてんき".chars().collect::<Vec<_>>()),
            0,
            "°C without percent counter must not swallow C"
        );
        assert_eq!(
            super::skip_intervening_numeric_unit_noise(&"°Coffee".chars().collect::<Vec<_>>()),
            0,
            "°C in ordinary Latin text must not swallow C"
        );
        let degree_kaiten = "90°かいてん".chars().collect::<Vec<_>>();
        assert_eq!(
            numeric_surface_prefix(&degree_kaiten),
            None,
            "degree plus non-percent counter must not form a digit+counter prefix that deletes °"
        );
        let separated = "いち、に".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&separated), Some((2, "1".to_string())));
    }

    #[test]
    fn rejects_bare_large_units_and_classifies_compound_spans() {
        for reading in ["まんえん", "けいさん", "あまん", "ぜろまん", "よけい"] {
            let chars = reading.chars().collect::<Vec<_>>();
            assert_eq!(numeric_surface_prefix(&chars), None, "reading: {reading}");
        }
        assert!(!super::numeric_span_starts_with_digit("じゅう"));
        assert!(super::numeric_span_starts_with_digit("さんびゃく"));
        assert!(super::numeric_span_starts_with_digit("１２３"));
    }
}
