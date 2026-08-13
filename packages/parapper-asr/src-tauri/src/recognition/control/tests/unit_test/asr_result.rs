#![allow(clippy::cast_precision_loss)]

use super::super::*;

#[test]
fn turn_runtime_following_interim_keeps_previous_audio_visible_in_replaced_output() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .interim_display(true)
        .scripted_asr_texts(vec!["前半", "後半"]);
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );
    runtime.step();
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        100..180,
    );
    runtime.step();
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(
        outputs
            .iter()
            .map(|output| (
                output.text.as_str(),
                output.is_final,
                output.turn_id,
                output.segment_id
            ))
            .collect::<Vec<_>>(),
        vec![("前半...", false, 1, 1), ("前半後半...", false, 1, 2)]
    );
    assert_eq!(
        outputs.iter().map(|output| output.phrase.len()).collect::<Vec<_>>(),
        vec![100, 180],
        "a replaced interim output must still carry all previous turn audio"
    );
}

#[test]
fn turn_runtime_applies_asr_result_to_request_target_not_current_open_turn() {
    let mut builder = RecognitionSessionTestBuilder::new();
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 2);
    runtime_state(&mut runtime).open_turn(1).in_flight(request.clone());
    asr_handle.complete_request_with_text(&request, "target turn");

    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![OutputSnapshot {
            text: "target turn...".to_string(),
            is_final: false,
            turn_id: 2,
            segment_id: 2,
        }]
    );
    assert_eq!(
        runtime.turn_store.open_turn_id,
        Some(2),
        "open turn must follow the ASR request target after applying the result"
    );
}

#[test]
fn turn_runtime_completed_asr_result_without_in_flight_request_is_consumed_without_dispatching() {
    let mut builder = RecognitionSessionTestBuilder::new();
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 1);
    asr_handle.complete_request_with_text(&request, "late result");

    runtime.step();

    assert!(runtime.requests.in_flight_request.is_none());
    assert!(
        runtime.requests.last_dispatched.is_none(),
        "a late ASR result without an in-flight request must not synthesize a new dispatch"
    );
}

#[test]
fn turn_runtime_interim_output_uses_asr_result_elapsed_millis() {
    let mut builder = RecognitionSessionTestBuilder::new();
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(request.clone());
    asr_handle.complete_request_with_text_elapsed(&request, "処理時間あり", 37);

    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].text, "処理時間あり...");
    assert!(!outputs[0].is_final);
    assert_eq!(outputs[0].turn_id, 1);
    assert_eq!(outputs[0].segment_id, 1);
    assert_eq!(outputs[0].elapsed_millis, 37);
}

#[test]
fn turn_runtime_stale_asr_result_with_revision_mismatch_does_not_recreate_turn() {
    let mut builder = RecognitionSessionTestBuilder::new();
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).turn_revision(1, 1).in_flight(request.clone());
    asr_handle.complete_request_with_text(&request, "古い途中表示");

    runtime.step();

    assert!(
        outputs.lock().expect("outputs should be readable").is_empty(),
        "stale ASR result from a finalized turn must not overwrite the final output"
    );
    assert!(
        !runtime.turn_store.turns.contains_key(&1),
        "stale ASR result must not recreate a finalized turn draft"
    );
}

#[test]
fn turn_runtime_interim_after_finalized_turn_does_not_recreate_or_overwrite_final_output() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .interim_display(true)
        .scripted_asr_texts(vec!["遅い途中表示"]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "確定済み", &[1.0]))
        .turn_audio_range(1, 0..1);

    runtime.complete_turn_without_grammar(1);
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("確定済み。", true, 1, 1)]
    );

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        1..2,
    );
    runtime.step();
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("確定済み。", true, 1, 1)],
        "a finalized turn output must be immutable even if a late interim segment appears"
    );
    assert!(
        !runtime.turn_store.turns.contains_key(&1),
        "late interim for a finalized turn must not recreate a mutable draft"
    );
}

#[test]
fn turn_runtime_speech_after_finalized_greeting_starts_a_new_turn() {
    // After a complete greeting finalizes, the next utterance often arrives as a
    // child of the last closed segment (AfterInterimSilence). That audio must
    // become turn 2 instead of vanishing with the finalized turn.
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .scripted_asr_texts(vec!["こんにちはーきこえますかー"]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "こんばんは", &[1.0]))
        .turn_audio_range(1, 0..10);

    runtime.complete_turn_without_grammar(1);
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("こんばんは。", true, 1, 1)]
    );

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        10..30,
    );
    runtime.step();
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("こんばんは。", true, 1, 1),
            output_snapshot("こんにちはーきこえますかー...", false, 2, 2),
        ],
        "the second utterance after a finalized greeting must emit as a new turn"
    );
    assert_eq!(runtime.turn_store.open_turn_id, Some(2));
    assert!(
        !runtime.turn_store.finalized_turns.contains(&2),
        "the reminted turn must stay open for further speech"
    );
}

#[test]
fn third_utterance_after_reminted_interim_must_not_drop_or_reuse_turn_two() {
    // Invariant: after turn 1 finalizes and utterance 2 remints onto turn 2 via
    // InterimResultSilenceReached, a third utterance must still emit and must
    // not reuse turn 2 (caption overwrite / silent drop).
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .scripted_asr_texts(vec!["utterance-two", "utterance-three"]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "utterance-one", &[1.0]))
        .turn_audio_range(1, 0..10);

    runtime.complete_turn_without_grammar(1);
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("utterance-one。", true, 1, 1)]
    );

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        10..30,
    );
    runtime.step();
    runtime.step();
    assert_eq!(runtime.turn_store.open_turn_id, Some(2));

    // New root segment: SegmentBuilder starts a fresh root after the reminted
    // turn's interim close when the next utterance is not a child attachment.
    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        30..50,
    );
    runtime.step();
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| output.text.contains("utterance-three")),
        "utterance 3 must not be dropped after a reminted interim turn; got {outputs:?}"
    );
    assert!(
        outputs
            .iter()
            .any(|output| { output.text.contains("utterance-three") && output.turn_id == 3 }),
        "utterance 3 must not land on reminted turn 2; got {outputs:?}"
    );
    assert!(
        !outputs
            .iter()
            .any(|output| { output.text.contains("utterance-three") && output.turn_id == 2 }),
        "utterance 3 must not overwrite reminted turn 2; got {outputs:?}"
    );
}

#[test]
fn reminted_turn_completion_must_emit_is_final() {
    // Invariant: a reminted turn that later receives completion audio must
    // finalize and emit isFinal (existing remint coverage only asserts open).
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .scripted_asr_texts(vec!["reminted-interim", "reminted-final"]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .turn(1, recognized_turn_with_audio(1, "prior-final", &[1.0]))
        .turn_audio_range(1, 0..10);

    runtime.complete_turn_without_grammar(1);

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        10..30,
    );
    runtime.step();
    runtime.step();
    assert_eq!(runtime.turn_store.open_turn_id, Some(2));
    assert!(
        outputs.lock().expect("outputs should be readable").iter().any(|output| {
            output.turn_id == 2 && !output.is_final && output.text.contains("reminted-interim")
        }),
        "reminted turn must first emit an interim"
    );

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        30..50,
    );
    runtime.step();
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| output.turn_id == 2 && output.is_final),
        "reminted turn 2 must finalize with isFinal after completion; got {outputs:?}"
    );
}

#[test]
fn turn_runtime_completion_does_not_duplicate_visible_interim_when_rerecognition_does_not_run() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let interim = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "五月五日はこどもの日です");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(1)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "五月五日はこどもの日です");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("五月五日はこどもの日です...", false, 1, 1),
            output_snapshot("五月五日はこどもの日です。", true, 1, 1),
        ],
        "completion must not duplicate the already-visible utterance in the final when rerecognition does not run"
    );
}

#[test]
fn turn_runtime_duplicate_completion_keeps_uncovered_tail_without_advancing_segment_id() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "五月五日はこどもの日です");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "五月五日はこどもの日です");
    runtime.step();

    let rerecognition =
        runtime.requests.in_flight_request.clone().expect(
            "duplicate completion with an uncovered tail must still dispatch rerecognition",
        );
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        rerecognition.target.last_segment_id,
        Some(SegmentId(1)),
        "empty duplicate completion text must not append a new segment or advance latest_segment_id"
    );
    asr_handle.complete_request_with_text(&rerecognition, "五月五日はこどもの日です");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "五月五日はこどもの日です。");
    assert!(final_output.is_final);
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "uncovered completion tail audio must remain even when duplicate text does not create a new segment"
    );
}

#[test]
fn turn_runtime_empty_incoming_completion_keeps_uncovered_tail_without_advancing_segment_id() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "。");
    runtime.step();

    let rerecognition = runtime.requests.in_flight_request.clone().expect(
        "blank incoming completion with an uncovered tail must still dispatch rerecognition",
    );
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        rerecognition.target.last_segment_id,
        Some(SegmentId(1)),
        "empty incoming completion text must not append a new segment or advance latest_segment_id"
    );
    asr_handle.complete_request_with_text(&rerecognition, "全体");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "全体。");
    assert!(final_output.is_final);
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "uncovered completion tail audio must remain even when incoming text is empty"
    );
}

#[test]
fn turn_runtime_whitespace_asr_completion_keeps_uncovered_tail_without_advancing_segment_id() {
    for incoming in ["", "   "] {
        let mut builder = RecognitionSessionTestBuilder::new()
            .turn_detector(TurnDetector::Simple)
            .interim_display(true)
            .rerecognize_full_on_complete(true);
        let asr_handle = builder.use_manual_asr();
        let outputs = builder.use_recording_phrase_sink();
        let (mut runtime, _config) = builder.build();

        let mut interim = interim_request_for_turn(1, 1);
        interim.source_audio = (0..100).map(|sample| sample as f32).collect();
        interim.source_vad_results = vec![vad(true)];
        interim.target = AsrTarget::new(
            TurnId(1),
            TurnRevision(0),
            AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
            Some(SegmentId(1)),
            Some(SegmentId(1)),
        );
        runtime_state(&mut runtime).in_flight(interim.clone());
        asr_handle.complete_request_with_text(&interim, "全体");
        runtime.step();

        let mut completion = interim_request_for_turn(2, 1);
        completion.kind = AsrTaskKind::CompletionCheck;
        completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
        completion.source_audio = (0..150).map(|sample| sample as f32).collect();
        completion.source_vad_results = vec![vad(true), vad(true)];
        completion.target = AsrTarget::new(
            TurnId(1),
            TurnRevision(0),
            AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
            Some(SegmentId(1)),
            Some(SegmentId(2)),
        );
        runtime_state(&mut runtime).in_flight(completion.clone());
        asr_handle.complete_request_with_text(&completion, incoming);
        runtime.step();

        let rerecognition = runtime.requests.in_flight_request.clone().unwrap_or_else(|| {
            panic!(
                "whitespace ASR {incoming:?} must still apply uncovered tail and dispatch rerecognition"
            )
        });
        assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
        assert_eq!(
            rerecognition.target.last_segment_id,
            Some(SegmentId(1)),
            "unusable completion text {incoming:?} must not append a new segment"
        );
        asr_handle.complete_request_with_text(&rerecognition, "全体");
        runtime.step();

        let outputs = outputs.lock().expect("outputs should be readable");
        let final_output = outputs.last().expect("final output should be emitted");
        assert_eq!(final_output.text, "全体。");
        assert!(final_output.is_final);
        assert_eq!(final_output.segment_id, 1);
        assert_eq!(
            final_output.phrase,
            (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
            "uncovered completion tail must remain for unusable ASR {incoming:?}"
        );
    }
}

#[test]
fn turn_runtime_failed_completion_keeps_visible_text_and_uncovered_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.fail_request(&completion);
    runtime.step();

    assert!(runtime.requests.in_flight_request.is_none());
    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "全体。");
    assert!(final_output.is_final);
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "failed completion ASR must still keep visible text and uncovered tail audio"
    );
}

#[test]
fn turn_runtime_pending_next_utterance_preempts_rerecognition_and_keeps_visible_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone()).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        200..300,
    );
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "the completed turn must finalize from the visible draft instead of waiting on rerecognition"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "queued next-utterance ASR must dispatch instead of occupying the slot with rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(200), GlobalSampleIndex(300))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "preempting rerecognition must keep visible text and uncovered tail audio"
    );
}

#[test]
fn turn_runtime_in_flight_rerecognition_yields_to_pending_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("completion without a newer pending utterance should start rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        200..300,
    );
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "in-flight rerecognition must yield so the prior turn can finalize from visible text"
    );
    let dispatched = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued next-utterance ASR must take the slot from in-flight rerecognition");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let dispatched_after_late_result = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("a late rerecognition result must not steal the next-utterance slot");
    assert_eq!(dispatched_after_late_result.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched_after_late_result.target.turn_id, TurnId(3));

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(
        final_output.text, "全体。",
        "a late rerecognition result must not shorten the already-final visible text"
    );
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "a late rerecognition result must not drop uncovered tail audio"
    );
}

#[test]
fn turn_runtime_child_next_utterance_preempts_rerecognition_and_keeps_visible_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone()).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "a child of the last closed segment must not block finalization of a closing turn"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the AfterInterimSilence child must remint onto a new turn instead of waiting on rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(
        dispatched.target.turn_id,
        TurnId(3),
        "the next utterance must remint off the finalized parent turn"
    );
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "preempting rerecognition for a child next utterance must keep visible text and uncovered tail"
    );
}

#[test]
fn turn_runtime_in_flight_rerecognition_yields_to_child_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("completion without a newer pending utterance should start rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "in-flight closing rerecognition must yield to a child next utterance"
    );
    let dispatched = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("the AfterInterimSilence child must remint onto a new turn");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let dispatched_after_late_result = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("a late rerecognition result must not steal the next-utterance slot");
    assert_eq!(dispatched_after_late_result.target.turn_id, TurnId(3));

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "a late rerecognition result must not drop uncovered tail audio"
    );
}

#[test]
fn turn_runtime_same_turn_continuation_does_not_preempt_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "Namo completion must wait on grammar rerecognition"
    );

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..200,
    );
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "a same-turn continuation must wait for grammar rerecognition instead of stealing the slot"
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "the open utterance must stay open so grammar can still Continue"
    );
    assert_eq!(runtime.pending.asr_segments.len(), 1);
}

