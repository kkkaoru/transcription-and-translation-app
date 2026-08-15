use super::dictionary::{
    is_jodoushi_cid, is_joshi_cid, is_postposition_cid, AzooKeyDictionary, DictionaryEntry,
    DictionaryPaths, BOS_EOS_MID, DEFAULT_CID, DEFAULT_MID,
};
use super::normalization::{
    is_boundary, japanese_counter_starts_at, japanese_numeral_has_unit, numeric_counter_surface,
    numeric_span_starts_with_digit, numeric_surface_prefix, skip_intervening_numeric_unit_noise,
    to_hiragana, to_katakana,
};
use super::verifier::{Draft, DraftVerifier, SessionContext, VerificationState};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::Once;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrecedingContext {
    pub rcid: u16,
    pub mid: u16,
}

/// Convert-scoped cache of `entries_starting_at` keyed by absolute offset.
/// Ranking helpers that inspect following edges share one prefix scan per mora
/// instead of repeating it for every beam state and lattice row.
struct SpanLookup<'a> {
    dictionary: &'a AzooKeyDictionary,
    chars: &'a [char],
    max_chars: usize,
    cache: RefCell<HashMap<usize, Vec<DictionaryEntry>>>,
}

impl<'a> SpanLookup<'a> {
    fn new(dictionary: &'a AzooKeyDictionary, chars: &'a [char], max_chars: usize) -> Self {
        Self { dictionary, chars, max_chars, cache: RefCell::new(HashMap::new()) }
    }

    fn entries_starting_at(&self, start: usize) -> Vec<DictionaryEntry> {
        if let Some(entries) = self.cache.borrow().get(&start) {
            return entries.clone();
        }
        let entries = self
            .dictionary
            .entries_starting_at(self.chars, start, self.max_chars)
            .unwrap_or_default();
        self.cache.borrow_mut().insert(start, entries.clone());
        entries
    }
}

const DEFAULT_BEAM_WIDTH: usize = 64;
const DEFAULT_VERIFIER_MAX_ITERATIONS: usize = 10;
static INVALID_LEFT_CONTEXT_WARNING: Once = Once::new();
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
/// Keep lexical lookahead bounded when a clause connector separates a
/// homophone from the word that disambiguates it. This is a tie-breaker only;
/// Viterbi/CID/MM scores remain the primary ranking signal.
const CONTEXT_LOOKAHEAD_CHARS: usize = 12;
const THICKNESS_CONTEXT_BONUS: f32 = 1.5;
/// Extra bonus when a thickness cue co-occurs with slicing/cutting vocabulary.
const THICKNESS_SLICE_CONTEXT_BONUS: f32 = 0.75;
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
/// Extra demotion when compact-unknown covers a span that already has a complete
/// multi-Kanji dictionary segmentation. Strong enough that object+verb paths
/// such as `柿`+`食う` can outrank raw kana after a predicate (`良く`).
const UNKNOWN_MULTI_KANJI_SEGMENTATION_PENALTY: f32 = -20.0;
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
/// Soft-demote a multi-Kanji compound when the same reading has a single-Kanji
/// alternative and the next edge is a conjugational verb (`下記` before `食う`
/// while `柿` remains available). Keeps compounds in n-best.
const MULTI_KANJI_COMPOUND_BEFORE_VERB_PENALTY: f32 = -4.0;
/// Soft-demote a conjugational stem that is immediately followed by another
/// conjugational verb without a connective `て`/`で` surface (`書き`+`食う`).
/// Serial verb chains without て are rare in captions; noun+verb stays intact.
const CONJUGATIONAL_STEM_BEFORE_VERB_PENALTY: f32 = -8.0;
/// Soft-boost a single-Kanji content word immediately before a conjugational
/// verb (`柿`+`食う`). Counters sparse multi-mora leftovers that leave a raw
/// kana tail (`角`+`くう`) without embedding a surface pair.
const SINGLE_KANJI_BEFORE_VERB_BONUS: f32 = 6.0;
/// Soft-boost adverbial `…く` spellings (`良く`) before content so they can
/// outrank bare Kanji homophones (`翌`) when an object+verb follows.
const ADVERBIAL_KU_BEFORE_CONTENT_BONUS: f32 = 12.0;
/// Soft-demote a longer stem that ends inside a following conjugational verb
/// after a short content object (`角く` under `かき`+`食う`).
const STEM_CUTTING_INTO_OBJECT_VERB_PENALTY: f32 = -10.0;
/// Soft-demote a bare single-Kanji row when the same reading has a conjugational
/// stem alternative (`書` under `書き`) and another verb follows.
const BARE_KANJI_STEM_BEFORE_VERB_PENALTY: f32 = -2.5;
/// Soft-demote a conjugational spelling that loses unigram value to another
/// conjugational surface for the same reading when attached after a content
/// object (`喰う` under `食う` after `柿`). Bare clause-initial adjectives are
/// unchanged so `晴れ` is not demoted toward `貼れ`.
const DOMINATED_CONJUGATIONAL_AFTER_OBJECT_PENALTY: f32 = -3.0;
/// Soft-demote non-conjugational Kanji when a conjugational stem alternative
/// exists for the same reading and the next edge is a jodoushi identity
/// auxiliary (`ます`). Bare roots such as `古` otherwise beat verb stems
/// (`降り`) on connection cost alone before polite endings. Also covers
/// evidential `そうです`, where the same bare roots outrank `降り`/`振り`.
const BARE_CONTENT_BEFORE_JODOUSHI_PENALTY: f32 = -12.0;
/// Soft-boost precipitation stems after a weather noun (`雨`/`雪` and
/// `が`/`は` tails) so `あめがふりそうです` becomes `雨が降りそうです`
/// instead of `振り`.
const PRECIPITATION_STEM_AFTER_RAIN_BONUS: f32 = 4.5;
/// Soft-demote the wave/shake stem after the same weather noun so it stays in
/// n-best without winning live weather captions.
const WAVE_STEM_AFTER_RAIN_PENALTY: f32 = -4.5;
/// Soft-boost food-temperature `熱い` after a food subject (`料理が`/`スープは`)
/// so `りょうりがあついのでさます` does not become weather `暑い`.
const FOOD_HEAT_AFTER_FOOD_SUBJECT_BONUS: f32 = 4.5;
/// Soft-demote weather `暑い` after the same food subject.
const WEATHER_HEAT_AFTER_FOOD_SUBJECT_PENALTY: f32 = -4.5;
/// Soft-boost `橋` when the leftover is a crossing cue (`をわたる` / `をとおる`)
/// so isolated `はし` can stay chopsticks while `はしをわたる` becomes a bridge.
const BRIDGE_CROSSING_CONTEXT_BONUS: f32 = 4.5;
/// Soft-boost thickness `厚い` before a physical object noun (`かべ` / `ほん` /
/// `こおり`) so attributive captions do not keep weather `暑い`.
const THICKNESS_OBJECT_NOUN_BONUS: f32 = 6.5;
/// Soft-demote weather/temperature `暑い`/`熱い` in the same attributive slot.
const THICKNESS_OBJECT_NOUN_HEAT_PENALTY: f32 = -4.5;
/// Soft-boost te-form `書いて` before a request/try auxiliary so
/// `かいてください` / `かいてみます` do not keep rarer `描いて`.
const KAKU_TE_REQUEST_CONTEXT_BONUS: f32 = 4.5;
/// Soft-boost edge `端` after a physical/spatial noun + `の` so
/// `みちのはじ` / `つくえのはじ` do not keep shame `恥`. Isolated `はじ`
/// and animate possessives (`わたしのはじ`) stay shame-capable.
const EDGE_AFTER_SPATIAL_NOUN_BONUS: f32 = 6.5;
/// Soft-demote shame `恥`/`恥じ` in the same spatial-possessive slot.
const SHAME_AFTER_SPATIAL_NOUN_PENALTY: f32 = -4.5;
/// Soft-boost paper `紙` when leftover speech is `の`+`はじ` so `かみのはじ`
/// becomes `紙の端` instead of literary `神の恥`. Isolated `かみ` stays 神.
const PAPER_BEFORE_EDGE_POSSESSIVE_BONUS: f32 = 6.5;
/// Soft-demote deity `神` in the same leftover slot.
const GOD_BEFORE_EDGE_POSSESSIVE_PENALTY: f32 = -4.5;
/// Soft-boost hair `髪` when leftover speech is `をきる` so `かみをきる`
/// becomes `髪を切る` instead of `神を切る`. Isolated `かみ` stays 神.
const HAIR_BEFORE_CUT_VERB_BONUS: f32 = 6.5;
/// Soft-demote deity `神` in the same leftover slot.
const GOD_BEFORE_CUT_VERB_PENALTY: f32 = -4.5;
/// Soft-boost draw `描いて`/`描く` after a picture object (`絵を` / `画を`)
/// so `えをかいて` does not keep write `書いて`. Isolated `かいて` and
/// `かいてください` stay write-capable.
const DRAW_AFTER_PICTURE_OBJECT_BONUS: f32 = 4.5;
/// Soft-demote write `書いて`/`書く` in the same picture-object slot.
const WRITE_AFTER_PICTURE_OBJECT_PENALTY: f32 = -4.5;
/// Soft-boost scratch `掻く` after shame `恥を` so the idiom `はじをかく`
/// becomes `恥を掻く` instead of `恥を書く`. Isolated `かく` is unchanged.
const SCRATCH_AFTER_SHAME_OBJECT_BONUS: f32 = 11.0;
/// Soft-demote write/draw `書く`/`描く` after `恥を`. The glued rows
/// `を書く` / `を描く` exist, but `を掻く` does not, so the idiom path is
/// `恥を`+`掻く` and needs a larger swing than picture-object `描いて`.
const WRITE_AFTER_SHAME_OBJECT_PENALTY: f32 = -6.5;
/// Soft-demote raw Katakana ruby-id rows before a jodoushi identity when a
/// conjugational Kanji stem exists for the same reading. Without this, loanword
/// orthography such as `フリ`+`ます` can beat `降り`+`ます` after bare roots are
/// demoted.
const RUBY_IDENTITY_BEFORE_JODOUSHI_PENALTY: f32 = -4.0;
/// Soft-boost a conjugational stem with an inflectional kana tail immediately
/// before a jodoushi identity auxiliary. Complements the bare-content demotion
/// so `降り`+`ます` stays ahead of near-tie ruby and compound leftovers.
const CONJUGATIONAL_STEM_BEFORE_JODOUSHI_BONUS: f32 = 3.0;
/// Soft-demote a hiragana identity before a jodoushi auxiliary when a
/// conjugational Kanji stem exists for the same reading (`のみ`+`ます` →
/// `飲み`+`ます`). Joshi-band and conjugational-band kana identities both
/// outrank stems via cheap transitions; jodoushi-band identities such as
/// `あり` before `ます` stay score-driven.
const HIRAGANA_IDENTITY_BEFORE_JODOUSHI_PENALTY: f32 = -4.0;
/// Soft-demote a one-mora non-conjugational Kanji when a longer conjugational
/// stem starts at the same offset and the leftover is a jodoushi identity
/// (`ふ`+`理想`+`です` under `降り`+`そうです`). Keeps the short Kanji in n-best.
const SHORT_KANJI_HIDING_STEM_BEFORE_JODOUSHI_PENALTY: f32 = -12.0;
/// Soft-demote a short converted head when the remaining reading begins with a
/// closed-class personification suffix and a longer converted dictionary row
/// already covers head+suffix (`私たち` covering `わたし`+`たち`). Keeps rare
/// short spellings (`妾`) from winning via cheap DEFAULT transitions.
const SHORT_HEAD_BEFORE_PERSON_SUFFIX_PENALTY: f32 = -5.0;
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

/// Controls whether a verifier should be applied to a conversion.
///
/// The policy is deliberately owned by the caller rather than hidden inside
/// the verifier backend.  This keeps the same decision available to embedded,
/// HTTP, and WASM callers and leaves room for additional application rules
/// (speaker turns, utterance type, and so on) without changing the backend
/// contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifierPolicy {
    /// When true, verification requires a non-empty, non-whitespace left
    /// context.  When false, verification is attempted even without context.
    pub require_left_context: bool,
}

impl VerifierPolicy {
    /// Require usable left context before starting verification.
    pub const fn require_left_context() -> Self {
        Self { require_left_context: true }
    }

    /// Always attempt verification, including for a context-free utterance.
    /// This is intended for offline measurement or diagnostics; production
    /// caption conversion should use the default context-required policy.
    pub const fn always_verify() -> Self {
        Self { require_left_context: false }
    }

    /// Returns whether the caller's context satisfies this policy.
    ///
    /// Context is transported as UTF-8 bytes so the same predicate can be
    /// applied before both embedded and HTTP sessions. Invalid UTF-8 is not a
    /// usable text context and therefore fails the requirement rather than
    /// being silently interpreted as arbitrary bytes.
    pub fn should_verify(&self, left_context: Option<&[u8]>) -> bool {
        matches!(self.decision(left_context), VerifierPolicyDecision::Verify)
    }

    fn decision(&self, left_context: Option<&[u8]>) -> VerifierPolicyDecision {
        match left_context {
            Some(bytes) => match std::str::from_utf8(bytes) {
                Err(_) => VerifierPolicyDecision::InvalidContext,
                Ok(_) if !self.require_left_context => VerifierPolicyDecision::Verify,
                Ok(text) if text.chars().any(|character| !character.is_whitespace()) => {
                    VerifierPolicyDecision::Verify
                }
                Ok(_) => VerifierPolicyDecision::MissingContext,
            },
            None if self.require_left_context => VerifierPolicyDecision::MissingContext,
            None => VerifierPolicyDecision::Verify,
        }
    }
}

impl Default for VerifierPolicy {
    fn default() -> Self {
        Self::require_left_context()
    }
}

/// Controls how many draft/constraint rounds a verifier may request before
/// conversion returns the latest constrained candidate or, if none can be
/// constructed, the dictionary result. The loop is bounded even when a
/// backend repeatedly returns a prefix constraint, so a verifier cannot make
/// caption production unbounded or prevent a result from being emitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierConversionOptions {
    pub max_iterations: usize,
    pub inference_config_revision: String,
    /// Optional left context supplied to the verifier session.
    pub left_context: Option<Vec<u8>>,
    /// The application policy used before opening a verifier session.
    pub policy: VerifierPolicy,
    /// Optional wall-clock budget for verifier setup and evaluation. The
    /// conversion loop checks this budget before and after backend calls; a
    /// synchronous backend call that is already in progress cannot be
    /// forcefully preempted by this Rust boundary.
    pub deadline: Option<Duration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerifierPolicyDecision {
    Verify,
    MissingContext,
    InvalidContext,
}

impl VerifierConversionOptions {
    /// Create options with the production-safe context-required policy.
    pub fn new(max_iterations: usize, inference_config_revision: impl Into<String>) -> Self {
        Self {
            max_iterations,
            inference_config_revision: inference_config_revision.into(),
            left_context: None,
            policy: VerifierPolicy::default(),
            deadline: None,
        }
    }

    /// Attach UTF-8 left context. Empty and whitespace-only context is
    /// therefore observable as a policy skip rather than an attempted model
    /// call under the default policy.
    pub fn with_left_context(mut self, left_context: impl AsRef<[u8]>) -> Self {
        self.left_context = Some(left_context.as_ref().to_vec());
        self
    }

