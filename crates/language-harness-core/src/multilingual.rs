use std::collections::VecDeque;

const EPSILON: f32 = 1.0e-8;
const UNKNOWN_LANGUAGE: &str = "unknown";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MultilingualTrackerConfig {
    pub tracker_step_ms: u64,
    pub minimum_duration_ticks: usize,
    pub expected_duration_ticks: usize,
    pub maximum_duration_ticks: usize,
    pub sprt_accept_llr: f32,
    pub sprt_reject_llr: f32,
    pub maximum_llr_increment: f32,
    pub switch_posterior_threshold: f32,
    pub retain_posterior_threshold: f32,
    pub minimum_observation_quality: f32,
    pub maximum_pending_ticks: usize,
}

impl Default for MultilingualTrackerConfig {
    fn default() -> Self {
        Self {
            tracker_step_ms: 500,
            minimum_duration_ticks: 2,
            expected_duration_ticks: 8,
            maximum_duration_ticks: 40,
            sprt_accept_llr: 3.0,
            sprt_reject_llr: -1.5,
            maximum_llr_increment: 2.0,
            switch_posterior_threshold: 0.72,
            retain_posterior_threshold: 0.42,
            minimum_observation_quality: 0.2,
            maximum_pending_ticks: 16,
        }
    }
}