#[test]
fn turn_runtime_namo_confirmed_grammar_yields_rerecognition_to_child_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("Namo completion must wait on grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        runtime.requests.pending_rerecognition_purpose,
        Some(RerecognitionPurpose::GrammarAfterCompletion)
    );

    runtime
        .turn_store
        .turns
        .get_mut(&1)
        .expect("turn 1 draft must still be open")
        .draft_mut()
        .boundary_candidates =
        vec![boundary_candidate("全体", 150, 150, 150, GrammarBoundaryClass::NormalEnd)];

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "confirmed completing grammar must yield the slot to a true next utterance"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the AfterInterimSilence child must remint onto a new turn instead of waiting on grammar rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let dispatched_after_late_result = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("a late grammar rerecognition result must not steal the next-utterance slot");
    assert_eq!(dispatched_after_late_result.target.turn_id, TurnId(3));

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(
        final_output.text, "全体。",
        "yielding grammar rerecognition must not drop already-visible text"
    );
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "yielding grammar rerecognition must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_namo_incomplete_grammar_keeps_rerecognition_when_root_is_pending() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "Namo completion must wait on grammar rerecognition"
    );

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "incomplete grammar must keep the slot so Namo can still Continue into a pending root"
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "the open utterance must stay open while Continue is still possible"
    );
    assert_eq!(runtime.pending.asr_segments.len(), 1);
}

#[test]
fn turn_runtime_completion_visible_sentence_end_yields_to_child_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体。");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone()).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "a visible sentence end on the completion draft must yield without waiting for rerecognition"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the AfterInterimSilence child must remint onto a new turn instead of waiting on grammar rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "yielding from the visible completion draft must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_completion_visible_sentence_end_yields_in_flight_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体。");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("without a newer utterance, Namo still starts grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert!(
        !runtime
            .turn_store
            .turns
            .get(&1)
            .expect("turn 1 must still be open")
            .draft()
            .boundary_candidates
            .is_empty(),
        "completion must populate boundary candidates from the visible draft"
    );

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "in-flight grammar rerecognition must yield once the visible draft already completes the turn"
    );
    let dispatched =
        runtime.requests.in_flight_request.as_ref().expect("the next utterance must take the slot");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(3));

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "a late rerecognition result must not drop uncovered tail audio"
    );
}

#[test]
fn turn_runtime_completion_mid_clause_keeps_grammar_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&completion, "しようとしたら");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "a Continue-possible mid-clause must still wait on grammar rerecognition"
    );

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "internal or missing completing grammar must not treat the child as a new turn"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
}

#[test]
fn turn_runtime_completion_internal_sentence_end_keeps_grammar_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&completion, "前半。続き");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "a sentence end that is not at the visible text end must keep Continue possible"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
}

#[test]
fn turn_runtime_completion_without_interim_yields_child_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert!(
        runtime.turn_store.open_turn_id.is_none(),
        "completion without an interim must not already own an open turn"
    );

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "a closing completion without an interim must remint the AfterInterimSilence child"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must take the slot instead of waiting on grammar rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.target.turn_id, TurnId(2));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert_eq!(final_output.text, "全体。");
    assert_eq!(
        final_output.phrase,
        vec![1.0; 150],
        "reminting a child next utterance must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_completion_without_interim_keeps_max_chunk_on_same_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "a closing max-chunk continuation must take the slot instead of waiting on grammar rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "same-turn max-chunk audio must still extend the open utterance"
    );
    assert!(runtime.pending.asr_segments.is_empty());
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");
    assert_eq!(
        draft.full_audio,
        vec![1.0; 150],
        "releasing rerecognition must keep uncovered tail audio on the draft"
    );

    let max_chunk = dispatched.clone();
    asr_handle.complete_request_with_text(&max_chunk, "追加");
    runtime.step();

    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "applying max-chunk tail ASR must not remint a new turn"
    );
    assert_eq!(runtime.turn_store.open_turn_id, Some(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "max-chunk tail ASR must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "max-chunk tail ASR must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100]].concat(),
        "max-chunk tail ASR must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_in_flight_completion_yields_to_prequeued_max_chunk_then_resumes() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();

    let dispatched =
        runtime.requests.in_flight_request.as_ref().expect(
            "in-flight CompletionCheck must yield the slot to same-turn max-chunk tail ASR",
        );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert_ne!(
        dispatched.request_id, completion.request_id,
        "yielding CompletionCheck must drop the original in-flight request"
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "yielding CompletionCheck to max-chunk must not remint a new turn"
    );
    assert!(
        !runtime.requests.deferred_completion.is_empty(),
        "yielding CompletionCheck must keep the prefix request deferred"
    );
    assert!(runtime.pending.asr_segments.is_empty());

    let max_chunk = dispatched.clone();
    asr_handle.complete_request_with_text(&max_chunk, "追加");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must resume after the same-turn max-chunk tail");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(resumed.target.turn_id, TurnId(1));
    assert_eq!(resumed.target.range, AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)));
    assert_ne!(resumed.request_id, completion.request_id);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "追加");
    assert_eq!(draft.full_audio, vec![2.0; 100]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert_eq!(runtime.turn_store.open_turn_id, Some(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed CompletionCheck must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "resumed CompletionCheck must keep the uncovered tail; got {}",
        draft.combined_text
    );
    let overall_pos = draft.combined_text.find("全体").expect("prefix text");
    let tail_pos = draft.combined_text.find("追加").expect("tail text");
    assert!(
        overall_pos < tail_pos,
        "prefix completion must prepend before the tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100]].concat(),
        "resumed CompletionCheck must prepend uncovered prefix audio"
    );
}

#[test]
fn turn_runtime_in_flight_completion_yields_to_prequeued_160ms_then_resumes() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let dispatched = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight CompletionCheck must yield the slot to same-turn 160ms tail ASR");
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert_ne!(dispatched.request_id, completion.request_id);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    let chunk = dispatched.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must resume after the same-turn 160ms tail");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(resumed.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "続き");
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed CompletionCheck must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed CompletionCheck must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "resumed CompletionCheck must prepend uncovered prefix audio"
    );
}

#[test]
fn turn_runtime_in_flight_end_silence_yields_to_root_160ms() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    assert!(
        runtime.turn_store.open_turn_id.is_none(),
        "completion without an interim must not already own an open turn"
    );

    // Production Nemotron 160ms after EndSilence: streaming was flushed, so the
    // next chunk is a new root (previous=None, new display id).
    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight EndSilence CompletionCheck must yield to a later root 160ms tail");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, completion.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::EndSilenceReached)
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must resume after the root 160ms tail");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(resumed.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "続き");
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed prefix CompletionCheck must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed prefix CompletionCheck must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "resumed prefix must prepend uncovered prefix audio ahead of the root 160ms tail"
    );
}

#[test]
fn turn_runtime_resumed_end_silence_overlap_keeps_prefix_before_160ms_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..200,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);

    // Segment-builder padding copies prior end-silence into the next chunk, so
    // the later 160ms starts before the EndSilence range ends.
    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight overlapping EndSilence must yield to a later root 160ms tail");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, completion.request_id);

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("overlapping EndSilence prefix must resume after the 160ms tail");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "続き");
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "overlapping EndSilence resume must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "overlapping EndSilence resume must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    let prefix_pos = draft.combined_text.find("全体").expect("prefix text");
    let tail_pos = draft.combined_text.find("続き").expect("tail text");
    assert!(
        prefix_pos < tail_pos,
        "overlapping EndSilence prefix must stay before the 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "overlapping EndSilence must prepend only the uncovered prefix, not restack the 160ms tail"
    );
}

#[test]
fn turn_runtime_in_flight_silence_interim_yields_to_root_160ms() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..150,
    );
    runtime.step();
    let silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("silence interim must dispatch InterimDisplay ASR");
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));

    // Production Nemotron 160ms after a silence snapshot: streaming starts as a
    // new root (previous=None, new display id).
    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight silence InterimDisplay must yield to a later root 160ms tail");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, silence.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::InterimResultSilenceReached)
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix silence InterimDisplay must resume after the root 160ms tail");
    assert_eq!(resumed.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(resumed.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "続き");
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体");
    runtime.step();

    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed silence prefix must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed silence prefix must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    let prefix_pos = draft.combined_text.find("全体").expect("prefix text");
    let tail_pos = draft.combined_text.find("続き").expect("tail text");
    assert!(
        prefix_pos < tail_pos,
        "resumed silence prefix must prepend before the 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "resumed silence prefix must prepend uncovered prefix audio ahead of the root 160ms tail"
    );
}

#[test]
fn turn_runtime_resumed_silence_overlap_keeps_prefix_before_160ms_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..200,
    );
    runtime.step();
    let silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("silence interim must dispatch InterimDisplay ASR");

    // Segment-builder padding copies prior end-silence into the next chunk, so
    // the later 160ms starts before the silence range ends.
    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight overlapping silence must yield to a later root 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, silence.request_id);

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("overlapping silence prefix must resume after the 160ms tail");
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "続き");
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "overlapping silence resume must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "overlapping silence resume must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    let prefix_pos = draft.combined_text.find("全体").expect("prefix text");
    let tail_pos = draft.combined_text.find("続き").expect("tail text");
    assert!(
        prefix_pos < tail_pos,
        "overlapping silence prefix must stay before the 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "overlapping silence must prepend only the uncovered prefix, not restack the 160ms tail"
    );
}

#[test]
fn turn_runtime_late_yielded_completion_result_does_not_clobber_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("max-chunk tail must be in flight after CompletionCheck yields");
    asr_handle.complete_request_with_text(&completion, "短い");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.request_id),
        Some(max_chunk.request_id),
        "a late original CompletionCheck result must not steal the max-chunk slot"
    );
    assert!(
        runtime
            .turn_store
            .turns
            .get(&1)
            .is_none_or(|turn| { !turn.draft().combined_text.contains("短い") }),
        "a mismatched late CompletionCheck must not clobber the draft"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
}

#[test]
fn turn_runtime_in_flight_completion_does_not_yield_to_after_interim_silence() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let _asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence must not steal in-flight CompletionCheck");
    assert_eq!(in_flight.request_id, completion.request_id);
    assert_eq!(in_flight.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert!(runtime.requests.deferred_completion.is_empty());
}

#[test]
fn turn_runtime_in_flight_completion_yields_to_160ms_keeping_visible_interim() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        0..160,
    );
    runtime.step();
    let interim = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("streaming chunk must dispatch interim ASR");
    asr_handle.complete_request_with_text(&interim, "前半");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::EndSilenceReached,
        0..160,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR on the open turn");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(completion.target.turn_id, TurnId(1));

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        160..320,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight CompletionCheck must yield to the later 160ms tail");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "前半",
        "yielding CompletionCheck must keep already-visible interim text"
    );

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must resume after the 160ms tail");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("前半"),
        "160ms tail must not drop visible interim text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "160ms tail must append the continuation; got {}",
        draft.combined_text
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed CompletionCheck must update the prefix; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed CompletionCheck must keep the uncovered tail; got {}",
        draft.combined_text
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "same-turn 160ms continuation must not remint"
    );
}

#[test]
fn turn_runtime_160ms_then_after_interim_silence_emits_tail_on_current_caption() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        0..160,
    );
    runtime.step();
    let lead = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("first 160ms must dispatch");
    asr_handle.complete_request_with_text(&lead, "前半");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        160..260,
    );
    runtime.step();
    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("AfterInterimSilence after 160ms must dispatch");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "前半");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("AfterInterimSilence must dispatch after grammar");
    }
    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| {
            output.turn_id == 1 && output.text.contains("前半") && output.text.contains("後半")
        }),
        "same-utterance AfterInterimSilence after 160ms must emit on the current caption; got {:?}",
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers prefix defer, max-chunk yield, 160ms apply, and resume order"
)]
fn turn_runtime_in_flight_max_chunk_yields_to_160ms_without_dropping_prefix() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();
    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("prefix CompletionCheck must yield to same-turn max-chunk");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::EndSilenceReached)
    );

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimChunkReached,
        250..410,
    );
    runtime.step();

    let chunk =
        runtime.requests.in_flight_request.as_ref().expect(
            "in-flight max-chunk CompletionCheck must yield the slot to a later 160ms tail",
        );
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, max_chunk.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 2);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::EndSilenceReached),
        "yielding max-chunk must keep the deferred prefix CompletionCheck"
    );
    assert_eq!(
        runtime.requests.deferred_completion[1].close_reason,
        Some(SegmentCloseReason::SegmentMaxChunksReached)
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.full_audio,
        vec![2.0; 100],
        "yielding max-chunk must park uncovered tail audio so 160ms can append"
    );

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed_max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("max-chunk CompletionCheck must resume after the 160ms tail");
    assert_eq!(resumed_max_chunk.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed_max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(resumed_max_chunk.target.turn_id, TurnId(1));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::EndSilenceReached)
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "160ms tail must stay visible; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![2.0; 100], vec![3.0; 160]].concat(),
        "160ms tail must keep parked max-chunk audio"
    );

    let resumed_max_chunk = resumed_max_chunk.clone();
    asr_handle.complete_request_with_text(&resumed_max_chunk, "追加");
    runtime.step();

    let resumed_prefix = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must still resume after max-chunk");
    assert_eq!(resumed_prefix.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed_prefix.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(resumed_prefix.target.turn_id, TurnId(1));
    assert_ne!(resumed_prefix.request_id, prefix.request_id);
    assert!(runtime.requests.deferred_completion.is_empty());
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("追加"),
        "resumed max-chunk must keep tail text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed max-chunk must keep the 160ms tail; got {}",
        draft.combined_text
    );
    let extra_pos = draft.combined_text.find("追加").expect("max-chunk text");
    let cont_pos = draft.combined_text.find("続き").expect("160ms text");
    assert!(
        extra_pos < cont_pos,
        "max-chunk text must stay before the 160ms tail; got {}",
        draft.combined_text
    );

    let resumed_prefix = resumed_prefix.clone();
    asr_handle.complete_request_with_text(&resumed_prefix, "全体。");
    runtime.step();

    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert_eq!(runtime.turn_store.open_turn_id, Some(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed prefix CompletionCheck must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "resumed prefix must keep max-chunk text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed prefix must keep the 160ms tail; got {}",
        draft.combined_text
    );
    let overall_pos = draft.combined_text.find("全体").expect("prefix text");
    let extra_pos = draft.combined_text.find("追加").expect("max-chunk text");
    let cont_pos = draft.combined_text.find("続き").expect("160ms text");
    assert!(
        overall_pos < extra_pos && extra_pos < cont_pos,
        "prefix, max-chunk, and 160ms text must stay in audio order; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100], vec![3.0; 160]].concat(),
        "resumed prefix must prepend uncovered prefix audio ahead of parked max-chunk and 160ms"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers max-chunk park trim, 160ms apply, resume text order, and prefix audio"
)]
fn turn_runtime_max_chunk_yield_does_not_double_count_160ms_overlap() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    runtime.requests.in_flight_request.as_ref().expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();
    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("prefix CompletionCheck must yield to same-turn max-chunk");

    // Segment-builder padding copies prior max-chunk end-silence into the next
    // 160ms, so the grid starts before the parked max-chunk range ends.
    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimChunkReached,
        200..360,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight max-chunk must yield to the overlapping 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, max_chunk.request_id);
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.full_audio,
        vec![2.0; 50],
        "yielding max-chunk must park only the uncovered prefix before the 160ms overlap"
    );

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed_max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("max-chunk CompletionCheck must resume after the 160ms tail");
    assert_eq!(resumed_max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.full_audio,
        [vec![2.0; 50], vec![3.0; 160]].concat(),
        "160ms must keep its full grid instead of stacking on parked overlap"
    );
    assert!(
        draft.combined_text.contains("続き"),
        "160ms tail must stay visible; got {}",
        draft.combined_text
    );

    let resumed_max_chunk = resumed_max_chunk.clone();
    asr_handle.complete_request_with_text(&resumed_max_chunk, "追加");
    runtime.step();

    let resumed_prefix = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("prefix CompletionCheck must still resume after max-chunk");
    assert_eq!(resumed_prefix.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("追加"),
        "resumed max-chunk must keep tail text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed max-chunk must keep the 160ms tail; got {}",
        draft.combined_text
    );
    let extra_pos = draft.combined_text.find("追加").expect("max-chunk text");
    let cont_pos = draft.combined_text.find("続き").expect("160ms text");
    assert!(
        extra_pos < cont_pos,
        "max-chunk text must stay before the 160ms tail; got {}",
        draft.combined_text
    );

    let resumed_prefix = resumed_prefix.clone();
    asr_handle.complete_request_with_text(&resumed_prefix, "全体。");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed prefix must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加") && draft.combined_text.contains("続き"),
        "resumed prefix must keep max-chunk and 160ms text; got {}",
        draft.combined_text
    );
    let overall_pos = draft.combined_text.find("全体").expect("prefix text");
    let extra_pos = draft.combined_text.find("追加").expect("max-chunk text");
    let cont_pos = draft.combined_text.find("続き").expect("160ms text");
    assert!(
        overall_pos < extra_pos && extra_pos < cont_pos,
        "prefix, max-chunk, and 160ms text must stay in audio order; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 50], vec![3.0; 160]].concat(),
        "overlap must not double-count max-chunk samples ahead of the uncovered 160ms tail"
    );
}