    /// Override the application policy supplied by the caller.
    pub fn with_policy(mut self, policy: VerifierPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Set the caller-owned verification wall-clock budget.
    pub fn with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// Disable a previously configured verification deadline.
    pub fn without_deadline(mut self) -> Self {
        self.deadline = None;
        self
    }
}

/// The conversion result always contains a text candidate. `verification_state`
/// preserves whether that candidate was verified, came from constrained
/// lattice search, or came from the dictionary fallback, without retaining
/// backend diagnostics or input text. The iteration counter is numeric-only
/// diagnostic data and records how many verifier evaluations were attempted.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversionWithVerification {
    pub candidate: ConversionCandidate,
    pub verification_state: VerificationState,
    pub verification_iterations: usize,
}

impl ConversionWithVerification {
    pub fn text(&self) -> &str {
        &self.candidate.text
    }

    pub fn is_verified(&self) -> bool {
        self.verification_state == VerificationState::Verified
    }

    pub fn verification_iterations(&self) -> usize {
        self.verification_iterations
    }
}

/// Policy used when a reading position has no dictionary-backed edge.
///
/// `AllowOovIdentity` is the compatibility default: it keeps an unknown
/// scalar as an explicit OOV edge so callers can distinguish it from a
/// dictionary identity. `PreserveInput` has the same coverage guarantee but
/// documents that the original source spelling is required by the caller.
/// `StrictDictionary` omits OOV edges entirely; a strict lattice can therefore
/// be empty for input that is not fully covered by dictionary/boundary edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UnknownPolicy {
    StrictDictionary,
    #[default]
    AllowOovIdentity,
    PreserveInput,
}

pub type EdgeHandle = usize;
pub type DictionaryEntryId = u32;

/// A conversion request used to construct the inspectable dictionary lattice.
///
/// The existing `ConversionOptions` API remains unchanged for v1 callers.
/// This request deliberately owns its input so a lattice can be retained by a
/// verifier session without borrowing an application buffer.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversionRequest {
    pub input: String,
    pub left_context: Option<PrecedingContext>,
    pub right_context: Option<PrecedingContext>,
    pub beam_width: usize,
    pub n_best: usize,
    pub unknown_policy: UnknownPolicy,
    pub max_dictionary_word_chars: usize,
}

impl ConversionRequest {
    pub fn new(input: impl Into<String>) -> Self {
        Self { input: input.into(), ..Self::default() }
    }
}

impl Default for ConversionRequest {
    fn default() -> Self {
        Self {
            input: String::new(),
            left_context: None,
            right_context: None,
            beam_width: DEFAULT_BEAM_WIDTH,
            n_best: 1,
            unknown_policy: UnknownPolicy::default(),
            max_dictionary_word_chars: DEFAULT_MAX_DICTIONARY_WORD_CHARS,
        }
    }
}

/// The provenance of an edge in a conversion lattice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeOrigin {
    Dictionary(DictionaryEntryId),
    KnownIdentity,
    NumericSynthesized,
    OovIdentity,
    Boundary,
}

/// A read-only edge description. Spans use normalized scalar positions for
/// lattice traversal and source UTF-8 byte positions for wire/cache keys.
#[derive(Debug, Clone, PartialEq)]
pub struct LatticeEdge {
    pub scalar_span: Range<usize>,
    pub byte_span: Range<usize>,
    pub reading: String,
    pub surface: String,
    pub score: f32,
    pub lcid: u16,
    pub rcid: u16,
    pub mid: u16,
    pub origin: EdgeOrigin,
}

/// A candidate path is represented by edge handles, not copied dictionary
/// entries. The rendered text is retained as a convenience for verifier
/// protocols and is reconstructed from the lattice on every search.
#[derive(Debug, Clone, PartialEq)]
pub struct CandidatePath {
    pub edge_handles: Vec<EdgeHandle>,
    pub text: String,
    pub score: f32,
    pub trailing: Option<PrecedingContext>,
}

/// A UTF-8 byte-prefix constraint attached to the edge that begins at
/// `scalar_position`. The prefix is compared against `surface.as_bytes()`;
/// token IDs and Unicode scalar IDs never cross this API boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utf8BytePrefixConstraint {
    pub scalar_position: usize,
    pub prefix: Vec<u8>,
}

impl Utf8BytePrefixConstraint {
    pub fn new(scalar_position: usize, prefix: impl AsRef<[u8]>) -> Self {
        Self { scalar_position, prefix: prefix.as_ref().to_vec() }
    }

    pub fn from_surface(scalar_position: usize, surface: &str) -> Self {
        Self::new(scalar_position, surface.as_bytes())
    }

    /// A global output-prefix constraint. It is evaluated against the
    /// reconstructed candidate text rather than an individual lattice edge.
    pub fn output_prefix(prefix: impl AsRef<[u8]>) -> Self {
        Self::new(usize::MAX, prefix)
    }
}

pub type BytePrefixConstraint = Utf8BytePrefixConstraint;

/// Request for a fresh lattice search. The optional candidate path is a hint
/// from an earlier evaluator; it is never the sole search source, so a path
/// pruned by an earlier beam can be recovered from the complete lattice.
#[derive(Debug, Clone, PartialEq)]
pub struct ConstrainedSearchRequest {
    pub candidate_path: Option<CandidatePath>,
    pub constraints: Vec<Utf8BytePrefixConstraint>,
    pub beam_width: usize,
    pub n_best: usize,
}

impl Default for ConstrainedSearchRequest {
    fn default() -> Self {
        Self {
            candidate_path: None,
            constraints: Vec::new(),
            beam_width: DEFAULT_BEAM_WIDTH,
            n_best: 1,
        }
    }
}

impl ConstrainedSearchRequest {
    pub fn new() -> Self {
        Self { beam_width: DEFAULT_BEAM_WIDTH, n_best: 1, ..Self::default() }
    }

    pub fn with_constraint(mut self, constraint: Utf8BytePrefixConstraint) -> Self {
        self.constraints.push(constraint);
        self
    }

    pub fn with_candidate_path(mut self, candidate_path: CandidatePath) -> Self {
        self.candidate_path = Some(candidate_path);
        self
    }
}

/// An inspectable, complete dictionary lattice. `edges()` exposes a slice and
/// therefore does not allow callers to mutate the lattice after construction.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversionLattice {
    source_input: String,
    normalized_input: String,
    terminal: usize,
    edges: Vec<LatticeEdge>,
    outgoing: Vec<Vec<EdgeHandle>>,
    dictionary_revision: u64,
}

impl ConversionLattice {
    pub fn input(&self) -> &str {
        &self.source_input
    }

    pub fn normalized_input(&self) -> &str {
        &self.normalized_input
    }

    pub fn terminal(&self) -> usize {
        self.terminal
    }

    pub fn dictionary_revision(&self) -> u64 {
        self.dictionary_revision
    }

    pub fn edges(&self) -> &[LatticeEdge] {
        &self.edges
    }

    pub fn edge(&self, handle: EdgeHandle) -> Option<&LatticeEdge> {
        self.edges.get(handle)
    }

    pub fn edge_handles_from(&self, scalar_position: usize) -> &[EdgeHandle] {
        self.outgoing.get(scalar_position).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn search(&self, request: &ConstrainedSearchRequest) -> Vec<CandidatePath> {
        search(self, request)
    }
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
    // Skip temperature/angle unit glyphs (°/℃/°C) before percent-counter
    // detection so digit+percent attachments survive ASR/neural unit-mark
    // noise. The skip is percent-only and folds into the counter edge so the
    // lattice advances past the noise without emitting it when `%` wins.
    // Non-percent counters (`かい`/`ど`) leave the degree mark in place.
    let unit_noise = skip_intervening_numeric_unit_noise(suffix);
    let counter_suffix = &suffix[unit_noise..];
    let followed_by_counter = japanese_counter_starts_at(counter_suffix);
    let followed_by_boundary = suffix.first().is_some_and(|character| is_boundary(*character));
    let starts_after_boundary = start > 0 && is_boundary(chars[start - 1]);
    // The counter reading `じ` uses the contracted `よじ` form; treating the
    // standalone `し` reading as four here creates `4時` from `しじ`.
    let invalid_shi_counter =
        reading == "し" && counter_suffix.first().is_some_and(|character| *character == 'じ');
    let starts_after_text = start > 0 && !starts_after_boundary;
    let unit_span_is_unbounded = has_unit
        && !has_digit_and_unit
        && starts_after_text
        && !followed_by_counter
        && !followed_by_boundary;
    let numeric_context =
        has_unit || followed_by_counter || followed_by_boundary || starts_after_boundary;
    let counter_span = numeric_counter_surface(counter_suffix)
        .map(|(counter_length, surface)| (unit_noise + counter_length, surface));
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

/// Construct the complete, inspectable dictionary lattice used by the
/// verifier layer. Unlike `convert_with_dictionary`, this function does not
/// prune short entries with the live beam: every dictionary edge is retained
/// so a later UTF-8 prefix constraint can recover a path that was absent from
/// the old top-N candidate list.
pub fn build_lattice(
    dictionary: &AzooKeyDictionary,
    request: &ConversionRequest,
) -> ConversionLattice {
    let source_input = request.input.clone();
    let normalized_input = to_hiragana(&source_input);
    let source_chars = source_input.chars().collect::<Vec<_>>();
    let chars = normalized_input.chars().collect::<Vec<_>>();
    debug_assert_eq!(source_chars.len(), chars.len());
    let terminal = chars.len();
    let byte_offsets = scalar_byte_offsets(&source_input);
    let max_dictionary_word_chars =
        bounded_dictionary_word_chars(request.max_dictionary_word_chars);
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::<EdgeHandle>::new(); terminal + 1];
    let mut dictionary_ids = HashMap::<String, DictionaryEntryId>::new();
    let mut next_dictionary_id = 0u32;

    for start in 0..terminal {
        let entries = dictionary
            .entries_starting_at(&chars, start, max_dictionary_word_chars)
            .unwrap_or_default();
        for entry in entries {
            let entry_len = entry.reading.chars().count();
            let end = start + entry_len;
            if entry_len == 0
                || end > terminal
                || chars[start..end].iter().collect::<String>() != entry.reading
            {
                continue;
            }
            let source_span = &source_chars[start..end];
            let surface = dictionary_surface_for_source(&entry, source_span);
            let source_surface: String = source_span.iter().collect();
            let origin = if is_known_identity_edge(&entry, &surface, &source_surface) {
                EdgeOrigin::KnownIdentity
            } else {
                let key = dictionary_entry_key(&entry);
                let entry_id = *dictionary_ids.entry(key).or_insert_with(|| {
                    let id = next_dictionary_id;
                    next_dictionary_id = next_dictionary_id.saturating_add(1);
                    id
                });
                EdgeOrigin::Dictionary(entry_id)
            };
            let context_score = if start == 0 {
                request
                    .left_context
                    .map(|context| dictionary.context_connection_cost(context.rcid, &entry))
                    .unwrap_or_else(|| dictionary.beginning_connection_cost(&entry))
            } else {
                NO_SCORE
            };
            push_lattice_edge(
                &mut edges,
                &mut outgoing,
                &byte_offsets,
                LatticeEdgeSpec {
                    start,
                    end,
                    reading: entry.reading,
                    surface,
                    score: entry.value + context_score,
                    lcid: entry.lcid,
                    rcid: entry.rcid,
                    mid: entry.mid,
                    origin,
                },
            );
        }

        // Numeric synthesis is deliberately independent of dictionary rows:
        // the verifier must be able to constrain `さんびゃくえん` to `300円`
        // even when the dictionary beam would prefer a lexical homophone.
        if let Some((number_len, number_surface)) = numeric_surface_prefix(&chars[start..]) {
            let reading: String = chars[start..start + number_len].iter().collect();
            let next = start + number_len;
            let suffix = &chars[next..];
            let starts_at_boundary = start == 0 || is_boundary(chars[start - 1]);
            let ends_at_boundary = next == terminal
                || chars.get(next).is_some_and(|character| is_boundary(*character));
            let has_counter = japanese_counter_starts_at(suffix);
            let explicit_digit = numeric_span_starts_with_digit(&reading)
                && reading.chars().next().is_some_and(|character| {
                    character.is_ascii_digit() || ('０'..='９').contains(&character)
                });
            let has_unit = japanese_numeral_has_unit(&reading);
            if starts_at_boundary || ends_at_boundary || has_counter || has_unit || explicit_digit {
                let score = if starts_at_boundary || ends_at_boundary || has_counter {
                    NUMERIC_BOUNDARY_SCORE
                } else {
                    NUMERIC_AMBIGUOUS_SCORE
                };
                push_lattice_edge(
                    &mut edges,
                    &mut outgoing,
                    &byte_offsets,
                    LatticeEdgeSpec {
                        start,
                        end: next,
                        reading,
                        surface: number_surface.clone(),
                        score,
                        lcid: DEFAULT_CID,
                        rcid: DEFAULT_CID,
                        mid: BOS_EOS_MID,
                        origin: EdgeOrigin::NumericSynthesized,
                    },
                );
                if let Some((counter_len, counter_surface)) = numeric_counter_surface(suffix) {
                    let counter_end = next + counter_len;
                    if counter_end <= terminal {
                        let counter_reading: String = chars[start..counter_end].iter().collect();
                        push_lattice_edge(
                            &mut edges,
                            &mut outgoing,
                            &byte_offsets,
                            LatticeEdgeSpec {
                                start,
                                end: counter_end,
                                reading: counter_reading,
                                surface: format!("{number_surface}{counter_surface}"),
                                score: score + NUMERIC_COUNTER_SCORE_PENALTY,
                                lcid: DEFAULT_CID,
                                rcid: DEFAULT_CID,
                                mid: BOS_EOS_MID,
                                origin: EdgeOrigin::NumericSynthesized,
                            },
                        );
                    }
                }
            }
        }

        if is_boundary(chars[start]) {
            push_lattice_edge(
                &mut edges,
                &mut outgoing,
                &byte_offsets,
                LatticeEdgeSpec {
                    start,
                    end: start + 1,
                    reading: chars[start].to_string(),
                    surface: source_chars[start].to_string(),
                    score: NO_SCORE,
                    lcid: DEFAULT_CID,
                    rcid: DEFAULT_CID,
                    mid: BOS_EOS_MID,
                    origin: EdgeOrigin::Boundary,
                },
            );
        }
    }

    if !matches!(request.unknown_policy, UnknownPolicy::StrictDictionary) {
        for start in 0..terminal {
            let has_non_oov_single_edge = outgoing[start].iter().any(|handle| {
                edges[*handle].scalar_span == (start..start + 1)
                    && !matches!(edges[*handle].origin, EdgeOrigin::OovIdentity)
            });
            if has_non_oov_single_edge || is_boundary(chars[start]) {
                continue;
            }
            push_lattice_edge(
                &mut edges,
                &mut outgoing,
                &byte_offsets,
                LatticeEdgeSpec {
                    start,
                    end: start + 1,
                    reading: chars[start].to_string(),
                    surface: source_chars[start].to_string(),
                    score: UNKNOWN_CHARACTER_PENALTY,
                    lcid: DEFAULT_CID,
                    rcid: DEFAULT_CID,
                    mid: BOS_EOS_MID,
                    origin: EdgeOrigin::OovIdentity,
                },
            );
        }
    }

    ConversionLattice {
        source_input,
        normalized_input,
        terminal,
        edges,
        outgoing,
        dictionary_revision: dictionary.revision(),
    }
}

impl AzooKeyDictionary {
    pub fn build_lattice(&self, request: &ConversionRequest) -> ConversionLattice {
        build_lattice(self, request)
    }
}

fn scalar_byte_offsets(input: &str) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(input.chars().count() + 1);
    offsets.push(0);
    for (byte_index, character) in input.char_indices() {
        offsets.push(byte_index + character.len_utf8());
    }
    offsets
}

