//! Progressive source reveal for Live / Overlay / Syphon.
//!
//! Port of `apps/desktop/src/core/progressive-caption-reveal.ts`.
//! Timing constants are injected by callers; this module never reads a clock.

use crate::display::{restore_collapsed_continuation, sanitize_caption_display_text};
use crate::grapheme::{caption_graphemes, scalar_count, unicode_scalars};
use crate::payload::CaptionPayload;
use crate::sentence::{select_visible_caption_sentence, CaptionSentenceHints, CaptionSentenceKey};

/// Delay between newly recognized graphemes while revealing a longer hypothesis.
pub const PROGRESSIVE_REVEAL_MS_PER_GRAPHEME: i64 = 12;
/// Cap so a long jump (e.g. silence interim) still finishes promptly.
pub const PROGRESSIVE_REVEAL_MAX_MS: i64 = 160;
/// Hold the first visible paint for one display frame (native 2nd-frame rAF).
pub const PROGRESSIVE_FIRST_PAINT_COALESCE_MS: i64 = 16;

const MIN_STEP_MS: i64 = 8;

/// Source string the progressive reveal should grow toward.
///
/// Overlay/Syphon page finished clauses on punctuation. Revealing the raw full
/// `source_text` still recreates punctuated prefixes; sentence paging then
/// collapses the plate to a one-grapheme fragment. Target the same visible
/// sentence the final paint would show so intermediates stay inside one clause.
pub fn resolve_progressive_reveal_source_target(caption: &CaptionPayload) -> String {
    let source = sanitize_caption_display_text(&caption.source_text);
    let hints = CaptionSentenceHints {
        key: Some(CaptionSentenceKey::Source),
        azookey_input_text: caption.azookey_input_text.clone(),
        sentence_end_offsets: caption.sentence_end_offsets.clone(),
        soft_break_offsets: caption.soft_break_offsets.clone(),
        defer_sentence_paging: Some(caption.provisional == Some(true)),
        previous_text: None,
        previous_ends: None,
    };
    restore_collapsed_continuation(&source, &select_visible_caption_sentence(&source, &hints))
}

/// True when `next` is a longer recognition of the same growing utterance.
/// Non-prefix rewrites (kana→kanji) jump.
pub fn should_progressively_reveal(previous: &str, next: &str) -> bool {
    let prev = previous.trim();
    let nxt = next.trim();
    if nxt.is_empty() || nxt == prev {
        return false;
    }
    if prev.is_empty() {
        return caption_graphemes(nxt).len() > 1;
    }
    nxt.starts_with(prev) && caption_graphemes(nxt).len() > caption_graphemes(prev).len()
}

/// Reveal delay for the remaining graphemes, capped for long jumps.
pub fn progressive_reveal_step_ms(remaining_graphemes: i64) -> i64 {
    let safe_remaining = remaining_graphemes.max(0);
    if safe_remaining <= 0 {
        return 0;
    }
    let total_budget =
        (PROGRESSIVE_REVEAL_MS_PER_GRAPHEME * safe_remaining).min(PROGRESSIVE_REVEAL_MAX_MS);
    (total_budget / safe_remaining).max(MIN_STEP_MS)
}

/// First paint for a progressive jump from an empty plate.
pub fn immediate_progressive_reveal_start(displayed: &str, target: &str) -> String {
    if !displayed.trim().is_empty() {
        return displayed.to_string();
    }
    target.to_string()
}

/// Advance `displayed` toward `target`. An empty plate snaps to the first
/// hypothesis; later prefix extensions grow one grapheme at a time; rewrites snap.
pub fn advance_progressive_reveal(displayed: &str, target: &str) -> String {
    if displayed == target {
        return target.to_string();
    }
    if displayed.trim().is_empty() {
        return immediate_progressive_reveal_start(displayed, target);
    }
    if !should_progressively_reveal(displayed, target) {
        return target.to_string();
    }
    let target_graphemes = caption_graphemes(target);
    let displayed_count = caption_graphemes(displayed).len();
    if displayed_count >= target_graphemes.len() {
        return target.to_string();
    }
    target_graphemes[..displayed_count + 1].join("")
}

/// Snap the first visible paint to a longer surface that is already available.
pub fn should_snap_progressive_first_paint(
    displayed: &str,
    target: &str,
    first_frame_pending: bool,
) -> bool {
    first_frame_pending && should_progressively_reveal(displayed, target)
}