#[test]
fn turn_runtime_applied_prefix_max_chunk_yields_to_160ms_keeping_visible_text() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&prefix, "全体。");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("applied prefix must still dispatch same-turn max-chunk");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimChunkReached,
        250..410,
    );
    runtime.step();

    let chunk = runtime.requests.in_flight_request.as_ref().expect(
        "in-flight max-chunk must yield to a later 160ms tail after the prefix already applied",
    );
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "全体。",
        "yielding max-chunk must keep already-visible prefix text"
    );

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed_max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("max-chunk CompletionCheck must resume after the 160ms tail");
    assert_eq!(resumed_max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "160ms tail must not drop visible prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "160ms tail must append the continuation; got {}",
        draft.combined_text
    );

    let resumed_max_chunk = resumed_max_chunk.clone();
    asr_handle.complete_request_with_text(&resumed_max_chunk, "追加");
    runtime.step();

    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "resumed max-chunk must keep prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "resumed max-chunk must keep tail text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "resumed max-chunk must keep the 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100], vec![3.0; 160]].concat(),
        "resumed max-chunk must keep prefix, parked max-chunk, and 160ms audio"
    );
}

#[test]
fn turn_runtime_same_display_id_160ms_keeps_visible_prefix() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&prefix, "全体。");
    runtime.step();
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");

    // Production max-chunk closes the same display segment the stream started
    // with, then continuation 160ms reuses that display_segment_id. Distinct
    // samples keep prefix/max-chunk/tail from aliasing as one waveform.
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        segment.audio = vec![2.0; 100];
        segment.source_audio = vec![2.0; 100];
    }
    runtime.step();
    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("applied prefix must still dispatch same-turn max-chunk");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        250..410,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        segment.audio = vec![3.0; 160];
        segment.source_audio = vec![3.0; 160];
    }
    runtime.step();

    let chunk = runtime.requests.in_flight_request.as_ref().expect(
        "in-flight max-chunk must yield to a later 160ms that reuses the display segment id",
    );
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "全体。",
        "yielding max-chunk must keep already-visible prefix text"
    );

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed_max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("max-chunk CompletionCheck must resume after the 160ms tail");
    assert_eq!(resumed_max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "same-display-id 160ms must not drop visible prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "same-display-id 160ms must keep the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100], vec![3.0; 160]].concat(),
        "same-display-id 160ms must keep prefix, parked max-chunk, and uncovered tail audio"
    );
}

#[test]
fn turn_runtime_cumulative_160ms_does_not_restack_prefix_audio() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&prefix, "全体。");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        segment.audio = vec![2.0; 100];
        segment.source_audio = vec![2.0; 100];
    }
    runtime.step();
    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("applied prefix must still dispatch same-turn max-chunk");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        0..410,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        // Production Nemotron chunk: cumulative source from stream start, delta audio.
        segment.source_audio = [vec![9.0; 250], vec![3.0; 160]].concat();
        segment.audio = vec![3.0; 160];
    }
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight max-chunk must yield to the later cumulative 160ms");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "cumulative 160ms must not drop visible prefix text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "cumulative 160ms must keep the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100], vec![3.0; 160]].concat(),
        "cumulative 160ms must append only the uncovered delta, not restack the stream prefix"
    );
    assert!(
        !draft.full_audio.contains(&9.0),
        "already-visible prefix audio must not be restacked from cumulative source"
    );
}

#[test]
fn turn_runtime_cumulative_160ms_range_does_not_drop_uncovered_completion_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&prefix, "全体。");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        0..410,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        segment.source_audio = [vec![9.0; 250], vec![3.0; 160]].concat();
        segment.audio = vec![3.0; 160];
    }
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("cumulative 160ms must dispatch after the visible prefix");
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();
    let draft =
        runtime.turn_store.turns.get(&1).expect("turn 1 must keep the prefix plus delta").draft();
    assert!(
        draft.combined_text.contains("全体") && draft.combined_text.contains("続き"),
        "160ms apply must keep visible prefix plus delta before the hole completion; got {}",
        draft.combined_text
    );

    let mut completion = interim_request_for_turn(3, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.audio = vec![2.0; 100];
    completion.source_audio = vec![2.0; 100];
    completion.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "inflated 160ms coverage must not drop the visible prefix; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "inflated 160ms coverage must keep the continuation; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "a completion tail in the hole before the 160ms delta must be kept; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![3.0; 160], vec![2.0; 100]].concat(),
        "uncovered completion audio in the hole must be kept instead of looking range-covered"
    );
    assert!(
        !draft.full_audio.contains(&9.0),
        "already-visible prefix audio must not be restacked from cumulative source"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers gapped 160ms restack plus keeping the uncovered hole"
)]
fn turn_runtime_gapped_160ms_delta_is_not_restacked_by_same_display_completion() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&prefix, "全体。");
    runtime.step();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimChunkReached,
        0..410,
    );
    if let Some(segment) = runtime.pending.asr_segments.back_mut() {
        segment.source_audio = [vec![9.0; 250], vec![3.0; 160]].concat();
        segment.audio = vec![3.0; 160];
    }
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("cumulative 160ms must dispatch after the visible prefix");
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let mut completion = interim_request_for_turn(3, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(410)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    completion.audio = [vec![9.0; 250], vec![3.0; 160]].concat();
    completion.source_audio = [vec![9.0; 250], vec![3.0; 160]].concat();
    completion.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "続き");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "same-display completion of the 160ms delta must keep the visible prefix; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "same-display completion of the 160ms delta must keep the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![3.0; 160]].concat(),
        "already-present 160ms delta audio must not be restacked by a same-display CompletionCheck"
    );
    assert!(
        !draft.full_audio.contains(&9.0),
        "already-visible prefix audio must not be restacked from cumulative source"
    );

    let mut hole = interim_request_for_turn(4, 1);
    hole.kind = AsrTaskKind::CompletionCheck;
    hole.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    hole.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    hole.audio = vec![2.0; 100];
    hole.source_audio = vec![2.0; 100];
    hole.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(hole.clone());
    asr_handle.complete_request_with_text(&hole, "追加");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("追加"),
        "uncovered hole completion must still be kept after recording the delta window; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![3.0; 160], vec![2.0; 100]].concat(),
        "recording the 160ms delta must not treat the hole as covered"
    );
}

#[test]
fn turn_runtime_in_flight_max_chunk_does_not_yield_to_after_interim_silence() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let _asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();
    let max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("prefix CompletionCheck must yield to same-turn max-chunk");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimResultSilenceReached,
        250..350,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence must not steal in-flight max-chunk CompletionCheck");
    assert_eq!(in_flight.request_id, max_chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert_eq!(
        runtime.requests.deferred_completion[0].close_reason,
        Some(SegmentCloseReason::EndSilenceReached)
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, same-utterance AfterInterimSilence staying on the current caption, prefix, and uncovered tail"
)]
fn turn_runtime_after_interim_silence_stays_after_160ms_without_stealing_grid() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(runtime.pending.asr_segments.front().map(|segment| segment.segment_id), Some(3));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before AfterInterimSilence");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding AfterInterimSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "same-utterance AfterInterimSilence after 160ms must stay on the current caption"
    );
    let mut silence = runtime.requests.in_flight_request.clone().expect(
        "AfterInterimSilence after 160ms must dispatch on the current turn",
    );
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "全体。");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );

    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| {
            output.turn_id == 1
                && output.text.contains("全体")
                && output.text.contains("続き")
                && output.text.contains("後半")
        }),
        "same-utterance AfterInterimSilence must emit on the current caption; got {:?}",
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160], vec![3.0; 100]].concat(),
        "current turn must keep prefix, uncovered 160ms tail, and AfterInterimSilence audio"
    );
}