fn dictionary_entry_key(entry: &DictionaryEntry) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        entry.reading,
        entry.surface,
        entry.lcid,
        entry.rcid,
        entry.mid,
        entry.raw_ruby_identity as u8,
        entry.user_supplied as u8,
        entry.value.to_bits(),
    )
}

fn is_known_identity_edge(entry: &DictionaryEntry, surface: &str, source: &str) -> bool {
    entry.surface == entry.reading
        || (surface == source
            && !contains_kanji(&entry.surface)
            && !contains_ascii_alphanumeric(&entry.surface))
}

struct LatticeEdgeSpec {
    start: usize,
    end: usize,
    reading: String,
    surface: String,
    score: f32,
    lcid: u16,
    rcid: u16,
    mid: u16,
    origin: EdgeOrigin,
}

fn push_lattice_edge(
    edges: &mut Vec<LatticeEdge>,
    outgoing: &mut [Vec<EdgeHandle>],
    byte_offsets: &[usize],
    spec: LatticeEdgeSpec,
) {
    let handle = edges.len();
    let byte_start = byte_offsets.get(spec.start).copied().unwrap_or_default();
    let byte_end = byte_offsets.get(spec.end).copied().unwrap_or(byte_start);
    edges.push(LatticeEdge {
        scalar_span: spec.start..spec.end,
        byte_span: byte_start..byte_end,
        reading: spec.reading,
        surface: spec.surface,
        score: spec.score,
        lcid: spec.lcid,
        rcid: spec.rcid,
        mid: spec.mid,
        origin: spec.origin,
    });
    if let Some(bucket) = outgoing.get_mut(spec.start) {
        bucket.push(handle);
    }
}

