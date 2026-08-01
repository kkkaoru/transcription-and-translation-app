pub(crate) fn to_hiragana(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            let code = character as u32;
            if (0x30a1..=0x30f6).contains(&code) {
                char::from_u32(code - 0x60).unwrap_or(character)
            } else if (0xff01..=0xff5e).contains(&code) {
                char::from_u32(code - 0xfee0).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

pub(crate) fn to_katakana(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            let code = character as u32;
            if (0x3041..=0x3096).contains(&code) {
                char::from_u32(code + 0x60).unwrap_or(character)
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
    ("びゃく", NumeralToken::SmallUnit(100)),
    ("ぴゃく", NumeralToken::SmallUnit(100)),
    ("じゅう", NumeralToken::SmallUnit(10)),
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
        let Some(surface) = numeric_surface(&candidate) else {
            continue;
        };
        if length == reading.len()
            || japanese_numeral_has_unit(&candidate)
            || japanese_counter_starts_at(&reading[length..])
            || reading.get(length).is_some_and(|character| is_boundary(*character))
        {
            return Some((length, surface));
        }
    }
    None
}

pub(crate) fn numeric_surface(reading: &str) -> Option<String> {
    let normalized = to_hiragana(reading);
    let digits: String = normalized
        .chars()
        .map(|character| match character {
            '０'..='９' => char::from_u32(character as u32 - 0xfee0).unwrap_or(character),
            _ => character,
        })
        .collect();
    if !digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()) {
        return Some(digits);
    }
    parse_japanese_numeral(&normalized).map(|number| number.to_string())
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
    ("そく", "足"),
    ("ぼん", "本"),
    ("ぽん", "本"),
    ("ばん", "番"),
    ("ど", "度"),
    ("かげつ", "か月"),
    ("しゅう", "週"),
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
        numeric_counter_surface, numeric_surface, numeric_surface_prefix, to_hiragana, to_katakana,
    };

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
        let currency_suffix = "えんです".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&currency_suffix), Some((2, "円".to_string())));
        let people_suffix = "にんいる".chars().collect::<Vec<_>>();
        assert_eq!(numeric_counter_surface(&people_suffix), Some((2, "人".to_string())));
        let separated = "いち、に".chars().collect::<Vec<_>>();
        assert_eq!(numeric_surface_prefix(&separated), Some((2, "1".to_string())));
    }
}