#[test]
fn turn_runtime_namo_grammar_does_not_close_lead_before_same_utterance_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: true, confidence: 0.99 }]);
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before grammar");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "Namo grammar must not finalize the lead before the same-utterance tail applies"
    );
    let silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("same-utterance AfterInterimSilence must take the slot instead of grammar closing the lead");
    assert_eq!(
        silence.kind,
        AsrTaskKind::InterimDisplay,
        "Namo grammar must not occupy the slot before the same-utterance tail applies"
    );
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.target.turn_id, TurnId(1));

    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| {
            output.turn_id == 1
                && output.text.contains("全体")
                && output.text.contains("続き")
                && output.text.contains("後半")
        }),
        "same-utterance tail must emit on the current caption before Namo can close the lead; got {:?}",
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, grammar yield to same-utterance AfterInterimSilence, prefix, and uncovered tail"
)]
fn turn_runtime_in_flight_namo_grammar_yields_to_same_utterance_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: true, confidence: 0.99 }]);
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();
    let resumed = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("deferred prefix CompletionCheck must resume before grammar");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    let grammar = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("Namo must start grammar when AfterInterimSilence is not queued yet");
    assert_eq!(grammar.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        runtime.requests.pending_rerecognition_purpose,
        Some(RerecognitionPurpose::GrammarAfterCompletion)
    );
    assert_ne!(
        grammar.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "grammar must start only after the 160ms grid has applied"
    );

    runtime
        .turn_store
        .turns
        .get_mut(&1)
        .expect("turn 1 draft must still be open")
        .draft_mut()
        .boundary_candidates =
        vec![boundary_candidate("全体。続き", 310, 310, 310, GrammarBoundaryClass::NormalEnd)];

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime.step();

    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "in-flight grammar must not finalize the lead before the same-utterance tail applies"
    );
    let silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("same-utterance AfterInterimSilence must take the slot from in-flight grammar");
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.target.turn_id, TurnId(1));
    assert_ne!(silence.request_id, grammar.request_id);
    assert_ne!(
        silence.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "yielding grammar must not steal an in-flight 160ms grid"
    );

    asr_handle.complete_request_with_text(&grammar, "全体。");
    runtime.step();
    let silence_after_late_grammar = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("a late grammar result must not steal the same-utterance tail slot");
    assert_eq!(silence_after_late_grammar.request_id, silence.request_id);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| {
            output.turn_id == 1
                && output.text.contains("全体")
                && output.text.contains("続き")
                && output.text.contains("後半")
        }),
        "same-utterance tail must stay on the current caption after in-flight grammar yields; got {:?}",
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, tail apply, then resumed grammar not rewriting the joined caption to the lead"
)]
fn turn_runtime_resumed_namo_grammar_does_not_rewrite_joined_caption_to_lead() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: true, confidence: 0.99 }]);
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime.step();
    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();
    let resumed = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("deferred prefix CompletionCheck must resume before grammar");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    let silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("same-utterance AfterInterimSilence must apply before resumed grammar");
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.target.turn_id, TurnId(1));
    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体")
            && draft.combined_text.contains("続き")
            && draft.combined_text.contains("後半"),
        "joined caption must include the tail before resumed grammar; got {}",
        draft.combined_text
    );
    let joined = draft.combined_text.clone();

    let grammar = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("deferred Namo grammar must resume after the same-utterance tail applies");
    assert_eq!(grammar.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        runtime.requests.pending_rerecognition_purpose,
        Some(RerecognitionPurpose::GrammarAfterCompletion)
    );
    assert_ne!(
        grammar.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "resumed grammar must not steal an in-flight 160ms grid"
    );

    asr_handle.complete_request_with_text(&grammar, "全体続き");
    runtime.step();

    if let Some(turn) = runtime.turn_store.turns.get(&1) {
        assert!(
            turn.draft().combined_text.contains("全体")
                && turn.draft().combined_text.contains("続き")
                && turn.draft().combined_text.contains("後半"),
            "resumed grammar must not rewrite the joined caption back to the lead; before={joined} after={}",
            turn.draft().combined_text
        );
    }

    let outputs = outputs.lock().expect("outputs should be readable");
    let last = outputs
        .iter()
        .filter(|output| output.turn_id == 1)
        .next_back()
        .expect("turn 1 must emit a caption");
    assert!(
        last.text.contains("全体") && last.text.contains("続き") && last.text.contains("後半"),
        "resumed grammar must not rewrite the latest caption back to the lead; joined before grammar was {joined}; latest={} is_final={} all={:?}",
        last.text,
        last.is_final,
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, remint of a next-utterance child EndSilence, prefix, and uncovered tail"
)]
fn turn_runtime_end_silence_child_remints_after_160ms_without_stealing_grid() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("child EndSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(runtime.pending.asr_segments.front().map(|segment| segment.segment_id), Some(3));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding child EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "child EndSilence after the 160ms grid must remint instead of continuing turn 1"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the child EndSilence must remint onto a new turn after the 160ms grid",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn as a continuation"
    );
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must keep uncovered 160ms tail audio"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, same-utterance root AfterInterimSilence staying on the current caption, prefix, and uncovered tail"
)]
fn turn_runtime_after_interim_silence_root_stays_after_160ms_without_stealing_grid() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);

    // Stream reset after the 160ms grid: AfterInterimSilence restarts as a new
    // root (previous=None, new display id) instead of naming the 160ms segment.
    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("AfterInterimSilence root must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(runtime.pending.asr_segments.front().map(|segment| segment.segment_id), Some(3));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before AfterInterimSilence");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding AfterInterimSilence root must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "same-utterance AfterInterimSilence after 160ms must stay on the current caption"
    );
    let mut silence = runtime.requests.in_flight_request.clone().expect(
        "AfterInterimSilence root after 160ms must dispatch on the current turn",
    );
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "全体。");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );

    asr_handle.complete_request_with_text(&silence, "後半");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| {
            output.turn_id == 1
                && output.text.contains("全体")
                && output.text.contains("続き")
                && output.text.contains("後半")
        }),
        "same-utterance AfterInterimSilence must emit on the current caption; got {:?}",
        outputs.iter().map(|output| (output.turn_id, output.text.as_str(), output.is_final)).collect::<Vec<_>>()
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160], vec![3.0; 100]].concat(),
        "current turn must keep prefix, uncovered 160ms tail, and AfterInterimSilence audio"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, next-utterance 160ms isolation, prefix, and uncovered tail"
)]
fn turn_runtime_later_160ms_after_interim_silence_does_not_attach_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance 160ms must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "next-utterance 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "AfterInterimSilence after the 160ms grid must remint even with a later 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "later 160ms must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason)
        }),
        Some((4, SegmentCloseReason::InterimChunkReached)),
        "later 160ms must stay queued for the next utterance"
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, child next-utterance 160ms isolation, prefix, and uncovered tail"
)]
fn turn_runtime_later_child_160ms_after_interim_silence_does_not_attach_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(2),
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later child 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding child next-utterance 160ms must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "child next-utterance 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "AfterInterimSilence after the 160ms grid must remint even with a later child 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "later child 160ms must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimChunkReached, Some(2))),
        "later child 160ms must stay queued for the next utterance"
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later child 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, next-utterance silence naming prefix, later tail isolation, prefix, and uncovered tail"
)]
fn turn_runtime_silence_naming_prefix_after_160ms_does_not_attach_tail_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance silence that names prefix must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "next-utterance silence that names prefix must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "AfterInterimSilence that names prefix after the 160ms grid must remint even with a later tail queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching the later tail to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "later 160ms must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimChunkReached, Some(1))),
        "later 160ms that names prefix must stay queued for the next utterance"
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, EndSilence naming prefix, reminted root max-chunk staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_end_silence_naming_prefix_after_160ms_does_not_attach_tail_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(1),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence that names prefix must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "next-utterance EndSilence that names prefix must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence that names prefix after the 160ms grid must remint even with a later max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching the later tail to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::SegmentMaxChunksReached),
        "later max-chunk must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::SegmentMaxChunksReached, None)),
        "later root max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued root max-chunk must dispatch for the next utterance after remint");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_ne!(
        max_chunk.target.turn_id,
        TurnId(1),
        "queued root max-chunk must not return to the previous caption"
    );
    assert_eq!(
        max_chunk.target.turn_id,
        next_turn_id,
        "queued root max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted max-chunk text; got {}",
        final_output.text
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, following root 160ms staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_root_160ms_after_reminted_end_silence_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later root 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later root 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with a later root 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "later root 160ms must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimChunkReached, None)),
        "later root 160ms must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued root 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_ne!(
        later_chunk.target.turn_id,
        TurnId(1),
        "queued root 160ms must not return to the previous caption"
    );
    assert_eq!(
        later_chunk.target.turn_id,
        next_turn_id,
        "queued root 160ms must stay on the reminted next utterance instead of opening a third turn"
    );

    let later_chunk = later_chunk.clone();
    asr_handle.complete_request_with_text(&later_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later 160ms tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted 160ms text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following root 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted 160ms, following root 160ms staying on the next utterance without 160ms-to-160ms yield, prefix, and uncovered tail"
)]
fn turn_runtime_root_160ms_after_reminted_160ms_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        None,
        SegmentCloseReason::InterimChunkReached,
        570..730,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later reminted 160ms and following root 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later reminted 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later root 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::InterimChunkReached, None),
            (5, SegmentCloseReason::InterimChunkReached, None),
        ],
        "reminted 160ms and following root 160ms must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued reminted 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        later_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570)),
        "following root 160ms must not fold into the reminted 160ms grid"
    );
    assert_eq!(later_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimChunkReached, None)),
        "following root 160ms must stay queued after reminted 160ms dispatches"
    );

    let later_chunk = later_chunk.clone();
    runtime.step();
    let still_in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("following root 160ms must not yield the in-flight reminted 160ms");
    assert_eq!(
        still_in_flight.request_id,
        later_chunk.request_id,
        "do not add 160ms-to-160ms yield after remint"
    );
    assert_eq!(
        still_in_flight.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570))
    );

    asr_handle.complete_request_with_text(&later_chunk, "追加した");
    runtime.step();

    let mut following_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued following root 160ms must dispatch after reminted 160ms");
    if following_chunk.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&following_chunk, "追加した");
        runtime.step();
        following_chunk = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("following root 160ms must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(following_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(following_chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(
        following_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(570), GlobalSampleIndex(730)),
        "following root 160ms must keep the 160ms grid instead of folding into the reminted chunk"
    );
    assert_ne!(following_chunk.target.turn_id, TurnId(1));
    assert_eq!(
        following_chunk.target.turn_id,
        next_turn_id,
        "queued following root 160ms must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&following_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's reminted or following 160ms tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the following reminted 160ms text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following root 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted 160ms, following child 160ms staying on the next utterance without 160ms-to-160ms yield, prefix, and uncovered tail"
)]
fn turn_runtime_child_160ms_after_reminted_160ms_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::InterimChunkReached,
        570..730,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later reminted 160ms and following child 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later reminted 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later child 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::InterimChunkReached, None),
            (5, SegmentCloseReason::InterimChunkReached, Some(4)),
        ],
        "reminted 160ms and following child 160ms must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued reminted 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        later_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570)),
        "following child 160ms must not fold into the reminted 160ms grid"
    );
    assert_eq!(later_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimChunkReached, Some(4))),
        "following child 160ms must stay queued after reminted 160ms dispatches"
    );

    let later_chunk = later_chunk.clone();
    runtime.step();
    let still_in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("following child 160ms must not yield the in-flight reminted 160ms");
    assert_eq!(
        still_in_flight.request_id,
        later_chunk.request_id,
        "do not add 160ms-to-160ms yield after remint"
    );
    assert_eq!(
        still_in_flight.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570))
    );

    asr_handle.complete_request_with_text(&later_chunk, "追加した");
    runtime.step();

    let mut following_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued following child 160ms must dispatch after reminted 160ms");
    if following_chunk.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&following_chunk, "追加した");
        runtime.step();
        following_chunk = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("following child 160ms must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(following_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(following_chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(
        following_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(570), GlobalSampleIndex(730)),
        "following child 160ms must keep the 160ms grid instead of folding into the reminted chunk"
    );
    assert_ne!(following_chunk.target.turn_id, TurnId(1));
    assert_eq!(
        following_chunk.target.turn_id,
        next_turn_id,
        "queued following child 160ms must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&following_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's reminted or following child 160ms tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the following reminted child 160ms text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted 160ms, following root max-chunk staying on the next utterance without 160ms-to-160ms yield, prefix, and uncovered tail"
)]
fn turn_runtime_root_max_chunk_after_reminted_160ms_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        570..670,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later reminted 160ms and following root max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later reminted 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later root max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::InterimChunkReached, None),
            (5, SegmentCloseReason::SegmentMaxChunksReached, None),
        ],
        "reminted 160ms and following root max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued reminted 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        later_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570)),
        "following root max-chunk must not fold into the reminted 160ms grid"
    );
    assert_eq!(later_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::SegmentMaxChunksReached, None)),
        "following root max-chunk must stay queued after reminted 160ms dispatches"
    );

    let later_chunk = later_chunk.clone();
    runtime.step();
    let still_in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("following root max-chunk must not yield the in-flight reminted 160ms");
    assert_eq!(
        still_in_flight.request_id,
        later_chunk.request_id,
        "do not add 160ms-to-160ms yield after remint"
    );
    assert_eq!(
        still_in_flight.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570))
    );

    asr_handle.complete_request_with_text(&later_chunk, "追加した");
    runtime.step();

    let mut max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued following root max-chunk must dispatch after reminted 160ms");
    if max_chunk.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&max_chunk, "追加した");
        runtime.step();
        max_chunk = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("following root max-chunk must dispatch as CompletionCheck after grammar");
    }
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(max_chunk.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(
        max_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(570), GlobalSampleIndex(670)),
        "following root max-chunk must keep its own range instead of folding into the reminted 160ms"
    );
    assert_ne!(max_chunk.target.turn_id, TurnId(1));
    assert_eq!(
        max_chunk.target.turn_id,
        next_turn_id,
        "queued following root max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&max_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's reminted 160ms or following root max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the following reminted root max-chunk text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following root max-chunk tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, following child 160ms staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_160ms_after_reminted_end_silence_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(3),
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later child 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later child 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with a later child 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimChunkReached),
        "later child 160ms must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimChunkReached, Some(3))),
        "later child 160ms must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued child 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_ne!(
        later_chunk.target.turn_id,
        TurnId(1),
        "queued child 160ms must not return to the previous caption"
    );
    assert_eq!(
        later_chunk.target.turn_id,
        next_turn_id,
        "queued child 160ms must stay on the reminted next utterance instead of opening a third turn"
    );

    let later_chunk = later_chunk.clone();
    asr_handle.complete_request_with_text(&later_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later child 160ms tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted child 160ms text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, following child max-chunk staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_max_chunk_after_reminted_end_silence_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(3),
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later child max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later child max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with a later child max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::SegmentMaxChunksReached),
        "later child max-chunk must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::SegmentMaxChunksReached, Some(3))),
        "later child max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let mut max_chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child max-chunk must dispatch for the next utterance after remint");
    if max_chunk.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&max_chunk, "追加");
        runtime.step();
        max_chunk = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child max-chunk must dispatch as CompletionCheck after grammar");
    }
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_ne!(
        max_chunk.target.turn_id,
        TurnId(1),
        "queued child max-chunk must not return to the previous caption"
    );
    assert_eq!(
        max_chunk.target.turn_id,
        next_turn_id,
        "queued child max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&max_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later child max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted child max-chunk text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child max-chunk tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, following child 160ms after reminted max-chunk, prefix, and uncovered tail"
)]
fn turn_runtime_child_160ms_after_reminted_max_chunk_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::InterimChunkReached,
        510..670,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later child 160ms must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later child 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later max-chunk and child 160ms queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::SegmentMaxChunksReached, None),
            (5, SegmentCloseReason::InterimChunkReached, Some(4)),
        ],
        "root max-chunk and child 160ms must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued max-chunk or child 160ms must dispatch for the next utterance after remint");
    assert_eq!(later.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(later.target.turn_id, next_turn_id);
    asr_handle.complete_request_with_text(&later, "追加した");
    runtime.step();
    let mut later = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child 160ms must dispatch after reminted max-chunk");
    if later.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&later, "追加した");
        runtime.step();
        later = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child 160ms must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(later.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_ne!(later.target.turn_id, TurnId(1));
    assert_eq!(
        later.target.turn_id,
        next_turn_id,
        "queued child 160ms must stay on the reminted next utterance instead of opening a third turn"
    );
    assert_eq!(
        later.target.range,
        AudioRange::new(GlobalSampleIndex(510), GlobalSampleIndex(670))
    );

    asr_handle.complete_request_with_text(&later, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's max-chunk or child 160ms tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted child 160ms text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child 160ms tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted root max-chunk, following child max-chunk staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_max_chunk_after_reminted_root_max_chunk_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::SegmentMaxChunksReached,
        510..610,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later child max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later child max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later root and child max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::SegmentMaxChunksReached, None),
            (5, SegmentCloseReason::SegmentMaxChunksReached, Some(4)),
        ],
        "root max-chunk and child max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued root max-chunk must dispatch for the next utterance after remint");
    assert_eq!(later.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(
        later.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(510)),
        "child max-chunk must not fold into the reminted root max-chunk CompletionCheck"
    );
    assert_eq!(later.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::SegmentMaxChunksReached, Some(4))),
        "child max-chunk must stay queued after root max-chunk dispatches"
    );

    asr_handle.complete_request_with_text(&later, "追加した");
    runtime.step();
    let mut later = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child max-chunk must dispatch after reminted root max-chunk");
    if later.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&later, "追加した");
        runtime.step();
        later = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child max-chunk must dispatch as CompletionCheck after grammar");
    }
    assert_eq!(later.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_ne!(later.target.turn_id, TurnId(1));
    assert_eq!(
        later.target.turn_id,
        next_turn_id,
        "queued child max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );
    assert_eq!(
        later.target.range,
        AudioRange::new(GlobalSampleIndex(510), GlobalSampleIndex(610))
    );

    asr_handle.complete_request_with_text(&later, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's root or child max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted child max-chunk text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child max-chunk tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, following AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_after_interim_silence_after_reminted_end_silence_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later AfterInterimSilence must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later AfterInterimSilence queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching AfterInterimSilence to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::InterimResultSilenceReached),
        "later AfterInterimSilence must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimResultSilenceReached, None)),
        "later AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let silence = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued AfterInterimSilence must dispatch for the next utterance after remint");
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_ne!(
        silence.target.turn_id,
        TurnId(1),
        "queued AfterInterimSilence must not return to the previous caption"
    );
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    let silence = silence.clone();
    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted 160ms, following AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_after_interim_silence_after_reminted_160ms_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        570..670,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later reminted 160ms and AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later reminted 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later 160ms and AfterInterimSilence queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::InterimChunkReached, None),
            (5, SegmentCloseReason::InterimResultSilenceReached, None),
        ],
        "reminted 160ms and AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued reminted 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        later_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570)),
        "AfterInterimSilence must not fold into the reminted 160ms grid"
    );
    assert_eq!(later_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimResultSilenceReached, None)),
        "AfterInterimSilence must stay queued after reminted 160ms dispatches"
    );

    let later_chunk = later_chunk.clone();
    asr_handle.complete_request_with_text(&later_chunk, "追加した");
    runtime.step();

    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued AfterInterimSilence must dispatch after reminted 160ms");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "追加した");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_ne!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's reminted 160ms or AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, reminted 160ms, following child AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_after_interim_silence_after_reminted_160ms_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::InterimChunkReached,
        410..570,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::InterimResultSilenceReached,
        570..670,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later reminted 160ms and child AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later reminted 160ms must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later 160ms and child AfterInterimSilence queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching later 160ms to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::InterimChunkReached, None),
            (5, SegmentCloseReason::InterimResultSilenceReached, Some(4)),
        ],
        "reminted 160ms and child AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let later_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued reminted 160ms must dispatch for the next utterance after remint");
    assert_eq!(later_chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        later_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(570)),
        "child AfterInterimSilence must not fold into the reminted 160ms grid"
    );
    assert_eq!(later_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimResultSilenceReached, Some(4))),
        "child AfterInterimSilence must stay queued after reminted 160ms dispatches"
    );

    let later_chunk = later_chunk.clone();
    asr_handle.complete_request_with_text(&later_chunk, "追加した");
    runtime.step();

    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child AfterInterimSilence must dispatch after reminted 160ms");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "追加した");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_ne!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued child AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's reminted 160ms or child AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted child AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, child AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_after_interim_silence_after_reminted_end_silence_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(3),
        SegmentCloseReason::InterimResultSilenceReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("child AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "child AfterInterimSilence must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with child AfterInterimSilence queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching AfterInterimSilence to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410)),
        "child AfterInterimSilence must not fold into the reminted EndSilence CompletionCheck"
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::InterimResultSilenceReached, Some(3))),
        "child AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child AfterInterimSilence must dispatch for the next utterance after remint");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "追加");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_ne!(
        silence.target.turn_id,
        TurnId(1),
        "queued child AfterInterimSilence must not return to the previous caption"
    );
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued child AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's child AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, child max-chunk, following AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_child_after_interim_silence_after_reminted_max_chunk_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(3),
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::InterimResultSilenceReached,
        510..610,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later max-chunk and AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::SegmentMaxChunksReached, Some(3)),
            (5, SegmentCloseReason::InterimResultSilenceReached, Some(4)),
        ],
        "child max-chunk and AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued child max-chunk must dispatch for the next utterance after remint");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(
        max_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(510)),
        "child AfterInterimSilence must not fold into the reminted max-chunk CompletionCheck"
    );
    assert_eq!(max_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimResultSilenceReached, Some(4))),
        "child AfterInterimSilence must stay queued after max-chunk dispatches"
    );

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "追加");
    runtime.step();

    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child AfterInterimSilence must dispatch for the next utterance");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "追加");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_ne!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued child AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's max-chunk or AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, reminted EndSilence, root max-chunk, following AfterInterimSilence staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_after_interim_silence_after_reminted_root_max_chunk_stays_on_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime_state(&mut runtime).pending_segment(
        5,
        Some(4),
        SegmentCloseReason::InterimResultSilenceReached,
        510..610,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later root max-chunk and AfterInterimSilence must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance EndSilence must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "later root max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence after the 160ms grid must remint even with later root max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }).collect::<Vec<_>>(),
        vec![
            (4, SegmentCloseReason::SegmentMaxChunksReached, None),
            (5, SegmentCloseReason::InterimResultSilenceReached, Some(4)),
        ],
        "root max-chunk and AfterInterimSilence must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let end_silence = dispatched.clone();
    asr_handle.complete_request_with_text(&end_silence, "追加");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued root max-chunk must dispatch for the next utterance after remint");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(
        max_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(410), GlobalSampleIndex(510)),
        "child AfterInterimSilence must not fold into the reminted root max-chunk CompletionCheck"
    );
    assert_eq!(max_chunk.target.turn_id, next_turn_id);
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((5, SegmentCloseReason::InterimResultSilenceReached, Some(4))),
        "child AfterInterimSilence must stay queued after root max-chunk dispatches"
    );

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "追加");
    runtime.step();

    let mut silence = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued child AfterInterimSilence must dispatch for the next utterance");
    if silence.kind == AsrTaskKind::Rerecognition {
        asr_handle.complete_request_with_text(&silence, "追加");
        runtime.step();
        silence = runtime
            .requests
            .in_flight_request
            .clone()
            .expect("child AfterInterimSilence must dispatch as InterimDisplay after grammar");
    }
    assert_eq!(silence.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(silence.kind, AsrTaskKind::InterimDisplay);
    assert_ne!(silence.target.turn_id, TurnId(1));
    assert_eq!(
        silence.target.turn_id,
        next_turn_id,
        "queued child AfterInterimSilence must stay on the reminted next utterance instead of opening a third turn"
    );

    asr_handle.complete_request_with_text(&silence, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's max-chunk or AfterInterimSilence tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted AfterInterimSilence text; got {}",
        final_output.text
    );
    let next_turn = next_turn_id.0;
    assert!(
        outputs.iter().any(|output| output.turn_id == next_turn && output.text.contains("もっと")),
        "next utterance must keep the following child AfterInterimSilence tail"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, remint isolation, queued max-chunk staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_later_max_chunk_after_interim_silence_does_not_attach_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        Some(2),
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        Some(2),
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance max-chunk must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "next-utterance max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "AfterInterimSilence after the 160ms grid must remint even with a later max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::SegmentMaxChunksReached),
        "later max-chunk must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::SegmentMaxChunksReached, Some(2))),
        "later max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let silence = dispatched.clone();
    asr_handle.complete_request_with_text(&silence, "追加");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued max-chunk must dispatch for the next utterance after remint");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_ne!(
        max_chunk.target.turn_id,
        TurnId(1),
        "queued max-chunk that still names applied 160ms must not return to the previous caption"
    );
    assert_eq!(
        max_chunk.target.turn_id,
        next_turn_id,
        "queued max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted max-chunk text; got {}",
        final_output.text
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, remint isolation, root max-chunk staying on the next utterance, prefix, and uncovered tail"
)]
fn turn_runtime_later_root_max_chunk_after_interim_silence_does_not_attach_to_previous_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);

    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        310..410,
    );
    runtime_state(&mut runtime).pending_segment(
        4,
        None,
        SegmentCloseReason::SegmentMaxChunksReached,
        410..510,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("later root max-chunk must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        runtime.pending.asr_segments.iter().map(|segment| segment.segment_id).collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding next-utterance root max-chunk must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        vec![2.0; 160],
        "next-utterance root max-chunk must not attach while prefix CompletionCheck resumes"
    );

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "AfterInterimSilence after the 160ms grid must remint even with a later root max-chunk queued"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the next utterance must dispatch after remint instead of attaching root max-chunk to turn 1",
    );
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not attach to the previous turn"
    );
    assert_ne!(
        dispatched.close_reason,
        Some(SegmentCloseReason::SegmentMaxChunksReached),
        "later root max-chunk must not take the previous turn's slot as a continuation tail"
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimResultSilenceReached));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );
    assert_eq!(
        runtime.pending.asr_segments.front().map(|segment| {
            (segment.segment_id, segment.reason, segment.previous_segment_id)
        }),
        Some((4, SegmentCloseReason::SegmentMaxChunksReached, None)),
        "later root max-chunk must stay queued for the next utterance"
    );

    let next_turn_id = dispatched.target.turn_id;
    let silence = dispatched.clone();
    asr_handle.complete_request_with_text(&silence, "追加");
    runtime.step();

    let max_chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("queued root max-chunk must dispatch for the next utterance after remint");
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_ne!(
        max_chunk.target.turn_id,
        TurnId(1),
        "queued root max-chunk must not return to the previous caption"
    );
    assert_eq!(
        max_chunk.target.turn_id,
        next_turn_id,
        "queued root max-chunk must stay on the reminted next utterance instead of opening a third turn"
    );

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "もっと");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must not keep the next utterance's later root max-chunk tail"
    );
    assert!(
        !final_output.text.contains("もっと"),
        "previous caption must not absorb the reminted root max-chunk text; got {}",
        final_output.text
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "invariant covers in-flight 160ms hold, remint of a stream-reset EndSilence root, prefix, and uncovered tail"
)]
fn turn_runtime_end_silence_root_remints_after_160ms_without_stealing_grid() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let prefix = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");

    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("in-flight prefix must yield to the same-turn 160ms tail");
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert_ne!(chunk.request_id, prefix.request_id);
    assert_eq!(runtime.requests.deferred_completion.len(), 1);

    // Stream reset after the 160ms grid: next-utterance EndSilence restarts as
    // a new root (previous=None, new display id) instead of naming the 160ms.
    runtime_state(&mut runtime).pending_segment(
        3,
        None,
        SegmentCloseReason::EndSilenceReached,
        310..410,
    );
    runtime.step();

    let in_flight = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("EndSilence root must not steal in-flight 160ms");
    assert_eq!(in_flight.request_id, chunk.request_id);
    assert_eq!(in_flight.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
    assert_eq!(runtime.pending.asr_segments.front().map(|segment| segment.segment_id), Some(3));
    assert_eq!(runtime.requests.deferred_completion.len(), 1);
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let resumed = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("deferred prefix CompletionCheck must resume before remint");
    assert_eq!(resumed.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(resumed.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("続き"),
        "holding EndSilence root must keep the uncovered 160ms tail; got {}",
        draft.combined_text
    );
    assert_eq!(draft.full_audio, vec![2.0; 160]);

    let resumed = resumed.clone();
    asr_handle.complete_request_with_text(&resumed, "全体。");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "EndSilence root after the 160ms grid must remint instead of continuing turn 1"
    );
    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "the EndSilence root must remint onto a new turn after the 160ms grid",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::EndSilenceReached));
    assert_ne!(
        dispatched.target.turn_id,
        TurnId(1),
        "the next utterance must not be absorbed into the open turn as a continuation"
    );
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(410))
    );

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must emit a final caption");
    assert!(
        final_output.text.contains("全体"),
        "previous turn must keep prefix completion; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "previous turn must keep the uncovered 160ms tail; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "previous turn must keep uncovered 160ms tail audio"
    );
}

