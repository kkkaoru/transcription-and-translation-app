use crate::{
    delivery::{RecognizedTextMeta, RecognizedTextOutput},
    recognition::{
    control::{RecognitionSession, RerecognitionPurpose},
    control::events::RecognitionSourceMeta,
    control::input::RecognitionStreamOutput,
    segmentation::segment::builder::SegmentCloseReason,
    segmentation::vad::engine::VadResult,
    transcription::{
        asr::{
            engine::AsrTranscript,
            task::{
                AsrInFlight, AsrRequest, AsrRequestId, AsrResult, AsrTarget, AsrTaskKind,
                AudioRange, GlobalSampleIndex, VadFrameIndex,
            },
        },
        planner::{
            PendingAsrSegment, drop_front_interim_segments_covered_by_completion,
            take_next_request_segment_plan,
        },
        reducer::{
            AsrRequestStaleInput, AsrResultAction, AsrResultCompletionAfterTranscript,
            AsrResultCompletionFailureAction, AsrResultReductionInput,
            AsrResultRerecognitionPurpose, reduce_asr_result,
        },
        route::{
            RecognitionRoute, RecognitionRouteSelection,
            language_id::LanguageDetector,
            selection::{AsrInput, TurnInput, refresh_turn, select_asr},
        },
    },
    },
};

