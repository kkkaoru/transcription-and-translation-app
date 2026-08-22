//! Translation displayability, ellipsis stripping, and empty-plate factories.
//!
//! Port of the sanitization / translation-guard surface in
//! `apps/desktop/src/overlay/captions.ts`.

use crate::grapheme::caption_graphemes;
use crate::payload::{CaptionPayload, CaptionStage};
use crate::sentence::{select_visible_caption_sentence, CaptionSentenceHints};

/// Keep at most two identical Kanji in a row.
pub const MAX_IDENTICAL_KANJI_RUN: usize = 2;

const DROPPED_KIKOERU_KANA: &[&str] = &["あえますか", "おえますか"];
const DROPPED_KIKOERU_KANJI: &[&str] = &["会えますか", "終えますか"];

fn is_han_script(grapheme: &str) -> bool {
    grapheme
        .chars()
        .any(|character| unicode_script::Script::from(character) == unicode_script::Script::Han)
}

fn is_elongation_only(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|character| matches!(character, 'ー' | '〜' | '～'))
}

fn is_elongation_led(text: &str) -> bool {
    text.chars().next().is_some_and(|character| matches!(character, 'ー' | '〜' | '～'))
}

fn strip_elongation_and_trailing_clause_punct(text: &str) -> String {
    let without_elongation: String =
        text.chars().filter(|character| !matches!(character, 'ー' | '〜' | '～')).collect();
    without_elongation
        .trim_end_matches(|character: char| {
            matches!(character, '。' | '．' | '.' | '、' | '！' | '？' | '!' | '?')
        })
        .to_string()
}

/// Parapper marks continuing turns with a trailing `...`.
pub fn strip_caption_continuation_marker(text: &str) -> String {
    let graphemes = caption_graphemes(text);
    let mut end = graphemes.len();
    while end > 0 {
        let cluster = graphemes[end - 1].as_str();
        if cluster == "..." || cluster == "…" || cluster == "⋯" || cluster == "." {
            if cluster == "." {
                let mut dots = 0;
                let mut cursor = end;
                while cursor > 0 && graphemes[cursor - 1] == "." {
                    dots += 1;
                    cursor -= 1;
                }
                if dots >= 3 {
                    end = cursor;
                    continue;
                }
                break;
            }
            end -= 1;
            continue;
        }
        break;
    }
    graphemes[..end].join("").trim_end().to_string()
}

/// A translation containing no Unicode letter or number is not useful caption content.
pub fn has_displayable_translation_text(text: &str) -> bool {
    text.trim().chars().any(|character| {
        character.is_alphanumeric()
            || matches!(
                unicode_general_category::get_general_category(character),
                unicode_general_category::GeneralCategory::UppercaseLetter
                    | unicode_general_category::GeneralCategory::LowercaseLetter
                    | unicode_general_category::GeneralCategory::TitlecaseLetter
                    | unicode_general_category::GeneralCategory::ModifierLetter
                    | unicode_general_category::GeneralCategory::OtherLetter
                    | unicode_general_category::GeneralCategory::DecimalNumber
                    | unicode_general_category::GeneralCategory::LetterNumber
                    | unicode_general_category::GeneralCategory::OtherNumber
            )
    })
}

/// Collapse pathological single-Kanji runs.
pub fn collapse_runaway_grapheme_runs(text: &str, max_run: usize) -> String {
    let graphemes = caption_graphemes(text);
    if graphemes.is_empty() {
        return String::new();
    }
    let safe_max = max_run.max(1);
    let mut out = Vec::new();
    let mut previous = String::new();
    let mut run = 0;
    for grapheme in graphemes {
        if grapheme == previous && is_han_script(&grapheme) {
            run += 1;
            if run <= safe_max {
                out.push(grapheme);
            }
            continue;
        }
        previous = grapheme.clone();
        run = 1;
        out.push(grapheme);
    }
    out.join("")
}

/// Repair ReazonSpeech き-drop of 聞こえる.
pub fn repair_hearing_phrase_confusion(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let mut next = text.to_string();
    for slip in DROPPED_KIKOERU_KANA {
        next = next.replace(slip, "きこえますか");
    }
    for slip in DROPPED_KIKOERU_KANJI {
        next = next.replace(slip, "聞こえますか");
    }
    next
}

/// Sanitize caption text before segmentation / display.
pub fn sanitize_caption_display_text(text: &str) -> String {
    collapse_runaway_grapheme_runs(
        &repair_hearing_phrase_confusion(&strip_caption_continuation_marker(
            &text.replace("\r\n", "\n").replace('\r', "\n"),
        )),
        MAX_IDENTICAL_KANJI_RUN,
    )
}

fn prefix_before_shown(source: &str, shown: &str) -> Option<String> {
    if !shown.is_empty() && source.ends_with(shown) && shown.len() < source.len() {
        return Some(source[..source.len() - shown.len()].to_string());
    }
    let source_bare = strip_elongation_and_trailing_clause_punct(source);
    let shown_bare = strip_elongation_and_trailing_clause_punct(shown);
    if !shown_bare.is_empty()
        && source_bare.ends_with(&shown_bare)
        && shown_bare.len() < source_bare.len()
    {
        return Some(source_bare[..source_bare.len() - shown_bare.len()].to_string());
    }
    None
}