#[test]
fn turn_runtime_closing_interim_chunk_takes_rerecognition_slot_on_same_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "a closing streaming chunk must take the slot instead of waiting on grammar rerecognition",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert_eq!(
        dispatched.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(310))
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert!(runtime.pending.asr_segments.is_empty());
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");
    assert_eq!(draft.full_audio, vec![1.0; 150]);

    let chunk = dispatched.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "closing 160ms tail must restart grammar rerecognition instead of waiting on timeout"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1))
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "closing 160ms tail must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "closing 160ms tail must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "closing 160ms tail must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_closing_root_160ms_stays_on_same_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let dispatched =
        runtime.requests.in_flight_request.as_ref().expect(
            "a closing root 160ms must take the slot on the same turn instead of reminting",
        );
    assert_eq!(dispatched.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(dispatched.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");
    assert_eq!(draft.full_audio, vec![1.0; 150]);

    let chunk = dispatched.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "closing root 160ms must restart grammar rerecognition on the same turn"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1))
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "closing root 160ms must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "closing root 160ms must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "closing root 160ms must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_closing_interim_chunk_rerecognition_final_keeps_visible_text_and_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: true, confidence: 0.99 }]);
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();
    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("closing streaming chunk must take the slot");
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();
    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("grammar rerecognition must restart after the closing 160ms tail");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    asr_handle.complete_request_with_text(&rerecognition, "全体。続き");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "restarted grammar rerecognition must be able to finalize instead of waiting on timeout"
    );
    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert!(
        final_output.text.contains("全体"),
        "final must not drop already-visible text; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "final must keep the 160ms tail text; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "final must keep uncovered tail audio from the closing 160ms chunk"
    );
}

#[test]
fn turn_runtime_closing_queued_interim_chunks_drain_before_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimChunkReached, 150..310)
        .pending_segment(3, Some(2), SegmentCloseReason::InterimChunkReached, 310..470);
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let tail = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("queued 160ms chunks must take the slot before grammar rerecognition");
    assert_eq!(tail.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(tail.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(tail.target.turn_id, TurnId(1));
    assert_eq!(
        tail.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(310)),
        "the first 160ms grid must dispatch alone instead of absorbing the later chunk"
    );
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "the later 160ms grid must stay queued until the first chunk finishes"
    );
    assert_eq!(runtime.pending.asr_segments.front().map(|segment| segment.segment_id), Some(3));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&tail, "続き");
    runtime.step();

    let second = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("the later 160ms grid must take the slot before grammar rerecognition");
    assert_eq!(second.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(second.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(
        second.target.range,
        AudioRange::new(GlobalSampleIndex(310), GlobalSampleIndex(470)),
        "the later 160ms grid must run as its own request"
    );
    assert!(runtime.pending.asr_segments.is_empty());
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "draining 160ms grids must keep the visible prefix; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "the first 160ms chunk must keep its continuation; got {}",
        draft.combined_text
    );

    asr_handle.complete_request_with_text(&second, "尾");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "grammar rerecognition must restart only after queued 160ms tail ASR has drained"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1))
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "drained 160ms grids must keep the visible prefix; got {}",
        draft.combined_text
    );
}

