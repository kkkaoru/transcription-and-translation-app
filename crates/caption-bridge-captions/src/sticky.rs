//! Caller-owned sticky sentence carry.
//!
//! Port of OverlayApp sticky state (lines 94–257): hints-only via
//! `previous_text` / `previous_ends`. Translation is never sticky-paged.

use crate::payload::CaptionPayload;
use crate::sentence::{
    detect_caption_sentence_ends, select_visible_caption_sentence, CaptionSentenceHints,
    CaptionSentenceKey,
};

/// Display-only sentence carry for one source surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayStickyState {
    pub previous_text: String,
    pub previous_ends: Vec<usize>,
}

/// Owner of the current sticky carry (utterance id + capture generation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayStickyOwner {
    pub id: String,
    pub capture_generation: Option<i64>,
}

/// Caller-owned refs for sticky paging.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OverlayStickyRefs {
    pub source: Option<OverlayStickyState>,
    pub owner: Option<OverlayStickyOwner>,
}

fn normalize_overlay_sticky_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").trim().to_string()
}

/// Reset display-only sentence carry; IPC caption state remains untouched.
pub fn reset_overlay_sticky_refs(refs: &mut OverlayStickyRefs) {
    refs.source = None;
    refs.owner = None;
}

/// A revision may grow or temporarily shrink the same turn.
pub fn compatible_overlay_sticky_state(
    sticky: Option<&OverlayStickyState>,
    text: &str,
) -> Option<OverlayStickyState> {
    let sticky = sticky?;
    if sticky.previous_text.is_empty() || sticky.previous_ends.is_empty() {
        return None;
    }
    let normalized = normalize_overlay_sticky_text(text);
    let previous = normalize_overlay_sticky_text(&sticky.previous_text);
    if normalized.is_empty() || previous.is_empty() {
        return None;
    }
    if normalized.starts_with(&previous) || previous.starts_with(&normalized) {
        return Some(sticky.clone());
    }
    None
}

/// Remember boundaries accepted for this compatible prefix.
pub fn remember_overlay_sticky_state(
    text: &str,
    hints: &CaptionSentenceHints,
    previous: Option<&OverlayStickyState>,
) -> Option<OverlayStickyState> {
    let normalized = normalize_overlay_sticky_text(text);
    if normalized.is_empty() {
        return None;
    }
    let mut fresh_hints = hints.clone();
    fresh_hints.previous_text = None;
    fresh_hints.previous_ends = None;
    let fresh_ends = detect_caption_sentence_ends(&normalized, &fresh_hints);
    let compatible = compatible_overlay_sticky_state(previous, &normalized);
    let limit = normalized.chars().count();
    let mut merged_ends: Vec<usize> = compatible
        .as_ref()
        .map(|state| state.previous_ends.clone())
        .unwrap_or_default()
        .into_iter()
        .chain(fresh_ends)
        .filter(|offset| *offset > 0 && *offset <= limit)
        .collect();
    merged_ends.sort_unstable();
    merged_ends.dedup();
    if merged_ends.is_empty() {
        return None;
    }
    Some(OverlayStickyState { previous_text: normalized, previous_ends: merged_ends })
}

/// Bang/question and elongation-only remainders keep the recognized head.
pub fn should_keep_overlay_head_after_sticky_page(original: &str, paged: &str) -> bool {
    let source = original.trim();
    let shown = paged.trim();
    if shown.is_empty() || shown == source || !source.ends_with(shown) {
        return false;
    }
    let prefix = &source[..source.len() - shown.len()];
    if prefix.trim_end().ends_with(['！', '？', '!', '?']) {
        return true;
    }
    !shown.is_empty() && shown.chars().all(|character| matches!(character, 'ー' | '〜' | '～'))
}

/// Apply sticky carry to one source field.
pub fn apply_overlay_sticky_field(
    text: &str,
    hints: &CaptionSentenceHints,
    sticky: Option<&OverlayStickyState>,
) -> String {
    let paged = select_visible_caption_sentence(
        text,
        &CaptionSentenceHints {
            previous_text: sticky.map(|state| state.previous_text.clone()),
            previous_ends: sticky.map(|state| state.previous_ends.clone()),
            ..hints.clone()
        },
    );
    if paged.is_empty() || paged == text || should_keep_overlay_head_after_sticky_page(text, &paged)
    {
        return text.to_string();
    }
    paged
}

/// Apply the same caller-owned sentence carry to Overlay DOM and native output.
pub fn apply_overlay_sticky_display(
    caption: &CaptionPayload,
    refs: &mut OverlayStickyRefs,
) -> CaptionPayload {
    if caption.id == "preview" || caption.id == "empty" {
        reset_overlay_sticky_refs(refs);
        return caption.clone();
    }

    let generation = caption.capture_generation;
    if let Some(owner) = &refs.owner {
        let generation_changed = owner.capture_generation != generation
            && (owner.capture_generation.is_some() || generation.is_some());
        if owner.id != caption.id || generation_changed {
            refs.source = None;
        }
    }
    refs.owner =
        Some(OverlayStickyOwner { id: caption.id.clone(), capture_generation: generation });

    let source_hints = CaptionSentenceHints {
        key: Some(CaptionSentenceKey::Source),
        azookey_input_text: caption.azookey_input_text.clone(),
        sentence_end_offsets: caption.sentence_end_offsets.clone(),
        soft_break_offsets: caption.soft_break_offsets.clone(),
        defer_sentence_paging: Some(caption.is_provisional()),
        previous_text: None,
        previous_ends: None,
    };
    let source_sticky = compatible_overlay_sticky_state(refs.source.as_ref(), &caption.source_text);

    if caption.is_provisional() {
        return caption.clone();
    }

    refs.source =
        remember_overlay_sticky_state(&caption.source_text, &source_hints, source_sticky.as_ref());

    let next_source =
        apply_overlay_sticky_field(&caption.source_text, &source_hints, source_sticky.as_ref());
    if next_source == caption.source_text {
        return caption.clone();
    }
    let mut next = caption.clone();
    next.source_text = next_source;
    next.sentence_end_offsets = None;
    next.soft_break_offsets = None;
    next
}

