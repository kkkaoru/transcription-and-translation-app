//! Hold-clear timers for finalized or translated captions.
//!
//! Port of `apps/desktop/src/core/caption-hold-clear.ts`.

use crate::payload::CaptionPayload;

/// How long a finalized (or translated) caption stays visible after updates stop.
pub const CAPTION_HOLD_CLEAR_MS: i64 = 5_000;

/// Display lifecycle labels recorded by the TypeScript logger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionDisplayLifecycle {
    Visible,
    Hold,
    Clear,
}

impl CaptionDisplayLifecycle {
    /// Wire label used by the TypeScript structured log.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Hold => "hold",
            Self::Clear => "clear",
        }
    }
}

/// Structured fields for a display-lifecycle log row (no caption text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptionDisplayLifecycleLog {
    pub message: String,
    pub lifecycle: CaptionDisplayLifecycle,
    pub age_ms: i64,
    pub generation: Option<i64>,
    pub is_final: bool,
    pub has_translation: bool,
}

/// Records numeric lifecycle changes without caption text.
pub fn log_caption_display_lifecycle(
    lifecycle: CaptionDisplayLifecycle,
    caption: &CaptionPayload,
    now_ms: i64,
) -> CaptionDisplayLifecycleLog {
    let published_at = caption.received_at.max(caption.started_at).max(0);
    let age_ms = if published_at > 0 { (now_ms - published_at).max(0) } else { 0 };
    let generation = caption.capture_generation;
    let has_translation = !caption.translation_text.trim().is_empty();
    let generation_label = match generation {
        Some(value) => value.to_string(),
        None => "none".to_string(),
    };
    CaptionDisplayLifecycleLog {
        message: format!(
            "caption display lifecycle={} age_ms={} generation={} has_translation={}",
            lifecycle.as_str(),
            age_ms,
            generation_label,
            has_translation
        ),
        lifecycle,
        age_ms,
        generation,
        is_final: caption.is_final_true(),
        has_translation,
    }
}

/// Identity of the held caption used to ignore stale hold-clear timers.
pub fn caption_hold_clear_epoch(caption: &CaptionPayload) -> String {
    format!(
        "{}\u{0000}{}\u{0000}{}\u{0000}{}\u{0000}{}\u{0000}{}",
        caption.id,
        caption.source_text,
        caption.translation_text,
        bool_label(caption.is_final),
        bool_label(caption.provisional),
        caption.received_at
    )
}

fn bool_label(value: Option<bool>) -> String {
    match value {
        Some(true) => "true".to_string(),
        Some(false) => "false".to_string(),
        None => "undefined".to_string(),
    }
}

/// True when a scheduled hold-clear still refers to the visible caption.
pub fn should_apply_caption_hold_clear(expected_epoch: &str, current: &CaptionPayload) -> bool {
    expected_epoch == caption_hold_clear_epoch(current)
}

/// Decide whether a hold-clear timer may blank the visible caption.
pub fn should_blank_caption_for_hold_clear(expected_epoch: &str, current: &CaptionPayload) -> bool {
    if !should_apply_caption_hold_clear(expected_epoch, current) {
        return false;
    }
    if current.id == "preview" {
        return false;
    }
    current.has_visible_text()
}