#[test]
fn turn_runtime_closing_in_flight_rerecognition_yields_to_later_interim_chunk_then_restarts() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();
    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("without a queued continuation, Namo still starts grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("in-flight closing rerecognition must yield the slot to same-turn 160ms ASR");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "全体。",
        "a late grammar rerecognition result must not drop already-visible text"
    );

    let chunk = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("the 160ms chunk must stay in flight after a mismatched late result");
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "grammar rerecognition must restart after the late-yielded 160ms tail"
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "restarted closing rerecognition must not drop visible text; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "restarted closing rerecognition must keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_mid_clause_max_chunk_dispatches_same_turn_then_restarts_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: false, confidence: 0.01 }]);
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "しようとしたら");
    runtime.step();

    let max_chunk =
        runtime.requests.in_flight_request.as_ref().expect(
            "a Continue-possible mid-clause must still dispatch same-turn max-chunk tail ASR",
        );
    assert_eq!(max_chunk.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(max_chunk.close_reason, Some(SegmentCloseReason::SegmentMaxChunksReached));
    assert_eq!(max_chunk.target.turn_id, TurnId(1));
    assert_eq!(
        max_chunk.target.range,
        AudioRange::new(GlobalSampleIndex(150), GlobalSampleIndex(250))
    );
    assert!(
        !runtime.turn_store.finalized_turns.contains(&1),
        "mid-clause max-chunk must not remint a new turn"
    );
    assert!(!runtime.turn_store.open_turn_is_closing);
    assert!(runtime.pending.asr_segments.is_empty());
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "しようとしたら");
    assert_eq!(draft.full_audio, vec![1.0; 150]);

    let max_chunk = max_chunk.clone();
    asr_handle.complete_request_with_text(&max_chunk, "追加");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "grammar rerecognition must restart after the mid-clause tail so Continue can still run"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1))
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("しようとしたら"),
        "mid-clause tail ASR must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("追加"),
        "mid-clause tail ASR must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 100]].concat(),
        "mid-clause tail ASR must keep uncovered tail audio"
    );

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("restarted grammar rerecognition must be in flight");
    asr_handle.complete_request_with_text(&rerecognition, "しようとしたら追加");
    runtime.step();

    assert_eq!(
        runtime.turn_store.open_turn_id,
        Some(1),
        "Namo Continue after restarted rerecognition must keep the same turn"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("しようとしたら"),
        "Continue must not drop the visible mid-clause; got {}",
        draft.combined_text
    );
}

#[test]
fn turn_runtime_mid_clause_interim_chunk_dispatches_same_turn_then_restarts_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    asr_handle.complete_request_with_text(&completion, "しようとしたら");
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("a Continue-possible mid-clause must still dispatch same-turn 160ms tail ASR");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.close_reason, Some(SegmentCloseReason::InterimChunkReached));
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert!(!runtime.turn_store.open_turn_is_closing);
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "しようとしたら");

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "grammar rerecognition must restart after the 160ms tail so Continue can still run"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1))
    );
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("しようとしたら"),
        "160ms tail ASR must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "160ms tail ASR must append the continuation; got {}",
        draft.combined_text
    );
}

#[test]
fn turn_runtime_mid_clause_in_flight_rerecognition_yields_to_later_max_chunk() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&completion, "しようとしたら");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("without a queued continuation, Namo still starts grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();

    let dispatched = runtime.requests.in_flight_request.as_ref().expect(
        "in-flight mid-clause rerecognition must yield the slot to same-turn max-chunk ASR",
    );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert!(!runtime.turn_store.open_turn_is_closing);

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "しようとしたら",
        "a late grammar rerecognition result must not drop already-visible text"
    );
    assert_eq!(
        draft.full_audio,
        vec![1.0; 150],
        "a late grammar rerecognition result must not drop uncovered tail audio"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1)),
        "a mismatched late rerecognition result must keep the max-chunk request in flight"
    );
}

#[test]
fn turn_runtime_in_flight_rerecognition_yields_to_later_max_chunk_without_dropping_text() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("without a queued continuation, Namo still starts grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);

    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::SegmentMaxChunksReached,
        150..250,
    );
    runtime.step();

    let dispatched =
        runtime.requests.in_flight_request.as_ref().expect(
            "in-flight grammar rerecognition must yield the slot to same-turn max-chunk ASR",
        );
    assert_eq!(dispatched.kind, AsrTaskKind::CompletionCheck);
    assert_eq!(dispatched.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));

    asr_handle.complete_request_with_text(&rerecognition, "短い");
    runtime.step();

    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(
        draft.combined_text, "全体。",
        "a late grammar rerecognition result must not drop already-visible text"
    );
    assert_eq!(
        draft.full_audio,
        vec![1.0; 150],
        "a late grammar rerecognition result must not drop uncovered tail audio"
    );
    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.target.turn_id),
        Some(TurnId(1)),
        "a mismatched late rerecognition result must keep the max-chunk request in flight"
    );
}

#[test]
fn turn_runtime_mid_clause_prequeued_child_does_not_steal_rerecognition_on_same_tick() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        150..250,
    );
    asr_handle.complete_request_with_text(&completion, "しようとしたら");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "same-tick dispatch_next must not remint a Continue-possible mid-clause as a new turn"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    assert_eq!(runtime.pending.asr_segments.len(), 1);
}

#[test]
fn turn_runtime_open_turn_child_continuation_stays_on_same_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .scripted_asr_texts(vec!["続き"]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime)
        .turn(
            1,
            recognized_turn_with_audio(
                1,
                "全体",
                &(0..100).map(|sample| sample as f32).collect::<Vec<_>>(),
            ),
        )
        .turn_audio_range(1, 0..100)
        .open_turn(1)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..180);

    runtime.step();
    runtime.step();

    assert_eq!(
        runtime.turn_store.open_turn_id,
        Some(1),
        "a child while the turn still accepts continuation must stay on the same turn"
    );
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let outputs = outputs.lock().expect("outputs should be readable");
    assert!(
        outputs.iter().any(|output| output.turn_id == 1 && output.text.contains("続き")),
        "same-turn continuation audio must apply to turn 1; got {outputs:?}"
    );
}

#[test]
fn turn_runtime_blank_replace_keeps_visible_text_and_uncovered_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.source_audio = vec![1.0; 320];
    streaming_interim.source_vad_results = vec![vad(true)];
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "今日はいい天気ですね");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = [vec![1.0; 320], vec![2.0; 80]].concat();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(400)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "。");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(
        final_output.text, "今日はいい天気ですね。",
        "blank completion must not wipe the longer visible streaming hypothesis"
    );
    assert!(final_output.is_final);
    assert_eq!(final_output.segment_id, 1);
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 320], vec![2.0; 80]].concat(),
        "replacing the latest segment with blank text must still keep uncovered tail audio"
    );
}

#[test]
fn turn_runtime_rerecognition_does_not_hear_already_covered_completion_audio() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "五月五日はこどもの日です");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..100).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "五月五日はこどもの日です");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("completion must still dispatch full-turn rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    let speech_end = rerecognition
        .audio
        .iter()
        .rposition(|sample| sample.abs() > f32::EPSILON)
        .map_or(0, |index| index + 1);
    assert!(
        speech_end <= interim.source_audio.len(),
        "rerecognition must not concatenate already-covered completion audio; speech_end={speech_end}"
    );

    asr_handle.complete_request_with_text(
        &rerecognition,
        "五月五日はこどもの日です五月五日はこどもの日です",
    );
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "五月五日はこどもの日です。");
    assert!(final_output.is_final);
    assert_eq!(
        final_output.phrase,
        (0..100).map(|sample| sample as f32).collect::<Vec<_>>(),
        "the saved phrase must keep a single copy of the covered utterance"
    );
}

#[test]
fn turn_runtime_overlapping_completion_keeps_uncovered_tail_audio_for_rerecognition() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = (0..100).map(|sample| sample as f32).collect();
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = (0..150).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体追加");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("completion with an uncovered tail must still dispatch rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    asr_handle.complete_request_with_text(&rerecognition, "全体追加");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "全体追加。");
    assert!(final_output.is_final);
    assert_eq!(
        final_output.phrase,
        (0..150).map(|sample| sample as f32).collect::<Vec<_>>(),
        "uncovered completion tail audio must remain in the rerecognition buffer"
    );
}

#[test]
fn turn_runtime_overlapping_completion_skips_unmatched_covered_audio_and_keeps_tail() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = vec![1.0; 100];
    interim.source_vad_results = vec![vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(100)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = [vec![2.0; 100], vec![3.0; 50]].concat();
    completion.audio = completion.source_audio.clone();
    completion.source_vad_results = vec![vad(true), vad(true)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(150)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "全体追加。");
    assert!(final_output.is_final);
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 100], vec![3.0; 50]].concat(),
        "an overlapping completion window must drop already-covered samples even without a waveform prefix match, while keeping the uncovered tail"
    );
}

#[test]
fn turn_runtime_faded_child_completion_keeps_new_speech_despite_range_overlap() {
    const CHUNK: usize = 512;
    const FADE: usize = 160;
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut interim = interim_request_for_turn(1, 1);
    interim.source_audio = vec![1.0; CHUNK * 2];
    interim.audio = interim.source_audio.clone();
    interim.source_vad_results = vec![vad(true), vad(true)];
    interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex((CHUNK * 2) as u64)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let source = [vec![2.0; CHUNK], vec![0.0; CHUNK * 2]].concat();
    let mut faded_source = source.clone();
    for (index, sample) in faded_source.iter_mut().take(FADE).enumerate() {
        *sample *= index as f32 / FADE as f32;
    }
    let fade_start = faded_source.len() - FADE;
    for (index, sample) in faded_source[fade_start..].iter_mut().enumerate() {
        *sample *= (FADE - index) as f32 / FADE as f32;
    }
    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.source_audio = source;
    completion.audio = [vec![0.0; CHUNK], faded_source].concat();
    completion.source_vad_results = vec![vad(true), vad(false), vad(false)];
    completion.vad_results = vec![vad(false), vad(true), vad(false), vad(false)];
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(CHUNK as u64), GlobalSampleIndex((CHUNK * 5) as u64)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs.last().expect("final output should be emitted");
    assert_eq!(final_output.text, "全体追加。");
    assert!(final_output.is_final);
    assert_eq!(
        final_output.phrase,
        [vec![1.0; CHUNK * 2], vec![2.0; CHUNK], vec![0.0; CHUNK * 2]].concat(),
        "copied leading ASR padding must still be recognized after an edge fade so new child speech is not geometrically skipped"
    );
}

#[test]
fn turn_runtime_completion_after_non_streaming_interim_keeps_uncovered_tail_speech() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let interim = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(1)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("全体...", false, 1, 1), output_snapshot("全体追加。", true, 1, 2),],
        "a real completion tail after a non-streaming interim must still append"
    );
}

#[test]
fn turn_runtime_completion_replaces_visible_interim_with_full_longer_rewrite() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(false);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let interim = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "前半");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(1)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "前半と末尾");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("前半...", false, 1, 1), output_snapshot("前半と末尾。", true, 1, 2),],
        "a full longer completion rewrite must replace the visible utterance, not concatenate it"
    );
}

#[test]
fn turn_runtime_completion_after_streaming_interim_does_not_append_duplicate_tail_text() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = vec![1.0; 320];
    streaming_interim.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体末尾");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(160), GlobalSampleIndex(352)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = [vec![2.0; 160], vec![0.0; 32]].concat();
    completion.source_vad_results = vec![vad(true), vad(false)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "末尾");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("全体末尾...", false, 1, 1),
            output_snapshot("全体末尾。", true, 1, 1),
        ],
        "a completion segment already covered by a cumulative streaming interim must finalize the draft without appending the tail again"
    );
}

#[test]
fn turn_runtime_completion_after_streaming_interim_keeps_uncovered_tail_speech() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = vec![1.0; 320];
    streaming_interim.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(160), GlobalSampleIndex(352)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = vec![2.0; 192];
    completion.source_vad_results = vec![vad(true), vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("全体...", false, 1, 1), output_snapshot("全体追加。", true, 1, 2),],
        "completion text must still be appended when it contains speech not covered by the streaming interim"
    );
}

#[test]
fn turn_runtime_completion_after_streaming_interim_appends_only_uncovered_tail_audio() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(320)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..320).map(|sample| sample as f32).collect();
    streaming_interim.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(160), GlobalSampleIndex(352)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = (160..352).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true), vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(
        outputs.iter().map(|output| output.text.as_str()).collect::<Vec<_>>(),
        vec!["全体...", "全体追加。"]
    );
    assert_eq!(
        outputs.last().expect("final output should be emitted").phrase,
        (0..352).map(|sample| sample as f32).collect::<Vec<_>>(),
        "completion audio that overlaps a cumulative streaming interim must not be appended twice to the saved phrase"
    );
}

#[test]
fn turn_runtime_completion_after_streaming_interim_drops_overlapping_transcript_tokens() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(4_800)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = vec![1.0; 4_800];
    streaming_interim.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "電車が遅延してた");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(3_200), GlobalSampleIndex(8_000)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = vec![2.0; 4_800];
    completion.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_transcript(
        &completion,
        AsrTranscript::from_parts(
            "だから僕は学校に行かない",
            ["だ", "か", "ら", "僕", "は", "学", "校", "に", "行", "か", "な", "い"]
                .into_iter()
                .map(String::from)
                .collect(),
            Some(&[0.0, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.20, 0.21, 0.22]),
            None,
        ),
    );
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("電車が遅延してた...", false, 1, 1),
            output_snapshot("電車が遅延してたから僕は学校に行かない。", true, 1, 2),
        ],
        "completion text in the already-covered audio prefix must not duplicate the seam mora"
    );
}

#[test]
fn turn_runtime_completion_after_streaming_interim_drops_all_tokens_inside_audio_overlap() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(4_800)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = vec![1.0; 4_800];
    streaming_interim.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "電車が遅延してた");
    runtime.step();

    // Completion source starts 1_600 samples before the streaming end (0.1s at 16kHz).
    // Keep post-overlap speech so the duplicate-tail VAD short-circuit does not fire;
    // every token timestamp still lands inside that covered prefix.
    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(3_200), GlobalSampleIndex(8_000)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = vec![2.0; 4_800];
    completion.source_vad_results = vec![vad(true), vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_transcript(
        &completion,
        AsrTranscript::from_parts(
            "してただから",
            ["し", "て", "た", "だ", "か", "ら"].into_iter().map(String::from).collect(),
            Some(&[0.0, 0.02, 0.04, 0.06, 0.08, 0.09]),
            None,
        ),
    );
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("電車が遅延してた...", false, 1, 1),
            output_snapshot("電車が遅延してた。", true, 1, 1),
        ],
        "when every completion token begins inside the streaming overlap, none of that text may append"
    );
}

