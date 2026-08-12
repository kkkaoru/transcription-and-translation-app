use super::super::*;

struct RejectingAsrRunner;

impl AsrRequestRunner for RejectingAsrRunner {
    fn submit(&mut self, _request: AsrRequest) -> bool {
        false
    }

    fn try_recv_result(&mut self) -> Option<AsrResult> {
        None
    }
}

#[test]
fn turn_runtime_asr_submit_failure_does_not_occupy_in_flight_slot() {
    let (mut runtime, _config) =
        RecognitionSessionTestBuilder::new().asr_runner(Box::new(RejectingAsrRunner)).build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..10,
    );

    runtime.step();

    assert!(
        runtime.requests.in_flight_request.is_none(),
        "failed ASR submit must not leave the runtime waiting forever for a result"
    );
    assert!(
        runtime.requests.last_dispatched.is_none(),
        "failed ASR submit must not be recorded as a dispatched request"
    );
}

#[test]
fn turn_runtime_dispatches_completion_instead_of_covered_stale_interim() {
    let (mut runtime, _config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple).build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 100..200)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 200..250)
        .pending_segment(3, Some(1), SegmentCloseReason::EndSilenceReached, 0..300);

    runtime.step();

    let dispatched = runtime
        .take_last_dispatched()
        .expect("covered interim requests should be dropped in favor of completion");
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.range.start_sample, GlobalSampleIndex(0));
    assert_eq!(dispatched.target.range.end_sample, GlobalSampleIndex(300));
    assert!(
        runtime.pending.asr_segments.is_empty(),
        "covered interim segments must not remain queued to overwrite the completion later"
    );
}

#[test]
fn turn_runtime_builds_one_completion_request_with_following_interim_after_max_chunks_when_td_allows_it(
) {
    let (mut runtime, _config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Namo).build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::SegmentMaxChunksReached, 0..100)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    let dispatched = runtime
        .take_last_dispatched()
        .expect("Namo should connect completion and following interim into one ASR request");
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert_eq!(dispatched.target.range.start_sample, GlobalSampleIndex(0));
    assert_eq!(dispatched.target.range.end_sample, GlobalSampleIndex(200));
    assert_eq!(dispatched.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(dispatched.target.last_segment_id, Some(SegmentId(2)));
    let request =
        runtime.requests.in_flight_request.as_ref().expect("connected request should be in flight");
    assert_eq!(request.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(request.audio.len(), 200);
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_does_not_merge_completion_with_root_interim_without_segment_chain() {
    let (mut runtime, _config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Namo).build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::EndSilenceReached, 0..100)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    let dispatched = runtime
        .take_last_dispatched()
        .expect("completion should dispatch without merging an unrelated root interim");
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.range.start_sample, GlobalSampleIndex(0));
    assert_eq!(dispatched.target.range.end_sample, GlobalSampleIndex(100));
    assert_eq!(dispatched.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(dispatched.target.last_segment_id, Some(SegmentId(1)));
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "a root interim after completion must wait for TD/grammar, not request-level merge"
    );
}

#[test]
fn turn_runtime_keeps_completion_and_following_interim_separate_when_td_disallows_it() {
    let (mut runtime, _config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple).build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::EndSilenceReached, 0..100)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    let dispatched =
        runtime.take_last_dispatched().expect("Simple should dispatch completion first");
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.range.start_sample, GlobalSampleIndex(0));
    assert_eq!(dispatched.target.range.end_sample, GlobalSampleIndex(100));
    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("completion request should be in flight");
    assert_eq!(request.audio.len(), 100);
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(
        runtime.pending.asr_segments.front().expect("interim should remain pending").segment_id,
        2
    );
}

