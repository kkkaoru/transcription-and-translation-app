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

pub(crate) fn contains_kanji(input: &str) -> bool {
    input.chars().any(|character| {
        let code = character as u32;
        (0x3400..=0x4dbf).contains(&code) || (0x4e00..=0x9fff).contains(&code)
    })
}

pub(crate) fn is_boundary(character: char) -> bool {
    character.is_whitespace() || "、。！？,.!?()（）「」『』【】[]{}\"'".contains(character)
}

pub(crate) fn numeric_surface(reading: &str) -> Option<String> {
    let digits: String = reading
        .chars()
        .map(|character| match character {
            '０'..='９' => char::from_u32(character as u32 - 0xfee0).unwrap_or(character),
            _ => character,
        })
        .collect();
    (!digits.is_empty() && digits.chars().all(|character| character.is_ascii_digit()))
        .then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::{contains_kanji, numeric_surface, to_hiragana, to_katakana};

    #[test]
    fn normalizes_katakana_and_fullwidth_ascii() {
        assert_eq!(to_hiragana("カタカナ ＡＢＣ"), "かたかな ABC");
        assert_eq!(to_katakana("かたかな"), "カタカナ");
    }

    #[test]
    fn detects_kanji_and_numbers() {
        assert!(contains_kanji("日本語"));
        assert_eq!(numeric_surface("１２３"), Some("123".to_string()));
    }
}
