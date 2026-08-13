use crate::recognition::{
    control::{PendingFinalization, RecognitionSession, RerecognitionPurpose},
    segmentation::segment::builder::SegmentCloseReason,
    transcription::{
        asr::{
            input::{AsrRequestEdgePadding, ensure_asr_request_edge_silence},
            task::{
                AsrInFlight, AsrRequest, AsrRequestId, AsrTarget, AsrTaskKind, AudioRange,
                GlobalSampleIndex, SegmentId, TurnId, TurnRevision, VadFrameIndex,
            },
        },
        planner::PendingAsrSegment,
        route::{RecognitionRoute, selection::configured_split_route},
    },
    turn::{
        policy::{completion, namo, silence, timeout},
        take_next_output_sequence,
    },
};

impl RecognitionSession {
    pub(in crate::recognition) fn complete_turn_without_grammar(&mut self, turn_id: u64) {
        self.stop_accepting_root_while_closing(turn_id);
        if self.defer_finalization_if_blocked(PendingFinalization::new(turn_id)) {
            return;
        }
        self.finalize_turn_now(turn_id);
    }

    fn finalize_turn_now(&mut self, turn_id: u64) {
        self.emit_stale_turn_finals(turn_id);
        self.emit_turn_output(turn_id, true);
        self.clear_open_turn();
    }

    pub(in crate::recognition) fn rerecognition_purpose_after_completion(
        &self,
    ) -> Option<RerecognitionPurpose> {
        completion::rerecognition_purpose(&self.config)
    }