#[test]
fn turn_runtime_builds_one_interim_request_from_multiple_pending_interim_segments() {
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new().build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..100)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    let dispatched = runtime
        .take_last_dispatched()
        .expect("pending interim segments should be combined into one ASR request");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.range.start_sample, GlobalSampleIndex(0));
    assert_eq!(dispatched.target.range.end_sample, GlobalSampleIndex(200));
    assert_eq!(dispatched.target.last_segment_id, Some(SegmentId(2)));
    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("combined interim request should be in flight");
    assert_eq!(
        request.source_audio,
        [vec![1.0; 100], vec![2.0; 100]].concat(),
        "interim ASR request padding must not change the source audio that will be persisted"
    );
    assert_eq!(request.target.first_segment_id, Some(SegmentId(1)));
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_does_not_merge_adjacent_root_interim_segments_without_segment_chain() {
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..100)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..180);

    runtime.step();

    let dispatched =
        runtime.take_last_dispatched().expect("first root interim should dispatch alone");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(dispatched.target.last_segment_id, Some(SegmentId(1)));
    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("first root interim request should be in flight");
    assert_eq!(
        request.source_audio.len(),
        100,
        "adjacent root segments must not be silently merged into one ASR request"
    );
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "the second root segment should remain pending for the next turn"
    );
}

#[test]
fn turn_runtime_batched_turn_check_promotes_pending_interim_to_completion_before_interim_asr() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .vad_interval_ms(32)
        .segment_start_speech_ms(1)
        .interim_display(true)
        .interim_result_silence_ms(32)
        .turn_check_silence_ms(64);
    let asr_handle = builder.use_manual_asr();
    let _outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    runtime.push_vad_frame(&vec![1.0; 16_000], vad(true));
    runtime.push_vad_frame(&vec![0.0; 512], vad(false));
    runtime.push_vad_frame(&vec![0.0; 512], vad(false));

    runtime.step();

    let submitted = asr_handle.submitted_requests();
    assert_eq!(submitted.len(), 1);
    assert_eq!(
        submitted[0].kind,
        AsrTaskKind::CompletionCheck,
        "when turn-check silence is already reached, the queued interim segment must become the completion ASR instead of dispatching interim first"
    );
    assert_eq!(submitted[0].close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(
        runtime.pending.turn_check.is_none(),
        "the turn-check event must be consumed after promoting the queued interim segment"
    );
}

#[test]
fn turn_runtime_turn_check_flushes_nemotron_streaming_chunk_before_promoting_silence_interim() {
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimChunkReached, 0..160)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..320)
        .pending_turn_check(1);

    runtime.step();

    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("turn-check should flush the streaming chunk before promoting silence interim");
    assert_eq!(request.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(request.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(request.target.range, AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(160)));
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "silence interim must remain queued behind the flushed streaming chunk"
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| segment.reason),
        Some(SegmentCloseReason::InterimResultSilenceReached)
    );
    assert!(
        runtime.pending.turn_check.is_some(),
        "turn-check must be preserved so the silence interim can be promoted after the streaming chunk completes"
    );
}

#[test]
fn turn_runtime_turn_check_promotes_silence_interim_to_completion_after_nemotron_chunk_flushed() {
    // Regression: Nemotron streaming chunk + queued silence interim. After the
    // streaming chunk is flushed, the turn-check must re-fire and promote the
    // silence interim from InterimResultSilenceReached to
    // EndSilenceReached -> CompletionCheck, not degrade to InterimDisplay.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimChunkReached, 0..160)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..320)
        .pending_turn_check(1);

    runtime.step();

    let chunk_request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("first step must dispatch the streaming chunk");
    assert_eq!(chunk_request.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk_request.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert!(runtime.pending.turn_check.is_some(), "turn-check must be deferred, not consumed");
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| segment.reason),
        Some(SegmentCloseReason::InterimResultSilenceReached)
    );

    runtime.requests.in_flight_request = None;

    runtime.step();

    let completion = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("second step must promote the silence interim to CompletionCheck");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(completion.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        completion.target.range,
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320))
    );
    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after successful promotion"
    );
    assert!(
        runtime.pending.asr_segments.is_empty(),
        "silence interim must be consumed after promotion"
    );
}

