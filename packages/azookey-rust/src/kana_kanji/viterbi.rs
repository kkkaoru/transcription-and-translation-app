use super::dictionary::{
    is_joshi_cid, is_postposition_cid, AzooKeyDictionary, DictionaryEntry, DictionaryPaths,
    BOS_EOS_MID, DEFAULT_CID, DEFAULT_MID,
};
use super::normalization::{
    is_boundary, japanese_counter_starts_at, japanese_numeral_has_unit, numeric_counter_surface,
    numeric_span_starts_with_digit, numeric_surface_prefix, to_hiragana, to_katakana,
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
/// Hiragana ASR readings without `ー` still map to Katakana ruby-id rows
/// (`ぱそこん` → `パソコン`). Two-mora grammatical ruby such as `です` →
/// `デス` stays source-script; those rows also lose to a stronger identity.
const MIN_KATAKANA_RUBY_LOANWORD_CHARS: usize = 3;
/// Closed-class personification / name suffixes. A full-span hiragana
/// identity such as `きりんさん` should lose to `キリン` + `さん`.
const HONORIFIC_READING_SUFFIXES: &[&str] = &["さん", "くん", "ちゃん", "さま", "たち"];
const IDENTITY_SURFACE_PENALTY: f32 = -1.5;
// A long identity row can hide a conventional multi-word Kanji segmentation
// when the system dictionary has no full-span Kanji row. Keep short function
// words and single lexical segments untouched.
const IDENTITY_SEGMENTATION_PENALTY: f32 = -4.0;
const MODEL_DEFAULT_METADATA_PENALTY: f32 = -2.0;
const MODEL_DEFAULT_MID_PENALTY: f32 = -2.5;
const COPULAR_CONTINUATION_PENALTY: f32 = -6.0;
const GRAMMATICAL_CONTEXT_BONUS: f32 = 4.0;
const CONTEXTUAL_ENTRY_BONUS: f32 = 4.5;
/// After a particle, prefer a strictly longer converted content word over one
/// of its dictionary prefixes (`は` + `のみたい` → `飲みたい` rather than
/// `のみ`/`の味` + `たい`/`体`). Soft penalty keeps the prefix in n-best.
const PARTICLE_FOLLOWING_SHORTER_PREFIX_PENALTY: f32 = -2.5;
/// Soft-demote a conjugational (verb-band) short Kanji head when a closed-class
/// continuation plus further content remains (`走` before `の`+`端`). Keeps the
/// row in n-best; bare readings without that continuation stay score-driven.
const VERB_STEM_BEFORE_PARTICLE_PHRASE_PENALTY: f32 = -4.0;
/// After a particle, soft-demote the unique unigram-leading Kanji homophone so
/// connection / MM evidence can compete (`恥` vs `端` after `の`). Alternatives
/// remain in the lattice.
const PARTICLE_FOLLOWING_UNIGRAM_LEADER_PENALTY: f32 = -3.0;
/// CID rows encode an in-sentence morphological transition. At the start of a
/// particle-linked content phrase, discount that transition so it cannot
/// overwhelm the lexical evidence for a short, otherwise ambiguous head word.
const INITIAL_PARTICLE_PHRASE_CONNECTION_DISCOUNT: f32 = 0.43;
/// Minimum reading length of a lexical word that may suppress its own short
/// Kanji prefixes (`き`/`機` under `きかく`/`規格`). One-kana and two-kana
/// pieces otherwise invent non-dictionary compounds such as `機各` / `券小`.
const MIN_SHADOWING_LEXICAL_CHARS: usize = 3;
/// Two-mora converted rows may trigger prefix pruning so a one-mora Kanji
/// homophone (`は`/`端`) cannot hide under a complete two-mora word (`はじ`/`端`).
const MIN_SHADOWING_TRIGGER_CHARS: usize = 2;
/// When a longer reading exists at the same start, keep at most this many
/// one-kana Kanji rows. Standalone one-kana inputs (`き` → `木`) skip the cap
/// so connection costs can still pick the natural orthography.
const MAX_ONE_KANA_KANJI_ENTRIES: usize = 24;
/// Prefer a list item that reuses Kanji from the previous comma-separated
/// clause (`一等賞` → `懸賞` over `検証`).
const COMMA_LIST_KANJI_OVERLAP_BONUS: f32 = 3.5;
/// Prefer currency orthography when the next clause is a spoken yen amount
/// (`こうか、じゅうえん` → `硬貨` over `効果`).
const FOLLOWING_YEN_AMOUNT_BONUS: f32 = 4.0;
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
struct NumericPrefixContext {
    length: usize,
    surface: String,
    has_unit: bool,
    has_digit_and_unit: bool,
    followed_by_counter: bool,
    followed_by_boundary: bool,
    invalid_shi_counter: bool,
    unit_span_is_unbounded: bool,
    numeric_context: bool,
    counter_span: Option<(usize, String)>,
    counter_has_numeric_variant: bool,
    counter_kanji_homophone: bool,
    counter_lexical_span: bool,
    explicit_digit: bool,
    lexical_same_span: bool,
    numeric_score: f32,
}

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
    /// Whether the path is currently inside a spoken-number chain. Bare kana
    /// digits are ambiguous homophones; retaining this bit lets a sequence
    /// such as `いち、に、さん` continue while blocking a suffix such as
    /// `校4` after an ordinary lexical word.
    numeric_chain: bool,
}

