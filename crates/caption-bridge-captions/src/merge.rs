//! Caption payload merge, provisional fold, and stale-shorter suppression.
//!
//! Port of `apps/desktop/src/core/caption-updates.ts`. The TypeScript file also
//! records translation-disposition diagnostics; that side effect is omitted here
//! because it is not display-algorithm state.

use crate::display::collapse_runaway_grapheme_runs;
use crate::grapheme::unicode_scalars;
use crate::payload::{CaptionPayload, CaptionStage};

const NO_TIME_MS: i64 = 0;
const SOURCE_SEQUENCE: i64 = 0;
const TRANSLATION_SEQUENCE: i64 = 1;
const MIN_OVERLAP_CHARS: usize = 2;
const INDEX_STEP: usize = 1;
const MAX_PAINTED_HEAD_REWRITE_CHARS: usize = 3;
const PAINTED_HEAD_REWRITE_DENOMINATOR: usize = 8;
const MAX_PENDING_CROSS_ID_TRANSLATIONS: usize = 64;
const HIRAGANA_START_CODE_POINT: u32 = 0x3041;
const KATAKANA_START_CODE_POINT: u32 = 0x30A1;
const KATAKANA_END_CODE_POINT: u32 = 0x30F6;
const KATAKANA_TO_HIRAGANA_OFFSET: u32 = KATAKANA_START_CODE_POINT - HIRAGANA_START_CODE_POINT;
const SOURCE_CONTINUATION_GAP_MS: i64 = 3_200;
const SHORT_SOURCE_CONTINUATION_MAX_CHARS: usize = 8;
const MIN_DISJOINT_CLAUSE_GRAPHEMES: usize = 4;
const MAX_IDENTICAL_KANJI_RUN: usize = 2;

/// Number of first-time IDs inserted into the bounded pending store, plus the
/// current store size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptionMergeDiagnostics {
    pub cross_id_translation_ids_saved: usize,
    pub pending_cross_id_translations: usize,
}

struct PendingStore {
    saved: usize,
    entries: Vec<(String, CaptionPayload)>,
}

impl PendingStore {
    fn new() -> Self {
        Self { saved: 0, entries: Vec::new() }
    }

    fn diagnostics(&self) -> CaptionMergeDiagnostics {
        CaptionMergeDiagnostics {
            cross_id_translation_ids_saved: self.saved,
            pending_cross_id_translations: self.entries.len(),
        }
    }

    fn clear(&mut self) {
        self.saved = 0;
        self.entries.clear();
    }

    fn get(&self, id: &str) -> Option<&CaptionPayload> {
        self.entries.iter().find(|(key, _)| key == id).map(|(_, payload)| payload)
    }

    fn evict_oldest_until_room(&mut self) {
        while self.entries.len() >= MAX_PENDING_CROSS_ID_TRANSLATIONS {
            if self.entries.is_empty() {
                break;
            }
            self.entries.remove(0);
        }
    }

    fn insert(&mut self, id: String, payload: CaptionPayload) {
        if let Some(existing) = self.entries.iter_mut().find(|(key, _)| key == &id) {
            existing.1 = payload;
            return;
        }
        self.evict_oldest_until_room();
        self.saved += 1;
        self.entries.push((id, payload));
    }

    fn take(&mut self, id: &str) -> Option<CaptionPayload> {
        let index = self.entries.iter().position(|(key, _)| key == id)?;
        Some(self.entries.remove(index).1)
    }
}

use std::cell::RefCell;

thread_local! {
    static PENDING: RefCell<PendingStore> = RefCell::new(PendingStore::new());
}

fn trim(value: &str) -> &str {
    value.trim()
}

fn has_text(value: &str) -> bool {
    !trim(value).is_empty()
}

fn received_at_of(caption: &CaptionPayload) -> i64 {
    caption.received_at
}

fn started_at_of(caption: &CaptionPayload) -> i64 {
    caption.started_at
}

fn is_older_same_id_revision(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_started_at = started_at_of(current);
    let next_started_at = started_at_of(next);
    if current_started_at > NO_TIME_MS
        && next_started_at > NO_TIME_MS
        && next_started_at != current_started_at
    {
        return next_started_at < current_started_at;
    }
    received_at_of(next) < received_at_of(current)
}

fn sequence_of(caption: &CaptionPayload) -> i64 {
    if let Some(sequence) = caption.sequence {
        return sequence;
    }
    if caption.stage == Some(CaptionStage::Translation)
        || caption.is_final_true()
        || has_text(&caption.translation_text)
    {
        return TRANSLATION_SEQUENCE;
    }
    SOURCE_SEQUENCE
}

/// Preserve a cross-ID translation outside the live slot.
pub fn save_pending_caption_translation(caption: &CaptionPayload) -> bool {
    if caption.id.trim().is_empty() {
        return false;
    }
    PENDING.with(|store| {
        let mut store = store.borrow_mut();
        let previous = store.get(&caption.id).cloned();
        let should_store = match previous.as_ref() {
            None => true,
            Some(previous) => {
                is_newer_final_translation_revision(previous, caption)
                    || !is_older_same_id_revision(previous, caption)
            }
        };
        if !should_store {
            return false;
        }
        store.insert(caption.id.clone(), caption.clone());
        true
    })
}

/// Return and remove a translation preserved for a different caption ID.
pub fn take_pending_caption_translation(id: &str) -> Option<CaptionPayload> {
    PENDING.with(|store| store.borrow_mut().take(id))
}

/// Inspect cross-ID translation preservation without mutating the pending store.
pub fn get_caption_merge_diagnostics() -> CaptionMergeDiagnostics {
    PENDING.with(|store| store.borrow().diagnostics())
}

/// Clear caption merge diagnostics and pending cross-ID translations.
pub fn clear_caption_merge_diagnostics() {
    PENDING.with(|store| store.borrow_mut().clear());
}

fn ends_with_source_boundary(text: &str) -> bool {
    text.ends_with(['。', '．', '！', '？', '!', '?'])
}

fn incomplete_source_ending(text: &str) -> bool {
    const ENDINGS: &[&str] = &[
        "は", "が", "を", "に", "へ", "で", "と", "も", "の", "や", "か", "ね", "よ", "な", "ま",
        "て", "is", "are", "the", "a", "an", "to", "of", "and", "but", "with", "for", "in", "on",
        "at",
    ];
    let lower = text.to_ascii_lowercase();
    ENDINGS.iter().any(|ending| {
        if ending.chars().all(|character| character.is_ascii_alphabetic()) {
            lower.ends_with(ending)
        } else {
            text.ends_with(ending)
        }
    })
}

fn is_japanese_source_text(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|character| {
            matches!(
                unicode_script::Script::from(character),
                unicode_script::Script::Hiragana
                    | unicode_script::Script::Katakana
                    | unicode_script::Script::Han
            )
        })
}

fn is_short_ack_surface(text: &str) -> bool {
    matches!(text, "はい" | "うん" | "ええ" | "いいえ")
}

fn is_short_japanese_continuation(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if current.id != next.id
        || current.stage != Some(CaptionStage::Source)
        || next.stage != Some(CaptionStage::Source)
        || current.is_final == Some(true)
        || next.is_final == Some(true)
        || ends_with_source_boundary(current_text)
        || ends_with_source_boundary(next_text)
        || unicode_scalars(current_text).len() > SHORT_SOURCE_CONTINUATION_MAX_CHARS
        || unicode_scalars(current_text).is_empty()
        || unicode_scalars(next_text).is_empty()
    {
        return false;
    }
    is_japanese_source_text(current_text) && is_japanese_source_text(next_text)
}

fn is_advancing_same_id_source(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    current.id == next.id
        && current.stage == Some(CaptionStage::Source)
        && next.stage == Some(CaptionStage::Source)
        && current.is_final != Some(true)
        && next.is_final != Some(true)
        && started_at_of(next) > started_at_of(current)
}

fn is_source_stage_payload(caption: &CaptionPayload) -> bool {
    caption.stage == Some(CaptionStage::Source)
        || (caption.stage.is_none()
            && sequence_of(caption) == SOURCE_SEQUENCE
            && !has_text(&caption.translation_text))
}