    pub(in crate::recognition) fn dispatch_rerecognition_for_turn_if_idle(
        &mut self,
        turn_id: u64,
        purpose: RerecognitionPurpose,
    ) -> bool {
        if self.requests.in_flight_request.is_some() {
            return false;
        }
        if self.has_deferred_completion() {
            // Prefix CompletionCheck still has to apply before grammar ASR hears
            // the full utterance (prefix + same-turn tail).
            return false;
        }
        if self.should_yield_rerecognition_to_pending_next(turn_id, purpose) {
            // A newer utterance is already queued. Occupying the single ASR
            // slot with follow-up rerecognition would delay its first hypothesis.
            return false;
        }
        if self.should_release_rerecognition_for_same_turn_continuation(turn_id, purpose) {
            // Max-chunk / streaming-chunk audio is still this utterance.
            // Occupying the slot would delay the tail caption; do not start.
            return false;
        }
        let Some((
            draft_route,
            mut detected_language,
            mut audio,
            mut vad_results,
            first_segment_id,
            latest_segment_id,
        )) = self.turn_store.turns.get(&turn_id).and_then(|turn| {
            let draft = turn.draft();
            Some((
                draft.route?,
                draft.detected_language.clone(),
                draft.full_audio.clone(),
                draft.vad_results.clone(),
                draft.segment_ids.first().copied(),
                draft.latest_segment_id,
            ))
        })
        else {
            return false;
        };
        let route = configured_split_route(&self.config, AsrTaskKind::Rerecognition)
            .unwrap_or_else(|| {
                if draft_route.model.is_interim_only() {
                    RecognitionRoute::from_model(self.config.asr.model)
                } else {
                    draft_route
                }
            });
        if route != draft_route {
            detected_language = None;
        }
        if audio.is_empty() {
            return false;
        }
        let source_audio_len = audio.len();
        ensure_asr_request_edge_silence(
            &self.config,
            &mut audio,
            &mut vad_results,
            AsrRequestEdgePadding::TrailingOnly,
        );
        let range = self.turn_store.audio_ranges.get(&turn_id).copied().unwrap_or_else(|| {
            AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(source_audio_len as u64))
        });
        let target = AsrTarget::new(
            TurnId(turn_id),
            TurnRevision(*self.turn_store.revisions.get(&turn_id).unwrap_or(&0)),
            range,
            first_segment_id.map(SegmentId),
            latest_segment_id.map(SegmentId),
        );
        let request = AsrRequest {
            request_id: AsrRequestId(self.take_next_request_id()),
            kind: AsrTaskKind::Rerecognition,
            target,
            route,
            detected_language,
            audio,
            vad_results,
            source_audio: Vec::new(),
            source_vad_results: Vec::new(),
            close_reason: None,
            created_at_frame: VadFrameIndex(self.counters.next_vad_frame_index),
        };
        let in_flight = AsrInFlight::from(&request);
        if !self.io.asr_runner.submit(request.clone()) {
            log::warn!(
                "Dropping rerecognition ASR request after submit failure: request_id={:?} turn_id={turn_id}",
                request.request_id,
            );
            return false;
        }
        self.requests.in_flight_request = Some(request);
        self.requests.pending_rerecognition_purpose = Some(purpose);
        self.requests.last_dispatched = Some(in_flight);
        self.requests.deferred_rerecognition = None;
        self.stamp_asr_dispatch(turn_id);
        true
    }

    pub(in crate::recognition) fn yield_rerecognition_slot_for_next_utterance(&mut self) {
        let Some(request) = self.requests.in_flight_request.as_ref() else {
            return;
        };
        if request.kind != AsrTaskKind::Rerecognition {
            return;
        }
        let turn_id = request.target.turn_id.0;
        let Some(purpose) = self.requests.pending_rerecognition_purpose else {
            return;
        };
        if !self.should_yield_rerecognition_to_pending_next(turn_id, purpose) {
            return;
        }
        // Drop the slot so finalization is not blocked by this follow-up ASR.
        // The late result is ignored (no in-flight / mismatch). Visible text
        // and uncovered tail already live on the draft.
        self.requests.in_flight_request = None;
        self.requests.pending_rerecognition_purpose = None;
        self.complete_turn_without_grammar(turn_id);
    }

    pub(in crate::recognition) fn yield_rerecognition_slot_for_same_turn_continuation(&mut self) {
        let Some(request) = self.requests.in_flight_request.as_ref() else {
            return;
        };
        if request.kind != AsrTaskKind::Rerecognition {
            return;
        }
        let turn_id = request.target.turn_id.0;
        let Some(purpose) = self.requests.pending_rerecognition_purpose else {
            return;
        };
        if !self.should_release_rerecognition_for_same_turn_continuation(turn_id, purpose) {
            return;
        }
        // Drop the slot so same-utterance tail ASR can run. Do not finalize or
        // remint: max-chunk / streaming chunks still extend this turn. Visible
        // text and uncovered tail already live on the draft. Late rerecognition
        // is ignored (mismatch).
        self.requests.in_flight_request = None;
        self.requests.pending_rerecognition_purpose = None;
    }

    pub(in crate::recognition) fn yield_completion_slot_for_same_turn_continuation(&mut self) {
        let Some(request) = self.requests.in_flight_request.as_ref() else {
            return;
        };
        if request.kind != AsrTaskKind::CompletionCheck {
            return;
        }
        let turn_id = request.target.turn_id.0;
        let should_yield = match request.close_reason {
            // Max-chunk is already a same-turn tail. Yield it only to a later
            // 160ms chunk, and keep any deferred prefix CompletionCheck.
            Some(SegmentCloseReason::SegmentMaxChunksReached) => {
                self.pending_streaming_chunk_continuation(turn_id)
            }
            _ => self.pending_same_utterance_continuation(turn_id),
        };
        if !should_yield {
            return;
        }
        // Drop the slot so 160ms / max-chunk tail ASR can run. Do not finalize
        // or remint. Late original CompletionCheck is ignored (new request id
        // on resume). Visible text already on the draft stays; prefix audio
        // that has not applied yet is prepended when the request resumes.
        let request = self.requests.in_flight_request.take().expect(
            "in-flight CompletionCheck was present when yielding to same-turn continuation",
        );
        self.park_yielded_max_chunk_audio_on_draft(&request);
        self.requests.deferred_completion.push_back(request);
    }

    pub(in crate::recognition) fn dispatch_deferred_completion_if_idle(&mut self) {
        let Some(request) = self.requests.deferred_completion.back() else {
            return;
        };
        let turn_id = request.target.turn_id.0;
        if self.requests.in_flight_request.is_some()
            || self.pending_same_utterance_continuation(turn_id)
        {
            return;
        }
        if self.turn_store.finalized_turns.contains(&turn_id) {
            self.requests.deferred_completion.clear();
            return;
        }
        let Some(mut request) = self.requests.deferred_completion.pop_back() else {
            return;
        };
        request.request_id = AsrRequestId(self.take_next_request_id());
        let in_flight = AsrInFlight::from(&request);
        if !self.io.asr_runner.submit(request.clone()) {
            log::warn!(
                "Dropping deferred completion ASR request after submit failure: request_id={:?} turn_id={turn_id}",
                request.request_id,
            );
            self.requests.deferred_completion.push_back(request);
            return;
        }
        self.requests.in_flight_request = Some(request);
        self.requests.last_dispatched = Some(in_flight);
        self.stamp_asr_dispatch(turn_id);
    }

    pub(in crate::recognition) fn has_deferred_completion(&self) -> bool {
        !self.requests.deferred_completion.is_empty()
    }

    fn should_yield_rerecognition_to_pending_next(
        &mut self,
        turn_id: u64,
        purpose: RerecognitionPurpose,
    ) -> bool {
        match purpose {
            RerecognitionPurpose::SimpleTurnCheckFinal | RerecognitionPurpose::TimeoutFinal => {
                self.stop_accepting_root_while_closing(turn_id);
            }
            RerecognitionPurpose::GrammarAfterCompletion => {
                // Namo/Morph may still Continue. Only treat the pending segment
                // as a true next utterance when the current draft already has a
                // confirmed completing grammar boundary (split-after-genuine-
                // end-silence). Mid-phrase Continue must keep the slot.
                if !self.grammar_already_completes_turn(turn_id) {
                    return false;
                }
                self.stop_accepting_root_while_closing(turn_id);
            }
        }
        self.pending_asr_preempts_rerecognition(turn_id)
    }

    pub(in crate::recognition) fn should_release_rerecognition_for_same_turn_continuation(
        &mut self,
        turn_id: u64,
        purpose: RerecognitionPurpose,
    ) -> bool {
        match purpose {
            RerecognitionPurpose::SimpleTurnCheckFinal | RerecognitionPurpose::TimeoutFinal => {
                self.stop_accepting_root_while_closing(turn_id);
            }
            RerecognitionPurpose::GrammarAfterCompletion => {
                if self.grammar_already_completes_turn(turn_id) {
                    self.stop_accepting_root_while_closing(turn_id);
                }
            }
        }
        if self.pending_asr_preempts_rerecognition(turn_id) {
            // A true next utterance remints via yield_rerecognition_slot_for_next_utterance.
            return false;
        }
        if !self.pending_same_utterance_continuation(turn_id) {
            return false;
        }
        self.requests.deferred_rerecognition = Some((turn_id, purpose));
        true
    }

    pub(in crate::recognition) fn dispatch_deferred_rerecognition_if_idle(&mut self) {
        let Some((turn_id, purpose)) = self.requests.deferred_rerecognition else {
            return;
        };
        if self.turn_store.finalized_turns.contains(&turn_id)
            || !self.turn_store.turns.contains_key(&turn_id)
        {
            self.requests.deferred_rerecognition = None;
            return;
        }
        let _ = self.dispatch_rerecognition_for_turn_if_idle(turn_id, purpose);
    }

    fn pending_same_utterance_continuation(&self, turn_id: u64) -> bool {
        self.pending.asr_segments.iter().any(|segment| {
            matches!(
                segment.reason,
                SegmentCloseReason::SegmentMaxChunksReached
                    | SegmentCloseReason::InterimChunkReached
            ) && self.pending_segment_blocks_finalization(segment, turn_id)
        })
    }

    fn pending_streaming_chunk_continuation(&self, turn_id: u64) -> bool {
        self.pending.asr_segments.iter().any(|segment| {
            segment.reason == SegmentCloseReason::InterimChunkReached
                && self.pending_segment_blocks_finalization(segment, turn_id)
        })
    }

    fn pending_asr_preempts_rerecognition(&self, rerecognition_turn_id: u64) -> bool {
        self.pending.asr_segments.iter().any(|segment| {
            !self.pending_segment_blocks_finalization(segment, rerecognition_turn_id)
        })
    }

    pub(in crate::recognition) fn complete_or_continue_turn_with_namo(&mut self, turn_id: u64) {
        match namo::action(self.namo_final_decision(turn_id)) {
            namo::Action::Complete => {
                self.complete_turn_without_grammar(turn_id);
            }
            namo::Action::Continue { emit_interim } => {
                self.keep_turn_open(turn_id, emit_interim);
            }
        }
    }

    fn namo_final_decision(&mut self, turn_id: u64) -> bool {
        let Some(text) =
            self.turn_store.turns.get(&turn_id).map(|turn| turn.draft().combined_text.clone())
        else {
            return false;
        };
        self.namo_final_decision_for_text(turn_id, &text)
    }

    pub(in crate::recognition) fn namo_final_decision_for_text(
        &mut self,
        turn_id: u64,
        text: &str,
    ) -> bool {
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        let Some(route) = self.turn_store.turns.get(&turn_id).and_then(|turn| turn.draft().route)
        else {
            return false;
        };
        self.io
            .turn_decision_runner
            .decide(route, text, self.config.turn.namo_context_max_tokens)
            .is_ok_and(|decision| {
                decision.is_end_of_turn
                    && decision.confidence >= self.config.turn.namo_confidence_threshold
            })
    }

    pub(in crate::recognition) fn keep_turn_open(&mut self, turn_id: u64, emit_interim: bool) {
        self.turn_store.open_turn_id = Some(turn_id);
        self.turn_store.open_turn_accepts_root_segment = true;
        self.turn_store.open_turn_is_closing = false;
        self.reset_open_turn_timeout_origin();
        if emit_interim && self.config.turn.interim_result_enabled {
            self.emit_turn_output(turn_id, false);
        } else {
            // Interim display off still must paint a longer rerecognition
            // rewrite. Namo/Morph Continue used to skip emit and leave the
            // overlay on the older completion hypothesis until final.
            self.emit_waiting_draft_if_blank_or_longer(turn_id);
        }
    }

    pub(in crate::recognition) fn finalize_timeout_turn_after_rerecognition(
        &mut self,
        turn_id: u64,
    ) {
        self.stop_accepting_root_while_closing(turn_id);
        if self.defer_finalization_if_blocked(PendingFinalization::new(turn_id)) {
            return;
        }
        self.finalize_turn_now(turn_id);
    }

    /// A queued next-utterance root is a new turn once we have decided to close.
    /// Namo/Morph otherwise treat that root as a continuation and defer forever.
    fn stop_accepting_root_while_closing(&mut self, turn_id: u64) {
        if self.turn_store.open_turn_id.is_none() && self.turn_store.turns.contains_key(&turn_id) {
            // Completion can create a draft without an interim, so `open_turn`
            // was never assigned. Attach it now: AfterInterimSilence children
            // of a closing turn remint instead of blocking as same-turn.
            self.turn_store.open_turn_id = Some(turn_id);
        }
        if self.turn_store.open_turn_id == Some(turn_id) {
            self.turn_store.open_turn_accepts_root_segment = false;
            self.turn_store.open_turn_is_closing = true;
        }
    }

    pub(in crate::recognition) fn clear_open_turn(&mut self) {
        self.turn_store.open_turn_id = None;
        self.turn_store.open_turn_accepts_root_segment = false;
        self.turn_store.open_turn_is_closing = false;
        self.activity.open_turn_since_tick = None;
        self.requests.deferred_rerecognition = None;
        self.requests.deferred_completion.clear();
    }

    fn reset_open_turn_timeout_origin(&mut self) {
        self.activity.open_turn_activity_epoch = self.activity.segment_activity_epoch;
        self.activity.open_turn_since_tick = Some(self.counters.next_runtime_tick);
    }

    pub(in crate::recognition) fn handle_turn_check_silence_reached(
        &mut self,
        previous_segment_id: u64,
    ) -> bool {
        let open_turn_id = self.turn_store.open_turn_id;
        let turn = open_turn_id.and_then(|turn_id| self.turn_store.turns.get(&turn_id));
        let open_turn = match (open_turn_id, turn) {
            (None, _) => silence::OpenTurn::None,
            (Some(_), None) => silence::OpenTurn::Missing,
            (Some(turn_id), Some(turn)) => silence::OpenTurn::Present {
                turn_id,
                latest_segment_id: turn.draft().latest_segment_id,
            },
        };
        let action = silence::action(silence::Input {
            open_turn,
            previous_segment_id,
            asr_state: silence::asr_state(self.requests.in_flight_request.is_some()),
            pending_interim: silence::pending_interim(
                self.can_promote_pending_interim_to_completion(previous_segment_id),
            ),
            completion_strategy: silence::completion_strategy(
                self.config.turn.detector,
                self.config.turn.rerecognize_full_on_complete,
            ),
        });
        match action {
            silence::Action::WaitForBusyAsr => false,
            silence::Action::Ignore => true,
            silence::Action::PromotePendingInterim => {
                self.promote_pending_interim_to_completion_for_turn_check(previous_segment_id)
            }
            silence::Action::RefreshRouteThenDispatchRerecognition {
                turn_id,
                purpose,
                fallback_complete_without_grammar: _,
            } => {
                self.refresh_turn_route_with_sli(turn_id);
                if self.dispatch_rerecognition_for_turn_if_idle(turn_id, purpose) {
                    // Existing draft must stay visible while grammar/full-turn
                    // rerecognition occupies the slot.
                    self.emit_waiting_draft_if_blank_or_longer(turn_id);
                    true
                } else if self
                    .should_release_rerecognition_for_same_turn_continuation(turn_id, purpose)
                {
                    // Same-utterance tail ASR will take the slot. Deferred
                    // SimpleTurnCheckFinal / grammar rerecognition restarts after.
                    true
                } else {
                    // Submit/route/audio failure must not hold the turn-check
                    // forever; finalize the draft and let the next utterance
                    // dispatch in this step.
                    self.complete_turn_without_grammar(turn_id);
                    true
                }
            }
            silence::Action::CompleteWithoutGrammar { turn_id } => {
                self.complete_turn_without_grammar(turn_id);
                true
            }
        }
    }

    fn can_promote_pending_interim_to_completion(&self, previous_segment_id: u64) -> bool {
        self.promotable_pending_interim_index(previous_segment_id).is_some()
    }

    fn promote_pending_interim_to_completion_for_turn_check(
        &mut self,
        previous_segment_id: u64,
    ) -> bool {
        let Some(index) = self.promotable_pending_interim_index(previous_segment_id) else {
            return false;
        };
        // Streaming Nemotron chunks ahead of the silence interim must decode
        // first so the utterance tail is not dropped on promotion.
        if self
            .pending
            .asr_segments
            .iter()
            .take(index)
            .any(|segment| segment.reason == SegmentCloseReason::InterimChunkReached)
        {
            self.dispatch_next_asr_request_if_idle();
            return false;
        }

        let mut promoted: Option<PendingAsrSegment> = None;
        for _ in 0..=index {
            let Some(segment) = self.pending.asr_segments.pop_front() else {
                return false;
            };
            promoted = Some(match promoted {
                None => segment,
                // Covered prefix (e.g. cumulative streaming geometry already inside
                // the silence interim): keep the covering segment only.
                Some(previous) if segment.range.contains(previous.range) => segment,
                // Contiguous mid-utterance breath chain: fold audio into one
                // CompletionCheck that spans every interim silence segment.
                Some(previous) => previous.merge_contiguous_interim(segment),
            });
        }
        let Some(mut segment) = promoted else {
            return false;
        };
        segment.reason = SegmentCloseReason::EndSilenceReached;
        self.pending.asr_segments.push_front(segment);
        self.dispatch_next_asr_request_if_idle();
        self.requests.in_flight_request.is_some()
    }

    fn promotable_pending_interim_index(&self, previous_segment_id: u64) -> Option<usize> {
        let candidate_index = self.pending.asr_segments.iter().position(|segment| {
            segment.reason == SegmentCloseReason::InterimResultSilenceReached
                && segment.last_segment_id().0 == previous_segment_id
        })?;
        let candidate = self.pending.asr_segments.get(candidate_index)?;
        let preceding = self.pending.asr_segments.iter().take(candidate_index).collect::<Vec<_>>();
        if preceding.is_empty() {
            return Some(candidate_index);
        }
        if !preceding.iter().all(|segment| segment.kind() == AsrTaskKind::InterimDisplay) {
            return None;
        }
        // Existing path: cumulative Nemotron chunks / covered silence already
        // inside the candidate range can be dropped on promotion.
        if preceding.iter().all(|segment| {
            segment.turn_id() == candidate.turn_id() && candidate.range.contains(segment.range)
        }) {
            return Some(candidate_index);
        }
        // Breath-chained interim silences may abut or overlap (ASR-only leading
        // padding copies prior end-silence into the next segment range). Require a
        // contiguous previous→next segment chain ending at the candidate so
        // turn-check can still promote the whole utterance to CompletionCheck.
        if preceding
            .iter()
            .any(|segment| segment.reason != SegmentCloseReason::InterimResultSilenceReached)
        {
            return None;
        }
        let chain_ok = preceding.windows(2).all(|pair| pair[0].is_contiguous_with(pair[1]))
            && preceding.last().is_some_and(|last| last.is_contiguous_with(candidate));
        chain_ok.then_some(candidate_index)
    }

    /// Paint a still-open draft when the caption is blank, or when completion
    /// produced a longer rewrite of the visible interim.
    ///
    /// Re-recognition can occupy the ASR slot for a full extra round-trip.
    /// Emit even when live interim display is off: Namo/Morph wait on
    /// rerecognition before any final, and that wait used to leave the overlay
    /// empty. Do not clobber a longer interim with a truncated completion, and
    /// do not flash a duplicate-append of the text already on screen.
    pub(in crate::recognition) fn emit_waiting_draft_if_blank_or_longer(&mut self, turn_id: u64) {
        let Some(turn) = self.turn_store.turns.get(&turn_id) else {
            return;
        };
        let draft = turn.draft();
        if let Some(visible) = draft.last_emitted_interim_text.as_deref()
            && !super::transcript::is_longer_turn_rewrite(visible, &draft.combined_text)
        {
            return;
        }
        self.emit_turn_output(turn_id, false);
    }

    pub(in crate::recognition) fn emit_stale_turn_finals(&mut self, before_turn_id: u64) {
        let mut stale_turn_ids = self
            .turn_store
            .turns
            .keys()
            .copied()
            .filter(|turn_id| *turn_id < before_turn_id)
            .collect::<Vec<_>>();
        stale_turn_ids.extend(self.turn_store.audio_ranges.keys().copied().filter(|turn_id| {
            *turn_id < before_turn_id && !self.turn_store.turns.contains_key(turn_id)
        }));
        stale_turn_ids.sort_unstable();
        stale_turn_ids.dedup();

        for turn_id in stale_turn_ids {
            if self.turn_store.turns.contains_key(&turn_id) {
                self.emit_turn_output(turn_id, true);
            } else {
                self.finalize_turn_audio_range(turn_id);
            }
        }
    }

    pub(in crate::recognition) fn emit_turn_output(&mut self, turn_id: u64, is_final: bool) {
        let Some(turn) = self.turn_store.turns.get(&turn_id) else {
            if is_final {
                self.finalize_turn_audio_range(turn_id);
            }
            return;
        };
        let draft = turn.draft();
        if draft.combined_text.is_empty() {
            if is_final {
                self.cleanup_final_turn_state(turn_id);
            }
            return;
        }
        let route =
            draft.route.unwrap_or_else(|| RecognitionRoute::from_model(self.config.asr.model));
        if is_final {
            let output_sequence =
                take_next_output_sequence(&mut self.counters.next_output_sequence);
            self.finalize_turn_audio_range(turn_id);
            self.turn_store.finalized_turns.insert(turn_id);
            self.turn_store.streaming_interim_ranges.remove(&turn_id);
            let Some(turn) = self.turn_store.turns.remove(&turn_id) else {
                return;
            };
            let Some(confirmed) = turn.into_draft().confirm(
                self.counters.turn_session_id,
                turn_id,
                output_sequence,
                route,
            ) else {
                return;
            };
            *self.turn_store.revisions.entry(turn_id).or_insert(0) += 1;
            let mut output = confirmed.into_output();
            self.attach_caption_latency(turn_id, true, &mut output);
            self.io.output_sink.emit(output);
            return;
        }

        // Only emit an interim when the turn text changed since the last emitted interim;
        // skip without consuming an output sequence when it is unchanged.
        if draft.last_emitted_interim_text.as_deref() == Some(draft.combined_text.as_str()) {
            return;
        }
        let combined_text = draft.combined_text.clone();
        let output_sequence = take_next_output_sequence(&mut self.counters.next_output_sequence);
        let Some(mut output) =
            draft.interim_output(self.counters.turn_session_id, turn_id, output_sequence, route)
        else {
            return;
        };
        if let Some(turn) = self.turn_store.turns.get_mut(&turn_id) {
            turn.draft_mut().last_emitted_interim_text = Some(combined_text);
        }
        self.attach_caption_latency(turn_id, false, &mut output);
        self.io.output_sink.emit(output);
    }

    fn cleanup_final_turn_state(&mut self, turn_id: u64) {
        self.turn_store.finalized_turns.insert(turn_id);
        self.turn_store.streaming_interim_ranges.remove(&turn_id);
        self.finalize_turn_audio_range(turn_id);
        self.turn_store.turns.remove(&turn_id);
    }

    fn finalize_turn_audio_range(&mut self, turn_id: u64) {
        if let Some(range) = self.turn_store.audio_ranges.remove(&turn_id) {
            self.turn_store.confirmed_until_sample =
                self.turn_store.confirmed_until_sample.max(range.end_sample);
        }
    }

    pub(in crate::recognition) fn handle_open_turn_timeout(&mut self) -> bool {
        let action = timeout::action(timeout::Input {
            open_turn_id: self.turn_store.open_turn_id,
            open_turn_activity_epoch: self.activity.open_turn_activity_epoch,
            segment_activity_epoch: self.activity.segment_activity_epoch,
            open_turn_since_tick: self.activity.open_turn_since_tick,
            next_runtime_tick: self.counters.next_runtime_tick,
            timeout_ticks: self.timeout_ticks_for_open_turn(),
        });
        let turn_id = match action {
            timeout::Action::NoOpenTurn | timeout::Action::Waiting => return false,
            timeout::Action::ResetTimeoutOrigin => {
                self.reset_open_turn_timeout_origin();
                return false;
            }
            timeout::Action::Timeout { turn_id } => turn_id,
        };
        if self.config.uses_deferred_turn_completion() {
            self.refresh_turn_route_with_sli(turn_id);
            if self.dispatch_rerecognition_for_turn_if_idle(
                turn_id,
                RerecognitionPurpose::TimeoutFinal,
            ) {
                self.emit_waiting_draft_if_blank_or_longer(turn_id);
                return true;
            }
            if self.should_release_rerecognition_for_same_turn_continuation(
                turn_id,
                RerecognitionPurpose::TimeoutFinal,
            ) {
                // Same-utterance tail ASR will take the slot. Deferred
                // TimeoutFinal rerecognition restarts after it drains.
                return true;
            }
        }
        self.finalize_timeout_turn_after_rerecognition(turn_id);
        true
    }

    pub(in crate::recognition) fn timeout_ticks(&self) -> u64 {
        timeout::ticks(&self.config)
    }

    /// Greetings often pause briefly before a same-breath continuation
    /// (`こんにちは` … `きこえますか`). Give those drafts a longer silence
    /// timeout so the continuation can still attach to the same turn.
    fn timeout_ticks_for_open_turn(&self) -> u64 {
        let base = self.timeout_ticks();
        let Some(turn_id) = self.turn_store.open_turn_id else {
            return base;
        };
        let Some(turn) = self.turn_store.turns.get(&turn_id) else {
            return base;
        };
        let text = turn.draft().combined_text.trim();
        if is_fixed_greeting_only(text) { base.saturating_mul(3) } else { base }
    }
}