fn numeric_prefix_context(
    chars: &[char],
    start: usize,
    entries: &[DictionaryEntry],
) -> Option<NumericPrefixContext> {
    let (length, surface) = numeric_surface_prefix(&chars[start..])?;
    let reading: String = chars[start..start + length].iter().collect();
    let has_unit = japanese_numeral_has_unit(&reading);
    let has_digit_and_unit = has_unit && numeric_span_starts_with_digit(&reading);
    let suffix = &chars[start + length..];
    let followed_by_counter = japanese_counter_starts_at(suffix);
    let followed_by_boundary = suffix.first().is_some_and(|character| is_boundary(*character));
    let starts_after_boundary = start > 0 && is_boundary(chars[start - 1]);
    // The counter reading `じ` uses the contracted `よじ` form; treating the
    // standalone `し` reading as four here creates `4時` from `しじ`.
    let invalid_shi_counter =
        reading == "し" && suffix.first().is_some_and(|character| *character == 'じ');
    let starts_after_text = start > 0 && !starts_after_boundary;
    let unit_span_is_unbounded = has_unit
        && !has_digit_and_unit
        && starts_after_text
        && !followed_by_counter
        && !followed_by_boundary;
    let numeric_context =
        has_unit || followed_by_counter || followed_by_boundary || starts_after_boundary;
    let counter_span = numeric_counter_surface(suffix);
    let counter_numeric_surface =
        counter_span.as_ref().map(|(_, counter_surface)| format!("{}{}", surface, counter_surface));
    let counter_has_numeric_variant = counter_span.as_ref().is_some_and(|(counter_length, _)| {
        let full_length = length + counter_length;
        entries.iter().any(|entry| {
            entry.reading.chars().count() == full_length
                && entry.surface.chars().any(|character| character.is_ascii_digit())
        })
    });
    // If a same-span dictionary row already renders a numeric surface (5年,
    // 4月, ...), retain the numeric edge; otherwise a lexical homophone such
    // as 司会 would be allowed to manufacture 4回.
    let counter_kanji_homophone = counter_span.as_ref().is_some_and(|(counter_length, _)| {
        let full_length = length + counter_length;
        entries.iter().any(|entry| {
            entry.reading.chars().count() == full_length
                && entry.surface != entry.reading
                && contains_kanji(&entry.surface)
                && counter_numeric_surface.as_deref() != Some(entry.surface.as_str())
        })
    });
    let counter_lexical_span = if counter_has_numeric_variant {
        false
    } else {
        counter_span.as_ref().is_some_and(|(counter_length, _)| {
            let full_length = length + counter_length;
            entries.iter().any(|entry| {
                entry.reading.chars().count() == full_length
                    && entry.surface != entry.reading
                    && counter_numeric_surface.as_deref() != Some(entry.surface.as_str())
            })
        })
    };
    let explicit_digit = reading
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit() || ('０'..='９').contains(&character));
    let lexical_same_span = entries.iter().any(|entry| {
        entry.reading.chars().count() == length
            && entry.surface != entry.reading
            && contains_kanji(&entry.surface)
    });
    let numeric_score = if has_digit_and_unit
        || followed_by_counter
        || followed_by_boundary
        || starts_after_boundary
        || start == 0
    {
        NUMERIC_BOUNDARY_SCORE
    } else {
        NUMERIC_AMBIGUOUS_SCORE
    };
    Some(NumericPrefixContext {
        length,
        surface,
        has_unit,
        has_digit_and_unit,
        followed_by_counter,
        followed_by_boundary,
        invalid_shi_counter,
        unit_span_is_unbounded,
        numeric_context,
        counter_span,
        counter_has_numeric_variant,
        counter_kanji_homophone,
        counter_lexical_span,
        explicit_digit,
        lexical_same_span,
        numeric_score,
    })
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
        numeric_chain: false,
    });

    for start in 0..chars.len() {
        let current = states[start].clone();
        if current.is_empty() {
            continue;
        }
        let max_dictionary_word_chars =
            bounded_dictionary_word_chars(options.max_dictionary_word_chars);
        let entries = prune_short_kanji_prefix_entries(
            dictionary,
            &chars,
            start,
            dictionary
                .entries_starting_at(&chars, start, max_dictionary_word_chars)
                .unwrap_or_default(),
            chars.len() - start,
            max_dictionary_word_chars,
        );
        let numeric_prefix = numeric_prefix_context(&chars, start, &entries);
        for state in current {
            // A caption can end one kana after a high-confidence lexical
            // prefix (`ありがとうご`). Treat that final non-particle kana as
            // an unresolved continuation and retain the original utterance
            // as a candidate. This keeps a public-dictionary homophone from
            // winning solely because its one-character tail is unknown,
            // while complete lexical entries and grammatical particles keep
            // their normal ranking.
            if start == 0
                && unresolved_single_tail_candidate(
                    dictionary,
                    &chars,
                    &source_chars,
                    &entries,
                    bounded_dictionary_word_chars(options.max_dictionary_word_chars),
                )
            {
                push_state(
                    &mut states[chars.len()],
                    PathState {
                        text: trimmed.to_string(),
                        score: UNKNOWN_SPAN_PENALTY
                            + unknown_span_multi_kanji_segmentation_penalty(
                                dictionary,
                                &chars,
                                max_dictionary_word_chars,
                            ),
                        meaning_score: NO_SCORE,
                        last: None,
                        clause_mid: BOS_EOS_MID,
                        clause_has_word: false,
                        numeric_chain: false,
                    },
                    width,
                );
            }
            if let Some(numeric) = numeric_prefix.as_ref() {
                // Do not exempt `followed_by_boundary` or
                // `starts_after_boundary` here. A lexical word immediately
                // before punctuation can still end in a bare numeric
                // homophone (`こうし、...`), so only a real number chain may
                // carry that one-kana reading forward.
                let bare_digit_outside_chain = !numeric.has_unit
                    && !numeric.followed_by_counter
                    && !numeric.explicit_digit
                    && !state.numeric_chain;
                let unit_only_outside_chain = numeric.has_unit
                    && !numeric.has_digit_and_unit
                    && !numeric.followed_by_counter
                    && !state.numeric_chain
                    && start > 0;
                // Excluding a same-span lexical candidate only when plain
                // text follows is intentional: a number ending at punctuation
                // (`じゅう、`) must remain available.
                let shadowed_numeric_span = start + numeric.length < chars.len()
                    && !state.numeric_chain
                    && !numeric.followed_by_counter
                    && !numeric.followed_by_boundary
                    && numeric.lexical_same_span;
                let shadowed_single_digit_counter = numeric.length == 1
                    && numeric.followed_by_counter
                    && numeric.counter_lexical_span
                    && !state.numeric_chain;
                // A numeric counter that begins inside an ordinary lexical
                // span is usually a dictionary homophone (for example
                // `ぞくじ` -> `俗字`, not `ぞ9時`). Keep genuine number
                // chains available, and retain multi-kana counters when a
                // Kanji homophone explicitly competes with their numeric row.
                let shadowed_midword_counter = numeric.followed_by_counter
                    && !state.numeric_chain
                    && start > 0
                    && !is_boundary(chars[start - 1])
                    && numeric.counter_has_numeric_variant
                    && (numeric.length == 1 || !numeric.counter_kanji_homophone);
                // After short Kanji-prefix pruning, a bare number such as
                // `せん` → `1000` can outrank the remaining longer word
                // (`戦争`). Suppress that number when a longer converted
                // lexical entry still covers this start.
                let shadowed_by_longer_lexical = !state.numeric_chain
                    && !numeric.followed_by_counter
                    && !numeric.explicit_digit
                    && entries.iter().any(|entry| {
                        let len = entry.reading.chars().count();
                        len > numeric.length
                            && entry.surface != entry.reading
                            && contains_kanji(&entry.surface)
                            && !is_particle_reading(&entry.reading)
                    });
                if (numeric.numeric_context || start == 0)
                    && (!bare_digit_outside_chain || start == 0)
                    && !unit_only_outside_chain
                    && !shadowed_numeric_span
                    && !shadowed_single_digit_counter
                    && !shadowed_midword_counter
                    && !shadowed_by_longer_lexical
                    && !numeric.unit_span_is_unbounded
                    && !numeric.invalid_shi_counter
                {
                    push_state(
                        &mut states[start + numeric.length],
                        PathState {
                            text: format!("{}{}", state.text, numeric.surface),
                            score: state.score + numeric.numeric_score,
                            meaning_score: state.meaning_score,
                            last: None,
                            clause_mid: BOS_EOS_MID,
                            clause_has_word: false,
                            numeric_chain: true,
                        },
                        width,
                    );
                    // Once a spoken counter follows the number, emit its
                    // conventional Kanji surface as one grammatical edge.
                    // This prevents public-dictionary homophones such as
                    // `えん` -> 塩 from winning after `さん` while leaving
                    // ordinary `えん` unconstrained outside numeric context.
                    if let Some((counter_length, counter_surface)) = numeric.counter_span.as_ref() {
                        push_state(
                            &mut states[start + numeric.length + counter_length],
                            PathState {
                                text: format!(
                                    "{}{}{}",
                                    state.text, numeric.surface, counter_surface
                                ),
                                score: state.score
                                    + numeric.numeric_score
                                    + NUMERIC_COUNTER_SCORE_PENALTY,
                                meaning_score: state.meaning_score,
                                last: None,
                                clause_mid: BOS_EOS_MID,
                                clause_has_word: false,
                                numeric_chain: true,
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
                    numeric_chain: false,
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
                    && is_lexical_surface_for_unknown(entry)
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
                                score: state.score
                                    + unknown_kana_span_penalty(length)
                                    + unknown_span_multi_kanji_segmentation_penalty(
                                        dictionary,
                                        &chars[start..end],
                                        max_dictionary_word_chars,
                                    ),
                                meaning_score: state.meaning_score,
                                last: None,
                                clause_mid: BOS_EOS_MID,
                                clause_has_word: false,
                                numeric_chain: false,
                            },
                            width,
                        );
                    }
                }
            }
            if is_boundary(chars[start]) {
                // Clause-level MM context continues across sentence-internal
                // separators (comma/full stop), matching the upstream
                // punctuation dictionary nodes. Terminal/question/exclaim
                // marks end the lexical context instead; carrying the
                // previous clause through `？？` can crowd out the intended
                // kana continuation in short conversational captions.
                let keep_clause_context = matches!(chars[start], '、' | '。' | ',' | '.');
                // Numeric chains are intentionally narrower than `is_boundary`:
                // only `、`/`,` continue a chain; `。`/`.` terminate it.
                //
                // When the public dictionary already exposes a one-character
                // punctuation row for this mark, skip the free score+=0 edge.
                // That bypass drops CID/MID transitions and lets short Kanji
                // fragments invent compounds such as `券小` / `機各`.
                if !has_exact_punctuation_dictionary_entry(
                    &entries,
                    source_chars[start],
                    chars[start],
                ) {
                    push_state(
                        &mut states[start + 1],
                        PathState {
                            text: format!("{}{}", state.text, source_chars[start]),
                            score: state.score,
                            meaning_score: state.meaning_score,
                            last: keep_clause_context.then(|| state.last.clone()).flatten(),
                            clause_mid: if keep_clause_context {
                                state.clause_mid
                            } else {
                                BOS_EOS_MID
                            },
                            clause_has_word: keep_clause_context && state.clause_has_word,
                            numeric_chain: keep_clause_context
                                && state.numeric_chain
                                && matches!(chars[start], '、' | ','),
                        },
                        width,
                    );
                }
            }
            for entry in &entries {
                let entry_len = entry.reading.chars().count();
                let end = start + entry_len;
                if end > chars.len()
                    || chars[start..end].iter().collect::<String>() != entry.reading
                {
                    continue;
                }
                // Particle-position guards. Two different failure modes share
                // the "starts at a particle kana" lattice slot:
                //
                // 1) Short particle Kanji homophones (`は` → `端`/`歯`) after a
                //    converted content word. Source Kanji catches mixed script
                //    (`東京は`); path state catches pure-hiragana ASR loanwords
                //    (`すーぷは` → `スープ` then `端`).
                // 2) Multi-kana entries that swallow particle + following stem
                //    after source Kanji (`東京へいきます` → `東京平気ます`).
                //    Do NOT apply this broader block from path state alone:
                //    that would reject legitimate words that merely begin with
                //    a particle mora (`もよう` → `模様`, `はれる` → `晴れる`).
                if is_particle(chars[start]) && contains_kanji(&entry.surface) {
                    let after_source_kanji = start > 0 && is_kanji(source_chars[start - 1]);
                    let after_converted_content =
                        preceding_converted_content_word(&state, &source_chars, start);
                    let short_particle_homophone = is_particle_reading(&entry.reading);
                    if short_particle_homophone && (after_source_kanji || after_converted_content)
                        || (!short_particle_homophone && after_source_kanji)
                    {
                        continue;
                    }
                }
                // Numeric dictionary rows such as `ついたち -> 1日` are
                // intentional kana-to-digit spellings. Reject Latin
                // transliterations (`des`, `Sun`, `アップroad`) while keeping
                // mixed-case brand spellings (`iPhone`) and numeric rows
                // available when the generic spoken-number parser has no
                // special form.
                if source_is_hiragana_surface(&source_chars[start..end])
                    && is_rejected_latin_transliteration(&entry.surface)
                {
                    continue;
                }
                // A kana-only span adjacent to a prolonged mark is normally a
                // loanword whose dictionary spelling is Katakana (`すーぷ` ->
                // `スープ`).  Suppress the hiragana identity so the Ruby-ID
                // loanword surface can win.  But interjections and fillers
                // (`えーっと`, `あのー`, `そのー`, `うーん`) are stored as
                // hiragana identity rows with a non-default CID, and their
                // natural spelling is that hiragana - converting just the
                // leading mora (`絵ーっと`) or emitting a Katakana fragment
                // (`エーッと`) is spurious.  Key the suppression on the
                // DEFAULT_CID loanword orthography so genuine loanwords keep
                // converting while morphology-bearing filler identities stay.
                if prolonged_mark_adjacent_to_span(&source_chars, &chars, start, end)
                    && !entry.surface.chars().any(|character| is_katakana(&character))
                    && entry.lcid == DEFAULT_CID
                    && entry.rcid == DEFAULT_CID
                {
                    continue;
                }
                // Keep a complete lexical row such as 俗字 ahead of a
                // one-kana suffix split (族 + 時). The public dictionary
                // legitimately contains one-kana lexical rows (き -> 木),
                // so filter only when the immediately preceding row and this
                // row are covered by a usable longer surface.
                if one_kana_suffix_shadowed_by_longer_entry(dictionary, &state, entry) {
                    continue;
                }
                // A DEFAULT_CID row that is value-dominated by a same-surface
                // specific-CID sibling inherits a cheap connection that can
                // overturn the better-ranked spelling (`腫れ` over `晴れ`).
                // Drop only that dominated DEFAULT edge; the specific sibling
                // (and DEFAULT rows that remain best for their surface) stay.
                if default_cid_dominated_by_same_surface(dictionary, entry) {
                    continue;
                }
                // A full-span hiragana identity such as `きりんさん` hides
                // `キリン` + `さん`. Drop only those honorific compounds whose
                // prefix already has a converted loanword or Kanji row.
                if honorific_compound_has_converted_prefix(dictionary, &entry.reading)
                    && entry.surface == entry.reading
                {
                    continue;
                }
                // Short ruby-id rows that would render as the hiragana source
                // (`はれ` → `ハレ` kept as `はれ`) are fake identities. Their
                // cheap CID can outrank the real Kanji row (`晴れ`). Keep the
                // row only when the Katakana/Latin surface would actually emit.
                if entry.raw_ruby_identity
                    && !should_emit_raw_ruby_surface(entry, &source_chars[start..end])
                {
                    continue;
                }
                let (mut connection, clause_mid, clause_has_word, meaning_delta) =
                    transition_score(dictionary, &state, entry, options.preceding);
                if discounts_initial_particle_phrase_connection(
                    dictionary,
                    &state,
                    entry,
                    &chars,
                    end,
                    options.preceding,
                    max_dictionary_word_chars,
                ) {
                    connection *= INITIAL_PARTICLE_PHRASE_CONNECTION_DISCOUNT;
                }
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
                            + identity_segmentation_penalty(
                                dictionary,
                                &chars[start..end],
                                entry,
                                bounded_dictionary_word_chars(options.max_dictionary_word_chars),
                            )
                            + model_metadata_penalty(dictionary, entry)
                            + grammatical_context_bonus(&state, entry)
                            + copular_continuation_penalty(&state, entry)
                            + particle_following_shorter_prefix_penalty(&state, entry, &entries)
                            + verb_stem_before_particle_phrase_penalty(
                                dictionary,
                                entry,
                                &chars,
                                end,
                                max_dictionary_word_chars,
                            )
                            + particle_following_unigram_leader_penalty(dictionary, &state, entry)
                            + comma_list_kanji_overlap_bonus(&state, entry)
                            + following_yen_amount_bonus(&chars, end, entry)
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
                        // Official punctuation rows replace the free `、`
                        // boundary edge. Keep a spoken-number chain alive
                        // across those commas (`いち、に、さん` → `1、2、3`).
                        numeric_chain: continues_numeric_chain_through_comma(
                            &state,
                            &surface,
                            &entry.reading,
                        ),
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
                                numeric_chain: false,
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
/// Raw-ruby identity rows are the dictionary's chosen loanword spelling
/// (`きりん` → `キリン`); do not demote them toward rare Kanji homographs
/// such as `麒麟`.
fn orthographic_surface_penalty(
    dictionary: &AzooKeyDictionary,
    source: &[char],
    entry: &DictionaryEntry,
) -> f32 {
    if entry.raw_ruby_identity
        || !source_is_hiragana_surface(source)
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
    if !source_is_hiragana_surface(source)
        || entry.surface != entry.reading
        // A non-default CID identifies a morphology-bearing identity row
        // (for example an inflected verb or auxiliary compound). Its value
        // already models the orthographic choice; applying the generic
        // same-POS kana penalty would erase that upstream lattice edge.
        || entry.lcid != DEFAULT_CID
        || entry.rcid != DEFAULT_CID
    {
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

/// Prefer a segmented Kanji path over a long system-dictionary identity row
/// when the dictionary has no full-span Kanji alternative. This is deliberately
/// a lattice-coverage check: it does not encode a phrase or a surface pair.
fn identity_segmentation_penalty(
    dictionary: &AzooKeyDictionary,
    reading: &[char],
    entry: &DictionaryEntry,
    max_dictionary_word_chars: usize,
) -> f32 {
    if !dictionary.has_system_dictionary() || entry.surface != entry.reading || reading.len() < 2 {
        return NO_SCORE;
    }
    let has_full_kanji_alternative = dictionary
        .lookup_exact(&entry.reading)
        .unwrap_or_default()
        .iter()
        .any(|candidate| contains_kanji(&candidate.surface));
    if has_full_kanji_alternative
        || !has_multi_kanji_segmentation(dictionary, reading, max_dictionary_word_chars)
    {
        NO_SCORE
    } else {
        IDENTITY_SEGMENTATION_PENALTY
    }
}

fn honorific_compound_has_converted_prefix(dictionary: &AzooKeyDictionary, reading: &str) -> bool {
    for suffix in HONORIFIC_READING_SUFFIXES {
        let Some(prefix) = reading.strip_suffix(suffix) else {
            continue;
        };
        if prefix.chars().count() < MIN_KATAKANA_RUBY_LOANWORD_CHARS {
            continue;
        }
        if dictionary
            .lookup_exact(prefix)
            .unwrap_or_default()
            .iter()
            .any(is_converted_content_surface)
        {
            return true;
        }
    }
    false
}

fn is_converted_content_surface(entry: &DictionaryEntry) -> bool {
    contains_kanji(&entry.surface)
        || (entry.raw_ruby_identity && is_multi_mora_katakana_loanword_surface(&entry.surface))
        || (entry.surface != entry.reading
            && entry.surface.chars().any(|character| is_katakana(&character)))
}

fn has_multi_kanji_segmentation(
    dictionary: &AzooKeyDictionary,
    reading: &[char],
    max_dictionary_word_chars: usize,
) -> bool {
    // State bits: number of covered edges (0, 1, or 2+) and Kanji edges
    // (0, 1, or 2+), both capped at two because only the existence of a
    // multi-Kanji segmentation matters here.
    let mut reachable = vec![[false; 9]; reading.len() + 1];
    reachable[0][0] = true;
    for start in 0..reading.len() {
        let entries = dictionary
            .entries_starting_at(reading, start, max_dictionary_word_chars)
            .unwrap_or_default();
        for state in 0..9 {
            if !reachable[start][state] {
                continue;
            }
            let edge_count = state / 3;
            let kanji_count = state % 3;
            for candidate in &entries {
                let candidate_len = candidate.reading.chars().count();
                let end = start + candidate_len;
                if candidate_len == 0
                    || end > reading.len()
                    || reading[start..end].iter().collect::<String>() != candidate.reading
                {
                    continue;
                }
                let next_edge_count = (edge_count + 1).min(2);
                let next_kanji_count =
                    (kanji_count + usize::from(contains_kanji(&candidate.surface))).min(2);
                reachable[end][next_edge_count * 3 + next_kanji_count] = true;
            }
        }
    }
    reachable[reading.len()][2 * 3 + 2]
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
    // DEFAULT_CID+DEFAULT_MID: demote whenever a richer CID kanji beats value.
    // DEFAULT_CID with a non-default MID (e.g. 買い手 mid=474) only demote when
    // a conjugational te-form sibling wins: conjugational lcid + joshi rcid
    // (書いて lcid=687/rcid=307). Do NOT treat jodoushi rcid as sufficient —
    // 書こう (rcid=506) otherwise demotes unrelated nouns like 河口 (mid=432)
    // and drops them from narrow comma-list beams. Do not key off conjugational
    // lcid alone — 恥じ would demote DEFAULT 端 (mid=304) and let 橋野端 beat
    // 橋の端 at wide beam.
    if entry.lcid == DEFAULT_CID && entry.rcid == DEFAULT_CID {
        let dominated = if entry.mid == DEFAULT_MID {
            best_specific_value.is_some_and(|value| entry.value < value)
        } else {
            alternatives.iter().any(|candidate| {
                candidate.lcid != DEFAULT_CID
                    && candidate.rcid != DEFAULT_CID
                    && contains_kanji(&candidate.surface)
                    && candidate.value > entry.value
                    && is_conjugational_content_cid(candidate.lcid)
                    && is_joshi_cid(candidate.rcid)
            })
        };
        if dominated {
            penalty += MODEL_DEFAULT_METADATA_PENALTY;
        }
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

/// True when a DEFAULT_CID row should leave the lattice because it is both
/// value-dominated by a same-surface specific-CID sibling and lexically
/// dominated by a different-surface kanji for the same reading.
///
/// Cheap DEFAULT_CID transitions otherwise let a low-frequency spelling such
/// as `腫れ` overturn `晴れ`. Dropping every same-surface-dominated DEFAULT
/// row is too broad: `駅` keeps a DEFAULT_CID row whose value still beats
/// every other surface (`易`/`益`/...), and removing it regresses `えきへの`.
/// Requiring a better-valued *different* surface limits the filter to the
/// overturned-homophone case.
fn default_cid_dominated_by_same_surface(
    dictionary: &AzooKeyDictionary,
    entry: &DictionaryEntry,
) -> bool {
    if !dictionary.has_system_dictionary()
        || entry.lcid != DEFAULT_CID
        || entry.rcid != DEFAULT_CID
        || !contains_kanji(&entry.surface)
    {
        return false;
    }
    let alternatives = dictionary.lookup_exact(&entry.reading).unwrap_or_default();
    let dominated_by_same_surface = alternatives.iter().any(|candidate| {
        candidate.surface == entry.surface
            && candidate.lcid != DEFAULT_CID
            && candidate.rcid != DEFAULT_CID
            && contains_kanji(&candidate.surface)
            && candidate.value > entry.value
    });
    if !dominated_by_same_surface {
        return false;
    }
    alternatives.iter().any(|candidate| {
        candidate.surface != entry.surface
            && contains_kanji(&candidate.surface)
            && candidate.value > entry.value
    })
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

/// A public dictionary often contains a high-scoring Kanji homograph for the
/// `した` reading (`下`, `舌`). After an identity `で` particle, that edge is
/// more commonly the copular continuation `でした`; keep the homograph in
/// n-best while applying a bounded grammar prior to the lexical path.
fn copular_continuation_penalty(state: &PathState, entry: &DictionaryEntry) -> f32 {
    let Some(former) = state.last.as_ref() else {
        return NO_SCORE;
    };
    if former.surface == former.reading
        && former.reading == "で"
        && entry.reading == "した"
        && contains_kanji(&entry.surface)
    {
        COPULAR_CONTINUATION_PENALTY
    } else {
        NO_SCORE
    }
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

/// Copular / predicative continuations used only as a fallback when a row
/// lacks real postposition CIDs (TSV fixtures / DEFAULT_CID). Prefer
/// [`is_grammatical_continuation_entry`] for lattice pruning. Bare `な` and a
/// blanket `なの` prefix stay absent so `ひな` → `雛`.
fn is_copular_continuation_reading(reading: &str) -> bool {
    matches!(
        reading,
        "だ" | "です"
            | "でした"
            | "でしょう"
            | "である"
            | "なので"
            | "なのに"
            | "なら"
            | "なのだ"
            | "なのです"
            | "だが"
            | "ですが"
            | "だけど"
    )
}

/// Closed-class continuation after a short content prefix.
///
/// Prefer narrow joshi (`147..=368`) / jodoushi (`369..=554`) CIDs over the
/// residual `word_type == Postposition` class. CID membership alone is not
/// enough: official-dict conjugational residue such as identity `じ` (CID
/// 507) or `のう` (CIDs 479 / 283) sits in those bands but must not invent
/// particle boundaries under `はじ` / `きのう`. Require an existing particle
/// or copular reading as well, and keep bare `な` out so `ひな` → `雛`.
/// Reading-list fallback applies only to metadata-less / both-`DEFAULT_CID`
/// fixtures — official rows with real CIDs outside joshi/jodoushi must not
/// retain short prefixes via the allowlist alone. Do not grow those lists.
fn is_grammatical_continuation_entry(entry: &DictionaryEntry) -> bool {
    if entry.surface != entry.reading {
        return false;
    }
    // Narrow joshi∪jodoushi only — not residual Postposition. In-band
    // conjugational residue (じ/のう) still needs a known continuation reading.
    if is_postposition_cid(entry.lcid) || is_postposition_cid(entry.rcid) {
        return entry.reading != "な"
            && (is_particle_reading(&entry.reading)
                || is_copular_continuation_reading(&entry.reading));
    }
    // TSV fixtures / DEFAULT_CID only — not real non-joshi/jodoushi identity rows.
    entry.lcid == DEFAULT_CID
        && entry.rcid == DEFAULT_CID
        && (is_particle_reading(&entry.reading) || is_copular_continuation_reading(&entry.reading))
}

fn is_grammatical_particle_entry(entry: &DictionaryEntry) -> bool {
    entry.surface == entry.reading && is_particle_reading(&entry.reading)
}

/// True when the lattice path has a converted content word immediately before
/// `start` (pure-hiragana ASR loanwords such as `すーぷ` → `スープ`).
///
/// Punctuation boundaries and prior particles are not content anchors: a
/// following word may legitimately start with a particle mora
/// (`、もよう`, `は` + `はれる`).
fn preceding_converted_content_word(
    state: &PathState,
    source_chars: &[char],
    start: usize,
) -> bool {
    if start == 0 || is_boundary(source_chars[start - 1]) {
        return false;
    }
    let Some(former) = state.last.as_ref() else {
        return false;
    };
    // A prior particle, or a compound surface that already ends in a particle
    // (`明日は`), means this position starts a new word rather than a
    // particle-homophone attachment to content.
    if is_particle_reading(&former.reading)
        || former.reading.chars().last().is_some_and(is_particle)
        || former.surface.chars().last().is_some_and(is_particle)
    {
        return false;
    }
    if former.raw_ruby_identity {
        return true;
    }
    former
        .surface
        .chars()
        .any(|character| is_kanji(character) || is_katakana(&character) || character == 'ー')
}

/// True when `entry` is a multi-kana converted content word.
///
/// Used to keep the first mora of verbs such as `のみたい` from being stolen
/// by a following short particle after `は`/`を`/`が`.
fn is_longer_lexical_content_entry(entry: &DictionaryEntry) -> bool {
    let len = entry.reading.chars().count();
    len >= MIN_LEXICAL_ENTRY_CHARS
        && !is_particle_reading(&entry.reading)
        && (contains_kanji(&entry.surface)
            || entry.surface.chars().any(|character| is_katakana(&character))
            || entry.raw_ruby_identity)
}

/// Soft prior: after a particle, a dictionary prefix of a longer converted
/// content word is usually the wrong segmentation
/// (`のみ`/`の味` before `飲みたい`). Do not apply outside particle context so
/// ordinary noun boundaries such as `東京`/`東京都` stay score-driven.
fn particle_following_shorter_prefix_penalty(
    state: &PathState,
    entry: &DictionaryEntry,
    entries: &[DictionaryEntry],
) -> f32 {
    if !state.last.as_ref().is_some_and(|former| is_particle_reading(&former.reading)) {
        return NO_SCORE;
    }
    let len = entry.reading.chars().count();
    if len == 0 {
        return NO_SCORE;
    }
    let has_strictly_longer_content = entries.iter().any(|other| {
        let other_len = other.reading.chars().count();
        other_len > len
            && other.reading.starts_with(&entry.reading)
            && is_longer_lexical_content_entry(other)
    });
    if has_strictly_longer_content {
        PARTICLE_FOLLOWING_SHORTER_PREFIX_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a short conjugational Kanji head when a particle / joshi and
/// further lexical content remain on the suffix (`走` before `の`+`端`).
/// Bare verb-homophone readings without that continuation stay untouched.
fn verb_stem_before_particle_phrase_penalty(
    dictionary: &AzooKeyDictionary,
    entry: &DictionaryEntry,
    chars: &[char],
    end: usize,
    max_dictionary_word_chars: usize,
) -> f32 {
    let len = entry.reading.chars().count();
    if len == 0
        || len > 2
        || entry.surface == entry.reading
        || !contains_kanji(&entry.surface)
        || is_particle_reading(&entry.reading)
        || !is_conjugational_content_cid(entry.lcid)
        || !is_conjugational_content_cid(entry.rcid)
    {
        return NO_SCORE;
    }
    let has_particle_phrase =
        particle_continuations_starting_at(dictionary, chars, end, max_dictionary_word_chars)
            .iter()
            .any(|particle| {
                let after_particle = end + particle.chars().count();
                following_particle_phrase_is_content(
                    dictionary,
                    chars.get(after_particle..).unwrap_or_default(),
                    max_dictionary_word_chars,
                )
            });
    if has_particle_phrase {
        VERB_STEM_BEFORE_PARTICLE_PHRASE_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote the unique unigram-leading Kanji homophone after a particle so
/// connection evidence can surface (`恥` vs `端` after `の`). Rows stay in
/// n-best; bare readings without a preceding particle are unchanged.
fn particle_following_unigram_leader_penalty(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
) -> f32 {
    if !state.last.as_ref().is_some_and(|former| {
        former.surface == former.reading && is_particle_reading(&former.reading)
    }) || !contains_kanji(&entry.surface)
        || entry.surface == entry.reading
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    let alternatives = dictionary.lookup_exact(&entry.reading).unwrap_or_default();
    let kanji_alternatives = alternatives
        .iter()
        .filter(|candidate| {
            contains_kanji(&candidate.surface) && candidate.surface != candidate.reading
        })
        .collect::<Vec<_>>();
    if kanji_alternatives.len() < 2 {
        return NO_SCORE;
    }
    let Some(best_value) =
        kanji_alternatives.iter().map(|candidate| candidate.value).max_by(f32::total_cmp)
    else {
        return NO_SCORE;
    };
    let leaders = kanji_alternatives
        .iter()
        .filter(|candidate| candidate.value == best_value)
        .collect::<Vec<_>>();
    if leaders.len() == 1 && leaders[0].surface == entry.surface && leaders[0].mid == entry.mid {
        PARTICLE_FOLLOWING_UNIGRAM_LEADER_PENALTY
    } else {
        NO_SCORE
    }
}

fn is_conjugational_content_cid(cid: u16) -> bool {
    (561..=867).contains(&cid)
}

fn comma_list_kanji_overlap_bonus(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if !state.text.contains('、') && !state.text.contains(',') {
        return NO_SCORE;
    }
    if !entry.surface.chars().any(is_kanji) {
        return NO_SCORE;
    }
    let previous = state.text.trim_end_matches(['、', ',']);
    let previous_clause =
        previous.rsplit_once(['、', ',']).map(|(_, right)| right).unwrap_or(previous);
    // Anchor on the final Kanji of the previous clause so `一等賞` boosts
    // `懸賞`, without letting an earlier character in `河口` promote `河辺`
    // over the natural `川辺`.
    let Some(anchor) = previous_clause.chars().rev().find(|character| is_kanji(*character)) else {
        return NO_SCORE;
    };
    if entry.surface.contains(anchor) {
        COMMA_LIST_KANJI_OVERLAP_BONUS
    } else {
        NO_SCORE
    }
}

fn following_yen_amount_bonus(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    // Currency orthography often carries 貨/金/幣. Prefer it when the next
    // comma-separated clause is a short spoken yen amount (`じゅうえん`).
    if !entry.surface.chars().any(|character| matches!(character, '貨' | '金' | '幣')) {
        return NO_SCORE;
    }
    let rest = chars.get(end..).unwrap_or_default();
    let mut clause = rest;
    if let Some(first) = clause.first() {
        if matches!(*first, '、' | ',') {
            clause = &clause[1..];
        } else {
            return NO_SCORE;
        }
    } else {
        return NO_SCORE;
    }
    if clause.is_empty() || clause.len() > 8 {
        return NO_SCORE;
    }
    if clause.ends_with(&['え', 'ん'])
        && clause.iter().all(|character| is_hiragana(*character) || *character == 'ー')
    {
        FOLLOWING_YEN_AMOUNT_BONUS
    } else {
        NO_SCORE
    }
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
                && is_lexical_surface_for_unknown(entry)
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

fn unresolved_single_tail_candidate(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    source: &[char],
    entries: &[DictionaryEntry],
    max_dictionary_word_chars: usize,
) -> bool {
    if chars.len() < MIN_UNKNOWN_FALLBACK_CHARS
        || chars.len() != source.len()
        || is_particle(*chars.last().unwrap_or(&' '))
    {
        return false;
    }
    let tail_start = chars.len() - 1;
    let has_complete_lexical_entry = entries.iter().any(|entry| {
        entry.reading.chars().count() == chars.len() && is_lexical_surface_for_unknown(entry)
    });
    if has_complete_lexical_entry {
        return false;
    }
    let has_lexical_prefix = entries.iter().any(|entry| {
        entry.reading.chars().count() == tail_start && is_lexical_surface_for_unknown(entry)
    });
    if !has_lexical_prefix {
        return false;
    }
    let tail = dictionary
        .entries_starting_at(chars, tail_start, max_dictionary_word_chars)
        .unwrap_or_default();
    // A single-kana system row is too ambiguous to establish that an
    // unresolved tail is a real lexical continuation. Public dictionaries
    // contain many one-kana homophones (for example `ご`), and allowing any
    // of them here turns an incomplete ASR suffix into arbitrary Kanji. Require
    // a multi-kana lexical row before suppressing the raw utterance candidate.
    let has_multi_kana_tail = tail.iter().any(|entry| {
        entry.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
            && is_lexical_surface_for_unknown(entry)
    });
    if has_multi_kana_tail {
        return false;
    }
    // Do not hide a grammatical inflection behind the raw fallback merely
    // because its final kana is only one character. A lexical prefix such as
    // `木を切っ` is expected to continue with the postposition `て`; the
    // public CID table marks that transition as staying inside the clause.
    // Conversely, an unresolved preposition such as `ご` after `有難う`
    // starts a new clause and remains eligible for the readable raw candidate.
    let has_grammatical_tail = entries
        .iter()
        .filter(|prefix| {
            prefix.reading.chars().count() == tail_start && is_lexical_surface_for_unknown(prefix)
        })
        .any(|prefix| {
            tail.iter().any(|tail_entry| {
                tail_entry.surface == tail_entry.reading
                    && !dictionary.is_clause_boundary(prefix.rcid, tail_entry.lcid)
            })
        });
    !has_grammatical_tail
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

/// Soft-demote a raw/unknown hiragana span when the same reading already has a
/// multi-Kanji segmentation (`あついひ` → `暑い`+`日`). The span stays in n-best.
fn unknown_span_multi_kanji_segmentation_penalty(
    dictionary: &AzooKeyDictionary,
    reading: &[char],
    max_dictionary_word_chars: usize,
) -> f32 {
    if reading.len() < MIN_LEXICAL_ENTRY_CHARS
        || !has_multi_kanji_segmentation(dictionary, reading, max_dictionary_word_chars)
    {
        NO_SCORE
    } else {
        IDENTITY_SEGMENTATION_PENALTY
    }
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
    // A missing loudstxt3 surface is represented by the serialized ruby.  It
    // can therefore look like a Katakana lexical row (`デス`) even though it
    // is semantically an identity edge for the normalized reading (`です`).
    // Preserve the user's source script for short grammatical ruby; emit the
    // Katakana surface for multi-mora loanwords (`ぱそこん` → `パソコン`) and
    // for readings that already carry `ー` (`すーぷ` → `スープ`).
    if entry.raw_ruby_identity {
        return if should_emit_raw_ruby_surface(entry, source) {
            entry.surface.clone()
        } else {
            source_surface
        };
    }
    if source_is_katakana_surface(source)
        && (entry.surface == entry.reading
            || (entry.surface != source_surface
                && (contains_kanji(&entry.surface) || contains_ascii_alphanumeric(&entry.surface))))
    {
        return source_surface;
    }
    entry.surface.clone()
}

fn continues_numeric_chain_through_comma(state: &PathState, surface: &str, reading: &str) -> bool {
    state.numeric_chain && is_clause_internal_comma(surface, reading)
}

fn is_clause_internal_comma(surface: &str, reading: &str) -> bool {
    let mut surface_chars = surface.chars();
    let mut reading_chars = reading.chars();
    matches!(
        (surface_chars.next(), surface_chars.next(), reading_chars.next(), reading_chars.next()),
        (Some('、') | Some(','), None, Some('、') | Some(','), None)
    )
}

fn should_emit_raw_ruby_surface(entry: &DictionaryEntry, source: &[char]) -> bool {
    if source_is_katakana_surface(source) || source.contains(&'ー') {
        return true;
    }
    source_is_hiragana_surface(source) && is_multi_mora_katakana_loanword_surface(&entry.surface)
}

fn is_multi_mora_katakana_loanword_surface(surface: &str) -> bool {
    let count = surface.chars().count();
    count >= MIN_KATAKANA_RUBY_LOANWORD_CHARS
        && surface.chars().all(|character| is_katakana(&character) || character == 'ー')
}

fn is_rejected_latin_transliteration(surface: &str) -> bool {
    if !surface.chars().any(|character| character.is_ascii_alphabetic()) {
        return false;
    }
    if surface
        .chars()
        .any(|character| is_hiragana(character) || is_katakana(&character) || is_kanji(character))
    {
        return true;
    }
    !is_latin_brand_surface(surface)
}

fn is_latin_brand_surface(surface: &str) -> bool {
    let alphabetic = surface.chars().filter(|character| character.is_ascii_alphabetic());
    let mut count = 0usize;
    let mut has_upper = false;
    let mut has_lower = false;
    for character in alphabetic {
        count += 1;
        has_upper |= character.is_ascii_uppercase();
        has_lower |= character.is_ascii_lowercase();
    }
    count >= 4 && has_upper && has_lower
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
        .filter(|candidate| {
            candidate.lcid == entry.lcid
                && candidate.rcid == entry.rcid
                // Raw-ruby identity rows are kept for faithful full
                // conversion, but they must not manufacture a second
                // lexical alternative for this Rust-only contextual prior.
                // Otherwise adding `アツイ` makes the generic `熱い` row gain
                // a +4.5 bonus and can reverse a homonym choice.
                && !is_normalized_identity_surface(candidate)
        })
        .collect::<Vec<_>>();
    alternatives.sort_by(|left, right| right.value.total_cmp(&left.value));
    if alternatives.len() < MIN_LEXICAL_ENTRY_CHARS {
        return NO_SCORE;
    }
    // Do not reward a short homophone row that is only a *prefix* of a longer
    // converted reading at the same lattice position.  For example `觀` (1 mora)
    // is a prefix of the full-span `観ている`; steering the tie-breaker at the
    // prefix column would let the rarer `観` beat the natural `見` (which also
    // has a full-span `見ている`) purely from a following accusative auxiliary.
    // A full-span adjective such as `あつい`/`熱い` has no longer same-span
    // reading, so the semantic tie-breaker still applies there.
    if entry.reading.chars().count() == 1
        && dictionary
            .entries_starting_at(chars, start, max_dictionary_word_chars)
            .unwrap_or_default()
            .iter()
            .any(|candidate| {
                candidate.reading.chars().count() > 1
                    && candidate.reading.starts_with(&entry.reading)
                    && contains_kanji(&candidate.surface)
            })
    {
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

fn is_normalized_identity_surface(entry: &DictionaryEntry) -> bool {
    to_hiragana(&entry.surface) == entry.reading
}

fn is_lexical_surface_for_unknown(entry: &DictionaryEntry) -> bool {
    !is_normalized_identity_surface(entry)
        && (contains_kanji(&entry.surface)
            || entry.surface.chars().any(|character| is_katakana(&character)))
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
    // Do not let a dictionary compound that starts with a particle make
    // the following clause look content-bearing. The particle belongs to
    // the next edge, not to the homonym's lexical context.
    if matches!(*first, 'を' | 'は') {
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
        raw_ruby_identity: false,
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

fn one_kana_suffix_shadowed_by_longer_entry(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
) -> bool {
    if entry.reading.chars().count() != 1
        || entry.surface == entry.reading
        || !dictionary.has_system_dictionary()
    {
        return false;
    }
    let Some(former) = state.last.as_ref() else {
        return false;
    };
    let combined_reading = format!("{}{}", former.reading, entry.reading);
    dictionary.lookup_exact(&combined_reading).unwrap_or_default().iter().any(|candidate| {
        candidate.surface != candidate.reading
            && contains_kanji(&candidate.surface)
            && candidate.reading.chars().count() > entry.reading.chars().count()
    })
}

/// Drop short Kanji dictionary pieces that are strict prefixes of a longer
/// converted word at the same lattice start.
///
/// Without this, `きかく` keeps hundreds of `き`/`機` rows beside `規格`, and
/// Viterbi invents non-dictionary surfaces such as `機各` / `券小`. Identity
/// and particle rows stay so grammar edges remain available. When a longer
/// reading still exists, remaining one-kana Kanji rows are value-capped so a
/// mid-clause `き` (500+ surfaces) cannot explode captions such as
/// `あしたのてんきははれ`.
fn prune_short_kanji_prefix_entries(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    mut entries: Vec<DictionaryEntry>,
    remaining_chars: usize,
    max_dictionary_word_chars: usize,
) -> Vec<DictionaryEntry> {
    if entries.is_empty() {
        return entries;
    }
    let has_shadowing_lexical = entries.iter().any(is_shadowing_lexical_entry);
    if has_shadowing_lexical {
        let snapshot = entries.clone();
        entries.retain(|entry| {
            !short_kanji_prefix_shadowed_by_longer_entry(
                dictionary,
                chars,
                start,
                entry,
                &snapshot,
                remaining_chars,
                max_dictionary_word_chars,
            )
        });
        entries.retain(|entry| {
            !longer_lexical_row_eats_into_following_particle(
                dictionary,
                chars,
                start,
                entry,
                &snapshot,
                max_dictionary_word_chars,
            )
        });
        entries.retain(|entry| {
            !longer_lexical_row_glues_leading_particle_to_one_mora(
                dictionary,
                chars,
                start,
                entry,
                &snapshot,
                max_dictionary_word_chars,
            )
        });
    }
    cap_one_kana_kanji_entries_when_longer_readings_exist(&mut entries);
    entries
}

fn is_shadowing_lexical_entry(entry: &DictionaryEntry) -> bool {
    let len = entry.reading.chars().count();
    len >= MIN_SHADOWING_TRIGGER_CHARS
        && entry.surface != entry.reading
        && contains_kanji(&entry.surface)
        && !is_particle_reading(&entry.reading)
}

/// True when the lattice already has the official one-character punctuation
/// dictionary row for this source mark. Prefer that row over a free boundary
/// edge so CID/MID transitions stay intact across commas.
fn has_exact_punctuation_dictionary_entry(
    entries: &[DictionaryEntry],
    source_char: char,
    normalized_char: char,
) -> bool {
    entries.iter().any(|entry| {
        let reading = entry.reading.chars().collect::<Vec<_>>();
        let surface = entry.surface.chars().collect::<Vec<_>>();
        reading.len() == 1
            && surface.len() == 1
            && reading[0] == normalized_char
            && (surface[0] == source_char || surface[0] == normalized_char)
    })
}

fn short_kanji_prefix_shadowed_by_longer_entry(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    entry: &DictionaryEntry,
    entries: &[DictionaryEntry],
    remaining_chars: usize,
    max_dictionary_word_chars: usize,
) -> bool {
    let len = entry.reading.chars().count();
    if len == 0 || len > 2 {
        return false;
    }
    if is_grammatical_particle_entry(entry) {
        return false;
    }
    // Suppress both Kanji fragments (`機`) and short kana identities (`き`)
    // when a longer converted word covers the same start. Leaving the identity
    // would still invent non-dictionary compounds such as `き各`.
    let short_piece = contains_kanji(&entry.surface) || entry.surface == entry.reading;
    if !short_piece {
        return false;
    }
    let grammatical_continuations = grammatical_lattice_continuations_starting_at(
        dictionary,
        chars,
        start + len,
        max_dictionary_word_chars,
    );
    let min_other_len =
        if len == 1 { MIN_SHADOWING_TRIGGER_CHARS } else { MIN_SHADOWING_LEXICAL_CHARS };
    entries.iter().any(|other| {
        let other_len = other.reading.chars().count();
        // A longer row that leaves a single dangling mora (`晴れ間` + `す`
        // under `はれます`) should not hide the shorter complete word
        // (`晴れ` + `ます`).
        let leftover = remaining_chars.saturating_sub(other_len);
        let reading_leftover = other.reading.chars().skip(len).collect::<String>();
        other_len >= min_other_len
            && other_len > len
            && other_len <= remaining_chars
            && leftover != 1
            && other.reading.starts_with(&entry.reading)
            && other.surface != other.reading
            && contains_kanji(&other.surface)
            && !is_particle_reading(&other.reading)
            && !longer_reading_crosses_a_particle_boundary(
                &reading_leftover,
                &grammatical_continuations,
            )
    })
}

/// Keep a short prefix when a longer lexical row crosses a function-word edge.
///
/// Prefix pruning is useful for preventing invented compounds, but a longer
/// row can also glue a real particle onto a shorter word (`はし` + `の`
/// versus `橋野`, or `はじ` + `から` versus `弾か`), or glue a one-mora
/// content Kanji onto a postpositional / copular continuation (`ひな` /
/// `雛` before `なので` / `なのに` / `なら`). Compare the extra mora of that
/// longer reading against closed-class continuations that start at the short
/// prefix's end (narrow joshi/jodoushi CID + known continuation reading when
/// available; reading-list fallback for DEFAULT_CID fixtures otherwise):
///
/// - leftover equals the particle (`はしの` / `の`) → keep the short word
/// - leftover is a strict prefix of the particle (`はじか` / `から`) → keep
/// - leftover is a strict prefix of a copula (`ひな` / `なので`) → keep
/// - particle is a strict prefix of leftover (`きのう` / `の`) → still prune
fn discounts_initial_particle_phrase_connection(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
    chars: &[char],
    end: usize,
    preceding: Option<PrecedingContext>,
    max_dictionary_word_chars: usize,
) -> bool {
    if state.last.is_some()
        || preceding.is_some()
        || entry.reading.chars().count() > 2
        || entry.surface == entry.reading
        || !contains_kanji(&entry.surface)
        || is_particle_reading(&entry.reading)
    {
        return false;
    }
    particle_continuations_starting_at(dictionary, chars, end, max_dictionary_word_chars)
        .iter()
        .any(|particle| {
            let after_particle = end + particle.chars().count();
            following_particle_phrase_is_content(
                dictionary,
                chars.get(after_particle..).unwrap_or_default(),
                max_dictionary_word_chars,
            )
        })
}

fn following_particle_phrase_is_content(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    max_dictionary_word_chars: usize,
) -> bool {
    dictionary
        .entries_starting_at(chars, 0, max_dictionary_word_chars)
        .unwrap_or_default()
        .iter()
        .any(|candidate| {
            candidate.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
                && contains_kanji(&candidate.surface)
                && !is_particle_reading(&candidate.reading)
        })
}

fn particle_continuations_starting_at(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
) -> Vec<String> {
    grammatical_continuations_starting_at(
        dictionary,
        chars,
        start,
        max_dictionary_word_chars,
        |continuation| is_particle_reading(&continuation.reading),
    )
}

fn grammatical_lattice_continuations_starting_at(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
) -> Vec<String> {
    grammatical_continuations_starting_at(
        dictionary,
        chars,
        start,
        max_dictionary_word_chars,
        is_grammatical_continuation_entry,
    )
}

fn grammatical_continuations_starting_at(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
    keep: impl Fn(&DictionaryEntry) -> bool,
) -> Vec<String> {
    if start >= chars.len() {
        return Vec::new();
    }
    dictionary
        .entries_starting_at(chars, start, max_dictionary_word_chars)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|continuation| {
            let continuation_len = continuation.reading.chars().count();
            if continuation_len > 0
                && start + continuation_len <= chars.len()
                && keep(&continuation)
            {
                Some(continuation.reading)
            } else {
                None
            }
        })
        .collect()
}

fn longer_reading_crosses_a_particle_boundary(
    reading_leftover: &str,
    particles: &[String],
) -> bool {
    !reading_leftover.is_empty()
        && particles
            .iter()
            .any(|particle| reading_leftover == particle || particle.starts_with(reading_leftover))
}

fn longer_reading_eats_into_particle(reading_leftover: &str, particles: &[String]) -> bool {
    !reading_leftover.is_empty()
        && particles
            .iter()
            .any(|particle| reading_leftover != particle && particle.starts_with(reading_leftover))
}

fn longer_reading_glues_one_mora_kanji_to_particle(
    short_len: usize,
    short_is_kanji: bool,
    reading_leftover: &str,
    particles: &[String],
    surface: &str,
) -> bool {
    short_len == 1
        && short_is_kanji
        && !reading_leftover.is_empty()
        && particles
            .iter()
            .any(|particle| reading_leftover == particle && surface.ends_with(particle))
}

/// Drop a longer converted row whose extra mora is only part of the following
/// particle (`はじか` under `はじから`), or that glues a one-mora Kanji onto
/// that particle (`じから` / `時から`). A complete short+particle compound
/// such as `はしの` / `橋野` is left for Viterbi to score.
fn longer_lexical_row_eats_into_following_particle(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    entry: &DictionaryEntry,
    snapshot: &[DictionaryEntry],
    max_dictionary_word_chars: usize,
) -> bool {
    if !is_shadowing_lexical_entry(entry) {
        return false;
    }
    snapshot.iter().any(|short| {
        let short_len = short.reading.chars().count();
        if short_len == 0 || short_len > 2 || short_len >= entry.reading.chars().count() {
            return false;
        }
        if is_grammatical_particle_entry(short) {
            return false;
        }
        let short_is_kanji = contains_kanji(&short.surface);
        let short_piece = short_is_kanji || short.surface == short.reading;
        if !short_piece || !entry.reading.starts_with(&short.reading) {
            return false;
        }
        let leftover = entry.reading.chars().skip(short_len).collect::<String>();
        let particles = particle_continuations_starting_at(
            dictionary,
            chars,
            start + short_len,
            max_dictionary_word_chars,
        );
        longer_reading_eats_into_particle(&leftover, &particles)
            || longer_reading_glues_one_mora_kanji_to_particle(
                short_len,
                short_is_kanji,
                &leftover,
                &particles,
                &entry.surface,
            )
    })
}

/// Drop a converted row that starts with a real particle and then glues a
/// single Kanji mora (`のは` / `の端`). Two-mora leftovers such as `のはら`
/// / `野原` stay in the lattice.
fn longer_lexical_row_glues_leading_particle_to_one_mora(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    entry: &DictionaryEntry,
    snapshot: &[DictionaryEntry],
    max_dictionary_word_chars: usize,
) -> bool {
    if entry.surface == entry.reading || !contains_kanji(&entry.surface) {
        return false;
    }
    let reading_len = entry.reading.chars().count();
    if reading_len < 2 {
        return false;
    }
    snapshot.iter().any(|particle| {
        if !is_grammatical_particle_entry(particle) {
            return false;
        }
        let particle_len = particle.reading.chars().count();
        if particle_len == 0 || particle_len >= reading_len {
            return false;
        }
        if !entry.reading.starts_with(&particle.reading) {
            return false;
        }
        let leftover: String = entry.reading.chars().skip(particle_len).collect();
        if leftover.chars().count() != 1 || !entry.surface.starts_with(&particle.reading) {
            return false;
        }
        let after_particle = start + particle_len;
        let has_one_mora_kanji = dictionary
            .entries_starting_at(chars, after_particle, max_dictionary_word_chars)
            .unwrap_or_default()
            .iter()
            .any(|content| content.reading == leftover && contains_kanji(&content.surface));
        has_one_mora_kanji
            && particle_continuations_starting_at(
                dictionary,
                chars,
                start,
                max_dictionary_word_chars,
            )
            .iter()
            .any(|continuation| continuation == &particle.reading)
    })
}

fn cap_one_kana_kanji_entries_when_longer_readings_exist(entries: &mut Vec<DictionaryEntry>) {
    let max_reading_len =
        entries.iter().map(|entry| entry.reading.chars().count()).max().unwrap_or(0);
    // Keep the full one-kana set for standalone conversions such as `き` → `木`.
    if max_reading_len <= 1 {
        return;
    }
    let mut one_kana_kanji = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            entry.reading.chars().count() == 1
                && entry.surface != entry.reading
                && contains_kanji(&entry.surface)
        })
        .map(|(index, entry)| (index, entry.value))
        .collect::<Vec<_>>();
    if one_kana_kanji.len() <= MAX_ONE_KANA_KANJI_ENTRIES {
        return;
    }
    one_kana_kanji.sort_by(|left, right| right.1.total_cmp(&left.1));
    let mut keep = vec![false; entries.len()];
    for (index, _) in &one_kana_kanji[..MAX_ONE_KANA_KANJI_ENTRIES] {
        keep[*index] = true;
    }
    let mut index = 0;
    entries.retain(|entry| {
        let retain = entry.reading.chars().count() != 1
            || entry.surface == entry.reading
            || !contains_kanji(&entry.surface)
            || keep[index];
        index += 1;
        retain
    });
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
        if unique
            .iter()
            .any(|kept: &PathState| kept.text == state.text && same_path_context(kept, &state))
        {
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
        // Keep numeric-chain alternatives distinct. Collapsing this bit can
        // reintroduce bare-digit absorption; if the extra variants dilute a
        // future beam, tune width before removing this context.
        || left.numeric_chain != right.numeric_chain
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
    fn converts_known_readings_through_the_convenience_api() {
        // `convert_kana_to_kanji` honors `AZOOKEY_DICTIONARY_ROOT` and resolves
        // the real LOUDS dictionary when the gate provides a resolvable path;
        // with no dictionary configured it falls back to the built-in lexicon.
        // This assertion holds in both modes, verifying the convenience API
        // end-to-end rather than only the built-in fallback.
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
        // This test asserts the compact built-in lexicon, so it must not pick
        // up a system dictionary configured via `AZOOKEY_DICTIONARY_ROOT`.
        // `convert_kana_to_kanji` honors that environment variable, which makes
        // a bare homophone such as `ねん` resolve against the official LOUDS
        // dictionary (`念`) instead of the compact lexicon (`年`). Using the
        // default dictionary explicitly keeps the assertion deterministic.
        let dictionary = AzooKeyDictionary::default();
        let convert = |input: &str| {
            convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next()
                .map(|candidate| candidate.text)
                .unwrap_or_else(|| input.trim().to_string())
        };
        assert_eq!(convert("かんじのしょりをかいぜん"), "漢字の処理を改善");
        assert_eq!(convert("おつかれさまです"), "お疲れ様です");
        assert_eq!(convert("おつかれさまでした"), "お疲れ様でした");
        assert_eq!(convert("いきます"), "行きます");
        assert_eq!(convert("ねん"), "年");
        assert_eq!(convert("おんりょうをちょうせい"), "音量を調整");
    }

    #[test]
    fn keeps_public_dictionary_context_for_ambiguous_caption_words() {
        let root = crate::dictionary::test_system_dictionary_path();
        let converted = super::convert_kana_to_kanji_with_paths(
            "かんじのしょりをかいぜん",
            DictionaryPaths { system: Some(root), ..DictionaryPaths::default() },
        )
        .expect("configured public dictionary should convert");
        assert_eq!(converted, "漢字の処理を改善");
    }

    #[test]
    fn carries_meaning_context_across_clause_punctuation() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        let candidate = convert_with_dictionary(
            "しょうぼう、しょうか、ほのお",
            &dictionary,
            ConversionOptions { n_best: 10, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("public conversion should produce a candidate");
        assert_eq!(candidate.text, "消防、消火、炎");
    }

    #[test]
    fn prefers_dictionary_punctuation_rows_over_a_free_boundary_edge() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public conversion dictionary should load");
        let punctuation_entries = dictionary
            .entries_starting_at(&['、'], 0, 4)
            .expect("punctuation lookup should complete");
        assert!(
            super::has_exact_punctuation_dictionary_entry(&punctuation_entries, '、', '、'),
            "public dictionary should expose a one-character 、 row"
        );
        // With the free score+=0 boundary suppressed, comma-separated captions
        // keep CID/MID transitions and prefer real dictionary words.
        let candidate = convert_with_dictionary(
            "こうぎょう、きかく、とういつ",
            &dictionary,
            ConversionOptions { n_best: 5, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("public conversion should produce a candidate");
        assert_eq!(candidate.text, "工業、規格、統一");
    }

    #[test]
    fn suppresses_invented_kanji_compounds_in_comma_lists() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public conversion dictionary should load");
        for (input, expected) in [
            ("こうぎょう、きかく、とういつ", "工業、規格、統一"),
            ("いっとうしょう、けんしょう、おうぼ", "一等賞、懸賞、応募"),
            ("しへい、こうか、じゅうえん", "紙幣、硬貨、10円"),
        ] {
            let candidate = convert_with_dictionary(
                input,
                &dictionary,
                ConversionOptions { n_best: 10, ..ConversionOptions::default() },
            )
            .into_iter()
            .next()
            .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
            assert!(
                !candidate.text.contains("券小")
                    && !candidate.text.contains("機各")
                    && !candidate.text.contains("き各"),
                "invented compound leaked for {input}: {}",
                candidate.text
            );
        }
    }

    #[test]
    fn prefix_shadowing_keeps_a_short_row_only_when_a_particle_follows() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-prefix-shadow-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(
            &root,
            "はし\t橋\t-10\nはしの\t橋野\t-8\nの\tの\t-2\nのは\tの端\t-8\nは\tは\t-1\nは\t端\t-9\nはじ\t端\t-10\nはじか\t弾か\t-8\nから\tから\t-2\nじ\t時\t-9\nじから\t時から\t-8\nき\t機\t-9\nきかく\t規格\t-5\nきのう\t昨日\t-6\nはれ\t晴れ\t-8\nはれま\t晴れ間\t-6\nも\t藻\t-9\nもの\t物\t-5\n",
        )
        .expect("prefix-shadow fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("prefix-shadow fixture should load")
        .without_builtin_entries_for_test();

        let hashi = "はしの".chars().collect::<Vec<_>>();
        let hashi_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &hashi,
            0,
            dictionary.entries_starting_at(&hashi, 0, 24).expect("はしの lookup"),
            hashi.len(),
            24,
        );
        assert!(
            hashi_pruned.iter().any(|entry| entry.reading == "はし" && entry.surface == "橋"),
            "はし+の must keep 橋 against 橋野: {:?}",
            hashi_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(
            hashi_pruned.iter().any(|entry| entry.reading == "はしの" && entry.surface == "橋野"),
            "longer name row stays available in the lattice"
        );

        let haji = "はじから".chars().collect::<Vec<_>>();
        let haji_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &haji,
            0,
            dictionary.entries_starting_at(&haji, 0, 24).expect("はじから lookup"),
            haji.len(),
            24,
        );
        assert!(
            haji_pruned.iter().any(|entry| entry.reading == "はじ" && entry.surface == "端"),
            "はじ+から must keep 端 against 弾か: {:?}",
            haji_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(
            !haji_pruned.iter().any(|entry| entry.reading == "はじか"),
            "はじか must be dropped when it eats into から: {:?}",
            haji_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let kikaku = "きかく".chars().collect::<Vec<_>>();
        let kikaku_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &kikaku,
            0,
            dictionary.entries_starting_at(&kikaku, 0, 24).expect("きかく lookup"),
            kikaku.len(),
            24,
        );
        assert!(
            !kikaku_pruned.iter().any(|entry| entry.reading == "き"),
            "きかく must still prune short き/機 prefixes: {:?}",
            kikaku_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(kikaku_pruned
            .iter()
            .any(|entry| entry.reading == "きかく" && entry.surface == "規格"));

        let kinou = "きのう".chars().collect::<Vec<_>>();
        let kinou_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &kinou,
            0,
            dictionary.entries_starting_at(&kinou, 0, 24).expect("きのう lookup"),
            kinou.len(),
            24,
        );
        assert!(
            !kinou_pruned.iter().any(|entry| entry.reading == "き"),
            "きのう must still prune short き/機 prefixes: {:?}",
            kinou_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(kinou_pruned
            .iter()
            .any(|entry| entry.reading == "きのう" && entry.surface == "昨日"));

        let haji_only = "はじ".chars().collect::<Vec<_>>();
        let haji_only_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &haji_only,
            0,
            dictionary.entries_starting_at(&haji_only, 0, 24).expect("はじ lookup"),
            haji_only.len(),
            24,
        );
        assert!(
            !haji_only_pruned.iter().any(|entry| entry.reading == "は" && entry.surface == "端"),
            "kanji は/端 must be shadowed by はじ/端: {:?}",
            haji_only_pruned
                .iter()
                .map(|entry| (&entry.reading, &entry.surface))
                .collect::<Vec<_>>()
        );
        assert!(
            haji_only_pruned.iter().any(|entry| entry.reading == "は" && entry.surface == "は"),
            "identity は must remain available as a particle"
        );
        assert!(haji_only_pruned
            .iter()
            .any(|entry| entry.reading == "はじ" && entry.surface == "端"));

        let jikara = "じから".chars().collect::<Vec<_>>();
        let jikara_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &jikara,
            0,
            dictionary.entries_starting_at(&jikara, 0, 24).expect("じから lookup"),
            jikara.len(),
            24,
        );
        assert!(
            jikara_pruned.iter().any(|entry| entry.reading == "じ" && entry.surface == "時"),
            "じ/時 must survive so 時+から can be scored separately"
        );
        assert!(
            !jikara_pruned.iter().any(|entry| entry.reading == "じから"),
            "じから/時から must drop when leftover is exactly から: {:?}",
            jikara_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let noha = "のはじ".chars().collect::<Vec<_>>();
        let noha_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &noha,
            0,
            dictionary.entries_starting_at(&noha, 0, 24).expect("のは lookup"),
            noha.len(),
            24,
        );
        assert!(
            noha_pruned.iter().any(|entry| entry.reading == "の" && entry.surface == "の"),
            "grammatical の must remain"
        );
        assert!(
            !noha_pruned.iter().any(|entry| entry.reading == "のは"),
            "のは/の端 must drop as leading-particle + one-mora Kanji glue: {:?}",
            noha_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let haremasu = "はれます".chars().collect::<Vec<_>>();
        let hare_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &haremasu,
            0,
            dictionary.entries_starting_at(&haremasu, 0, 24).expect("はれます lookup"),
            haremasu.len(),
            24,
        );
        assert!(
            hare_pruned.iter().any(|entry| entry.reading == "はれ" && entry.surface == "晴れ"),
            "はれ/晴れ must survive when 晴れ間 would leave one dangling mora: {:?}",
            hare_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let mono = "もの".chars().collect::<Vec<_>>();
        let mono_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &mono,
            0,
            dictionary.entries_starting_at(&mono, 0, 24).expect("もの lookup"),
            mono.len(),
            24,
        );
        assert!(
            mono_pruned.iter().any(|entry| entry.reading == "もの" && entry.surface == "物"),
            "もの/物 must not drop just because leftover reading の is a particle: {:?}",
            mono_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn official_dict_prefix_prune_ignores_in_band_conjugational_residue() {
        // Narrow joshi/jodoushi CIDs still tag identity じ (507) and のう
        // (479/283). Those must not count as grammatical continuations, or
        // short は/端 under はじ and き/機 under きのう survive incorrectly.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("official AzooKey dictionary should load");

        let haji = "はじ".chars().collect::<Vec<_>>();
        let haji_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &haji,
            0,
            dictionary.entries_starting_at(&haji, 0, 24).expect("はじ lookup"),
            haji.len(),
            24,
        );
        assert!(
            !haji_pruned
                .iter()
                .any(|entry| entry.reading == "は" && super::contains_kanji(&entry.surface)),
            "official はじ must prune short kanji は/* prefixes despite identity じ CID: {:?}",
            haji_pruned
                .iter()
                .map(|entry| (&entry.reading, &entry.surface, entry.lcid, entry.rcid))
                .collect::<Vec<_>>()
        );
        assert!(
            haji_pruned.iter().any(|entry| entry.reading == "はじ" && entry.surface == "端"),
            "はじ/端 must remain available"
        );

        let kinou = "きのう".chars().collect::<Vec<_>>();
        let kinou_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &kinou,
            0,
            dictionary.entries_starting_at(&kinou, 0, 24).expect("きのう lookup"),
            kinou.len(),
            24,
        );
        assert!(
            !kinou_pruned
                .iter()
                .any(|entry| { entry.reading == "き" && super::contains_kanji(&entry.surface) }),
            "official きのう must prune short kanji き/* despite identity のう CID: {:?}",
            kinou_pruned
                .iter()
                .map(|entry| (&entry.reading, &entry.surface, entry.lcid, entry.rcid))
                .collect::<Vec<_>>()
        );
        assert!(
            !kinou_pruned.iter().any(|entry| entry.surface == "機"),
            "機 must not remain as a きのう prefix: {:?}",
            kinou_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(
            kinou_pruned.iter().any(|entry| entry.reading == "きのう" && entry.surface == "昨日"),
            "きのう/昨日 must remain available"
        );

        let haremasu = "はれます".chars().collect::<Vec<_>>();
        let hare_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &haremasu,
            0,
            dictionary.entries_starting_at(&haremasu, 0, 24).expect("はれます lookup"),
            haremasu.len(),
            24,
        );
        assert!(
            hare_pruned.iter().any(|entry| entry.reading == "はれ" && entry.surface == "晴れ"),
            "official はれます must keep 晴れ against 晴れ間: {:?}",
            hare_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let kikaku = "きかく".chars().collect::<Vec<_>>();
        let kikaku_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &kikaku,
            0,
            dictionary.entries_starting_at(&kikaku, 0, 24).expect("きかく lookup"),
            kikaku.len(),
            24,
        );
        assert!(
            !kikaku_pruned
                .iter()
                .any(|entry| { entry.reading == "き" && super::contains_kanji(&entry.surface) }),
            "official きかく must still prune kanji き/* (機各 guard): {:?}",
            kikaku_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
        assert!(
            !kikaku_pruned.iter().any(|entry| entry.surface == "機"),
            "機 must not remain under きかく: {:?}",
            kikaku_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        // Copular goldens still keep 日 before なのに via real joshi/jodoushi rows.
        let hinanoni = "ひなのに".chars().collect::<Vec<_>>();
        let hina_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &hinanoni,
            0,
            dictionary.entries_starting_at(&hinanoni, 0, 24).expect("ひなのに lookup"),
            hinanoni.len(),
            24,
        );
        assert!(
            hina_pruned.iter().any(|entry| entry.reading == "ひ" && entry.surface == "日"),
            "official ひなのに must keep 日 before なのに: {:?}",
            hina_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn keeps_particle_chain_when_unrelated_longer_word_shadows_short_particle() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-particle-chain-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "で\tで\t-1\nの\tの\t-0.1\nこと\t事\t-0.1\nのこと\t野事\t-5\n")
            .expect("particle-chain fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("particle-chain fixture should load")
        .without_builtin_entries_for_test();

        let candidates = convert_with_dictionary(
            "でのこと",
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let top = candidates.first().expect("particle-chain conversion should produce a candidate");
        assert_eq!(
            top.text,
            "での事",
            "an unrelated のこと lexical row must not erase the valid で+の+事 chain: {:?}",
            candidates.iter().map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn public_dictionary_restores_hashi_particle_segmentation() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        let candidates = convert_with_dictionary(
            "はしのはじからものがおちてます",
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let top = candidates.first().expect("public conversion should produce a candidate");
        assert!(
            !top.text.starts_with("橋野"),
            "prefix pruning must not let 橋野 erase はし+の: {}",
            top.text
        );
        assert!(
            candidates.iter().any(|candidate| candidate.text == "橋の端から物が落ちてます"
                || candidate.text == "箸の端から物が落ちてます"),
            "requested particle segmentation must remain available once short prefixes survive: {:?}",
            candidates.iter().map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
    }

    #[test]
    fn keeps_short_prefixes_with_a_distinct_particle_segmentation() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public conversion dictionary should load");
        let input = "はしのはじからものがおちてます";
        let chars = super::to_hiragana(input).chars().collect::<Vec<_>>();
        let max_dictionary_word_chars = super::bounded_dictionary_word_chars(
            ConversionOptions::default().max_dictionary_word_chars,
        );

        let first_entries = dictionary
            .entries_starting_at(&chars, 0, max_dictionary_word_chars)
            .expect("first lattice position should load");
        let first_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &chars,
            0,
            first_entries,
            chars.len(),
            max_dictionary_word_chars,
        );
        assert!(
            first_pruned.iter().any(|entry| entry.reading == "はし" && entry.surface == "橋"),
            "the short 橋 candidate must survive before the following particle の"
        );

        let haji_start = "はしの".chars().count();
        let haji_entries = dictionary
            .entries_starting_at(&chars, haji_start, max_dictionary_word_chars)
            .expect("second lattice position should load");
        let haji_pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &chars,
            haji_start,
            haji_entries,
            chars.len() - haji_start,
            max_dictionary_word_chars,
        );
        assert!(
            haji_pruned.iter().any(|entry| entry.reading == "はじ" && entry.surface == "端"),
            "the short 端 candidate must survive before the following particle から"
        );
        assert!(
            !haji_pruned.iter().any(|entry| entry.reading.starts_with("はじ")
                && entry.reading.chars().count() > 2),
            "longer はじ… rows that eat into から must leave the lattice: {:?}",
            haji_pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let candidates = convert_with_dictionary(
            input,
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let texts = candidates.iter().map(|candidate| candidate.text.as_str()).collect::<Vec<_>>();
        assert!(
            !texts.iter().any(|text| text.contains("端時")),
            "particle-cutting はじか rows must not remain in n-best: {texts:?}"
        );
        assert!(
            texts
                .iter()
                .any(|text| *text == "橋の端から物が落ちてます"
                    || *text == "箸の端から物が落ちてます"),
            "particle segmentation must remain available: {texts:?}"
        );
    }

    #[test]
    fn public_dictionary_default_beam_restores_hashi_no_haji_kara() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        let candidates = convert_with_dictionary(
            "はしのはじからものがおちてます",
            &dictionary,
            ConversionOptions::default(),
        );
        let top = candidates.first().expect("public conversion should produce a candidate");
        assert_eq!(top.text, "橋の端から物が落ちてます");
        assert!(
            candidates.iter().all(|candidate| {
                !candidate.text.contains("端時") && !candidate.text.contains("橋野は時")
            }),
            "agglutinated particle rows must not remain in default n-best: {:?}",
            candidates.iter().map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
    }

    #[test]
    fn soft_prune_ranking_prefers_hashi_no_haji_and_atsui_hi() {
        // Ranking-only soft penalties: keep bare はし→箸 / ひな→雛, demote
        // distractor paths when a Postposition continuation or multi-Kanji
        // segmentation is available.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("official AzooKey dictionary should load");

        let hashi_no_haji =
            convert_with_dictionary("はしのはじ", &dictionary, ConversionOptions::default());
        assert_eq!(
            hashi_no_haji.first().map(|candidate| candidate.text.as_str()),
            Some("橋の端"),
            "soft-prune must beat 走の恥 / 箸の恥: {:?}",
            hashi_no_haji.iter().take(5).map(|candidate| &candidate.text).collect::<Vec<_>>()
        );

        let atsui_hi =
            convert_with_dictionary("あついひ", &dictionary, ConversionOptions::default());
        assert_eq!(
            atsui_hi.first().map(|candidate| candidate.text.as_str()),
            Some("暑い日"),
            "soft-prune must beat raw あついひ: {:?}",
            atsui_hi.iter().take(5).map(|candidate| &candidate.text).collect::<Vec<_>>()
        );

        let bare_hashi = convert_with_dictionary("はし", &dictionary, ConversionOptions::default());
        assert_eq!(
            bare_hashi.first().map(|candidate| candidate.text.as_str()),
            Some("箸"),
            "bare はし must remain chopsticks-capable: {:?}",
            bare_hashi.iter().take(3).map(|candidate| &candidate.text).collect::<Vec<_>>()
        );

        let bare_hina = convert_with_dictionary("ひな", &dictionary, ConversionOptions::default());
        assert_eq!(
            bare_hina.first().map(|candidate| candidate.text.as_str()),
            Some("雛"),
            "bare ひな must remain 雛: {:?}",
            bare_hina.iter().take(3).map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
    }

    #[test]
    fn suppresses_bare_numeric_homophones_without_breaking_counter_paths() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("public conversion dictionary should load");
        for (input, expected) in [
            ("かたち、こうし、もよう", "形、格子、模様"),
            ("せんそう、しんこう、しんりゃく", "戦争、侵攻、侵略"),
            ("かせん、かこう、かわべ", "河川、河口、川辺"),
            ("にゅうきん、しゅうし、かくにん", "入金、収支、確認"),
            ("もじ、かんじ、ぞくじ", "文字、漢字、俗字"),
            ("ごねん", "5年"),
            ("しがつ", "4月"),
            ("じゅう、", "10、"),
            ("よっか", "4日"),
            ("さんがつついたち", "3月1日"),
            ("しちじはん", "7時半"),
            ("ごじはん", "5時半"),
        ] {
            let candidate = convert_with_dictionary(
                input,
                &dictionary,
                ConversionOptions { n_best: 10, ..ConversionOptions::default() },
            )
            .into_iter()
            .next()
            .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }
    }

    #[test]
    fn converts_common_technical_katakana_without_losing_surface_script() {
        assert_eq!(convert_kana_to_kanji("データをダウンロード"), "データをダウンロード");
        assert_eq!(convert_kana_to_kanji("せっていのアップデート"), "設定のアップデート");
    }

    #[test]
    fn converts_hiragana_loanwords_from_official_ruby_identity() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        assert!(
            dictionary.has_system_dictionary(),
            "quality test requires the official dictionary"
        );
        for (input, expected) in [
            ("ぱそこん", "パソコン"),
            ("ぱそこんが", "パソコンが"),
            ("かめらで", "カメラで"),
            ("ほてるに", "ホテルに"),
            ("きりん", "キリン"),
            ("きりんさんがすきです", "キリンさんが好きです"),
            ("あいふぉん", "iPhone"),
            ("あいふぉんをこうにゅうする", "iPhoneを購入する"),
            ("です", "です"),
            ("すーぷ", "スープ"),
            ("はれ", "晴れ"),
            ("はれです", "晴れです"),
            ("はれます", "晴れます"),
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
    fn keeps_nonnumeric_large_unit_suffixes_in_plain_text() {
        let dictionary = AzooKeyDictionary::default();
        for (input, expected) in [
            ("けいさん", "けいさん"),
            ("まるまん", "まるまん"),
            ("あまん", "あまん"),
            ("そうじゅう", "そうじゅう"),
            ("まんえん", "まんえん"),
            ("しけい", "しけい"),
            ("しじ", "しじ"),
            ("よけい", "よけい"),
            // Keep the existing lexical `ぜん` guard intact: 改善 must not
            // become 改1000 when the lattice starts at the suffix.
            ("かいぜん", "改善"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("plain dictionary should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }
    }

    #[test]
    fn preserves_valid_bare_and_compound_number_paths() {
        let dictionary = AzooKeyDictionary::default();
        for (input, expected) in [
            ("いちまん", "10000"),
            ("さんじゅうまんえん", "300000円"),
            ("ひゃくえん", "100円"),
            ("さんびゃくえん", "300円"),
            ("にせんにじゅうよねん", "2024年"),
            ("じゅう", "10"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("plain dictionary should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }
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
    fn tsv_fixture_is_ranked_and_stable_across_prefixes_without_builtin_rows() {
        // This is a converter-contract test, not a portable/official-dictionary
        // quality claim. Excluding built-in rows ensures the fixture alone
        // supplies every lexical result asserted below.
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
        .expect("quality fixture should load")
        .without_builtin_entries_for_test();

        let options = ConversionOptions { n_best: 8, ..ConversionOptions::default() };
        let full = convert_with_dictionary(full_reading, &dictionary, options);
        assert!(!full.is_empty());
        assert_eq!(full[0].text, full_surface);

        // Check the same-reading alternatives directly. The full-reading
        // conversion appends the unknown kana tail to each shorter path, so
        // asserting on the standalone stem isolates beam surface retention.
        let stem = convert_with_dictionary(stem_reading, &dictionary, options);
        assert_eq!(stem[0].text, "検証語");
        assert!(
            stem.iter().any(|candidate| candidate.text == "検証歩"),
            "same-metadata alternatives must retain distinct rendered surfaces"
        );
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
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        assert!(
            dictionary.has_system_dictionary(),
            "quality test requires the official dictionary"
        );
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
    fn prefers_natural_orthography_for_totemo_and_soup_particle_tails() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        assert!(
            dictionary.has_system_dictionary(),
            "quality test requires the official dictionary"
        );
        for (input, expected) in [
            // Rare dictionary row 迚も must not beat the common kana form.
            ("とても", "とても"),
            ("とてもおいしい", "とても美味しい"),
            // Particle は after a loanword must stay a particle, not 歯/端/派.
            ("すーぷは", "スープは"),
            ("あついすーぷは", "熱いスープは"),
            ("おいしいすーぷは", "美味しいスープは"),
            // Short ASR fragments ending in particles.
            ("きょうは", "今日は"),
            ("てんきは", "天気は"),
            ("は", "は"),
            ("すーぷ", "スープ"),
        ] {
            let candidates =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default());
            let top = candidates.first().expect("public conversion should produce a candidate");
            assert_eq!(top.text, expected, "input: {input}");
            assert!(
                !top.text.contains('歯') && !top.text.contains('端'),
                "particle-tail conversion must not yield 歯/端 for {input}: {:?}",
                top.text
            );
            assert_ne!(top.text, "迚も", "input: {input}");
            assert!(!top.text.starts_with('迚'), "input: {input}");
            assert!(!top.text.starts_with("撮ても"), "input: {input}");
        }
    }

    #[test]
    fn keeps_particle_after_loanword_when_a_verb_follows() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        assert!(
            dictionary.has_system_dictionary(),
            "quality test requires the official dictionary"
        );
        for (input, expected_prefix, forbidden_substrings) in [
            ("すーぷはください", "スープは", &["スープ端", "スープ歯", "スープ派下さい"][..]),
            ("すーぷはのみたい", "スープは", &["スープ端", "スープ歯", "端の味", "歯の"][..]),
            ("すーぷはたべたい", "スープは食べ", &["スープ端", "スープ歯"][..]),
            ("あついすーぷはたべたくない", "熱いスープは食べ", &["スープ端", "スープ歯"][..]),
        ] {
            let candidates =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default());
            let top = candidates.first().expect("public conversion should produce a candidate");
            assert!(
                top.text.starts_with(expected_prefix),
                "input {input}: expected prefix {expected_prefix:?}, got {:?}",
                top.text
            );
            assert!(
                top.text.contains('は'),
                "particle は must survive for {input}: {:?}",
                top.text
            );
            for forbidden in forbidden_substrings {
                assert!(
                    !top.text.contains(forbidden),
                    "input {input}: must not contain {forbidden:?}, got {:?}",
                    top.text
                );
            }
            // Exact preferred surfaces for the two user-reported regressions.
            if input == "すーぷはください" {
                assert_eq!(top.text, "スープはください", "input: {input}");
            }
            if input == "すーぷはのみたい" {
                assert_eq!(top.text, "スープは飲みたい", "input: {input}");
            }
        }
    }

    #[test]
    fn converts_requested_weather_and_soup_sentences_with_public_dictionary() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        assert!(
            dictionary.has_system_dictionary(),
            "quality test requires the official dictionary"
        );
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
    fn keeps_inflectional_rows_available_to_full_conversion() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        for (input, expected) in [
            ("おこなわ", "行わ"),
            ("おもっ", "思っ"),
            ("まわっ", "回っ"),
            ("つかっ", "使っ"),
            ("きをきって", "木を切って"),
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
        let root = crate::dictionary::test_system_dictionary_path();
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
        let root = crate::dictionary::test_system_dictionary_path();
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
        // The morphology-specific identity row is the valid kana continuation
        // after the particle sequence; it must not be replaced by a homonym.
        assert_eq!(candidate.text, "料理が暑いのでさます");
    }

    #[test]
    fn keeps_preferred_morphology_identity_for_formal_kana() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("いただきます", "いただきます"),
            ("りょうりがあついのでさます", "料理が暑いのでさます"),
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
    fn keeps_long_public_dictionary_paths_in_the_default_beam() {
        let root = crate::dictionary::test_system_dictionary_path();
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

    #[test]
    fn public_dictionary_keeps_numeric_edges_below_ordinary_homophones() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("けいさん", "計算"),
            ("そうじゅう", "操縦"),
            ("しけい", "死刑"),
            ("しじ", "支持"),
            ("よけい", "余計"),
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
    fn keeps_one_mora_kanji_before_copular_nanode() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-copular-nanode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "ひ\t日\t-1\nひ\tひ\t-2\nひな\t雛\t-0.1\nなので\tなので\t-0.5\n")
            .expect("copular-nanode fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("copular-nanode fixture should load")
        .without_builtin_entries_for_test();

        let chars = "ひなので".chars().collect::<Vec<_>>();
        let pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &chars,
            0,
            dictionary.entries_starting_at(&chars, 0, 24).expect("ひなので lookup"),
            chars.len(),
            24,
        );
        assert!(
            pruned.iter().any(|entry| entry.reading == "ひ" && entry.surface == "日"),
            "ひな must not shadow 日 before なので: {:?}",
            pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
        );

        let candidates = convert_with_dictionary(
            "ひなので",
            &dictionary,
            ConversionOptions { n_best: 8, ..ConversionOptions::default() },
        );
        let top = candidates.first().expect("copular-nanode conversion should produce a candidate");
        assert_eq!(
            top.text,
            "日なので",
            "one-mora content Kanji before a copula must outrank ひな glue: {:?}",
            candidates.iter().map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn public_dictionary_default_beam_converts_atsui_hi_nanode() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load");
        let input = "あついひなのであついすーぷをのみたくない";
        let chars = super::to_hiragana(input).chars().collect::<Vec<_>>();
        let hi_start = "あつい".chars().count();
        let max_dictionary_word_chars = super::bounded_dictionary_word_chars(
            ConversionOptions::default().max_dictionary_word_chars,
        );
        let pruned = super::prune_short_kanji_prefix_entries(
            &dictionary,
            &chars,
            hi_start,
            dictionary
                .entries_starting_at(&chars, hi_start, max_dictionary_word_chars)
                .expect("ひ lookup"),
            chars.len() - hi_start,
            max_dictionary_word_chars,
        );
        assert!(
            pruned.iter().any(|entry| entry.reading == "ひ" && entry.surface == "日"),
            "日 must remain before なので: {:?}",
            pruned
                .iter()
                .filter(|entry| entry.reading.starts_with('ひ'))
                .map(|entry| (&entry.reading, &entry.surface))
                .collect::<Vec<_>>()
        );

        let candidates = convert_with_dictionary(input, &dictionary, ConversionOptions::default());
        let top = candidates.first().expect("public conversion should produce a candidate");
        assert_eq!(top.text, "暑い日なので熱いスープを飲みたくない");
    }

    #[test]
    fn keeps_one_mora_kanji_before_copular_nanoni_nara_nanoda_nanodesu() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-copular-extra-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(
            &root,
            "ひ\t日\t-1\nひ\tひ\t-2\nひな\t雛\t-0.1\nなのに\tなのに\t-0.5\nなら\tなら\t-0.5\nなのだ\tなのだ\t-0.5\nなのです\tなのです\t-0.5\n",
        )
        .expect("copular-extra fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("copular-extra fixture should load")
        .without_builtin_entries_for_test();

        for (input, expected) in [
            ("ひなのに", "日なのに"),
            ("ひなら", "日なら"),
            ("ひなのだ", "日なのだ"),
            ("ひなのです", "日なのです"),
        ] {
            let chars = input.chars().collect::<Vec<_>>();
            let pruned = super::prune_short_kanji_prefix_entries(
                &dictionary,
                &chars,
                0,
                dictionary.entries_starting_at(&chars, 0, 24).expect("ひ lookup"),
                chars.len(),
                24,
            );
            assert!(
                pruned.iter().any(|entry| entry.reading == "ひ" && entry.surface == "日"),
                "ひな must not shadow 日 before {input}: {:?}",
                pruned.iter().map(|entry| (&entry.reading, &entry.surface)).collect::<Vec<_>>()
            );
            let top = convert_with_dictionary(
                input,
                &dictionary,
                ConversionOptions { n_best: 8, ..ConversionOptions::default() },
            )
            .into_iter()
            .next()
            .expect("copular-extra conversion should produce a candidate");
            assert_eq!(top.text, expected, "input: {input}");
        }

        let hina = convert_with_dictionary(
            "ひな",
            &dictionary,
            ConversionOptions { n_best: 8, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("bare ひな conversion should produce a candidate");
        assert_eq!(hina.text, "雛", "bare ひな must stay 雛, not 日な");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn public_dictionary_default_beam_keeps_hi_before_copular_nanoni_and_nara() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load");
        let max_dictionary_word_chars = super::bounded_dictionary_word_chars(
            ConversionOptions::default().max_dictionary_word_chars,
        );
        for (input, hi_prefix, expected_top) in [
            ("ひなのに", "", None),
            ("あついひなのに", "あつい", Some("暑い日なのに")),
            ("あついひなら", "あつい", Some("暑い日なら")),
        ] {
            let chars = super::to_hiragana(input).chars().collect::<Vec<_>>();
            let hi_start = hi_prefix.chars().count();
            let pruned = super::prune_short_kanji_prefix_entries(
                &dictionary,
                &chars,
                hi_start,
                dictionary
                    .entries_starting_at(&chars, hi_start, max_dictionary_word_chars)
                    .expect("ひ lookup"),
                chars.len() - hi_start,
                max_dictionary_word_chars,
            );
            assert!(
                pruned.iter().any(|entry| entry.reading == "ひ" && entry.surface == "日"),
                "日 must remain before the copular continuation in {input}: {:?}",
                pruned
                    .iter()
                    .filter(|entry| entry.reading.starts_with('ひ'))
                    .map(|entry| (&entry.reading, &entry.surface))
                    .collect::<Vec<_>>()
            );
            let candidates = convert_with_dictionary(
                input,
                &dictionary,
                ConversionOptions { n_best: 16, ..ConversionOptions::default() },
            );
            let texts =
                candidates.iter().map(|candidate| candidate.text.as_str()).collect::<Vec<_>>();
            assert!(
                texts.iter().any(|text| text.contains('日')),
                "日 must remain available after {input}: {texts:?}"
            );
            if let Some(expected) = expected_top {
                let top = texts.first().expect("public conversion should produce a candidate");
                assert_eq!(*top, expected, "input: {input}");
            }
        }
    }

    #[test]
    fn public_dictionary_default_beam_converts_bare_hina_to_chick() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load");
        let top = convert_with_dictionary("ひな", &dictionary, ConversionOptions::default())
            .into_iter()
            .next()
            .expect("public conversion should produce a candidate");
        assert_eq!(top.text, "雛");
    }
}
