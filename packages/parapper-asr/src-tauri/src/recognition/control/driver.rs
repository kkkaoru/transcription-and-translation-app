use std::{
    ops::{Deref, DerefMut},
    thread,
    time::{Duration, Instant},
};

use tauri::AppHandle;

use super::{AsrWorkerStartupSender, RecognitionSession, pending::PendingTurnCheck};
use crate::{
    config::ParapperConfig,
    recognition::segmentation::{
        flow::{SegmentationFlow, SegmentationFrameEvents},
        segment::builder::{SegmentBuilderEvent, SegmentCloseReason},
        vad::engine::VadResult,
    },
};

pub(crate) trait RecognitionDriverHandle {
    fn update_config(&mut self, config: &ParapperConfig);
    fn push_vad_frame(&mut self, samples: &[f32], vad_result: VadResult);
    fn step(&mut self);
    fn shutdown(&mut self) -> RecognitionShutdownResult;
    fn cancel(&mut self) {
        let _ = self.shutdown();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecognitionShutdownResult {
    Completed,
    TimedOut,
    Cancelled,
}

pub(crate) struct RecognitionDriver {
    runtime: RecognitionSession,
    segmentation_flow: SegmentationFlow,
}

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(1);

#[cfg(test)]
pub(crate) fn replay_vad_frames_for_runtime(
    runtime: &mut dyn RecognitionDriverHandle,
    config: &ParapperConfig,
    frames: impl IntoIterator<Item = (Vec<f32>, VadResult)>,
) {
    runtime.update_config(config);
    for (samples, vad_result) in frames {
        runtime.push_vad_frame(&samples, vad_result);
        runtime.step();
    }
}

impl RecognitionDriver {
    #[cfg(test)]
    pub(crate) fn new_for_production(
        handle: &AppHandle,
        config: &ParapperConfig,
        asr_startup_sender: Option<AsrWorkerStartupSender>,
    ) -> Self {
        Self::new(
            RecognitionSession::new_for_production(handle, config, asr_startup_sender),
            config,
        )
    }

    /// Production driver with a session-scoped output sink (see
    /// [`RecognitionSession::new_for_production_with_output_sink`]).
    pub(crate) fn new_for_production_with_output_sink(
        handle: &AppHandle,
        config: &ParapperConfig,
        asr_startup_sender: Option<AsrWorkerStartupSender>,
        output_sink: Box<dyn super::TurnOutputSink>,
    ) -> Self {
        Self::new(
            RecognitionSession::new_for_production_with_output_sink(
                handle,
                config,
                asr_startup_sender,
                output_sink,
            ),
            config,
        )
    }

    pub(in crate::recognition) fn new(
        runtime: RecognitionSession,
        config: &ParapperConfig,
    ) -> Self {
        Self { runtime, segmentation_flow: SegmentationFlow::new(config) }
    }

    fn shutdown_flush_and_drain(&mut self) -> RecognitionShutdownResult {
        let frame_events = self.segmentation_flow.flush();
        self.runtime.push_segment_event_frame(frame_events);
        let started_at = Instant::now();
        // Shutdown is an input boundary, so drive queued ASR and pending finalization
        // far enough that an active tail segment is not dropped with the worker.
        while self.runtime.has_shutdown_drain_work() {
            self.step();
            if !self.runtime.has_shutdown_drain_work() {
                break;
            }
            if started_at.elapsed() >= SHUTDOWN_DRAIN_TIMEOUT {
                log::warn!("Timed out while draining recognition shutdown work");
                return RecognitionShutdownResult::TimedOut;
            }
            thread::sleep(SHUTDOWN_DRAIN_POLL_INTERVAL);
        }
        if let Some(open_turn_id) = self.runtime.turn_store.open_turn_id
            && !self.runtime.has_shutdown_drain_work()
        {
            // No more audio can arrive after shutdown; an open Namo suffix must fall
            // back to final instead of waiting for runtime ticks that will never come.
            self.runtime.finalize_timeout_turn_after_rerecognition(open_turn_id);
        }
        RecognitionShutdownResult::Completed
    }
}

impl Deref for RecognitionDriver {
    type Target = RecognitionSession;

    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl DerefMut for RecognitionDriver {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}

impl RecognitionSession {
    fn update_config(&mut self, config: &ParapperConfig) {
        if self.config == *config {
            return;
        }
        let route_settings_changed = self.config.asr.language != config.asr.language
            || self.config.asr.model != config.asr.model
            || self.config.asr.interim_model != config.asr.interim_model
            || self.config.asr.multilingual_enabled != config.asr.multilingual_enabled
            || self.config.asr.enabled_models != config.asr.enabled_models;
        self.config = config.clone();
        if route_settings_changed {
            self.turn_store.last_recognition_route = None;
            self.pending.interim_asr.clear_streaming();
        }
        self.io.asr_runner.update_config(config);
        self.io.turn_decision_runner.update_config(config);
        self.io.output_sink.update_config(config);
        if !config.asr.multilingual_enabled {
            self.io.language_id = None;
        } else if self.io.language_id.is_none() {
            self.io.language_id = self
                .io
                .language_id_runtime
                .as_ref()
                .and_then(|runtime| runtime.build_language_id(config));
        }
    }

    fn advance_runtime_tick(&mut self) {
        self.counters.next_runtime_tick = self.counters.next_runtime_tick.saturating_add(1);
    }

    pub(in crate::recognition) fn push_segment_event_frame(
        &mut self,
        frame_events: SegmentationFrameEvents,
    ) {
        self.counters.global_sample_cursor =
            self.counters.global_sample_cursor.saturating_add(frame_events.samples_len as u64);
        self.counters.next_vad_frame_index = self.counters.next_vad_frame_index.saturating_add(1);

        for event in frame_events.events {
            match event {
                SegmentBuilderEvent::SegmentStarted {
                    segment_id,
                    previous_segment_id,
                    audio_so_far,
                    vad_results,
                } => {
                    self.activity.segment_activity_epoch =
                        self.activity.segment_activity_epoch.saturating_add(1);
                    self.record_interim_segment_started(
                        segment_id,
                        previous_segment_id,
                        audio_so_far,
                        vad_results,
                    );
                }
                SegmentBuilderEvent::SegmentExtended {
                    segment_id,
                    previous_segment_id,
                    new_audio,
                    vad_result,
                } => {
                    self.activity.segment_activity_epoch =
                        self.activity.segment_activity_epoch.saturating_add(1);
                    self.record_interim_segment_extended(
                        segment_id,
                        previous_segment_id,
                        new_audio,
                        vad_result,
                    );
                }
                SegmentBuilderEvent::TurnCheckSilenceReached { previous_segment_id } => {
                    self.pending.turn_check = Some(PendingTurnCheck {
                        previous_segment_id,
                        activity_epoch: self.activity.segment_activity_epoch,
                    });
                }
                SegmentBuilderEvent::SegmentClosed {
                    segment_id,
                    previous_segment_id,
                    full_audio,
                    vad_results,
                    source_audio,
                    source_vad_results,
                    reason,
                } => {
                    if reason == SegmentCloseReason::EndSilenceReached {
                        self.reset_interim_streaming_for_completion(segment_id);
                    }
                    self.record_segment_closed_asr_candidate(
                        segment_id,
                        previous_segment_id,
                        full_audio,
                        vad_results,
                        source_audio,
                        source_vad_results,
                        reason,
                    );
                }
            }
        }
    }
}

impl RecognitionDriverHandle for RecognitionDriver {
    fn update_config(&mut self, config: &ParapperConfig) {
        self.segmentation_flow.update_config(config);
        self.runtime.update_config(config);
    }

    fn push_vad_frame(&mut self, samples: &[f32], vad_result: VadResult) {
        self.runtime.advance_runtime_tick();
        self.runtime.note_vad_speech(vad_result.is_speech);
        let frame_events = self.segmentation_flow.push_vad_frame(samples, vad_result);
        self.runtime.push_segment_event_frame(frame_events);
    }

    fn step(&mut self) {
        let in_flight_before =
            self.runtime.requests.in_flight_request.as_ref().map(|request| request.request_id);
        let applied_asr = self.runtime.apply_completed_asr_result_if_ready();
        if applied_asr
            && self
                .runtime
                .requests
                .in_flight_request
                .as_ref()
                .is_some_and(|request| Some(request.request_id) == in_flight_before)
        {
            // Only a mismatched result keeps the original in-flight request.
            // Completion that starts grammar rerecognition occupies the slot
            // with a *new* request; same-tick dispatch_next must still run so
            // a yielded next utterance can take that slot immediately.
            return;
        }

        if self.runtime.process_pending_finalization_if_ready() {
            // The next utterance's pending ASR is for a newer turn (otherwise
            // finalization would still be blocked). Dispatch it now so the
            // first hypothesis does not wait another VAD/input tick.
            self.runtime.dispatch_next_asr_request_if_idle();
            return;
        }

        if let Some(turn_check) = self.runtime.pending.turn_check {
            if turn_check.activity_epoch != self.runtime.activity.segment_activity_epoch {
                // Stale check: new speech already advanced the epoch. Drop it
                // and fall through so queued ASR for that speech can dispatch.
                self.runtime.pending.turn_check = None;
            } else if self.runtime.handle_turn_check_silence_reached(turn_check.previous_segment_id)
            {
                self.runtime.pending.turn_check = None;
                // CompleteWithoutGrammar / Ignore used to return here, so a
                // newer utterance already queued waited another VAD tick.
                // Promote/rerecognition already occupy in-flight; dispatch is
                // then a no-op.
                self.runtime.dispatch_next_asr_request_if_idle();
                return;
            } else {
                return;
            }
        }

        // A just-applied ASR result must not re-enter timeout rerecognition in
        // the same step (failed timeout rerecognition already finalized).
        // Pending segments and turn-check promotion above still run so the
        // next caption does not wait for another VAD/input tick.
        if !applied_asr && self.runtime.handle_open_turn_timeout() {
            // Timeout may finalize immediately (Simple) or occupy in-flight
            // with rerecognition. Either way, a newer utterance already queued
            // must not wait another VAD tick.
            self.runtime.dispatch_next_asr_request_if_idle();
            return;
        }

        self.runtime.dispatch_next_asr_request_if_idle();
    }

    fn shutdown(&mut self) -> RecognitionShutdownResult {
        let result = self.shutdown_flush_and_drain();
        self.runtime.io.asr_runner.shutdown();
        result
    }

    fn cancel(&mut self) {
        self.runtime.io.asr_runner.shutdown();
    }
}

impl RecognitionSession {
    fn has_shutdown_drain_work(&self) -> bool {
        self.requests.in_flight_request.is_some()
            || self.pending.turn_check.is_some()
            || self.pending.finalization.is_some()
            || !self.pending.asr_segments.is_empty()
            || self.requests.deferred_completion.is_some()
            || self.requests.deferred_rerecognition.is_some()
    }
}