/// Overlay/Syphon: paint an already-recognized longer prefix instead of typewriting.
pub fn should_snap_available_prefix_extension(
    displayed: &str,
    target: &str,
    enabled: bool,
) -> bool {
    enabled && should_progressively_reveal(displayed, target)
}

/// True when `text` is exactly one user-visible grapheme.
pub fn is_single_grapheme_caption_surface(text: &str) -> bool {
    caption_graphemes(text.trim()).len() == 1
}

/// Hold an empty plate for one display frame when the first hypothesis is one grapheme.
pub fn should_hold_single_grapheme_first_paint(
    displayed: &str,
    target: &str,
    first_frame_pending: bool,
) -> bool {
    first_frame_pending && displayed.trim().is_empty() && is_single_grapheme_caption_surface(target)
}

/// Align a progressive paint with the offsets that describe that surface.
pub fn align_caption_offsets_to_painted_source(
    caption: &CaptionPayload,
    paint_source: &str,
) -> CaptionPayload {
    let paint = restore_collapsed_continuation(&caption.source_text, paint_source);
    if paint == caption.source_text {
        return caption.clone();
    }
    let mut aligned = caption.clone();
    aligned.source_text = paint.clone();
    let Some(shift) = painted_source_shift(&caption.source_text, &paint) else {
        aligned.sentence_end_offsets = None;
        aligned.soft_break_offsets = None;
        return aligned;
    };
    let paint_len = scalar_count(&paint);
    aligned.soft_break_offsets =
        transform_caption_offsets(caption.soft_break_offsets.as_deref(), shift, paint_len);
    aligned.sentence_end_offsets = drop_sentence_ends_that_page_to_shorter_remainder(
        &paint,
        transform_caption_offsets(caption.sentence_end_offsets.as_deref(), shift, paint_len),
    );
    aligned
}

fn painted_source_shift(full: &str, paint: &str) -> Option<usize> {
    if paint.is_empty() {
        return None;
    }
    if full.starts_with(paint) {
        return Some(0);
    }
    let full_chars = unicode_scalars(full);
    let paint_chars = unicode_scalars(paint);
    if paint_chars.is_empty() || paint_chars.len() > full_chars.len() {
        return None;
    }
    if full.ends_with(paint) {
        return Some(full_chars.len() - paint_chars.len());
    }
    full_chars.windows(paint_chars.len()).position(|window| window == paint_chars.as_slice())
}

fn transform_caption_offsets(
    offsets: Option<&[usize]>,
    shift: usize,
    paint_len: usize,
) -> Option<Vec<usize>> {
    let offsets = offsets?;
    if offsets.is_empty() {
        return Some(Vec::new());
    }
    let next: Vec<usize> = offsets
        .iter()
        .filter_map(|offset| offset.checked_sub(shift))
        .filter(|offset| *offset > 0 && *offset <= paint_len)
        .collect();
    if next.is_empty() {
        None
    } else {
        Some(next)
    }
}