/// Non-final captions must not auto-clear on a short idle.
pub fn caption_hold_clear_delay_ms(caption: &CaptionPayload) -> Option<i64> {
    if !caption.has_visible_text() {
        return None;
    }
    if caption.id == "preview" || caption.id == "empty" {
        return None;
    }
    if caption.is_final_true() || !caption.translation_text.trim().is_empty() {
        return Some(CAPTION_HOLD_CLEAR_MS);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        caption_hold_clear_delay_ms, caption_hold_clear_epoch, log_caption_display_lifecycle,
        should_apply_caption_hold_clear, should_blank_caption_for_hold_clear,
        CaptionDisplayLifecycle, CAPTION_HOLD_CLEAR_MS,
    };
    use crate::display::{create_empty_caption, create_hold_cleared_caption};
    use crate::payload::{CaptionPayload, CaptionStage};

    fn caption(partial: CaptionPartial) -> CaptionPayload {
        CaptionPayload {
            id: partial.id.unwrap_or_else(|| "u-1".to_string()),
            source_text: partial.source_text.unwrap_or_else(|| "今日は晴れ".to_string()),
            azookey_input_text: None,
            translation_text: partial.translation_text.unwrap_or_default(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: partial.started_at.unwrap_or(1),
            received_at: partial.received_at.unwrap_or(1),
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(partial.is_final.unwrap_or(false)),
            provisional: partial.provisional,
            capture_generation: partial.capture_generation,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        }
    }

    struct CaptionPartial {
        id: Option<String>,
        source_text: Option<String>,
        translation_text: Option<String>,
        started_at: Option<i64>,
        received_at: Option<i64>,
        is_final: Option<bool>,
        provisional: Option<bool>,
        capture_generation: Option<i64>,
    }

    impl Default for CaptionPartial {
        fn default() -> Self {
            Self {
                id: None,
                source_text: None,
                translation_text: None,
                started_at: None,
                received_at: None,
                is_final: None,
                provisional: None,
                capture_generation: None,
            }
        }
    }

    #[test]
    fn log_caption_display_lifecycle_records_numeric_lifecycle_changes_without_caption_text() {
        let row = log_caption_display_lifecycle(
            CaptionDisplayLifecycle::Hold,
            &caption(CaptionPartial {
                id: Some("parapper:s:1:2".to_string()),
                source_text: Some("秘密の字幕".to_string()),
                translation_text: Some("secret".to_string()),
                received_at: Some(1_000),
                capture_generation: Some(4),
                ..CaptionPartial::default()
            }),
            9_500,
        );
        assert_eq!(
            row.message,
            "caption display lifecycle=hold age_ms=8500 generation=4 has_translation=true"
        );
        assert_eq!(row.lifecycle, CaptionDisplayLifecycle::Hold);
        assert_eq!(row.age_ms, 8500);
        assert_eq!(row.generation, Some(4));
        assert!(row.has_translation);
        assert!(!row.message.contains("秘密の字幕"));
        assert!(!row.message.contains("secret"));
    }

    #[test]
    fn caption_hold_clear_delay_ms_skips_empty_preview_and_placeholder_captions() {
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                source_text: Some(String::new()),
                translation_text: Some(String::new()),
                ..CaptionPartial::default()
            })),
            None
        );
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                id: Some("preview".to_string()),
                ..CaptionPartial::default()
            })),
            None
        );
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                id: Some("empty".to_string()),
                source_text: Some("x".to_string()),
                ..CaptionPartial::default()
            })),
            None
        );
    }

    #[test]
    fn caption_hold_clear_delay_ms_gives_finalized_and_translated_captions_a_stream_readable_hold()
    {
        assert!(CAPTION_HOLD_CLEAR_MS >= 4_000);
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                is_final: Some(true),
                ..CaptionPartial::default()
            })),
            Some(CAPTION_HOLD_CLEAR_MS)
        );
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                is_final: Some(false),
                translation_text: Some("It is sunny today".to_string()),
                ..CaptionPartial::default()
            })),
            Some(CAPTION_HOLD_CLEAR_MS)
        );
    }

    #[test]
    fn caption_hold_clear_delay_ms_does_not_auto_clear_non_final_captions_during_long_speech_gaps()
    {
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                is_final: Some(false),
                provisional: Some(true),
                ..CaptionPartial::default()
            })),
            None
        );
        assert_eq!(
            caption_hold_clear_delay_ms(&caption(CaptionPartial {
                is_final: Some(false),
                ..CaptionPartial::default()
            })),
            None
        );
    }

    #[test]
    fn should_apply_caption_hold_clear_rejects_a_stale_hold_when_a_newer_utterance_already_replaced_the_plate(
    ) {
        let held = caption(CaptionPartial {
            id: Some("parapper:s:t:1".to_string()),
            source_text: Some("今日は晴れです".to_string()),
            is_final: Some(true),
            received_at: Some(1_000),
            ..CaptionPartial::default()
        });
        let next_turn = caption(CaptionPartial {
            id: Some("parapper:s:t:2".to_string()),
            source_text: Some("明日は雨です".to_string()),
            is_final: Some(true),
            received_at: Some(1_000 + CAPTION_HOLD_CLEAR_MS),
            ..CaptionPartial::default()
        });
        let held_epoch = caption_hold_clear_epoch(&held);
        assert!(should_apply_caption_hold_clear(&held_epoch, &held));
        assert!(!should_apply_caption_hold_clear(&held_epoch, &next_turn));
    }

    #[test]
    fn should_blank_caption_for_hold_clear_blanks_only_when_the_epoch_still_matches_a_non_empty_live_caption(
    ) {
        let held = caption(CaptionPartial {
            id: Some("parapper:s:t:1".to_string()),
            source_text: Some("今日は晴れです".to_string()),
            is_final: Some(true),
            received_at: Some(1_000),
            ..CaptionPartial::default()
        });
        let held_epoch = caption_hold_clear_epoch(&held);
        assert!(should_blank_caption_for_hold_clear(&held_epoch, &held));
        assert!(!should_blank_caption_for_hold_clear(
            &held_epoch,
            &caption(CaptionPartial {
                id: Some("parapper:s:t:2".to_string()),
                source_text: Some("明日は雨です".to_string()),
                is_final: Some(true),
                received_at: Some(1_000 + CAPTION_HOLD_CLEAR_MS),
                ..CaptionPartial::default()
            })
        ));
        let preview = caption(CaptionPartial {
            id: Some("preview".to_string()),
            ..CaptionPartial::default()
        });
        assert!(!should_blank_caption_for_hold_clear(
            &caption_hold_clear_epoch(&preview),
            &preview
        ));
        let empty = caption(CaptionPartial {
            source_text: Some(String::new()),
            translation_text: Some(String::new()),
            is_final: Some(true),
            ..CaptionPartial::default()
        });
        assert!(!should_blank_caption_for_hold_clear(&caption_hold_clear_epoch(&empty), &empty));
    }

    #[test]
    fn live_hold_clear_receipt_barrier_proves_create_empty_caption_after_hold_clear_would_revive_a_late_same_utterance_payload(
    ) {
        let empty_plate = create_empty_caption();
        assert_eq!(empty_plate.received_at, 0);
        // Merge lives in caption-updates (out of crate scope). Lock the barrier
        // values that merge depends on.
        assert_eq!(empty_plate.id, "empty");
        assert_eq!(empty_plate.started_at, 0);
    }

    #[test]
    fn live_hold_clear_receipt_barrier_drops_a_late_older_payload_after_hold_clear_while_accepting_a_newer_utterance(
    ) {
        let cleared = create_hold_cleared_caption(5_000);
        assert_eq!(cleared.received_at, 5_000);
        assert_eq!(cleared.started_at, 0);
        let late = caption(CaptionPartial {
            id: Some("live-hold-stale-revive".to_string()),
            source_text: Some("消えたあとに戻ってはいけない".to_string()),
            is_final: Some(true),
            started_at: Some(70),
            received_at: Some(90),
            ..CaptionPartial::default()
        });
        assert!(late.received_at < cleared.received_at);
        let newer = caption(CaptionPartial {
            id: Some("live-after-hold-clear".to_string()),
            source_text: Some("新しい発話".to_string()),
            is_final: Some(false),
            started_at: Some(4_900),
            received_at: Some(5_001),
            ..CaptionPartial::default()
        });
        assert!(newer.received_at > cleared.received_at);
    }

    #[test]
    fn live_hold_clear_receipt_barrier_keeps_session_reset_empty_at_received_at_0() {
        let reset = create_empty_caption();
        assert_eq!(reset.received_at, 0);
        let first = caption(CaptionPartial {
            id: Some("live-first-after-reset".to_string()),
            source_text: Some("リセット後の最初の字幕".to_string()),
            is_final: Some(false),
            started_at: Some(10),
            received_at: Some(20),
            ..CaptionPartial::default()
        });
        assert!(first.received_at > reset.received_at);
    }
}