#[test]
fn turn_runtime_completion_overlap_offset_ignores_leading_asr_only_padding_on_source_audio() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(4_800)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..4_800).map(|sample| sample as f32).collect();
    streaming_interim.audio = streaming_interim.source_audio.clone();
    streaming_interim.source_vad_results = vec![vad(true)];
    streaming_interim.vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体");
    runtime.step();

    // Segment builder copies prior end-silence into the next segment as ASR-only
    // padding (`include_in_turn_audio = false`). The completion range still spans
    // that padding, but source_audio starts after it. Overlap must be converted
    // into source coordinates; applying the raw range overlap drops real speech.
    let leading_asr_padding = 1_600;
    let source_len = 3_200;
    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(3_200), GlobalSampleIndex(8_000)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = (4_800..8_000).map(|sample| sample as f32).collect();
    completion.audio = std::iter::repeat_n(0.0, leading_asr_padding)
        .chain(completion.source_audio.iter().copied())
        .collect();
    completion.source_vad_results = vec![vad(true); 2];
    completion.vad_results = vec![vad(false), vad(true), vad(true)];
    assert_eq!(completion.source_audio.len(), source_len);
    assert_eq!(completion.audio.len(), leading_asr_padding + source_len);
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "追加");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(
        outputs.iter().map(|output| output.text.as_str()).collect::<Vec<_>>(),
        vec!["全体...", "全体追加。"]
    );
    assert_eq!(
        outputs.last().expect("final output should be emitted").phrase,
        (0..8_000).map(|sample| sample as f32).collect::<Vec<_>>(),
        "ASR-only leading padding must not inflate the source overlap offset and drop post-overlap speech"
    );
}

#[test]
fn turn_runtime_completion_overlap_token_trim_uses_source_timeline_when_timestamps_omit_leading_padding()
 {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(4_800)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..4_800).map(|sample| sample as f32).collect();
    streaming_interim.audio = streaming_interim.source_audio.clone();
    streaming_interim.source_vad_results = vec![vad(true)];
    streaming_interim.vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体");
    runtime.step();

    // Geometric overlap equals leading ASR-only padding, so source overlap is 0.
    // Offline completion may still timestamp from the first source sample (0.0)
    // after ignoring copied silence; trimming against the padded audio timeline
    // would treat every token as overlapped and drop the uncovered suffix text.
    let leading_asr_padding = 1_600;
    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(3_200), GlobalSampleIndex(8_000)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = (4_800..8_000).map(|sample| sample as f32).collect();
    completion.audio = std::iter::repeat_n(0.0, leading_asr_padding)
        .chain(completion.source_audio.iter().copied())
        .collect();
    completion.source_vad_results = vec![vad(true); 2];
    completion.vad_results = vec![vad(false), vad(true), vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_transcript(
        &completion,
        AsrTranscript::from_parts(
            "追加分",
            ["追", "加", "分"].into_iter().map(String::from).collect(),
            Some(&[0.0, 0.05, 0.10]),
            None,
        ),
    );
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("全体...", false, 1, 1), output_snapshot("全体追加分。", true, 1, 2),],
        "source-relative completion timestamps must not be trimmed against the padded audio overlap"
    );
}

#[test]
fn turn_runtime_completion_overlap_token_trim_keeps_padded_audio_timeline_when_timestamps_include_padding()
 {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(4_800)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..4_800).map(|sample| sample as f32).collect();
    streaming_interim.audio = streaming_interim.source_audio.clone();
    streaming_interim.source_vad_results = vec![vad(true)];
    streaming_interim.vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "電車が遅延してた");
    runtime.step();

    // Same padded completion geometry as above, but token clocks include the
    // leading silence. Overlap trimming must stay on the padded audio timeline.
    let leading_asr_padding = 1_600;
    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(3_200), GlobalSampleIndex(8_000)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = (4_800..8_000).map(|sample| sample as f32).collect();
    completion.audio = std::iter::repeat_n(0.0, leading_asr_padding)
        .chain(completion.source_audio.iter().copied())
        .collect();
    completion.source_vad_results = vec![vad(true); 2];
    completion.vad_results = vec![vad(false), vad(true), vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_transcript(
        &completion,
        AsrTranscript::from_parts(
            "だから僕は学校に行かない",
            ["だ", "か", "ら", "僕", "は", "学", "校", "に", "行", "か", "な", "い"]
                .into_iter()
                .map(String::from)
                .collect(),
            // Clocks include the 0.1s leading silence. Tokens before 0.1s are in
            // the padded overlap; 0.12s+ is the uncovered source suffix.
            Some(&[0.09, 0.095, 0.099, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.20]),
            None,
        ),
    );
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("電車が遅延してた...", false, 1, 1),
            output_snapshot("電車が遅延してた僕は学校に行かない。", true, 1, 2),
        ],
        "padded-audio token timestamps must still drop the overlapped prefix mora"
    );
}

#[test]
fn streaming_interim_prespeech_padding_is_not_reused_by_final_completion_audio() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..480).map(|sample| sample as f32).collect();
    streaming_interim.source_vad_results = vec![vad(false), vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "全体");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(2)),
    );
    completion.source_audio = (80..480).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "全体");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(
        outputs.iter().map(|output| output.text.as_str()).collect::<Vec<_>>(),
        vec!["全体...", "全体。"]
    );
    assert_eq!(
        outputs.last().expect("final output should be emitted").phrase,
        (80..480).map(|sample| sample as f32).collect::<Vec<_>>(),
        "final output must use the completion source audio instead of reusing the streaming interim source with pre-speech padding"
    );
}

#[test]
fn turn_runtime_same_segment_completion_after_streaming_interim_uses_completion_audio_for_final() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    streaming_interim.source_audio = (0..480).map(|sample| sample as f32).collect();
    streaming_interim.source_vad_results = vec![vad(false), vad(true)];
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "途中");
    runtime.step();

    let mut completion = interim_request_for_turn(1, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    completion.source_audio = (80..480).map(|sample| sample as f32).collect();
    completion.source_vad_results = vec![vad(true)];
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "確定");
    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(
        outputs.iter().map(|output| output.text.as_str()).collect::<Vec<_>>(),
        vec!["途中...", "確定。"]
    );
    assert_eq!(
        outputs.first().expect("interim output should be emitted").phrase,
        (0..480).map(|sample| sample as f32).collect::<Vec<_>>(),
        "interim output should keep the streaming ASR source audio"
    );
    assert_eq!(
        outputs.last().expect("final output should be emitted").phrase,
        (80..480).map(|sample| sample as f32).collect::<Vec<_>>(),
        "final output should save the completion source separately instead of reusing the interim source"
    );
}

#[test]
fn split_asr_completion_after_interim_only_draft_is_not_dropped_as_stale() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .asr_model(AsrModel::ReazonSpeechK2V2)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .interim_display(true)
        .turn_detector(TurnDetector::Simple);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.route =
        RecognitionRoute::from_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "途中");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.route = RecognitionRoute::from_model(AsrModel::ReazonSpeechK2V2);
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "確定");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("途中...", false, 1, 1), output_snapshot("確定。", true, 1, 1),]
    );
}

#[test]
fn split_asr_completion_keeps_longer_streaming_interim_when_completion_truncates_prefix() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .asr_model(AsrModel::ReazonSpeechK2V2)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .interim_display(true)
        .turn_detector(TurnDetector::Simple);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.route =
        RecognitionRoute::from_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "今日はいい天気ですね");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.route = RecognitionRoute::from_model(AsrModel::ReazonSpeechK2V2);
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "今日はいい天気");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("今日はいい天気ですね...", false, 1, 1),
            output_snapshot("今日はいい天気ですね。", true, 1, 1),
        ],
        "a truncated ReazonSpeech completion must not erase the longer Nemotron utterance tail"
    );
}

#[test]
fn turn_runtime_mismatched_asr_result_keeps_in_flight_request_for_later_match() {
    let mut builder = RecognitionSessionTestBuilder::new();
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(request.clone());
    asr_handle.push_completed_result(AsrResult {
        request_id: AsrRequestId(999),
        kind: request.kind,
        target: request.target.clone(),
        route: request.route,
        status: AsrResultStatus::Ok(AsrTranscript::from_text("古い結果")),
        completed_at_frame: VadFrameIndex(0),
        elapsed_millis: 0,
    });

    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.request_id),
        Some(request.request_id),
        "a mismatched result must not clear the current in-flight request"
    );
    assert!(
        outputs.lock().expect("outputs should be readable").is_empty(),
        "a mismatched result must not emit output"
    );

    asr_handle.complete_request_with_text(&request, "正しい結果");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("正しい結果...", false, 1, 1)]
    );
    assert!(runtime.requests.in_flight_request.is_none());
}

#[test]
fn turn_runtime_mismatched_asr_result_does_not_dispatch_pending_next_utterance() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let request = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(request.clone()).pending_segment(
        2,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        100..200,
    );
    asr_handle.push_completed_result(AsrResult {
        request_id: AsrRequestId(999),
        kind: request.kind,
        target: request.target.clone(),
        route: request.route,
        status: AsrResultStatus::Ok(AsrTranscript::from_text("古い結果")),
        completed_at_frame: VadFrameIndex(0),
        elapsed_millis: 0,
    });

    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.request_id),
        Some(request.request_id),
        "a mismatched result must keep the original in-flight request"
    );
    assert_eq!(
        runtime.pending.asr_segments.len(),
        1,
        "a mismatched result must not dispatch a queued next utterance over the live request"
    );
    assert!(
        outputs.lock().expect("outputs should be readable").is_empty(),
        "a mismatched result must not emit output"
    );
}

#[test]
fn turn_runtime_route_changed_before_result_marks_request_stale() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .asr_model(AsrModel::ReazonSpeechK2V2);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..100,
    );
    runtime.step();
    let old_route_request =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    assert_eq!(old_route_request.route, RecognitionRoute::from_model(AsrModel::ReazonSpeechK2V2));
    runtime.update_config(&parapper_config! {
        asr_model: AsrModel::NemoParakeetTdt0_6BV2Int8,
        ..config
    });
    asr_handle.complete_request_with_text(&old_route_request, "古い経路");

    runtime.step();

    assert!(
        runtime.turn_store.turns.is_empty(),
        "an ASR result from the old route must not create or update a turn after route changes"
    );
    assert_eq!(*outputs.lock().expect("outputs should be readable"), Vec::<OutputSnapshot>::new());
}

#[test]
fn turn_runtime_failed_completion_check_falls_back_to_existing_draft_final() {
    let mut builder = RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let mut turn = Turn::new("turn-1-1-0".to_string(), 0);
    {
        let draft = turn.draft_mut();
        draft.append_recognized_segment(
            1,
            None,
            &[1.0],
            &[vad(true)],
            RecognitionRoute::from_language(crate::config::AsrLanguage::Japanese),
            "途中表示".to_string(),
            0,
        );
    }
    runtime_state(&mut runtime).turn(1, turn);
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..1,
    );
    runtime.step();
    let request =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
    asr_handle.fail_request(&request);

    runtime.step();

    assert!(runtime.requests.in_flight_request.is_none());
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("途中表示。", true, 1, 1)]
    );
}

#[test]
fn turn_runtime_failed_namo_completion_without_existing_draft_does_not_open_ghost_turn() {
    let mut builder = RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Namo);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..100,
    );
    runtime.step();
    let request =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    assert_eq!(request.kind, AsrTaskKind::CompletionCheck);
    asr_handle.fail_request(&request);

    runtime.step();

    assert!(runtime.requests.in_flight_request.is_none());
    assert!(
        runtime.turn_store.open_turn_id.is_none(),
        "a failed first completion with no draft text must not create a ghost open turn"
    );
    assert_eq!(*outputs.lock().expect("outputs should be readable"), Vec::<OutputSnapshot>::new());
}

#[test]
fn turn_runtime_failed_interim_display_does_not_block_later_completion_final() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );
    runtime.step();
    let interim_request =
        runtime.requests.in_flight_request.clone().expect("interim request should be in flight");
    assert_eq!(interim_request.kind, AsrTaskKind::InterimDisplay);
    asr_handle.fail_request(&interim_request);
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..100,
    );

    runtime.step();
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        Vec::<OutputSnapshot>::new(),
        "failed interim must not emit a placeholder or create a broken open turn"
    );
    runtime.step();
    let completion_request = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("completion should still dispatch after interim failure");
    assert_eq!(completion_request.kind, AsrTaskKind::CompletionCheck);
    asr_handle.complete_request_with_text(&completion_request, "確定表示");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("確定表示。", true, 1, 1)]
    );
}

#[test]
fn turn_runtime_empty_interim_transcript_clears_in_flight_without_opening_turn() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );
    runtime.step();
    let request =
        runtime.requests.in_flight_request.clone().expect("interim ASR should be in flight");
    asr_handle.push_completed_result(AsrResult {
        request_id: request.request_id,
        kind: request.kind,
        target: request.target,
        route: request.route,
        status: AsrResultStatus::Ok(AsrTranscript::from_text("   ")),
        completed_at_frame: VadFrameIndex(0),
        elapsed_millis: 0,
    });

    runtime.step();

    assert!(
        runtime.requests.in_flight_request.is_none(),
        "empty ASR transcript must clear the in-flight request"
    );
    assert!(
        runtime.turn_store.open_turn_id.is_none(),
        "empty interim text must not create a ghost open turn"
    );
    assert_eq!(*outputs.lock().expect("outputs should be readable"), Vec::<OutputSnapshot>::new());
}

#[test]
fn turn_runtime_completion_after_end_silence_emits_final_output() {
    let mut builder = RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Simple);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..100,
    );
    runtime.step();
    let request =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    asr_handle.complete_request_with_text(&request, "確定");

    runtime.step();

    let outputs = outputs.lock().expect("outputs should be readable");
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].text, "確定。");
}

#[test]
fn turn_runtime_failed_timeout_rerecognition_clears_purpose_and_finalizes_existing_draft() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .vad_interval_ms(32)
        .turn_check_silence_ms(32);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let turn = recognized_turn_with_vad(1, "未確定", &[1.0, 2.0], &[vad(true), vad(false)]);
    let timeout_ticks = runtime.timeout_ticks();
    runtime_state(&mut runtime)
        .turn(1, turn)
        .open_turn_since(1, 0)
        .next_runtime_tick(timeout_ticks);

    runtime.step();
    let request = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("timeout rerecognition request should be in flight");
    assert_eq!(request.kind, AsrTaskKind::Rerecognition);
    asr_handle.fail_request(&request);

    runtime.step();

    assert!(runtime.requests.in_flight_request.is_none());
    assert!(
        runtime.requests.pending_rerecognition_purpose.is_none(),
        "failed rerecognition must not leave a purpose for a later unrelated result"
    );
    assert_eq!(
        asr_handle.submitted_requests().len(),
        1,
        "a failed ASR result must not trigger another timeout rerecognition in the same step"
    );
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("未確定...", false, 1, 1), output_snapshot("未確定。", true, 1, 1)],
        "timeout rerecognition failure should fall back to the existing draft instead of hanging"
    );
    assert!(runtime.turn_store.open_turn_id.is_none());
}

