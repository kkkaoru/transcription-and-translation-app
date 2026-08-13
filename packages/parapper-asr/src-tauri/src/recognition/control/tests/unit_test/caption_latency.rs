use super::super::*;
use crate::recognition::control::{clock::InjectedCaptionClock, events::TurnCaptionLatency};

struct LatencySink {
    outputs: std::sync::Arc<std::sync::Mutex<Vec<RecognizedTextOutput>>>,
}

impl TurnOutputSink for LatencySink {
    fn emit(&mut self, output: RecognizedTextOutput) {
        self.outputs.lock().expect("latency outputs should be writable").push(output);
    }
}

fn latency_of(output: &RecognizedTextOutput) -> TurnCaptionLatency {
    output.caption_latency
}

#[test]
fn caption_latency_stamps_speech_dispatch_partial_and_final_from_injected_clock() {
    let clock = InjectedCaptionClock::new(0);
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let outputs = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    builder = builder.output_sink(Box::new(LatencySink { outputs: outputs.clone() }));
    let (mut runtime, _config) = builder.build();
    runtime.set_clock(std::sync::Arc::new(clock.clone()));

    clock.set(1_000);
    runtime.push_vad_frame(&[1.0; 16], vad(true));

    clock.set(1_100);
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );
    runtime.step();

    let dispatched = runtime
        .turn_store
        .caption_latency
        .get(&1)
        .copied()
        .expect("dispatch must open a latency span for the target turn");
    assert_eq!(dispatched.speech_start_at, Some(1_000));
    assert_eq!(dispatched.asr_dispatch_at, Some(1_100));
    assert_eq!(dispatched.first_partial_at, None);
    assert_eq!(dispatched.asr_final_at, None);

    let request =
        runtime.requests.in_flight_request.clone().expect("queued root segment must dispatch");
    clock.set(1_300);
    asr_handle.complete_request_with_text(&request, "partial-text");
    runtime.step();

    let partials = outputs.lock().expect("outputs should be readable");
    assert_eq!(partials.len(), 1);
    let partial = latency_of(&partials[0]);
    assert!(!partials[0].meta.is_final);
    assert_eq!(partial.speech_start_at, Some(1_000));
    assert_eq!(partial.asr_dispatch_at, Some(1_100));
    assert_eq!(partial.first_partial_at, Some(1_300));
    assert_eq!(partial.asr_final_at, None);
    drop(partials);

    clock.set(1_800);
    runtime.complete_turn_without_grammar(1);

    let emitted = outputs.lock().expect("outputs should be readable");
    assert_eq!(emitted.len(), 2);
    let final_latency = latency_of(&emitted[1]);
    assert!(emitted[1].meta.is_final);
    assert_eq!(final_latency.speech_start_at, Some(1_000));
    assert_eq!(final_latency.asr_dispatch_at, Some(1_100));
    assert_eq!(final_latency.first_partial_at, Some(1_300));
    assert_eq!(final_latency.asr_final_at, Some(1_800));
}

#[test]
fn caption_latency_keeps_first_dispatch_across_later_same_turn_asr() {
    // A continuation segment on the same turn must not look “faster” by
    // resetting speech_start_at / asr_dispatch_at. Long utterances keep the
    // original onset and first submit.
    let clock = InjectedCaptionClock::new(0);
    let mut builder = RecognitionSessionTestBuilder::new().interim_display(true);
    let asr_handle = builder.use_manual_asr();
    let (mut runtime, _config) = builder.build();
    runtime.set_clock(std::sync::Arc::new(clock.clone()));

    clock.set(500);
    runtime.push_vad_frame(&[1.0; 16], vad(true));
    clock.set(600);
    runtime_state(&mut runtime).pending_segment(
        1,
        None,
        SegmentCloseReason::InterimResultSilenceReached,
        0..100,
    );
    runtime.step();
    let first = runtime.requests.in_flight_request.clone().expect("first ASR");
    clock.set(700);
    asr_handle.complete_request_with_text(&first, "head");
    runtime.step();

    clock.set(2_000);
    runtime.push_vad_frame(&[1.0; 16], vad(true));
    clock.set(2_100);
    runtime_state(&mut runtime).pending_segment(
        2,
        Some(1),
        SegmentCloseReason::InterimResultSilenceReached,
        100..400,
    );
    runtime.step();

    let span = runtime
        .turn_store
        .caption_latency
        .get(&1)
        .copied()
        .expect("same-turn continuation must keep the original span");
    assert_eq!(span.speech_start_at, Some(500));
    assert_eq!(span.asr_dispatch_at, Some(600));
    assert_eq!(span.first_partial_at, Some(700));
    assert!(
        runtime.requests.in_flight_request.is_some(),
        "continuation ASR must still dispatch; telemetry must not skip long segments"
    );
}