fn source_overlap_length(current: &str, next: &str) -> usize {
    let current_chars = unicode_scalars(current);
    let next_chars = unicode_scalars(next);
    let max = current_chars.len().min(next_chars.len());
    let mut length = max;
    while length >= MIN_OVERLAP_CHARS {
        let prefix: String = next_chars[..length].iter().collect();
        let suffix: String = current_chars[current_chars.len() - length..].iter().collect();
        if suffix == prefix {
            return prefix.len();
        }
        length -= INDEX_STEP;
    }
    0
}

fn has_lexical_source_continuation(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if current_text.is_empty() || next_text.is_empty() {
        return false;
    }
    next_text.starts_with(current_text)
        || current_text.starts_with(next_text)
        || source_overlap_length(current_text, next_text) > 0
}

fn has_close_source_timing(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_started_at = started_at_of(current);
    let next_started_at = started_at_of(next);
    if current_started_at <= NO_TIME_MS
        || next_started_at <= NO_TIME_MS
        || next_started_at < current_started_at
    {
        return false;
    }
    next_started_at - current_started_at <= SOURCE_CONTINUATION_GAP_MS
}

fn should_keep_surface_over_short_ack(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    if !is_source_stage_payload(current) || !is_source_stage_payload(next) {
        return false;
    }
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if current_text.is_empty()
        || is_short_ack_surface(current_text)
        || !is_short_ack_surface(next_text)
    {
        return false;
    }
    if unicode_scalars(current_text).len() <= unicode_scalars(next_text).len() {
        return false;
    }
    if current.id == next.id {
        return true;
    }
    let both_unset = started_at_of(current) == NO_TIME_MS && started_at_of(next) == NO_TIME_MS;
    let current_received_at = received_at_of(current);
    let next_received_at = received_at_of(next);
    let close_receipt = current_received_at > NO_TIME_MS
        && next_received_at >= current_received_at
        && next_received_at - current_received_at <= SOURCE_CONTINUATION_GAP_MS;
    has_close_source_timing(current, next) || both_unset || close_receipt
}

fn should_append_close_disjoint_turn_continuation(
    current: &CaptionPayload,
    next: &CaptionPayload,
) -> bool {
    if !is_source_stage_payload(current) || !is_source_stage_payload(next) {
        return false;
    }
    if current.id == next.id || current.is_final != Some(true) || next.is_final == Some(true) {
        return false;
    }
    let current_text = trim(&current.source_text);
    if current_text.is_empty() || ends_with_source_boundary(current_text) {
        return false;
    }
    if has_lexical_source_continuation(current, next) {
        return false;
    }
    if !has_close_source_timing(current, next) {
        return false;
    }
    let current_received_at = received_at_of(current);
    if current_received_at > NO_TIME_MS && started_at_of(next) < current_received_at {
        return false;
    }
    should_append_disjoint_same_turn_surfaces(&current.source_text, &next.source_text)
}

fn append_disjoint_continuation(current_text: &str, next_text: &str) -> String {
    let lead = trim(current_text);
    let tail = trim(next_text);
    let separator =
        if ends_with_latin_alnum(lead) && starts_with_latin_alnum(tail) { " " } else { "" };
    collapse_runaway_grapheme_runs(&format!("{lead}{separator}{tail}"), MAX_IDENTICAL_KANJI_RUN)
}

fn ends_with_latin_alnum(text: &str) -> bool {
    text.chars().next_back().is_some_and(|character| character.is_ascii_alphanumeric())
}

fn starts_with_latin_alnum(text: &str) -> bool {
    text.chars().next().is_some_and(|character| character.is_ascii_alphanumeric())
}

fn strip_elongation_marks(text: &str) -> String {
    text.chars().filter(|character| !matches!(character, 'ー' | '〜' | '～')).collect()
}

fn strip_trailing_clause_punct(text: &str) -> String {
    text.trim_end_matches(['。', '．', '.', '、', '！', '？', '!', '?']).to_string()
}

/// Surface-only half of a same-turn disjoint continuation.
pub fn should_append_disjoint_same_turn_surfaces(current_text: &str, next_text: &str) -> bool {
    let current = trim(current_text);
    let next = trim(next_text);
    if current.is_empty() || next.is_empty() || current == next {
        return false;
    }
    if is_short_ack_surface(next) {
        return false;
    }
    if next.starts_with(current)
        || current.starts_with(next)
        || is_shorter_suffix_surface(next, current)
    {
        return false;
    }
    let current_bare = strip_trailing_clause_punct(&strip_elongation_marks(current));
    let next_bare = strip_trailing_clause_punct(&strip_elongation_marks(next));
    if current_bare.is_empty()
        || next_bare.is_empty()
        || current_bare.contains(&next_bare)
        || next_bare.contains(&current_bare)
    {
        return false;
    }
    if unicode_scalars(&current_bare).len() < MIN_DISJOINT_CLAUSE_GRAPHEMES
        || unicode_scalars(&next_bare).len() < MIN_DISJOINT_CLAUSE_GRAPHEMES
    {
        return false;
    }
    if !is_japanese_source_text(&current_bare) || !is_japanese_source_text(&next_bare) {
        return false;
    }
    shared_grapheme_prefix_length(current, next) < MIN_OVERLAP_CHARS
}

fn should_append_disjoint_same_id_continuation(
    current: &CaptionPayload,
    next: &CaptionPayload,
) -> bool {
    if current.id != next.id || !is_source_stage_payload(current) || !is_source_stage_payload(next)
    {
        return false;
    }
    let current_started_at = started_at_of(current);
    let next_started_at = started_at_of(next);
    if current_started_at <= NO_TIME_MS
        || next_started_at <= NO_TIME_MS
        || current_started_at != next_started_at
    {
        return false;
    }
    should_append_disjoint_same_turn_surfaces(&current.source_text, &next.source_text)
}

fn is_parapper_turn_id(id: &str) -> bool {
    id.starts_with("parapper:")
}

fn merge_source_text(
    current: &CaptionPayload,
    next: &CaptionPayload,
    allow_no_overlap_suffix: bool,
) -> String {
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if current_text.is_empty() || next_text.is_empty() {
        return collapse_runaway_grapheme_runs(
            if next_text.is_empty() { current_text } else { next_text },
            MAX_IDENTICAL_KANJI_RUN,
        );
    }
    let parapper_turn = is_parapper_turn_id(&current.id) && current.id == next.id;
    if next_text.starts_with(current_text) {
        return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
    }
    if current_text.starts_with(next_text) {
        return collapse_runaway_grapheme_runs(current_text, MAX_IDENTICAL_KANJI_RUN);
    }
    let overlap = source_overlap_length(current_text, next_text);
    if overlap > 0 {
        return collapse_runaway_grapheme_runs(
            &format!("{current_text}{}", &next_text[overlap..]),
            MAX_IDENTICAL_KANJI_RUN,
        );
    }
    if ends_with_source_boundary(current_text) {
        return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
    }
    if parapper_turn {
        return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
    }
    if !allow_no_overlap_suffix
        || (!incomplete_source_ending(current_text)
            && !is_short_japanese_continuation(current, next)
            && !is_advancing_same_id_source(current, next))
    {
        return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
    }
    let separator = if ends_with_latin_alnum(current_text) && starts_with_latin_alnum(next_text) {
        " "
    } else {
        ""
    };
    if unicode_scalars(next_text).len() == 1 && current_text.ends_with(next_text) {
        return collapse_runaway_grapheme_runs(current_text, MAX_IDENTICAL_KANJI_RUN);
    }
    collapse_runaway_grapheme_runs(
        &format!("{current_text}{separator}{next_text}"),
        MAX_IDENTICAL_KANJI_RUN,
    )
}

fn merge_cross_id_source_text(current: &CaptionPayload, next: &CaptionPayload) -> String {
    if current.is_final == Some(true) {
        trim(&next.source_text).to_string()
    } else {
        merge_source_text(current, next, true)
    }
}

fn is_likely_cross_id_source_revision(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    if !is_source_stage_payload(current)
        || !is_source_stage_payload(next)
        || !has_text(&current.source_text)
        || !has_text(&next.source_text)
    {
        return false;
    }
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if next_text.starts_with(current_text)
        || current_text.starts_with(next_text)
        || source_overlap_length(current_text, next_text) > 0
    {
        return false;
    }
    let current_reading = trimmed_azookey_reading(current);
    let next_reading = trimmed_azookey_reading(next);
    !current_reading.is_empty() && current_reading == next_reading
}