impl RecognitionSession {
    #[expect(
        clippy::too_many_arguments,
        reason = "closed segment handling keeps ASR request audio and continuous turn-source audio separate"
    )]
    pub(in crate::recognition) fn record_segment_closed_asr_candidate(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        full_audio: Vec<f32>,
        vad_results: Vec<VadResult>,
        source_audio: Vec<f32>,
        source_vad_results: Vec<VadResult>,
        reason: SegmentCloseReason,
    ) {
        if full_audio.is_empty() {
            log::warn!("Ignoring empty ASR segment: segment_id={segment_id}");
            return;
        }
        let audio_len = full_audio.len() as u64;
        let end_sample = GlobalSampleIndex(self.counters.global_sample_cursor);
        let start_sample =
            GlobalSampleIndex(self.counters.global_sample_cursor.saturating_sub(audio_len));
        let segment = PendingAsrSegment {
            segment_id,
            previous_segment_id,
            audio: full_audio,
            vad_results,
            source_audio,
            source_vad_results,
            reason,
            range: AudioRange::new(start_sample, end_sample),
            created_at_frame: VadFrameIndex(self.counters.next_vad_frame_index),
        };
        if reason == SegmentCloseReason::InterimResultSilenceReached {
            let streaming_interim_enabled = self.streaming_interim_asr_enabled();
            if let Some(segment) =
                self.pending.interim_asr.interim_request(streaming_interim_enabled, segment)
            {
                self.pending.asr_segments.push_back(segment);
            }
        } else {
            self.pending.asr_segments.push_back(segment);
        }
    }

    pub(in crate::recognition) fn record_interim_segment_started(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        audio_so_far: Vec<f32>,
        vad_results: Vec<VadResult>,
    ) {
        if self.partial_window_asr_enabled && !self.streaming_interim_asr_enabled() {
            self.pending.partial_window.start_segment(
                segment_id,
                previous_segment_id,
                audio_so_far.clone(),
                vad_results.clone(),
                GlobalSampleIndex(self.counters.global_sample_cursor),
                VadFrameIndex(self.counters.next_vad_frame_index),
                self.counters.next_runtime_tick,
                self.config.segmentation.vad_interval_ms,
            );
        } else {
            self.pending.partial_window.reset();
        }
        if !self.streaming_interim_asr_enabled() {
            self.pending.interim_asr.clear_streaming();
            return;
        }
        let ready = self.pending.interim_asr.start_streaming_segment(
            segment_id,
            previous_segment_id,
            audio_so_far,
            vad_results,
            GlobalSampleIndex(self.counters.global_sample_cursor),
            VadFrameIndex(self.counters.next_vad_frame_index),
        );
        self.pending.asr_segments.extend(ready);
    }

    pub(in crate::recognition) fn record_interim_segment_extended(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        new_audio: Vec<f32>,
        vad_result: VadResult,
    ) {
        if self.partial_window_asr_enabled && !self.streaming_interim_asr_enabled() {
            self.pending.partial_window.extend_segment(
                segment_id,
                previous_segment_id,
                new_audio.clone(),
                vad_result,
                GlobalSampleIndex(self.counters.global_sample_cursor),
                VadFrameIndex(self.counters.next_vad_frame_index),
                self.counters.next_runtime_tick,
                self.config.segmentation.vad_interval_ms,
            );
        }
        if !self.streaming_interim_asr_enabled() {
            self.pending.interim_asr.clear_streaming();
            return;
        }
        let ready = self.pending.interim_asr.extend_streaming_segment(
            segment_id,
            previous_segment_id,
            new_audio,
            vad_result,
            GlobalSampleIndex(self.counters.global_sample_cursor),
            VadFrameIndex(self.counters.next_vad_frame_index),
        );
        self.pending.asr_segments.extend(ready);
    }

    pub(in crate::recognition) fn reset_partial_window_for_segment(&mut self, segment_id: u64) {
        self.pending.partial_window.close_segment(segment_id);
    }

    pub(in crate::recognition) fn reset_interim_streaming_for_completion(
        &mut self,
        segment_id: u64,
    ) {
        // Keep queued / remainder Nemotron chunks so the utterance tail can
        // decode before Reazon completion. Reset the streaming cache only after
        // those InterimChunkReached requests have been submitted.
        if let Some((_display_segment_id, flushed)) =
            self.pending.interim_asr.flush_streaming_if_segment(segment_id)
        {
            self.pending.asr_segments.extend(flushed);
        } else {
            self.pending.interim_asr.clear_streaming();
        }
        self.pending.deferred_streaming_session_reset = true;
        self.apply_deferred_streaming_session_reset_if_ready();
    }

    pub(in crate::recognition) fn apply_deferred_streaming_session_reset_if_ready(&mut self) {
        if !self.pending.deferred_streaming_session_reset {
            return;
        }
        let has_pending_streaming_chunk = self
            .pending
            .asr_segments
            .iter()
            .any(|segment| segment.reason == SegmentCloseReason::InterimChunkReached);
        let in_flight_is_streaming_chunk =
            self.requests.in_flight_request.as_ref().is_some_and(|request| {
                request.close_reason == Some(SegmentCloseReason::InterimChunkReached)
            });
        if has_pending_streaming_chunk || in_flight_is_streaming_chunk {
            return;
        }
        self.io.asr_runner.reset_streaming_sessions();
        self.pending.deferred_streaming_session_reset = false;
    }

    fn streaming_interim_asr_enabled(&self) -> bool {
        self.config.turn.interim_result_enabled
            && self.config.asr.interim_model.unwrap_or(self.config.asr.model).is_nemotron()
    }

    pub(in crate::recognition) fn take_next_request_id(&mut self) -> u64 {
        let request_id = self.counters.next_request_id;
        self.counters.next_request_id = self.counters.next_request_id.saturating_add(1);
        request_id
    }

    pub(in crate::recognition) fn dispatch_next_asr_request_if_idle(&mut self) {
        self.yield_rerecognition_slot_for_next_utterance();
        self.yield_rerecognition_slot_for_same_turn_continuation();
        self.yield_completion_slot_for_same_turn_continuation();
        if self.requests.in_flight_request.is_some() {
            if self.partial_window_asr_enabled && !self.streaming_interim_asr_enabled() {
                self.pending.partial_window.skip_due_if_busy(
                    self.counters.next_runtime_tick,
                    self.config.segmentation.vad_interval_ms,
                );
            }
            return;
        }
        self.dispatch_deferred_completion_if_idle();
        if self.requests.in_flight_request.is_some() {
            return;
        }
        self.dispatch_deferred_rerecognition_if_idle();
        if self.requests.in_flight_request.is_some() {
            return;
        }
        self.finalize_open_turn_if_after_interim_silence_follows_160ms();
        drop_front_interim_segments_covered_by_completion(&mut self.pending.asr_segments);
        let Some(request) = self.build_next_asr_request() else {
            self.dispatch_partial_window_if_idle();
            self.apply_deferred_streaming_session_reset_if_ready();
            return;
        };
        let in_flight = AsrInFlight::from(&request);
        if !self.io.asr_runner.submit(request.clone()) {
            log::warn!(
                "Dropping ASR request after submit failure: request_id={:?} kind={:?}",
                request.request_id,
                request.kind,
            );
            return;
        }
        let turn_id = request.target.turn_id.0;
        self.requests.in_flight_request = Some(request);
        self.requests.last_dispatched = Some(in_flight);
        self.stamp_asr_dispatch(turn_id);
        self.apply_deferred_streaming_session_reset_if_ready();
    }

    /// Partial-window work is intentionally the last dispatch candidate.  It
    /// never waits in a queue: a due tick is consumed while another ASR task is
    /// in flight, and the next adaptive gap starts from the following tick.
    fn dispatch_partial_window_if_idle(&mut self) {
        if !self.partial_window_asr_enabled || self.streaming_interim_asr_enabled() {
            return;
        }
        if self.requests.in_flight_request.is_some() {
            self.pending.partial_window.skip_due_if_busy(
                self.counters.next_runtime_tick,
                self.config.segmentation.vad_interval_ms,
            );
            return;
        }
        let Some(snapshot) = self.pending.partial_window.take_due(
            self.counters.next_runtime_tick,
            self.config.segmentation.vad_interval_ms,
        ) else {
            return;
        };
        let Some(request) = self.build_partial_window_request(snapshot) else {
            return;
        };
        if !self.io.asr_runner.submit(request.clone()) {
            log::warn!(
                "Dropping partial-window ASR request after submit failure: request_id={:?} segment_id={:?}",
                request.request_id,
                request.target.last_segment_id,
            );
            return;
        }
        log::debug!(
            "partial_window_asr dispatched: request_id={:?} turn_id={} segment_id={:?} audio_samples={} gap_ms={}",
            request.request_id,
            request.target.turn_id.0,
            request.target.last_segment_id,
            request.audio.len(),
            self.pending.partial_window.gap_millis(),
        );
        self.pending.partial_window.mark_dispatched();
        self.requests.in_flight_request = Some(request.clone());
        self.requests.last_dispatched = Some(AsrInFlight::from(&request));
        self.stamp_asr_dispatch(request.target.turn_id.0);
    }

    fn build_partial_window_request(
        &mut self,
        snapshot: crate::recognition::control::PartialWindowSnapshot,
    ) -> Option<AsrRequest> {
        if snapshot.audio.is_empty() {
            return None;
        }
        let target_turn_id = self
            .turn_store
            .open_turn_id
            .filter(|turn_id| !self.turn_store.finalized_turns.contains(turn_id))
            .unwrap_or(snapshot.segment_id);
        let route_selection = self.route_selection_for_asr_request(
            target_turn_id,
            AsrTaskKind::PartialWindow,
            SegmentCloseReason::SegmentMaxChunksReached,
            snapshot.audio.as_slice(),
        );
        let revision = *self.turn_store.revisions.get(&target_turn_id).unwrap_or(&0);
        let request_id = AsrRequestId(self.take_next_request_id());
        let target = AsrTarget::new(
            crate::recognition::transcription::asr::task::TurnId(target_turn_id),
            crate::recognition::transcription::asr::task::TurnRevision(revision),
            snapshot.range,
            snapshot.previous_segment_id.map(
                crate::recognition::transcription::asr::task::SegmentId,
            ).or_else(|| {
                Some(crate::recognition::transcription::asr::task::SegmentId(
                    snapshot.segment_id,
                ))
            }),
            Some(crate::recognition::transcription::asr::task::SegmentId(
                snapshot.segment_id,
            )),
        );
        Some(AsrRequest {
            request_id,
            kind: AsrTaskKind::PartialWindow,
            target,
            route: route_selection.route,
            detected_language: route_selection.detected_language,
            audio: snapshot.audio.clone(),
            vad_results: snapshot.vad_results.clone(),
            source_audio: snapshot.audio,
            source_vad_results: snapshot.vad_results,
            // Partial windows are not segment-close candidates.  Keeping the
            // reason empty prevents the turn completion and Nemotron streaming
            // paths from treating this request as a normal segment result.
            close_reason: None,
            created_at_frame: snapshot.created_at_frame,
        })
    }

    fn build_next_asr_request(&mut self) -> Option<AsrRequest> {
        loop {
            let plan = take_next_request_segment_plan(
                &self.config,
                &mut self.pending.asr_segments,
                self.turn_store.open_turn_id,
            )?;
            let range = plan.range();
            if range.end_sample <= self.turn_store.confirmed_until_sample {
                log::warn!(
                    "Dropping pending ASR segment plan already covered by confirmed audio: range={:?} confirmed_until={:?}",
                    range,
                    self.turn_store.confirmed_until_sample,
                );
                continue;
            }
            let mut target_turn_id = plan.target_turn_id(
                &self.config,
                self.turn_store.open_turn_id,
                self.turn_store.open_turn_accepts_root_segment,
            );
            // A child segment can still name a just-finalized turn (greeting /
            // completion sealed the draft while SegmentBuilder was in
            // AfterInterimSilence). New audio must become the next turn instead
            // of vanishing. Late plans whose own segment id *is* the finalized
            // turn stay dropped so a finished caption cannot be reopened.
            // When the natural remint id is already finalized, open, or live for a
            // different reason, allocate a fresh turn id instead of dropping or
            // cross-wiring into an existing turn namespace.
            if self.turn_store.finalized_turns.contains(&target_turn_id) {
                let reminted_turn_id = plan.first_segment_id();
                if reminted_turn_id != target_turn_id
                    && !self.turn_id_is_already_issued(reminted_turn_id)
                {
                    log::info!(
                        "Starting a new turn after finalized turn attachment: finalized={target_turn_id} new_turn={reminted_turn_id} range={range:?}"
                    );
                    target_turn_id = reminted_turn_id;
                } else if reminted_turn_id == target_turn_id {
                    log::warn!(
                        "Dropping pending ASR segment plan for finalized turn: turn_id={target_turn_id} range={range:?}",
                    );
                    continue;
                } else {
                    let fresh_turn_id = self.take_unconflicting_turn_id();
                    log::info!(
                        "Starting a fresh turn after remint id collision: finalized_target={target_turn_id} colliding_remint={reminted_turn_id} new_turn={fresh_turn_id} range={range:?}"
                    );
                    target_turn_id = fresh_turn_id;
                }
            }
            let source_audio = plan.source_audio();
            let route_selection = self.route_selection_for_asr_request(
                target_turn_id,
                plan.kind,
                plan.first_reason(),
                source_audio.as_slice(),
            );
            let revision = *self.turn_store.revisions.get(&target_turn_id).unwrap_or(&0);
            let request_id = AsrRequestId(self.take_next_request_id());
            return Some(plan.into_request(
                &self.config,
                request_id,
                target_turn_id,
                revision,
                RecognitionRouteSelection {
                    route: route_selection.route,
                    detected_language: route_selection.detected_language,
                },
            ));
        }
    }

    fn turn_id_is_already_issued(&self, turn_id: u64) -> bool {
        self.turn_store.finalized_turns.contains(&turn_id)
            || self.turn_store.turns.contains_key(&turn_id)
            || self.turn_store.open_turn_id == Some(turn_id)
            || self
                .requests
                .in_flight_request
                .as_ref()
                .is_some_and(|request| request.target.turn_id.0 == turn_id)
            || self
                .requests
                .last_dispatched
                .as_ref()
                .is_some_and(|request| request.target.turn_id.0 == turn_id)
    }

    fn take_unconflicting_turn_id(&mut self) -> u64 {
        loop {
            let candidate = self.counters.next_turn_id;
            self.counters.next_turn_id = candidate.saturating_add(1);
            if !self.turn_id_is_already_issued(candidate) {
                return candidate;
            }
        }
    }

    fn route_selection_for_asr_request(
        &mut self,
        turn_id: u64,
        kind: AsrTaskKind,
        close_reason: SegmentCloseReason,
        request_audio: &[f32],
    ) -> RecognitionRouteSelection {
        let current_route = self.route_hint_for_request(turn_id);
        let draft_audio =
            self.turn_store.turns.get(&turn_id).map(|turn| turn.draft().full_audio.as_slice());
        let language_id = self
            .io
            .language_id
            .as_mut()
            .map(|detector| detector.as_mut() as &mut dyn LanguageDetector);
        select_asr(
            AsrInput {
                config: &self.config,
                warning_sink: self
                    .io
                    .language_id_runtime
                    .as_deref()
                    .map(|runtime| runtime as &dyn crate::recognition::transcription::route::language_id::LanguageDetectionWarningSink),
                kind,
                close_reason,
                current_route,
                fallback_route: RecognitionRoute::from_model(self.config.asr.model),
                draft_audio,
                request_audio,
            },
            language_id,
        )
    }

    fn route_hint_for_request(&self, turn_id: u64) -> Option<RecognitionRoute> {
        self.turn_store
            .turns
            .get(&turn_id)
            .and_then(|turn| turn.draft().route)
            .or(self.turn_store.last_recognition_route)
    }

    pub(in crate::recognition) fn refresh_turn_route_with_sli(&mut self, turn_id: u64) {
        let Some((draft_route, full_audio)) = self
            .turn_store
            .turns
            .get(&turn_id)
            .map(|turn| (turn.draft().route, turn.draft().full_audio.clone()))
        else {
            return;
        };
        let language_id = self
            .io
            .language_id
            .as_mut()
            .map(|detector| detector.as_mut() as &mut dyn LanguageDetector);
        let Some(selection) = refresh_turn(
            TurnInput {
                config: &self.config,
                warning_sink: self
                    .io
                    .language_id_runtime
                    .as_deref()
                    .map(|runtime| runtime as &dyn crate::recognition::transcription::route::language_id::LanguageDetectionWarningSink),
                current_route: draft_route.or(self.turn_store.last_recognition_route),
                full_audio: &full_audio,
            },
            language_id,
        ) else {
            return;
        };

        if let Some(turn) = self.turn_store.turns.get_mut(&turn_id) {
            let draft = turn.draft_mut();
            draft.route = Some(selection.route);
            draft.set_detected_language(selection.detected_language);
        }
    }

    pub(in crate::recognition) fn apply_completed_asr_result_if_ready(&mut self) -> bool {
        let Some(result) = self.io.asr_runner.try_recv_result() else {
            return false;
        };
        let Some(request) = self.requests.in_flight_request.take() else {
            log::warn!(
                "Dropping ASR result without an in-flight request: request_id={:?} kind={:?}",
                result.request_id,
                result.kind,
            );
            return true;
        };
        if request.kind == AsrTaskKind::PartialWindow
            && !request
                .target
                .last_segment_id
                .is_some_and(|segment_id| self.pending.partial_window.matches_segment(segment_id.0))
        {
            // SegmentClosed resets the OPEN snapshot.  A completion-model
            // result that races that reset belongs to the closed segment and
            // must not repopulate the display suffix or affect throttle state.
            log::debug!(
                "partial_window_asr drop result after segment close: request_id={:?} segment_id={:?}",
                request.request_id,
                request.target.last_segment_id,
            );
            return true;
        }
        let action = self.reduce_asr_result_for_runtime(&result, &request);
        if matches!(action, AsrResultAction::KeepInFlightForMismatchedResult { .. }) {
            self.apply_asr_result_action(&request, action);
            self.requests.in_flight_request = Some(request);
            return true;
        }
        if request.kind == AsrTaskKind::PartialWindow {
            self.pending.partial_window.record_decode(
                self.counters.next_runtime_tick,
                result.elapsed_millis,
                result.decode_millis.unwrap_or(result.elapsed_millis),
                request.audio.len(),
                self.config.segmentation.vad_interval_ms,
            );
        }
        self.apply_asr_result_action(&request, action);
        self.apply_deferred_streaming_session_reset_if_ready();
        true
    }

    fn reduce_asr_result_for_runtime(
        &self,
        result: &AsrResult,
        request: &AsrRequest,
    ) -> AsrResultAction {
        reduce_asr_result(
            result,
            request,
            AsrResultReductionInput {
                stale_input: self.stale_input_for_request(request),
                completion_has_non_empty_draft: request.kind == AsrTaskKind::CompletionCheck
                    && self.turn_has_non_empty_draft(request.target.turn_id.0),
                completion_failure_action: self.completion_failure_action_for_request(),
                completion_rerecognition_purpose: self
                    .rerecognition_purpose_after_completion()
                    .map(result_purpose_from_runtime),
                pending_rerecognition_purpose: self
                    .requests
                    .pending_rerecognition_purpose
                    .map(result_purpose_from_runtime),
            },
        )
    }

    fn apply_asr_result_action(&mut self, request: &AsrRequest, action: AsrResultAction) {
        match action {
            AsrResultAction::KeepInFlightForMismatchedResult {
                result_request_id,
                in_flight_request_id,
            } => {
                log::warn!(
                    "Ignoring ASR result that does not match the current in-flight request: result_id={result_request_id:?} in_flight_id={in_flight_request_id:?}",
                );
            }
            AsrResultAction::DropStaleResult
            | AsrResultAction::DropUnusableInterim
            | AsrResultAction::DropUnusablePartialWindow
            | AsrResultAction::DropUnusableCompletionWithoutDraft => {}
            AsrResultAction::FallbackCompletionWithNamo { turn_id } => {
                self.apply_unusable_completion_audio_keep_visible(request);
                self.complete_or_continue_turn_with_namo(turn_id);
            }
            AsrResultAction::FallbackCompletionWithoutGrammar { turn_id } => {
                self.apply_unusable_completion_audio_keep_visible(request);
                self.complete_turn_without_grammar(turn_id);
            }
            AsrResultAction::FallbackCompletionKeepOpen { turn_id } => {
                self.apply_unusable_completion_audio_keep_visible(request);
                self.keep_turn_open(turn_id, true);
            }
            AsrResultAction::FallbackRerecognition { turn_id, purpose } => {
                self.requests.pending_rerecognition_purpose.take();
                self.apply_rerecognition_follow_up(turn_id, purpose);
            }
            AsrResultAction::ApplyInterimTranscript { transcript, elapsed_millis } => {
                let turn_id = self.apply_segment_transcript(request, transcript, elapsed_millis);
                self.emit_turn_output(turn_id, false);
                let previous_open_turn_id = self.turn_store.open_turn_id;
                if self.turn_store.open_turn_id.is_none_or(|open_turn_id| open_turn_id <= turn_id) {
                    self.turn_store.open_turn_id = Some(turn_id);
                    if previous_open_turn_id != Some(turn_id) {
                        self.turn_store.open_turn_accepts_root_segment = false;
                    }
                }
            }
            AsrResultAction::ApplyPartialWindowTranscript { transcript, elapsed_millis } => {
                self.emit_partial_window_output(request, transcript, elapsed_millis);
            }
            AsrResultAction::ApplyCompletionTranscript {
                transcript,
                elapsed_millis,
                after_transcript,
            } => {
                let turn_id = self.apply_segment_transcript(request, transcript, elapsed_millis);
                match after_transcript {
                    AsrResultCompletionAfterTranscript::RerecognizeIfIdle(purpose) => {
                        let purpose = runtime_purpose_from_result(purpose);
                        if self.has_deferred_completion() {
                            // Same-utterance tail applied first. Keep the draft
                            // open and restart grammar rerecognition after the
                            // deferred prefix CompletionCheck resumes.
                            self.requests.deferred_rerecognition = Some((turn_id, purpose));
                            self.emit_waiting_draft_if_blank_or_longer(turn_id);
                            self.adopt_open_turn_after_completion(turn_id);
                            return;
                        }
                        if self.dispatch_rerecognition_for_turn_if_idle(turn_id, purpose) {
                            // Paint the completion hypothesis before waiting on
                            // follow-up ASR so the caption is not blank for a
                            // full extra recognition round-trip.
                            self.emit_waiting_draft_if_blank_or_longer(turn_id);
                            self.adopt_open_turn_after_completion(turn_id);
                            return;
                        }
                        if self.should_release_rerecognition_for_same_turn_continuation(
                            turn_id, purpose,
                        ) || self.requests.deferred_rerecognition.is_some()
                        {
                            // Same-utterance tail ASR is queued. Keep the draft
                            // open so max-chunk / streaming chunks / root
                            // AfterInterimSilence after EndSilence extend it
                            // instead of finalizing or reminting a new turn.
                            self.emit_waiting_draft_if_blank_or_longer(turn_id);
                            self.adopt_open_turn_after_completion(turn_id);
                            return;
                        }
                    }
                    AsrResultCompletionAfterTranscript::CompleteWithoutGrammar => {}
                }
                if self.has_deferred_completion() {
                    self.emit_waiting_draft_if_blank_or_longer(turn_id);
                    self.adopt_open_turn_after_completion(turn_id);
                    return;
                }
                self.complete_turn_without_grammar(turn_id);
            }
            AsrResultAction::ApplyRerecognitionTranscript {
                transcript,
                elapsed_millis,
                purpose,
            } => {
                self.requests.pending_rerecognition_purpose.take();
                self.apply_rerecognition_transcript(
                    request,
                    transcript,
                    elapsed_millis,
                    purpose == AsrResultRerecognitionPurpose::GrammarAfterCompletion,
                );
                self.apply_rerecognition_follow_up(request.target.turn_id.0, purpose);
            }
        }
    }

    pub(in crate::recognition) fn adopt_open_turn_after_completion(&mut self, turn_id: u64) {
        let previous_open_turn_id = self.turn_store.open_turn_id;
        if self.turn_store.open_turn_id.is_none_or(|open_turn_id| open_turn_id <= turn_id) {
            self.turn_store.open_turn_id = Some(turn_id);
            if previous_open_turn_id != Some(turn_id) {
                self.turn_store.open_turn_accepts_root_segment = false;
            }
        }
    }

    fn emit_partial_window_output(
        &mut self,
        request: &AsrRequest,
        transcript: AsrTranscript,
        elapsed_millis: u128,
    ) {
        if transcript.text.trim().is_empty() {
            return;
        }
        let source = RecognitionSourceMeta {
            turn_session_id: self.counters.turn_session_id,
            turn_id: request.target.turn_id.0,
            turn_revision: request.target.turn_revision.0,
            output_sequence: {
                let sequence = self.counters.next_partial_window_sequence;
                self.counters.next_partial_window_sequence = sequence.saturating_add(1);
                sequence
            },
            segment_id: request.target.last_segment_id.map_or(
                request.target.turn_id.0,
                |segment_id| segment_id.0,
            ),
            previous_segment_id: request.target.first_segment_id.and_then(|first| {
                (Some(first) != request.target.last_segment_id).then_some(first.0)
            }),
        };
        let meta = RecognizedTextMeta::replace_turn_output(
            format!(
                "partial-window-{}-{}-{}",
                source.turn_session_id, source.turn_id, source.segment_id
            ),
            source,
            false,
        );
        let output = RecognizedTextOutput::from_route(
            request.source_audio.clone(),
            transcript.text,
            request.route,
            request.detected_language.clone(),
            meta,
            elapsed_millis,
        );
        self.io.output_sink.emit_partial_window(RecognitionStreamOutput {
            output,
            source_text: None,
            azookey_input_text: None,
        });
    }

    fn stale_input_for_request(&self, request: &AsrRequest) -> AsrRequestStaleInput {
        AsrRequestStaleInput {
            current_revision: *self
                .turn_store
                .revisions
                .get(&request.target.turn_id.0)
                .unwrap_or(&0),
            confirmed_until_sample: self.turn_store.confirmed_until_sample,
            target_turn_is_finalized: self
                .turn_store
                .finalized_turns
                .contains(&request.target.turn_id.0),
            turn_route: self
                .turn_store
                .turns
                .get(&request.target.turn_id.0)
                .and_then(|turn| turn.draft().route)
                .filter(|route| {
                    request.kind == AsrTaskKind::InterimDisplay || !route.model.is_interim_only()
                }),
            last_recognition_route: self.turn_store.last_recognition_route,
            default_route: RecognitionRoute::from_model(self.config.asr.model),
            split_route:
                crate::recognition::transcription::route::selection::configured_split_route(
                    &self.config,
                    request.kind,
                ),
        }
    }

    fn apply_rerecognition_follow_up(
        &mut self,
        turn_id: u64,
        purpose: AsrResultRerecognitionPurpose,
    ) {
        match purpose {
            AsrResultRerecognitionPurpose::GrammarAfterCompletion => {
                self.process_grammar_boundaries_after_rerecognition(turn_id);
            }
            AsrResultRerecognitionPurpose::SimpleTurnCheckFinal => {
                self.complete_turn_without_grammar(turn_id);
            }
            AsrResultRerecognitionPurpose::TimeoutFinal => {
                self.finalize_timeout_turn_after_rerecognition(turn_id);
            }
        }
    }

    fn turn_has_non_empty_draft(&self, turn_id: u64) -> bool {
        self.turn_store
            .turns
            .get(&turn_id)
            .is_some_and(|turn| !turn.draft().combined_text.trim().is_empty())
    }

    fn apply_unusable_completion_audio_keep_visible(&mut self, request: &AsrRequest) {
        if request.kind != AsrTaskKind::CompletionCheck {
            return;
        }
        if !self.turn_has_non_empty_draft(request.target.turn_id.0) {
            return;
        }
        self.apply_segment_transcript(request, AsrTranscript::from_text(""), 0);
    }

    fn completion_failure_action_for_request(&self) -> AsrResultCompletionFailureAction {
        match self.config.turn.detector {
            crate::config::TurnDetector::Namo => AsrResultCompletionFailureAction::DecideWithNamo,
            crate::config::TurnDetector::Morph => AsrResultCompletionFailureAction::KeepOpen,
            crate::config::TurnDetector::Simple => {
                AsrResultCompletionFailureAction::CompleteWithoutGrammar
            }
        }
    }
}