#[test]
fn turn_runtime_failed_simple_turn_check_rerecognition_finalizes_existing_draft() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    let mut turn = Turn::new("turn-1-1-0".to_string(), 0);
    {
        let draft = turn.draft_mut();
        draft.append_recognized_segment(
            1,
            None,
            &[1.0],
            &[vad(true)],
            RecognitionRoute::from_language(crate::config::AsrLanguage::Japanese),
            "簡易確定".to_string(),
            0,
        );
    }
    runtime_state(&mut runtime).turn(1, turn).open_turn(1).pending_turn_check(1);
    runtime.step();
    let request = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("simple turn-check rerecognition should be in flight");
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("簡易確定...", false, 1, 1)],
        "existing draft must stay visible while turn-check rerecognition is in flight"
    );
    asr_handle.fail_request(&request);

    runtime.step();

    assert!(runtime.requests.pending_rerecognition_purpose.is_none());
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("簡易確定...", false, 1, 1),
            output_snapshot("簡易確定。", true, 1, 1)
        ]
    );
}

#[test]
fn turn_runtime_simple_turn_check_rerecognition_yields_to_160ms_tail_then_restarts() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .rerecognize_full_on_complete(true)
        .interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();

    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..150,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch completion ASR");
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimChunkReached,
        150..310,
    );
    asr_handle.complete_request_with_text(&completion, "全体。");
    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("SimpleTurnCheckFinal must yield the slot to same-turn 160ms tail ASR");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "全体。");
    assert_eq!(draft.full_audio, vec![1.0; 150]);

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("SimpleTurnCheckFinal rerecognition must restart after the 160ms tail");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        runtime.requests.pending_rerecognition_purpose,
        Some(RerecognitionPurpose::SimpleTurnCheckFinal)
    );
    assert_eq!(rerecognition.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("全体"),
        "SimpleTurnCheckFinal tail must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "SimpleTurnCheckFinal tail must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "SimpleTurnCheckFinal tail must keep uncovered tail audio"
    );

    let rerecognition = rerecognition.clone();
    asr_handle.complete_request_with_text(&rerecognition, "全体。続き");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "restarted SimpleTurnCheckFinal must finalize instead of waiting on timeout"
    );
    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert!(
        final_output.text.contains("全体"),
        "final must not drop already-visible text; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "final must keep the 160ms tail text; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "final must keep uncovered tail audio from the SimpleTurnCheckFinal 160ms chunk"
    );
}

#[test]
fn turn_runtime_timeout_final_rerecognition_yields_to_160ms_tail_then_restarts() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(true)
        .vad_interval_ms(32)
        .turn_check_silence_ms(32);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_phrase_sink();
    let (mut runtime, _config) = builder.build();
    let turn = recognized_turn_with_audio(1, "未確定", &vec![1.0; 150]);
    let timeout_ticks = runtime.timeout_ticks();
    runtime_state(&mut runtime)
        .turn(1, turn)
        .turn_audio_range(1, 0..150)
        .open_turn_since(1, 0)
        .next_runtime_tick(timeout_ticks)
        .pending_segment(2, Some(1), SegmentCloseReason::InterimChunkReached, 150..310);

    runtime.step();

    let chunk = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("TimeoutFinal must yield the slot to same-turn 160ms tail ASR");
    assert_eq!(chunk.kind, AsrTaskKind::InterimDisplay);
    assert_eq!(chunk.target.turn_id, TurnId(1));
    assert!(!runtime.turn_store.finalized_turns.contains(&1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert_eq!(draft.combined_text, "未確定");

    let chunk = chunk.clone();
    asr_handle.complete_request_with_text(&chunk, "続き");
    runtime.step();

    let rerecognition = runtime
        .requests
        .in_flight_request
        .as_ref()
        .expect("TimeoutFinal rerecognition must restart after the 160ms tail");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        runtime.requests.pending_rerecognition_purpose,
        Some(RerecognitionPurpose::TimeoutFinal)
    );
    assert_eq!(rerecognition.target.turn_id, TurnId(1));
    let draft = runtime.turn_store.turns.get(&1).expect("turn 1 draft must stay open").draft();
    assert!(
        draft.combined_text.contains("未確定"),
        "TimeoutFinal tail must not drop already-visible text; got {}",
        draft.combined_text
    );
    assert!(
        draft.combined_text.contains("続き"),
        "TimeoutFinal tail must append the continuation; got {}",
        draft.combined_text
    );
    assert_eq!(
        draft.full_audio,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "TimeoutFinal tail must keep uncovered tail audio"
    );

    let rerecognition = rerecognition.clone();
    asr_handle.complete_request_with_text(&rerecognition, "未確定続き");
    runtime.step();

    assert!(
        runtime.turn_store.finalized_turns.contains(&1),
        "restarted TimeoutFinal must finalize instead of waiting on another timeout"
    );
    let outputs = outputs.lock().expect("outputs should be readable");
    let final_output = outputs
        .iter()
        .find(|output| output.is_final && output.turn_id == 1)
        .expect("turn 1 must keep its final caption");
    assert!(
        final_output.text.contains("未確定"),
        "final must not drop already-visible text; got {}",
        final_output.text
    );
    assert!(
        final_output.text.contains("続き"),
        "final must keep the 160ms tail text; got {}",
        final_output.text
    );
    assert_eq!(
        final_output.phrase,
        [vec![1.0; 150], vec![2.0; 160]].concat(),
        "final must keep uncovered tail audio from the TimeoutFinal 160ms chunk"
    );
}

#[test]
fn turn_runtime_failed_grammar_rerecognition_uses_turn_decision_on_existing_draft() {
    let mut builder = RecognitionSessionTestBuilder::new().turn_detector(TurnDetector::Namo);
    let asr_handle = builder.use_manual_asr();
    let decision_texts = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: true, confidence: 0.99 }]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..1,
    );
    runtime.step();
    let completion =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    assert_eq!(completion.kind, AsrTaskKind::CompletionCheck);
    asr_handle.complete_request_with_text(&completion, "文法判定");
    runtime.step();
    let request = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("grammar rerecognition should be in flight");
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("文法判定...", false, 1, 1)],
        "completion text must be visible while grammar rerecognition is in flight"
    );
    asr_handle.fail_request(&request);

    runtime.step();

    assert!(runtime.requests.pending_rerecognition_purpose.is_none());
    assert_eq!(
        *decision_texts.lock().expect("turn decision texts should be readable"),
        vec!["文法判定".to_string()]
    );
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("文法判定...", false, 1, 1),
            output_snapshot("文法判定。", true, 1, 1)
        ]
    );
}

#[test]
fn turn_runtime_interim_with_unchanged_text_is_not_re_emitted_until_it_changes() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    // Successive 160ms streaming chunks for the same segment update the latest segment in place,
    // so identical ASR text leaves the turn's combined text unchanged.
    let streaming_chunk = |request_id: u64, end_sample: u64| {
        let mut request = interim_request_for_turn(request_id, 1);
        request.close_reason = Some(SegmentCloseReason::InterimChunkReached);
        request.target = AsrTarget::new(
            TurnId(1),
            TurnRevision(0),
            AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(end_sample)),
            Some(SegmentId(1)),
            Some(SegmentId(1)),
        );
        request.source_audio = vec![1.0; usize::try_from(end_sample).unwrap()];
        request.source_vad_results = vec![vad(true)];
        request
    };

    let first = streaming_chunk(1, 160);
    runtime_state(&mut runtime).in_flight(first.clone());
    asr_handle.complete_request_with_text(&first, "こん");
    runtime.step();

    let second = streaming_chunk(2, 320);
    runtime_state(&mut runtime).in_flight(second.clone());
    asr_handle.complete_request_with_text(&second, "こん");
    runtime.step();

    let third = streaming_chunk(3, 480);
    runtime_state(&mut runtime).in_flight(third.clone());
    asr_handle.complete_request_with_text(&third, "こんにちは");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("こん...", false, 1, 1),
            output_snapshot("こんにちは...", false, 1, 1),
        ],
        "an interim must emit only when the turn text changed since the last emitted interim"
    );
}

#[test]
fn turn_runtime_final_is_emitted_even_when_text_equals_last_emitted_interim() {
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let interim = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "確定テキスト");
    runtime.step();

    runtime.complete_turn_without_grammar(1);

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("確定テキスト...", false, 1, 1),
            output_snapshot("確定テキスト。", true, 1, 1),
        ],
        "a final must always emit even when its combined text equals the last emitted interim"
    );
}

#[test]
fn turn_runtime_completion_hypothesis_is_visible_while_rerecognition_is_in_flight() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..100,
    );
    runtime.step();
    let completion = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("end-silence must dispatch a completion request");
    asr_handle.complete_request_with_text(&completion, "completion-draft");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "completion must still wait on full-turn rerecognition"
    );
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("completion-draft...", false, 1, 1)],
        "the completion transcript must be on screen before rerecognition returns"
    );
}

#[test]
fn turn_runtime_longer_completion_rewrite_is_visible_while_rerecognition_is_in_flight() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Simple)
        .interim_display(true)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let interim = interim_request_for_turn(1, 1);
    runtime_state(&mut runtime).in_flight(interim.clone());
    asr_handle.complete_request_with_text(&interim, "長い発話の前半");
    runtime.step();
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("長い発話の前半...", false, 1, 1)]
    );

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(1)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "長い発話の前半と末尾");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "completion must still wait on full-turn rerecognition"
    );
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("長い発話の前半...", false, 1, 1),
            output_snapshot("長い発話の前半と末尾...", false, 1, 1)
        ],
        "a longer completion rewrite must reach the caption before rerecognition returns"
    );
}

#[test]
fn turn_runtime_truncated_completion_does_not_clobber_longer_interim_while_rerecognition_is_in_flight()
 {
    let mut builder = RecognitionSessionTestBuilder::new()
        .asr_model(AsrModel::ReazonSpeechK2V2)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .interim_display(true)
        .turn_detector(TurnDetector::Simple)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.route =
        RecognitionRoute::from_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "今日はいい天気ですね");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.route = RecognitionRoute::from_model(AsrModel::ReazonSpeechK2V2);
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "今日はいい天気");
    runtime.step();

    assert_eq!(
        runtime.requests.in_flight_request.as_ref().map(|request| request.kind),
        Some(AsrTaskKind::Rerecognition),
        "truncated completion must still wait on full-turn rerecognition"
    );
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("今日はいい天気ですね...", false, 1, 1)],
        "a truncated completion must not replace the longer visible interim while rerecognition waits"
    );
}

#[test]
fn turn_runtime_truncated_rerecognition_does_not_shorten_final_output() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .asr_model(AsrModel::ReazonSpeechK2V2)
        .interim_asr_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8)
        .interim_display(true)
        .turn_detector(TurnDetector::Simple)
        .rerecognize_full_on_complete(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();

    let mut streaming_interim = interim_request_for_turn(1, 1);
    streaming_interim.route =
        RecognitionRoute::from_model(AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8);
    streaming_interim.close_reason = Some(SegmentCloseReason::InterimChunkReached);
    streaming_interim.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(streaming_interim.clone());
    asr_handle.complete_request_with_text(&streaming_interim, "今日はいい天気ですね");
    runtime.step();

    let mut completion = interim_request_for_turn(2, 1);
    completion.kind = AsrTaskKind::CompletionCheck;
    completion.route = RecognitionRoute::from_model(AsrModel::ReazonSpeechK2V2);
    completion.close_reason = Some(SegmentCloseReason::EndSilenceReached);
    completion.target = AsrTarget::new(
        TurnId(1),
        TurnRevision(0),
        AudioRange::new(GlobalSampleIndex(0), GlobalSampleIndex(480)),
        Some(SegmentId(1)),
        Some(SegmentId(1)),
    );
    runtime_state(&mut runtime).in_flight(completion.clone());
    asr_handle.complete_request_with_text(&completion, "今日はいい天気");
    runtime.step();
    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("truncated completion must still dispatch full-turn rerecognition");
    asr_handle.complete_request_with_text(&rerecognition, "今日はいい天気");
    runtime.step();

    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("今日はいい天気ですね...", false, 1, 1),
            output_snapshot("今日はいい天気ですね。", true, 1, 1)
        ],
        "a truncated rerecognition must not replace the longer hypothesis in the final caption"
    );
}

#[test]
fn turn_runtime_namo_continue_emits_longer_rerecognition_rewrite_when_interim_display_is_off() {
    let mut builder = RecognitionSessionTestBuilder::new()
        .turn_detector(TurnDetector::Namo)
        .interim_display(false);
    let asr_handle = builder.use_manual_asr();
    let _ = builder
        .use_scripted_decisions(vec![TurnDecision { is_end_of_turn: false, confidence: 0.01 }]);
    let outputs = builder.use_recording_sink();
    let (mut runtime, _config) = builder.build();
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::EndSilenceReached,
        0..1,
    );
    runtime.step();
    let completion =
        runtime.requests.in_flight_request.clone().expect("completion request should be in flight");
    asr_handle.complete_request_with_text(&completion, "前半から");
    runtime.step();
    let rerecognition = runtime
        .requests
        .in_flight_request
        .clone()
        .expect("Namo completion must dispatch grammar rerecognition");
    assert_eq!(rerecognition.kind, AsrTaskKind::Rerecognition);
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![output_snapshot("前半から...", false, 1, 1)],
        "completion hypothesis must be visible while rerecognition is in flight"
    );
    asr_handle.complete_request_with_text(&rerecognition, "前半から末尾まで");
    runtime.step();

    assert_eq!(runtime.turn_store.open_turn_id, Some(1), "Namo Continue must keep the turn open");
    assert!(!runtime.turn_store.finalized_turns.contains(&1), "Namo Continue must not finalize");
    assert_eq!(
        *outputs.lock().expect("outputs should be readable"),
        vec![
            output_snapshot("前半から...", false, 1, 1),
            output_snapshot("前半から末尾まで...", false, 1, 1)
        ],
        "a longer rerecognition rewrite must reach the caption before final even when interim display is off"
    );
}
