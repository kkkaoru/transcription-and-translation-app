#![forbid(unsafe_code)]

use std::{
    collections::{HashMap, VecDeque},
    error::Error,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Instant,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use language_harness_core::multilingual::{
    MultilingualObservation, MultilingualTracker, MultilingualTrackerConfig,
};
use ort::{inputs, session::Session, value::TensorRef};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

const DEFAULT_PORT: u16 = 8080;
const SAMPLE_RATE_HZ: usize = 16_000;
const MAXIMUM_AUDIO_SECONDS: usize = 30;
const MAXIMUM_AUDIO_BYTES: usize = SAMPLE_RATE_HZ * MAXIMUM_AUDIO_SECONDS * size_of::<f32>();
const MINIMUM_AUDIO_SAMPLES: usize = SAMPLE_RATE_HZ / 2;
const ROLLING_WINDOW_SAMPLES: usize = SAMPLE_RATE_HZ * 6;
const PREFERRED_CONTEXT_SAMPLES: usize = SAMPLE_RATE_HZ * 3;
const MINIMUM_AUDIBLE_RMS: f32 = 0.02;
const UNKNOWN_CONFIDENCE_BOUNDARY: f32 = 0.55;
const UNKNOWN_QUALITY_WEIGHT: f32 = 0.70;
const TOP_LANGUAGE_COUNT: usize = 8;
const SESSION_ID_HEADER: &str = "x-kotoba-session-id";
const ECAPA_MODEL_FILE: &str = "lang-id-ecapa.onnx";
const AMBERNET_MODEL_FILE: &str = "ambernet.onnx";
const LABELS_FILE: &str = "labels.json";
const AMBERNET_PREPROCESSOR_FILE: &str = "preprocessor.json";
const WORKERS_AI_NOVA_MODEL: &str = "@cf/deepgram/nova-3";
const RESPONSIVE_ACCEPT_LLR: f32 = 2.0;
const RESPONSIVE_REJECT_LLR: f32 = -1.5;
const MINIMUM_ACCEPT_LLR: f32 = 0.25;
const MAXIMUM_ACCEPT_LLR: f32 = 10.0;
const MINIMUM_REJECT_LLR: f32 = -10.0;
const MAXIMUM_REJECT_LLR: f32 = -0.1;
const MINIMUM_ERROR_PROBABILITY: f32 = 0.001;
const MAXIMUM_ERROR_PROBABILITY: f32 = 0.4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ModelKind {
    SpeechbrainEcapa,
    NvidiaAmbernet,
}

impl ModelKind {
    fn from_environment() -> Self {
        match std::env::var("LANGUAGE_MODEL_KIND").as_deref() {
            Ok("nvidia-ambernet") => Self::NvidiaAmbernet,
            _ => Self::SpeechbrainEcapa,
        }
    }

    const fn model_name(self) -> &'static str {
        match self {
            Self::SpeechbrainEcapa => "speechbrain/lang-id-voxlingua107-ecapa",
            Self::NvidiaAmbernet => "nvidia/nemo-langid-ambernet",
        }
    }

    const fn model_file(self) -> &'static str {
        match self {
            Self::SpeechbrainEcapa => ECAPA_MODEL_FILE,
            Self::NvidiaAmbernet => AMBERNET_MODEL_FILE,
        }
    }
}

#[derive(Clone)]
struct AppState {
    runtime: RuntimeHandle,
    model_kind: ModelKind,
    language_count: usize,
}