#[test]
fn turn_runtime_turn_check_promotes_contiguous_interim_silence_chain_to_completion() {
    // Mid-utterance breath closes interim segment 1, then speech continues into
    // segment 2. When genuine end silence arrives, both InterimResultSilenceReached
    // segments may still be queued. Promotion must merge that contiguous chain into
    // one CompletionCheck instead of ignoring the turn-check (range containment
    // fails across abutting non-overlapping ranges) and dispatching InterimDisplay.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..100)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..200)
        .pending_turn_check(2);

    runtime.step();

    let completion = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("turn-check must promote the contiguous interim silence chain");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(completion.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        completion.target.range,
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(200)),
        "promoted completion must cover the full contiguous interim chain"
    );
    assert_eq!(completion.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(completion.target.last_segment_id, Some(SegmentId(2)));
    assert_eq!(
        completion.source_audio,
        [vec![1.0; 100], vec![2.0; 100]].concat(),
        "promoted completion must keep audio from every breath-chained interim segment"
    );
    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after promoting the contiguous interim chain"
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_turn_check_promotes_padding_overlapped_interim_silence_chain_to_completion() {
    // Production geometry: segment builder copies prior end-silence into the next
    // segment as ASR-only leading padding, so the next pending range starts before
    // the previous end (overlap) instead of abutting. Turn-check must still promote
    // the previous→next interim chain to one CompletionCheck; otherwise only
    // InterimDisplay runs and the final caption for the continued utterance is lost.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..100)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 80..200)
        .pending_turn_check(2);

    runtime.step();

    let completion = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("turn-check must promote a padding-overlapped interim silence chain");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(completion.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        completion.target.range,
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(200)),
        "promoted completion must span the union of the overlapped interim chain"
    );
    assert_eq!(completion.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(completion.target.last_segment_id, Some(SegmentId(2)));
    assert_eq!(
        completion.source_audio,
        [vec![1.0; 100], vec![2.0; 100]].concat(),
        "promoted completion must append only the non-overlapped suffix of the next interim"
    );
    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after promoting the overlapped interim chain"
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_turn_check_promotes_pending_interim_while_open_turn_exists() {
    let (mut runtime, config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple).build();
    let mut open_turn = Turn::new("turn-1-1-0".to_string(), 0);
    open_turn.draft_mut().append_recognized_segment(
        1,
        None,
        &[1.0],
        &[vad(true)],
        RecognitionRoute::from_model(config.asr.model),
        "前半".to_string(),
        0,
    );
    runtime_state(&mut runtime)
        .turn(1, open_turn)
        .open_turn(1)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..200)
        .pending_turn_check(2);

    runtime.step();

    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("turn-check must promote the queued interim even with an open turn");
    assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(request.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        request.target.turn_id,
        TurnId(1),
        "continuation interim should attach to the existing open turn"
    );
    assert_eq!(request.target.first_segment_id, Some(SegmentId(1)));
    assert_eq!(request.target.last_segment_id, Some(SegmentId(2)));
    assert_eq!(
        request.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after promoting the pending interim"
    );
    assert!(
        runtime.pending.asr_segments.is_empty(),
        "promoted interim must leave the pending ASR queue as the in-flight completion"
    );
}

#[test]
fn turn_runtime_turn_check_promotes_same_segment_pending_interim_before_open_turn_finalization() {
    let (mut runtime, config) =
        RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple).build();
    let mut open_turn = Turn::new("turn-1-1-0".to_string(), 0);
    open_turn.draft_mut().append_recognized_segment(
        1,
        None,
        &[1.0],
        &[vad(true)],
        RecognitionRoute::from_model(config.asr.model),
        "途中".to_string(),
        0,
    );
    runtime_state(&mut runtime)
        .turn(1, open_turn)
        .open_turn(1)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..160)
        .pending_turn_check(1);

    runtime.step();

    let request = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("matching open-turn segment must still promote the queued silence interim");
    assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(request.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(request.target.turn_id, TurnId(1));
    assert_eq!(request.target.range, AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(160)));
    assert!(runtime.pending.turn_check.is_none());
}