#[cfg(test)]
fn is_stale_asr_request_for_runtime(runtime: &RecognitionSession, request: &AsrRequest) -> bool {
    crate::recognition::transcription::reducer::is_stale_asr_request(
        request,
        runtime.stale_input_for_request(request),
    )
}

fn result_purpose_from_runtime(purpose: RerecognitionPurpose) -> AsrResultRerecognitionPurpose {
    match purpose {
        RerecognitionPurpose::GrammarAfterCompletion => {
            AsrResultRerecognitionPurpose::GrammarAfterCompletion
        }
        RerecognitionPurpose::SimpleTurnCheckFinal => {
            AsrResultRerecognitionPurpose::SimpleTurnCheckFinal
        }
        RerecognitionPurpose::TimeoutFinal => AsrResultRerecognitionPurpose::TimeoutFinal,
    }
}

fn runtime_purpose_from_result(purpose: AsrResultRerecognitionPurpose) -> RerecognitionPurpose {
    match purpose {
        AsrResultRerecognitionPurpose::GrammarAfterCompletion => {
            RerecognitionPurpose::GrammarAfterCompletion
        }
        AsrResultRerecognitionPurpose::SimpleTurnCheckFinal => {
            RerecognitionPurpose::SimpleTurnCheckFinal
        }
        AsrResultRerecognitionPurpose::TimeoutFinal => RerecognitionPurpose::TimeoutFinal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{AsrLanguage, AsrModel, ParapperConfig, TurnDetector},
        recognition::{
            transcription::asr::task::{
                AsrTarget, AudioRange, GlobalSampleIndex, SegmentId, TurnId, TurnRevision,
            },
            turn::Turn,
        },
    };

    #[test]
    fn dispatch_next_asr_request_if_idle_leaves_empty_queue_without_test_only_side_effects() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());

        runtime.dispatch_next_asr_request_if_idle();

        assert!(runtime.requests.in_flight_request.is_none());
        assert!(runtime.requests.last_dispatched.is_none());
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn record_segment_closed_asr_candidate_ignores_empty_audio_without_panic() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());

        runtime.record_segment_closed_asr_candidate(
            1,
            None,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            SegmentCloseReason::EndSilenceReached,
        );

        assert!(
            runtime.pending.asr_segments.is_empty(),
            "empty closed segments must not create a zero-length ASR range"
        );
    }

    #[test]
    fn take_following_interim_segments_stops_at_non_contiguous_segment() {
        let mut runtime = RecognitionSession::new(&parapper_config! {
            turn_detector: TurnDetector::Namo,
            ..ParapperConfig::default()
        });
        runtime.pending.asr_segments.push_back(pending_segment(
            1,
            None,
            SegmentCloseReason::InterimResultSilenceReached,
            0..10,
        ));
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(99),
            SegmentCloseReason::InterimResultSilenceReached,
            10..20,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("first interim request should be dispatched");
        assert_eq!(request.target.first_segment_id, Some(SegmentId(1)));
        assert_eq!(request.target.last_segment_id, Some(SegmentId(1)));
        assert_eq!(
            request.source_audio,
            vec![1.0; 10],
            "request-level ASR padding must not alter the pending segment source audio"
        );
        assert_eq!(runtime.pending.asr_segments.len(), 1);
        assert_eq!(
            runtime
                .pending
                .asr_segments
                .front()
                .expect("non-contiguous segment should remain queued")
                .segment_id,
            2
        );
    }

    #[test]
    fn drop_front_interim_segments_covered_by_completion_promotes_covering_completion() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.pending.asr_segments.push_back(pending_segment(
            1,
            None,
            SegmentCloseReason::InterimResultSilenceReached,
            0..10,
        ));
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::InterimResultSilenceReached,
            10..20,
        ));
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::EndSilenceReached,
            0..20,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("covering completion should be dispatched first");
        assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(request.target.first_segment_id, Some(SegmentId(1)));
        assert_eq!(request.target.last_segment_id, Some(SegmentId(2)));
        assert_eq!(request.audio, vec![2.0; 20]);
        assert!(
            runtime.pending.asr_segments.is_empty(),
            "covered interim segments must be removed instead of replayed after completion"
        );
    }

    #[test]
    fn end_silence_completion_does_not_fold_following_after_interim_silence() {
        for turn_detector in [TurnDetector::Namo, TurnDetector::Simple] {
            let mut runtime = RecognitionSession::new(&parapper_config! {
                turn_detector: turn_detector,
                ..ParapperConfig::default()
            });
            runtime.pending.asr_segments.push_back(pending_segment(
                1,
                None,
                SegmentCloseReason::EndSilenceReached,
                0..10,
            ));
            runtime.pending.asr_segments.push_back(pending_segment(
                2,
                Some(1),
                SegmentCloseReason::InterimResultSilenceReached,
                10..20,
            ));

            runtime.dispatch_next_asr_request_if_idle();

            let request = runtime
                .requests
                .in_flight_request
                .as_ref()
                .expect("completion request should be dispatched");
            assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
            assert_eq!(request.audio.len(), 10, "turn_detector={turn_detector:?}");
            assert_eq!(
                request.target.range,
                AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(10)),
                "turn_detector={turn_detector:?}"
            );
            assert_eq!(runtime.pending.asr_segments.len(), 1, "turn_detector={turn_detector:?}");
            assert_eq!(
                runtime.pending.asr_segments.front().map(|segment| segment.reason),
                Some(SegmentCloseReason::InterimResultSilenceReached),
                "turn_detector={turn_detector:?}"
            );
        }
    }

    #[test]
    fn stale_asr_request_detects_turn_revision_change() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.revisions.insert(1, 1);

        assert!(is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(
                AsrTaskKind::InterimDisplay,
                RecognitionRoute::from_model(ParapperConfig::default().asr.model),
                None,
                0..10,
            )
        ));
    }

    #[test]
    fn stale_asr_request_detects_audio_range_already_confirmed() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);

        assert!(is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(
                AsrTaskKind::InterimDisplay,
                RecognitionRoute::from_model(ParapperConfig::default().asr.model),
                None,
                0..10,
            )
        ));
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_drops_confirmed_pending_segment_before_asr_submit() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);
        runtime.pending.asr_segments.push_back(pending_segment(
            1,
            None,
            SegmentCloseReason::EndSilenceReached,
            0..10,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        assert!(
            runtime.requests.in_flight_request.is_none(),
            "a pending segment whose range is already confirmed must not consume an ASR cycle"
        );
        assert!(runtime.requests.last_dispatched.is_none());
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_starts_new_turn_when_previous_points_at_finalized_turn() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::InterimResultSilenceReached,
            10..30,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("new speech after a finalized turn must still be transcribed");
        assert_eq!(request.target.turn_id, TurnId(2));
        // The plan still names the previous closed segment as its first id;
        // reminting only changes the turn the new audio is attributed to.
        assert_eq!(request.target.first_segment_id, Some(SegmentId(1)));
        assert_eq!(request.target.last_segment_id, Some(SegmentId(2)));
        assert_eq!(request.target.range.start_sample, GlobalSampleIndex(10));
        assert_eq!(request.target.range.end_sample, GlobalSampleIndex(30));
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_still_drops_late_plan_for_same_finalized_segment() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.pending.asr_segments.push_back(pending_segment(
            1,
            None,
            SegmentCloseReason::InterimResultSilenceReached,
            10..20,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        assert!(
            runtime.requests.in_flight_request.is_none(),
            "a late plan whose segment id is the finalized turn must stay dropped"
        );
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_does_not_drop_when_remint_id_already_finalized() {
        // Invariant: when the attachment target is finalized and the natural
        // remint id is *also* finalized for a different reason than the
        // same-segment late plan, new audio beyond confirmed_until must not
        // vanish in the else branch.
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.turn_store.finalized_turns.insert(2);
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);
        runtime.counters.next_turn_id = 3;
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::InterimResultSilenceReached,
            10..30,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("new audio must not be dropped when remint id is already finalized");
        assert_ne!(
            request.target.turn_id,
            TurnId(1),
            "must not reopen the finalized attachment target"
        );
        assert_ne!(
            request.target.turn_id,
            TurnId(2),
            "must not reuse the already-finalized remint id"
        );
        assert_eq!(
            request.target.turn_id,
            TurnId(3),
            "fresh turn must come from the next_turn_id watermark"
        );
        assert_eq!(request.target.range.start_sample, GlobalSampleIndex(10));
        assert_eq!(request.target.range.end_sample, GlobalSampleIndex(30));
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_third_plan_after_two_remints_gets_fresh_turn() {
        // Invariant: two remint cycles in a row (turn 1 then turn 2 finalized)
        // must still attribute the third child plan to a live turn, not drop it.
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.turn_store.finalized_turns.insert(2);
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(30);
        runtime.counters.next_turn_id = 3;
        runtime.pending.asr_segments.push_back(pending_segment(
            3,
            Some(2),
            SegmentCloseReason::InterimResultSilenceReached,
            30..50,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("third utterance after reminted finals must still be transcribed");
        assert_eq!(request.target.turn_id, TurnId(3));
        assert_eq!(request.target.last_segment_id, Some(SegmentId(3)));
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_does_not_remint_onto_already_live_turn() {
        // Invariant: when attachment target is finalized and the natural remint
        // id is already a live (non-finalized) turn — e.g. open was cleared by
        // finalizing an older turn while the reminted draft remains — new audio
        // must not cross-wire onto that live turn.
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);
        runtime.counters.next_turn_id = 3;
        runtime.turn_store.open_turn_id = None;
        let mut live = Turn::new("turn-1-2-0".to_string(), 0);
        live.draft_mut().append_recognized_segment(
            2,
            None,
            &[1.0],
            &[vad(true)],
            RecognitionRoute::from_language(AsrLanguage::Japanese),
            "already-live".to_string(),
            0,
        );
        runtime.turn_store.turns.insert(2, live);
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::InterimResultSilenceReached,
            10..30,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("new audio after finalized attachment must still be transcribed");
        assert_ne!(
            request.target.turn_id,
            TurnId(1),
            "must not reopen the finalized attachment target"
        );
        assert_ne!(
            request.target.turn_id,
            TurnId(2),
            "must not remint onto an already-live turn id"
        );
        assert_eq!(
            request.target.turn_id,
            TurnId(3),
            "fresh turn must come from the next_turn_id watermark"
        );
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn dispatch_next_asr_request_if_idle_does_not_remint_onto_open_turn_id() {
        // Invariant: remint must not reuse open_turn_id even when that id is
        // not yet present in the turns map (issued / in-flight namespace).
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        runtime.turn_store.finalized_turns.insert(1);
        runtime.turn_store.confirmed_until_sample = GlobalSampleIndex(10);
        runtime.counters.next_turn_id = 3;
        runtime.turn_store.open_turn_id = Some(2);
        runtime.turn_store.open_turn_accepts_root_segment = false;
        runtime.pending.asr_segments.push_back(pending_segment(
            2,
            Some(1),
            SegmentCloseReason::InterimResultSilenceReached,
            10..30,
        ));

        runtime.dispatch_next_asr_request_if_idle();

        let request = runtime
            .requests
            .in_flight_request
            .as_ref()
            .expect("child plan with open turn must still dispatch");
        // With open_turn_id set, target_turn_id prefers the open turn and never
        // enters the remint branch — attaching to open turn 2 is correct.
        assert_eq!(request.target.turn_id, TurnId(2));
        assert!(runtime.pending.asr_segments.is_empty());
    }

    #[test]
    fn stale_asr_request_detects_existing_turn_route_mismatch() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        let mut turn = Turn::new("turn-1-1-0".to_string(), 0);
        turn.draft_mut().append_recognized_segment(
            1,
            None,
            &[1.0],
            &[vad(true)],
            RecognitionRoute::from_language(AsrLanguage::English),
            "hello".to_string(),
            0,
        );
        runtime.turn_store.turns.insert(1, turn);

        assert!(is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(
                AsrTaskKind::InterimDisplay,
                RecognitionRoute::from_language(AsrLanguage::Japanese),
                None,
                0..10,
            )
        ));
    }

    #[test]
    fn stale_asr_request_accepts_sli_selected_route_even_without_cached_last_route() {
        let runtime = RecognitionSession::new(&ParapperConfig::default());

        assert!(!is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(
                AsrTaskKind::CompletionCheck,
                RecognitionRoute::from_model(AsrModel::NemoParakeetTdt0_6BV2Int8),
                Some("en".to_string()),
                0..10,
            )
        ));
    }

    #[test]
    fn stale_asr_request_rejects_non_default_route_without_sli_or_cached_last_route() {
        let runtime = RecognitionSession::new(&ParapperConfig::default());

        assert!(is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(
                AsrTaskKind::CompletionCheck,
                RecognitionRoute::from_model(AsrModel::NemoParakeetTdt0_6BV2Int8),
                None,
                0..10,
            )
        ));
    }

    #[test]
    fn stale_asr_request_accepts_cached_last_recognition_route() {
        let mut runtime = RecognitionSession::new(&ParapperConfig::default());
        let route = RecognitionRoute::from_model(AsrModel::NemoParakeetTdt0_6BV2Int8);
        runtime.turn_store.last_recognition_route = Some(route);

        assert!(!is_stale_asr_request_for_runtime(
            &runtime,
            &asr_request(AsrTaskKind::CompletionCheck, route, None, 0..10,)
        ));
    }

    fn pending_segment(
        segment_id: u64,
        previous_segment_id: Option<u64>,
        reason: SegmentCloseReason,
        range: std::ops::Range<u64>,
    ) -> PendingAsrSegment {
        let sample_value =
            f32::from(u16::try_from(segment_id).expect("test segment id should fit u16"));
        let audio = vec![
            sample_value;
            usize::try_from(range.end - range.start)
                .expect("test range should fit usize")
        ];
        let vad_results = vec![vad(true)];
        PendingAsrSegment {
            segment_id,
            previous_segment_id,
            source_audio: audio.clone(),
            source_vad_results: vad_results.clone(),
            audio,
            vad_results,
            reason,
            range: AudioRange::new(GlobalSampleIndex(range.start), GlobalSampleIndex(range.end)),
            created_at_frame: VadFrameIndex(segment_id),
        }
    }

    fn asr_request(
        kind: AsrTaskKind,
        route: RecognitionRoute,
        detected_language: Option<String>,
        range: std::ops::Range<u64>,
    ) -> AsrRequest {
        AsrRequest {
            request_id: AsrRequestId(1),
            kind,
            target: AsrTarget::new(
                TurnId(1),
                TurnRevision(0),
                AudioRange::new(GlobalSampleIndex(range.start), GlobalSampleIndex(range.end)),
                Some(SegmentId(1)),
                Some(SegmentId(1)),
            ),
            route,
            detected_language,
            audio: vec![1.0; usize::try_from(range.end - range.start).unwrap()],
            vad_results: vec![vad(true)],
            source_audio: vec![1.0; usize::try_from(range.end - range.start).unwrap()],
            source_vad_results: vec![vad(true)],
            close_reason: Some(SegmentCloseReason::EndSilenceReached),
            created_at_frame: VadFrameIndex(1),
        }
    }

    fn vad(is_speech: bool) -> VadResult {
        VadResult { probability: if is_speech { 0.9 } else { 0.1 }, is_speech }
    }
}