#[derive(Clone)]
struct RuntimeHandle {
    sender: mpsc::Sender<RuntimeCommand>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EcapaPattern {
    Utterance,
    RollingContext,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DecisionMode {
    Responsive,
    Wald,
    Custom,
    HysteresisOnly,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
enum DecisionPolicyRequest {
    Responsive,
    Wald {
        false_switch_probability: f32,
        missed_switch_probability: f32,
    },
    Custom {
        accept_llr: f32,
        reject_llr: f32,
    },
    #[default]
    HysteresisOnly,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ResolvedDecisionPolicy {
    mode: DecisionMode,
    sprt_enabled: bool,
    accept_llr: f32,
    reject_llr: f32,
}

#[derive(Debug, Deserialize)]
struct InferQuery {
    at_ms: u64,
    pattern: EcapaPattern,
    decision_policy: Option<String>,
}

#[derive(Debug)]
struct InferInput {
    session_id: String,
    at_ms: u64,
    pattern: EcapaPattern,
    decision_policy: ResolvedDecisionPolicy,
    samples: Vec<f32>,
}

#[derive(Debug)]
struct TrackInput {
    session_id: String,
    request: ProviderTrackRequest,
}

#[derive(Debug)]
enum RuntimeCommand {
    Warmup { response: oneshot::Sender<Result<WarmupResponse, ServiceError>> },
    Infer { input: InferInput, response: oneshot::Sender<Result<InferenceResponse, ServiceError>> },
    Track { input: TrackInput, response: oneshot::Sender<Result<InferenceResponse, ServiceError>> },
    Reset { session_id: String, response: oneshot::Sender<()> },
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    model: &'static str,
    languages: usize,
    tracker: &'static str,
}

#[derive(Debug, Serialize)]
struct WarmupResponse {
    ok: bool,
    model_load_ms: f64,
    languages: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LanguageProbability {
    language: String,
    probability: f32,
}

#[derive(Debug, Deserialize)]
struct ProviderTrackRequest {
    at_ms: u64,
    pattern: EcapaPattern,
    decision_policy: Option<DecisionPolicyRequest>,
    raw_languages: Vec<LanguageProbability>,
    quality: f32,
    speech_seconds: f32,
    inference_ms: f64,
    model: String,
}

struct TrackerUpdate<'a> {
    session_id: &'a str,
    at_ms: u64,
    decision_policy: ResolvedDecisionPolicy,
    raw_probabilities: &'a [f32],
    quality: f32,
}

struct TrackerSnapshot {
    stable_language: String,
    stable_confidence: f32,
    candidate_language: Option<String>,
    challenger_language: Option<String>,
    challenger_posterior: f32,
    posterior: Vec<LanguageProbability>,
    hsmm_duration_ticks: usize,
    hsmm_transition_hazard: f32,
    sprt_enabled: bool,
    decision_mode: DecisionMode,
    sprt_llr: f32,
    sprt_accept_llr: f32,
    sprt_reject_llr: f32,
    sprt_state: SprtState,
    hysteresis_enter_posterior: f32,
    hysteresis_retain_posterior: f32,
    hysteresis_state: HysteresisState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SprtState {
    Disabled,
    Idle,
    Accumulating,
    Accepted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HysteresisState {
    Unlocked,
    Retaining,
    Challenged,
    Switched,
}

#[derive(Debug, Serialize)]
struct HsmmDiagnostics {
    duration_ticks: usize,
    transition_hazard: f32,
    posterior: Vec<LanguageProbability>,
}

#[derive(Debug, Serialize)]
struct SprtDiagnostics {
    enabled: bool,
    mode: DecisionMode,
    candidate_language: Option<String>,
    llr: f32,
    accept_llr: f32,
    reject_llr: f32,
    state: SprtState,
}

#[derive(Debug, Serialize)]
struct HysteresisDiagnostics {
    stable_posterior: f32,
    enter_posterior: f32,
    retain_posterior: f32,
    state: HysteresisState,
    challenger_language: Option<String>,
    challenger_posterior: f32,
}

#[derive(Debug, Serialize)]
struct InferenceResponse {
    session_id: String,
    stable_language: String,
    stable_confidence: f32,
    raw_languages: Vec<LanguageProbability>,
    hsmm: HsmmDiagnostics,
    sprt: SprtDiagnostics,
    hysteresis: HysteresisDiagnostics,
    quality: f32,
    speech_seconds: f32,
    inference_ms: f64,
    model: String,
    pattern: EcapaPattern,
}

#[derive(Debug)]
struct RuntimeService {
    model_kind: ModelKind,
    model_path: PathBuf,
    labels: Vec<String>,
    model: Option<AcousticModel>,
    sessions: HashMap<String, LanguageSession>,
}

#[derive(Debug)]
struct LanguageSession {
    decision_policy: ResolvedDecisionPolicy,
    tracker: MultilingualTracker,
    rolling_samples: VecDeque<f32>,
}

struct AcousticModel {
    kind: ModelKind,
    session: Session,
    ambernet_preprocessor: Option<AmbernetPreprocessor>,
}

#[derive(Debug, Deserialize)]
struct AmbernetPreprocessorConfig {
    n_fft: usize,
    hop_length: usize,
    pad_to: usize,
    preemphasis: f32,
    log_zero_guard: f32,
    window: Vec<f32>,
    filter_bank: Vec<Vec<f32>>,
}

struct AmbernetPreprocessor {
    config: AmbernetPreprocessorConfig,
    cosine_basis: Vec<f32>,
    sine_basis: Vec<f32>,
}

impl std::fmt::Debug for AmbernetPreprocessor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AmbernetPreprocessor")
            .field("n_fft", &self.config.n_fft)
            .field("mel_bins", &self.config.filter_bank.len())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for AcousticModel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AcousticModel").finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ServiceError {
    status: StatusCode,
    message: String,
}

impl ServiceError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self { status: StatusCode::SERVICE_UNAVAILABLE, message: message.into() }
    }
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        (self.status, axum::Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

impl DecisionPolicyRequest {
    fn resolve(self) -> Result<ResolvedDecisionPolicy, ServiceError> {
        match self {
            Self::Responsive => Ok(ResolvedDecisionPolicy {
                mode: DecisionMode::Responsive,
                sprt_enabled: true,
                accept_llr: RESPONSIVE_ACCEPT_LLR,
                reject_llr: RESPONSIVE_REJECT_LLR,
            }),
            Self::Wald { false_switch_probability, missed_switch_probability } => {
                validate_error_probability(false_switch_probability, "False-switch probability")?;
                validate_error_probability(missed_switch_probability, "Missed-switch probability")?;
                Ok(ResolvedDecisionPolicy {
                    mode: DecisionMode::Wald,
                    sprt_enabled: true,
                    accept_llr: ((1.0 - missed_switch_probability) / false_switch_probability).ln(),
                    reject_llr: (missed_switch_probability / (1.0 - false_switch_probability)).ln(),
                })
            }
            Self::Custom { accept_llr, reject_llr } => {
                validate_custom_bound(
                    accept_llr,
                    MINIMUM_ACCEPT_LLR,
                    MAXIMUM_ACCEPT_LLR,
                    "accept",
                )?;
                validate_custom_bound(
                    reject_llr,
                    MINIMUM_REJECT_LLR,
                    MAXIMUM_REJECT_LLR,
                    "reject",
                )?;
                Ok(ResolvedDecisionPolicy {
                    mode: DecisionMode::Custom,
                    sprt_enabled: true,
                    accept_llr,
                    reject_llr,
                })
            }
            Self::HysteresisOnly => Ok(ResolvedDecisionPolicy {
                mode: DecisionMode::HysteresisOnly,
                sprt_enabled: false,
                accept_llr: RESPONSIVE_ACCEPT_LLR,
                reject_llr: RESPONSIVE_REJECT_LLR,
            }),
        }
    }
}

fn validate_error_probability(value: f32, label: &str) -> Result<(), ServiceError> {
    if !value.is_finite()
        || !(MINIMUM_ERROR_PROBABILITY..=MAXIMUM_ERROR_PROBABILITY).contains(&value)
    {
        return Err(ServiceError::bad_request(format!(
            "{label} must be between {MINIMUM_ERROR_PROBABILITY} and {MAXIMUM_ERROR_PROBABILITY}",
        )));
    }
    Ok(())
}

fn validate_custom_bound(
    value: f32,
    minimum: f32,
    maximum: f32,
    label: &str,
) -> Result<(), ServiceError> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return Err(ServiceError::bad_request(format!(
            "Custom SPRT {label} boundary must be between {minimum} and {maximum}",
        )));
    }
    Ok(())
}

fn decision_policy_from_query(value: Option<&str>) -> Result<ResolvedDecisionPolicy, ServiceError> {
    let request = value.map_or(Ok(DecisionPolicyRequest::default()), |json| {
        serde_json::from_str(json).map_err(|error| {
            ServiceError::bad_request(format!("Decision policy is invalid: {error}"))
        })
    })?;
    request.resolve()
}

impl RuntimeHandle {
    async fn warmup(&self) -> Result<WarmupResponse, ServiceError> {
        let (response, receiver) = oneshot::channel();
        self.sender.send(RuntimeCommand::Warmup { response }).map_err(|error| {
            ServiceError::unavailable(format!("Inference runtime stopped: {error}"))
        })?;
        receiver.await.map_err(|error| {
            ServiceError::unavailable(format!("Inference response dropped: {error}"))
        })?
    }

    async fn infer(&self, input: InferInput) -> Result<InferenceResponse, ServiceError> {
        let (response, receiver) = oneshot::channel();
        self.sender.send(RuntimeCommand::Infer { input, response }).map_err(|error| {
            ServiceError::unavailable(format!("Inference runtime stopped: {error}"))
        })?;
        receiver.await.map_err(|error| {
            ServiceError::unavailable(format!("Inference response dropped: {error}"))
        })?
    }

    async fn track(&self, input: TrackInput) -> Result<InferenceResponse, ServiceError> {
        let (response, receiver) = oneshot::channel();
        self.sender.send(RuntimeCommand::Track { input, response }).map_err(|error| {
            ServiceError::unavailable(format!("Tracker runtime stopped: {error}"))
        })?;
        receiver.await.map_err(|error| {
            ServiceError::unavailable(format!("Tracker response dropped: {error}"))
        })?
    }

    async fn reset(&self, session_id: String) -> Result<(), ServiceError> {
        let (response, receiver) = oneshot::channel();
        self.sender.send(RuntimeCommand::Reset { session_id, response }).map_err(|error| {
            ServiceError::unavailable(format!("Tracker runtime stopped: {error}"))
        })?;
        receiver.await.map_err(|error| {
            ServiceError::unavailable(format!("Tracker reset response dropped: {error}"))
        })
    }
}

impl RuntimeService {
    fn new(model_dir: &Path, model_kind: ModelKind) -> Result<Self, Box<dyn Error>> {
        let labels_path = model_dir.join(LABELS_FILE);
        let labels_json = fs::read_to_string(&labels_path)?;
        let mut labels: Vec<String> = serde_json::from_str(&labels_json)?;
        labels.iter_mut().for_each(|label| {
            if label == "iw" {
                *label = "he".into();
            } else if label == "jw" {
                *label = "jv".into();
            }
        });
        if labels.len() < TOP_LANGUAGE_COUNT {
            return Err(
                format!("Language label set is unexpectedly small: {}", labels.len()).into()
            );
        }
        Ok(Self {
            model_kind,
            model_path: model_dir.join(model_kind.model_file()),
            labels,
            model: None,
            sessions: HashMap::new(),
        })
    }

    fn warmup(&mut self) -> Result<WarmupResponse, ServiceError> {
        let started_at = Instant::now();
        self.ensure_model()?;
        Ok(WarmupResponse {
            ok: true,
            model_load_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
            languages: self.labels.len(),
        })
    }

    fn infer(&mut self, input: InferInput) -> Result<InferenceResponse, ServiceError> {
        if input.samples.len() < MINIMUM_AUDIO_SAMPLES {
            return Err(ServiceError::bad_request("At least 500 ms of speech is required"));
        }
        let quality = observation_quality(&input.samples);
        let model_samples = self.samples_for_pattern(&input)?;
        let started_at = Instant::now();
        self.ensure_model()?;
        let model = self
            .model
            .as_mut()
            .ok_or_else(|| ServiceError::unavailable("Language model did not initialize"))?;
        let raw_probabilities = model.infer(&model_samples)?;
        if raw_probabilities.len() != self.labels.len() {
            return Err(ServiceError::unavailable(format!(
                "Language model returned {} probabilities for {} labels",
                raw_probabilities.len(),
                self.labels.len()
            )));
        }
        let snapshot = self.update_tracker(TrackerUpdate {
            session_id: &input.session_id,
            at_ms: input.at_ms,
            decision_policy: input.decision_policy,
            raw_probabilities: &raw_probabilities,
            quality,
        })?;
        Ok(InferenceResponse {
            session_id: input.session_id,
            stable_language: snapshot.stable_language,
            stable_confidence: snapshot.stable_confidence,
            raw_languages: top_probabilities(&self.labels, &raw_probabilities),
            hsmm: HsmmDiagnostics {
                duration_ticks: snapshot.hsmm_duration_ticks,
                transition_hazard: snapshot.hsmm_transition_hazard,
                posterior: snapshot.posterior,
            },
            sprt: SprtDiagnostics {
                enabled: snapshot.sprt_enabled,
                mode: snapshot.decision_mode,
                candidate_language: snapshot.candidate_language,
                llr: snapshot.sprt_llr,
                accept_llr: snapshot.sprt_accept_llr,
                reject_llr: snapshot.sprt_reject_llr,
                state: snapshot.sprt_state,
            },
            hysteresis: HysteresisDiagnostics {
                stable_posterior: snapshot.stable_confidence,
                enter_posterior: snapshot.hysteresis_enter_posterior,
                retain_posterior: snapshot.hysteresis_retain_posterior,
                state: snapshot.hysteresis_state,
                challenger_language: snapshot.challenger_language,
                challenger_posterior: snapshot.challenger_posterior,
            },
            quality,
            speech_seconds: input.samples.len() as f32 / SAMPLE_RATE_HZ as f32,
            inference_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
            model: self.model_kind.model_name().into(),
            pattern: input.pattern,
        })
    }

    fn track(&mut self, input: TrackInput) -> Result<InferenceResponse, ServiceError> {
        let request = input.request;
        let decision_policy = request.decision_policy.unwrap_or_default().resolve()?;
        if request.model != WORKERS_AI_NOVA_MODEL {
            return Err(ServiceError::bad_request("Provider model is not supported"));
        }
        if !request.quality.is_finite() || !(0.0..=1.0).contains(&request.quality) {
            return Err(ServiceError::bad_request("Provider quality must be between zero and one"));
        }
        if !request.speech_seconds.is_finite() || request.speech_seconds <= 0.0 {
            return Err(ServiceError::bad_request("Provider speech duration must be positive"));
        }
        if !request.inference_ms.is_finite() || request.inference_ms < 0.0 {
            return Err(ServiceError::bad_request("Provider inference time is invalid"));
        }
        let raw_probabilities = self.provider_probabilities(&request.raw_languages)?;
        let snapshot = self.update_tracker(TrackerUpdate {
            session_id: &input.session_id,
            at_ms: request.at_ms,
            decision_policy,
            raw_probabilities: &raw_probabilities,
            quality: request.quality,
        })?;
        Ok(InferenceResponse {
            session_id: input.session_id,
            stable_language: snapshot.stable_language,
            stable_confidence: snapshot.stable_confidence,
            raw_languages: request.raw_languages,
            hsmm: HsmmDiagnostics {
                duration_ticks: snapshot.hsmm_duration_ticks,
                transition_hazard: snapshot.hsmm_transition_hazard,
                posterior: snapshot.posterior,
            },
            sprt: SprtDiagnostics {
                enabled: snapshot.sprt_enabled,
                mode: snapshot.decision_mode,
                candidate_language: snapshot.candidate_language,
                llr: snapshot.sprt_llr,
                accept_llr: snapshot.sprt_accept_llr,
                reject_llr: snapshot.sprt_reject_llr,
                state: snapshot.sprt_state,
            },
            hysteresis: HysteresisDiagnostics {
                stable_posterior: snapshot.stable_confidence,
                enter_posterior: snapshot.hysteresis_enter_posterior,
                retain_posterior: snapshot.hysteresis_retain_posterior,
                state: snapshot.hysteresis_state,
                challenger_language: snapshot.challenger_language,
                challenger_posterior: snapshot.challenger_posterior,
            },
            quality: request.quality,
            speech_seconds: request.speech_seconds,
            inference_ms: request.inference_ms,
            model: request.model,
            pattern: request.pattern,
        })
    }

    fn provider_probabilities(
        &self,
        languages: &[LanguageProbability],
    ) -> Result<Vec<f32>, ServiceError> {
        if languages.is_empty() {
            return Err(ServiceError::bad_request("Provider returned no language probabilities"));
        }
        let mut probabilities = vec![0.0_f32; self.labels.len()];
        for language in languages {
            if !language.probability.is_finite() || !(0.0..=1.0).contains(&language.probability) {
                return Err(ServiceError::bad_request("Provider probability is invalid"));
            }
            let normalized = normalized_language_code(&language.language);
            if normalized == "unknown" {
                continue;
            }
            let Some(index) = self.labels.iter().position(|label| label == &normalized) else {
                return Err(ServiceError::bad_request(format!(
                    "Provider language is not supported: {}",
                    language.language
                )));
            };
            probabilities[index] += language.probability;
            if probabilities[index] > 1.0 {
                return Err(ServiceError::bad_request("Provider probabilities exceed one"));
            }
        }
        Ok(probabilities)
    }

    fn update_tracker(
        &mut self,
        input: TrackerUpdate<'_>,
    ) -> Result<TrackerSnapshot, ServiceError> {
        let tracker_probabilities =
            calibrated_tracker_probabilities(input.raw_probabilities, input.quality);
        let labels = tracker_labels(&self.labels);
        let session = self.session_mut(input.session_id, labels, input.decision_policy)?;
        let observation = MultilingualObservation::from_probabilities(
            input.at_ms,
            tracker_probabilities,
            input.quality,
            true,
        );
        if !session.tracker.push_observation(observation).is_accepted() {
            session.tracker.reset();
            return Err(ServiceError::bad_request(
                "Tracker rejected the observation; the session was reset",
            ));
        }
        let previous_state = session.tracker.state();
        let previous_was_unknown =
            session.tracker.labels()[previous_state.stable_index] == "unknown";
        let switched = !session.tracker.advance_through_observation(input.at_ms).is_empty();
        let state = session.tracker.state();
        let labels = session.tracker.labels();
        let leading_index = probability_argmax_index(&state.posterior);
        let challenger_index = (leading_index != state.stable_index).then_some(leading_index);
        let sprt_state = if !session.decision_policy.sprt_enabled {
            SprtState::Disabled
        } else if switched && !previous_was_unknown {
            SprtState::Accepted
        } else if state.candidate_index.is_some() {
            SprtState::Accumulating
        } else {
            SprtState::Idle
        };
        let hysteresis_state = if switched {
            HysteresisState::Switched
        } else if labels[state.stable_index] == "unknown" {
            HysteresisState::Unlocked
        } else if state.candidate_index.is_some() {
            HysteresisState::Challenged
        } else {
            HysteresisState::Retaining
        };
        Ok(TrackerSnapshot {
            stable_language: labels[state.stable_index].clone(),
            stable_confidence: state.stable_confidence,
            candidate_language: state.candidate_index.map(|index| labels[index].clone()),
            challenger_language: challenger_index.map(|index| labels[index].clone()),
            challenger_posterior: challenger_index.map_or(0.0, |index| state.posterior[index]),
            posterior: top_probabilities(labels, &state.posterior),
            hsmm_duration_ticks: state.hsmm_duration_ticks,
            hsmm_transition_hazard: state.hsmm_transition_hazard,
            sprt_enabled: session.decision_policy.sprt_enabled,
            decision_mode: session.decision_policy.mode,
            sprt_llr: state.sprt_llr,
            sprt_accept_llr: state.sprt_accept_llr,
            sprt_reject_llr: state.sprt_reject_llr,
            sprt_state,
            hysteresis_enter_posterior: state.hysteresis_enter_posterior,
            hysteresis_retain_posterior: state.hysteresis_retain_posterior,
            hysteresis_state,
        })
    }

    fn reset(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    fn ensure_model(&mut self) -> Result<(), ServiceError> {
        if self.model.is_none() {
            self.model = Some(AcousticModel::load(&self.model_path, self.model_kind)?);
        }
        Ok(())
    }

    fn samples_for_pattern(&mut self, input: &InferInput) -> Result<Vec<f32>, ServiceError> {
        if matches!(input.pattern, EcapaPattern::Utterance) {
            return Ok(input.samples.clone());
        }
        let labels = tracker_labels(&self.labels);
        let session = self.session_mut(&input.session_id, labels, input.decision_policy)?;
        input.samples.iter().copied().for_each(|sample| {
            session.rolling_samples.push_back(sample);
        });
        let overflow = session.rolling_samples.len().saturating_sub(ROLLING_WINDOW_SAMPLES);
        session.rolling_samples.drain(..overflow);
        Ok(session.rolling_samples.iter().copied().collect())
    }

    fn session_mut(
        &mut self,
        session_id: &str,
        labels: Vec<String>,
        decision_policy: ResolvedDecisionPolicy,
    ) -> Result<&mut LanguageSession, ServiceError> {
        if !self.sessions.contains_key(session_id) {
            let session = LanguageSession::new(labels, decision_policy)?;
            self.sessions.insert(session_id.into(), session);
        }
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ServiceError::unavailable("Language session was not created"))?;
        if session.decision_policy != decision_policy {
            return Err(ServiceError::bad_request(
                "Decision policy changed during a session; reset the language state first",
            ));
        }
        Ok(session)
    }
}

impl LanguageSession {
    fn new(
        labels: Vec<String>,
        decision_policy: ResolvedDecisionPolicy,
    ) -> Result<Self, ServiceError> {
        let config = MultilingualTrackerConfig {
            sprt_enabled: decision_policy.sprt_enabled,
            sprt_accept_llr: decision_policy.accept_llr,
            sprt_reject_llr: decision_policy.reject_llr,
            ..MultilingualTrackerConfig::default()
        };
        let tracker = MultilingualTracker::new(labels, config).map_err(|error| {
            ServiceError::unavailable(format!("Invalid tracker configuration: {error:?}"))
        })?;
        Ok(Self {
            decision_policy,
            tracker,
            rolling_samples: VecDeque::with_capacity(ROLLING_WINDOW_SAMPLES),
        })
    }
}

impl AcousticModel {
    fn load(model_path: &Path, kind: ModelKind) -> Result<Self, ServiceError> {
        let builder = Session::builder().map_err(|error| {
            ServiceError::unavailable(format!("Failed to create language runtime: {error}"))
        })?;
        let mut builder = builder.with_intra_threads(1).map_err(|error| {
            ServiceError::unavailable(format!("Failed to configure language runtime: {error}"))
        })?;
        let session = builder.commit_from_file(model_path).map_err(|error| {
            ServiceError::unavailable(format!("Failed to load language model: {error}"))
        })?;
        let ambernet_preprocessor = if matches!(kind, ModelKind::NvidiaAmbernet) {
            let path = model_path.with_file_name(AMBERNET_PREPROCESSOR_FILE);
            Some(AmbernetPreprocessor::load(&path)?)
        } else {
            None
        };
        Ok(Self { kind, session, ambernet_preprocessor })
    }

    fn infer(&mut self, samples: &[f32]) -> Result<Vec<f32>, ServiceError> {
        let outputs = match self.kind {
            ModelKind::SpeechbrainEcapa => {
                let waveform = TensorRef::from_array_view(([1_usize, samples.len()], samples))
                    .map_err(|error| {
                        ServiceError::bad_request(format!("Invalid waveform: {error}"))
                    })?;
                self.session.run(inputs!["waveform" => waveform])
            }
            ModelKind::NvidiaAmbernet => {
                let preprocessor = self.ambernet_preprocessor.as_ref().ok_or_else(|| {
                    ServiceError::unavailable("AmberNet preprocessor did not initialize")
                })?;
                let features = preprocessor.process(samples)?;
                let tensor = TensorRef::from_array_view((
                    [1_usize, features.mel_bins, features.padded_frames],
                    features.values.as_slice(),
                ))
                .map_err(|error| {
                    ServiceError::bad_request(format!("Invalid AmberNet features: {error}"))
                })?;
                let lengths = [i64::try_from(features.valid_frames).map_err(|error| {
                    ServiceError::bad_request(format!("AmberNet context is too long: {error}"))
                })?];
                let length = TensorRef::from_array_view(([1_usize], lengths.as_slice())).map_err(
                    |error| ServiceError::bad_request(format!("Invalid feature length: {error}")),
                )?;
                self.session.run(inputs!["audio_signal" => tensor, "length" => length])
            }
        }
        .map_err(|error| {
            ServiceError::unavailable(format!("Language inference failed: {error}"))
        })?;
        let (_, values) = outputs[0].try_extract_tensor::<f32>().map_err(|error| {
            ServiceError::unavailable(format!("Invalid language model output: {error}"))
        })?;
        let output = values.to_vec();
        if matches!(self.kind, ModelKind::NvidiaAmbernet) {
            Ok(softmax(&output))
        } else {
            Ok(output)
        }
    }
}

#[derive(Debug)]
struct AmbernetFeatures {
    values: Vec<f32>,
    mel_bins: usize,
    valid_frames: usize,
    padded_frames: usize,
}

impl AmbernetPreprocessor {
    fn load(path: &Path) -> Result<Self, ServiceError> {
        let json = fs::read_to_string(path).map_err(|error| {
            ServiceError::unavailable(format!("Failed to read AmberNet preprocessing: {error}"))
        })?;
        let config: AmbernetPreprocessorConfig = serde_json::from_str(&json).map_err(|error| {
            ServiceError::unavailable(format!("Invalid AmberNet preprocessing: {error}"))
        })?;
        let spectrum_bins = config.n_fft / 2 + 1;
        let valid = config.n_fft > 0
            && config.hop_length > 0
            && config.window.len() == config.n_fft
            && !config.filter_bank.is_empty()
            && config.filter_bank.iter().all(|row| row.len() == spectrum_bins);
        if !valid {
            return Err(ServiceError::unavailable("AmberNet preprocessing dimensions are invalid"));
        }
        let basis_size = spectrum_bins * config.n_fft;
        let mut cosine_basis = Vec::with_capacity(basis_size);
        let mut sine_basis = Vec::with_capacity(basis_size);
        for frequency in 0..spectrum_bins {
            for time in 0..config.n_fft {
                let angle = 2.0 * std::f32::consts::PI * frequency as f32 * time as f32
                    / config.n_fft as f32;
                cosine_basis.push(config.window[time] * angle.cos());
                sine_basis.push(config.window[time] * -angle.sin());
            }
        }
        Ok(Self { config, cosine_basis, sine_basis })
    }

    fn process(&self, samples: &[f32]) -> Result<AmbernetFeatures, ServiceError> {
        let padding = self.config.n_fft / 2;
        if samples.len() <= padding {
            return Err(ServiceError::bad_request(
                "AmberNet requires more than half an FFT window of audio",
            ));
        }
        let mut preemphasized = Vec::with_capacity(samples.len());
        preemphasized.push(samples[0]);
        preemphasized
            .extend(samples.windows(2).map(|pair| pair[1] - self.config.preemphasis * pair[0]));
        let mut padded = vec![0.0_f32; samples.len() + padding * 2];
        padded[padding..padding + samples.len()].copy_from_slice(&preemphasized);
        for offset in 0..padding {
            padded[padding - 1 - offset] = preemphasized[offset + 1];
            padded[padding + samples.len() + offset] = preemphasized[samples.len() - 2 - offset];
        }
        let frame_count = (padded.len() - self.config.n_fft) / self.config.hop_length + 1;
        if frame_count < 2 {
            return Err(ServiceError::bad_request(
                "AmberNet requires at least two spectrogram frames",
            ));
        }
        let spectrum_bins = self.config.n_fft / 2 + 1;
        let mut power = vec![0.0_f32; spectrum_bins * frame_count];
        for frame in 0..frame_count {
            let frame_start = frame * self.config.hop_length;
            let frame_samples = &padded[frame_start..frame_start + self.config.n_fft];
            for frequency in 0..spectrum_bins {
                let basis_start = frequency * self.config.n_fft;
                let cosine = &self.cosine_basis[basis_start..basis_start + self.config.n_fft];
                let sine = &self.sine_basis[basis_start..basis_start + self.config.n_fft];
                let mut real = 0.0_f32;
                let mut imaginary = 0.0_f32;
                for time in 0..self.config.n_fft {
                    real += frame_samples[time] * cosine[time];
                    imaginary += frame_samples[time] * sine[time];
                }
                power[frequency * frame_count + frame] = real * real + imaginary * imaginary;
            }
        }
        let mel_bins = self.config.filter_bank.len();
        let padded_frames = if self.config.pad_to == 0 {
            frame_count
        } else {
            frame_count.div_ceil(self.config.pad_to) * self.config.pad_to
        };
        let mut values = vec![0.0_f32; mel_bins * padded_frames];
        for (mel, filter) in self.config.filter_bank.iter().enumerate() {
            let mut log_features = vec![0.0_f32; frame_count];
            for frame in 0..frame_count {
                let energy: f32 = filter
                    .iter()
                    .enumerate()
                    .map(|(frequency, weight)| weight * power[frequency * frame_count + frame])
                    .sum();
                log_features[frame] = (energy.max(0.0) + self.config.log_zero_guard).ln();
            }
            let mean = log_features.iter().sum::<f32>() / frame_count as f32;
            let variance = log_features
                .iter()
                .map(|value| {
                    let difference = value - mean;
                    difference * difference
                })
                .sum::<f32>()
                / (frame_count - 1) as f32;
            let standard_deviation = variance.sqrt() + 1e-5;
            let output = &mut values[mel * padded_frames..mel * padded_frames + frame_count];
            output.iter_mut().zip(log_features).for_each(|(target, value)| {
                *target = (value - mean) / standard_deviation;
            });
        }
        Ok(AmbernetFeatures { values, mel_bins, valid_frames: frame_count, padded_frames })
    }
}

fn softmax(logits: &[f32]) -> Vec<f32> {
    let maximum = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exponentials: Vec<f32> = logits.iter().map(|value| (value - maximum).exp()).collect();
    let total: f32 = exponentials.iter().sum();
    exponentials.into_iter().map(|value| value / total.max(f32::EPSILON)).collect()
}

fn normalized_language_code(language: &str) -> String {
    let primary = language.split(['-', '_']).next().unwrap_or(language).to_ascii_lowercase();
    match primary.as_str() {
        "iw" => "he".into(),
        "jw" => "jv".into(),
        _ => primary,
    }
}

fn tracker_labels(model_labels: &[String]) -> Vec<String> {
    std::iter::once("unknown".into()).chain(model_labels.iter().cloned()).collect()
}

fn calibrated_tracker_probabilities(raw: &[f32], quality: f32) -> Vec<f32> {
    let top_probability = raw.iter().copied().fold(0.0_f32, f32::max);
    let confidence_unknown = ((UNKNOWN_CONFIDENCE_BOUNDARY - top_probability)
        / UNKNOWN_CONFIDENCE_BOUNDARY)
        .clamp(0.0, 1.0);
    let quality_unknown = (1.0 - quality) * UNKNOWN_QUALITY_WEIGHT;
    let missing_probability = (1.0 - raw.iter().sum::<f32>()).clamp(0.0, 1.0);
    let unknown_probability =
        confidence_unknown.max(quality_unknown).max(missing_probability).clamp(0.0, 0.9);
    std::iter::once(unknown_probability)
        .chain(raw.iter().map(|probability| probability * (1.0 - unknown_probability)))
        .collect()
}

fn observation_quality(samples: &[f32]) -> f32 {
    let duration_quality =
        (samples.len() as f32 / PREFERRED_CONTEXT_SAMPLES as f32).clamp(0.0, 1.0);
    let rms = (samples.iter().map(|sample| sample * sample).sum::<f32>()
        / samples.len().max(1) as f32)
        .sqrt();
    let signal_quality = (rms / MINIMUM_AUDIBLE_RMS).clamp(0.0, 1.0);
    duration_quality * signal_quality
}

fn probability_argmax_index(probabilities: &[f32]) -> usize {
    probabilities
        .iter()
        .copied()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map_or(0, |(index, _)| index)
}

fn probability_order(left: &(usize, f32), right: &(usize, f32)) -> std::cmp::Ordering {
    right.1.total_cmp(&left.1).then_with(|| left.0.cmp(&right.0))
}

fn top_probabilities(labels: &[String], probabilities: &[f32]) -> Vec<LanguageProbability> {
    let mut indexed: Vec<(usize, f32)> = probabilities.iter().copied().enumerate().collect();
    indexed.sort_by(probability_order);
    indexed
        .into_iter()
        .take(TOP_LANGUAGE_COUNT)
        .map(|(index, probability)| LanguageProbability {
            language: labels.get(index).cloned().unwrap_or_else(|| "unknown".into()),
            probability,
        })
        .collect()
}

fn decode_float32_pcm(bytes: &[u8]) -> Result<Vec<f32>, ServiceError> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(size_of::<f32>()) {
        return Err(ServiceError::bad_request("Audio body must contain little-endian float32 PCM"));
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(ServiceError::bad_request("Audio contains a non-finite sample"));
    }
    Ok(samples)
}

fn validated_session_id(headers: &HeaderMap) -> Result<String, ServiceError> {
    let value = headers
        .get(SESSION_ID_HEADER)
        .ok_or_else(|| ServiceError::bad_request("Missing x-kotoba-session-id header"))?
        .to_str()
        .map_err(|_| ServiceError::bad_request("Session ID is not valid ASCII"))?;
    let valid = !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid {
        return Err(ServiceError::bad_request("Session ID has an invalid format"));
    }
    Ok(value.into())
}

async fn health(State(state): State<AppState>) -> axum::Json<HealthResponse> {
    axum::Json(HealthResponse {
        ok: true,
        model: state.model_kind.model_name(),
        languages: state.language_count,
        tracker: "rust-online-hsmm-configurable-sprt-hysteresis",
    })
}

async fn warmup(State(state): State<AppState>) -> Result<axum::Json<WarmupResponse>, ServiceError> {
    state.runtime.warmup().await.map(axum::Json)
}

async fn infer(
    State(state): State<AppState>,
    Query(query): Query<InferQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<axum::Json<InferenceResponse>, ServiceError> {
    let session_id = validated_session_id(&headers)?;
    let samples = decode_float32_pcm(&body)?;
    let decision_policy = decision_policy_from_query(query.decision_policy.as_deref())?;
    state
        .runtime
        .infer(InferInput {
            session_id,
            at_ms: query.at_ms,
            pattern: query.pattern,
            decision_policy,
            samples,
        })
        .await
        .map(axum::Json)
}

async fn track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ProviderTrackRequest>,
) -> Result<axum::Json<InferenceResponse>, ServiceError> {
    let session_id = validated_session_id(&headers)?;
    state.runtime.track(TrackInput { session_id, request }).await.map(axum::Json)
}

async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::Json<serde_json::Value>, ServiceError> {
    let session_id = validated_session_id(&headers)?;
    state.runtime.reset(session_id).await?;
    Ok(axum::Json(serde_json::json!({ "ok": true, "state": "reset" })))
}

fn spawn_runtime(
    model_dir: PathBuf,
    model_kind: ModelKind,
) -> Result<RuntimeHandle, Box<dyn Error>> {
    let (sender, receiver) = mpsc::channel();
    let (boot_sender, boot_receiver) = mpsc::sync_channel(1);
    thread::Builder::new().name("language-harness-runtime".into()).spawn(move || {
        let service = RuntimeService::new(&model_dir, model_kind);
        let boot_result = service.as_ref().map(|_| ()).map_err(|error| error.to_string());
        if boot_sender.send(boot_result).is_err() {
            return;
        }
        let Ok(mut service) = service else {
            return;
        };
        while let Ok(command) = receiver.recv() {
            match command {
                RuntimeCommand::Warmup { response } => {
                    drop(response.send(service.warmup()));
                }
                RuntimeCommand::Infer { input, response } => {
                    drop(response.send(service.infer(input)));
                }
                RuntimeCommand::Track { input, response } => {
                    drop(response.send(service.track(input)));
                }
                RuntimeCommand::Reset { session_id, response } => {
                    service.reset(&session_id);
                    let _send_result = response.send(());
                }
            }
        }
    })?;
    boot_receiver.recv().map_err(|error| error.to_string())??;
    Ok(RuntimeHandle { sender })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let model_kind = ModelKind::from_environment();
    let model_dir = std::env::var_os("LANGUAGE_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/models/speechbrain-ecapa"));
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let labels_json = fs::read_to_string(model_dir.join(LABELS_FILE))?;
    let language_count = serde_json::from_str::<Vec<String>>(&labels_json)?.len();
    let state =
        AppState { runtime: spawn_runtime(model_dir, model_kind)?, model_kind, language_count };
    let app = Router::new()
        .route("/health", get(health))
        .route("/warmup", post(warmup))
        .route("/infer", post(infer))
        .route("/track", post(track))
        .route("/reset", post(reset))
        .layer(DefaultBodyLimit::max(MAXIMUM_AUDIO_BYTES))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bounded_float_pcm_and_rejects_invalid_shapes() {
        assert_eq!(decode_float32_pcm(&[0, 0, 0, 0, 0, 0, 128, 63]).unwrap(), vec![0.0, 1.0]);
        assert_eq!(
            decode_float32_pcm(&[]).unwrap_err(),
            ServiceError::bad_request("Audio body must contain little-endian float32 PCM")
        );
        assert_eq!(
            decode_float32_pcm(&[0, 1]).unwrap_err(),
            ServiceError::bad_request("Audio body must contain little-endian float32 PCM")
        );
        assert_eq!(
            decode_float32_pcm(&f32::NAN.to_le_bytes()).unwrap_err(),
            ServiceError::bad_request("Audio contains a non-finite sample")
        );
    }

    #[test]
    fn calibration_adds_unknown_without_collapsing_multilingual_probabilities() {
        assert_eq!(
            calibrated_tracker_probabilities(&[0.7, 0.2, 0.1], 1.0),
            vec![0.0, 0.7, 0.2, 0.1]
        );
        let low_quality = calibrated_tracker_probabilities(&[0.7, 0.2, 0.1], 0.0);
        assert!((low_quality[0] - 0.7).abs() < 0.0001);
        assert!((low_quality.iter().sum::<f32>() - 1.0).abs() < 0.0001);
        let uncertain = calibrated_tracker_probabilities(&[0.2, 0.2, 0.2], 1.0);
        assert!(uncertain[0] > 0.6);
    }

    #[test]
    fn quality_combines_context_duration_and_signal_level() {
        assert_eq!(observation_quality(&vec![0.0; SAMPLE_RATE_HZ]), 0.0);
        let preferred = observation_quality(&vec![0.1; PREFERRED_CONTEXT_SAMPLES]);
        assert!((preferred - 1.0).abs() < 0.0001);
        let short = observation_quality(&vec![0.1; SAMPLE_RATE_HZ]);
        assert!((short - (1.0 / 3.0)).abs() < 0.0001);
    }

    #[test]
    fn top_probabilities_are_ranked_and_bounded() {
        let labels: Vec<String> =
            ["a", "b", "c", "d", "e", "f", "g", "h", "i"].into_iter().map(String::from).collect();
        let top = top_probabilities(&labels, &[0.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
        assert_eq!(top.len(), 8);
        assert_eq!(top[0].language, "b");
        assert_eq!(top[0].probability, 0.9);
        assert_eq!(top[7].language, "i");
    }

    #[test]
    fn session_header_requires_a_bounded_url_safe_identifier() {
        let mut valid = HeaderMap::new();
        valid.insert(SESSION_ID_HEADER, "session_1-test".parse().unwrap());
        assert_eq!(validated_session_id(&valid).unwrap(), "session_1-test");
        assert_eq!(
            validated_session_id(&HeaderMap::new()).unwrap_err(),
            ServiceError::bad_request("Missing x-kotoba-session-id header")
        );
        let mut invalid = HeaderMap::new();
        invalid.insert(SESSION_ID_HEADER, "session/1".parse().unwrap());
        assert_eq!(
            validated_session_id(&invalid).unwrap_err(),
            ServiceError::bad_request("Session ID has an invalid format")
        );
    }

    #[test]
    fn model_kind_selects_distinct_artifacts_and_softmax_normalizes_logits() {
        assert_eq!(
            ModelKind::SpeechbrainEcapa.model_name(),
            "speechbrain/lang-id-voxlingua107-ecapa"
        );
        assert_eq!(ModelKind::NvidiaAmbernet.model_file(), AMBERNET_MODEL_FILE);
        let probabilities = softmax(&[1.0, 2.0, 3.0]);
        assert_eq!(probabilities.len(), 3);
        assert!((probabilities.iter().sum::<f32>() - 1.0).abs() < 0.0001);
        assert!(probabilities[2] > probabilities[1]);
    }

    fn test_service() -> RuntimeService {
        RuntimeService {
            model_kind: ModelKind::SpeechbrainEcapa,
            model_path: PathBuf::new(),
            labels: vec![
                "ja".into(),
                "en".into(),
                "ko".into(),
                "fr".into(),
                "de".into(),
                "es".into(),
                "he".into(),
                "jv".into(),
            ],
            model: None,
            sessions: HashMap::new(),
        }
    }

    fn provider_request(language: &str, probability: f32) -> ProviderTrackRequest {
        ProviderTrackRequest {
            at_ms: 1_000,
            pattern: EcapaPattern::Utterance,
            decision_policy: Some(DecisionPolicyRequest::Responsive),
            raw_languages: vec![LanguageProbability { language: language.into(), probability }],
            quality: probability,
            speech_seconds: 1.0,
            inference_ms: 12.0,
            model: WORKERS_AI_NOVA_MODEL.into(),
        }
    }

    #[test]
    fn provider_tracking_uses_the_rust_tracker_and_resets_only_the_session() {
        let mut service = test_service();
        let response = service
            .track(TrackInput {
                session_id: "provider-session".into(),
                request: provider_request("EN-us", 0.9),
            })
            .unwrap();
        assert_eq!(response.session_id, "provider-session");
        assert_eq!(response.raw_languages[0].language, "EN-us");
        assert_eq!(response.model, WORKERS_AI_NOVA_MODEL);
        assert_eq!(response.pattern, EcapaPattern::Utterance);
        assert_eq!(response.stable_language, "en");
        assert_eq!(response.sprt.state, SprtState::Idle);
        assert_eq!(response.hysteresis.state, HysteresisState::Switched);
        assert!(service.sessions.contains_key("provider-session"));

        let mut japanese_challenge = provider_request("ja", 0.998);
        japanese_challenge.at_ms = 1_600;
        let challenged = service
            .track(TrackInput {
                session_id: "provider-session".into(),
                request: japanese_challenge,
            })
            .unwrap();
        assert_eq!(challenged.stable_language, "en");
        assert_eq!(challenged.sprt.state, SprtState::Accumulating);
        assert_eq!(challenged.sprt.candidate_language.as_deref(), Some("ja"));
        assert_eq!(challenged.hysteresis.state, HysteresisState::Challenged);
        assert_eq!(challenged.hysteresis.challenger_language.as_deref(), Some("ja"));
        assert!(challenged.hysteresis.challenger_posterior >= 0.42);

        let mut sustained_japanese = provider_request("ja", 0.998);
        sustained_japanese.at_ms = 2_200;
        let switched = service
            .track(TrackInput {
                session_id: "provider-session".into(),
                request: sustained_japanese,
            })
            .unwrap();
        assert_eq!(switched.stable_language, "ja");
        assert_eq!(switched.sprt.state, SprtState::Accepted);
        assert_eq!(switched.sprt.accept_llr, 2.0);
        assert_eq!(switched.hysteresis.state, HysteresisState::Switched);
        assert!(switched.hysteresis.stable_posterior > 0.99);

        let labels = tracker_labels(&service.labels);
        service.sessions.insert(
            "other-session".into(),
            LanguageSession::new(labels, DecisionPolicyRequest::default().resolve().unwrap())
                .unwrap(),
        );
        service.reset("provider-session");
        assert!(!service.sessions.contains_key("provider-session"));
        assert!(service.sessions.contains_key("other-session"));
        assert_eq!(normalized_language_code("iw_IL"), "he");
        assert_eq!(normalized_language_code("JW"), "jv");
    }

    #[test]
    fn decision_policies_resolve_wald_custom_and_hysteresis_only_modes() {
        let wald = DecisionPolicyRequest::Wald {
            false_switch_probability: 0.1,
            missed_switch_probability: 0.2,
        }
        .resolve()
        .unwrap();
        assert_eq!(wald.mode, DecisionMode::Wald);
        assert!((wald.accept_llr - 8.0_f32.ln()).abs() < 0.0001);
        assert!((wald.reject_llr - (0.2_f32 / 0.9).ln()).abs() < 0.0001);

        let custom =
            DecisionPolicyRequest::Custom { accept_llr: 4.0, reject_llr: -2.0 }.resolve().unwrap();
        assert_eq!(custom.accept_llr, 4.0);
        assert_eq!(custom.reject_llr, -2.0);

        let without_sprt = DecisionPolicyRequest::HysteresisOnly.resolve().unwrap();
        assert!(!without_sprt.sprt_enabled);
        assert_eq!(without_sprt.mode, DecisionMode::HysteresisOnly);

        assert!(
            DecisionPolicyRequest::Wald {
                false_switch_probability: 0.0,
                missed_switch_probability: 0.2,
            }
            .resolve()
            .is_err()
        );
        assert!(
            DecisionPolicyRequest::Wald {
                false_switch_probability: 0.1,
                missed_switch_probability: 0.5,
            }
            .resolve()
            .is_err()
        );
        assert!(
            DecisionPolicyRequest::Custom { accept_llr: 0.0, reject_llr: -1.0 }.resolve().is_err()
        );
        assert!(
            DecisionPolicyRequest::Custom { accept_llr: 2.0, reject_llr: 0.0 }.resolve().is_err()
        );
        assert!(decision_policy_from_query(Some("{invalid")).is_err());
        assert_eq!(decision_policy_from_query(None).unwrap().mode, DecisionMode::HysteresisOnly);
    }

    #[test]
    fn provider_tracking_applies_session_decision_policy() {
        let mut service = test_service();
        let mut request = provider_request("fr", 0.99);
        request.decision_policy = Some(DecisionPolicyRequest::HysteresisOnly);
        let response =
            service.track(TrackInput { session_id: "policy-session".into(), request }).unwrap();
        assert!(!response.sprt.enabled);
        assert_eq!(response.sprt.mode, DecisionMode::HysteresisOnly);
        assert_eq!(response.sprt.state, SprtState::Disabled);

        let mut changed = provider_request("de", 0.99);
        changed.at_ms = 1_600;
        changed.decision_policy = Some(DecisionPolicyRequest::Responsive);
        assert_eq!(
            service
                .track(TrackInput { session_id: "policy-session".into(), request: changed })
                .unwrap_err()
                .message,
            "Decision policy changed during a session; reset the language state first"
        );
    }

    #[test]
    fn provider_tracking_rejects_untrusted_provider_fields() {
        let mut service = test_service();
        let mut request = provider_request("en", 0.9);
        request.model = "other/model".into();
        assert_eq!(
            service.track(TrackInput { session_id: "session".into(), request }).unwrap_err(),
            ServiceError::bad_request("Provider model is not supported")
        );

        let mut request = provider_request("en", 0.9);
        request.quality = f32::NAN;
        assert_eq!(
            service.track(TrackInput { session_id: "session".into(), request }).unwrap_err(),
            ServiceError::bad_request("Provider quality must be between zero and one")
        );
        let mut request = provider_request("en", 0.9);
        request.speech_seconds = 0.0;
        assert_eq!(
            service.track(TrackInput { session_id: "session".into(), request }).unwrap_err(),
            ServiceError::bad_request("Provider speech duration must be positive")
        );
        let mut request = provider_request("en", 0.9);
        request.inference_ms = -1.0;
        assert_eq!(
            service.track(TrackInput { session_id: "session".into(), request }).unwrap_err(),
            ServiceError::bad_request("Provider inference time is invalid")
        );
    }

    #[test]
    fn provider_probabilities_validate_and_map_language_codes() {
        let service = test_service();
        assert_eq!(
            service.provider_probabilities(&[]).unwrap_err(),
            ServiceError::bad_request("Provider returned no language probabilities")
        );
        assert_eq!(
            service
                .provider_probabilities(&[LanguageProbability {
                    language: "en".into(),
                    probability: f32::INFINITY,
                }])
                .unwrap_err(),
            ServiceError::bad_request("Provider probability is invalid")
        );
        assert_eq!(
            service
                .provider_probabilities(&[LanguageProbability {
                    language: "unsupported".into(),
                    probability: 0.5,
                }])
                .unwrap_err(),
            ServiceError::bad_request("Provider language is not supported: unsupported")
        );
        assert_eq!(
            service
                .provider_probabilities(&[
                    LanguageProbability { language: "en".into(), probability: 0.6 },
                    LanguageProbability { language: "EN-us".into(), probability: 0.6 },
                ])
                .unwrap_err(),
            ServiceError::bad_request("Provider probabilities exceed one")
        );
        let mapped = service
            .provider_probabilities(&[
                LanguageProbability { language: "unknown".into(), probability: 0.2 },
                LanguageProbability { language: "iw-IL".into(), probability: 0.7 },
            ])
            .unwrap();
        assert_eq!(mapped[6], 0.7);
        assert_eq!(mapped.iter().sum::<f32>(), 0.7);
    }

    #[test]
    fn rolling_pattern_retains_only_the_latest_six_seconds() {
        let mut service = test_service();
        let decision_policy = DecisionPolicyRequest::default().resolve().unwrap();
        let first = service
            .samples_for_pattern(&InferInput {
                session_id: "session".into(),
                at_ms: 0,
                pattern: EcapaPattern::RollingContext,
                decision_policy,
                samples: vec![0.1; SAMPLE_RATE_HZ * 4],
            })
            .unwrap();
        assert_eq!(first.len(), SAMPLE_RATE_HZ * 4);
        let second = service
            .samples_for_pattern(&InferInput {
                session_id: "session".into(),
                at_ms: 500,
                pattern: EcapaPattern::RollingContext,
                decision_policy,
                samples: vec![0.2; SAMPLE_RATE_HZ * 4],
            })
            .unwrap();
        assert_eq!(second.len(), ROLLING_WINDOW_SAMPLES);
        assert_eq!(second[0], 0.1);
        assert_eq!(second[SAMPLE_RATE_HZ * 2], 0.2);
        let utterance = service
            .samples_for_pattern(&InferInput {
                session_id: "session".into(),
                at_ms: 1_000,
                pattern: EcapaPattern::Utterance,
                decision_policy,
                samples: vec![0.3; SAMPLE_RATE_HZ],
            })
            .unwrap();
        assert_eq!(utterance, vec![0.3; SAMPLE_RATE_HZ]);
    }
}
