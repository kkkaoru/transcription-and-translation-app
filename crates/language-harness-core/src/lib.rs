#![forbid(unsafe_code)]

use std::collections::VecDeque;

pub const LANGUAGE_COUNT: usize = 4;
const EPSILON: f32 = 1.0e-6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(usize)]
pub enum Language {
    Ja = 0,
    En = 1,
    Unknown = 2,
    Unsupported = 3,
}

impl Language {
    pub const ALL: [Self; LANGUAGE_COUNT] = [
        Self::Ja,
        Self::En,
        Self::Unknown,
        Self::Unsupported,
    ];

    pub const fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observation {
    pub at_ms: u64,
    pub log_scores: [f32; LANGUAGE_COUNT],
    pub quality: f32,
    pub speech: bool,
}

impl Observation {
    pub fn from_probabilities(
        at_ms: u64,
        probabilities: [f32; LANGUAGE_COUNT],
        quality: f32,
        speech: bool,
    ) -> Self {
        let normalized = normalize_probabilities(probabilities);
        Self {
            at_ms,
            log_scores: normalized.map(|value| value.max(EPSILON).ln()),
            quality: quality.clamp(0.0, 1.0),
            speech,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackerConfig {
    pub tracker_step_ms: u64,
    pub hmm_self_probability: f32,
    pub switch_llr_threshold: f32,
    pub switch_posterior_threshold: f32,
    pub retain_posterior_threshold: f32,
    pub max_switch_silence_ms: u64,
    pub min_observation_quality: f32,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            tracker_step_ms: 500,
            hmm_self_probability: 0.94,
            switch_llr_threshold: 3.0,
            switch_posterior_threshold: 0.72,
            retain_posterior_threshold: 0.42,
            max_switch_silence_ms: 1_500,
            min_observation_quality: 0.2,
        }
    }
}

impl TrackerConfig {
    pub fn validate(self) -> Result<Self, ConfigError> {
        if self.tracker_step_ms == 0 {
            return Err(ConfigError::TrackerStepZero);
        }
        if !(0.25..1.0).contains(&self.hmm_self_probability) {
            return Err(ConfigError::InvalidSelfProbability);
        }
        if self.switch_llr_threshold <= 0.0 || !self.switch_llr_threshold.is_finite() {
            return Err(ConfigError::InvalidSwitchThreshold);
        }
        if !(0.0..=1.0).contains(&self.switch_posterior_threshold)
            || !(0.0..=1.0).contains(&self.retain_posterior_threshold)
            || self.switch_posterior_threshold <= self.retain_posterior_threshold
        {
            return Err(ConfigError::InvalidHysteresis);
        }
        if !(0.0..=1.0).contains(&self.min_observation_quality) {
            return Err(ConfigError::InvalidMinimumQuality);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    TrackerStepZero,
    InvalidSelfProbability,
    InvalidSwitchThreshold,
    InvalidHysteresis,
    InvalidMinimumQuality,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitchEvent {
    pub at_ms: u64,
    pub from: Language,
    pub to: Language,
    pub llr: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackerState {
    pub stable_language: Language,
    pub stable_confidence: f32,
    pub candidate_language: Option<Language>,
    pub candidate_llr: f32,
    pub posterior: [f32; LANGUAGE_COUNT],
    pub tick_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SwitchEpisode {
    candidate: Language,
    llr: f32,
    last_speech_ms: u64,
}

#[derive(Debug)]
pub struct LanguageTracker {
    config: TrackerConfig,
    posterior: [f32; LANGUAGE_COUNT],
    stable_language: Language,
    pending: VecDeque<Observation>,
    last_enqueued_at_ms: Option<u64>,
    next_tick_ms: Option<u64>,
    last_tick_ms: u64,
    switch_episode: Option<SwitchEpisode>,
}

impl LanguageTracker {
    pub fn new(config: TrackerConfig) -> Result<Self, ConfigError> {
        let config = config.validate()?;
        let mut posterior = [0.0; LANGUAGE_COUNT];
        posterior[Language::Unknown.index()] = 1.0;
        Ok(Self {
            config,
            posterior,
            stable_language: Language::Unknown,
            pending: VecDeque::new(),
            last_enqueued_at_ms: None,
            next_tick_ms: None,
            last_tick_ms: 0,
            switch_episode: None,
        })
    }

    /// Returns false when an out-of-order observation is rejected.
    pub fn push_observation(&mut self, observation: Observation) -> bool {
        if self
            .last_enqueued_at_ms
            .is_some_and(|last| observation.at_ms < last)
        {
            return false;
        }
        self.last_enqueued_at_ms = Some(observation.at_ms);
        self.next_tick_ms.get_or_insert(observation.at_ms);
        self.pending.push_back(observation);
        true
    }

    pub fn advance_to(&mut self, target_ms: u64) -> Vec<SwitchEvent> {
        let mut events = Vec::new();
        while let Some(tick_ms) = self.next_tick_ms {
            if tick_ms > target_ms {
                break;
            }

            let observation = self.take_latest_observation_for_tick(tick_ms);
            if let Some(observation) = observation {
                if let Some(event) = self.advance_tick(tick_ms, observation) {
                    events.push(event);
                }
            } else {
                self.expire_episode_on_silence(tick_ms);
            }

            self.last_tick_ms = tick_ms;
            self.next_tick_ms = Some(tick_ms.saturating_add(self.config.tracker_step_ms));
        }
        events
    }

    pub fn state(&self) -> TrackerState {
        TrackerState {
            stable_language: self.stable_language,
            stable_confidence: self.posterior[self.stable_language.index()],
            candidate_language: self.switch_episode.map(|episode| episode.candidate),
            candidate_llr: self.switch_episode.map_or(0.0, |episode| episode.llr),
            posterior: self.posterior,
            tick_at_ms: self.last_tick_ms,
        }
    }

    pub fn reset(&mut self) {
        self.posterior = [0.0; LANGUAGE_COUNT];
        self.posterior[Language::Unknown.index()] = 1.0;
        self.stable_language = Language::Unknown;
        self.pending.clear();
        self.last_enqueued_at_ms = None;
        self.next_tick_ms = None;
        self.last_tick_ms = 0;
        self.switch_episode = None;
    }

    fn take_latest_observation_for_tick(&mut self, tick_ms: u64) -> Option<Observation> {
        let mut latest = None;
        while self.pending.front().is_some_and(|item| item.at_ms <= tick_ms) {
            latest = self.pending.pop_front();
        }
        latest
    }

    fn advance_tick(&mut self, tick_ms: u64, observation: Observation) -> Option<SwitchEvent> {
        if observation.quality < self.config.min_observation_quality {
            self.expire_episode_on_silence(tick_ms);
            return None;
        }

        self.posterior = hmm_forward(
            self.posterior,
            observation.log_scores,
            self.config.hmm_self_probability,
        );

        if self.stable_language == Language::Unknown {
            return self.try_lock_initial_language(tick_ms);
        }

        let candidate = argmax(&self.posterior);
        if candidate == self.stable_language
            || self.posterior[candidate.index()] < self.config.retain_posterior_threshold
        {
            self.switch_episode = None;
            return None;
        }

        if !observation.speech {
            self.expire_episode_on_silence(tick_ms);
            return None;
        }

        let increment = observation.log_scores[candidate.index()]
            - observation.log_scores[self.stable_language.index()];
        let mut episode = match self.switch_episode {
            Some(existing) if existing.candidate == candidate => existing,
            _ => SwitchEpisode {
                candidate,
                llr: 0.0,
                last_speech_ms: tick_ms,
            },
        };
        episode.llr += increment;
        episode.last_speech_ms = tick_ms;
        self.switch_episode = Some(episode);

        if episode.llr >= self.config.switch_llr_threshold
            && self.posterior[candidate.index()] >= self.config.switch_posterior_threshold
        {
            let from = self.stable_language;
            self.stable_language = candidate;
            self.switch_episode = None;
            return Some(SwitchEvent {
                at_ms: tick_ms,
                from,
                to: candidate,
                llr: episode.llr,
            });
        }
        None
    }

    fn try_lock_initial_language(&mut self, tick_ms: u64) -> Option<SwitchEvent> {
        let best = argmax(&self.posterior);
        if best == Language::Unknown
            || self.posterior[best.index()] < self.config.switch_posterior_threshold
        {
            return None;
        }
        let from = self.stable_language;
        self.stable_language = best;
        self.switch_episode = None;
        Some(SwitchEvent {
            at_ms: tick_ms,
            from,
            to: best,
            llr: 0.0,
        })
    }

    fn expire_episode_on_silence(&mut self, tick_ms: u64) {
        if self.switch_episode.is_some_and(|episode| {
            tick_ms.saturating_sub(episode.last_speech_ms) > self.config.max_switch_silence_ms
        }) {
            self.switch_episode = None;
        }
    }
}

pub fn hmm_forward(
    previous: [f32; LANGUAGE_COUNT],
    observation_log_scores: [f32; LANGUAGE_COUNT],
    self_probability: f32,
) -> [f32; LANGUAGE_COUNT] {
    let cross_probability = (1.0 - self_probability) / (LANGUAGE_COUNT as f32 - 1.0);
    let mut unnormalized = [0.0; LANGUAGE_COUNT];
    for destination in 0..LANGUAGE_COUNT {
        let predicted = previous
            .iter()
            .enumerate()
            .map(|(source, probability)| {
                let transition = if source == destination {
                    self_probability
                } else {
                    cross_probability
                };
                probability * transition
            })
            .sum::<f32>();
        unnormalized[destination] =
            predicted.max(EPSILON) * observation_log_scores[destination].exp();
    }
    normalize_probabilities(unnormalized)
}

pub fn fixed_lag_viterbi(
    observations: &[[f32; LANGUAGE_COUNT]],
    self_probability: f32,
) -> Vec<Language> {
    if observations.is_empty() {
        return Vec::new();
    }

    let cross_probability = (1.0 - self_probability) / (LANGUAGE_COUNT as f32 - 1.0);
    let mut scores = [-(LANGUAGE_COUNT as f32).ln(); LANGUAGE_COUNT];
    let mut backpointers = vec![[0usize; LANGUAGE_COUNT]; observations.len()];

    for (time, observation) in observations.iter().enumerate() {
        let mut next = [f32::NEG_INFINITY; LANGUAGE_COUNT];
        for destination in 0..LANGUAGE_COUNT {
            let emission = observation[destination].max(EPSILON).ln();
            let mut best_score = f32::NEG_INFINITY;
            let mut best_source = 0usize;
            for (source, source_score) in scores.iter().copied().enumerate() {
                let transition = if source == destination {
                    self_probability
                } else {
                    cross_probability
                };
                let score = source_score + transition.max(EPSILON).ln() + emission;
                if score > best_score {
                    best_score = score;
                    best_source = source;
                }
            }
            next[destination] = best_score;
            backpointers[time][destination] = best_source;
        }
        scores = next;
    }

    let mut state = argmax_index(&scores);
    let mut path = vec![Language::Unknown; observations.len()];
    for time in (0..observations.len()).rev() {
        path[time] = Language::ALL[state];
        state = backpointers[time][state];
    }
    path
}

fn argmax(values: &[f32; LANGUAGE_COUNT]) -> Language {
    Language::ALL[argmax_index(values)]
}

fn argmax_index(values: &[f32; LANGUAGE_COUNT]) -> usize {
    let mut best_index = 0;
    let mut best_value = f32::NEG_INFINITY;
    for (index, value) in values.iter().copied().enumerate() {
        if value > best_value {
            best_value = value;
            best_index = index;
        }
    }
    best_index
}

fn normalize_probabilities(mut values: [f32; LANGUAGE_COUNT]) -> [f32; LANGUAGE_COUNT] {
    for value in &mut values {
        if !value.is_finite() || *value < 0.0 {
            *value = 0.0;
        }
    }
    let sum: f32 = values.iter().sum();
    if sum <= EPSILON {
        return [1.0 / LANGUAGE_COUNT as f32; LANGUAGE_COUNT];
    }
    values.map(|value| value / sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(at_ms: u64, ja: f32, en: f32, unknown: f32, unsupported: f32) -> Observation {
        Observation::from_probabilities(at_ms, [ja, en, unknown, unsupported], 1.0, true)
    }

    fn tracker() -> LanguageTracker {
        LanguageTracker::new(TrackerConfig {
            switch_llr_threshold: 2.5,
            ..TrackerConfig::default()
        })
        .unwrap()
    }

    fn lock_ja(tracker: &mut LanguageTracker) {
        assert!(tracker.push_observation(obs(0, 0.99, 0.005, 0.004, 0.001)));
        let events = tracker.advance_to(0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].to, Language::Ja);
    }

    #[test]
    fn language_indexes_are_stable() {
        assert_eq!(Language::Ja.index(), 0);
        assert_eq!(Language::Unsupported.index(), 3);
        assert_eq!(Language::ALL[Language::En.index()], Language::En);
    }

    #[test]
    fn observation_normalizes_probabilities_and_quality() {
        let observation = Observation::from_probabilities(10, [2.0, 1.0, 1.0, 0.0], 2.0, true);
        let probs = observation.log_scores.map(f32::exp);
        assert!((probs.iter().sum::<f32>() - 1.0).abs() < 1.0e-5);
        assert_eq!(observation.quality, 1.0);
        assert!(observation.speech);
    }

    #[test]
    fn invalid_probability_inputs_fall_back_safely() {
        let observation = Observation::from_probabilities(
            0,
            [f32::NAN, -1.0, f32::INFINITY, 0.0],
            -1.0,
            false,
        );
        let probs = observation.log_scores.map(f32::exp);
        for value in probs {
            assert!((value - 0.25).abs() < 1.0e-5);
        }
        assert_eq!(observation.quality, 0.0);
    }

    #[test]
    fn config_validation_rejects_invalid_shapes() {
        let default = TrackerConfig::default();
        assert_eq!(
            TrackerConfig {
                tracker_step_ms: 0,
                ..default
            }
            .validate(),
            Err(ConfigError::TrackerStepZero)
        );
        assert_eq!(
            TrackerConfig {
                hmm_self_probability: 0.2,
                ..default
            }
            .validate(),
            Err(ConfigError::InvalidSelfProbability)
        );
        assert_eq!(
            TrackerConfig {
                switch_llr_threshold: f32::NAN,
                ..default
            }
            .validate(),
            Err(ConfigError::InvalidSwitchThreshold)
        );
        assert_eq!(
            TrackerConfig {
                switch_posterior_threshold: 0.4,
                retain_posterior_threshold: 0.5,
                ..default
            }
            .validate(),
            Err(ConfigError::InvalidHysteresis)
        );
        assert_eq!(
            TrackerConfig {
                min_observation_quality: 2.0,
                ..default
            }
            .validate(),
            Err(ConfigError::InvalidMinimumQuality)
        );
        assert_eq!(default.validate(), Ok(default));
    }

    #[test]
    fn hmm_forward_prefers_stability_but_accepts_strong_evidence() {
        let previous = [0.95, 0.02, 0.02, 0.01];
        let stable = hmm_forward(
            previous,
            obs(0, 0.45, 0.44, 0.1, 0.01).log_scores,
            0.94,
        );
        assert!(stable[Language::Ja.index()] > stable[Language::En.index()]);
        let switched = hmm_forward(
            stable,
            obs(0, 0.01, 0.98, 0.005, 0.005).log_scores,
            0.94,
        );
        assert!(switched[Language::En.index()] > stable[Language::En.index()]);
    }

    #[test]
    fn initial_unknown_state_locks_to_confident_language() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        assert_eq!(tracker.state().stable_language, Language::Ja);
    }

    #[test]
    fn ambiguous_evidence_keeps_stable_language() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        for tick in [500, 1000, 1500, 2000] {
            tracker.push_observation(obs(tick, 0.42, 0.4, 0.17, 0.01));
            tracker.advance_to(tick);
        }
        assert_eq!(tracker.state().stable_language, Language::Ja);
        assert_eq!(tracker.state().candidate_language, None);
    }

    #[test]
    fn sustained_new_language_switches_without_fixed_duration_rule() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        let mut switch_at = None;
        for tick in [500, 1000, 1500, 2000, 2500] {
            tracker.push_observation(obs(tick, 0.01, 0.98, 0.005, 0.005));
            for event in tracker.advance_to(tick) {
                if event.to == Language::En {
                    switch_at = Some(event.at_ms);
                }
            }
            if switch_at.is_some() {
                break;
            }
        }
        assert!(switch_at.is_some_and(|at| at <= 2500));
        assert_eq!(tracker.state().stable_language, Language::En);
    }

    #[test]
    fn multiple_events_in_one_tick_are_coalesced() {
        let mut dense = tracker();
        lock_ja(&mut dense);
        for at in [100, 200, 300, 400, 500] {
            dense.push_observation(obs(at, 0.01, 0.98, 0.005, 0.005));
        }
        dense.advance_to(500);

        let mut sparse = tracker();
        lock_ja(&mut sparse);
        sparse.push_observation(obs(500, 0.01, 0.98, 0.005, 0.005));
        sparse.advance_to(500);

        assert_eq!(dense.state().stable_language, sparse.state().stable_language);
        for (a, b) in dense
            .state()
            .posterior
            .iter()
            .zip(sparse.state().posterior)
        {
            assert!((a - b).abs() < 1.0e-6);
        }
    }

    #[test]
    fn stale_observation_is_not_reapplied_across_ticks() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        tracker.push_observation(obs(500, 0.01, 0.98, 0.005, 0.005));
        tracker.advance_to(500);
        let after_one = tracker.state();
        tracker.advance_to(5_000);
        let after_idle = tracker.state();
        assert_eq!(after_idle.posterior, after_one.posterior);
        assert_eq!(after_idle.stable_language, Language::Ja);
        assert_eq!(after_idle.candidate_llr, 0.0);
    }

    #[test]
    fn future_observation_waits_for_its_tick() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        tracker.push_observation(obs(750, 0.01, 0.98, 0.005, 0.005));
        tracker.advance_to(500);
        let before = tracker.state().posterior;
        tracker.advance_to(1000);
        assert_ne!(tracker.state().posterior, before);
    }