fn is_fixed_greeting_only(text: &str) -> bool {
    matches!(
        text.trim_end_matches(['ー', '〜', '～']),
        "こんにちは" | "こんばんは" | "おはようございます" | "おはよう" | "さようなら"
    )
}

impl RecognitionSession {
    pub(in crate::recognition) fn process_pending_finalization_if_ready(&mut self) -> bool {
        let Some(action) = self.pending.finalization else {
            return false;
        };
        if self.finalization_is_blocked(action.turn_id()) {
            return false;
        }
        self.pending.finalization = None;
        self.finalize_turn_now(action.turn_id());
        true
    }

    fn defer_finalization_if_blocked(&mut self, action: PendingFinalization) -> bool {
        if !self.finalization_is_blocked(action.turn_id()) {
            return false;
        }
        // Finalization is intentionally deferred globally, not just during shutdown:
        // late ASR for the same or an older turn can still extend the text and saved audio.
        // Keep the newest blocked turn because finalizing it also sweeps stale older turns.
        if self.pending.finalization.is_some_and(|pending| pending.turn_id() >= action.turn_id()) {
            return true;
        }
        self.pending.finalization = Some(action);
        true
    }

    fn finalization_is_blocked(&self, turn_id: u64) -> bool {
        self.requests
            .in_flight_request
            .as_ref()
            .is_some_and(|request| request.target.turn_id.0 <= turn_id)
            || self
                .pending
                .asr_segments
                .iter()
                .any(|segment| self.pending_segment_blocks_finalization(segment, turn_id))
    }

