use super::dictionary::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
use super::normalization::{
    is_boundary, japanese_counter_starts_at, japanese_numeral_has_unit, numeric_counter_surface,
    numeric_surface_prefix, to_hiragana, to_katakana,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConversionOptions {
    pub n_best: usize,
    pub max_dictionary_word_chars: usize,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        // Keep a wide enough beam for long Japanese utterances.  A narrow
        // beam can prune a locally expensive particle/verb edge before a
        // later connection cost makes the complete Kanji path preferable.
        // 12 remains bounded while preserving the fast local converter.
        Self { n_best: 12, max_dictionary_word_chars: 24 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversionCandidate {
    pub text: String,
    pub score: f32,
}

// A missing dictionary edge should lose to even a low-confidence system
// entry (system rows below the -17 quality floor are filtered separately).
// Keeping this as an explicit lattice penalty also prevents an all-kana
// unknown span from outranking a known multi-character word.
const UNKNOWN_CHARACTER_PENALTY: f32 = -30.0;
// Keep the unknown continuation bounded.  A full remaining utterance is not
// a useful token: it can hide dictionary words that begin a few characters
// later (for example the `く` before `くう` in a long caption).
const MAX_UNKNOWN_KANA_SPAN_CHARS: usize = 4;

#[derive(Debug, Clone)]
struct PathState {
    text: String,
    score: f32,
    last: Option<DictionaryEntry>,
    /// Latest content-word MID in the current AzooKey clause.
    clause_mid: u16,
    clause_has_word: bool,
}

pub fn convert_kana_to_kanji(input: &str) -> String {
    // Resolve the optional system dictionary even for the convenience API.
    // The desktop app uses this function when no explicit dictionary path is
    // configured; bypassing `DictionaryPaths::with_defaults` there silently
    // discarded `AZOOKEY_DICTIONARY_ROOT` and forced the tiny built-in lexicon.
    // A malformed/unavailable environment path remains non-fatal: retain the
    // built-in dictionary so captions are still produced.
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths::default()).unwrap_or_default();
    convert_with_dictionary(input, &dictionary, ConversionOptions::default())
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
    if trimmed.is_empty() {
        return vec![ConversionCandidate { text: trimmed.to_string(), score: 0.0 }];
    }
    // Keep a one-to-one copy of the source characters for the unknown-token
    // path.  Dictionary lookup uses hiragana readings, but writing the
    // normalized reading back to the caption would unexpectedly turn every
    // unknown katakana token into hiragana (for example, "カタカナ" →
    // "かたかな").  Keeping these vectors aligned also lets mixed text that
    // already contains kanji continue through the converter: existing kanji
    // are preserved while adjacent kana can still be converted.
    let source_chars = trimmed.chars().collect::<Vec<_>>();
    let chars = to_hiragana(trimmed).chars().collect::<Vec<_>>();
    debug_assert_eq!(source_chars.len(), chars.len());
    let width = options.n_best.clamp(1, 32);
    let mut states = vec![Vec::<PathState>::new(); chars.len() + 1];
    states[0].push(PathState {
        text: String::new(),
        score: 0.0,
        last: None,
        clause_mid: 500,
        clause_has_word: false,
    });

    for start in 0..chars.len() {
        let current = states[start].clone();
        if current.is_empty() {
            continue;
        }
        let entries = dictionary
            .entries_starting_at(&chars, start, options.max_dictionary_word_chars.clamp(1, 128))
            .unwrap_or_default();
        for state in current {
            if let Some((numeric_length, surface)) = numeric_surface_prefix(&chars[start..]) {
                let numeric_reading: String = chars[start..start + numeric_length].iter().collect();
                let has_unit = japanese_numeral_has_unit(&numeric_reading);
                let suffix = &chars[start + numeric_length..];
                let followed_by_counter = japanese_counter_starts_at(suffix);
                let followed_by_boundary =
                    suffix.first().is_some_and(|character| is_boundary(*character));
                let starts_after_boundary = start > 0 && is_boundary(chars[start - 1]);
                // A bare spoken digit is useful at a punctuation-separated
                // boundary (`いち、に`) but dangerous in ordinary words:
                // without this guard the final `ご` of `にほんご` could turn
                // into `5`. Compound numerals and counter forms remain
                // available anywhere in a caption.
                let numeric_context = has_unit
                    || followed_by_counter
                    || followed_by_boundary
                    || starts_after_boundary;
                if numeric_context || start == 0 {
                    // Keep ambiguous one-syllable digits below dictionary
                    // entries (`ご` -> `語`) unless the surrounding boundary
                    // makes the numeric reading intentional.
                    let numeric_score = if has_unit
                        || followed_by_counter
                        || followed_by_boundary
                        || starts_after_boundary
                    {
                        -1.0
                    } else {
                        -12.0
                    };
                    push_state(
                        &mut states[start + numeric_length],
                        PathState {
                            text: format!("{}{}", state.text, surface),
                            score: state.score + numeric_score,
                            last: None,
                            clause_mid: 500,
                            clause_has_word: false,
                        },
                        width,
                    );
                    // Once a spoken counter follows the number, emit its
                    // conventional Kanji surface as one grammatical edge.
                    // This prevents public-dictionary homophones such as
                    // `えん` -> 塩 from winning after `さん` while leaving
                    // ordinary `えん` unconstrained outside numeric context.
                    if let Some((counter_length, counter_surface)) = numeric_counter_surface(suffix)
                    {
                        push_state(
                            &mut states[start + numeric_length + counter_length],
                            PathState {
                                text: format!("{}{}{}", state.text, surface, counter_surface),
                                score: state.score + numeric_score - 0.25,
                                last: None,
                                clause_mid: 500,
                                clause_has_word: false,
                            },
                            width,
                        );
                    }
                }
            }
            push_state(
                &mut states[start + 1],
                PathState {
                    text: format!(
                        "{}{}",
                        state.text,
                        preserve_unknown_surface_with_context(&source_chars, &chars, start)
                    ),
                    // Unknown characters are a penalty. AzooKey dictionary
                    // values are log-probabilities: higher (less negative)
                    // values win, so a raw character receives a strong
                    // negative penalty and cannot beat a known word.
                    score: state.score + UNKNOWN_CHARACTER_PENALTY,
                    last: None,
                    clause_mid: 500,
                    clause_has_word: false,
                },
                width,
            );
            // The compact fallback is useful for an unknown *continuation*
            // (for example a suffix that the public dictionary cannot spell),
            // but it must not become a single all-kana path from the start of
            // a sentence.  At position zero the ordinary per-character edges
            // keep unknown words available while known dictionary entries can
            // still win on their lexical score.
            let has_multi_char_entry =
                entries.iter().any(|entry| entry.reading.chars().count() >= 2);
            let has_multi_char_prior_entry =
                state.last.as_ref().is_some_and(|entry| entry.reading.chars().count() >= 2);
            let particle_followed_by_adjective = following_has_lexical_adjective(
                dictionary,
                &chars,
                start,
                options.max_dictionary_word_chars.clamp(1, 128),
            );
            if start > 0
                && state.last.is_some()
                && has_multi_char_prior_entry
                && !has_multi_char_entry
                && !particle_followed_by_adjective
                && dictionary.has_system_dictionary()
            {
                if let Some(end) = unknown_kana_span_end(&chars, start) {
                    let length = end - start;
                    if length > 1 {
                        let surface: String = source_chars[start..end].iter().collect();
                        push_state(
                            &mut states[end],
                            PathState {
                                text: format!("{}{}", state.text, surface),
                                // Match AzooKey's all-hiragana fallback without
                                // allowing a long unknown span to outrank known
                                // dictionary words.
                                score: state.score + unknown_kana_span_penalty(length),
                                last: None,
                                clause_mid: 500,
                                clause_has_word: false,
                            },
                            width,
                        );
                    }
                }
            }
            if is_boundary(chars[start]) {
                push_state(
                    &mut states[start + 1],
                    PathState {
                        text: format!("{}{}", state.text, source_chars[start]),
                        score: state.score,
                        last: None,
                        clause_mid: 500,
                        clause_has_word: false,
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
                // Existing Kanji marks a hard semantic boundary for the
                // lightweight converter. A full system entry beginning with a
                // particle can otherwise consume the particle and the next
                // verb (`東京へいきます` -> `東京平気ます`). Keep the
                // particle edge and let the following kana word be scored on
                // its own. Identity particles remain available for grammar
                // context; only a multi-character Kanji surface is blocked.
                if start > 0
                    && is_kanji(source_chars[start - 1])
                    && entry_len > 1
                    && is_particle(chars[start])
                    && contains_kanji(&entry.surface)
                {
                    continue;
                }
                if source_is_hiragana_surface(&source_chars[start..end])
                    && contains_ascii_alphanumeric(&entry.surface)
                {
                    continue;
                }
                if prolonged_mark_adjacent_to_span(&source_chars, &chars, start, end) {
                    continue;
                }
                let (connection, clause_mid, clause_has_word) =
                    transition_score(dictionary, &state, entry);
                let surface = dictionary_surface_for_source(entry, &source_chars[start..end]);
                push_state(
                    &mut states[end],
                    PathState {
                        text: format!("{}{}", state.text, surface),
                        score: state.score
                            + entry.value
                            + connection
                            + dictionary.builtin_surface_bonus(entry)
                            + inflectional_surface_penalty(entry)
                            + contextual_entry_bonus(
                                dictionary,
                                &chars,
                                start,
                                end,
                                entry,
                                options.max_dictionary_word_chars.clamp(1, 128),
                            ),
                        last: Some(entry.clone()),
                        clause_mid,
                        clause_has_word,
                    },
                    width,
                );
                if let Some(former) = state.last.as_ref() {
                    if let Some(identity) =
                        identity_fallback_entry(dictionary, former, entry, &chars[start..end])
                    {
                        let (identity_connection, clause_mid, clause_has_word) =
                            transition_score(dictionary, &state, &identity);
                        push_state(
                            &mut states[end],
                            PathState {
                                text: format!("{}{}", state.text, identity.surface),
                                score: state.score + identity.value + identity_connection,
                                last: Some(identity),
                                clause_mid,
                                clause_has_word,
                            },
                            width,
                        );
                    }
                }
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

/// Some public-dictionary rows expose an inflected surface for a stem reading
/// (for example `から -> 辛い`).  That row is useful inside a larger lattice,
/// but should not outrank the kana/particle continuation when the reading
/// does not include the inflectional ending.  Keep this as a generic
/// morphology prior rather than a reading-specific replacement.
fn inflectional_surface_penalty(entry: &DictionaryEntry) -> f32 {
    if contains_kanji(&entry.surface)
        && entry.surface.ends_with('い')
        && !entry.reading.ends_with('い')
    {
        -10.0
    } else {
        0.0
    }
}

fn transition_score(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
) -> (f32, u16, bool) {
    let Some(former) = state.last.as_ref() else {
        let clause_mid = if entry.mid != 500 { entry.mid } else { 500 };
        return (dictionary.beginning_connection_cost(entry), clause_mid, true);
    };

    let mut score = dictionary.class_connection_cost(former, entry);
    let starts_clause = dictionary.is_clause_boundary(former.rcid, entry.lcid);
    if starts_clause {
        let next_clause_mid = if dictionary.include_meaning_cost(entry) { entry.mid } else { 500 };
        score += dictionary.meaning_connection_cost(state.clause_mid, next_clause_mid);
        return (score, next_clause_mid, true);
    }

    let clause_mid =
        if dictionary.include_meaning_cost(entry) || (!state.clause_has_word && entry.mid != 500) {
            entry.mid
        } else {
            state.clause_mid
        };
    (score, clause_mid, true)
}

fn unknown_kana_span_end(chars: &[char], start: usize) -> Option<usize> {
    let first = *chars.get(start)?;
    // Small kana are orthographic continuations of the preceding syllable;
    // treating `ゃく` as an independent unknown token would let a short
    // high-frequency entry such as `気` beat the full `きゃく` dictionary row.
    if (!is_hiragana(first) && first != 'ー') || is_small_hiragana(first) {
        return None;
    }
    let mut end = start + 1;
    while end < chars.len()
        && end - start < MAX_UNKNOWN_KANA_SPAN_CHARS
        && (is_hiragana(chars[end]) || chars[end] == 'ー')
    {
        end += 1;
    }
    Some(end)
}

fn is_small_hiragana(character: char) -> bool {
    matches!(character, 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'っ' | 'ゃ' | 'ゅ' | 'ょ')
}

fn unknown_kana_span_penalty(_length: usize) -> f32 {
    // AzooKey's additional whole-hiragana candidate uses -14.5 regardless of
    // the span length.  Keep that upstream prior rather than making a
    // dictionary-missing suffix look much less plausible than a chain of
    // unrelated one-character homonyms.
    -14.5
}

fn following_has_lexical_adjective(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
) -> bool {
    if !chars.get(start).is_some_and(|character| is_particle(*character)) {
        return false;
    }
    let Some(following) = chars.get(start + 1..) else {
        return false;
    };
    dictionary
        .entries_starting_at(following, 0, max_dictionary_word_chars)
        .unwrap_or_default()
        .iter()
        .any(|entry| {
            entry.reading.chars().count() >= 2
                && entry.surface.ends_with('い')
                && contains_kanji(&entry.surface)
        })
}

fn dictionary_surface_for_source(entry: &DictionaryEntry, source: &[char]) -> String {
    // A system dictionary may contain an identity row such as
    // `かたかな -> かたかな`. It is useful for hiragana input but should not
    // rewrite a user's katakana spelling merely because lookup normalizes the
    // reading. Preserve that original orthography while retaining true
    // kana→kanji and kana→loanword surfaces.
    let source_surface: String = source.iter().collect();
    if source_is_katakana_surface(source)
        && (entry.surface == entry.reading
            || (entry.surface != source_surface
                && (contains_kanji(&entry.surface) || contains_ascii_alphanumeric(&entry.surface))))
    {
        return source_surface;
    }
    entry.surface.clone()
}

fn source_is_katakana_surface(source: &[char]) -> bool {
    !source.is_empty()
        && source.iter().all(|character| is_katakana(character) || *character == 'ー')
}

fn contains_ascii_alphanumeric(text: &str) -> bool {
    text.chars().any(|character| character.is_ascii_alphanumeric())
}

fn is_katakana(character: &char) -> bool {
    let code = *character as u32;
    (0x30a1..=0x30f6).contains(&code)
}

fn is_kanji(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
}

fn contains_kanji(text: &str) -> bool {
    text.chars().any(is_kanji)
}

/// Use dictionary alternatives and the grammatical shape of the following
/// edge as a small, bounded tie-breaker. The system dictionary's values and
/// CID/MID connection costs remain primary; no reading or surface pair is
/// embedded here, so custom phrase dictionaries are not required.
fn contextual_entry_bonus(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    end: usize,
    entry: &DictionaryEntry,
    max_dictionary_word_chars: usize,
) -> f32 {
    let mut alternatives = dictionary
        .lookup_exact(&entry.reading)
        .unwrap_or_default()
        .into_iter()
        .filter(|candidate| candidate.lcid == entry.lcid && candidate.rcid == entry.rcid)
        .collect::<Vec<_>>();
    alternatives.sort_by(|left, right| right.value.total_cmp(&left.value));
    if alternatives.len() < 2 {
        return 0.0;
    }
    let rank = alternatives
        .iter()
        .position(|candidate| candidate.surface == entry.surface && candidate.mid == entry.mid);
    let Some(rank) = rank else {
        return 0.0;
    };
    let following_content = following_context_is_content(
        dictionary,
        chars.get(end..).unwrap_or_default(),
        max_dictionary_word_chars,
    );
    let preceding_content = preceding_context_is_content(chars.get(..start).unwrap_or_default());
    let adjective_like = entry.surface.ends_with('い') && contains_kanji(&entry.surface);
    if !following_content && !preceding_content && !adjective_like {
        return 0.0;
    }
    let desired_rank = usize::from(following_content || preceding_content);
    if rank == desired_rank {
        2.5
    } else {
        0.0
    }
}

fn preceding_context_is_content(before: &[char]) -> bool {
    before.iter().rev().take(8).any(|character| *character == 'ー')
}

fn following_context_is_content(
    dictionary: &AzooKeyDictionary,
    after: &[char],
    max_dictionary_word_chars: usize,
) -> bool {
    let Some(first) = after.first() else {
        return false;
    };
    if is_boundary(*first) {
        return false;
    }
    if after.iter().take(8).any(|character| *character == 'ー') {
        return true;
    }
    let next_entries =
        dictionary.entries_starting_at(after, 0, max_dictionary_word_chars).unwrap_or_default();
    if next_entries.is_empty() {
        return after.len() >= 3 && !after.iter().take(3).all(|character| is_hiragana(*character));
    }
    next_entries.iter().any(|candidate| {
        candidate.reading.chars().count() >= 3 && contains_kanji(&candidate.surface)
    })
}

/// Keep a grammar-shaped kana edge available when a system dictionary only
/// offers a lexical homonym for a continuation.  The decision uses POS/CID
/// metadata and inflectional surface shape, never a reading→surface table.
fn identity_fallback_entry(
    dictionary: &AzooKeyDictionary,
    former: &DictionaryEntry,
    candidate: &DictionaryEntry,
    reading: &[char],
) -> Option<DictionaryEntry> {
    if !dictionary.has_system_dictionary()
        || reading.len() < 2
        || candidate.surface == candidate.reading
        || !contains_kanji(&candidate.surface)
    {
        return None;
    }
    let same_pos_continuation = former.rcid == candidate.lcid && candidate.lcid == candidate.rcid;
    let inflectional_continuation =
        former.surface.ends_with('く') && candidate.surface.ends_with('い') && reading.len() <= 2;
    if !(same_pos_continuation || inflectional_continuation) {
        return None;
    }
    let value = if inflectional_continuation {
        // Preserve a readable kana auxiliary after a verb/adjective stem;
        // this is a general conjugation rule, not a word-pair exception.
        -3.0
    } else {
        // A kana identity edge is an escape hatch for an incomplete clause,
        // not a competing lexical interpretation.  Keep it below a real
        // system-dictionary surface so a contextual Kanji candidate wins when
        // the reading is fully covered (while still retaining the edge for
        // genuinely unfinished speech).
        -12.0 - (reading.len().saturating_sub(2) as f32 * 1.5)
    };
    Some(DictionaryEntry {
        reading: reading.iter().collect(),
        surface: reading.iter().collect(),
        lcid: candidate.lcid,
        rcid: candidate.rcid,
        mid: candidate.mid,
        value,
    })
}

/// Keep particle detection separate from dictionary ranking.
/// The function is used only for protecting a particle edge after existing
/// kanji, while candidate ranking stays in AzooKey's lattice costs.
fn is_particle(character: char) -> bool {
    matches!(character, 'は' | 'が' | 'を' | 'に' | 'へ' | 'で' | 'と' | 'も' | 'の')
}

fn preserve_unknown_surface_with_context(
    source: &[char],
    normalized: &[char],
    index: usize,
) -> char {
    let original = source[index];
    let normalized_character = normalized[index];
    if !is_hiragana(original) || !unknown_run_has_prolonged_mark(source, normalized, index) {
        return preserve_unknown_surface(original, normalized_character);
    }
    to_katakana(&original.to_string()).chars().next().unwrap_or(original)
}

fn unknown_run_has_prolonged_mark(source: &[char], chars: &[char], index: usize) -> bool {
    let mut left = index;
    while left > 0 && is_kana_or_prolonged(chars[left - 1]) {
        left -= 1;
    }
    let mut right = index;
    while right < chars.len() && is_kana_or_prolonged(chars[right]) {
        right += 1;
    }
    chars[left..right].contains(&'ー') && !source[left..right].iter().any(is_katakana)
}

fn prolonged_mark_adjacent_to_span(
    source: &[char],
    chars: &[char],
    start: usize,
    end: usize,
) -> bool {
    if !source_is_hiragana_surface(&source[start..end]) {
        return false;
    }
    let left = start.saturating_sub(1);
    let right = (end + 1).min(chars.len());
    chars[left..right].contains(&'ー') && !source[left..right].iter().any(is_katakana)
}

fn is_kana_or_prolonged(character: char) -> bool {
    character == 'ー' || is_hiragana(character) || is_katakana(&character)
}

fn is_hiragana(character: char) -> bool {
    let code = character as u32;
    (0x3041..=0x3096).contains(&code)
}

fn source_is_hiragana_surface(source: &[char]) -> bool {
    !source.is_empty()
        && source.iter().all(|character| is_hiragana(*character) || *character == 'ー')
}

fn preserve_unknown_surface(source: char, normalized: char) -> char {
    // Katakana is a meaningful orthography for loanwords.  `to_hiragana` is
    // still used for lookup, but only kana characters should retain their
    // original surface on a dictionary miss; full-width ASCII and digits keep
    // the normalized form for stable caption output.
    let code = source as u32;
    if (0x30a1..=0x30f6).contains(&code) {
        source
    } else {
        normalized
    }
}

fn push_state(states: &mut Vec<PathState>, candidate: PathState, width: usize) {
    states.push(candidate);
    // AzooKey's values are log-probabilities and are ordered descending in
    // the upstream candidate lattice. Keeping the best (highest) score first
    // prevents low-confidence -30 rows from beating a likely -5 row.
    states.sort_by(|left, right| right.score.total_cmp(&left.score));
    // The rendered text is not a sufficient lattice identity: two entries
    // can render the same surface while carrying different POS/CID/MID
    // metadata, and that metadata changes the score of the next edge. Keep
    // those alternate contexts in the beam instead of collapsing one by
    // `text` alone. `Vec::dedup_by` only removes adjacent duplicates; scores
    // can interleave equal contexts, so scan the small beam explicitly.
    let mut unique = Vec::with_capacity(states.len());
    for state in states.drain(..) {
        if unique.iter().any(|kept: &PathState| same_path_context(kept, &state)) {
            continue;
        }
        unique.push(state);
    }
    states.extend(unique);
    states.truncate(width);
}

fn same_path_context(left: &PathState, right: &PathState) -> bool {
    if left.clause_mid != right.clause_mid || left.clause_has_word != right.clause_has_word {
        return false;
    }
    match (&left.last, &right.last) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.lcid == right.lcid && left.rcid == right.rcid && left.mid == right.mid
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        convert_kana_to_kanji, convert_kana_to_kanji_with_paths, convert_with_dictionary,
        ConversionOptions,
    };
    use crate::{AzooKeyDictionary, DictionaryEntry, DictionaryPaths};
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
    fn converts_kana_adjacent_to_existing_kanji() {
        assert_eq!(convert_kana_to_kanji("今日ははいしんです"), "今日は配信です");
        assert_eq!(convert_kana_to_kanji("ほんじつはじかんの説明です"), "本日は時間の説明です");
        assert_eq!(convert_kana_to_kanji("わたしたちはがくせいです"), "私たちは学生です");
    }

    #[test]
    fn prefers_the_longer_dictionary_entry_over_a_raw_tail() {
        assert_eq!(convert_kana_to_kanji("にほんご"), "日本語");
    }

    #[test]
    fn converts_high_frequency_caption_vocabulary() {
        assert_eq!(convert_kana_to_kanji("かんじのしょりをかいぜん"), "漢字の処理を改善");
        assert_eq!(convert_kana_to_kanji("おつかれさまです"), "お疲れ様です");
        assert_eq!(convert_kana_to_kanji("おつかれさまでした"), "お疲れ様でした");
        assert_eq!(convert_kana_to_kanji("いきます"), "行きます");
        assert_eq!(convert_kana_to_kanji("ねん"), "年");
        assert_eq!(convert_kana_to_kanji("おんりょうをちょうせい"), "音量を調整");
    }

    #[test]
    fn keeps_public_dictionary_context_for_ambiguous_caption_words() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let converted = super::convert_kana_to_kanji_with_paths(
            "かんじのしょりをかいぜん",
            DictionaryPaths { system: Some(root.into()), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        assert_eq!(converted, "漢字の処理を改善");
    }

    #[test]
    fn converts_common_technical_katakana_without_losing_surface_script() {
        assert_eq!(convert_kana_to_kanji("データをダウンロード"), "データをダウンロード");
        assert_eq!(convert_kana_to_kanji("せっていのアップデート"), "設定のアップデート");
    }

    #[test]
    fn preserves_unknown_katakana_surface() {
        assert_eq!(convert_kana_to_kanji("カタカナ"), "カタカナ");
        assert_eq!(convert_kana_to_kanji("ＡＢＣ"), "ABC");
    }

    #[test]
    fn preserves_katakana_when_dictionary_identity_row_matches() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-katakana-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "かたかな\tかたかな\t-1\n").expect("fixture should write");
        let converted = super::convert_kana_to_kanji_with_paths(
            "カタカナ",
            DictionaryPaths { system: Some(root.clone()), ..DictionaryPaths::default() },
        )
        .expect("identity dictionary should load");
        assert_eq!(converted, "カタカナ");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn preserves_katakana_when_dictionary_offers_a_kanji_homophone() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-katakana-kanji-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "かたかな\t片仮名\t-1\n").expect("fixture should write");
        let converted = super::convert_kana_to_kanji_with_paths(
            "カタカナ",
            DictionaryPaths { system: Some(root.clone()), ..DictionaryPaths::default() },
        )
        .expect("kanji homophone dictionary should load");
        assert_eq!(converted, "カタカナ");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn preserves_katakana_when_dictionary_offers_latin_transliteration() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-katakana-latin-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "あっぷろーど\tアップroad\t-1\n").expect("fixture should write");
        let converted = super::convert_kana_to_kanji_with_paths(
            "アップロード",
            DictionaryPaths { system: Some(root.clone()), ..DictionaryPaths::default() },
        )
        .expect("latin transliteration dictionary should load");
        assert_eq!(converted, "アップロード");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn normalizes_fullwidth_numeric_special_conversion() {
        assert_eq!(convert_kana_to_kanji("１２３"), "123");
    }

    #[test]
    fn converts_spoken_numerals_inside_captions() {
        assert_eq!(convert_kana_to_kanji("さんびゃく"), "300");
        assert_eq!(convert_kana_to_kanji("にせんにじゅうごねん"), "2025年");
        assert_eq!(convert_kana_to_kanji("じゅう"), "10");
        assert_eq!(convert_kana_to_kanji("いち、に、さん"), "1、2、3");
        assert_eq!(convert_kana_to_kanji("さんえん"), "3円");
        assert_eq!(convert_kana_to_kanji("さんにん"), "3人");
        assert_eq!(convert_kana_to_kanji("いちにち"), "1日");
        assert_eq!(convert_kana_to_kanji("ありがとうご"), "ありがとうご");
    }

    #[test]
    fn selects_user_dictionary_entry_and_returns_n_best() {
        let root = std::env::temp_dir().join(format!("caption-bridge-{}", std::process::id()));
        // AzooKey scores are log-probabilities: -1 outranks the built-in -10.
        fs::write(&root, "はいしん\t配信中\t-1\n").expect("fixture should write");
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
    fn keeps_duplicate_surface_candidates_with_distinct_context_metadata() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-context-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "はいしん\t配信\t-1\t1\t1\t1\nはいしん\t配信\t-2\t2\t2\t2\n")
            .expect("fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("TSV dictionary should load");
        let candidates = convert_with_dictionary(
            "はいしん",
            &dictionary,
            ConversionOptions { n_best: 3, ..ConversionOptions::default() },
        );
        assert!(
            candidates.iter().filter(|candidate| candidate.text == "配信").count() >= 2,
            "distinct POS/CID contexts should survive beam deduplication"
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn dictionary_entry_metadata_is_available_to_callers() {
        let entry = DictionaryEntry::plain("はいしん", "配信", -10.0);
        assert_eq!(entry.mid, 501);
    }

    #[test]
    fn converts_weather_and_soup_homophones_with_public_dictionary() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.into()),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("そとのてんきがあついから", "外の天気が暑いから"),
            ("外の天気があついから", "外の天気が暑いから"),
            ("あついすーぷはたべたくない", "熱いスープは食べたくない"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }
    }

    #[test]
    fn converts_requested_weather_and_soup_sentences_with_public_dictionary() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.into()),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("きょうのてんきはあつい", "今日の天気は暑い"),
            ("すーぷがあつい", "スープが熱い"),
            ("あついりょうりはおいしい", "熱い料理は美味しい"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }
    }

    #[test]
    fn keeps_an_unknown_hiragana_suffix_readable_after_a_dictionary_clause() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let converted = convert_kana_to_kanji_with_paths(
            "あしたははれるでしょう",
            DictionaryPaths { system: Some(root.into()), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        // The implementation uses AzooKey's generic whole-hiragana fallback
        // for a suffix absent from the dictionary; no `でしょう` replacement
        // is embedded in the converter.
        assert_eq!(converted, "明日は晴れるでしょう");
    }

    #[test]
    fn keeps_long_public_dictionary_paths_in_the_default_beam() {
        let Ok(root) = std::env::var("AZOOKEY_DICTIONARY_ROOT") else {
            return;
        };
        let converted = convert_kana_to_kanji_with_paths(
            "となりのきゃくはよくかきくうきゃくだ",
            DictionaryPaths { system: Some(root.into()), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        // A narrow (five-state) beam used to commit to `下記くうきゃくだ`
        // before the later verb/nominal connections were available. The
        // wider default keeps the complete lexical path without embedding a
        // phrase-specific replacement.
        assert_eq!(converted, "隣の客は良くかきくう客だ");
    }
}
