use super::dictionary::{
    AzooKeyDictionary, DictionaryEntry, DictionaryPaths, BOS_EOS_MID, DEFAULT_CID, DEFAULT_MID,
};
use super::normalization::{
    is_boundary, japanese_counter_starts_at, japanese_numeral_has_unit, numeric_counter_surface,
    numeric_surface_prefix, to_hiragana, to_katakana,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrecedingContext {
    pub rcid: u16,
    pub mid: u16,
}

const DEFAULT_BEAM_WIDTH: usize = 64;
const MIN_BEAM_WIDTH: usize = 1;
const MAX_BEAM_WIDTH: usize = 256;
const DEFAULT_MAX_DICTIONARY_WORD_CHARS: usize = 24;
const MIN_DICTIONARY_WORD_CHARS: usize = 1;
const MAX_DICTIONARY_WORD_CHARS: usize = 128;
const MIN_LEXICAL_ENTRY_CHARS: usize = 2;
const MIN_FOLLOWING_CONTENT_CHARS: usize = 3;
const MIN_UNKNOWN_FALLBACK_CHARS: usize = 2;
const MIN_UNKNOWN_SPAN_CHARS: usize = 4;
const CONTEXT_LOOKBACK_CHARS: usize = 8;
const NO_SCORE: f32 = 0.0;
const NUMERIC_BOUNDARY_SCORE: f32 = -1.0;
const NUMERIC_AMBIGUOUS_SCORE: f32 = -12.0;
const NUMERIC_COUNTER_SCORE_PENALTY: f32 = -0.25;
const UNKNOWN_SPAN_PENALTY: f32 = -14.5;
const INFLECTIONAL_SURFACE_PENALTY: f32 = -10.0;
const ORTHOGRAPHIC_SURFACE_PENALTY: f32 = -3.0;
const IDENTITY_SURFACE_PENALTY: f32 = -1.5;
const MODEL_DEFAULT_METADATA_PENALTY: f32 = -2.0;
const MODEL_DEFAULT_MID_PENALTY: f32 = -2.5;
const GRAMMATICAL_CONTEXT_BONUS: f32 = 4.0;
const CONTEXTUAL_ENTRY_BONUS: f32 = 2.5;
const MIN_IDENTITY_FALLBACK_CHARS: usize = 2;
const INFLECTIONAL_IDENTITY_FALLBACK_VALUE: f32 = -3.0;
const PARTICLE_IDENTITY_FALLBACK_VALUE: f32 = -1.0;
const UNFINISHED_IDENTITY_FALLBACK_BASE: f32 = -24.0;
const IDENTITY_FALLBACK_LENGTH_PENALTY: f32 = 1.5;

fn bounded_dictionary_word_chars(value: usize) -> usize {
    value.clamp(MIN_DICTIONARY_WORD_CHARS, MAX_DICTIONARY_WORD_CHARS)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConversionOptions {
    pub n_best: usize,
    pub max_dictionary_word_chars: usize,
    pub preceding: Option<PrecedingContext>,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        // Keep a wide enough beam for long Japanese utterances.  A narrow
        // beam can prune a locally expensive particle/verb edge before a
        // later connection cost makes the complete Kanji path preferable.
        // Keep the beam wide enough for long Japanese utterances while
        // retaining a bounded per-position memory footprint.
        Self {
            n_best: DEFAULT_BEAM_WIDTH,
            max_dictionary_word_chars: DEFAULT_MAX_DICTIONARY_WORD_CHARS,
            preceding: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversionCandidate {
    pub text: String,
    pub score: f32,
    pub trailing: Option<PrecedingContext>,
}

// A missing dictionary edge should lose to even a low-confidence system
// entry (system rows below the -17 quality floor are filtered separately).
// Keeping this as an explicit lattice penalty also prevents an all-kana
// unknown span from outranking a known multi-character word.
const UNKNOWN_CHARACTER_PENALTY: f32 = -36.0;
// Keep the unknown continuation bounded.  A full remaining utterance is not
// a useful token: it can hide dictionary words that begin a few characters
// later (for example the `く` before `くう` in a long caption).
const MAX_UNKNOWN_KANA_SPAN_CHARS: usize = 4;

#[derive(Debug, Clone)]
struct PathState {
    text: String,
    /// The score used while updating the lattice.  This intentionally only
    /// contains word and CID transition costs: AzooKey applies its meaning
    /// (MM) bigram after the complete clause sequence has been built, not
    /// while pruning intermediate lattice nodes.
    score: f32,
    /// Clause-level meaning-bigram cost accumulated for the path.  Keeping it
    /// separate from `score` preserves the upstream beam ordering while still
    /// making it available when the final candidate is ranked.
    meaning_score: f32,
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
        return vec![ConversionCandidate {
            text: trimmed.to_string(),
            score: NO_SCORE,
            trailing: None,
        }];
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
    let width = options.n_best.clamp(MIN_BEAM_WIDTH, MAX_BEAM_WIDTH);
    let mut states = vec![Vec::<PathState>::new(); chars.len() + 1];
    states[0].push(PathState {
        text: String::new(),
        score: NO_SCORE,
        meaning_score: NO_SCORE,
        last: None,
        clause_mid: BOS_EOS_MID,
        clause_has_word: false,
    });

    for start in 0..chars.len() {
        let current = states[start].clone();
        if current.is_empty() {
            continue;
        }
        let entries = dictionary
            .entries_starting_at(
                &chars,
                start,
                bounded_dictionary_word_chars(options.max_dictionary_word_chars),
            )
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
                        NUMERIC_BOUNDARY_SCORE
                    } else {
                        NUMERIC_AMBIGUOUS_SCORE
                    };
                    push_state(
                        &mut states[start + numeric_length],
                        PathState {
                            text: format!("{}{}", state.text, surface),
                            score: state.score + numeric_score,
                            meaning_score: state.meaning_score,
                            last: None,
                            clause_mid: BOS_EOS_MID,
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
                                score: state.score + numeric_score + NUMERIC_COUNTER_SCORE_PENALTY,
                                meaning_score: state.meaning_score,
                                last: None,
                                clause_mid: BOS_EOS_MID,
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
                    meaning_score: state.meaning_score,
                    last: None,
                    clause_mid: BOS_EOS_MID,
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
            let particle_followed_by_adjective = following_has_lexical_adjective(
                dictionary,
                &chars,
                start,
                bounded_dictionary_word_chars(options.max_dictionary_word_chars),
            );
            // Keep the readable fallback for genuinely unknown continuations
            // only. If this position already has a multi-kana lexical entry,
            // the unknown edge can outrank the real CID/MM path and suppress
            // homophone conversion (for example `あつい` or `から`).
            let has_lexical_entry = entries.iter().any(|entry| {
                let entry_len = entry.reading.chars().count();
                entry_len >= MIN_LEXICAL_ENTRY_CHARS
                    && !chars
                        .get(start + entry_len)
                        .is_some_and(|character| is_small_hiragana(*character))
                    && (entry.surface != entry.reading
                        || contains_kanji(&entry.surface)
                        || entry.surface.chars().any(|character| is_katakana(&character)))
            });
            let unknown_after_predicate = state.last.as_ref().is_some_and(|entry| {
                entry.surface.ends_with('る')
                    || entry.surface.ends_with('た')
                    || entry.surface.ends_with('く')
                    || entry.surface.ends_with("ない")
            });
            if start > 0
                && state.last.is_some()
                && !particle_followed_by_adjective
                && (!has_lexical_entry || unknown_after_predicate)
                && dictionary.has_system_dictionary()
            {
                if let Some(end) = unknown_kana_span_end(
                    dictionary,
                    &chars,
                    start,
                    bounded_dictionary_word_chars(options.max_dictionary_word_chars),
                    unknown_after_predicate,
                ) {
                    let length = end - start;
                    if length >= MIN_UNKNOWN_FALLBACK_CHARS {
                        let surface: String = source_chars[start..end].iter().collect();
                        push_state(
                            &mut states[end],
                            PathState {
                                text: format!("{}{}", state.text, surface),
                                // Match AzooKey's all-hiragana fallback without
                                // allowing a long unknown span to outrank known
                                // dictionary words.
                                score: state.score + unknown_kana_span_penalty(length),
                                meaning_score: state.meaning_score,
                                last: None,
                                clause_mid: BOS_EOS_MID,
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
                        meaning_score: state.meaning_score,
                        last: None,
                        clause_mid: BOS_EOS_MID,
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
                if prolonged_mark_adjacent_to_span(&source_chars, &chars, start, end)
                    && !entry.surface.chars().any(|character| is_katakana(&character))
                {
                    continue;
                }
                let (connection, clause_mid, clause_has_word, meaning_delta) =
                    transition_score(dictionary, &state, entry, options.preceding);
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
                            + orthographic_surface_penalty(
                                dictionary,
                                &source_chars[start..end],
                                entry,
                            )
                            + identity_surface_penalty(
                                dictionary,
                                &source_chars[start..end],
                                entry,
                            )
                            + model_metadata_penalty(dictionary, entry)
                            + grammatical_context_bonus(&state, entry)
                            + contextual_entry_bonus(
                                dictionary,
                                &chars,
                                start,
                                end,
                                entry,
                                bounded_dictionary_word_chars(options.max_dictionary_word_chars),
                            ),
                        meaning_score: state.meaning_score + meaning_delta,
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
                        let (identity_connection, clause_mid, clause_has_word, meaning_delta) =
                            transition_score(dictionary, &state, &identity, options.preceding);
                        push_state(
                            &mut states[end],
                            PathState {
                                text: format!("{}{}", state.text, identity.surface),
                                score: state.score + identity.value + identity_connection,
                                meaning_score: state.meaning_score + meaning_delta,
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
        .map(|state| ConversionCandidate {
            text: state.text.clone(),
            score: state.score + state.meaning_score,
            trailing: state
                .last
                .as_ref()
                .map(|entry| PrecedingContext { rcid: entry.rcid, mid: state.clause_mid }),
        })
        .collect::<Vec<_>>();
    // Intermediate lattice nodes are ordered by their base score.  The final
    // candidate order must be recomputed after adding clause-level MM costs,
    // otherwise a lower-scoring base path can never become the best rendered
    // conversion even when its context is much more likely.
    results.sort_by(|left, right| right.score.total_cmp(&left.score));
    if results.is_empty() {
        results.push(ConversionCandidate {
            text: trimmed.to_string(),
            score: NO_SCORE,
            trailing: None,
        });
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
        INFLECTIONAL_SURFACE_PENALTY
    } else {
        NO_SCORE
    }
}

/// Prefer a Kanji spelling when speech was supplied as hiragana and the
/// dictionary also exposes a Katakana homograph.  Katakana loanwords remain
/// available when no Kanji alternative exists (for example `てすと` →
/// `テスト`), so this is an orthographic prior rather than a word table.
fn orthographic_surface_penalty(
    dictionary: &AzooKeyDictionary,
    source: &[char],
    entry: &DictionaryEntry,
) -> f32 {
    if !source_is_hiragana_surface(source)
        || !entry.surface.chars().any(|character| is_katakana(&character))
    {
        return NO_SCORE;
    }
    let has_kanji_alternative = dictionary
        .lookup_exact(&entry.reading)
        .unwrap_or_default()
        .iter()
        .any(|candidate| contains_kanji(&candidate.surface));
    if has_kanji_alternative {
        ORTHOGRAPHIC_SURFACE_PENALTY
    } else {
        NO_SCORE
    }
}

/// Prefer an available lexical Kanji spelling over a same-POS hiragana
/// identity row when the source itself is hiragana. Identity rows remain in
/// the lattice for grammar/CID context; this only gives an orthographic prior
/// when a matching Kanji alternative carries the same POS metadata.
fn identity_surface_penalty(
    dictionary: &AzooKeyDictionary,
    source: &[char],
    entry: &DictionaryEntry,
) -> f32 {
    if !source_is_hiragana_surface(source) || entry.surface != entry.reading {
        return NO_SCORE;
    }
    let has_kanji_alternative =
        dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
            candidate.lcid == entry.lcid
                && candidate.rcid == entry.rcid
                && contains_kanji(&candidate.surface)
        });
    if has_kanji_alternative {
        IDENTITY_SURFACE_PENALTY
    } else {
        NO_SCORE
    }
}

/// Avoid letting a generic/default metadata row beat a more specific system
/// row solely because its MM transition happens to be cheaper. The public
/// dictionary uses CID 1285 and MID 501 as broad fallback classes; when a
/// reading has a same-span alternative with richer CID/MID metadata, keep the
/// fallback available but apply a small model-derived prior.
fn model_metadata_penalty(dictionary: &AzooKeyDictionary, entry: &DictionaryEntry) -> f32 {
    if !dictionary.has_system_dictionary() || !contains_kanji(&entry.surface) {
        return NO_SCORE;
    }
    let alternatives = dictionary.lookup_exact(&entry.reading).unwrap_or_default();
    let mut penalty = NO_SCORE;
    let best_specific_value = alternatives
        .iter()
        .filter(|candidate| {
            candidate.lcid != DEFAULT_CID
                && candidate.rcid != DEFAULT_CID
                && contains_kanji(&candidate.surface)
        })
        .map(|candidate| candidate.value)
        .max_by(f32::total_cmp);
    if entry.lcid == DEFAULT_CID
        && entry.rcid == DEFAULT_CID
        && best_specific_value.is_some_and(|value| entry.value < value)
    {
        penalty += MODEL_DEFAULT_METADATA_PENALTY;
    }
    let best_same_cid_value = alternatives
        .iter()
        .filter(|candidate| {
            candidate.lcid == entry.lcid
                && candidate.rcid == entry.rcid
                && candidate.mid != DEFAULT_MID
                && contains_kanji(&candidate.surface)
        })
        .map(|candidate| candidate.value)
        .max_by(f32::total_cmp);
    if entry.mid == DEFAULT_MID && best_same_cid_value.is_some_and(|value| entry.value < value) {
        penalty += MODEL_DEFAULT_MID_PENALTY;
    }
    penalty
}

/// A function-word identity row is a useful grammatical continuation after
/// an adjective/verb, while unrelated Kanji homophones for the same reading
/// should remain available in noun contexts.  Use POS-neutral surface shape
/// and the preceding dictionary node; no fixed phrase mapping is involved.
fn grammatical_context_bonus(state: &PathState, entry: &DictionaryEntry) -> f32 {
    let Some(former) = state.last.as_ref() else {
        return NO_SCORE;
    };
    if entry.surface != entry.reading
        || !is_particle_reading(&entry.reading)
        || !former.surface.ends_with('い')
    {
        return NO_SCORE;
    }
    GRAMMATICAL_CONTEXT_BONUS
}

fn is_particle_reading(reading: &str) -> bool {
    matches!(
        reading,
        "は" | "が"
            | "を"
            | "に"
            | "へ"
            | "で"
            | "と"
            | "も"
            | "の"
            | "から"
            | "まで"
            | "より"
            | "だけ"
            | "しか"
            | "ほど"
            | "ので"
            | "けど"
            | "けれど"
    )
}

fn transition_score(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
    preceding: Option<PrecedingContext>,
) -> (f32, u16, bool, f32) {
    let Some(former) = state.last.as_ref() else {
        let clause_mid = if entry.mid != BOS_EOS_MID { entry.mid } else { BOS_EOS_MID };
        let (connection, former_mid) = match preceding {
            Some(ctx) => (dictionary.context_connection_cost(ctx.rcid, entry), ctx.mid),
            None => (dictionary.beginning_connection_cost(entry), BOS_EOS_MID),
        };
        let meaning_delta = dictionary.meaning_connection_cost(former_mid, clause_mid);
        return (connection, clause_mid, true, meaning_delta);
    };

    let score = dictionary.class_connection_cost(former, entry);
    let starts_clause = dictionary.is_clause_boundary(former.rcid, entry.lcid);
    if starts_clause {
        let next_clause_mid =
            if dictionary.include_meaning_cost(entry) { entry.mid } else { BOS_EOS_MID };
        let meaning_delta = dictionary.meaning_connection_cost(state.clause_mid, next_clause_mid);
        return (score, next_clause_mid, true, meaning_delta);
    }

    let clause_mid = if dictionary.include_meaning_cost(entry)
        || (!state.clause_has_word && entry.mid != BOS_EOS_MID)
    {
        entry.mid
    } else {
        state.clause_mid
    };
    (score, clause_mid, true, NO_SCORE)
}

fn unknown_kana_span_end(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
    allow_particle_suffix: bool,
) -> Option<usize> {
    let first = *chars.get(start)?;
    // Small kana are orthographic continuations of the preceding syllable;
    // treating `ゃく` as an independent unknown token would let a short
    // high-frequency entry such as `気` beat the full `きゃく` dictionary row.
    if (!is_hiragana(first) && first != 'ー') || is_small_hiragana(first) {
        return None;
    }
    // A dictionary-backed multi-kana entry at this position is a lexical
    // candidate, even when the surrounding state is provisional. Let the
    // normal lattice rank it instead of replacing it with an all-kana span.
    let has_lexical_entry = dictionary
        .entries_starting_at(chars, start, max_dictionary_word_chars)
        .unwrap_or_default()
        .iter()
        .any(|entry| {
            let entry_len = entry.reading.chars().count();
            entry_len >= MIN_LEXICAL_ENTRY_CHARS
                && !chars
                    .get(start + entry_len)
                    .is_some_and(|character| is_small_hiragana(*character))
                && (entry.surface != entry.reading
                    || contains_kanji(&entry.surface)
                    || entry.surface.chars().any(|character| is_katakana(&character)))
        });
    if has_lexical_entry && !allow_particle_suffix {
        return None;
    }
    let mut end = start + 1;
    while end < chars.len()
        && end - start < MAX_UNKNOWN_KANA_SPAN_CHARS
        && (is_hiragana(chars[end]) || chars[end] == 'ー')
    {
        end += 1;
    }
    // A particle can be the first syllable of an unfinished auxiliary or
    // colloquial suffix (for example `でしょう`). Keep that suffix as one
    // readable kana span rather than forcing a low-confidence homonym at the
    // next index. The normal lattice still exposes the particle and every
    // following dictionary edge as separate alternatives.
    if is_particle(first) {
        if allow_particle_suffix {
            return Some(end);
        }
        // Keep a particle available as its own edge when a dictionary word
        // starts immediately after it (`のきゃく`, `はれる`, ...).  Unknown
        // auxiliaries such as `でしょう` still use the whole short span.
        let following_has_word = dictionary
            .entries_starting_at(chars, start + 1, max_dictionary_word_chars)
            .unwrap_or_default()
            .iter()
            .any(|entry| entry.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS);
        // Do not let an unresolved particle sequence swallow a lexical word
        // that begins a few characters later (`のでさます`, `のですずしい`,
        // ...).  The generic suffix fallback is intentionally bounded, but a
        // particle inside that bounded run is still a hard lattice boundary.
        // Leave the particle/auxiliary edges to the normal per-position pass;
        // this preserves the lexical candidate without embedding a phrase.
        if chars[start + 1..end].iter().any(|character| is_particle(*character)) {
            return None;
        }
        return Some(if following_has_word { start + 1 } else { end });
    }
    // Short runs are more likely to be valid dictionary words than an
    // unknown span. Require a full four-kana run, and avoid crossing a clear
    // particle boundary (`てんきは`, `あしたの`, ...).
    if end - start < MIN_UNKNOWN_SPAN_CHARS
        || chars[start + 1..end].iter().any(|character| is_particle(*character))
    {
        return None;
    }
    // Keep the whole short run available even when the dictionary has
    // homographs beginning inside it.  The beam can then compare a readable
    // kana fallback against a sequence of unrelated lexical fragments (for
    // example an uncertain ASR tail); the ordinary dictionary edges remain
    // available as alternatives.
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
    UNKNOWN_SPAN_PENALTY
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
            entry.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
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
    if alternatives.len() < MIN_LEXICAL_ENTRY_CHARS {
        return NO_SCORE;
    }
    let rank = alternatives
        .iter()
        .position(|candidate| candidate.surface == entry.surface && candidate.mid == entry.mid);
    let Some(rank) = rank else {
        return NO_SCORE;
    };
    let following_content = following_context_is_content(
        dictionary,
        chars.get(end..).unwrap_or_default(),
        max_dictionary_word_chars,
    );
    let preceding_content = preceding_context_is_content(chars.get(..start).unwrap_or_default());
    let adjective_like = entry.surface.ends_with('い') && contains_kanji(&entry.surface);
    if !following_content && !preceding_content && !adjective_like {
        return NO_SCORE;
    }
    let desired_rank = usize::from(following_content || preceding_content);
    if rank == desired_rank {
        CONTEXTUAL_ENTRY_BONUS
    } else {
        NO_SCORE
    }
}

fn preceding_context_is_content(before: &[char]) -> bool {
    before.iter().rev().take(CONTEXT_LOOKBACK_CHARS).any(|character| *character == 'ー')
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
    if after.iter().take(CONTEXT_LOOKBACK_CHARS).any(|character| *character == 'ー') {
        return true;
    }
    let next_entries =
        dictionary.entries_starting_at(after, 0, max_dictionary_word_chars).unwrap_or_default();
    if next_entries.is_empty() {
        return after.len() >= MIN_FOLLOWING_CONTENT_CHARS
            && !after
                .iter()
                .take(MIN_FOLLOWING_CONTENT_CHARS)
                .all(|character| is_hiragana(*character));
    }
    next_entries.iter().any(|candidate| {
        candidate.reading.chars().count() >= MIN_FOLLOWING_CONTENT_CHARS
            && contains_kanji(&candidate.surface)
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
        || reading.len() < MIN_IDENTITY_FALLBACK_CHARS
        || candidate.surface == candidate.reading
        || !contains_kanji(&candidate.surface)
    {
        return None;
    }
    let same_pos_continuation = former.rcid == candidate.lcid && candidate.lcid == candidate.rcid;
    let inflectional_continuation = former.surface.ends_with('く')
        && candidate.surface.ends_with('い')
        && reading.len() <= MIN_IDENTITY_FALLBACK_CHARS;
    let particle_continuation = is_particle_reading(&reading.iter().collect::<String>())
        && (former.surface.ends_with('い')
            || former.surface.ends_with('る')
            || former.surface.ends_with('た')
            || former.surface.ends_with("ない"));
    if !(same_pos_continuation || inflectional_continuation || particle_continuation) {
        return None;
    }
    let value = if inflectional_continuation {
        // Preserve a readable kana auxiliary after a verb/adjective stem;
        // this is a general conjugation rule, not a word-pair exception.
        INFLECTIONAL_IDENTITY_FALLBACK_VALUE
    } else if particle_continuation {
        // A function-word continuation after a predicate is a grammatical
        // edge. Keep it preferred to unrelated Kanji homophones (e.g. `から`
        // after an adjective) while leaving noun contexts untouched.
        PARTICLE_IDENTITY_FALLBACK_VALUE
    } else {
        // A kana identity edge is an escape hatch for an incomplete clause,
        // not a competing lexical interpretation.  Keep it below a real
        // system-dictionary surface so a contextual Kanji candidate wins when
        // the reading is fully covered (while still retaining the edge for
        // genuinely unfinished speech).
        UNFINISHED_IDENTITY_FALLBACK_BASE
            - (reading.len().saturating_sub(MIN_IDENTITY_FALLBACK_CHARS) as f32
                * IDENTITY_FALLBACK_LENGTH_PENALTY)
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
    if left.clause_mid != right.clause_mid
        || left.clause_has_word != right.clause_has_word
        // MM is deliberately excluded from the intermediate ordering, but
        // two paths with different accumulated clause histories can receive
        // different final scores. Do not collapse those alternatives merely
        // because their current CID/MID context is identical.
        || left.meaning_score.total_cmp(&right.meaning_score) != std::cmp::Ordering::Equal
    {
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
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let converted = super::convert_kana_to_kanji_with_paths(
            "かんじのしょりをかいぜん",
            DictionaryPaths { system: Some(root), ..DictionaryPaths::default() },
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
    fn portable_dictionary_quality_is_ranked_and_stable_across_prefixes() {
        // This mirrors AzooKey's accuracy/gradual-input tests with generated
        // dictionary rows rather than a production phrase list.  It checks
        // the converter's general lattice contracts: a higher-scoring full
        // edge wins over a raw tail, every prefix remains convertible, and
        // candidate ordering is deterministic.
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-quality-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        let stem_reading = "ぬへも";
        let full_reading = "ぬへもよ";
        let full_surface = "検証子";
        let fixture = format!(
            "{stem_reading}\t検証語\t-4\n{stem_reading}\t検証歩\t-8\n{full_reading}\t{full_surface}\t-3\n"
        );
        fs::write(&root, fixture).expect("quality fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("quality fixture should load");

        let options = ConversionOptions { n_best: 8, ..ConversionOptions::default() };
        let full = convert_with_dictionary(full_reading, &dictionary, options);
        assert!(!full.is_empty());
        assert_eq!(full[0].text, full_surface);
        assert!(full.windows(2).all(|pair| pair[0].score >= pair[1].score));
        assert!(full.len() <= options.n_best);

        for end in 1..=full_reading.chars().count() {
            let prefix: String = full_reading.chars().take(end).collect();
            let candidates = convert_with_dictionary(&prefix, &dictionary, options);
            assert!(!candidates.is_empty(), "no candidate for prefix {prefix}");
            assert!(candidates.iter().all(|candidate| candidate.text.chars().count() > 0));
            assert!(candidates.windows(2).all(|pair| pair[0].score >= pair[1].score));
        }

        // Re-running conversion over its own rendered result must not change
        // the surface, which catches accidental kana normalization loops.
        let rendered_again = convert_with_dictionary(&full[0].text, &dictionary, options);
        assert_eq!(rendered_again[0].text, full[0].text);

        let _ = fs::remove_file(root);
    }

    #[test]
    fn dictionary_entry_metadata_is_available_to_callers() {
        let entry = DictionaryEntry::plain("はいしん", "配信", -10.0);
        assert_eq!(entry.mid, 501);
    }

    #[test]
    fn converts_weather_and_soup_homophones_with_public_dictionary() {
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
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
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
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
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let converted = convert_kana_to_kanji_with_paths(
            "あしたははれるでしょう",
            DictionaryPaths { system: Some(root), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        // The implementation uses AzooKey's generic whole-hiragana fallback
        // for a suffix absent from the dictionary; no `でしょう` replacement
        // is embedded in the converter.
        assert_eq!(converted, "明日は晴れるでしょう");
    }

    #[test]
    fn does_not_swallow_a_lexical_suffix_after_a_particle_sequence() {
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        let candidate = convert_with_dictionary(
            "りょうりがあついのでさます",
            &dictionary,
            ConversionOptions::default(),
        )
        .into_iter()
        .next()
        .expect("public conversion should produce a candidate");
        // A bounded unknown-kana edge may preserve an unresolved particle, but
        // it must not consume the following dictionary word wholesale.
        assert_ne!(candidate.text, "料理が暑いのでさます");
    }

    #[test]
    fn keeps_long_public_dictionary_paths_in_the_default_beam() {
        let Some(root) = crate::dictionary::test_system_dictionary_path() else {
            return;
        };
        let converted = convert_kana_to_kanji_with_paths(
            "となりのきゃくはよくかきくうきゃくだ",
            DictionaryPaths { system: Some(root), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        // A narrow (five-state) beam used to commit to `下記くうきゃくだ`
        // before the later verb/nominal connections were available. The
        // wider default keeps the complete lexical path without embedding a
        // phrase-specific replacement.
        assert_eq!(converted, "隣の客は良くかきくう客だ");
    }
}