    #[test]
    fn out_of_order_observation_is_rejected() {
        let mut tracker = tracker();
        assert!(tracker.push_observation(obs(500, 0.01, 0.98, 0.005, 0.005)));
        assert!(!tracker.push_observation(obs(100, 0.99, 0.005, 0.004, 0.001)));
    }

    #[test]
    fn low_quality_observation_is_ignored() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        let before = tracker.state();
        let mut weak = obs(500, 0.01, 0.98, 0.005, 0.005);
        weak.quality = 0.1;
        tracker.push_observation(weak);
        tracker.advance_to(500);
        assert_eq!(tracker.state().posterior, before.posterior);
    }

    #[test]
    fn silence_does_not_accumulate_switch_evidence() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        let mut english = obs(500, 0.01, 0.98, 0.005, 0.005);
        english.speech = false;
        tracker.push_observation(english);
        tracker.advance_to(500);
        assert_eq!(tracker.state().candidate_llr, 0.0);
    }

    #[test]
    fn switch_episode_expires_after_speech_gap() {
        let mut tracker = LanguageTracker::new(TrackerConfig {
            switch_llr_threshold: 100.0,
            max_switch_silence_ms: 500,
            ..TrackerConfig::default()
        })
        .unwrap();
        lock_ja(&mut tracker);
        tracker.push_observation(obs(500, 0.05, 0.9, 0.04, 0.01));
        tracker.advance_to(500);
        assert_eq!(tracker.state().candidate_language, Some(Language::En));
        tracker.advance_to(1500);
        assert_eq!(tracker.state().candidate_language, None);
    }