/// Re-run the complete lattice under byte-prefix constraints. Constraint
/// filtering happens before k-best truncation, so an edge removed by the
/// legacy candidate beam can still be recovered without enumerating every
/// exponential path in a long caption.
pub fn search(
    lattice: &ConversionLattice,
    request: &ConstrainedSearchRequest,
) -> Vec<CandidatePath> {
    if lattice.terminal == 0 {
        return vec![CandidatePath {
            edge_handles: Vec::new(),
            text: String::new(),
            score: NO_SCORE,
            trailing: None,
        }];
    }
    let n_best = request.n_best.max(1);
    let beam = if request.constraints.is_empty() {
        request.beam_width.max(n_best).max(1)
    } else {
        // With additive edge scores, the n best prefixes reaching a scalar
        // position dominate every lower-scoring prefix for the same future
        // constrained suffix. Keep exactly that protected k-best set rather
        // than restoring the old beam or retaining an unbounded path list.
        n_best
    };
    let mut states = vec![Vec::<LatticeSearchState>::new(); lattice.terminal + 1];
    states[0].push(LatticeSearchState {
        edge_handles: Vec::new(),
        text: String::new(),
        score: NO_SCORE,
        trailing: None,
    });

    for start in 0..lattice.terminal {
        let current = states[start].clone();
        if current.is_empty() {
            continue;
        }
        for state in current {
            for &handle in lattice.edge_handles_from(start) {
                let edge = &lattice.edges[handle];
                if !edge_matches_constraints(edge, &request.constraints) {
                    continue;
                }
                let end = edge.scalar_span.end;
                if end > lattice.terminal {
                    continue;
                }
                let mut edge_handles = state.edge_handles.clone();
                edge_handles.push(handle);
                let mut text = state.text.clone();
                text.push_str(&edge.surface);
                if !text_matches_prefix_constraints(&text, &request.constraints) {
                    continue;
                }
                let trailing = if matches!(edge.origin, EdgeOrigin::Boundary) {
                    state.trailing
                } else {
                    Some(PrecedingContext { rcid: edge.rcid, mid: edge.mid })
                };
                states[end].push(LatticeSearchState {
                    edge_handles,
                    text,
                    score: state.score + edge.score,
                    trailing,
                });
                trim_lattice_states(&mut states[end], beam);
            }
        }
    }

    let mut candidates = states[lattice.terminal]
        .drain(..)
        .filter_map(|state| {
            let candidate = CandidatePath {
                edge_handles: state.edge_handles,
                text: state.text,
                score: state.score,
                trailing: state.trailing,
            };
            path_matches_constraints(lattice, &candidate, &request.constraints).then_some(candidate)
        })
        .collect::<Vec<_>>();

    if let Some(candidate_path) = request.candidate_path.as_ref() {
        if let Some(candidate) = reconstruct_candidate_path(lattice, &candidate_path.edge_handles) {
            if path_matches_constraints(lattice, &candidate, &request.constraints) {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    let mut unique = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !unique.iter().any(|kept: &CandidatePath| {
            kept.edge_handles == candidate.edge_handles && kept.text == candidate.text
        }) {
            unique.push(candidate);
        }
    }
    unique.truncate(n_best);
    unique
}

#[derive(Debug, Clone)]
struct LatticeSearchState {
    edge_handles: Vec<EdgeHandle>,
    text: String,
    score: f32,
    trailing: Option<PrecedingContext>,
}

fn edge_matches_constraints(edge: &LatticeEdge, constraints: &[Utf8BytePrefixConstraint]) -> bool {
    constraints.iter().filter(|constraint| constraint.scalar_position != usize::MAX).all(
        |constraint| {
            constraint.scalar_position != edge.scalar_span.start
                || edge.surface.as_bytes().starts_with(&constraint.prefix)
        },
    )
}

fn text_matches_prefix_constraints(text: &str, constraints: &[Utf8BytePrefixConstraint]) -> bool {
    let bytes = text.as_bytes();
    constraints.iter().filter(|constraint| constraint.scalar_position == usize::MAX).all(
        |constraint| bytes.starts_with(&constraint.prefix) || constraint.prefix.starts_with(bytes),
    )
}

fn path_matches_constraints(
    lattice: &ConversionLattice,
    candidate: &CandidatePath,
    constraints: &[Utf8BytePrefixConstraint],
) -> bool {
    constraints.iter().all(|constraint| {
        if constraint.scalar_position == usize::MAX {
            return candidate.text.as_bytes().starts_with(&constraint.prefix);
        }
        candidate.edge_handles.iter().any(|handle| {
            lattice.edges[*handle].scalar_span.start == constraint.scalar_position
                && lattice.edges[*handle].surface.as_bytes().starts_with(&constraint.prefix)
        })
    })
}

fn reconstruct_candidate_path(
    lattice: &ConversionLattice,
    edge_handles: &[EdgeHandle],
) -> Option<CandidatePath> {
    let mut position = 0usize;
    let mut text = String::new();
    let mut score = NO_SCORE;
    let mut trailing = None;
    for handle in edge_handles {
        let edge = lattice.edges.get(*handle)?;
        if edge.scalar_span.start != position {
            return None;
        }
        position = edge.scalar_span.end;
        text.push_str(&edge.surface);
        score += edge.score;
        if !matches!(edge.origin, EdgeOrigin::Boundary) {
            trailing = Some(PrecedingContext { rcid: edge.rcid, mid: edge.mid });
        }
    }
    (position == lattice.terminal).then_some(CandidatePath {
        edge_handles: edge_handles.to_vec(),
        text,
        score,
        trailing,
    })
}

fn trim_lattice_states(states: &mut Vec<LatticeSearchState>, beam: usize) {
    states.sort_by(|left, right| right.score.total_cmp(&left.score));
    if beam != usize::MAX {
        states.truncate(beam);
    }
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
    let max_dictionary_word_chars =
        bounded_dictionary_word_chars(options.max_dictionary_word_chars);
    let lookup = SpanLookup::new(dictionary, &chars, max_dictionary_word_chars);
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
        // Keep one unpruned same-start snapshot for all ranking helpers. The
        // convert-scoped lookup avoids repeating the same prefix scan for each
        // beam state while preserving the exact dictionary row set.
        let same_start_entries = lookup.entries_starting_at(start);
        let entries = prune_short_kanji_prefix_entries(
            dictionary,
            &chars,
            start,
            same_start_entries.clone(),
            chars.len() - start,
            max_dictionary_word_chars,
        );
        let numeric_prefix = numeric_prefix_context(&chars, start, &entries);
        // This prior depends only on the lattice start, entry, and source
        // characters. Precompute it once per entry before iterating over the
        // (up to beam-width) path states; recalculating it for every state
        // performs identical dictionary lookups without changing the score.
        let contextual_entry_bonuses = entries
            .iter()
            .map(|entry| {
                let entry_len = entry.reading.chars().count();
                let end = start + entry_len;
                if end > chars.len()
                    || chars[start..end].iter().collect::<String>() != entry.reading
                {
                    NO_SCORE
                } else {
                    contextual_entry_bonus(
                        dictionary,
                        &chars,
                        start,
                        end,
                        entry,
                        max_dictionary_word_chars,
                    )
                }
            })
            .collect::<Vec<_>>();
        // This model prior depends only on the dictionary and entry. Avoid
        // repeating its exact-reading alternative scan for every beam state.
        let model_metadata_penalties = entries
            .iter()
            .map(|entry| model_metadata_penalty(dictionary, entry))
            .collect::<Vec<_>>();
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
            // After a predicate, compact unknown may re-open even when multi-kana
            // lexical rows exist. Keep that fallback for unfinished suffixes, but
            // the span penalty below demotes it whenever a complete multi-Kanji
            // segmentation covers the same run (`柿`+`食う` over raw `かきくう`).
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
            for ((entry, contextual_entry_bonus), model_metadata_penalty) in entries
                .iter()
                .zip(contextual_entry_bonuses.iter().copied())
                .zip(model_metadata_penalties.iter().copied())
            {
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
                if !entry.user_supplied
                    && source_is_hiragana_surface(&source_chars[start..end])
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
                if !entry.user_supplied
                    && prolonged_mark_adjacent_to_span(&source_chars, &chars, start, end)
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
                            + model_metadata_penalty
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
                            + multi_kanji_compound_before_verb_penalty(
                                dictionary, &lookup, end, entry,
                            )
                            + conjugational_stem_before_verb_penalty(&lookup, end, entry)
                            + single_kanji_before_verb_bonus(
                                &lookup,
                                end,
                                entry,
                                &same_start_entries,
                            )
                            + adverbial_ku_before_content_bonus(&lookup, end, entry)
                            + stem_cutting_into_object_verb_penalty(
                                dictionary,
                                &chars,
                                start,
                                entry,
                                max_dictionary_word_chars,
                            )
                            + bare_kanji_stem_before_verb_penalty(dictionary, &lookup, end, entry)
                            + dominated_conjugational_after_object_penalty(
                                dictionary, &state, entry,
                            )
                            + bare_content_before_jodoushi_penalty(dictionary, &lookup, end, entry)
                            + ruby_identity_before_jodoushi_penalty(
                                dictionary, &lookup, end, entry,
                            )
                            + hiragana_identity_before_jodoushi_penalty(
                                dictionary, &lookup, end, entry,
                            )
                            + short_kanji_hiding_stem_before_jodoushi_penalty(
                                &lookup,
                                start,
                                entry,
                                &same_start_entries,
                            )
                            + conjugational_stem_before_jodoushi_bonus(
                                dictionary, &lookup, end, entry,
                            )
                            + precipitation_stem_after_rain_bonus(&state, entry)
                            + wave_stem_after_rain_penalty(&state, entry)
                            + food_heat_after_food_subject_bonus(&state, entry)
                            + weather_heat_after_food_subject_penalty(&state, entry)
                            + bridge_crossing_context_bonus(&chars, end, entry)
                            + thickness_object_noun_context_score(&state, &chars, end, entry)
                            + kaku_te_request_context_bonus(&chars, end, entry)
                            + edge_after_spatial_possessive_score(&state, entry)
                            + kami_before_edge_possessive_score(&chars, end, entry)
                            + kami_before_hair_cut_score(&chars, end, entry)
                            + draw_after_picture_object_score(&state, entry)
                            + scratch_after_shame_object_score(&state, entry)
                            + haji_before_scratch_verb_score(&chars, end, entry)
                            + short_head_before_person_suffix_penalty(
                                dictionary, &chars, end, entry,
                            )
                            + comma_list_kanji_overlap_bonus(&state, entry)
                            + following_yen_amount_bonus(&chars, end, entry)
                            + contextual_entry_bonus
                            + thickness_context_bonus(
                                dictionary,
                                &chars,
                                end,
                                entry,
                                max_dictionary_word_chars,
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

/// Convert with an optional verifier while preserving the dictionary result
/// as a total fallback. The convenience API uses the production-safe default
/// policy, so a context-free request is reported as `SkippedByPolicy`; callers
/// that need to supply left context or an explicit policy should use
/// [`convert_with_verifier_with_limit`] and [`VerifierConversionOptions`]. A
/// missing verifier after policy admission is reported as
/// `CapabilityUnavailable`; backend/session/evaluation failures retain their
/// corresponding `VerificationState` and never turn a non-empty caption into
/// an empty string.
pub fn convert_with_verifier(
    input: &str,
    dictionary: &AzooKeyDictionary,
    options: ConversionOptions,
    verifier: Option<&mut dyn DraftVerifier>,
    inference_config_revision: impl Into<String>,
) -> ConversionWithVerification {
    convert_with_verifier_with_limit(
        input,
        dictionary,
        options,
        verifier,
        VerifierConversionOptions::new(DEFAULT_VERIFIER_MAX_ITERATIONS, inference_config_revision),
    )
}

/// Variant of [`convert_with_verifier`] with an explicit verifier iteration
/// limit. The default options policy skips verification when left context is
/// absent or whitespace-only and returns `SkippedByPolicy`. A zero limit
/// returns the dictionary candidate with `ExhaustedWithDictionaryFallback`,
/// matching Zenzai's behavior of returning the current draft before starting
/// model evaluation. Use [`VerifierPolicy::always_verify`] only for explicit
/// offline measurement or diagnostics. If the caller's deadline expires,
/// `DeadlineExceeded` is returned with the dictionary candidate.
pub fn convert_with_verifier_with_limit(
    input: &str,
    dictionary: &AzooKeyDictionary,
    options: ConversionOptions,
    verifier: Option<&mut dyn DraftVerifier>,
    verifier_options: VerifierConversionOptions,
) -> ConversionWithVerification {
    let fallback = safe_dictionary_candidate(input, dictionary, options);
    match verifier_options.policy.decision(verifier_options.left_context.as_deref()) {
        VerifierPolicyDecision::Verify => {}
        VerifierPolicyDecision::MissingContext => {
            return fallback_with_state(fallback, VerificationState::SkippedByPolicy);
        }
        VerifierPolicyDecision::InvalidContext => {
            INVALID_LEFT_CONTEXT_WARNING.call_once(|| {
                eprintln!("warning: invalid UTF-8 left context; skipping verification")
            });
            return fallback_with_state(fallback, VerificationState::SkippedByPolicy);
        }
    }
    let Some(verifier) = verifier else {
        return fallback_with_state(fallback, VerificationState::CapabilityUnavailable);
    };
    if !verifier.capabilities().prefix_constraints {
        return fallback_with_state(fallback, VerificationState::CapabilityUnavailable);
    }
    if verifier_options.max_iterations == 0 {
        return fallback_with_state(fallback, VerificationState::ExhaustedWithDictionaryFallback);
    }

    let verification_started = Instant::now();
    if deadline_exceeded(verification_started, verifier_options.deadline) {
        return fallback_with_state(fallback, VerificationState::DeadlineExceeded);
    }

    let mut session_context = SessionContext::new(
        input.as_bytes(),
        dictionary.revision(),
        verifier_options.inference_config_revision.clone(),
    );
    session_context.left_context = verifier_options.left_context.clone();
    let mut session = match verifier.open_session(session_context) {
        Ok(session) => session,
        Err(_) => return fallback_with_state(fallback, VerificationState::Error),
    };

    let mut current_path = candidate_path_from_conversion(&fallback);
    let mut constraints = Vec::new();
    let mut selected = fallback.clone();
    let mut final_state = VerificationState::UnverifiedFallback;
    let mut lattice = None;
    let mut verification_iterations = 0;

    for attempt in 0..verifier_options.max_iterations {
        if deadline_exceeded(verification_started, verifier_options.deadline) {
            final_state = VerificationState::DeadlineExceeded;
            break;
        }
        verification_iterations += 1;
        let mut draft = Draft::new(input.as_bytes(), current_path.clone());
        draft.constraints = constraints.clone();
        let evaluation = verifier.evaluate(&mut session, &draft);
        if deadline_exceeded(verification_started, verifier_options.deadline) {
            final_state = VerificationState::DeadlineExceeded;
            break;
        }
        match evaluation {
            Err(_) => {
                final_state = VerificationState::Error;
                break;
            }
            Ok(result) => match result.state {
                VerificationState::Verified => {
                    if let Some(candidate) = conversion_candidate_from_path(&result.candidate_path)
                    {
                        selected = candidate;
                        final_state = VerificationState::Verified;
                    } else {
                        // A verifier claiming success with no text is still a
                        // degraded result. Keep the baseline and expose that
                        // fallback instead of allowing captions to disappear.
                        final_state = VerificationState::UnverifiedFallback;
                    }
                    break;
                }
                VerificationState::PrefixConstraintReturned => {
                    let Some(prefix_constraint) = result.prefix_constraint else {
                        final_state = VerificationState::Error;
                        break;
                    };
                    constraints.push(prefix_constraint);
                    let lattice_ref = lattice.get_or_insert_with(|| {
                        build_lattice(
                            dictionary,
                            &ConversionRequest {
                                input: input.to_string(),
                                left_context: options.preceding,
                                right_context: None,
                                beam_width: options.n_best.max(1),
                                n_best: options.n_best.max(1),
                                unknown_policy: UnknownPolicy::default(),
                                max_dictionary_word_chars: options.max_dictionary_word_chars,
                            },
                        )
                    });
                    let candidates = lattice_ref.search(&ConstrainedSearchRequest {
                        candidate_path: Some(result.candidate_path),
                        constraints: constraints.clone(),
                        beam_width: options.n_best.max(1),
                        n_best: 1,
                    });
                    if deadline_exceeded(verification_started, verifier_options.deadline) {
                        final_state = VerificationState::DeadlineExceeded;
                        break;
                    }
                    let Some(next_path) = candidates.into_iter().next() else {
                        final_state = VerificationState::ExhaustedWithDictionaryFallback;
                        break;
                    };
                    current_path = next_path;
                    if attempt + 1 >= verifier_options.max_iterations {
                        if let Some(candidate) = conversion_candidate_from_path(&current_path) {
                            selected = candidate;
                            final_state = VerificationState::ExhaustedWithConstrainedCandidate;
                        } else {
                            final_state = VerificationState::ExhaustedWithDictionaryFallback;
                        }
                        break;
                    }
                }
                state => {
                    // Non-success states deliberately keep the dictionary
                    // candidate. The state is retained for diagnostics rather
                    // than being swallowed.
                    final_state = state;
                    break;
                }
            },
        }
    }

    // Cleanup must not be allowed to erase a successful caption. If cleanup
    // itself fails, return the dictionary candidate and expose the failure.
    if verifier.close_session(session).is_err() && final_state == VerificationState::Verified {
        selected = fallback;
        final_state = VerificationState::Error;
    }
    ConversionWithVerification {
        candidate: selected,
        verification_state: final_state,
        verification_iterations,
    }
}

fn deadline_exceeded(started: Instant, deadline: Option<Duration>) -> bool {
    deadline.is_some_and(|limit| started.elapsed() >= limit)
}

fn safe_dictionary_candidate(
    input: &str,
    dictionary: &AzooKeyDictionary,
    options: ConversionOptions,
) -> ConversionCandidate {
    let baseline = convert_with_dictionary(input, dictionary, options)
        .into_iter()
        .find(|candidate| !candidate.text.is_empty())
        .unwrap_or_else(|| ConversionCandidate {
            text: String::new(),
            score: NO_SCORE,
            trailing: None,
        });
    if baseline.text.is_empty() && !input.is_empty() {
        ConversionCandidate { text: input.to_string(), ..baseline }
    } else {
        baseline
    }
}

fn candidate_path_from_conversion(candidate: &ConversionCandidate) -> CandidatePath {
    CandidatePath {
        edge_handles: Vec::new(),
        text: candidate.text.clone(),
        score: candidate.score,
        trailing: candidate.trailing,
    }
}

fn conversion_candidate_from_path(path: &CandidatePath) -> Option<ConversionCandidate> {
    (!path.text.is_empty()).then(|| ConversionCandidate {
        text: path.text.clone(),
        score: path.score,
        trailing: path.trailing,
    })
}

fn fallback_with_state(
    candidate: ConversionCandidate,
    verification_state: VerificationState,
) -> ConversionWithVerification {
    ConversionWithVerification { candidate, verification_state, verification_iterations: 0 }
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
    // A multi-mora single-Kanji row with only DEFAULT_MID is often a sparse
    // morphology leftover (`角` for `かき`). When the same reading has a
    // non-default MID Kanji alternative (`柿` mid=4), soft-demote the fallback
    // so object+verb paths can compete without dropping the row from n-best.
    if entry.mid == DEFAULT_MID
        && entry.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
        && entry.surface.chars().count() == 1
        && entry.surface.chars().all(is_kanji)
        && alternatives.iter().any(|candidate| {
            candidate.mid != DEFAULT_MID
                && contains_kanji(&candidate.surface)
                && candidate.surface != entry.surface
        })
    {
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

/// Soft-demote multi-Kanji compounds when a single-Kanji homophone exists and
/// the next edge is a conjugational verb. Dictionary value alone often prefers
/// written compounds (`下記`) over spoken single-Kanji objects (`柿`) before
/// colloquial verbs (`食う`); this is a bounded morphology prior, not a phrase map.
fn multi_kanji_compound_before_verb_penalty(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    let kanji_count = entry.surface.chars().filter(|character| is_kanji(*character)).count();
    if kanji_count < 2
        || entry.surface == entry.reading
        || is_particle_reading(&entry.reading)
        || is_conjugational_content_cid(entry.lcid)
    {
        return NO_SCORE;
    }
    if !following_edge_is_conjugational_verb(lookup, end) {
        return NO_SCORE;
    }
    let has_single_kanji_alternative =
        dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
            candidate.surface != entry.surface
                && candidate.surface.chars().count() == 1
                && candidate.surface.chars().all(is_kanji)
        });
    if has_single_kanji_alternative {
        MULTI_KANJI_COMPOUND_BEFORE_VERB_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a conjugational stem immediately followed by another conjugational
/// verb when the stem is not already a て/で connective form. Noun + verb paths
/// are unaffected; caption-style serial verbs without て stay available in n-best.
fn conjugational_stem_before_verb_penalty(
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if !is_conjugational_content_cid(entry.lcid)
        || !contains_kanji(&entry.surface)
        || entry.surface.ends_with('て')
        || entry.surface.ends_with('で')
    {
        return NO_SCORE;
    }
    if following_edge_is_conjugational_verb(lookup, end) {
        CONJUGATIONAL_STEM_BEFORE_VERB_PENALTY
    } else {
        NO_SCORE
    }
}

/// Prefer a single-Kanji object reading when the next edge is a conjugational
/// verb. Spoken captions often realize object+verb as short Kanji + verb while
/// unigram frequency prefers written compounds or leaves a kana tail.
fn single_kanji_before_verb_bonus(
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
    same_start_entries: &[DictionaryEntry],
) -> f32 {
    if entry.surface.chars().count() != 1
        || !entry.surface.chars().all(is_kanji)
        || is_conjugational_content_cid(entry.lcid)
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    // Do not boost a one-Kanji head when a longer same-start converted word
    // extends that surface (`晴` under `晴れ` before `ます`).
    let entry_len = entry.reading.chars().count();
    let has_longer_extension = same_start_entries.iter().any(|candidate| {
        let candidate_len = candidate.reading.chars().count();
        candidate_len > entry_len
            && candidate.reading.starts_with(&entry.reading)
            && candidate.surface.starts_with(&entry.surface)
            && contains_kanji(&candidate.surface)
            && candidate.surface.chars().any(is_hiragana)
    });
    if has_longer_extension {
        return NO_SCORE;
    }
    if following_edge_is_conjugational_verb(lookup, end) {
        SINGLE_KANJI_BEFORE_VERB_BONUS
    } else {
        NO_SCORE
    }
}

/// Soft-demote a conjugational spelling that is value-dominated by another
/// conjugational surface for the same reading, but only after a content object.
/// Prefers `食う` over `喰う` after `柿` without demoting clause-initial `晴れ`.
fn dominated_conjugational_after_object_penalty(
    dictionary: &AzooKeyDictionary,
    state: &PathState,
    entry: &DictionaryEntry,
) -> f32 {
    if !is_conjugational_content_cid(entry.lcid) || !contains_kanji(&entry.surface) {
        return NO_SCORE;
    }
    let Some(former) = state.last.as_ref() else {
        return NO_SCORE;
    };
    if !contains_kanji(&former.surface)
        || is_conjugational_content_cid(former.lcid)
        || is_particle_reading(&former.reading)
        || former.surface == former.reading
    {
        return NO_SCORE;
    }
    let dominated =
        dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
            candidate.surface != entry.surface
                && is_conjugational_content_cid(candidate.lcid)
                && contains_kanji(&candidate.surface)
                && candidate.value > entry.value
        });
    if dominated {
        DOMINATED_CONJUGATIONAL_AFTER_OBJECT_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a bare single-Kanji spelling when the same reading has a
/// conjugational stem alternative (`書き` for `書`) and another verb follows.
/// Prevents incomplete stems from acting as objects before colloquial verbs.
fn bare_kanji_stem_before_verb_penalty(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if entry.surface.chars().count() != 1
        || !entry.surface.chars().all(is_kanji)
        || is_conjugational_content_cid(entry.lcid)
    {
        return NO_SCORE;
    }
    if !following_edge_is_conjugational_verb(lookup, end) {
        return NO_SCORE;
    }
    // Require the conjugational alternative to extend this exact Kanji
    // (`書` → `書き`), not an unrelated stem for the same reading (`柿` vs `書き`).
    let has_conjugational_stem_alternative =
        dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
            candidate.surface != entry.surface
                && candidate.surface.starts_with(&entry.surface)
                && candidate.surface.chars().count() > entry.surface.chars().count()
                && is_conjugational_content_cid(candidate.lcid)
                && candidate.surface.chars().any(is_hiragana)
        });
    if has_conjugational_stem_alternative {
        BARE_KANJI_STEM_BEFORE_VERB_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a multi-mora stem whose reading ends inside a conjugational verb
/// that attaches to a shorter content object at the same start (`角く` cutting
/// into `食う` after `柿`). Keeps the stem in n-best without burying object+verb.
///
/// Complete `…い` adjectives (`暑い`) are excluded: a later mora can still begin
/// an unrelated conjugational reading (`言ひ` under `あついひ`) without meaning
/// the adjective itself is an incomplete stem.
fn stem_cutting_into_object_verb_penalty(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    entry: &DictionaryEntry,
    max_dictionary_word_chars: usize,
) -> f32 {
    let len = entry.reading.chars().count();
    if len < MIN_SHADOWING_LEXICAL_CHARS
        || !contains_kanji(&entry.surface)
        || entry.surface == entry.reading
        || is_particle_reading(&entry.reading)
        || entry.surface.ends_with('い')
    {
        return NO_SCORE;
    }
    // Stem-like surfaces only (`角く` / `描き`), not closed nouns.
    if !(entry.surface.ends_with('く')
        || entry.surface.ends_with('き')
        || entry.surface.ends_with('ぎ')
        || entry.surface.ends_with('み')
        || entry.surface.ends_with('り')
        || entry.surface.ends_with('し'))
    {
        return NO_SCORE;
    }
    for prefix_len in 1..len {
        if prefix_len > 2 {
            break;
        }
        let prefix: String = entry.reading.chars().take(prefix_len).collect();
        let has_short_object =
            dictionary.lookup_exact(&prefix).unwrap_or_default().iter().any(|candidate| {
                contains_kanji(&candidate.surface)
                    && candidate.surface != candidate.reading
                    && !is_conjugational_content_cid(candidate.lcid)
                    && !is_particle_reading(&candidate.reading)
                    && candidate.surface.chars().filter(|character| is_kanji(*character)).count()
                        <= 2
            });
        if !has_short_object {
            continue;
        }
        let verb_lens = conjugational_verb_reading_lengths_starting_at(
            dictionary,
            chars,
            start + prefix_len,
            max_dictionary_word_chars,
        );
        // Verb must continue past this stem and share the stem's trailing mora
        // as its first mora (`く` of `角く` inside `くう`).
        let stem_tail = entry.reading.chars().nth(prefix_len);
        if verb_lens.iter().any(|verb_len| *verb_len > len - prefix_len)
            && stem_tail.is_some_and(|tail| chars.get(start + prefix_len).copied() == Some(tail))
        {
            return STEM_CUTTING_INTO_OBJECT_VERB_PENALTY;
        }
    }
    NO_SCORE
}

/// Prefer mixed-script adverbial `…く` rows (`良く`) over bare Kanji homophones
/// when the following lattice has content. Beginning/CID costs alone often make
/// `翌` win before an object+verb continuation.
fn adverbial_ku_before_content_bonus(
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if !entry.surface.ends_with('く')
        || !contains_kanji(&entry.surface)
        || entry.surface.chars().all(is_kanji)
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    let following = lookup.chars.get(end..).unwrap_or_default();
    if following.is_empty() {
        return NO_SCORE;
    }
    let has_following_content = lookup.entries_starting_at(end).iter().any(|candidate| {
        candidate.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
            && contains_kanji(&candidate.surface)
            && !is_particle_reading(&candidate.reading)
    });
    if has_following_content {
        ADVERBIAL_KU_BEFORE_CONTENT_BONUS
    } else {
        NO_SCORE
    }
}

fn following_edge_is_conjugational_verb(lookup: &SpanLookup<'_>, end: usize) -> bool {
    if end >= lookup.chars.len() {
        return false;
    }
    lookup.entries_starting_at(end).iter().any(|candidate| {
        is_conjugational_content_cid(candidate.lcid)
            && contains_kanji(&candidate.surface)
            && candidate.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
    })
}

/// True when the next lattice edge can be a jodoushi identity auxiliary such as
/// `ます` / `ました` / `です`. Kanji homophones for the same reading (`鱒`) are
/// ignored so only grammatical continuations trigger the prior.
fn following_edge_is_jodoushi_auxiliary(lookup: &SpanLookup<'_>, end: usize) -> bool {
    if end >= lookup.chars.len() {
        return false;
    }
    lookup.entries_starting_at(end).iter().any(|candidate| {
        candidate.surface == candidate.reading
            && (is_jodoushi_cid(candidate.lcid) || is_jodoushi_cid(candidate.rcid))
    })
}

/// Soft-demote non-conjugational Kanji when a conjugational stem alternative
/// exists for the same reading and the next edge is a jodoushi identity
/// auxiliary. Captions almost always attach `ます` to a verb/adjective stem
/// (`降り`+`ます`), not to a bare noun/adjective root (`古`+`ます`).
fn bare_content_before_jodoushi_penalty(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    // Gate on conjugational CID bands rather than system-dictionary presence so
    // TSV fixtures with real morphology CIDs can unit-test the prior. Builtin
    // DEFAULT_CID rows never look conjugational, so they stay score-driven.
    if is_conjugational_content_cid(entry.lcid)
        || !contains_kanji(&entry.surface)
        || entry.surface == entry.reading
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    if !following_edge_is_jodoushi_auxiliary(lookup, end) {
        return NO_SCORE;
    }
    if has_conjugational_stem_alternative(dictionary, entry) {
        BARE_CONTENT_BEFORE_JODOUSHI_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote raw Katakana ruby-id rows before a jodoushi identity when a
/// conjugational Kanji stem exists for the same reading (`フリ` under `降り`).
fn ruby_identity_before_jodoushi_penalty(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if !entry.raw_ruby_identity || is_particle_reading(&entry.reading) {
        return NO_SCORE;
    }
    if !following_edge_is_jodoushi_auxiliary(lookup, end) {
        return NO_SCORE;
    }
    if has_conjugational_stem_alternative(dictionary, entry) {
        RUBY_IDENTITY_BEFORE_JODOUSHI_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a hiragana identity before a jodoushi auxiliary when a
/// conjugational Kanji stem exists for the same reading. Captions attach
/// `ます` to verb stems (`飲み`), not to kana identities (`のみ`). Jodoushi-band
/// identities (`あり`) keep their morphology-driven ranking.
fn hiragana_identity_before_jodoushi_penalty(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if entry.surface != entry.reading
        || entry.reading.chars().count() < MIN_LEXICAL_ENTRY_CHARS
        || is_jodoushi_cid(entry.lcid)
        || is_jodoushi_cid(entry.rcid)
    {
        return NO_SCORE;
    }
    if !following_edge_is_jodoushi_auxiliary(lookup, end) {
        return NO_SCORE;
    }
    if has_conjugational_stem_alternative(dictionary, entry) {
        HIRAGANA_IDENTITY_BEFORE_JODOUSHI_PENALTY
    } else {
        NO_SCORE
    }
}

/// Soft-demote a one-mora non-conjugational Kanji when a longer conjugational
/// stem starts at the same offset and leaves a jodoushi identity remainder
/// (`不` under `降り`+`そうです`). Noun compounds such as `理想` otherwise
/// absorb the stem+auxiliary reading into an unrelated word.
fn short_kanji_hiding_stem_before_jodoushi_penalty(
    lookup: &SpanLookup<'_>,
    start: usize,
    entry: &DictionaryEntry,
    same_start_entries: &[DictionaryEntry],
) -> f32 {
    let len = entry.reading.chars().count();
    if len != 1
        || !contains_kanji(&entry.surface)
        || entry.surface == entry.reading
        || is_conjugational_content_cid(entry.lcid)
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    let has_hiding_stem = same_start_entries.iter().any(|candidate| {
        let stem_len = candidate.reading.chars().count();
        stem_len > len
            && is_conjugational_content_cid(candidate.lcid)
            && contains_kanji(&candidate.surface)
            && candidate.surface.chars().any(is_hiragana)
            && following_edge_is_jodoushi_auxiliary(lookup, start + stem_len)
    });
    if has_hiding_stem {
        SHORT_KANJI_HIDING_STEM_BEFORE_JODOUSHI_PENALTY
    } else {
        NO_SCORE
    }
}

fn path_ends_with_precipitation_noun(state: &PathState) -> bool {
    let prefix = state.text.as_str();
    prefix.ends_with('雨')
        || prefix.ends_with("雨が")
        || prefix.ends_with("雨は")
        || prefix.ends_with('雪')
        || prefix.ends_with("雪が")
        || prefix.ends_with("雪は")
}

/// Soft-boost `降り`/`降る`/`降っ` after a weather noun so evidentials keep
/// precipitation orthography (`雨が降りそうです` / `雪が降りそうです`).
fn precipitation_stem_after_rain_bonus(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if !path_ends_with_precipitation_noun(state) {
        return NO_SCORE;
    }
    if matches!(entry.surface.as_str(), "降り" | "降る" | "降っ") {
        PRECIPITATION_STEM_AFTER_RAIN_BONUS
    } else {
        NO_SCORE
    }
}

/// Soft-demote `振り`/`振る`/`振っ` after a weather noun. Without this, unigram
/// value can still rank the wave/shake stem over precipitation.
fn wave_stem_after_rain_penalty(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if !path_ends_with_precipitation_noun(state) {
        return NO_SCORE;
    }
    if matches!(entry.surface.as_str(), "振り" | "振る" | "振っ") {
        WAVE_STEM_AFTER_RAIN_PENALTY
    } else {
        NO_SCORE
    }
}

fn path_ends_with_food_subject(state: &PathState) -> bool {
    let prefix = state.text.as_str();
    prefix.ends_with("料理")
        || prefix.ends_with("料理が")
        || prefix.ends_with("料理は")
        || prefix.ends_with("スープ")
        || prefix.ends_with("スープが")
        || prefix.ends_with("スープは")
}

/// Soft-boost `熱い` after a food subject so cooling/eating captions keep
/// temperature, not weather (`料理が熱いのでさます`).
fn food_heat_after_food_subject_bonus(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if entry.surface == "熱い" && path_ends_with_food_subject(state) {
        FOOD_HEAT_AFTER_FOOD_SUBJECT_BONUS
    } else {
        NO_SCORE
    }
}

/// Soft-demote weather `暑い` after a food subject.
fn weather_heat_after_food_subject_penalty(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if entry.surface == "暑い" && path_ends_with_food_subject(state) {
        WEATHER_HEAT_AFTER_FOOD_SUBJECT_PENALTY
    } else {
        NO_SCORE
    }
}

fn remaining_reading(chars: &[char], end: usize) -> String {
    chars.get(end..).unwrap_or_default().iter().collect()
}

fn remaining_has_object_noun(remaining: &str, noun: &str) -> bool {
    remaining == noun
        || remaining.strip_prefix(noun).is_some_and(|rest| {
            rest.is_empty() || rest.starts_with(['が', 'は', 'を', 'の', 'で', 'に', 'も'])
        })
}

fn remaining_has_crossing_cue(remaining: &str) -> bool {
    remaining.starts_with("をわた") || remaining.starts_with("をとお")
}

fn remaining_has_edge_possessive(remaining: &str) -> bool {
    remaining.starts_with("のはじ")
}

fn remaining_has_hair_cut_verb(remaining: &str) -> bool {
    remaining.starts_with("をきる")
        || remaining.starts_with("をきって")
        || remaining.starts_with("をきった")
}

fn remaining_has_thickness_object_noun(remaining: &str) -> bool {
    remaining_has_object_noun(remaining, "かべ")
        || remaining_has_object_noun(remaining, "ほん")
        || remaining_has_object_noun(remaining, "こおり")
}

fn path_ends_with_particle_subject(prefix: &str, noun: &str) -> bool {
    ["が", "は", "も"].iter().any(|particle| prefix.ends_with(&format!("{noun}{particle}")))
}

/// True when the converted prefix is a thickness-bearing subject
/// (`壁が` / standalone `本が` / `氷が`). `日本が` must not match `本が`.
fn path_ends_with_thickness_object(state: &PathState) -> bool {
    let prefix = state.text.as_str();
    if path_ends_with_particle_subject(prefix, "壁")
        || path_ends_with_particle_subject(prefix, "氷")
    {
        return true;
    }
    for particle in ["が", "は", "も"] {
        let tail = format!("本{particle}");
        if !prefix.ends_with(&tail) {
            continue;
        }
        let before = prefix.strip_suffix(&tail).unwrap_or("");
        // Standalone book (`本が` / `この本が`), not `日本が` or numeral `2本が`.
        if before
            .chars()
            .last()
            .is_none_or(|character| is_hiragana(character) || is_katakana(&character))
        {
            return true;
        }
    }
    false
}

fn remaining_has_request_or_try_aux(remaining: &str) -> bool {
    remaining.starts_with("ください")
        || remaining.starts_with("下さい")
        || remaining.starts_with("みます")
}

/// Soft-boost `橋` when leftover speech is a crossing verb. Isolated `はし`
/// stays chopsticks-capable; `はしでたべる` is unchanged.
fn bridge_crossing_context_bonus(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    if entry.reading != "はし" || entry.surface != "橋" {
        return NO_SCORE;
    }
    if remaining_has_crossing_cue(&remaining_reading(chars, end)) {
        BRIDGE_CROSSING_CONTEXT_BONUS
    } else {
        NO_SCORE
    }
}

/// Soft-prefer thickness `厚い` before a physical object noun, or after a
/// thickness subject (`壁が厚い`). Weather `暑い` and food `熱い` stay in
/// n-best and keep their other contexts (`日本が暑い`, `スープが熱い`).
fn thickness_object_noun_context_score(
    state: &PathState,
    chars: &[char],
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if entry.reading != "あつい" {
        return NO_SCORE;
    }
    let attributive = remaining_has_thickness_object_noun(&remaining_reading(chars, end));
    let predicative = path_ends_with_thickness_object(state);
    if !attributive && !predicative {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "厚い" => THICKNESS_OBJECT_NOUN_BONUS,
        "暑い" | "熱い" => THICKNESS_OBJECT_NOUN_HEAT_PENALTY,
        _ => NO_SCORE,
    }
}

/// Soft-boost te-form `書いて` before `ください` / `みます`. Isolated `かいて`
/// already ranks `書いて`; the continuation otherwise prefers `描いて`.
fn kaku_te_request_context_bonus(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    if entry.surface != "書いて" {
        return NO_SCORE;
    }
    if remaining_has_request_or_try_aux(&remaining_reading(chars, end)) {
        KAKU_TE_REQUEST_CONTEXT_BONUS
    } else {
        NO_SCORE
    }
}

/// Physical/spatial nouns whose `の`+`はじ` continuation is an edge, not shame.
const SPATIAL_EDGE_NOUNS: &[&str] =
    &["道", "橋", "机", "壁", "駅", "ページ", "箱", "板", "窓", "床", "角", "線", "紙", "髪"];

fn path_ends_with_spatial_possessive(state: &PathState) -> bool {
    let prefix = state.text.as_str();
    if !prefix.ends_with('の') {
        return false;
    }
    if SPATIAL_EDGE_NOUNS.iter().any(|noun| prefix.ends_with(&format!("{noun}の"))) {
        return true;
    }
    if !prefix.ends_with("本の") {
        return false;
    }
    let before = prefix.strip_suffix("本の").unwrap_or("");
    // Standalone book (`本の` / `この本の`), not `日本の` or numeral `2本の`.
    before.chars().last().is_none_or(|character| is_hiragana(character) || is_katakana(&character))
}

/// Soft-prefer edge `端` after a spatial/physical noun + `の`. Shame `恥`
/// stays top-1 for isolated `はじ` and animate possessives (`私の恥`).
fn edge_after_spatial_possessive_score(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if entry.reading != "はじ" || !path_ends_with_spatial_possessive(state) {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "端" => EDGE_AFTER_SPATIAL_NOUN_BONUS,
        "恥" | "恥じ" => SHAME_AFTER_SPATIAL_NOUN_PENALTY,
        _ => NO_SCORE,
    }
}

/// Soft-prefer paper `紙` when leftover speech is the edge possessive `のはじ`.
/// Isolated `かみ`, `かみさま`, and `かみのけ` stay on their own priors.
fn kami_before_edge_possessive_score(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    if entry.reading != "かみ" || !remaining_has_edge_possessive(&remaining_reading(chars, end)) {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "紙" => PAPER_BEFORE_EDGE_POSSESSIVE_BONUS,
        "神" => GOD_BEFORE_EDGE_POSSESSIVE_PENALTY,
        _ => NO_SCORE,
    }
}

/// Soft-prefer hair `髪` when leftover speech is the cut verb `をきる`.
/// Isolated `かみ`, `かみさま`, and `かみのはじ` stay on their own priors.
fn kami_before_hair_cut_score(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    if entry.reading != "かみ" || !remaining_has_hair_cut_verb(&remaining_reading(chars, end)) {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "髪" => HAIR_BEFORE_CUT_VERB_BONUS,
        "神" => GOD_BEFORE_CUT_VERB_PENALTY,
        _ => NO_SCORE,
    }
}

fn picture_object_verb_context(state: &PathState, entry: &DictionaryEntry) -> bool {
    let prefix = state.text.as_str();
    if prefix.ends_with("絵を") || prefix.ends_with("画を") {
        return true;
    }
    if !(prefix.ends_with('絵') || prefix.ends_with('画')) {
        return false;
    }
    entry.reading.starts_with("をかい")
        || entry.reading.starts_with("をかく")
        || entry.surface.starts_with("を描")
        || entry.surface.starts_with("を書")
}

/// Soft-prefer draw `描いて` after a picture object. Write `書いて` stays
/// top-1 for isolated `かいて`, `もじをかいて`, and `かいてください`.
fn draw_after_picture_object_score(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if !picture_object_verb_context(state, entry) {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "描いて" | "描く" | "を描いて" | "を描く" => DRAW_AFTER_PICTURE_OBJECT_BONUS,
        "書いて" | "書く" | "を書いて" | "を書く" => WRITE_AFTER_PICTURE_OBJECT_PENALTY,
        _ => NO_SCORE,
    }
}

fn shame_object_verb_context(state: &PathState, entry: &DictionaryEntry) -> bool {
    let prefix = state.text.as_str();
    if prefix.ends_with("恥を") {
        return true;
    }
    if !prefix.ends_with('恥') {
        return false;
    }
    entry.reading.starts_with("をかく")
        || entry.surface.starts_with("を掻")
        || entry.surface.starts_with("を書")
        || entry.surface.starts_with("を描")
}

/// Soft-prefer scratch `掻く` after shame `恥を`. Isolated `かく` and
/// `てをかく` stay score-driven.
fn scratch_after_shame_object_score(state: &PathState, entry: &DictionaryEntry) -> f32 {
    if !shame_object_verb_context(state, entry) {
        return NO_SCORE;
    }
    let surface = entry.surface.as_str();
    if surface == "掻く" || surface.ends_with("掻く") {
        return SCRATCH_AFTER_SHAME_OBJECT_BONUS;
    }
    if surface == "各"
        || surface.ends_with("書く")
        || surface.ends_with("描く")
        || surface.ends_with("を各")
    {
        return WRITE_AFTER_SHAME_OBJECT_PENALTY;
    }
    NO_SCORE
}

fn remaining_has_scratch_verb(remaining: &str) -> bool {
    remaining.starts_with("をかく")
}

/// Soft-prefer shame `恥` when leftover speech is the idiom verb `をかく`.
/// Isolated `はじ` and spatial `の`+`はじ` stay on their own priors.
fn haji_before_scratch_verb_score(chars: &[char], end: usize, entry: &DictionaryEntry) -> f32 {
    if entry.reading != "はじ" || !remaining_has_scratch_verb(&remaining_reading(chars, end)) {
        return NO_SCORE;
    }
    match entry.surface.as_str() {
        "恥" => SCRATCH_AFTER_SHAME_OBJECT_BONUS,
        "端" => WRITE_AFTER_SHAME_OBJECT_PENALTY,
        _ => NO_SCORE,
    }
}

/// Soft-boost a conjugational stem with an inflectional kana tail immediately
/// before a jodoushi identity auxiliary when non-stem alternatives exist.
fn conjugational_stem_before_jodoushi_bonus(
    dictionary: &AzooKeyDictionary,
    lookup: &SpanLookup<'_>,
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if !is_conjugational_content_cid(entry.lcid)
        || !contains_kanji(&entry.surface)
        || !entry.surface.chars().any(is_hiragana)
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    if !following_edge_is_jodoushi_auxiliary(lookup, end) {
        return NO_SCORE;
    }
    // Only boost when a non-stem alternative would otherwise compete
    // (bare Kanji root or raw ruby for the same reading).
    let has_competing_non_stem =
        dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
            candidate.surface != entry.surface
                && (candidate.raw_ruby_identity
                    || (contains_kanji(&candidate.surface)
                        && !is_conjugational_content_cid(candidate.lcid)))
        });
    if has_competing_non_stem {
        CONJUGATIONAL_STEM_BEFORE_JODOUSHI_BONUS
    } else {
        NO_SCORE
    }
}

/// True when the same reading has a conjugational Kanji stem that keeps an
/// inflectional kana tail (`降り` / `行き`). Bare single-Kanji conjugational
/// residues are ignored so the prior stays stem-vs-root rather than a surface map.
fn has_conjugational_stem_alternative(
    dictionary: &AzooKeyDictionary,
    entry: &DictionaryEntry,
) -> bool {
    dictionary.lookup_exact(&entry.reading).unwrap_or_default().iter().any(|candidate| {
        candidate.surface != entry.surface
            && is_conjugational_content_cid(candidate.lcid)
            && contains_kanji(&candidate.surface)
            && candidate.surface.chars().any(is_hiragana)
    })
}

/// Soft-demote a short converted head when the remaining reading begins with a
/// closed-class personification suffix and a longer converted dictionary row
/// already covers head+suffix. Stops rare short spellings (`妾`) plus a suffix
/// identity from outranking the full-span form (`私たち`) via DEFAULT CID costs.
fn short_head_before_person_suffix_penalty(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    end: usize,
    entry: &DictionaryEntry,
) -> f32 {
    if !contains_kanji(&entry.surface)
        || entry.surface == entry.reading
        || is_particle_reading(&entry.reading)
    {
        return NO_SCORE;
    }
    let remaining: String = chars.get(end..).unwrap_or_default().iter().collect();
    if remaining.is_empty() {
        return NO_SCORE;
    }
    let Some(suffix) =
        HONORIFIC_READING_SUFFIXES.iter().copied().find(|suffix| remaining.starts_with(suffix))
    else {
        return NO_SCORE;
    };
    let combined = format!("{}{}", entry.reading, suffix);
    // Only fire when the dictionary already has a converted full-span row for
    // head+suffix. Without that row, short-head+suffix segmentation is legitimate.
    let has_full_span_converted =
        dictionary.lookup_exact(&combined).unwrap_or_default().iter().any(|candidate| {
            contains_kanji(&candidate.surface)
                && candidate.surface != candidate.reading
                && candidate.reading.chars().count() > entry.reading.chars().count()
        });
    if has_full_span_converted {
        SHORT_HEAD_BEFORE_PERSON_SUFFIX_PENALTY
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

/// Add a small, lexical-context prior for thickness adjectives.  This is
/// intentionally based on surface cue classes found in the following clause,
/// rather than on a reading/surface phrase table: a Kanji adjective containing
/// `厚` gains a bounded prior when the clause contains a thinness cue, with a
/// small extra amount when a slicing action is also present.
fn thickness_context_bonus(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    end: usize,
    entry: &DictionaryEntry,
    max_dictionary_word_chars: usize,
) -> f32 {
    if !entry.surface.ends_with('い') || !entry.surface.chars().any(|character| character == '厚')
    {
        return NO_SCORE;
    }
    if !following_clause_has_surface_cue(
        dictionary,
        chars,
        end,
        max_dictionary_word_chars,
        &['薄', '細'],
    ) {
        return NO_SCORE;
    }
    let slice_bonus = if following_clause_has_surface_cue(
        dictionary,
        chars,
        end,
        max_dictionary_word_chars,
        &['切', '刻', '削'],
    ) {
        THICKNESS_SLICE_CONTEXT_BONUS
    } else {
        NO_SCORE
    };
    THICKNESS_CONTEXT_BONUS + slice_bonus
}

/// Look only within the current punctuation-delimited clause and a short
/// bounded lookahead.  Dictionary surfaces, not raw phrase strings, provide
/// the semantic cue so this remains useful for other thickness/slicing
/// sentences and custom dictionary rows.
fn following_clause_has_surface_cue(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
    cues: &[char],
) -> bool {
    let clause_end = chars
        .get(start..)
        .and_then(|rest| rest.iter().position(|character| is_boundary(*character)))
        .map_or(chars.len(), |offset| start + offset);
    let scan_end = clause_end.min(start + CONTEXT_LOOKAHEAD_CHARS);
    for candidate_start in start..scan_end {
        let entries = dictionary
            .entries_starting_at(chars, candidate_start, max_dictionary_word_chars)
            .unwrap_or_default();
        if entries.iter().any(|candidate| {
            let candidate_end = candidate_start + candidate.reading.chars().count();
            candidate_end <= clause_end
                && candidate.surface.chars().any(|character| cues.contains(&character))
        }) {
            return true;
        }
    }
    false
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
    // available as alternatives. Multi-Kanji segmentations of the same span
    // win via unknown_span_multi_kanji_segmentation_penalty, not hard removal.
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
/// multi-Kanji segmentation (`あついひ` → `暑い`+`日`, `かきくう` → `柿`+`食う`).
/// The span stays in n-best for unfinished suffixes; lexical paths can outrank it.
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
        // Stack the identity-segmentation prior with a stronger unknown demotion
        // so predicate-final compact kana cannot bury complete object+verb paths.
        IDENTITY_SEGMENTATION_PENALTY + UNKNOWN_MULTI_KANJI_SEGMENTATION_PENALTY
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
    let thickness_bonus =
        contextual_thickness_bonus(dictionary, chars, end, entry, max_dictionary_word_chars);
    if !following_content && !preceding_content && !adjective_like && thickness_bonus == NO_SCORE {
        return NO_SCORE;
    }
    let desired_rank = usize::from(following_content || preceding_content);
    let rank_bonus = if rank == desired_rank { CONTEXTUAL_ENTRY_BONUS } else { NO_SCORE };
    rank_bonus + thickness_bonus
}

/// Add a small semantic prior when a bounded downstream clause contains the
/// opposite thickness axis. This helps the thickness-then-slicing construction
/// without tying the score to a subject: the current candidate and a
/// dictionary-backed lexical cue must form the generic thickness contrast.
fn contextual_thickness_bonus(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    end: usize,
    entry: &DictionaryEntry,
    max_dictionary_word_chars: usize,
) -> f32 {
    let Some(current_axis) = thickness_axis(&entry.surface) else {
        return NO_SCORE;
    };
    let after = chars.get(end..).unwrap_or_default();
    let Some(connector) = dictionary
        .entries_starting_at(after, 0, max_dictionary_word_chars)
        .unwrap_or_default()
        .into_iter()
        .filter(is_grammatical_continuation_entry)
        .max_by_key(|candidate| candidate.reading.chars().count())
    else {
        return NO_SCORE;
    };
    let connector_len = connector.reading.chars().count();
    if connector_len == 0 || connector_len >= after.len() {
        return NO_SCORE;
    }
    let context_start = end + connector_len;
    let context_end = (context_start + CONTEXT_LOOKAHEAD_CHARS).min(chars.len());
    for offset in context_start..context_end {
        if is_boundary(chars[offset]) {
            break;
        }
        let suffix = &chars[offset..];
        let Ok(entries) = dictionary.entries_starting_at(suffix, 0, max_dictionary_word_chars)
        else {
            continue;
        };
        if entries.iter().any(|candidate| {
            let candidate_len = candidate.reading.chars().count();
            candidate_len > 0
                && offset + candidate_len <= context_end
                && contains_kanji(&candidate.surface)
                && thickness_axis(&candidate.surface).is_some_and(|axis| axis != current_axis)
        }) {
            return THICKNESS_CONTEXT_BONUS;
        }
    }
    NO_SCORE
}

fn thickness_axis(surface: &str) -> Option<bool> {
    if surface.chars().any(|character| character == '厚') {
        Some(true)
    } else if surface.chars().any(|character| character == '薄') {
        Some(false)
    } else {
        None
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
        user_supplied: false,
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
    // Object+verb paths (`柿`+`食う`) must survive when a longer stem only
    // eats the first mora of the following verb (`角く` under `かきくう…`).
    let following_verb_lens = conjugational_verb_reading_lengths_starting_at(
        dictionary,
        chars,
        start + len,
        max_dictionary_word_chars,
    );
    entries.iter().any(|other| {
        let other_len = other.reading.chars().count();
        // A longer row that leaves a single dangling mora (`晴れ間` + `す`
        // under `はれます`) should not hide the shorter complete word
        // (`晴れ` + `ます`).
        let leftover = remaining_chars.saturating_sub(other_len);
        let reading_leftover = other.reading.chars().skip(len).collect::<String>();
        // Longer row ends strictly inside a conjugational verb that attaches
        // to this short content word → keep the short word for object+verb.
        let cuts_into_following_verb = following_verb_lens
            .iter()
            .any(|verb_len| other_len > len && other_len < len + *verb_len);
        // A longer row that ends immediately before a small kana (`空気` under
        // `くうきゃく`, leaving `ゃ…`) cannot start a legal next lattice token.
        // Keep the shorter verb/noun so `食う`+`客` remains available.
        let leftover_starts_with_small_kana =
            chars.get(start + other_len).is_some_and(|character| is_small_hiragana(*character));
        other_len >= min_other_len
            && other_len > len
            && other_len <= remaining_chars
            && leftover != 1
            && !leftover_starts_with_small_kana
            && !cuts_into_following_verb
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

fn conjugational_verb_reading_lengths_starting_at(
    dictionary: &AzooKeyDictionary,
    chars: &[char],
    start: usize,
    max_dictionary_word_chars: usize,
) -> Vec<usize> {
    if start >= chars.len() {
        return Vec::new();
    }
    dictionary
        .entries_starting_at(chars, start, max_dictionary_word_chars)
        .unwrap_or_default()
        .into_iter()
        .filter(|candidate| {
            is_conjugational_content_cid(candidate.lcid)
                && contains_kanji(&candidate.surface)
                && candidate.reading.chars().count() >= MIN_LEXICAL_ENTRY_CHARS
        })
        .map(|candidate| candidate.reading.chars().count())
        .collect()
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
        build_lattice, convert_kana_to_kanji, convert_kana_to_kanji_with_paths,
        convert_with_dictionary, convert_with_verifier, convert_with_verifier_with_limit,
        ConstrainedSearchRequest, ConversionOptions, ConversionRequest, EdgeOrigin, UnknownPolicy,
        Utf8BytePrefixConstraint, VerifierConversionOptions, VerifierPolicy,
    };
    use crate::dictionary::test_system_dictionary_path;
    use crate::{
        AzooKeyDictionary, CandidatePath, DictionaryEntry, DictionaryPaths, Draft, DraftVerifier,
        SessionContext, VerificationCacheKey, VerificationResult, VerificationState,
        VerifierCapabilities, VerifierError, VerifierSession,
    };
    use std::fs;
    use std::time::Duration;

    #[derive(Debug, Clone, Copy)]
    enum FallbackVerifierMode {
        OpenError,
        EvaluateError,
        EvaluateStateError,
        Exhausted,
        PrefixConstraint,
        UnverifiedFallback,
        VerifiedEmpty,
        NoPrefixCapability,
    }

    struct FallbackVerifier {
        mode: FallbackVerifierMode,
    }

    impl DraftVerifier for FallbackVerifier {
        fn capabilities(&self) -> VerifierCapabilities {
            if matches!(self.mode, FallbackVerifierMode::NoPrefixCapability) {
                return VerifierCapabilities::default();
            }
            VerifierCapabilities {
                prefix_constraints: true,
                max_candidates: 1,
                model_revision: "test-model".to_string(),
                tokenizer_revision: "test-tokenizer".to_string(),
                ..VerifierCapabilities::default()
            }
        }

        fn open_session(
            &mut self,
            context: SessionContext,
        ) -> Result<VerifierSession, VerifierError> {
            if matches!(self.mode, FallbackVerifierMode::OpenError) {
                return Err(VerifierError::Backend("open failed".to_string()));
            }
            Ok(VerifierSession {
                session_id: 1,
                context,
                model_revision: "test-model".to_string(),
                tokenizer_revision: "test-tokenizer".to_string(),
                kv_reusable: false,
            })
        }

        fn evaluate(
            &mut self,
            session: &mut VerifierSession,
            draft: &Draft,
        ) -> Result<VerificationResult, VerifierError> {
            if matches!(self.mode, FallbackVerifierMode::EvaluateError) {
                return Err(VerifierError::Backend("evaluate failed".to_string()));
            }
            let state = match self.mode {
                FallbackVerifierMode::EvaluateStateError => VerificationState::Error,
                FallbackVerifierMode::Exhausted => VerificationState::Exhausted,
                FallbackVerifierMode::PrefixConstraint => {
                    VerificationState::PrefixConstraintReturned
                }
                FallbackVerifierMode::UnverifiedFallback => VerificationState::UnverifiedFallback,
                FallbackVerifierMode::VerifiedEmpty => VerificationState::Verified,
                FallbackVerifierMode::OpenError
                | FallbackVerifierMode::EvaluateError
                | FallbackVerifierMode::NoPrefixCapability => VerificationState::Verified,
            };
            let prefix_constraint = matches!(self.mode, FallbackVerifierMode::PrefixConstraint)
                .then(|| Utf8BytePrefixConstraint::output_prefix("感じ"));
            let candidate_path = if matches!(self.mode, FallbackVerifierMode::VerifiedEmpty) {
                CandidatePath {
                    edge_handles: Vec::new(),
                    text: String::new(),
                    score: 0.0,
                    trailing: None,
                }
            } else {
                draft.candidate_path.clone()
            };
            Ok(VerificationResult {
                state,
                candidate_path,
                prefix_constraint,
                cache_key: VerificationCacheKey::for_draft(session, draft),
            })
        }

        fn close_session(&mut self, _session: VerifierSession) -> Result<(), VerifierError> {
            Ok(())
        }
    }

    struct CountingVerifier {
        evaluate_calls: usize,
        observed_left_context: Option<Vec<u8>>,
        evaluation_delay: Duration,
    }

    impl CountingVerifier {
        fn new() -> Self {
            Self {
                evaluate_calls: 0,
                observed_left_context: None,
                evaluation_delay: Duration::ZERO,
            }
        }

        fn with_evaluation_delay(delay: Duration) -> Self {
            Self { evaluation_delay: delay, ..Self::new() }
        }
    }

    impl DraftVerifier for CountingVerifier {
        fn capabilities(&self) -> VerifierCapabilities {
            VerifierCapabilities {
                prefix_constraints: true,
                max_candidates: 1,
                model_revision: "counting-model".to_string(),
                tokenizer_revision: "counting-tokenizer".to_string(),
                ..VerifierCapabilities::default()
            }
        }

        fn open_session(
            &mut self,
            context: SessionContext,
        ) -> Result<VerifierSession, VerifierError> {
            self.observed_left_context = context.left_context.clone();
            Ok(VerifierSession {
                session_id: 1,
                context,
                model_revision: "counting-model".to_string(),
                tokenizer_revision: "counting-tokenizer".to_string(),
                kv_reusable: false,
            })
        }

        fn evaluate(
            &mut self,
            session: &mut VerifierSession,
            draft: &Draft,
        ) -> Result<VerificationResult, VerifierError> {
            self.evaluate_calls += 1;
            if !self.evaluation_delay.is_zero() {
                std::thread::sleep(self.evaluation_delay);
            }
            Ok(VerificationResult {
                state: VerificationState::Verified,
                candidate_path: draft.candidate_path.clone(),
                prefix_constraint: None,
                cache_key: VerificationCacheKey::for_draft(session, draft),
            })
        }

        fn close_session(&mut self, _session: VerifierSession) -> Result<(), VerifierError> {
            Ok(())
        }
    }

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
    fn system_dictionary_still_rejects_unintentional_short_latin_transliteration() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-system-latin-noise-{}-{}.tsv",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "さん\tSun\t100\n").expect("fixture should write");
        let converted = super::convert_kana_to_kanji_with_paths(
            "さん",
            DictionaryPaths { system: Some(root.clone()), ..DictionaryPaths::default() },
        )
        .expect("system TSV should load");
        assert_ne!(converted, "Sun");
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
    fn digit_percent_counter_survives_intervening_unit_glyphs() {
        // Invariant: an arabic (or mixed-width) digit span followed by a known
        // percent-unit reading must emit `N%` even when a pure unit glyph
        // (°/℃/ﾟ or °C) sits between them. Without skipping that noise, the
        // lattice splits digits (`0`→`〇`) and ranks lexical `蕨` over `%`.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        for (input, expected) in [
            ("90わらび", "90%"),
            ("90°わらび", "90%"),
            ("6０°わらび", "60%"),
            ("90℃わらび", "90%"),
            ("90°ぱーせんと", "90%"),
            ("90°Cわらび", "90%"),
            ("こうすいかくりつは60°わらび", "降水確率は60%"),
            ("こうすいかくりつは6０°わらび", "降水確率は60%"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
            assert!(
                !candidate.text.contains('蕨')
                    && !candidate.text.contains('〇')
                    && !candidate.text.contains('°')
                    && !candidate.text.contains('℃'),
                "must not emit degree/fern/ideographic-zero garble for {input}: {:?}",
                candidate.text
            );
        }
    }

    #[test]
    fn intervening_unit_glyphs_stay_before_non_percent_surfaces() {
        // Percent-only skip must not silently delete degree/unit marks on bare
        // temperatures or before non-percent counters (回/度-class).
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load")
        .without_builtin_entries_for_test();
        for input in ["90°", "90℃", "90°C", "90°かいてん", "90°ど"] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("public conversion should produce a candidate");
            let keeps_unit = candidate.text.contains('°') || candidate.text.contains('℃');
            assert!(
                keeps_unit,
                "degree/unit glyph must not be deleted for {input}: {:?}",
                candidate.text
            );
        }
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
    fn explicit_user_dictionary_can_emit_a_short_uppercase_acronym() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-user-acronym-{}-{}.tsv",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "ぶいあーるちゃっと\tVRC\n").expect("fixture should write");
        let system_path = test_system_dictionary_path();
        let baseline = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(system_path.clone()),
            user: None,
            memory: None,
        })
        .expect("system dictionary should load");
        assert_eq!(
            convert_with_dictionary("ぶいあーるちゃっと", &baseline, ConversionOptions::default(),)
                [0]
            .text,
            "VRChat"
        );
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(system_path),
            user: Some(root.clone()),
            memory: None,
        })
        .expect("system and user dictionaries should load");
        let lookup = dictionary.lookup_exact("ぶいあーるちゃっと").expect("reading should lookup");
        let user = lookup
            .into_iter()
            .find(|entry| entry.surface == "VRC")
            .expect("user acronym should be present");
        assert!(user.user_supplied);
        assert_eq!(user.value, -1.0);

        let results = convert_with_dictionary(
            "ぶいあーるちゃっと",
            &dictionary,
            ConversionOptions::default(),
        );
        assert_eq!(results[0].text, "VRC", "results={results:?}");
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
    fn prefers_contextual_hashi_atsui_and_kaite_continuations() {
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
            ("はしをわたる", "橋を渡る"),
            ("はしをとおる", "橋を通る"),
            ("はしでたべる", "箸で食べる"),
            ("はし", "箸"),
            ("あついかべ", "厚い壁"),
            ("あついほん", "厚い本"),
            ("あついこおり", "厚い氷"),
            ("かべがあつい", "壁が厚い"),
            ("ほんがあつい", "本が厚い"),
            ("こおりがあつい", "氷が厚い"),
            ("あついひ", "暑い日"),
            ("あついすーぷは", "熱いスープは"),
            ("かいて", "書いて"),
            ("かいてください", "書いてください"),
            ("かいてみます", "書いてみます"),
            ("かいてある", "書いてある"),
            ("みちのはじ", "道の端"),
            ("つくえのはじ", "机の端"),
            ("かべのはじ", "壁の端"),
            ("えきのはじ", "駅の端"),
            ("ページのはじ", "ページの端"),
            ("はしのはじ", "橋の端"),
            ("はじ", "恥"),
            ("わたしのはじ", "私の恥"),
            ("はじる", "恥じる"),
            ("えをかいて", "絵を描いて"),
            ("もじをかいて", "文字を書いて"),
            ("はじをかく", "恥を掻く"),
            ("かみのはじ", "紙の端"),
            ("かみ", "神"),
            ("かみさま", "神様"),
            ("かみのけ", "髪の毛"),
            ("かみをきる", "髪を切る"),
        ] {
            let candidates = convert_with_dictionary(
                input,
                &dictionary,
                ConversionOptions { n_best: 16, ..ConversionOptions::default() },
            );
            let top = candidates.first().expect("public conversion should produce a candidate");
            assert_eq!(
                top.text,
                expected,
                "input: {input}; n-best={:?}",
                candidates.iter().take(5).map(|candidate| &candidate.text).collect::<Vec<_>>()
            );
        }
        let nihon = convert_with_dictionary(
            "にほんがあつい",
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let nihon_top = nihon.first().map(|candidate| candidate.text.as_str());
        assert_ne!(nihon_top, Some("2本が厚い"), "numeral 本 must not steal にほんがあつい");
        assert_ne!(nihon_top, Some("日本が厚い"), "日本が must not take the book-thickness prior");
        assert!(
            nihon.iter().any(|candidate| candidate.text == "日本が暑い"),
            "weather reading must remain available: {:?}",
            nihon.iter().take(5).map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
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
    fn uses_thickness_context_for_daikon_clause() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load")
        .without_builtin_entries_for_test();
        let input = "だいこんがあついのでうすくきる";
        let candidates = convert_with_dictionary(
            input,
            &dictionary,
            ConversionOptions { n_best: 16, ..ConversionOptions::default() },
        );
        let top = candidates.first().expect("public conversion should produce a candidate");
        assert_eq!(top.text, "大根が厚いので薄く切る");
        assert!(
            candidates.iter().any(|candidate| candidate.text == "大根が熱いので薄く切る"),
            "the temperature reading should remain in n-best: {:?}",
            candidates.iter().map(|candidate| &candidate.text).collect::<Vec<_>>()
        );
    }

    #[test]
    fn thickness_context_bonus_adds_slice_delta_over_thinness_only() {
        // Pin the thinness-gated prior and the optional slice add-on separately
        // from the combined daikon golden: thinness alone yields
        // THICKNESS_CONTEXT_BONUS; co-occurring 切/刻/削 adds
        // THICKNESS_SLICE_CONTEXT_BONUS without requiring a slicing-only path.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load")
        .without_builtin_entries_for_test();
        let thick = DictionaryEntry::plain("あつい", "厚い", -5.0);
        let end = "あつい".chars().count();
        let max_dictionary_word_chars = super::DEFAULT_MAX_DICTIONARY_WORD_CHARS;
        let thinness_only: Vec<char> = "あついのでうすくする".chars().collect();
        let thinness_and_slice: Vec<char> = "あついのでうすくきる".chars().collect();
        let thinness_bonus = super::thickness_context_bonus(
            &dictionary,
            &thinness_only,
            end,
            &thick,
            max_dictionary_word_chars,
        );
        let combined_bonus = super::thickness_context_bonus(
            &dictionary,
            &thinness_and_slice,
            end,
            &thick,
            max_dictionary_word_chars,
        );
        assert_eq!(thinness_bonus, super::THICKNESS_CONTEXT_BONUS);
        assert_eq!(
            combined_bonus,
            super::THICKNESS_CONTEXT_BONUS + super::THICKNESS_SLICE_CONTEXT_BONUS
        );
        assert_eq!(combined_bonus - thinness_bonus, super::THICKNESS_SLICE_CONTEXT_BONUS);
    }

    #[test]
    fn prefers_thickness_with_thinness_alone_without_slice_cue() {
        // Thinness cues alone must still prefer 厚い where intended; the slice
        // add-on is optional and must not be required for the base prior.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load")
        .without_builtin_entries_for_test();
        let top = convert_with_dictionary(
            "だいこんがあついのでうすくする",
            &dictionary,
            ConversionOptions::default(),
        )
        .into_iter()
        .next()
        .expect("public conversion should produce a candidate");
        assert_eq!(top.text, "大根が厚いので薄くする");
    }

    #[test]
    fn weather_thinness_with_slice_does_not_flip_to_thickness() {
        // Downstream thinness/slice cues must not override weather/food 暑い
        // when there is no thickness subject frame.
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            user: None,
            memory: None,
        })
        .expect("official AzooKey dictionary should load")
        .without_builtin_entries_for_test();
        for (input, expected) in [
            ("あついのでうすくきる", "暑いので薄く切る"),
            ("あついひなのでうすくきる", "暑い日なので薄く切る"),
        ] {
            let top = convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next()
                .expect("public conversion should produce a candidate");
            assert_eq!(top.text, expected, "input: {input}");
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
            ("りょうりがあついのでさます", "料理が熱いのでさます"),
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
        // Food subject + cooling verb: temperature 熱い, keep さます as the
        // morphology identity rather than a homonym. Weather 暑い is unnatural.
        assert_eq!(candidate.text, "料理が熱いのでさます");
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
            ("りょうりがあついのでさます", "料理が熱いのでさます"),
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
        // before the later verb/nominal connections were available. Compact
        // unknown after `良く` must not outrank the multi-Kanji path
        // `柿`+`食う` either.
        assert_eq!(converted, "隣の客は良く柿食う客だ");
    }

    #[test]
    fn prefers_multi_kanji_segmentation_for_kaki_kuu() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        let candidate =
            convert_with_dictionary("かきくう", &dictionary, ConversionOptions::default())
                .into_iter()
                .next()
                .expect("public conversion should produce a candidate");
        assert_eq!(candidate.text, "柿食う");
    }

    #[test]
    fn prefers_conjugational_stem_before_polite_auxiliary() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("ふります", "降ります"),
            ("あめがふります", "雨が降ります"),
            // Joshi/conjugational-band kana identities must not beat verb stems.
            ("のみます", "飲みます"),
            ("みずをのみます", "水を飲みます"),
            // Bare roots + noun compounds must not absorb stem+evidential そう.
            // After 雨, precipitation must beat the wave/shake homophone.
            ("ふりそうです", "振りそうです"),
            ("あめがふりそうです", "雨が降りそうです"),
            ("雨がふりそうです", "雨が降りそうです"),
            ("ゆきがふりそうです", "雪が降りそうです"),
            ("雪がふりそうです", "雪が降りそうです"),
            // Already-correct polite verbs must not regress.
            ("はれます", "晴れます"),
            ("いきます", "行きます"),
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
    fn prefers_full_span_person_plural_over_rare_short_head() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");
        for (input, expected) in [
            ("わたしたち", "私たち"),
            ("わたしたちはがくせいです", "私たちは学生です"),
            // Short head without a person suffix stays score-driven.
            ("わたし", "私"),
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
    fn jodoushi_and_person_suffix_priors_are_context_gated() {
        let root = crate::dictionary::test_system_dictionary_path();
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root),
            ..DictionaryPaths::default()
        })
        .expect("configured public dictionary should load");

        // Without a following jodoushi auxiliary, bare readings stay score-driven
        // rather than being forced toward a conjugational stem.
        let furi = convert_with_dictionary("ふり", &dictionary, ConversionOptions::default())
            .into_iter()
            .next()
            .expect("ふり should convert");
        assert_ne!(
            furi.text, "降り",
            "bare ふり must not be forced to the polite-stem prior: {}",
            furi.text
        );

        // Stem+ます that already has a full-span conjugational surface must not
        // regress when competing non-stem rows are absent from the top path.
        for (input, expected) in [
            ("みます", "見ます"),
            ("ききます", "聞きます"),
            ("かきます", "書きます"),
            ("たべます", "食べます"),
        ] {
            let candidate =
                convert_with_dictionary(input, &dictionary, ConversionOptions::default())
                    .into_iter()
                    .next()
                    .expect("public conversion should produce a candidate");
            assert_eq!(candidate.text, expected, "input: {input}");
        }

        // A personification suffix without a full-span converted plural row
        // remains a normal head+suffix path (not forced by the 私たち prior).
        let yamada =
            convert_with_dictionary("やまださん", &dictionary, ConversionOptions::default())
                .into_iter()
                .next()
                .expect("やまださん should convert");
        assert!(
            yamada.text.contains('山') || yamada.text.contains("山田"),
            "やまださん should keep the proper-noun path, got {}",
            yamada.text
        );
    }

    #[test]
    fn fixture_jodoushi_prior_demotes_bare_root_before_masu() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-jodoushi-prior-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        // Bare non-conjugational root + conjugational stem share ふり; only the
        // stem should win before jodoushi ます. CID 11 is outside the
        // conjugational band; 788 is inside it (matches official LOUDS bands).
        fs::write(
            &root,
            "ふり\t古\t-1\t11\t11\t10\n\
             ふり\t降り\t-2\t788\t788\t20\n\
             ます\tます\t-0.5\t491\t491\t17\n",
        )
        .expect("jodoushi-prior fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("jodoushi-prior fixture should load")
        .without_builtin_entries_for_test();

        let chars = "ふります".chars().collect::<Vec<_>>();
        let lookup = super::SpanLookup::new(&dictionary, &chars, 24);
        let furi = dictionary
            .lookup_exact("ふり")
            .expect("ふり lookup")
            .into_iter()
            .find(|entry| entry.surface == "古")
            .expect("bare root 古");
        let furi_stem = dictionary
            .lookup_exact("ふり")
            .expect("ふり lookup")
            .into_iter()
            .find(|entry| entry.surface == "降り")
            .expect("stem 降り");
        assert_eq!(
            super::bare_content_before_jodoushi_penalty(&dictionary, &lookup, 2, &furi),
            super::BARE_CONTENT_BEFORE_JODOUSHI_PENALTY,
            "bare root before ます must be demoted"
        );
        assert_eq!(
            super::bare_content_before_jodoushi_penalty(&dictionary, &lookup, 2, &furi_stem),
            super::NO_SCORE,
            "conjugational stem must not receive the bare-root demotion"
        );
        assert_eq!(
            super::conjugational_stem_before_jodoushi_bonus(&dictionary, &lookup, 2, &furi_stem),
            super::CONJUGATIONAL_STEM_BEFORE_JODOUSHI_BONUS,
            "conjugational stem before ます must receive the stem bonus"
        );
        let isolated = "ふり".chars().collect::<Vec<_>>();
        let isolated_lookup = super::SpanLookup::new(&dictionary, &isolated, 24);
        assert_eq!(
            super::bare_content_before_jodoushi_penalty(&dictionary, &isolated_lookup, 2, &furi),
            super::NO_SCORE,
            "bare root without a following jodoushi must stay score-driven"
        );

        let top = convert_with_dictionary(
            "ふります",
            &dictionary,
            ConversionOptions { n_best: 4, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("fixture conversion should produce a candidate");
        assert_eq!(
            top.text, "降ります",
            "conjugational stem must beat bare root before ます: {}",
            top.text
        );

        // Without ます, the higher-valued bare root may still win.
        let bare = convert_with_dictionary(
            "ふり",
            &dictionary,
            ConversionOptions { n_best: 4, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("bare fixture conversion should produce a candidate");
        assert_eq!(bare.text, "古", "bare ふり stays score-driven without ます");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn fixture_hiragana_identity_before_jodoushi_prefers_kanji_stem() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-hiragana-identity-jodoushi-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        // Conjugational-band kana identity outranks the Kanji stem on cheap
        // transitions unless the identity-before-jodoushi prior demotes it.
        fs::write(
            &root,
            "のみ\tのみ\t-1\t767\t767\t420\n\
             のみ\t飲み\t-2\t767\t767\t290\n\
             ます\tます\t-0.5\t491\t491\t17\n",
        )
        .expect("hiragana-identity fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("hiragana-identity fixture should load")
        .without_builtin_entries_for_test();

        let chars = "のみます".chars().collect::<Vec<_>>();
        let lookup = super::SpanLookup::new(&dictionary, &chars, 24);
        let identity = dictionary
            .lookup_exact("のみ")
            .expect("のみ lookup")
            .into_iter()
            .find(|entry| entry.surface == "のみ")
            .expect("identity のみ");
        let stem = dictionary
            .lookup_exact("のみ")
            .expect("のみ lookup")
            .into_iter()
            .find(|entry| entry.surface == "飲み")
            .expect("stem 飲み");
        assert_eq!(
            super::hiragana_identity_before_jodoushi_penalty(&dictionary, &lookup, 2, &identity),
            super::HIRAGANA_IDENTITY_BEFORE_JODOUSHI_PENALTY,
            "kana identity before ます must be demoted"
        );
        assert_eq!(
            super::hiragana_identity_before_jodoushi_penalty(&dictionary, &lookup, 2, &stem),
            super::NO_SCORE,
            "Kanji stem must not receive the identity demotion"
        );

        let top = convert_with_dictionary(
            "のみます",
            &dictionary,
            ConversionOptions { n_best: 4, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("fixture conversion should produce a candidate");
        assert_eq!(
            top.text, "飲みます",
            "Kanji stem must beat kana identity before ます: {}",
            top.text
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn fixture_person_suffix_prior_prefers_full_span_plural() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-person-suffix-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(
            &root,
            "わたし\t妾\t-1\t1285\t1285\t97\n\
             わたし\t私\t-0.5\t1306\t1306\t17\n\
             わたしたち\t私たち\t-1.2\t1288\t1288\t17\n\
             たち\tたち\t-0.3\t1298\t1298\t459\n\
             は\tは\t-0.2\t261\t261\t468\n",
        )
        .expect("person-suffix fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("person-suffix fixture should load")
        .without_builtin_entries_for_test();

        let top = convert_with_dictionary(
            "わたしたちは",
            &dictionary,
            ConversionOptions { n_best: 6, ..ConversionOptions::default() },
        )
        .into_iter()
        .next()
        .expect("person-suffix fixture conversion should produce a candidate");
        assert_eq!(
            top.text, "私たちは",
            "full-span plural must beat rare short head + たち: {}",
            top.text
        );
        let _ = fs::remove_file(root);
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

    #[test]
    fn lattice_keeps_dictionary_identity_numeric_boundary_and_oov_origins() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-lattice-origins-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "かんじ\t漢字\t-1\nかんじ\tかんじ\t-2\n")
            .expect("lattice fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("lattice fixture should load")
        .without_builtin_entries_for_test();

        let lattice =
            build_lattice(&dictionary, &ConversionRequest::new("かんじ、xyzさんびゃくえん"));
        assert!(lattice.edges().iter().any(|edge| {
            matches!(edge.origin, EdgeOrigin::Dictionary(_)) && edge.surface == "漢字"
        }));
        assert!(lattice
            .edges()
            .iter()
            .any(|edge| matches!(edge.origin, EdgeOrigin::KnownIdentity)));
        assert!(lattice
            .edges()
            .iter()
            .any(|edge| matches!(edge.origin, EdgeOrigin::Boundary) && edge.surface == "、"));
        assert!(lattice
            .edges()
            .iter()
            .any(|edge| matches!(edge.origin, EdgeOrigin::OovIdentity) && edge.surface == "x"));
        assert!(lattice.edges().iter().any(|edge| {
            matches!(edge.origin, EdgeOrigin::NumericSynthesized) && edge.surface == "300円"
        }));
        assert!(lattice.edges().iter().all(|edge| {
            edge.byte_span.start <= edge.byte_span.end
                && edge.byte_span.end <= lattice.input().len()
        }));
        let _ = fs::remove_file(root);
    }

    #[test]
    fn constrained_search_recovers_a_low_scoring_dictionary_path() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-lattice-constraint-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "かんじ\t漢字\t-1\nかんじ\t感じ\t-5\n")
            .expect("constraint fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("constraint fixture should load")
        .without_builtin_entries_for_test();
        let lattice = build_lattice(&dictionary, &ConversionRequest::new("かんじ"));

        let unconstrained = lattice.search(&ConstrainedSearchRequest {
            beam_width: 1,
            n_best: 1,
            ..ConstrainedSearchRequest::default()
        });
        assert_eq!(unconstrained.first().map(|path| path.text.as_str()), Some("漢字"));

        let constrained = lattice.search(&ConstrainedSearchRequest {
            beam_width: 1,
            n_best: 1,
            constraints: vec![Utf8BytePrefixConstraint::from_surface(0, "感じ")],
            ..ConstrainedSearchRequest::default()
        });
        assert_eq!(constrained.first().map(|path| path.text.as_str()), Some("感じ"));
        assert!(constrained[0].edge_handles.iter().any(|handle| {
            matches!(
                lattice.edge(*handle).map(|edge| &edge.origin),
                Some(EdgeOrigin::Dictionary(_))
            )
        }));

        let globally_constrained = lattice.search(&ConstrainedSearchRequest {
            beam_width: 1,
            n_best: 1,
            constraints: vec![Utf8BytePrefixConstraint::output_prefix("感じ")],
            ..ConstrainedSearchRequest::default()
        });
        assert_eq!(globally_constrained.first().map(|path| path.text.as_str()), Some("感じ"));
        let _ = fs::remove_file(root);
    }

    #[test]
    fn missing_verifier_returns_the_dictionary_result() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let baseline = convert_with_dictionary("かんじ", &dictionary, options)
            .into_iter()
            .next()
            .expect("dictionary conversion should produce a candidate");
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            None,
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::CapabilityUnavailable);
        assert_eq!(result.candidate.text, baseline.text);
        assert!(!result.text().is_empty(), "capability fallback must emit text");
    }

    #[test]
    fn unsupported_verifier_capability_returns_the_dictionary_result() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::NoPrefixCapability };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::CapabilityUnavailable);
        assert!(!result.text().is_empty(), "unsupported capability must emit text");
    }

    #[test]
    fn open_session_failure_returns_the_dictionary_result() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let baseline = convert_with_dictionary("かんじ", &dictionary, options)
            .into_iter()
            .next()
            .expect("dictionary conversion should produce a candidate");
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::OpenError };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::Error);
        assert_eq!(result.candidate.text, baseline.text);
        assert!(!result.text().is_empty(), "session failure must emit text");
    }

    #[test]
    fn evaluate_error_returns_the_dictionary_result() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let baseline = convert_with_dictionary("かんじ", &dictionary, options)
            .into_iter()
            .next()
            .expect("dictionary conversion should produce a candidate");
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::EvaluateError };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::Error);
        assert_eq!(result.candidate.text, baseline.text);
        assert!(!result.text().is_empty(), "evaluation failure must emit text");
    }

    #[test]
    fn evaluate_error_state_returns_the_dictionary_result() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let baseline = convert_with_dictionary("かんじ", &dictionary, options)
            .into_iter()
            .next()
            .expect("dictionary conversion should produce a candidate");
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::EvaluateStateError };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::Error);
        assert_eq!(result.candidate.text, baseline.text);
        assert!(!result.text().is_empty(), "error state must emit text");
    }

    #[test]
    fn default_verifier_iteration_limit_matches_zenzai() {
        assert_eq!(super::DEFAULT_VERIFIER_MAX_ITERATIONS, 10);
    }

    #[test]
    fn verifier_iteration_limit_returns_the_latest_constrained_candidate() {
        let root = std::env::temp_dir().join(format!(
            "caption-bridge-verifier-limit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        fs::write(&root, "かんじ\t漢字\t-1\nかんじ\t感じ\t-5\n")
            .expect("verifier limit fixture should write");
        let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
            system: Some(root.clone()),
            ..DictionaryPaths::default()
        })
        .expect("verifier limit fixture should load")
        .without_builtin_entries_for_test();
        let options = ConversionOptions::default();
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::PrefixConstraint };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(1, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::ExhaustedWithConstrainedCandidate);
        assert_eq!(result.candidate.text, "感じ");
        assert_eq!(result.verification_iterations(), 1);
        assert!(!result.text().is_empty(), "exhaustion result must emit text");
        let _ = fs::remove_file(root);
    }

    #[test]
    fn zero_verifier_limit_returns_the_dictionary_baseline_without_evaluation() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let baseline = convert_with_dictionary("かんじ", &dictionary, options)
            .into_iter()
            .next()
            .expect("dictionary conversion should produce a candidate");
        let mut verifier = FallbackVerifier { mode: FallbackVerifierMode::OpenError };
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(0, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::ExhaustedWithDictionaryFallback);
        assert_eq!(result.candidate.text, baseline.text);
        assert_eq!(result.verification_iterations(), 0);
        assert!(!result.text().is_empty(), "zero-limit result must emit text");
    }

    #[test]
    fn verifier_policy_skips_empty_left_context_without_calling_backend() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::new();
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_left_context(" \u{3000}\n"),
        );

        assert_eq!(result.verification_state, VerificationState::SkippedByPolicy);
        assert_eq!(verifier.evaluate_calls, 0);
        assert_eq!(result.verification_iterations(), 0);
        assert!(!result.text().is_empty(), "policy skip must emit dictionary text");
    }

    #[test]
    fn verifier_policy_calls_backend_with_left_context() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::new();
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1").with_left_context("前の発話"),
        );

        assert_eq!(result.verification_state, VerificationState::Verified);
        assert_eq!(verifier.evaluate_calls, 1);
        assert_eq!(verifier.observed_left_context.as_deref(), Some("前の発話".as_bytes()));
        assert!(!result.text().is_empty(), "verified conversion must emit text");
    }

    #[test]
    fn verifier_policy_can_be_overridden_for_context_free_measurement() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::new();
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify()),
        );

        assert_eq!(result.verification_state, VerificationState::Verified);
        assert_eq!(verifier.evaluate_calls, 1);
        assert_eq!(verifier.observed_left_context, None);
        assert!(!result.text().is_empty(), "measurement override must emit text");
    }

    #[test]
    fn invalid_left_context_is_skipped_without_calling_backend() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::new();
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1").with_left_context([0xff, 0xfe]),
        );

        assert_eq!(result.verification_state, VerificationState::SkippedByPolicy);
        assert_eq!(verifier.evaluate_calls, 0);
        assert!(!result.text().is_empty(), "invalid context must emit text");
    }

    #[test]
    fn expired_deadline_returns_dictionary_result_without_calling_backend() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::new();
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify())
                .with_deadline(Duration::ZERO),
        );

        assert_eq!(result.verification_state, VerificationState::DeadlineExceeded);
        assert_eq!(verifier.evaluate_calls, 0);
        assert_eq!(result.verification_iterations(), 0);
        assert!(!result.text().is_empty(), "deadline fallback must emit text");
    }

    #[test]
    fn deadline_after_backend_call_discards_late_verified_candidate() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let mut verifier = CountingVerifier::with_evaluation_delay(Duration::from_millis(5));
        let result = convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            options,
            Some(&mut verifier),
            VerifierConversionOptions::new(10, "test-inference-v1")
                .with_policy(VerifierPolicy::always_verify())
                .with_deadline(Duration::from_millis(1)),
        );

        assert_eq!(result.verification_state, VerificationState::DeadlineExceeded);
        assert_eq!(verifier.evaluate_calls, 1);
        assert!(!result.text().is_empty(), "late deadline fallback must emit text");
    }

    #[test]
    fn every_verifier_fallback_state_keeps_non_empty_text() {
        let dictionary = AzooKeyDictionary::default();
        let options = ConversionOptions::default();
        let modes = [
            FallbackVerifierMode::Exhausted,
            FallbackVerifierMode::UnverifiedFallback,
            FallbackVerifierMode::VerifiedEmpty,
            FallbackVerifierMode::NoPrefixCapability,
        ];
        for mode in modes {
            let mut verifier = FallbackVerifier { mode };
            let result = convert_with_verifier(
                "かんじ",
                &dictionary,
                options,
                Some(&mut verifier),
                "test-inference-v1",
            );
            assert!(!result.text().is_empty(), "fallback state {mode:?} returned empty text");
        }
        let missing =
            convert_with_verifier("かんじ", &dictionary, options, None, "test-inference-v1");
        assert!(!missing.text().is_empty(), "missing verifier returned empty text");
    }

    #[test]
    fn strict_dictionary_lattice_does_not_silently_add_oov_edges() {
        let dictionary = AzooKeyDictionary::default();
        let request = ConversionRequest {
            input: "xyz".to_string(),
            unknown_policy: UnknownPolicy::StrictDictionary,
            ..ConversionRequest::default()
        };
        let lattice = build_lattice(&dictionary, &request);
        assert!(lattice.edges().iter().all(|edge| !matches!(edge.origin, EdgeOrigin::OovIdentity)));
        assert!(lattice.search(&ConstrainedSearchRequest::default()).is_empty());
    }
}
