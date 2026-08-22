//! OPEN-segment suffix fencing for the partial-window relay.
//!
//! Port of `apps/desktop/src/core/partialWindowRelay.ts`. This fence is
//! independent from caption freshness/merge state.

/// Last accepted partial-window identity in one renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartialWindowRelayFence {
    pub capture_generation: Option<i64>,
    pub output_sequence: i64,
    pub relay_sequence: i64,
    pub revision: i64,
    pub segment_id: i64,
    pub session_id: String,
    pub turn_session_id: i64,
    pub turn_id: i64,
}

/// Partial-window caption used by the OPEN-segment suffix path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartialWindowCaption {
    pub capture_generation: Option<i64>,
    pub output_sequence: i64,
    pub relay_sequence: i64,
    pub revision: i64,
    pub segment_id: i64,
    pub session_id: String,
    pub text: String,
    pub turn_session_id: i64,
    pub turn_id: i64,
}

/// Snapshot the fence fields from a partial-window caption.
pub fn partial_window_relay_fence(caption: &PartialWindowCaption) -> PartialWindowRelayFence {
    PartialWindowRelayFence {
        capture_generation: caption.capture_generation,
        output_sequence: caption.output_sequence,
        relay_sequence: caption.relay_sequence,
        revision: caption.revision,
        segment_id: caption.segment_id,
        session_id: caption.session_id.clone(),
        turn_session_id: caption.turn_session_id,
        turn_id: caption.turn_id,
    }
}

fn generation_of(capture_generation: Option<i64>) -> i64 {
    capture_generation.unwrap_or(-1)
}

/// Accept only an advancing Main relay sequence, then independently reject a
/// stale capture/session/segment result. Empty text is a real clear event.
pub fn should_apply_partial_window_relay(
    previous: Option<&PartialWindowRelayFence>,
    next: &PartialWindowCaption,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if next.relay_sequence <= previous.relay_sequence {
        return false;
    }
    let next_generation = generation_of(next.capture_generation);
    let previous_generation = generation_of(previous.capture_generation);
    if next_generation < previous_generation {
        return false;
    }
    if next_generation > previous_generation {
        return true;
    }
    if next.session_id != previous.session_id {
        return false;
    }
    if next.text.trim().is_empty() {
        return true;
    }
    if next.turn_session_id != previous.turn_session_id || next.turn_id != previous.turn_id {
        return false;
    }
    if next.segment_id < previous.segment_id {
        return false;
    }
    if next.segment_id == previous.segment_id {
        if next.revision < previous.revision {
            return false;
        }
        if next.revision == previous.revision && next.output_sequence <= previous.output_sequence {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{
        partial_window_relay_fence, should_apply_partial_window_relay, PartialWindowCaption,
        PartialWindowRelayFence,
    };

    fn update(
        capture_generation: i64,
        output_sequence: i64,
        relay_sequence: i64,
        revision: i64,
        segment_id: i64,
        session_id: &str,
        text: &str,
        turn_id: i64,
        turn_session_id: i64,
    ) -> PartialWindowCaption {
        PartialWindowCaption {
            capture_generation: Some(capture_generation),
            output_sequence,
            relay_sequence,
            revision,
            segment_id,
            session_id: session_id.to_string(),
            text: text.to_string(),
            turn_id,
            turn_session_id,
        }
    }

    fn apply(
        state_fence: &mut Option<PartialWindowRelayFence>,
        state_text: &mut String,
        next: PartialWindowCaption,
    ) {
        if !should_apply_partial_window_relay(state_fence.as_ref(), &next) {
            return;
        }
        *state_fence = Some(partial_window_relay_fence(&next));
        *state_text = next.text;
    }

    #[test]
    fn keeps_the_slot_empty_when_a_delayed_set_arrives_after_its_clear() {
        let mut fence = None;
        let mut text = String::new();
        apply(&mut fence, &mut text, update(4, 9, 41, 3, 7, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(4, 9, 42, 3, 7, "capture-4", "", 11, 10));
        apply(&mut fence, &mut text, update(4, 9, 41, 3, 7, "capture-4", "OPEN suffix", 11, 10));
        assert_eq!(text, "");
        assert_eq!(fence.as_ref().map(|value| value.relay_sequence), Some(42));
    }

    #[test]
    fn cannot_paint_a_prior_capture_or_session_after_a_capture_restart() {
        let mut fence = None;
        let mut text = String::new();
        apply(&mut fence, &mut text, update(4, 9, 50, 3, 7, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(5, 1, 51, 1, 1, "capture-5", "new capture", 1, 1));
        apply(
            &mut fence,
            &mut text,
            update(4, 9, 52, 3, 7, "capture-4", "late old capture", 11, 10),
        );
        apply(&mut fence, &mut text, update(5, 1, 53, 1, 1, "wrong-session", "wrong", 1, 1));
        assert_eq!(text, "new capture");
        assert_eq!(fence.as_ref().map(|value| value.capture_generation), Some(Some(5)));
        assert_eq!(fence.as_ref().map(|value| value.session_id.as_str()), Some("capture-5"));
    }

    #[test]
    fn rejects_an_older_open_segment_revision_or_output_sequence() {
        let mut fence = None;
        let mut text = String::new();
        apply(&mut fence, &mut text, update(4, 12, 60, 4, 7, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(4, 13, 61, 3, 7, "capture-4", "old revision", 11, 10));
        apply(&mut fence, &mut text, update(4, 12, 62, 4, 7, "capture-4", "duplicate", 11, 10));
        assert_eq!(text, "OPEN suffix");
        assert_eq!(fence.as_ref().map(|value| value.output_sequence), Some(12));
        assert_eq!(fence.as_ref().map(|value| value.revision), Some(4));
        assert_eq!(fence.as_ref().map(|value| value.segment_id), Some(7));
    }

    #[test]
    fn rejects_a_mismatched_turn_and_a_segment_older_than_the_accepted_open_segment() {
        let mut fence = None;
        let mut text = String::new();
        apply(&mut fence, &mut text, update(4, 9, 70, 3, 7, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(4, 9, 71, 3, 7, "capture-4", "wrong turn", 12, 10));
        apply(&mut fence, &mut text, update(4, 9, 72, 3, 6, "capture-4", "older segment", 11, 10));
        assert_eq!(text, "OPEN suffix");
        assert_eq!(fence.as_ref().map(|value| value.relay_sequence), Some(70));
        assert_eq!(fence.as_ref().map(|value| value.segment_id), Some(7));
        assert_eq!(fence.as_ref().map(|value| value.turn_id), Some(11));
    }

    #[test]
    fn accepts_a_newer_segment_and_a_newer_revision_in_the_current_segment() {
        let mut fence = None;
        let mut text = String::new();
        apply(&mut fence, &mut text, update(4, 9, 80, 3, 7, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(4, 1, 81, 1, 8, "capture-4", "OPEN suffix", 11, 10));
        apply(&mut fence, &mut text, update(4, 2, 82, 2, 8, "capture-4", "newer suffix", 11, 10));
        assert_eq!(text, "newer suffix");
        assert_eq!(fence.as_ref().map(|value| value.output_sequence), Some(2));
        assert_eq!(fence.as_ref().map(|value| value.revision), Some(2));
        assert_eq!(fence.as_ref().map(|value| value.segment_id), Some(8));
    }
}