impl MultilingualTrackerConfig {
    pub fn validate(self) -> Result<Self, MultilingualConfigError> {
        if self.tracker_step_ms == 0 {
            return Err(MultilingualConfigError::TrackerStepZero);
        }
        if self.minimum_duration_ticks == 0
            || self.minimum_duration_ticks > self.expected_duration_ticks
            || self.expected_duration_ticks > self.maximum_duration_ticks
        {
            return Err(MultilingualConfigError::InvalidDurationBounds);
        }
        if !self.sprt_accept_llr.is_finite()
            || !self.sprt_reject_llr.is_finite()
            || self.sprt_accept_llr <= 0.0
            || self.sprt_reject_llr >= 0.0
        {
            return Err(MultilingualConfigError::InvalidSprtBoundaries);
        }
        if !self.maximum_llr_increment.is_finite() || self.maximum_llr_increment <= 0.0 {
            return Err(MultilingualConfigError::InvalidLlrIncrement);
        }
        if !(0.0..=1.0).contains(&self.switch_posterior_threshold)
            || !(0.0..=1.0).contains(&self.retain_posterior_threshold)
            || self.switch_posterior_threshold <= self.retain_posterior_threshold
        {
            return Err(MultilingualConfigError::InvalidHysteresis);
        }
        if !(0.0..=1.0).contains(&self.minimum_observation_quality) {
            return Err(MultilingualConfigError::InvalidMinimumQuality);
        }
        if self.maximum_pending_ticks == 0 {
            return Err(MultilingualConfigError::InvalidPendingCapacity);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MultilingualConfigError {
    TrackerStepZero,
    InvalidDurationBounds,
    InvalidSprtBoundaries,
    InvalidLlrIncrement,
    InvalidHysteresis,
    InvalidMinimumQuality,
    InvalidPendingCapacity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MultilingualTrackerError {
    TooFewLanguages,
    DuplicateLanguage,
    MissingUnknownLanguage,
    ProbabilityCountMismatch { expected: usize, actual: usize },
    InvalidConfig(MultilingualConfigError),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MultilingualObservation {
    pub at_ms: u64,
    pub log_scores: Vec<f32>,
    pub quality: f32,
    pub speech: bool,
}

impl MultilingualObservation {
    pub fn from_probabilities(
        at_ms: u64,
        probabilities: Vec<f32>,
        quality: f32,
        speech: bool,
    ) -> Self {
        let normalized = normalize_probabilities(probabilities);
        Self {
            at_ms,
            log_scores: normalized
                .into_iter()
                .map(|probability| probability.max(EPSILON).ln())
                .collect(),
            quality: quality.clamp(0.0, 1.0),
            speech,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MultilingualPushResult {
    Enqueued,
    Coalesced,
    OutOfOrder,
    Backpressure,
    ProbabilityCountMismatch,
}

impl MultilingualPushResult {
    pub const fn is_accepted(self) -> bool {
        matches!(self, Self::Enqueued | Self::Coalesced)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MultilingualSwitchEvent {
    pub at_ms: u64,
    pub from_index: usize,
    pub to_index: usize,
    pub sprt_llr: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MultilingualTrackerState {
    pub stable_index: usize,
    pub stable_confidence: f32,
    pub candidate_index: Option<usize>,
    pub sprt_llr: f32,
    pub posterior: Vec<f32>,
    pub tick_at_ms: u64,
    pub hsmm_duration_ticks: usize,
    pub hsmm_transition_hazard: f32,
    pub sprt_accept_llr: f32,
    pub sprt_reject_llr: f32,
    pub hysteresis_enter_posterior: f32,
    pub hysteresis_retain_posterior: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SprtEpisode {
    candidate_index: usize,
    llr: f32,
}

#[derive(Debug)]
pub struct MultilingualTracker {
    labels: Vec<String>,
    config: MultilingualTrackerConfig,
    hsmm_joint: Vec<f32>,
    posterior: Vec<f32>,
    stable_index: usize,
    pending: VecDeque<MultilingualObservation>,
    last_enqueued_at_ms: Option<u64>,
    next_tick_ms: Option<u64>,
    last_tick_ms: u64,
    sprt_episode: Option<SprtEpisode>,
}

impl MultilingualTracker {
    pub fn new(
        labels: Vec<String>,
        config: MultilingualTrackerConfig,
    ) -> Result<Self, MultilingualTrackerError> {
        let config = config.validate().map_err(MultilingualTrackerError::InvalidConfig)?;
        if labels.len() < 2 {
            return Err(MultilingualTrackerError::TooFewLanguages);
        }
        if labels.iter().enumerate().any(|(index, label)| {
            labels.iter().skip(index.saturating_add(1)).any(|other| label == other)
        }) {
            return Err(MultilingualTrackerError::DuplicateLanguage);
        }
        let Some(stable_index) = labels.iter().position(|label| label == UNKNOWN_LANGUAGE) else {
            return Err(MultilingualTrackerError::MissingUnknownLanguage);
        };
        let mut hsmm_joint = vec![0.0; labels.len() * config.maximum_duration_ticks];
        hsmm_joint[joint_index(stable_index, 1, config.maximum_duration_ticks)] = 1.0;
        let mut posterior = vec![0.0; labels.len()];
        posterior[stable_index] = 1.0;
        Ok(Self {
            labels,
            config,
            hsmm_joint,
            posterior,
            stable_index,
            pending: VecDeque::new(),
            last_enqueued_at_ms: None,
            next_tick_ms: None,
            last_tick_ms: 0,
            sprt_episode: None,
        })
    }

    pub fn labels(&self) -> &[String] {
        &self.labels
    }

    pub fn push_observation(
        &mut self,
        observation: MultilingualObservation,
    ) -> MultilingualPushResult {
        if observation.log_scores.len() != self.labels.len() {
            return MultilingualPushResult::ProbabilityCountMismatch;
        }
        if self.last_enqueued_at_ms.is_some_and(|last| observation.at_ms < last) {
            return MultilingualPushResult::OutOfOrder;
        }
        self.next_tick_ms.get_or_insert(observation.at_ms);
        let scheduled_tick = self.scheduled_tick_for(observation.at_ms);
        if self
            .pending
            .back()
            .is_some_and(|previous| self.scheduled_tick_for(previous.at_ms) == scheduled_tick)
        {
            if let Some(previous) = self.pending.back_mut() {
                *previous = observation;
            }
            self.last_enqueued_at_ms = Some(self.pending.back().map_or(0, |item| item.at_ms));
            return MultilingualPushResult::Coalesced;
        }
        if self.pending.len() >= self.config.maximum_pending_ticks {
            return MultilingualPushResult::Backpressure;
        }
        self.last_enqueued_at_ms = Some(observation.at_ms);
        self.pending.push_back(observation);
        MultilingualPushResult::Enqueued
    }

    pub fn advance_to(&mut self, target_ms: u64) -> Vec<MultilingualSwitchEvent> {
        let mut events = Vec::new();
        while let Some(tick_ms) = self.next_tick_ms {
            if tick_ms > target_ms {
                break;
            }
            if let Some(observation) = self.take_latest_observation_for_tick(tick_ms)
                && let Some(event) = self.advance_tick(tick_ms, &observation)
            {
                events.push(event);
            }
            self.last_tick_ms = tick_ms;
            self.next_tick_ms = Some(tick_ms.saturating_add(self.config.tracker_step_ms));
        }
        events
    }

    pub fn state(&self) -> MultilingualTrackerState {
        let duration_ticks = conditional_duration_ticks(
            &self.hsmm_joint,
            self.stable_index,
            self.config.maximum_duration_ticks,
        );
        MultilingualTrackerState {
            stable_index: self.stable_index,
            stable_confidence: self.posterior[self.stable_index],
            candidate_index: self.sprt_episode.map(|episode| episode.candidate_index),
            sprt_llr: self.sprt_episode.map_or(0.0, |episode| episode.llr),
            posterior: self.posterior.clone(),
            tick_at_ms: self.last_tick_ms,
            hsmm_duration_ticks: duration_ticks,
            hsmm_transition_hazard: duration_hazard(duration_ticks, self.config),
            sprt_accept_llr: self.config.sprt_accept_llr,
            sprt_reject_llr: self.config.sprt_reject_llr,
            hysteresis_enter_posterior: self.config.switch_posterior_threshold,
            hysteresis_retain_posterior: self.config.retain_posterior_threshold,
        }
    }

    pub fn reset(&mut self) {
        let unknown_index = self.stable_unknown_index();
        self.hsmm_joint.fill(0.0);
        self.hsmm_joint[joint_index(unknown_index, 1, self.config.maximum_duration_ticks)] = 1.0;
        self.posterior.fill(0.0);
        self.stable_index = unknown_index;
        self.posterior[self.stable_index] = 1.0;
        self.pending.clear();
        self.last_enqueued_at_ms = None;
        self.next_tick_ms = None;
        self.last_tick_ms = 0;
        self.sprt_episode = None;
    }

    fn stable_unknown_index(&self) -> usize {
        self.labels.iter().position(|label| label == UNKNOWN_LANGUAGE).unwrap_or(0)
    }

    fn scheduled_tick_for(&self, at_ms: u64) -> u64 {
        let next_tick = self.next_tick_ms.unwrap_or(at_ms);
        if at_ms <= next_tick {
            return next_tick;
        }
        let delta = at_ms - next_tick;
        let steps = delta.div_ceil(self.config.tracker_step_ms);
        next_tick.saturating_add(steps.saturating_mul(self.config.tracker_step_ms))
    }

    fn take_latest_observation_for_tick(
        &mut self,
        tick_ms: u64,
    ) -> Option<MultilingualObservation> {
        let mut latest = None;
        while self.pending.front().is_some_and(|item| item.at_ms <= tick_ms) {
            latest = self.pending.pop_front();
        }
        latest
    }

    fn advance_tick(
        &mut self,
        tick_ms: u64,
        observation: &MultilingualObservation,
    ) -> Option<MultilingualSwitchEvent> {
        if observation.quality < self.config.minimum_observation_quality {
            return None;
        }
        self.hsmm_joint = hsmm_forward(
            &self.hsmm_joint,
            &observation.log_scores,
            self.labels.len(),
            self.stable_unknown_index(),
            self.config,
        );
        self.posterior = marginalize_states(
            &self.hsmm_joint,
            self.labels.len(),
            self.config.maximum_duration_ticks,
        );
        if !observation.speech {
            self.sprt_episode = None;
            return None;
        }
        let candidate_index = argmax_index(&self.posterior);
        if self.stable_index == self.stable_unknown_index() {
            return self.try_lock_initial_language(tick_ms, candidate_index);
        }
        if candidate_index == self.stable_index
            || self.posterior[candidate_index] < self.config.retain_posterior_threshold
        {
            self.sprt_episode = None;
            return None;
        }
        let raw_increment =
            observation.log_scores[candidate_index] - observation.log_scores[self.stable_index];
        let increment = raw_increment
            .clamp(-self.config.maximum_llr_increment, self.config.maximum_llr_increment);
        let mut episode = match self.sprt_episode {
            Some(existing) if existing.candidate_index == candidate_index => existing,
            _ => SprtEpisode { candidate_index, llr: 0.0 },
        };
        episode.llr += increment;
        if episode.llr <= self.config.sprt_reject_llr {
            self.sprt_episode = None;
            return None;
        }
        self.sprt_episode = Some(episode);
        if episode.llr < self.config.sprt_accept_llr
            || self.posterior[candidate_index] < self.config.switch_posterior_threshold
        {
            return None;
        }
        let from_index = self.stable_index;
        self.stable_index = candidate_index;
        self.sprt_episode = None;
        Some(MultilingualSwitchEvent {
            at_ms: tick_ms,
            from_index,
            to_index: candidate_index,
            sprt_llr: episode.llr,
        })
    }

    fn try_lock_initial_language(
        &mut self,
        tick_ms: u64,
        candidate_index: usize,
    ) -> Option<MultilingualSwitchEvent> {
        if candidate_index == self.stable_unknown_index()
            || self.posterior[candidate_index] < self.config.switch_posterior_threshold
        {
            return None;
        }
        let from_index = self.stable_index;
        self.stable_index = candidate_index;
        Some(MultilingualSwitchEvent {
            at_ms: tick_ms,
            from_index,
            to_index: candidate_index,
            sprt_llr: 0.0,
        })
    }
}

fn hsmm_forward(
    previous: &[f32],
    observation_log_scores: &[f32],
    language_count: usize,
    unknown_index: usize,
    config: MultilingualTrackerConfig,
) -> Vec<f32> {
    let maximum_duration = config.maximum_duration_ticks;
    let mut predicted = vec![0.0; previous.len()];
    for source in 0..language_count {
        for duration in 1..=maximum_duration {
            let mass = previous[joint_index(source, duration, maximum_duration)];
            if mass <= 0.0 {
                continue;
            }
            let hazard =
                if source == unknown_index { 1.0 } else { duration_hazard(duration, config) };
            if duration < maximum_duration {
                predicted[joint_index(source, duration + 1, maximum_duration)] +=
                    mass * (1.0 - hazard);
            }
            let switch_mass = mass * hazard / (language_count.saturating_sub(1) as f32);
            for destination in 0..language_count {
                if destination != source {
                    predicted[joint_index(destination, 1, maximum_duration)] += switch_mass;
                }
            }
        }
    }
    for language in 0..language_count {
        let emission = observation_log_scores[language].exp().max(EPSILON);
        for duration in 1..=maximum_duration {
            predicted[joint_index(language, duration, maximum_duration)] *= emission;
        }
    }
    normalize_probabilities(predicted)
}

fn marginalize_states(joint: &[f32], language_count: usize, maximum_duration: usize) -> Vec<f32> {
    (0..language_count)
        .map(|language| {
            (1..=maximum_duration)
                .map(|duration| joint[joint_index(language, duration, maximum_duration)])
                .sum()
        })
        .collect()
}

fn conditional_duration_ticks(joint: &[f32], language: usize, maximum_duration: usize) -> usize {
    let state_mass: f32 = (1..=maximum_duration)
        .map(|duration| joint[joint_index(language, duration, maximum_duration)])
        .sum();
    if state_mass <= EPSILON {
        return 1;
    }
    let weighted: f32 = (1..=maximum_duration)
        .map(|duration| joint[joint_index(language, duration, maximum_duration)] * duration as f32)
        .sum();
    (weighted / state_mass).round().clamp(1.0, maximum_duration as f32) as usize
}

fn duration_hazard(duration: usize, config: MultilingualTrackerConfig) -> f32 {
    if duration < config.minimum_duration_ticks {
        return 0.0;
    }
    if duration >= config.maximum_duration_ticks {
        return 1.0;
    }
    1.0 / (config.expected_duration_ticks - config.minimum_duration_ticks + 1) as f32
}

fn joint_index(language: usize, duration: usize, maximum_duration: usize) -> usize {
    language * maximum_duration + duration.saturating_sub(1)
}

fn argmax_index(values: &[f32]) -> usize {
    values
        .iter()
        .copied()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map_or(0, |(index, _)| index)
}

fn normalize_probabilities(mut values: Vec<f32>) -> Vec<f32> {
    values.iter_mut().for_each(|value| {
        if !value.is_finite() || *value < 0.0 {
            *value = 0.0;
        }
    });
    let sum: f32 = values.iter().sum();
    if sum <= EPSILON {
        let uniform = 1.0 / values.len().max(1) as f32;
        return vec![uniform; values.len()];
    }
    values.iter_mut().for_each(|value| *value /= sum);
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> Vec<String> {
        vec!["unknown".into(), "ja".into(), "en".into(), "ko".into()]
    }

    fn observation(at_ms: u64, probabilities: [f32; 4]) -> MultilingualObservation {
        MultilingualObservation::from_probabilities(at_ms, probabilities.to_vec(), 1.0, true)
    }

    fn fast_config() -> MultilingualTrackerConfig {
        MultilingualTrackerConfig {
            minimum_duration_ticks: 1,
            expected_duration_ticks: 2,
            maximum_duration_ticks: 8,
            sprt_accept_llr: 2.5,
            ..MultilingualTrackerConfig::default()
        }
    }

    #[test]
    fn validates_configuration_boundaries() {
        assert_eq!(
            MultilingualTrackerConfig {
                tracker_step_ms: 0,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::TrackerStepZero)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                minimum_duration_ticks: 4,
                expected_duration_ticks: 3,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidDurationBounds)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                sprt_accept_llr: -1.0,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidSprtBoundaries)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                maximum_llr_increment: 0.0,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidLlrIncrement)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                switch_posterior_threshold: 0.3,
                retain_posterior_threshold: 0.4,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidHysteresis)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                minimum_observation_quality: 1.1,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidMinimumQuality)
        );
        assert_eq!(
            MultilingualTrackerConfig {
                maximum_pending_ticks: 0,
                ..MultilingualTrackerConfig::default()
            }
            .validate(),
            Err(MultilingualConfigError::InvalidPendingCapacity)
        );
    }

    #[test]
    fn rejects_invalid_language_sets() {
        assert_eq!(
            MultilingualTracker::new(vec!["unknown".into()], fast_config()).unwrap_err(),
            MultilingualTrackerError::TooFewLanguages
        );
        assert_eq!(
            MultilingualTracker::new(vec!["unknown".into(), "unknown".into()], fast_config())
                .unwrap_err(),
            MultilingualTrackerError::DuplicateLanguage
        );
        assert_eq!(
            MultilingualTracker::new(vec!["ja".into(), "en".into()], fast_config()).unwrap_err(),
            MultilingualTrackerError::MissingUnknownLanguage
        );
    }

    #[test]
    fn normalizes_invalid_probabilities_and_quality() {
        let item = MultilingualObservation::from_probabilities(
            10,
            vec![f32::NAN, -1.0, f32::INFINITY, 0.0],
            2.0,
            false,
        );
        assert_eq!(item.log_scores.len(), 4);
        assert!((item.log_scores[0].exp() - 0.25).abs() < 0.0001);
        assert_eq!(item.quality, 1.0);
        assert!(!item.speech);
    }

    #[test]
    fn online_hsmm_enforces_minimum_duration_and_exposes_hazard() {
        let config = MultilingualTrackerConfig {
            minimum_duration_ticks: 3,
            expected_duration_ticks: 4,
            maximum_duration_ticks: 6,
            ..fast_config()
        };
        assert_eq!(duration_hazard(1, config), 0.0);
        assert_eq!(duration_hazard(2, config), 0.0);
        assert_eq!(duration_hazard(3, config), 0.5);
        assert_eq!(duration_hazard(6, config), 1.0);
    }

    #[test]
    fn locks_and_switches_across_more_than_two_languages() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        assert_eq!(
            tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01])),
            MultilingualPushResult::Enqueued
        );
        assert_eq!(tracker.advance_to(0)[0].to_index, 1);
        assert_eq!(tracker.state().stable_index, 1);
        tracker.push_observation(observation(500, [0.01, 0.01, 0.01, 0.97]));
        assert!(tracker.advance_to(500).is_empty());
        tracker.push_observation(observation(1000, [0.01, 0.01, 0.01, 0.97]));
        let mut events = tracker.advance_to(1000);
        tracker.push_observation(observation(1500, [0.01, 0.01, 0.01, 0.97]));
        events.extend(tracker.advance_to(1500));
        tracker.push_observation(observation(2000, [0.01, 0.01, 0.01, 0.97]));
        events.extend(tracker.advance_to(2000));
        tracker.push_observation(observation(2500, [0.01, 0.01, 0.01, 0.97]));
        events.extend(tracker.advance_to(2500));
        tracker.push_observation(observation(3000, [0.01, 0.01, 0.01, 0.97]));
        events.extend(tracker.advance_to(3000));
        assert_eq!(events[0].from_index, 1);
        assert_eq!(events[0].to_index, 3);
        assert_eq!(tracker.state().stable_index, 3);
    }

    #[test]
    fn sprt_reject_boundary_clears_a_weak_candidate() {
        let config = MultilingualTrackerConfig {
            sprt_reject_llr: -0.25,
            retain_posterior_threshold: 0.01,
            ..fast_config()
        };
        let mut tracker = MultilingualTracker::new(labels(), config).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        tracker.push_observation(observation(500, [0.01, 0.45, 0.53, 0.01]));
        tracker.advance_to(500);
        tracker.push_observation(observation(1000, [0.01, 0.60, 0.38, 0.01]));
        tracker.advance_to(1000);
        assert_eq!(tracker.state().candidate_index, None);
        assert_eq!(tracker.state().sprt_llr, 0.0);
    }

    #[test]
    fn single_extreme_frame_cannot_cross_clamped_sprt_boundary() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        tracker.push_observation(observation(500, [0.001, 0.001, 0.997, 0.001]));
        assert!(tracker.advance_to(500).is_empty());
        assert_eq!(tracker.state().stable_index, 1);
        assert!(tracker.state().sprt_llr <= 2.0);
    }

    #[test]
    fn queue_coalesces_rejects_order_and_applies_backpressure() {
        let config = MultilingualTrackerConfig { maximum_pending_ticks: 1, ..fast_config() };
        let mut tracker = MultilingualTracker::new(labels(), config).unwrap();
        assert_eq!(
            tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01])),
            MultilingualPushResult::Enqueued
        );
        assert_eq!(
            tracker.push_observation(observation(100, [0.01, 0.96, 0.02, 0.01])),
            MultilingualPushResult::Backpressure
        );
        tracker.advance_to(0);
        assert_eq!(
            tracker.push_observation(observation(500, [0.01, 0.95, 0.03, 0.01])),
            MultilingualPushResult::Enqueued
        );
        assert_eq!(
            tracker.push_observation(observation(450, [0.01, 0.95, 0.03, 0.01])),
            MultilingualPushResult::OutOfOrder
        );
        assert_eq!(
            tracker.push_observation(MultilingualObservation::from_probabilities(
                500,
                vec![0.5, 0.5],
                1.0,
                true
            )),
            MultilingualPushResult::ProbabilityCountMismatch
        );
    }

    #[test]
    fn same_tick_observation_is_coalesced() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        assert_eq!(
            tracker.push_observation(observation(400, [0.01, 0.90, 0.08, 0.01])),
            MultilingualPushResult::Enqueued
        );
        assert_eq!(
            tracker.push_observation(observation(500, [0.01, 0.80, 0.18, 0.01])),
            MultilingualPushResult::Coalesced
        );
    }

    #[test]
    fn low_quality_and_silence_do_not_accumulate_sprt_evidence() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        let mut low_quality = observation(500, [0.01, 0.01, 0.97, 0.01]);
        low_quality.quality = 0.1;
        tracker.push_observation(low_quality);
        tracker.advance_to(500);
        let mut silence = observation(1000, [0.01, 0.01, 0.97, 0.01]);
        silence.speech = false;
        tracker.push_observation(silence);
        tracker.advance_to(1000);
        assert_eq!(tracker.state().stable_index, 1);
        assert_eq!(tracker.state().candidate_index, None);
    }

    #[test]
    fn diagnostics_report_hsmm_sprt_and_hysteresis_values() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        let state = tracker.state();
        assert_eq!(tracker.labels(), &["unknown", "ja", "en", "ko"]);
        assert_eq!(state.sprt_accept_llr, 2.5);
        assert_eq!(state.sprt_reject_llr, -1.5);
        assert_eq!(state.hysteresis_enter_posterior, 0.72);
        assert_eq!(state.hysteresis_retain_posterior, 0.42);
        assert!(state.hsmm_duration_ticks >= 1);
        assert!((0.0..=1.0).contains(&state.hsmm_transition_hazard));
    }

    #[test]
    fn reset_restores_unknown_and_clears_pending_state() {
        let mut tracker = MultilingualTracker::new(labels(), fast_config()).unwrap();
        tracker.push_observation(observation(0, [0.01, 0.97, 0.01, 0.01]));
        tracker.advance_to(0);
        tracker.push_observation(observation(500, [0.01, 0.01, 0.97, 0.01]));
        tracker.reset();
        assert_eq!(tracker.state().stable_index, 0);
        assert_eq!(tracker.state().posterior, vec![1.0, 0.0, 0.0, 0.0]);
        assert!(tracker.advance_to(10_000).is_empty());
    }
}
