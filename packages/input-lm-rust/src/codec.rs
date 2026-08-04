//! Key and value codec for the MARISA-backed n-gram tries.
//!
//! Ported from `SwiftTrainer` in
//! `submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/Trainer.swift`.
//!
//! Every token is stored as two `i8` digits in base [`RADIX`], each offset by
//! `+1` so that no digit can collide with the two negative delimiters.

/// Separates the key part of an entry from its encoded value.
pub const KEY_VALUE_DELIMITER: i8 = i8::MIN;

/// Placed immediately before the final token of a key so that the trie can be
/// searched for "this prefix followed by exactly one more token".
pub const PREDICTIVE_DELIMITER: i8 = i8::MIN + 1;

/// Radix of the key and value codecs (`i8::MAX - 1`).
pub const RADIX: i32 = (i8::MAX - 1) as i32;

/// Number of `i8` digits an encoded value occupies.
pub const VALUE_LEN: usize = 5;

/// Encodes tokens as two `i8` digits each.
pub fn encode_key(tokens: &[usize]) -> Vec<i8> {
    let mut out = Vec::with_capacity(tokens.len() * 2);
    for &token in tokens {
        let token = token as i32;
        out.push((token / RADIX + 1) as i8);
        out.push((token % RADIX + 1) as i8);
    }
    out
}

/// Inverse of the per-token half of [`encode_key`].
pub fn decode_key(v1: i8, v2: i8) -> usize {
    ((i32::from(v1) - 1) * RADIX + (i32::from(v2) - 1)) as usize
}

/// Encodes a count as [`VALUE_LEN`] digits, most significant first.
pub fn encode_value(value: u32) -> [i8; VALUE_LEN] {
    let radix = RADIX as u32;
    let (q1, r1) = (value / radix, value % radix);
    let (q2, r2) = (q1 / radix, q1 % radix);
    let (q3, r3) = (q2 / radix, q2 % radix);
    let (q4, r4) = (q3 / radix, q3 % radix);
    [(q4 + 1) as i8, (r4 + 1) as i8, (r3 + 1) as i8, (r2 + 1) as i8, (r1 + 1) as i8]
}

/// Decodes the first [`VALUE_LEN`] digits of `suffix`.
///
/// Returns `None` when the slice is too short or holds a digit outside the
/// valid `1..=RADIX` range, which means the entry was not a value we wrote.
pub fn decode_value(suffix: &[i8]) -> Option<u32> {
    if suffix.len() < VALUE_LEN {
        return None;
    }
    let mut value: i64 = 0;
    for &digit in &suffix[..VALUE_LEN] {
        let digit = i64::from(digit) - 1;
        if !(0..i64::from(RADIX)).contains(&digit) {
            return None;
        }
        value = value * i64::from(RADIX) + digit;
    }
    u32::try_from(value).ok()
}

/// Builds a point-lookup entry: `key | KV | value`.
pub fn point_entry(key: &[usize], value: u32) -> Vec<i8> {
    let mut out = point_prefix(key);
    out.extend_from_slice(&encode_value(value));
    out
}

/// Builds a predictive entry: `key[..last] | PRED | last | KV | value`.
pub fn predictive_entry(key: &[usize], value: u32) -> Vec<i8> {
    let mut out = encode_key(key);
    // The delimiter sits just before the final token's two digits.
    let at = out.len().saturating_sub(2);
    out.insert(at, PREDICTIVE_DELIMITER);
    out.push(KEY_VALUE_DELIMITER);
    out.extend_from_slice(&encode_value(value));
    out
}

/// Search prefix matching [`point_entry`] keys.
pub fn point_prefix(key: &[usize]) -> Vec<i8> {
    let mut out = encode_key(key);
    out.push(KEY_VALUE_DELIMITER);
    out
}

/// Search prefix matching [`predictive_entry`] keys that extend `key` by one token.
pub fn predictive_prefix(key: &[usize]) -> Vec<i8> {
    let mut out = encode_key(key);
    out.push(PREDICTIVE_DELIMITER);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radix_and_delimiters_match_the_swift_constants() {
        assert_eq!(RADIX, 126);
        assert_eq!(KEY_VALUE_DELIMITER, -128);
        assert_eq!(PREDICTIVE_DELIMITER, -127);
    }

    #[test]
    fn encode_key_uses_two_digits_per_token() {
        assert_eq!(encode_key(&[0]), vec![1, 1]);
        assert_eq!(encode_key(&[125]), vec![1, 126]);
        // 126 rolls over into the high digit.
        assert_eq!(encode_key(&[126]), vec![2, 1]);
        assert_eq!(encode_key(&[0, 126]).len(), 4);
    }

    #[test]
    fn key_digits_round_trip_across_the_vocabulary() {
        for token in [0usize, 1, 125, 126, 127, 3000, 5999] {
            let encoded = encode_key(&[token]);
            assert_eq!(decode_key(encoded[0], encoded[1]), token, "token {token}");
        }
    }

    #[test]
    fn key_digits_never_collide_with_the_delimiters() {
        for token in 0usize..6000 {
            for digit in encode_key(&[token]) {
                assert!(digit > PREDICTIVE_DELIMITER, "token {token} digit {digit}");
            }
        }
    }

    #[test]
    fn values_round_trip() {
        for value in [0u32, 1, 125, 126, 15_875, 2_000_016, u32::MAX] {
            let encoded = encode_value(value);
            assert_eq!(decode_value(&encoded), Some(value), "value {value}");
        }
    }

    #[test]
    fn decode_value_rejects_short_and_malformed_input() {
        assert_eq!(decode_value(&[1, 1, 1, 1]), None);
        // A delimiter is not a valid digit.
        assert_eq!(decode_value(&[1, 1, 1, 1, KEY_VALUE_DELIMITER]), None);
    }

    #[test]
    fn point_entry_is_key_then_delimiter_then_value() {
        let entry = point_entry(&[7, 9], 42);
        assert_eq!(&entry[..4], &encode_key(&[7, 9])[..]);
        assert_eq!(entry[4], KEY_VALUE_DELIMITER);
        assert_eq!(decode_value(&entry[5..]), Some(42));
    }

    #[test]
    fn predictive_entry_puts_the_delimiter_before_the_final_token() {
        let entry = predictive_entry(&[7, 9, 11], 42);
        let head = encode_key(&[7, 9]);
        assert_eq!(&entry[..head.len()], &head[..]);
        assert_eq!(entry[head.len()], PREDICTIVE_DELIMITER);
        let tail = &entry[head.len() + 1..];
        assert_eq!(decode_key(tail[0], tail[1]), 11);
        assert_eq!(tail[2], KEY_VALUE_DELIMITER);
        assert_eq!(decode_value(&tail[3..]), Some(42));
    }

    #[test]
    fn predictive_entry_extends_the_predictive_prefix_of_its_head() {
        // This equivalence is what makes one predictive search return every
        // continuation of a prefix.
        let entry = predictive_entry(&[3, 4, 5], 1);
        assert!(entry.starts_with(&predictive_prefix(&[3, 4])));
    }

    #[test]
    fn point_entry_extends_the_point_prefix_of_its_key() {
        let entry = point_entry(&[3, 4], 1);
        assert!(entry.starts_with(&point_prefix(&[3, 4])));
    }

    #[test]
    fn a_single_token_predictive_entry_leads_with_the_delimiter() {
        let entry = predictive_entry(&[5], 1);
        assert_eq!(entry[0], PREDICTIVE_DELIMITER);
        assert!(entry.starts_with(&predictive_prefix(&[])));
    }
}