#[cfg(test)]
mod tests {
    use super::{
        apply_overlay_sticky_display, compatible_overlay_sticky_state,
        remember_overlay_sticky_state, reset_overlay_sticky_refs,
        should_keep_overlay_head_after_sticky_page, OverlayStickyRefs, OverlayStickyState,
    };
    use crate::payload::{CaptionPayload, CaptionStage};
    use crate::sentence::CaptionSentenceHints;

    fn caption(id: &str, source: &str) -> CaptionPayload {
        CaptionPayload {
            id: id.to_string(),
            source_text: source.to_string(),
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
            capture_generation: Some(1),
            sentence_end_offsets: None,
            soft_break_offsets: None,
        }
    }

    #[test]
    fn sticky_carries_the_prior_boundary_when_a_longer_prefix_loses_its_fresh_end() {
        let mut refs = OverlayStickyRefs::default();
        let first = apply_overlay_sticky_display(&caption("u-1", "今日は晴れです"), &mut refs);
        assert_eq!(first.source_text, "今日は晴れです");
        let second =
            apply_overlay_sticky_display(&caption("u-1", "今日は晴れです明日は雨"), &mut refs);
        assert_eq!(second.source_text, "明日は雨");
        assert_eq!(second.sentence_end_offsets, None);
        assert_eq!(second.soft_break_offsets, None);
    }

    #[test]
    fn sticky_does_not_carry_a_boundary_across_a_non_prefix_hypothesis() {
        let mut refs = OverlayStickyRefs::default();
        let _ = apply_overlay_sticky_display(&caption("u-1", "今日は晴れです"), &mut refs);
        let next = apply_overlay_sticky_display(&caption("u-1", "明日は雨です"), &mut refs);
        assert_eq!(next.source_text, "明日は雨です");
    }

    #[test]
    fn sticky_resets_on_preview_and_empty_plates() {
        let mut refs = OverlayStickyRefs {
            source: Some(OverlayStickyState {
                previous_text: "今日は晴れです".to_string(),
                previous_ends: vec![7],
            }),
            owner: None,
        };
        let preview = caption("preview", "これはプレビュー用の字幕です。");
        let out = apply_overlay_sticky_display(&preview, &mut refs);
        assert_eq!(out, preview);
        assert!(refs.source.is_none());
        assert!(refs.owner.is_none());
    }

    #[test]
    fn sticky_does_not_apply_to_provisional_folded_asr() {
        let mut refs = OverlayStickyRefs::default();
        let mut first = caption("u-1", "今日は晴れです");
        first.provisional = Some(true);
        let out = apply_overlay_sticky_display(&first, &mut refs);
        assert_eq!(out.source_text, "今日は晴れです");
        assert!(refs.source.is_none());
    }

    #[test]
    fn sticky_clears_when_utterance_id_or_generation_changes() {
        let mut refs = OverlayStickyRefs::default();
        let _ = apply_overlay_sticky_display(&caption("u-1", "今日は晴れです"), &mut refs);
        assert!(refs.source.is_some());
        let mut next = caption("u-2", "今日は晴れです明日は雨");
        next.capture_generation = Some(1);
        let out = apply_overlay_sticky_display(&next, &mut refs);
        assert_eq!(out.source_text, "今日は晴れです明日は雨");
    }

    #[test]
    fn compatible_overlay_sticky_state_requires_shared_prefix() {
        let sticky = OverlayStickyState {
            previous_text: "今日は晴れです".to_string(),
            previous_ends: vec![7],
        };
        assert!(compatible_overlay_sticky_state(Some(&sticky), "今日は晴れです明日").is_some());
        assert!(compatible_overlay_sticky_state(Some(&sticky), "明日は雨です").is_none());
    }

    #[test]
    fn remember_overlay_sticky_state_unions_prior_and_fresh_ends() {
        let previous = OverlayStickyState {
            previous_text: "今日は晴れです".to_string(),
            previous_ends: vec![7],
        };
        let remembered = remember_overlay_sticky_state(
            "今日は晴れです明日も晴れる予報です",
            &CaptionSentenceHints::default(),
            Some(&previous),
        )
        .unwrap();
        assert_eq!(remembered.previous_ends, vec![7, 17]);
    }

    #[test]
    fn should_keep_overlay_head_after_bang_or_elongation_only_remainder() {
        assert!(should_keep_overlay_head_after_sticky_page(
            "こんにちは！きこえますか",
            "きこえますか"
        ));
        assert!(should_keep_overlay_head_after_sticky_page("会議を始めますー", "ー"));
        assert!(!should_keep_overlay_head_after_sticky_page("会議を始めます。続き", "続き"));
    }

    #[test]
    fn reset_overlay_sticky_refs_clears_both_slots() {
        let mut refs = OverlayStickyRefs {
            source: Some(OverlayStickyState {
                previous_text: "x".to_string(),
                previous_ends: vec![1],
            }),
            owner: None,
        };
        reset_overlay_sticky_refs(&mut refs);
        assert!(refs.source.is_none());
        assert!(refs.owner.is_none());
    }
}
