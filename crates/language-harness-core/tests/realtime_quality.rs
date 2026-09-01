use std::time::{Duration, Instant};

use language_harness_core::{
    Language, LanguageTracker, Observation, PushObservationResult, TrackerConfig,
};

fn observation(at_ms: u64, ja: f32, en: f32) -> Observation {
    Observation::from_probabilities(at_ms, [ja, en, 0.005, 0.005], 1.0, true)
}

fn tracker() -> LanguageTracker {
    LanguageTracker::new(TrackerConfig { switch_llr_threshold: 2.5, ..TrackerConfig::default() })
        .expect("valid tracker config")
}

fn push_and_advance(
    tracker: &mut LanguageTracker,
    observation: Observation,
) -> Vec<language_harness_core::SwitchEvent> {
    let at_ms = observation.at_ms;
    assert!(tracker.push_observation(observation));
    tracker.advance_to(at_ms)
}

#[test]
fn switches_ja_to_en_and_back_to_ja_without_flapping() {
    let mut tracker = tracker();
    let mut switches = Vec::new();

    switches.extend(push_and_advance(&mut tracker, observation(0, 0.99, 0.001)));
    assert_eq!(tracker.state().stable_language, Language::Ja);

    for at_ms in [500, 1_000, 1_500, 2_000] {
        switches.extend(push_and_advance(&mut tracker, observation(at_ms, 0.01, 0.98)));
    }
    assert_eq!(tracker.state().stable_language, Language::En);

    // A borrowed/ambiguous Japanese-looking token must not immediately flip the state back.
    switches.extend(push_and_advance(&mut tracker, observation(2_500, 0.60, 0.39)));
    assert_eq!(tracker.state().stable_language, Language::En);

    for at_ms in [3_000, 3_500, 4_000, 4_500] {
        switches.extend(push_and_advance(&mut tracker, observation(at_ms, 0.98, 0.01)));
    }
    assert_eq!(tracker.state().stable_language, Language::Ja);

    let language_changes: Vec<_> =
        switches.into_iter().map(|event| (event.from, event.to)).collect();
    assert_eq!(
        language_changes,
        vec![
            (Language::Unknown, Language::Ja),
            (Language::Ja, Language::En),
            (Language::En, Language::Ja),
        ]
    );
}

#[test]
fn burst_input_is_coalesced_and_backpressure_is_explicit() {
    let mut tracker =
        LanguageTracker::new(TrackerConfig { max_pending_ticks: 2, ..TrackerConfig::default() })
            .expect("valid tracker config");

    assert_eq!(
        tracker.push_observation_detailed(observation(0, 0.99, 0.001)),
        PushObservationResult::Enqueued
    );
    tracker.advance_to(0);

    for at_ms in 1..500 {
        assert!(tracker.push_observation(observation(at_ms, 0.90, 0.09)));
    }
    assert_eq!(tracker.pending_observation_count(), 1);

    assert_eq!(
        tracker.push_observation_detailed(observation(1_000, 0.90, 0.09)),
        PushObservationResult::Enqueued
    );
    assert_eq!(tracker.pending_observation_count(), 2);
    assert_eq!(
        tracker.push_observation_detailed(observation(1_500, 0.90, 0.09)),
        PushObservationResult::Backpressure
    );
}

#[test]
fn tracker_hot_path_is_far_below_realtime_budget() {
    const TICKS: u64 = 10_000;
    const STEP_MS: u64 = 500;
    // This is deliberately generous for shared CI runners. Processing 10,000 logical
    // 500 ms ticks in under one second leaves orders of magnitude of headroom relative
    // to the realtime cadence while still catching accidental O(n^2) regressions.
    const MAX_ELAPSED: Duration = Duration::from_secs(1);

    let mut tracker = tracker();
    let mut events = Vec::with_capacity(2);
    let event_capacity = events.capacity();
    let started = Instant::now();

    for tick in 0..TICKS {
        let at_ms = tick * STEP_MS;
        let input = if (tick / 200) % 2 == 0 {
            observation(at_ms, 0.92, 0.07)
        } else {
            observation(at_ms, 0.07, 0.92)
        };
        assert!(tracker.push_observation(input));
        tracker.advance_to_into(at_ms, &mut events);
    }

    let elapsed = started.elapsed();
    assert!(
        elapsed < MAX_ELAPSED,
        "10,000 tracker ticks took {elapsed:?}, exceeding {MAX_ELAPSED:?}"
    );
    assert_eq!(events.capacity(), event_capacity);
    assert_eq!(tracker.state().tick_at_ms, (TICKS - 1) * STEP_MS);
}