    /// Whether a queued ASR segment may still extend `turn_id` or an older turn.
    ///
    /// `PendingAsrSegment::turn_id()` uses only the immediate `previous_segment_id`
    /// (or the segment itself). Max-chunk / interim-silence chains therefore report
    /// intermediate ids (segment 3 with previous=2 yields `turn_id` 2) even when the
    /// open draft turn is still the utterance root (turn 1 with segments [1, 2]).
    /// Comparing that proxy to the session turn id alone finalizes too early and
    /// drops the continuation onto a new turn after `open_turn` is cleared.
    fn pending_segment_blocks_finalization(
        &self,
        segment: &PendingAsrSegment,
        turn_id: u64,
    ) -> bool {
        if self.pending_child_is_next_utterance_of_closing_turn(segment, turn_id) {
            // AfterInterimSilence names the last closed segment as previous.
            // Once this turn is closing, that child remints after finalize
            // instead of blocking the caption and merging into it.
            return false;
        }
        if segment.turn_id().0 <= turn_id {
            return true;
        }

        if let Some(previous_segment_id) = segment.previous_segment_id {
            for (existing_turn_id, turn) in &self.turn_store.turns {
                if *existing_turn_id <= turn_id
                    && turn.draft().segment_ids.contains(&previous_segment_id)
                {
                    return true;
                }
            }

            // previous itself may still be queued ahead in the same multi-hop chain
            if self.pending.asr_segments.iter().any(|other| {
                other.segment_id == previous_segment_id
                    && self.pending_segment_blocks_finalization(other, turn_id)
            }) {
                return true;
            }

            // Max-chunk / prefix CompletionCheck can still be in-flight (or
            // deferred) before its segment id lands on the draft. A 160ms
            // child that names that segment as previous is the same utterance.
            if self.completion_request_owns_segment(previous_segment_id, turn_id) {
                return true;
            }
        } else if self.turn_store.open_turn_id.is_some_and(|open| open <= turn_id)
            && self.turn_store.open_turn_accepts_root_segment
            && self.config.can_connect_interim_after_completion()
        {
            // Root segment that a Namo-continued open turn will absorb.
            return true;
        }

        false
    }