fn is_sentence_paged_remainder(original: &str, shown: &str) -> bool {
    prefix_before_shown(original, shown)
        .is_some_and(|prefix| prefix.trim_end().ends_with(['。', '．', '.']))
}

fn is_bang_or_question_remainder(original: &str, shown: &str) -> bool {
    prefix_before_shown(original, shown)
        .is_some_and(|prefix| prefix.trim_end().ends_with(['！', '？', '!', '?']))
}

fn is_collapsed_continuation_surface(source: &str, shown: &str) -> bool {
    if shown.is_empty() || shown == source || source.len() <= shown.len() {
        return false;
    }
    if is_elongation_only(shown) && source.contains(shown) {
        return true;
    }
    let source_bare = strip_elongation_and_trailing_clause_punct(source);
    let shown_bare = strip_elongation_and_trailing_clause_punct(shown);
    if shown_bare.is_empty() || unicode_scalars_len(&shown_bare) < 2 {
        return false;
    }
    if is_elongation_led(shown) && (source.ends_with(shown) || source_bare.ends_with(&shown_bare)) {
        return true;
    }
    source.ends_with(shown) || source_bare.ends_with(&shown_bare)
}

fn unicode_scalars_len(text: &str) -> usize {
    text.chars().count()
}

/// Restore a recognized head that paging collapsed to a continuation fragment.
pub fn restore_collapsed_continuation(original: &str, visible: &str) -> String {
    let source = original.trim();
    let shown = visible.trim();
    if source.is_empty() {
        return visible.to_string();
    }
    if shown.is_empty() {
        return sanitize_caption_display_text(source);
    }
    if shown == source {
        return visible.to_string();
    }
    if is_elongation_only(shown) && source.contains(shown) && source.len() > shown.len() {
        return sanitize_caption_display_text(source);
    }
    if is_sentence_paged_remainder(source, shown) {
        return visible.to_string();
    }
    if !is_collapsed_continuation_surface(source, shown) {
        return visible.to_string();
    }
    if select_visible_caption_sentence(source, &CaptionSentenceHints::default()) == shown {
        if is_bang_or_question_remainder(source, shown) {
            return sanitize_caption_display_text(source);
        }
        return visible.to_string();
    }
    sanitize_caption_display_text(source)
}

/// Empty live state used after capture stops.
pub fn create_empty_caption() -> CaptionPayload {
    CaptionPayload {
        id: "empty".to_string(),
        source_text: String::new(),
        azookey_input_text: None,
        translation_text: String::new(),
        source_language: "ja".to_string(),
        target_language: "en".to_string(),
        started_at: 0,
        received_at: 0,
        stage: Some(CaptionStage::Source),
        sequence: Some(0),
        is_final: Some(false),
        provisional: None,
        capture_generation: None,
        sentence_end_offsets: None,
        soft_break_offsets: None,
    }
}

/// Empty plate after hold-clear while capture is still running.
pub fn create_hold_cleared_caption(cleared_at: i64) -> CaptionPayload {
    let mut plate = create_empty_caption();
    plate.received_at = cleared_at.max(1);
    plate
}