    #[test]
    fn reset_restores_unknown_state() {
        let mut tracker = tracker();
        lock_ja(&mut tracker);
        tracker.reset();
        assert_eq!(tracker.state().stable_language, Language::Unknown);
        assert_eq!(tracker.state().posterior, [0.0, 0.0, 1.0, 0.0]);
        assert_eq!(tracker.state().tick_at_ms, 0);
        assert!(tracker.advance_to(10_000).is_empty());
    }

    #[test]
    fn viterbi_handles_empty_sequence() {
        assert!(fixed_lag_viterbi(&[], 0.94).is_empty());
    }

    #[test]
    fn viterbi_smooths_single_ambiguous_frame() {
        let sequence = [
            [0.95, 0.02, 0.02, 0.01],
            [0.1, 0.75, 0.1, 0.05],
            [0.95, 0.02, 0.02, 0.01],
        ];
        assert_eq!(
            fixed_lag_viterbi(&sequence, 0.98),
            vec![Language::Ja, Language::Ja, Language::Ja]
        );
    }

    #[test]
    fn viterbi_follows_sustained_language_change() {
        let sequence = [
            [0.95, 0.02, 0.02, 0.01],
            [0.9, 0.05, 0.04, 0.01],
            [0.02, 0.95, 0.02, 0.01],
            [0.02, 0.95, 0.02, 0.01],
            [0.02, 0.95, 0.02, 0.01],
        ];
        let path = fixed_lag_viterbi(&sequence, 0.9);
        assert_eq!(path.first(), Some(&Language::Ja));
        assert_eq!(path.last(), Some(&Language::En));
    }

    #[test]
    fn normalization_preserves_valid_distribution_and_ties_are_stable() {
        assert_eq!(
            normalize_probabilities([0.4, 0.3, 0.2, 0.1]),
            [0.4, 0.3, 0.2, 0.1]
        );
        assert_eq!(argmax(&[0.5, 0.5, 0.0, 0.0]), Language::Ja);
    }
}
