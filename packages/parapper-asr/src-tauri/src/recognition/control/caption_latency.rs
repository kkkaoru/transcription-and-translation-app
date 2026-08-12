use std::sync::Arc;

use super::{RecognitionSession, clock::CaptionClock, events::TurnCaptionLatency};
use crate::delivery::RecognizedTextOutput;

impl RecognitionSession {
    pub(in crate::recognition) fn note_vad_speech(&mut self, is_speech: bool) {
        if is_speech && !self.activity.vad_was_speech {
            self.activity.pending_speech_onset_at = Some(self.clock.now_millis());
        }
        self.activity.vad_was_speech = is_speech;
    }

    pub(in crate::recognition) fn stamp_asr_dispatch(&mut self, turn_id: u64) {
        let now = self.clock.now_millis();
        let onset = self.activity.pending_speech_onset_at;
        let latency = self.turn_store.caption_latency.entry(turn_id).or_default();
        if latency.speech_start_at.is_none() {
            latency.speech_start_at = onset;
        }
        if latency.asr_dispatch_at.is_none() {
            latency.asr_dispatch_at = Some(now);
        }
    }

    pub(in crate::recognition) fn attach_caption_latency(
        &mut self,
        turn_id: u64,
        is_final: bool,
        output: &mut RecognizedTextOutput,
    ) {
        let now = self.clock.now_millis();
        let onset = self.activity.pending_speech_onset_at;
        let latency = self.turn_store.caption_latency.entry(turn_id).or_default();
        if latency.speech_start_at.is_none() {
            latency.speech_start_at = onset;
        }
        if is_final {
            latency.asr_final_at = Some(now);
        } else if latency.first_partial_at.is_none() {
            latency.first_partial_at = Some(now);
        }
        output.caption_latency = *latency;
        if is_final {
            log::info!(
                "caption_latency turn_id={turn_id} speech_start_at={:?} asr_dispatch_at={:?} first_partial_at={:?} asr_final_at={:?} speech_to_partial_ms={:?} speech_to_final_ms={:?}",
                latency.speech_start_at,
                latency.asr_dispatch_at,
                latency.first_partial_at,
                latency.asr_final_at,
                latency.first_partial_at.and_then(|partial| {
                    latency.speech_start_at.map(|start| partial.saturating_sub(start))
                }),
                latency.asr_final_at.and_then(|final_at| {
                    latency.speech_start_at.map(|start| final_at.saturating_sub(start))
                }),
            );
            self.turn_store.caption_latency.remove(&turn_id);
        }
    }

    #[cfg(test)]
    pub(in crate::recognition) fn set_clock(&mut self, clock: Arc<dyn CaptionClock>) {
        self.clock = clock;
    }
}