fn drop_sentence_ends_that_page_to_shorter_remainder(
    paint: &str,
    offsets: Option<Vec<usize>>,
) -> Option<Vec<usize>> {
    let offsets = offsets?;
    if offsets.is_empty() {
        return Some(Vec::new());
    }
    let kept: Vec<usize> = offsets
        .into_iter()
        .filter(|offset| {
            let hints = CaptionSentenceHints {
                sentence_end_offsets: Some(vec![*offset]),
                ..CaptionSentenceHints::default()
            };
            select_visible_caption_sentence(paint, &hints) == paint
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_progressive_reveal, align_caption_offsets_to_painted_source,
        immediate_progressive_reveal_start, is_single_grapheme_caption_surface,
        progressive_reveal_step_ms, resolve_progressive_reveal_source_target,
        should_hold_single_grapheme_first_paint, should_progressively_reveal,
        should_snap_available_prefix_extension, should_snap_progressive_first_paint,
        PROGRESSIVE_FIRST_PAINT_COALESCE_MS, PROGRESSIVE_REVEAL_MAX_MS,
        PROGRESSIVE_REVEAL_MS_PER_GRAPHEME,
    };
    use crate::payload::{CaptionPayload, CaptionStage};
    use crate::sentence::{select_visible_caption_sentence, CaptionSentenceHints};

    fn caption(source_text: &str) -> CaptionPayload {
        CaptionPayload {
            id: "parapper:session:turn:1".to_string(),
            source_text: source_text.to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 1,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(false),
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        }
    }

    #[test]
    fn treats_prefix_growth_as_progressive_recognition_steps() {
        assert!(should_progressively_reveal("", "こんにちは"));
        assert!(should_progressively_reveal("こん", "こんにちは"));
        assert!(!should_progressively_reveal("こんにちは", "こんにちは"));
        assert!(!should_progressively_reveal("あしたは", "明日は"));
    }

    #[test]
    fn snaps_an_empty_plate_to_the_full_first_hypothesis_in_one_step() {
        assert_eq!(advance_progressive_reveal("", "こんにちは"), "こんにちは");
        assert_eq!(advance_progressive_reveal("   ", "明日は雨です"), "明日は雨です");
    }

    #[test]
    fn advances_one_grapheme_at_a_time_after_the_first_hypothesis_is_on_the_plate() {
        assert_eq!(advance_progressive_reveal("こ", "こんにちは"), "こん");
        assert_eq!(advance_progressive_reveal("こん", "こんにちは"), "こんに");
        assert_eq!(advance_progressive_reveal("こんに", "こんにちは"), "こんにち");
        assert_eq!(advance_progressive_reveal("こんにち", "こんにちは"), "こんにちは");
    }

    #[test]
    fn snaps_immediately_on_kana_to_kanji_rewrites() {
        assert_eq!(advance_progressive_reveal("あしたは", "明日は"), "明日は");
    }

    #[test]
    fn is_a_no_op_when_displayed_already_matches_the_target() {
        assert_eq!(advance_progressive_reveal("こんにちは", "こんにちは"), "こんにちは");
    }

    #[test]
    fn snaps_when_displayed_already_has_at_least_as_many_graphemes_as_the_target() {
        assert_eq!(advance_progressive_reveal("こんに", "こん"), "こん");
    }

    #[test]
    fn paints_the_full_first_hypothesis_immediately_when_the_plate_is_empty() {
        assert_eq!(immediate_progressive_reveal_start("", "こんにちは"), "こんにちは");
        assert_eq!(immediate_progressive_reveal_start("   ", "こんにちは"), "こんにちは");
        assert_eq!(immediate_progressive_reveal_start("こ", "こんにちは"), "こ");
        assert_eq!(immediate_progressive_reveal_start("", "あ"), "あ");
        assert_eq!(immediate_progressive_reveal_start("", "明日は"), "明日は");
    }

    #[test]
    fn snaps_the_first_visible_paint_to_a_longer_surface_that_is_already_available() {
        assert!(should_snap_progressive_first_paint("こ", "こんにちは", true));
        assert!(!should_snap_progressive_first_paint("こ", "こんにちは", false));
        assert!(!should_snap_progressive_first_paint("こんにちは", "こんにちは", true));
        assert!(should_snap_progressive_first_paint("", "こんにちは", true));
    }

    #[test]
    fn holds_a_one_grapheme_first_hypothesis_until_the_first_frame_commits() {
        assert!(should_hold_single_grapheme_first_paint("", "こ", true));
        assert!(should_hold_single_grapheme_first_paint("", "あ", true));
        assert!(!should_hold_single_grapheme_first_paint("", "こんにちは", true));
        assert!(!should_hold_single_grapheme_first_paint("", "こ", false));
        assert!(!should_hold_single_grapheme_first_paint("こ", "こ", true));
        assert!(is_single_grapheme_caption_surface("こ"));
        assert!(!is_single_grapheme_caption_surface("こんにちは"));
    }

    #[test]
    fn still_grows_a_committed_lead_into_the_concatenated_line_after_the_first_frame() {
        assert!(!should_snap_progressive_first_paint(
            "こんにちは",
            "こんにちはきこえますか",
            false
        ));
        assert!(!should_snap_available_prefix_extension(
            "こんにちは",
            "こんにちはきこえますか",
            false
        ));
        assert!(should_snap_available_prefix_extension(
            "こんにちは",
            "こんにちはきこえますか",
            true
        ));
        assert!(should_progressively_reveal("こんにちは", "こんにちはきこえますか"));
        assert_eq!(
            advance_progressive_reveal("こんにちは", "こんにちはきこえますか"),
            "こんにちはき"
        );
        assert_eq!(
            advance_progressive_reveal("おはよう", "おはようーーーよろしくお願いします"),
            "おはようー"
        );
        assert_eq!(
            advance_progressive_reveal("会議を始めます", "会議を始めます続きがあります"),
            "会議を始めます続"
        );
    }

    #[test]
    fn keeps_per_grapheme_delay_bounded_for_long_jumps() {
        assert_eq!(PROGRESSIVE_REVEAL_MS_PER_GRAPHEME, 12);
        assert_eq!(PROGRESSIVE_REVEAL_MAX_MS, 160);
        assert_eq!(PROGRESSIVE_FIRST_PAINT_COALESCE_MS, 16);
        assert_eq!(progressive_reveal_step_ms(1), 12);
        assert_eq!(progressive_reveal_step_ms(100), 8);
        assert_eq!(progressive_reveal_step_ms(0), 0);
        assert_eq!(progressive_reveal_step_ms(-3), 0);
    }

    #[test]
    fn targets_the_newest_paged_sentence_so_multi_clause_reveal_does_not_pass_through_one_grapheme_fragments(
    ) {
        let mut paged = caption("今日は晴れです。明日は雨です");
        paged.is_final = Some(true);
        assert_eq!(resolve_progressive_reveal_source_target(&paged), "明日は雨です");
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです。明", &CaptionSentenceHints::default()),
            "明"
        );
        assert_eq!(advance_progressive_reveal("", "明日は雨です"), "明日は雨です");
    }

    #[test]
    fn keeps_the_lead_sentence_as_the_reveal_target_unless_punctuation_or_a_2x_tail_pages() {
        let mut provisional = caption("今日は晴れです明日は雨");
        provisional.provisional = Some(true);
        provisional.is_final = Some(false);
        assert_eq!(
            resolve_progressive_reveal_source_target(&provisional),
            "今日は晴れです明日は雨"
        );
        let mut live = caption("今日は晴れです明日は雨");
        live.is_final = Some(false);
        assert_eq!(resolve_progressive_reveal_source_target(&live), "今日は晴れです明日は雨");
        let mut punctuated = caption("今日は晴れです。明日は雨");
        punctuated.provisional = Some(true);
        punctuated.is_final = Some(false);
        assert_eq!(resolve_progressive_reveal_source_target(&punctuated), "明日は雨");
    }

    #[test]
    fn keeps_a_single_clause_or_greeting_continuation_as_the_reveal_target() {
        assert_eq!(resolve_progressive_reveal_source_target(&caption("こんにちは")), "こんにちは");
        let mut greeting = caption("こんにちはーきこえますか");
        greeting.sentence_end_offsets = Some(vec![5]);
        assert_eq!(resolve_progressive_reveal_source_target(&greeting), "こんにちはーきこえますか");
    }

    #[test]
    fn keeps_prefix_offsets_that_still_sit_on_the_paint_without_paging_to_1_char() {
        let mut payload = caption("今日は寒い明日は");
        payload.sentence_end_offsets = Some(vec![5]);
        payload.soft_break_offsets = Some(vec![3]);
        let full_aligned = align_caption_offsets_to_painted_source(&payload, "今日は寒い明日は");
        assert_eq!(full_aligned.source_text, "今日は寒い明日は");
        assert_eq!(full_aligned.sentence_end_offsets.as_deref(), Some(&[5][..]));
        assert_eq!(
            select_visible_caption_sentence(
                "今日は寒い明日は",
                &CaptionSentenceHints {
                    sentence_end_offsets: Some(vec![5]),
                    ..CaptionSentenceHints::default()
                }
            ),
            "今日は寒い明日は"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "今日は寒い明",
                &CaptionSentenceHints {
                    sentence_end_offsets: Some(vec![5]),
                    ..CaptionSentenceHints::default()
                }
            ),
            "今日は寒い明"
        );
        let aligned = align_caption_offsets_to_painted_source(&payload, "今日は寒い明");
        assert_eq!(aligned.source_text, "今日は寒い明");
        assert_eq!(aligned.sentence_end_offsets.as_deref(), Some(&[5][..]));
        assert_eq!(aligned.soft_break_offsets.as_deref(), Some(&[3][..]));
        assert_eq!(
            select_visible_caption_sentence(
                &aligned.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: aligned.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "今日は寒い明"
        );
    }

    #[test]
    fn keeps_greeting_continuation_prefixes_intact_when_vibrato_ends_would_page_mid_reveal() {
        let mut payload = caption("こんにちはーきこえますか");
        payload.sentence_end_offsets = Some(vec![5]);
        assert_eq!(resolve_progressive_reveal_source_target(&payload), "こんにちはーきこえますか");
        let aligned = align_caption_offsets_to_painted_source(&payload, "こんにちはー");
        assert_eq!(aligned.sentence_end_offsets.as_deref(), Some(&[5][..]));
        assert_eq!(
            select_visible_caption_sentence(
                &aligned.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: aligned.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "こんにちはー"
        );
    }

    #[test]
    fn does_not_paint_a_lone_chouon_when_a_longer_greeting_continuation_is_already_available() {
        let mut payload = caption("こんにちはーきこえますか");
        payload.sentence_end_offsets = Some(vec![5]);
        assert_eq!(resolve_progressive_reveal_source_target(&payload), "こんにちはーきこえますか");
        assert_eq!(
            align_caption_offsets_to_painted_source(&payload, "ー").source_text,
            "こんにちはーきこえますか"
        );
        assert_eq!(
            align_caption_offsets_to_painted_source(&payload, "ーきこえますか").source_text,
            "こんにちはーきこえますか"
        );
    }

    #[test]
    fn does_not_page_a_greeting_to_a_hearing_check_tail_after_bang_or_question_punct() {
        let spoken = caption("こんにちは！きこえますか");
        assert_eq!(resolve_progressive_reveal_source_target(&spoken), "こんにちは！きこえますか");
        assert_eq!(
            align_caption_offsets_to_painted_source(&spoken, "きこえますか").source_text,
            "こんにちは！きこえますか"
        );
        assert_eq!(
            resolve_progressive_reveal_source_target(&caption("こんにちは。終えますか")),
            "聞こえますか"
        );
    }

    #[test]
    fn does_not_page_last_sentence_prefixes_to_1_char_after_offset_coordinate_transform() {
        let mut payload = caption("短いです今日はとても良い天気です");
        payload.sentence_end_offsets = Some(vec![4]);
        assert_eq!(resolve_progressive_reveal_source_target(&payload), "今日はとても良い天気です");
        assert_eq!(
            select_visible_caption_sentence(
                "今日はとて",
                &CaptionSentenceHints {
                    sentence_end_offsets: Some(vec![4]),
                    ..CaptionSentenceHints::default()
                }
            ),
            "今日はとて"
        );
        let aligned = align_caption_offsets_to_painted_source(&payload, "今日はとて");
        assert_eq!(
            select_visible_caption_sentence(
                &aligned.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: aligned.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "今日はとて"
        );
        assert_ne!(
            select_visible_caption_sentence(
                &aligned.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: aligned.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "て"
        );
        assert_eq!(
            advance_progressive_reveal("", "今日はとても良い天気です"),
            "今日はとても良い天気です"
        );
    }

    #[test]
    fn subtracts_a_dropped_prefix_for_suffix_paints_and_drops_rewrite_sentence_ends() {
        let mut payload = caption("短いです今日はとても良い天気です");
        payload.sentence_end_offsets = Some(vec![4, 16]);
        payload.soft_break_offsets = Some(vec![3, 7]);
        let aligned_suffix =
            align_caption_offsets_to_painted_source(&payload, "今日はとても良い天気です");
        assert_eq!(aligned_suffix.source_text, "今日はとても良い天気です");
        assert_eq!(aligned_suffix.sentence_end_offsets.as_deref(), Some(&[12][..]));
        assert_eq!(aligned_suffix.soft_break_offsets.as_deref(), Some(&[3][..]));
        assert_ne!(
            select_visible_caption_sentence(
                &aligned_suffix.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: aligned_suffix.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "て"
        );

        let mut rewritten = caption("明日は雨");
        rewritten.sentence_end_offsets = Some(vec![3]);
        rewritten.soft_break_offsets = Some(vec![2]);
        let rewritten = align_caption_offsets_to_painted_source(&rewritten, "あしたはあめ");
        assert_eq!(rewritten.source_text, "あしたはあめ");
        assert!(rewritten.sentence_end_offsets.is_none());
        assert!(rewritten.soft_break_offsets.is_none());
    }
}