#[test]
fn turn_runtime_new_root_interim_after_open_simple_turn_is_emitted_as_next_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, config) = builder.build();
    let mut previous_turn = Turn::new("turn-1-1-0".to_string(), 0);
    {
        let draft = previous_turn.draft_mut();
        draft.append_recognized_segment(
            1,
            None,
            &[1.0],
            &[vad(true)],
            RecognitionRoute::from_model(config.asr.model),
            "前の途中".to_string(),
            0,
        );
    }
    runtime_state(&mut runtime).turn(1, previous_turn).open_turn(1).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        100..180,
    );

    runtime.step();
    let dispatched = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("new root interim should dispatch an ASR request");
    assert_eq!(
        dispatched.target.turn_id,
        TurnId(2),
        "a new root segment in Simple mode must not be attached to the previous open turn"
    );
    asr_handle.complete_request_with_text(&dispatched, "次の途中");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("次の途中...", false, 2, 2)]
    );
    assert_eq!(
        runtime.turn_store.open_turn_id,
        Some(2),
        "the following interim should become the currently displayed open turn"
    );
}

#[test]
fn turn_runtime_rerecognition_uses_global_audio_range_from_turn_sources() {
    let mut builder = RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Namo);
    let asr_handle = builder.use_manual_asr();
    let _outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        7,
        None,
        SegmentCloseReason::EndSilenceReached,
        400..520,
    );
    runtime.step();
    let completion =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    assert_eq!(completion.target.range.start_sample, GlobalSampleIndex(400));
    assert_eq!(completion.target.range.end_sample, GlobalSampleIndex(520));
    asr_handle.complete_request_with_text(&completion, "範囲確認");

    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("Namo completion should dispatch rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(rerecognition.target.range.start_sample, GlobalSampleIndex(400));
    assert_eq!(rerecognition.target.range.end_sample, GlobalSampleIndex(520));
}

#[test]
fn turn_runtime_dispatches_queued_interim_in_same_step_after_asr_result() {
    // Nemotron/interim chunks queue behind the in-flight request. After that
    // result lands, the next pending segment must dispatch in the same step.
    // Waiting for the next VAD/input tick adds a full outer-loop delay between
    // already-recognized audio and the following caption, and can lose the
    // tail when speech has already ended.
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );

    runtime.step();
    let first = runtime.requests.in_flight_request.clone().expect("first interim should dispatch");
    assert_eq!(first.kind, AsrTaskKind::InterimDisplay);

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        100..200,
    );
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "the continuation must stay queued while the first interim is in flight"
    );

    asr_handle.complete_request_with_text(&first, "前半");
    runtime.step();

    let second =
        runtime.requests.in_flight_request.as_ref().expect(
            "queued continuation must dispatch in the same step that applied the prior result",
        );
    assert_eq!(second.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(
        second.target.first_segment_id,
        Some(SegmentId(1)),
        "a chained continuation names the open-turn root as first_segment_id"
    );
    assert_eq!(second.target.last_segment_id, Some(SegmentId(2)));
    assert_eq!(
        second.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(
        runtime.pending.asr_segments.is_empty(),
        "the continuation must leave the pending queue once dispatched"
    );
}

#[test]
fn turn_runtime_promotes_turn_check_in_same_step_after_streaming_chunk_result() {
    // Speech ended while a Nemotron streaming chunk was in flight. After that
    // chunk result lands, the queued silence interim + turn-check must promote
    // to CompletionCheck immediately. An extra VAD tick here is when finals
    // go missing after the speaker already stopped.
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .pending_segment(1, None, SegmentCloseReason::InterimChunkReached, 0..160)
        .pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..320)
        .pending_turn_check(1);

    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("turn-check should flush the streaming chunk first");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert!(runtime.pending.turn_check.is_some());

    asr_handle.complete_request_with_text(&chunk, "途中");
    runtime.step();

    let completion = runtime.requests.in_flight_request.as_ref().expect(
        "turn-check must promote the silence interim in the same step that applied the chunk",
    );
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(completion.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        completion.target.range,
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320))
    );
    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after same-step promotion"
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_next_utterance_in_same_step_after_finalization() {
    // Successful finalization used to `return` before dispatch. The next
    // utterance's already-queued root segment then waited a full VAD/input
    // tick, which is when the first hypothesis of the following turn goes
    // missing after the speaker already started again.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "前の発話", &[1.0, 2.0, 3.0]))
        .pending_finalization(1)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.pending.finalization.is_none(),
        "unblocked finalization must complete in this step"
    );
    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "turn 1 must finalize before the next utterance is dispatched"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch in the same step that finalized the prior turn",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(
        runtime.pending.asr_segments.is_empty(),
        "the next-utterance segment must leave the pending queue once dispatched"
    );
}