/// Fold katakana to hiragana and NFKC-normalize an AzooKey reading.
pub fn normalize_azookey_reading(value: &str) -> String {
    let normalized = value.chars().collect::<String>();
    normalized
        .chars()
        .map(|character| {
            let code_point = character as u32;
            if (KATAKANA_START_CODE_POINT..=KATAKANA_END_CODE_POINT).contains(&code_point) {
                char::from_u32(code_point - KATAKANA_TO_HIRAGANA_OFFSET).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

fn trimmed_azookey_reading(caption: &CaptionPayload) -> String {
    caption
        .azookey_input_text
        .as_deref()
        .map(|value| normalize_azookey_reading(value.trim()))
        .unwrap_or_default()
}

fn is_unicode_punctuation_or_separator(character: char) -> bool {
    matches!(
        unicode_general_category::get_general_category(character),
        unicode_general_category::GeneralCategory::ConnectorPunctuation
            | unicode_general_category::GeneralCategory::DashPunctuation
            | unicode_general_category::GeneralCategory::OpenPunctuation
            | unicode_general_category::GeneralCategory::ClosePunctuation
            | unicode_general_category::GeneralCategory::InitialPunctuation
            | unicode_general_category::GeneralCategory::FinalPunctuation
            | unicode_general_category::GeneralCategory::OtherPunctuation
            | unicode_general_category::GeneralCategory::SpaceSeparator
            | unicode_general_category::GeneralCategory::LineSeparator
            | unicode_general_category::GeneralCategory::ParagraphSeparator
    ) || character.is_whitespace()
}

fn punctuation_insensitive_source(caption: &CaptionPayload) -> String {
    trim(&caption.source_text)
        .chars()
        .filter(|character| !is_unicode_punctuation_or_separator(*character))
        .collect()
}

fn has_equivalent_translation_source(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_source = punctuation_insensitive_source(current);
    let next_source = punctuation_insensitive_source(next);
    !current_source.is_empty() && current_source == next_source
}

fn is_same_turn_source_continuation(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_source = punctuation_insensitive_source(current);
    let next_source = punctuation_insensitive_source(next);
    !current_source.is_empty()
        && !next_source.is_empty()
        && (current_source.starts_with(&next_source) || next_source.starts_with(&current_source))
}

fn is_newer_final_translation_revision(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    sequence_of(current) >= TRANSLATION_SEQUENCE
        && sequence_of(next) >= TRANSLATION_SEQUENCE
        && next.is_final == Some(true)
        && has_equivalent_translation_source(current, next)
        && received_at_of(next) >= received_at_of(current)
}

fn has_same_or_extended_azookey_reading(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_reading = trimmed_azookey_reading(current);
    let next_reading = trimmed_azookey_reading(next);
    !current_reading.is_empty()
        && !next_reading.is_empty()
        && (next_reading == current_reading || next_reading.starts_with(&current_reading))
}

fn is_progressive_provisional_extension(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    if next.provisional != Some(true)
        || current.id != next.id
        || !is_source_stage_payload(current)
        || !is_source_stage_payload(next)
        || !has_text(&current.source_text)
        || !has_text(&next.source_text)
    {
        return false;
    }
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    let current_reading = trimmed_azookey_reading(current);
    let next_reading = trimmed_azookey_reading(next);
    if !current_reading.is_empty() && !next_reading.is_empty() {
        if next_reading.starts_with(&current_reading) && next_reading != current_reading {
            return true;
        }
        if next_reading == current_reading {
            return false;
        }
    }
    if is_stale_shorter_caption_surface(current_text, next_text) {
        return true;
    }
    if is_shorter_same_utterance_surface(next_text, current_text) {
        return true;
    }
    if should_append_disjoint_same_id_continuation(current, next) {
        return true;
    }
    next_text.starts_with(current_text) && next_text != current_text
}

fn is_stale_normalized_against_provisional(
    current: &CaptionPayload,
    next: &CaptionPayload,
) -> bool {
    if current.provisional != Some(true)
        || next.provisional == Some(true)
        || !is_source_stage_payload(current)
        || !is_source_stage_payload(next)
        || !has_text(&current.source_text)
        || !has_text(&next.source_text)
    {
        return false;
    }
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if unicode_scalars(current_text).len() <= unicode_scalars(next_text).len() {
        return false;
    }
    let current_reading = trimmed_azookey_reading(current);
    let next_reading = trimmed_azookey_reading(next);
    if !current_reading.is_empty() && !next_reading.is_empty() {
        return current_reading.starts_with(&next_reading) && current_reading != next_reading;
    }
    if current_text.starts_with(next_text) && current_text != next_text {
        return true;
    }
    is_much_shorter_surface(next_text, current_text)
}

fn is_much_shorter_surface(incoming: &str, painted: &str) -> bool {
    unicode_scalars(incoming).len() * 2 < unicode_scalars(painted).len()
}

fn shared_grapheme_prefix_length(left: &str, right: &str) -> usize {
    let left_chars = unicode_scalars(left);
    let right_chars = unicode_scalars(right);
    left_chars.iter().zip(right_chars.iter()).take_while(|(left, right)| left == right).count()
}

fn is_longer_same_utterance_revision(current_text: &str, next_text: &str) -> bool {
    let current_chars = unicode_scalars(current_text);
    let next_chars = unicode_scalars(next_text);
    if next_chars.len() <= current_chars.len() || current_chars.is_empty() {
        return false;
    }
    let shared = shared_grapheme_prefix_length(current_text, next_text);
    shared >= MIN_OVERLAP_CHARS.max(current_chars.len().div_ceil(2))
}

fn is_longer_surface_continuation(current_text: &str, next_text: &str) -> bool {
    let current_chars = unicode_scalars(current_text);
    let next_chars = unicode_scalars(next_text);
    if next_chars.len() <= current_chars.len() || current_chars.is_empty() {
        return false;
    }
    if next_text.starts_with(current_text) {
        return true;
    }
    let shared = shared_grapheme_prefix_length(current_text, next_text);
    if shared < MIN_OVERLAP_CHARS {
        return false;
    }
    let rem_current = &current_chars[shared..];
    let rem_next = &next_chars[shared..];
    let max_rewrite = INDEX_STEP.max(
        MAX_PAINTED_HEAD_REWRITE_CHARS
            .min(current_chars.len().div_ceil(PAINTED_HEAD_REWRITE_DENOMINATOR)),
    );
    let mut drop_current = 0;
    while drop_current <= max_rewrite.min(rem_current.len()) {
        let mut drop_next = 0;
        while drop_next <= max_rewrite.min(rem_next.len()) {
            if drop_current != 0 || drop_next != 0 {
                let rest_current: String = rem_current[drop_current..].iter().collect();
                let rest_next: String = rem_next[drop_next..].iter().collect();
                if rest_current.is_empty() || rest_next.starts_with(&rest_current) {
                    return true;
                }
            }
            drop_next += INDEX_STEP;
        }
        drop_current += INDEX_STEP;
    }
    false
}

/// True when `incoming` is a shorter truncated rewrite of already-painted `painted`.
pub fn is_truncated_caption_rewrite(incoming: &str, painted: &str) -> bool {
    let next_text = incoming.trim();
    let current_text = painted.trim();
    if next_text.is_empty() || current_text.is_empty() {
        return false;
    }
    is_longer_surface_continuation(next_text, current_text)
}

/// True when `incoming` is a prefix cut or a much shorter conversion of `painted`.
pub fn is_stale_shorter_caption_surface(incoming: &str, painted: &str) -> bool {
    let next_text = incoming.trim();
    let current_text = painted.trim();
    if next_text.is_empty()
        || current_text.is_empty()
        || unicode_scalars(next_text).len() >= unicode_scalars(current_text).len()
    {
        return false;
    }
    is_truncated_caption_rewrite(next_text, current_text)
        || is_much_shorter_surface(next_text, current_text)
}

/// True when `incoming` is a shorter suffix of `painted`.
pub fn is_shorter_suffix_surface(incoming: &str, painted: &str) -> bool {
    let next_text = incoming.trim();
    let current_text = painted.trim();
    if next_text.is_empty()
        || current_text.is_empty()
        || unicode_scalars(next_text).len() >= unicode_scalars(current_text).len()
    {
        return false;
    }
    current_text.ends_with(next_text)
}

/// Same-utterance ASR that dropped an already-painted tail.
pub fn is_shorter_same_utterance_surface(incoming: &str, painted: &str) -> bool {
    is_stale_shorter_caption_surface(incoming, painted)
        || is_shorter_suffix_surface(incoming, painted)
}

fn stitch_converted_head_with_painted_tail(shorter: &str, longer: &str) -> Option<String> {
    if shorter.is_empty()
        || longer.is_empty()
        || unicode_scalars(longer).len() <= unicode_scalars(shorter).len()
    {
        return None;
    }
    if longer.starts_with(shorter) {
        return Some(longer.to_string());
    }
    if !is_longer_surface_continuation(shorter, longer) {
        return None;
    }
    let shorter_chars = unicode_scalars(shorter);
    let longer_chars = unicode_scalars(longer);
    let shared = shared_grapheme_prefix_length(shorter, longer);
    let rem_shorter = &shorter_chars[shared..];
    let rem_longer = &longer_chars[shared..];
    let max_rewrite = INDEX_STEP.max(
        MAX_PAINTED_HEAD_REWRITE_CHARS
            .min(shorter_chars.len().div_ceil(PAINTED_HEAD_REWRITE_DENOMINATOR)),
    );
    let mut drop_shorter = 0;
    while drop_shorter <= max_rewrite.min(rem_shorter.len()) {
        let mut drop_longer = 0;
        while drop_longer <= max_rewrite.min(rem_longer.len()) {
            if drop_shorter != 0 || drop_longer != 0 {
                let rest_shorter: String = rem_shorter[drop_shorter..].iter().collect();
                let rest_longer: String = rem_longer[drop_longer..].iter().collect();
                if rest_shorter.is_empty() {
                    return Some(longer.to_string());
                }
                if rest_longer.starts_with(&rest_shorter) {
                    return Some(format!("{shorter}{}", &rest_longer[rest_shorter.len()..]));
                }
            }
            drop_longer += INDEX_STEP;
        }
        drop_shorter += INDEX_STEP;
    }
    Some(longer.to_string())
}

fn is_stale_non_final_after_final(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if next_text.is_empty() {
        return true;
    }
    if next_text.starts_with(current_text) && next_text != current_text {
        return false;
    }
    if should_append_disjoint_same_id_continuation(current, next) {
        return false;
    }
    let current_reading = trimmed_azookey_reading(current);
    let next_reading = trimmed_azookey_reading(next);
    if !current_reading.is_empty() && !next_reading.is_empty() {
        if next_reading.starts_with(&current_reading) && next_reading != current_reading {
            return false;
        }
        if next_reading == current_reading
            && is_longer_same_utterance_revision(current_text, next_text)
            && next_text != next_reading
        {
            return false;
        }
        return true;
    }
    !is_longer_surface_continuation(current_text, next_text)
}

fn merge_same_id_source_text(current: &CaptionPayload, next: &CaptionPayload) -> String {
    let current_text = trim(&current.source_text);
    let next_text = trim(&next.source_text);
    if is_source_stage_payload(current)
        && is_source_stage_payload(next)
        && has_text(current_text)
        && has_text(next_text)
        && is_shorter_suffix_surface(next_text, current_text)
    {
        return collapse_runaway_grapheme_runs(current_text, MAX_IDENTICAL_KANJI_RUN);
    }
    if should_append_disjoint_same_id_continuation(current, next) {
        return append_disjoint_continuation(current_text, next_text);
    }
    if next.is_final == Some(true) && is_source_stage_payload(next) && has_text(&next.source_text) {
        if should_keep_surface_over_short_ack(current, next) {
            return collapse_runaway_grapheme_runs(current_text, MAX_IDENTICAL_KANJI_RUN);
        }
        if let Some(stitched) = stitch_converted_head_with_painted_tail(next_text, current_text) {
            return collapse_runaway_grapheme_runs(&stitched, MAX_IDENTICAL_KANJI_RUN);
        }
        if current.provisional == Some(true) && is_much_shorter_surface(next_text, current_text) {
            return collapse_runaway_grapheme_runs(current_text, MAX_IDENTICAL_KANJI_RUN);
        }
        return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
    }
    if is_source_stage_payload(next)
        && has_text(&next.source_text)
        && has_text(&current.source_text)
    {
        if let Some(stitched) = stitch_converted_head_with_painted_tail(next_text, current_text) {
            if unicode_scalars(&stitched).len() > unicode_scalars(next_text).len() {
                return collapse_runaway_grapheme_runs(&stitched, MAX_IDENTICAL_KANJI_RUN);
            }
        }
        if next.provisional == Some(true)
            && is_stale_shorter_caption_surface(current_text, next_text)
        {
            return collapse_runaway_grapheme_runs(next_text, MAX_IDENTICAL_KANJI_RUN);
        }
    }
    if current.id == next.id
        && current.provisional == Some(true)
        && next.provisional != Some(true)
        && is_source_stage_payload(current)
        && is_source_stage_payload(next)
    {
        if is_stale_normalized_against_provisional(current, next) {
            return current.source_text.clone();
        }
        return next.source_text.clone();
    }
    if has_same_or_extended_azookey_reading(current, next) {
        let current_reading = trimmed_azookey_reading(current);
        let next_reading = trimmed_azookey_reading(next);
        if !current_text.is_empty()
            && !next_text.is_empty()
            && unicode_scalars(current_text).len() > unicode_scalars(next_text).len()
            && !current_reading.is_empty()
            && !next_reading.is_empty()
            && current_reading.starts_with(&next_reading)
            && current_reading != next_reading
        {
            return current_text.to_string();
        }
        return next.source_text.clone();
    }
    let current_started_at = started_at_of(current);
    let next_started_at = started_at_of(next);
    let gap = next_started_at - current_started_at;
    merge_source_text(
        current,
        next,
        next_started_at > current_started_at && gap <= SOURCE_CONTINUATION_GAP_MS,
    )
}

fn can_merge_cross_id_source(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    let both_unset = started_at_of(current) == NO_TIME_MS && started_at_of(next) == NO_TIME_MS;
    let both_parapper_turns =
        current.id.starts_with("parapper:") && next.id.starts_with("parapper:");
    let related = has_lexical_source_continuation(current, next)
        || has_same_or_extended_azookey_reading(current, next);
    if related && both_parapper_turns {
        return false;
    }
    if related {
        return has_close_source_timing(current, next) || both_unset;
    }
    if both_parapper_turns {
        return false;
    }
    has_close_source_timing(current, next)
}

fn is_newer_source_revision(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    if !is_source_stage_payload(next) || !has_text(&next.source_text) {
        return false;
    }
    if trim(&next.source_text) == trim(&current.source_text) {
        return false;
    }
    !is_older_same_id_revision(current, next)
}

fn is_out_of_order(current: &CaptionPayload, next: &CaptionPayload) -> bool {
    if current.id == next.id {
        if current.provisional == Some(true)
            && next.provisional != Some(true)
            && is_source_stage_payload(next)
        {
            if next.is_final == Some(true) {
                return false;
            }
            return is_stale_normalized_against_provisional(current, next);
        }
        if current.provisional != Some(true)
            && next.provisional == Some(true)
            && has_text(&current.source_text)
            && is_source_stage_payload(next)
        {
            if current.is_final == Some(true) {
                return is_stale_non_final_after_final(current, next);
            }
            return !is_progressive_provisional_extension(current, next);
        }
        if current.provisional == Some(true)
            && next.provisional == Some(true)
            && is_source_stage_payload(current)
            && is_source_stage_payload(next)
            && has_text(&current.source_text)
            && has_text(&next.source_text)
        {
            let current_text = trim(&current.source_text);
            let next_text = trim(&next.source_text);
            if next_text != current_text
                && is_much_shorter_surface(next_text, current_text)
                && !should_append_disjoint_same_id_continuation(current, next)
            {
                return true;
            }
        }
        let next_sequence = sequence_of(next);
        let current_sequence = sequence_of(current);
        if is_newer_final_translation_revision(current, next) {
            return false;
        }
        if current_sequence == SOURCE_SEQUENCE
            && next_sequence == SOURCE_SEQUENCE
            && current.is_final == Some(true)
            && next.is_final != Some(true)
            && is_source_stage_payload(current)
            && is_source_stage_payload(next)
        {
            return is_stale_non_final_after_final(current, next);
        }
        if current_sequence == SOURCE_SEQUENCE
            && next_sequence == SOURCE_SEQUENCE
            && next.is_final == Some(true)
            && is_source_stage_payload(current)
            && is_source_stage_payload(next)
        {
            if current.is_final == Some(true) {
                let current_text = trim(&current.source_text);
                let next_text = trim(&next.source_text);
                if !has_text(next_text) {
                    return true;
                }
                if next_text == current_text
                    || current_text.starts_with(next_text)
                    || is_longer_surface_continuation(current_text, next_text)
                {
                    return false;
                }
                return is_older_same_id_revision(current, next);
            }
            return false;
        }
        if next_sequence > current_sequence {
            return false;
        }
        if next_sequence == current_sequence {
            let source_changed = next_sequence == SOURCE_SEQUENCE
                && has_text(&current.source_text)
                && has_text(&next.source_text)
                && trim(&current.source_text) != trim(&next.source_text);
            if source_changed {
                return is_older_same_id_revision(current, next);
            }
            return next_sequence >= TRANSLATION_SEQUENCE
                && is_older_same_id_revision(current, next);
        }
        return !is_newer_source_revision(current, next);
    }
    if current.id.starts_with("parapper:")
        && next.id.starts_with("parapper:")
        && current.id != next.id
    {
        return received_at_of(next) < received_at_of(current);
    }
    let current_started_at = started_at_of(current);
    let next_started_at = started_at_of(next);
    if current_started_at > NO_TIME_MS && next_started_at > NO_TIME_MS {
        if next_started_at < current_started_at {
            return true;
        }
        if next_started_at == current_started_at && received_at_of(next) < received_at_of(current) {
            return true;
        }
        return false;
    }
    received_at_of(next) < received_at_of(current)
}

/// True when two captions would paint the same visible subtitle content.
pub fn captions_display_equal(left: &CaptionPayload, right: &CaptionPayload) -> bool {
    left.id == right.id
        && left.source_text == right.source_text
        && left.translation_text == right.translation_text
        && left.stage == right.stage
        && left.sequence == right.sequence
        && left.is_final == right.is_final
        && left.is_provisional() == right.is_provisional()
}

/// Merge progressive caption events into the live slot.
pub fn merge_caption_payload(
    current: &CaptionPayload,
    incoming: &CaptionPayload,
) -> Option<CaptionPayload> {
    if !has_text(&incoming.source_text) && !has_text(&incoming.translation_text) {
        return None;
    }
    let same_chunk = current.id == incoming.id;
    let has_incoming_source = has_text(&incoming.source_text);
    let has_incoming_translation = has_text(&incoming.translation_text);
    let incoming_is_translation_payload = sequence_of(incoming) >= TRANSLATION_SEQUENCE;
    let cross_id_translation =
        !same_chunk && incoming_is_translation_payload && has_incoming_translation;
    if cross_id_translation {
        save_pending_caption_translation(incoming);
        if !has_incoming_source {
            return Some(current.clone());
        }
    }
    if is_out_of_order(current, incoming) {
        return None;
    }
    if should_keep_surface_over_short_ack(current, incoming) {
        return None;
    }
    if cross_id_translation {
        return Some(current.clone());
    }
    let incoming_is_translation = incoming.stage == Some(CaptionStage::Translation)
        || sequence_of(incoming) > sequence_of(current);
    let source_changed = has_text(&current.source_text)
        && has_incoming_source
        && trim(&current.source_text) != trim(&incoming.source_text);
    if same_chunk
        && current.stage == Some(CaptionStage::Source)
        && incoming_is_translation
        && has_incoming_translation
        && source_changed
        && !has_equivalent_translation_source(current, incoming)
    {
        if is_same_turn_source_continuation(current, incoming) {
            if has_text(&current.translation_text) {
                return Some(current.clone());
            }
            let mut kept = current.clone();
            kept.translation_text = incoming.translation_text.clone();
            return Some(kept);
        }
        return Some(current.clone());
    }
    if !same_chunk && !has_incoming_source {
        return Some(current.clone());
    }
    let merged_source_text = if !has_incoming_source {
        current.source_text.clone()
    } else if same_chunk {
        merge_same_id_source_text(current, incoming)
    } else if should_append_close_disjoint_turn_continuation(current, incoming) {
        append_disjoint_continuation(&current.source_text, &incoming.source_text)
    } else if is_source_stage_payload(incoming)
        && is_likely_cross_id_source_revision(current, incoming)
    {
        collapse_runaway_grapheme_runs(trim(&incoming.source_text), MAX_IDENTICAL_KANJI_RUN)
    } else if is_source_stage_payload(incoming) && can_merge_cross_id_source(current, incoming) {
        merge_cross_id_source_text(current, incoming)
    } else {
        collapse_runaway_grapheme_runs(&incoming.source_text, MAX_IDENTICAL_KANJI_RUN)
    };
    let current_source = trim(&current.source_text);
    let next_source = trim(&merged_source_text);
    let incoming_source = trim(&incoming.source_text);
    let source_keeps_translation = current_source.is_empty()
        || next_source.is_empty()
        || next_source == current_source
        || next_source.starts_with(current_source)
        || has_equivalent_translation_source(current, incoming);
    let mut merged = incoming.clone();
    merged.source_text = merged_source_text.clone();
    merged.translation_text = if same_chunk {
        if has_incoming_translation {
            incoming.translation_text.clone()
        } else if source_keeps_translation {
            current.translation_text.clone()
        } else {
            String::new()
        }
    } else if has_incoming_translation {
        incoming.translation_text.clone()
    } else {
        String::new()
    };
    if incoming.stage.is_none() {
        merged.stage = current.stage;
    }
    if incoming.sequence.is_none() {
        merged.sequence = current.sequence;
    }
    if incoming.azookey_input_text.is_none() {
        merged.azookey_input_text = current.azookey_input_text.clone();
    }
    if incoming.sentence_end_offsets.is_none() {
        merged.sentence_end_offsets = current.sentence_end_offsets.clone();
    }
    if incoming.soft_break_offsets.is_none() {
        merged.soft_break_offsets = current.soft_break_offsets.clone();
    }
    if incoming.capture_generation.is_none() {
        merged.capture_generation = current.capture_generation;
    }
    if incoming.provisional == Some(true) {
        merged.provisional = Some(true);
    } else if current.provisional == Some(true)
        && next_source == trim(&current.source_text)
        && has_incoming_source
        && next_source.len() > incoming_source.len()
    {
        merged.provisional = Some(true);
    } else {
        merged.provisional = None;
    }
    if has_incoming_source
        && next_source.len() > incoming_source.len()
        && next_source != incoming_source
    {
        let kept_current_surface = trim(&current.source_text) == next_source;
        if current.sentence_end_offsets.as_ref().is_some_and(|offsets| !offsets.is_empty())
            && kept_current_surface
        {
            merged.sentence_end_offsets = current.sentence_end_offsets.clone();
        } else {
            merged.sentence_end_offsets = None;
        }
        if current.soft_break_offsets.as_ref().is_some_and(|offsets| !offsets.is_empty())
            && kept_current_surface
        {
            merged.soft_break_offsets = current.soft_break_offsets.clone();
        } else {
            merged.soft_break_offsets = None;
        }
        if kept_current_surface {
            let current_reading = trimmed_azookey_reading(current);
            let incoming_reading = trimmed_azookey_reading(incoming);
            if !current_reading.is_empty()
                && (incoming_reading.is_empty()
                    || unicode_scalars(&current_reading).len()
                        >= unicode_scalars(&incoming_reading).len())
            {
                if let Some(reading) = current.azookey_input_text.clone() {
                    merged.azookey_input_text = Some(reading);
                }
            }
        }
    } else if has_incoming_source && next_source == incoming_source && next_source != current_source
    {
        if incoming.sentence_end_offsets.as_ref().is_none_or(|offsets| offsets.is_empty()) {
            merged.sentence_end_offsets = None;
        }
        if incoming.soft_break_offsets.as_ref().is_none_or(|offsets| offsets.is_empty()) {
            merged.soft_break_offsets = None;
        }
    }
    if incoming.is_final == Some(true) {
        merged.is_final = Some(true);
    } else if current.is_final == Some(true)
        && has_incoming_source
        && is_source_stage_payload(incoming)
        && trim(&merged_source_text) != trim(&current.source_text)
    {
        merged.is_final = Some(false);
    } else if incoming.is_final == Some(false) {
        merged.is_final = Some(false);
    } else {
        merged.is_final = current.is_final;
    }
    if captions_display_equal(current, &merged) {
        return Some(current.clone());
    }
    Some(merged)
}

#[cfg(test)]
mod tests {
    use super::{
        captions_display_equal, clear_caption_merge_diagnostics, get_caption_merge_diagnostics,
        is_shorter_same_utterance_surface, is_shorter_suffix_surface,
        is_stale_shorter_caption_surface, is_truncated_caption_rewrite, merge_caption_payload,
        normalize_azookey_reading, should_append_disjoint_same_turn_surfaces,
        take_pending_caption_translation, CaptionMergeDiagnostics,
    };
    use crate::payload::{CaptionPayload, CaptionStage};

    fn caption(
        id: &str,
        source_text: &str,
        translation_text: &str,
        started_at: i64,
        received_at: i64,
    ) -> CaptionPayload {
        CaptionPayload {
            id: id.to_string(),
            source_text: source_text.to_string(),
            azookey_input_text: None,
            translation_text: translation_text.to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at,
            received_at,
            stage: None,
            sequence: None,
            is_final: None,
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        }
    }

    fn source(
        id: &str,
        source_text: &str,
        started_at: i64,
        received_at: i64,
        is_final: bool,
    ) -> CaptionPayload {
        let mut payload = caption(id, source_text, "", started_at, received_at);
        payload.stage = Some(CaptionStage::Source);
        payload.sequence = Some(0);
        payload.is_final = Some(is_final);
        payload
    }

    fn translation(
        id: &str,
        source_text: &str,
        translation_text: &str,
        started_at: i64,
        received_at: i64,
        is_final: bool,
    ) -> CaptionPayload {
        let mut payload = caption(id, source_text, translation_text, started_at, received_at);
        payload.stage = Some(CaptionStage::Translation);
        payload.sequence = Some(1);
        payload.is_final = Some(is_final);
        payload
    }

    #[test]
    fn keeps_recognized_source_immediately_and_merges_translation_by_utterance_id() {
        clear_caption_merge_diagnostics();
        let first = caption("u-1", "こんにちは", "", 1, 1);
        let translated = caption("u-1", "こんにちは", "Hello", 1, 2);
        let staged = merge_caption_payload(&first, &translated).expect("merged");
        assert_eq!(staged.translation_text, "Hello");
        assert_eq!(staged.received_at, 2);
        assert_eq!(staged.source_text, "こんにちは");
    }

    #[test]
    fn keeps_a_completed_same_turn_translation_when_a_newer_source_revision_raced_it() {
        clear_caption_merge_diagnostics();
        let newer_source = source("parapper:session:turn:9", "今日は晴れです", 1_000, 1_400, false);
        let late_translation = translation(
            "parapper:session:turn:9",
            "今日は晴れ",
            "It is sunny today",
            1_000,
            1_300,
            true,
        );
        let merged = merge_caption_payload(&newer_source, &late_translation).expect("merged");
        assert_eq!(merged.source_text, "今日は晴れです");
        assert_eq!(merged.translation_text, "It is sunny today");
    }

    #[test]
    fn keeps_incoming_translation_when_a_new_sequence_0_chunk_already_carries_both_texts() {
        clear_caption_merge_diagnostics();
        let current = source("parapper:session:turn:1", "昨日は雨", 1, 10, false);
        let mut next = source("parapper:session:turn:2", "今日は晴れ", 2, 20, false);
        next.translation_text = "It is sunny today".to_string();
        let merged = merge_caption_payload(&current, &next).expect("merged");
        assert_eq!(merged.id, "parapper:session:turn:2");
        assert_eq!(merged.source_text, "今日は晴れ");
        assert_eq!(merged.translation_text, "It is sunny today");
    }

    #[test]
    fn shows_source_with_empty_translation_for_a_new_caption_id() {
        clear_caption_merge_diagnostics();
        let previous = caption("preview", "preview", "Preview", 1, 1);
        let source_only = caption("u-live", "音声認識結果", "", 10, 10);
        let merged = merge_caption_payload(&previous, &source_only).expect("merged");
        assert_eq!(merged.id, "u-live");
        assert_eq!(merged.source_text, "音声認識結果");
        assert_eq!(merged.translation_text, "");
    }

    #[test]
    fn preserves_a_cross_id_translation_only_payload_without_attaching_it_to_the_newer_source() {
        clear_caption_merge_diagnostics();
        let current = source("chunk-2", "明日の天気は晴れ", 1_640, 1_640, false);
        let late_translation =
            translation("chunk-1", "", "The weather tomorrow", 1_000, 1_700, true);
        let merged = merge_caption_payload(&current, &late_translation).expect("current");
        assert_eq!(merged.id, "chunk-2");
        assert_eq!(merged.source_text, "明日の天気は晴れ");
        assert_eq!(
            get_caption_merge_diagnostics(),
            CaptionMergeDiagnostics {
                cross_id_translation_ids_saved: 1,
                pending_cross_id_translations: 1,
            }
        );
        let pending = take_pending_caption_translation("chunk-1").expect("pending");
        assert_eq!(pending.translation_text, "The weather tomorrow");
        assert_eq!(get_caption_merge_diagnostics().pending_cross_id_translations, 0);
    }

    #[test]
    fn keeps_a_future_source_bearing_translation_out_of_the_current_live_slot() {
        clear_caption_merge_diagnostics();
        let current = source("chunk-1", "明日の天気は", 1_000, 1_000, false);
        let early_translation = translation(
            "chunk-2",
            "明日の天気は晴れ",
            "The weather tomorrow is sunny",
            1_640,
            1_650,
            true,
        );
        let merged = merge_caption_payload(&current, &early_translation).expect("current");
        assert_eq!(merged.id, "chunk-1");
        let pending = take_pending_caption_translation("chunk-2").expect("pending");
        assert_eq!(pending.translation_text, "The weather tomorrow is sunny");
    }

    #[test]
    fn returns_null_when_a_pending_translation_id_is_unknown() {
        clear_caption_merge_diagnostics();
        assert!(take_pending_caption_translation("missing-translation").is_none());
    }

    #[test]
    fn stores_a_translation_that_arrives_before_its_newer_source_caption() {
        clear_caption_merge_diagnostics();
        let current = source("chunk-1", "明日の天気は", 1_000, 1_000, false);
        let early_translation =
            translation("chunk-2", "", "The weather tomorrow is sunny", 1_640, 1_650, true);
        let merged = merge_caption_payload(&current, &early_translation).expect("current");
        assert_eq!(merged.id, "chunk-1");
        assert_eq!(
            take_pending_caption_translation("chunk-2").expect("pending").translation_text,
            "The weather tomorrow is sunny"
        );
    }

    fn store_pending(current: &CaptionPayload, id: &str, translation_text: &str, at: i64) {
        assert!(merge_caption_payload(
            current,
            &translation(id, "", translation_text, at, at, true)
        )
        .is_some());
    }

    #[test]
    fn evicts_the_oldest_cross_id_translation_when_the_bounded_side_channel_is_full() {
        clear_caption_merge_diagnostics();
        let current = source("current", "表示中の文", 10_000, 10_000, false);
        store_pending(&current, "pending-0", "translation-0", 1);
        store_pending(&current, "pending-1", "translation-1", 2);
        store_pending(&current, "pending-2", "translation-2", 3);
        store_pending(&current, "pending-3", "translation-3", 4);
        store_pending(&current, "pending-4", "translation-4", 5);
        store_pending(&current, "pending-5", "translation-5", 6);
        store_pending(&current, "pending-6", "translation-6", 7);
        store_pending(&current, "pending-7", "translation-7", 8);
        store_pending(&current, "pending-8", "translation-8", 9);
        store_pending(&current, "pending-9", "translation-9", 10);
        store_pending(&current, "pending-10", "translation-10", 11);
        store_pending(&current, "pending-11", "translation-11", 12);
        store_pending(&current, "pending-12", "translation-12", 13);
        store_pending(&current, "pending-13", "translation-13", 14);
        store_pending(&current, "pending-14", "translation-14", 15);
        store_pending(&current, "pending-15", "translation-15", 16);
        store_pending(&current, "pending-16", "translation-16", 17);
        store_pending(&current, "pending-17", "translation-17", 18);
        store_pending(&current, "pending-18", "translation-18", 19);
        store_pending(&current, "pending-19", "translation-19", 20);
        store_pending(&current, "pending-20", "translation-20", 21);
        store_pending(&current, "pending-21", "translation-21", 22);
        store_pending(&current, "pending-22", "translation-22", 23);
        store_pending(&current, "pending-23", "translation-23", 24);
        store_pending(&current, "pending-24", "translation-24", 25);
        store_pending(&current, "pending-25", "translation-25", 26);
        store_pending(&current, "pending-26", "translation-26", 27);
        store_pending(&current, "pending-27", "translation-27", 28);
        store_pending(&current, "pending-28", "translation-28", 29);
        store_pending(&current, "pending-29", "translation-29", 30);
        store_pending(&current, "pending-30", "translation-30", 31);
        store_pending(&current, "pending-31", "translation-31", 32);
        store_pending(&current, "pending-32", "translation-32", 33);
        store_pending(&current, "pending-33", "translation-33", 34);
        store_pending(&current, "pending-34", "translation-34", 35);
        store_pending(&current, "pending-35", "translation-35", 36);
        store_pending(&current, "pending-36", "translation-36", 37);
        store_pending(&current, "pending-37", "translation-37", 38);
        store_pending(&current, "pending-38", "translation-38", 39);
        store_pending(&current, "pending-39", "translation-39", 40);
        store_pending(&current, "pending-40", "translation-40", 41);
        store_pending(&current, "pending-41", "translation-41", 42);
        store_pending(&current, "pending-42", "translation-42", 43);
        store_pending(&current, "pending-43", "translation-43", 44);
        store_pending(&current, "pending-44", "translation-44", 45);
        store_pending(&current, "pending-45", "translation-45", 46);
        store_pending(&current, "pending-46", "translation-46", 47);
        store_pending(&current, "pending-47", "translation-47", 48);
        store_pending(&current, "pending-48", "translation-48", 49);
        store_pending(&current, "pending-49", "translation-49", 50);
        store_pending(&current, "pending-50", "translation-50", 51);
        store_pending(&current, "pending-51", "translation-51", 52);
        store_pending(&current, "pending-52", "translation-52", 53);
        store_pending(&current, "pending-53", "translation-53", 54);
        store_pending(&current, "pending-54", "translation-54", 55);
        store_pending(&current, "pending-55", "translation-55", 56);
        store_pending(&current, "pending-56", "translation-56", 57);
        store_pending(&current, "pending-57", "translation-57", 58);
        store_pending(&current, "pending-58", "translation-58", 59);
        store_pending(&current, "pending-59", "translation-59", 60);
        store_pending(&current, "pending-60", "translation-60", 61);
        store_pending(&current, "pending-61", "translation-61", 62);
        store_pending(&current, "pending-62", "translation-62", 63);
        store_pending(&current, "pending-63", "translation-63", 64);
        store_pending(&current, "pending-64", "translation-64", 65);
        assert_eq!(
            get_caption_merge_diagnostics(),
            CaptionMergeDiagnostics {
                cross_id_translation_ids_saved: 65,
                pending_cross_id_translations: 64,
            }
        );
        assert!(take_pending_caption_translation("pending-0").is_none());
        assert_eq!(
            take_pending_caption_translation("pending-1").expect("kept").translation_text,
            "translation-1"
        );
    }

    #[test]
    fn paints_the_first_source_caption_after_a_reset_when_current_is_the_empty_placeholder() {
        clear_caption_merge_diagnostics();
        let empty = source("empty", "", 0, 0, false);
        let first_source = source("u-first", "最初の発話", 1_000, 1_000, false);
        let merged = merge_caption_payload(&empty, &first_source).expect("first");
        assert_eq!(merged.id, "u-first");
        assert_eq!(merged.source_text, "最初の発話");
        assert_eq!(get_caption_merge_diagnostics().cross_id_translation_ids_saved, 0);
    }

    #[test]
    fn preserves_a_source_plus_translation_payload_in_the_side_channel_when_current_is_empty() {
        clear_caption_merge_diagnostics();
        let empty = source("empty", "", 0, 0, false);
        let first_with_translation =
            translation("u-first", "最初の発話", "First utterance", 1_000, 1_000, true);
        let merged = merge_caption_payload(&empty, &first_with_translation).expect("empty");
        assert_eq!(merged.id, "empty");
        assert_eq!(
            take_pending_caption_translation("u-first").expect("pending").translation_text,
            "First utterance"
        );
    }

    #[test]
    fn does_not_save_a_cross_id_translation_with_an_empty_or_whitespace_id() {
        clear_caption_merge_diagnostics();
        let current = source("live", "表示中", 5_000, 5_000, false);
        let empty_id = translation("", "", "No id", 1_000, 5_100, true);
        let whitespace_id = translation("   ", "", "Whitespace id", 1_000, 5_200, true);
        assert_eq!(merge_caption_payload(&current, &empty_id).expect("kept").id, "live");
        assert_eq!(merge_caption_payload(&current, &whitespace_id).expect("kept").id, "live");
        assert_eq!(
            get_caption_merge_diagnostics(),
            CaptionMergeDiagnostics {
                cross_id_translation_ids_saved: 0,
                pending_cross_id_translations: 0,
            }
        );
        assert!(take_pending_caption_translation("").is_none());
        assert!(take_pending_caption_translation("   ").is_none());
    }

    #[test]
    fn does_not_clear_the_live_caption_on_silence_soft_skip() {
        clear_caption_merge_diagnostics();
        let live = caption("u-1", "こんにちは", "Hello", 1, 1);
        let silence = caption("silence-1", "", "", 0, 0);
        assert!(merge_caption_payload(&live, &silence).is_none());
    }

    #[test]
    fn drops_an_unchanged_late_same_id_source_stage_result_after_translation_landed() {
        clear_caption_merge_diagnostics();
        let translated = translation("u-1", "こんにちは", "Hello", 1, 20, true);
        let late_source = source("u-1", "こんにちは", 1, 10, false);
        assert!(merge_caption_payload(&translated, &late_source).is_none());
    }

    #[test]
    fn merges_punctuation_only_translation_revisions_when_readings_differ() {
        clear_caption_merge_diagnostics();
        let mut provisional = source("u-1", "もう一度", 1, 10, false);
        provisional.azookey_input_text = Some("もういち度".to_string());
        provisional.provisional = Some(true);
        let mut translated = translation("u-1", "もう一度。", "Once more.", 1, 20, true);
        translated.azookey_input_text = Some("もういちど".to_string());
        let merged = merge_caption_payload(&provisional, &translated).expect("merged");
        assert_eq!(merged.source_text, "もう一度。");
        assert_eq!(merged.translation_text, "Once more.");
        assert_eq!(merged.stage, Some(CaptionStage::Translation));
    }

    #[test]
    fn accepts_a_newer_final_translation_when_completion_backdates_a_punctuation_only_revision() {
        clear_caption_merge_diagnostics();
        let mut interim = translation(
            "u-backdated-translation",
            "今日は晴れです...",
            "It is sunny today...",
            200,
            300,
            false,
        );
        interim.azookey_input_text = Some("きょうははれです...".to_string());
        let mut translated_final = translation(
            "u-backdated-translation",
            "今日は晴れです。",
            "It is sunny today.",
            100,
            400,
            true,
        );
        translated_final.azookey_input_text = Some("きょうははれです。".to_string());
        let merged = merge_caption_payload(&interim, &translated_final).expect("merged");
        assert_eq!(merged.source_text, "今日は晴れです。");
        assert_eq!(merged.translation_text, "It is sunny today.");
        assert_eq!(merged.is_final, Some(true));
    }

    #[test]
    fn keeps_translation_across_a_punctuation_only_same_reading_source_revision() {
        clear_caption_merge_diagnostics();
        let mut translated =
            translation("u-1", "こんにちは聞こえますか", "Hello, can you hear me?", 1, 10, true);
        translated.azookey_input_text = Some("こんにちはきこえますか".to_string());
        let mut normalized = source("u-1", "こんにちは。聞こえますか", 1, 20, false);
        normalized.azookey_input_text = Some("こんにちはきこえますか".to_string());
        let merged = merge_caption_payload(&translated, &normalized).expect("merged");
        assert_eq!(merged.source_text, "こんにちは。聞こえますか");
        assert_eq!(merged.translation_text, "Hello, can you hear me?");
        assert_eq!(merged.stage, Some(CaptionStage::Source));
    }

    #[test]
    fn does_not_attach_a_cross_id_translation_even_when_the_phonetic_reading_matches() {
        clear_caption_merge_diagnostics();
        let mut visible = source("new-turn", "今日は", 1, 20, false);
        visible.azookey_input_text = Some("きょうは".to_string());
        let mut older = translation("old-turn", "今日は", "Today", 1, 30, true);
        older.azookey_input_text = Some("きょうは".to_string());
        let merged = merge_caption_payload(&visible, &older).expect("visible");
        assert_eq!(merged.id, "new-turn");
        assert_eq!(merged.translation_text, "");
    }

    #[test]
    fn keeps_a_completed_prefix_translation_on_a_longer_same_turn_source_revision() {
        clear_caption_merge_diagnostics();
        let mut revised = source("u-1", "こんにちは聞こえますか", 1, 20, false);
        revised.azookey_input_text = Some("こんにちはきこえますか".to_string());
        let mut prefix = translation("u-1", "こんにちは", "Hello", 1, 30, true);
        prefix.azookey_input_text = Some("こんにちは".to_string());
        let merged = merge_caption_payload(&revised, &prefix).expect("merged");
        assert_eq!(merged.source_text, "こんにちは聞こえますか");
        assert_eq!(merged.translation_text, "Hello");
        assert_eq!(merged.stage, Some(CaptionStage::Source));
        assert_eq!(merged.sequence, Some(0));
    }

    #[test]
    fn keeps_a_longer_mid_utterance_provisional_when_a_stale_shorter_normalize_completes_later() {
        clear_caption_merge_diagnostics();
        let mut provisional = source("u-1", "今日はいい天気ですね", 1_200, 1_500, false);
        provisional.azookey_input_text = Some("きょうはいいてんきですね".to_string());
        provisional.provisional = Some(true);
        let mut stale = source("u-1", "今日は", 1_000, 1_600, false);
        stale.azookey_input_text = Some("きょうは".to_string());
        assert!(merge_caption_payload(&provisional, &stale).is_none());
    }

    #[test]
    fn keeps_mid_utterance_provisional_without_readings_when_a_shorter_prefix_normalize_arrives_stale(
    ) {
        clear_caption_merge_diagnostics();
        let mut provisional = source("u-1", "隣の客はよく柿を食べる", 1_200, 1_500, false);
        provisional.provisional = Some(true);
        let stale = source("u-1", "隣の客は", 1_000, 1_600, false);
        assert!(merge_caption_payload(&provisional, &stale).is_none());
    }

    #[test]
    fn returns_the_current_payload_when_event_and_invoke_paint_the_same_caption() {
        clear_caption_merge_diagnostics();
        let live = source("u-1", "こんにちは", 1, 10, false);
        let duplicate = source("u-1", "こんにちは", 1, 12, false);
        let merged = merge_caption_payload(&live, &duplicate).expect("same");
        assert!(captions_display_equal(&live, &merged));
        assert_eq!(merged.source_text, "こんにちは");
        assert_eq!(merged.received_at, 10);
    }

    #[test]
    fn treats_the_very_first_payload_after_reset_as_a_cross_id_translation_when_it_has_translation()
    {
        clear_caption_merge_diagnostics();
        let empty = caption("empty", "", "", 1, 1);
        let late = translation("u-1", "", "Late completion from prior session", 100, 200, true);
        let merged = merge_caption_payload(&empty, &late).expect("empty");
        assert_eq!(merged.id, "empty");
        assert_eq!(
            get_caption_merge_diagnostics(),
            CaptionMergeDiagnostics {
                cross_id_translation_ids_saved: 1,
                pending_cross_id_translations: 1,
            }
        );
        assert_eq!(
            take_pending_caption_translation("u-1").expect("pending").translation_text,
            "Late completion from prior session"
        );
    }

    #[test]
    fn accepts_a_new_source_caption_immediately_after_reset() {
        clear_caption_merge_diagnostics();
        let empty = caption("empty", "", "", 1, 1);
        let new_source = source("u-1", "最初の認識結果", 100, 200, false);
        let merged = merge_caption_payload(&empty, &new_source).expect("first");
        assert_eq!(merged.id, "u-1");
        assert_eq!(merged.source_text, "最初の認識結果");
    }

    #[test]
    fn enforces_session_boundary_contract_clear_resets_pending_translations() {
        clear_caption_merge_diagnostics();
        let current = source("u-2", "次の発話", 2, 2, false);
        let late = translation("u-1", "", "Prior session", 1, 3, true);
        assert!(merge_caption_payload(&current, &late).is_some());
        assert_eq!(get_caption_merge_diagnostics().pending_cross_id_translations, 1);
        clear_caption_merge_diagnostics();
        assert_eq!(get_caption_merge_diagnostics().pending_cross_id_translations, 0);
        assert!(take_pending_caption_translation("u-1").is_none());
    }

    #[test]
    fn locks_stale_shorter_and_prefix_identity_helpers() {
        assert!(!is_truncated_caption_rewrite("", "電車が遅延してただから僕は学校に行かない"));
        assert!(!is_truncated_caption_rewrite("電車が遅延してたから僕は学校", ""));
        assert!(!is_truncated_caption_rewrite(
            "別の話題です",
            "電車が遅延してただから僕は学校に行かない"
        ));
        assert!(is_truncated_caption_rewrite(
            "電車が遅延してたから僕は学校",
            "電車が遅延してただから僕は学校に行かない"
        ));
        assert!(is_stale_shorter_caption_surface("今日は", "きょうはいいてんきですね"));
        assert!(!is_stale_shorter_caption_surface("今日は", "きょうは"));
        assert!(is_shorter_same_utterance_surface("きこえますか", "こんにちはきこえますか"));
        assert!(is_shorter_suffix_surface("きこえますか", "こんにちはきこえますか"));
        assert!(!is_shorter_suffix_surface("晴れ", "明日の天気は"));
        assert!(!is_shorter_same_utterance_surface("こんにちはきこえますか", "きこえますか"));
        assert!(!is_shorter_same_utterance_surface("晴れです", "雨です"));
        assert!(should_append_disjoint_same_turn_surfaces("会議を始めます", "続きがあります"));
        assert!(should_append_disjoint_same_turn_surfaces(
            "本日はどうぞよろしくお願いします",
            "終わりますか"
        ));
        assert!(!should_append_disjoint_same_turn_surfaces(
            "こんにちはきこえますか",
            "きこえますか"
        ));
        assert!(!should_append_disjoint_same_turn_surfaces(
            "こんにちはーきこえますかー",
            "きこえますか"
        ));
        assert!(!should_append_disjoint_same_turn_surfaces("雨です", "晴れです"));
    }

    #[test]
    fn keeps_a_longer_painted_tail_when_a_later_non_final_rewrite_is_truncated() {
        clear_caption_merge_diagnostics();
        let mut painted = source(
            "parapper:session:turn:delay-tail",
            "電車が遅延してただから僕は学校に行かない",
            1_200,
            5_000,
            false,
        );
        painted.provisional = Some(true);
        let mut truncated = source(
            "parapper:session:turn:delay-tail",
            "電車が遅延してたから僕は学校",
            1_200,
            5_200,
            false,
        );
        truncated.provisional = Some(true);
        let merged = merge_caption_payload(&painted, &truncated).expect("stitched");
        assert_eq!(merged.source_text, "電車が遅延してたから僕は学校に行かない");
        assert_eq!(merged.provisional, Some(true));
    }

    #[test]
    fn normalizes_katakana_readings_to_hiragana() {
        assert_eq!(normalize_azookey_reading("スーパー"), "すーぱー");
        assert_eq!(normalize_azookey_reading("すーぱー"), "すーぱー");
    }

    #[test]
    fn replaces_kana_surface_when_the_incoming_azookey_reading_is_unchanged() {
        clear_caption_merge_diagnostics();
        let mut current = source("u-reading", "あしたは", 1_000, 1_000, false);
        current.azookey_input_text = Some("あしたは".to_string());
        let mut normalized = source("u-reading", "明日は", 1_300, 1_300, false);
        normalized.azookey_input_text = Some("あしたは".to_string());
        assert_eq!(
            merge_caption_payload(&current, &normalized).expect("replaced").source_text,
            "明日は"
        );
    }
}