/// Preview sample copy. `now_ms` is injected so tests stay deterministic.
pub fn create_preview_caption(now_ms: i64) -> CaptionPayload {
    CaptionPayload {
        id: "preview".to_string(),
        source_text: "これはプレビュー用の字幕です。".to_string(),
        azookey_input_text: None,
        translation_text: "This is a preview caption.".to_string(),
        source_language: "ja".to_string(),
        target_language: "en".to_string(),
        started_at: now_ms,
        received_at: now_ms,
        stage: None,
        sequence: None,
        is_final: None,
        provisional: None,
        capture_generation: None,
        sentence_end_offsets: None,
        soft_break_offsets: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        collapse_runaway_grapheme_runs, create_empty_caption, create_hold_cleared_caption,
        has_displayable_translation_text, repair_hearing_phrase_confusion,
        restore_collapsed_continuation, sanitize_caption_display_text,
        strip_caption_continuation_marker,
    };

    #[test]
    fn repairs_asr_slips_of_kikoemasuka_to_the_intended_hearing_phrase() {
        assert_eq!(repair_hearing_phrase_confusion("あえますか"), "きこえますか");
        assert_eq!(repair_hearing_phrase_confusion("おえますか"), "きこえますか");
        assert_eq!(repair_hearing_phrase_confusion("会えますか"), "聞こえますか");
        assert_eq!(repair_hearing_phrase_confusion("終えますか"), "聞こえますか");
        assert_eq!(
            repair_hearing_phrase_confusion("会議を始めますあえますか"),
            "会議を始めますきこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("会議を始めますーおえますか"),
            "会議を始めますーきこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("会議を始めます会えますか"),
            "会議を始めます聞こえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちはあえますか"),
            "こんにちはきこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは。聞こえますか。"),
            "こんにちは。聞こえますか。"
        );
        assert_eq!(
            sanitize_caption_display_text("こんにちは。聞こえますか。"),
            "こんにちは。聞こえますか。"
        );
        assert_eq!(
            sanitize_caption_display_text("会議を始めますあえますか"),
            "会議を始めますきこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは！きこえますか"),
            "こんにちは！きこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは？聞こえますか"),
            "こんにちは？聞こえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは。終えますか"),
            "こんにちは。聞こえますか"
        );
        assert_eq!(
            sanitize_caption_display_text("さようなら!きこえますか"),
            "さようなら!きこえますか"
        );
    }

    #[test]
    fn does_not_collapse_a_continuation_to_a_lone_chouon_or_suffix_after_paging() {
        assert_eq!(restore_collapsed_continuation("本文", ""), "本文");
        assert_eq!(
            restore_collapsed_continuation("会議を始めますー続きがあります", "ー"),
            "会議を始めますー続きがあります"
        );
        assert_eq!(
            restore_collapsed_continuation("会議を始めますー続きがあります", "ー続きがあります"),
            "会議を始めますー続きがあります"
        );
        assert_eq!(
            restore_collapsed_continuation("ー続きがあります", "ー続きがあります"),
            "ー続きがあります"
        );
        assert_eq!(
            restore_collapsed_continuation(
                "こんにちはーーーよろしくお願いします",
                "ーよろしくお願いします"
            ),
            "こんにちはーーーよろしくお願いします"
        );
        assert_eq!(
            restore_collapsed_continuation(
                "おはようーーーよろしくお願いしますーーー？",
                "ーーーよろしくお願いしますーーー？"
            ),
            "おはようーーーよろしくお願いしますーーー？"
        );
        assert_eq!(
            restore_collapsed_continuation("会議を始めます。ー続きがあります", "ー続きがあります"),
            "ー続きがあります"
        );
        assert_eq!(
            restore_collapsed_continuation("今日は晴れです", "明日は雨です"),
            "明日は雨です"
        );
        assert_eq!(
            restore_collapsed_continuation("おはようよろしくお願いします", "よろしくお願いします"),
            "おはようよろしくお願いします"
        );
        assert_eq!(
            restore_collapsed_continuation(
                "こんにちはよろしくお願いします",
                "よろしくお願いします"
            ),
            "こんにちはよろしくお願いします"
        );
        assert_eq!(
            restore_collapsed_continuation(
                "短いですこれから午後の予定と明日の議題",
                "これから午後の予定と明日の議題"
            ),
            "これから午後の予定と明日の議題"
        );
        assert_eq!(
            restore_collapsed_continuation("会議を始めます続きがあります", "続きがあります"),
            "会議を始めます続きがあります"
        );
        assert_eq!(
            restore_collapsed_continuation("こんにちは！きこえますか", "きこえますか"),
            "こんにちは！きこえますか"
        );
        assert_eq!(
            restore_collapsed_continuation("こんにちは。終えますか", "終えますか"),
            "終えますか"
        );
        assert_eq!(
            restore_collapsed_continuation("会議を始めます。続きがあります", "続きがあります"),
            "続きがあります"
        );
    }

    #[test]
    fn strips_trailing_parapper_continuation_markers_without_touching_mid_text_ellipsis() {
        assert_eq!(strip_caption_continuation_marker("今日は..."), "今日は");
        assert_eq!(strip_caption_continuation_marker("今日は…"), "今日は");
        assert_eq!(strip_caption_continuation_marker("待ち…ます"), "待ち…ます");
    }

    #[test]
    fn collapses_runaway_single_kanji_stutter_but_leaves_normal_kana_repetition_alone() {
        assert_eq!(collapse_runaway_grapheme_runs(&"為".repeat(20), 2), "為為");
        assert_eq!(
            collapse_runaway_grapheme_runs(&"あ".repeat(24), 2),
            "ああああああああああああああああああああああああ"
        );
        assert_eq!(sanitize_caption_display_text("為為為為為為為為為為為為..."), "為為");
    }

    #[test]
    fn has_displayable_translation_text_rejects_punctuation_only() {
        assert!(!has_displayable_translation_text("."));
        assert!(!has_displayable_translation_text("..."));
        assert!(!has_displayable_translation_text("   "));
        assert!(has_displayable_translation_text("Even so, the translation remains visible..."));
        assert!(has_displayable_translation_text("yeah"));
    }

    #[test]
    fn never_stamps_a_zero_receipt_barrier() {
        assert_eq!(create_hold_cleared_caption(0).received_at, 1);
        assert_eq!(create_hold_cleared_caption(-8).received_at, 1);
    }

    #[test]
    fn keeps_the_session_reset_empty_caption_at_received_at_0() {
        let empty = create_empty_caption();
        assert_eq!(empty.received_at, 0);
        assert_eq!(empty.started_at, 0);
        assert_eq!(empty.id, "empty");
        assert_eq!(empty.source_text, "");
    }
}