#[test]
fn turn_runtime_dispatches_pending_asr_after_stale_turn_check_is_dropped() {
    // A turn-check whose activity epoch no longer matches is discarded. That
    // used to `return` before dispatch, so a newer utterance already queued
    // behind the stale check waited another VAD tick.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_turn_check(1)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);
    runtime.activity.segment_activity_epoch =
        runtime.activity.segment_activity_epoch.saturating_add(1);

    runtime.step();

    assert!(
        runtime.pending.turn_check.is_none(),
        "a stale turn-check must be dropped in this step"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued ASR must dispatch in the same step that dropped the stale turn-check",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_next_utterance_in_same_step_after_open_turn_timeout() {
    // Open-turn timeout used to `return` before dispatch. The next utterance's
    // already-queued root segment then waited a full VAD tick, which is when
    // the first hypothesis after a long pause goes missing.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .vad_interval_ms(32)
        .turn_check_silence_ms(32)
        .build();
    let timeout_ticks = runtime.timeout_ticks();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "前の発話", &[1.0, 2.0, 3.0]))
        .open_turn_since(1, 0)
        .next_runtime_tick(timeout_ticks)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "timed-out turn 1 must finalize in this step"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch in the same step that timed out the prior turn",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_next_utterance_in_same_step_after_turn_check_completes_without_grammar()
{
    // Simple turn-check silence used to finalize then `return` before dispatch.
    // A root segment already queued for the following utterance waited another
    // VAD tick, which is when the first hypothesis after a pause goes missing.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "前の発話", &[1.0, 2.0, 3.0]))
        .open_turn(1)
        .pending_turn_check(1)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.pending.turn_check.is_none(),
        "turn-check must be consumed after CompleteWithoutGrammar"
    );
    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "turn 1 must finalize in the same step as the silence turn-check"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch in the same step that completed the prior turn",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_pending_asr_in_same_step_after_ignored_turn_check() {
    // Ignore (no open turn to close) used to `return` before dispatch, so a
    // queued root segment waited another VAD tick for its first hypothesis.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .pending_turn_check(1)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.pending.turn_check.is_none(),
        "an ignored turn-check must be dropped in this step"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued ASR must dispatch in the same step that ignored the stale turn-check",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_next_utterance_when_namo_turn_check_rerecognition_cannot_submit() {
    // Namo turn-check used to keep the check and return without dispatch when
    // rerecognition could not occupy in-flight (empty draft audio). The next
    // utterance's queued root then waited another VAD tick — or forever.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "prior-turn", &[]))
        .open_turn(1)
        .pending_turn_check(1)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.pending.turn_check.is_none(),
        "a turn-check that cannot start rerecognition must be consumed"
    );
    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "the open turn must finalize from its existing draft instead of stalling"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch in the same step",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}

#[test]
fn turn_runtime_dispatches_next_utterance_when_namo_timeout_rerecognition_cannot_submit() {
    // Namo timeout rerecognition used to defer finalization because a queued
    // next-utterance root looked like a continuation of the still-open turn.
    let (mut runtime, _config) = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .vad_interval_ms(32)
        .turn_check_silence_ms(32)
        .build();
    let timeout_ticks = runtime.timeout_ticks();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "prior-turn", &[]))
        .open_turn_since(1, 0)
        .next_runtime_tick(timeout_ticks)
        .pending_segment(2, None, SegmentCloseReason::InterimResultSilenceReached, 100..200);

    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "timed-out turn 1 must finalize from its existing draft instead of stalling"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch in the same step as the timeout fallback",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(100), GlobalSampleIndex(200))
    );
    assert!(runtime.pending.asr_segments.is_empty());
}