    fn completion_request_owns_segment(&self, segment_id: u64, turn_id: u64) -> bool {
        let owns = |request: &AsrRequest| {
            request.kind == AsrTaskKind::CompletionCheck
                && request.target.turn_id.0 <= turn_id
                && (request.target.last_segment_id.map(|id| id.0) == Some(segment_id)
                    || request.target.first_segment_id.map(|id| id.0) == Some(segment_id))
        };
        self.requests.in_flight_request.as_ref().is_some_and(owns)
            || self.requests.deferred_completion.iter().any(owns)
    }

    fn pending_child_is_next_utterance_of_closing_turn(
        &self,
        segment: &PendingAsrSegment,
        turn_id: u64,
    ) -> bool {
        if self.turn_store.open_turn_id != Some(turn_id) || !self.turn_store.open_turn_is_closing {
            return false;
        }
        let Some(previous_segment_id) = segment.previous_segment_id else {
            return false;
        };
        match segment.reason {
            // Max-chunk / streaming-chunk children are still the same utterance.
            SegmentCloseReason::SegmentMaxChunksReached
            | SegmentCloseReason::InterimChunkReached => return false,
            SegmentCloseReason::InterimResultSilenceReached
            | SegmentCloseReason::EndSilenceReached => {}
        }
        if segment.turn_id().0 == turn_id {
            return true;
        }
        self.turn_store.turns.get(&turn_id).is_some_and(|turn| {
            turn.draft().segment_ids.contains(&previous_segment_id)
                || turn.draft().latest_segment_id == Some(previous_segment_id)
        })
    }
}
