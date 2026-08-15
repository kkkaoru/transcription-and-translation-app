use crate::config::AppConfig;
use crate::config::RescoreConfig;
use crate::kana_kanji::{
    convert_kana_to_kanji, convert_with_dictionary, convert_with_verifier_with_limit,
    AzooKeyDictionary, ConversionOptions, DictionaryPaths, DraftVerifier, VerificationState,
    VerifierConversionOptions, VerifierPolicy,
};
use crate::vibrato_runtime::{contains_kanji, VibratoReader};
#[cfg(feature = "candle")]
use candle_core::Device;
use caption_bridge_input_lm::marisa::{open_model, MarisaTrie};
use caption_bridge_input_lm::model::NgramParams;
use caption_bridge_input_lm::rescore::{AsrConfusionRules, LmScorer, Rescorer};
use caption_bridge_input_lm::tokenizer::ZenzTokenizer;
#[cfg(feature = "candle")]
use caption_bridge_zenz_verifier::{EmbeddedVerifierLoadError, EmbeddedZenzDraftVerifier};
use reqwest::multipart;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{hash_map::Entry, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::{Duration, Instant};
use thiserror::Error;
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("inference request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("inference returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("inference response did not contain text")]
    MissingText,
    #[error("inference response JSON was invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported model: {0}")]
    UnsupportedModel(String),
    #[error("model asset error: {0}")]
    Model(String),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPayload {
    pub id: String,
    pub source_text: String,
    /// The phonetic text supplied to AzooKey for this caption, when the
    /// persistent Parapper path exposes it.  Keeping this alongside the
    /// rendered source lets the frontend distinguish a rolling suffix from a
    /// kana-to-kanji revision without guessing from surface text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azookey_input_text: Option<String>,
    pub translation_text: String,
    pub source_language: String,
    pub target_language: String,
    pub started_at: u64,
    pub received_at: u64,
    /// `source` is a partial row with recognition result and no translation yet.
    /// `translation` updates the same utterance with translated text.
    pub stage: &'static str,
    /// 0 for source stage, 1 for translation stage (used for ordering).
    pub sequence: u16,
    /// Indicates the payload can be shown as the latest final user-facing text.
    pub is_final: bool,
    pub confidence: Option<f32>,
    /// Exclusive Unicode-scalar offsets where Vibrato/AzooKey completed a sentence.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sentence_end_offsets: Vec<usize>,
    /// Mid-sentence POS wrap points for caption line breaks before maxChars.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub soft_break_offsets: Vec<usize>,
}

/// Fine-grained per-stage timing + I/O sample for debug mode / latency diagnosis.
/// Stages are independent: `asr` (parapper), `normalize` (azookey/zenz), `translate` (HY-MT2).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageEvent {
    /// `asr` | `normalize` | `translate`
    pub stage: &'static str,
    pub utterance_id: String,
    /// Selected model id for this stage (e.g. `parapper-ja`, `azookey-rust`, `hy-mt2-1.8b-gguf`).
    pub model_id: String,
    /// Short input sample (text, or audio size meta for ASR).
    pub input_snippet: String,
    /// Short output sample when the stage produced text.
    pub output_text: String,
    /// Optional original surface text retained by the Vibrato→Hiragana ASR
    /// sink.  This is metadata for the progressive source paint; the selected
    /// normalizer still receives the configured ASR text (`output_text`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_text: Option<String>,
    /// Stage wall-clock start (epoch millis).
    pub started_at: u64,
    /// Stage wall-clock end (epoch millis). Same as historical `at`.
    pub at: u64,
    pub duration_ms: u64,
    /// `false` means the selected stage failed.  A recoverable AzooKey
    /// dictionary fallback also reports `false` (with a diagnostic `error`)
    /// while retaining its built-in conversion in `output_text`; hard failures
    /// have an empty output and abort the pipeline.
    pub ok: bool,
    pub error: Option<String>,
    /// Privacy-safe Zenz prompt metadata. Caption contents are deliberately excluded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zenz_context: Option<ZenzContextDiagnostics>,
    /// Privacy-safe verifier counters. Caption and prompt text are deliberately
    /// excluded; the optional object is emitted only for the AzooKey verifier
    /// path so callers can distinguish disabled, unavailable, and loaded builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zenz_verifier: Option<ZenzVerifierDiagnostics>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZenzContextDiagnostics {
    pub enabled: bool,
    pub is_final: bool,
    pub character_count: u32,
    pub turn_count: u32,
    pub discarded_session_count: u64,
}

/// Privacy-safe verifier diagnostics attached to normalize stage events.
///
/// `enabled` is the runtime switch, `build_available` tells whether the
/// optional Candle backend was compiled into this binary, and `loaded` tells
/// whether its model/tokenizer assets were loaded successfully. Keeping these
/// three values separate avoids treating a disabled runtime, a feature-off
/// build, and a load failure as the same silent quality downgrade.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZenzVerifierDiagnostics {
    pub enabled: bool,
    pub build_available: bool,
    pub loaded: bool,
    pub load_failure_count: u64,
    pub load_failure_reason: Option<ZenzVerifierLoadFailureReason>,
    pub called_count: u64,
    pub skipped_count: u64,
    pub verified_count: u64,
    pub prefix_constraint_returned_count: u64,
    pub exhausted_count: u64,
    pub exhausted_with_constrained_candidate_count: u64,
    pub exhausted_with_dictionary_fallback_count: u64,
    pub skipped_by_policy_count: u64,
    pub deadline_exceeded_count: u64,
    pub capability_unavailable_count: u64,
    pub error_count: u64,
    pub unverified_fallback_count: u64,
    pub iteration_count: u64,
}

/// Stable, privacy-safe identifiers for failures while loading the optional
/// embedded verifier. The diagnostic exposes the identifier, never the model
/// path or the underlying error text.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ZenzVerifierLoadFailureReason {
    ModelNotFound,
    TokenizerMismatch,
    DecodeError,
    Other,
}

impl ZenzVerifierLoadFailureReason {
    #[cfg(feature = "candle")]
    fn as_str(self) -> &'static str {
        match self {
            Self::ModelNotFound => "model_not_found",
            Self::TokenizerMismatch => "tokenizer_mismatch",
            Self::DecodeError => "decode_error",
            Self::Other => "other",
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::ModelNotFound => 1,
            Self::TokenizerMismatch => 2,
            Self::DecodeError => 3,
            Self::Other => 4,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::ModelNotFound),
            2 => Some(Self::TokenizerMismatch),
            3 => Some(Self::DecodeError),
            4 => Some(Self::Other),
            _ => None,
        }
    }
}

impl PipelineStageEvent {
    fn with_zenz_context(mut self, diagnostics: Option<ZenzContextDiagnostics>) -> Self {
        self.zenz_context = diagnostics;
        self
    }

    fn with_zenz_verifier(mut self, diagnostics: Option<ZenzVerifierDiagnostics>) -> Self {
        self.zenz_verifier = diagnostics;
        self
    }
}

const STAGE_SNIPPET_CHARS: usize = 160;
const NORMALIZE_TEMPERATURE: f32 = 0.0;
// Translation temperature has not been empirically evaluated. Preserve the existing
// HY-MT2 sampling behavior until translation-quality measurements justify a change.
const TRANSLATE_TEMPERATURE: f32 = 0.7;
const ZENZ_CONTEXT_MAX_GRAPHEMES: usize = 40;
const ZENZ_CONTEXT_MAX_TURNS: usize = 64;
const ZENZ_VERIFIER_MAX_ITERATIONS: usize = 10;
const ZENZ_VERIFIER_INFERENCE_CONFIG_REVISION: &str =
    "desktop-zenz-verifier-v1;temperature=0;top_p=0.6;max_tokens=512";
#[cfg(feature = "candle")]
const ZENZ_VERIFIER_MODEL_ID: &str = "zenz-v3.2-small-gguf";
#[cfg(feature = "candle")]
const ZENZ_VERIFIER_MODEL_REVISION: &str =
    "zenz-v3.2-small-gguf@c67e03e07d215c869f591b274c1631170d3e11fe";
#[cfg(feature = "candle")]
const ZENZ_VERIFIER_MODEL_PATH_ENV: &str = "CAPTION_BRIDGE_ZENZ_MODEL_PATH";
#[cfg(feature = "candle")]
const ZENZ_VERIFIER_MODEL_RUNTIME_DIR_ENV: &str = "CAPTION_BRIDGE_MODEL_RUNTIME_DIR";
static ZENZ_LEFT_CONTEXT_ENABLED: OnceLock<bool> = OnceLock::new();
static ZENZ_VERIFIER_ENABLED: OnceLock<bool> = OnceLock::new();
static ZENZ_VERIFIER_LOAD_WARNING: Once = Once::new();

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct TranscriptResponse {
    text: Option<String>,
    transcript: Option<String>,
}

/// Structured output received from the persistent Parapper WebSocket session.
///
/// `text` is the sidecar's configured streaming representation. `source_text`
/// retains the original ASR surface selected by Vibrato, while
/// `azookey_input_text` explicitly carries the phonetic input expected by the
/// kana-kanji normalizer. Keeping these fields separate prevents a standard
/// Parapper surface payload from being mistaken for normalizer input (and
/// vice versa).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParapperRecognitionInput {
    pub text: String,
    #[serde(default)]
    pub source_text: Option<String>,
    /// Optional phonetic text supplied by the sidecar for AzooKey.  This is
    /// separate from the protocol's configured `text` representation so the
    /// normalizer never has to infer whether a payload is surface or reading.
    #[serde(default)]
    pub azookey_input_text: Option<String>,
    pub session_id: String,
    pub turn_session_id: u64,
    pub turn_id: u64,
    pub revision: u64,
    /// Monotonic sidecar output cursor; distinguishes partial/final events
    /// emitted at the same turn revision.
    #[serde(default)]
    pub output_sequence: u64,
    pub segment_id: u64,
    #[serde(default)]
    pub previous_segment_id: Option<u64>,
    #[serde(default)]
    pub source_asr_model: String,
    #[serde(default = "default_source_language")]
    pub source_language: String,
    #[serde(default)]
    pub detected_language: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub audio_duration_ms: Option<u64>,
    pub is_final: bool,
    /// Native capture generation the frontend queue
    /// (`parapper-output-queue.ts`) observed when this item was enqueued —
    /// not whatever generation happens to be current when the Tauri invoke
    /// for it finally runs. The queue keeps at most one pending partial and
    /// can serialize behind an in-flight normalizer call, so an item queued
    /// under session N can still be dequeued and processed after a
    /// Stop+Start bumped the generation to N+1. Capturing the generation
    /// fresh inside the command instead of at enqueue time would silently
    /// treat that stale item as belonging to whichever session happens to be
    /// active when it is finally processed. Older callers omit it; the
    /// command then falls back to the historical current-generation read.
    #[serde(default)]
    pub capture_generation: Option<u64>,
}

fn chat_request<'a>(
    config: &'a AppConfig,
    model: &'a str,
    prompt: String,
    purpose: ChatPurpose,
) -> ChatRequest<'a> {
    ChatRequest {
        model,
        model_path: config
            .models
            .paths
            .get(model)
            .map(String::as_str)
            .filter(|path| !path.trim().is_empty()),
        messages: vec![ChatMessageRequest { role: "user", content: prompt }],
        temperature: purpose.temperature(),
        top_p: 0.6,
        max_tokens: 512,
        stream: false,
    }
}

fn default_source_language() -> String {
    "ja".to_string()
}

/// Result of a normalizer invocation.
///
/// A dictionary fallback is intentionally distinct from a hard normalizer
/// error.  The selected AzooKey dictionary may be user-provided and is not
/// required for the built-in lexicon to produce a caption.  In that case the
/// stage is recorded as `ok = false` with a non-empty output and a diagnostic
/// error, while the surrounding pipeline continues with the fallback text.
#[derive(Debug, PartialEq, Eq)]
enum NormalizeOutcome {
    Success(String),
    Fallback { text: String, error: String },
}

#[derive(Debug, Clone, Copy)]
enum ChatPurpose {
    Normalize,
    Translate,
}

impl ChatPurpose {
    fn temperature(self) -> f32 {
        match self {
            Self::Normalize => NORMALIZE_TEMPERATURE,
            Self::Translate => TRANSLATE_TEMPERATURE,
        }
    }
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_path: Option<&'a str>,
    messages: Vec<ChatMessageRequest<'a>>,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    stream: bool,
}

#[derive(Debug, Serialize)]
struct ChatMessageRequest<'a> {
    role: &'a str,
    content: String,
}

/// The concrete rescorer type used by the pipeline.
type InputLmRescorer = Rescorer<LmScorer<MarisaTrie>>;

/// Lazy-loaded input-LM rescorer shared across `Pipeline` clones.
///
/// The 120 MB model is memory-mapped on first use when `RescoreConfig::enabled`
/// is true, then reused for every subsequent caption. `Debug` reports only
/// whether the model is loaded so the inner model/trie types (which do not
/// implement `Debug`) are never formatted.
#[derive(Clone)]
struct RescoreHandle(Arc<Mutex<Option<Arc<InputLmRescorer>>>>);

impl std::fmt::Debug for RescoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let loaded = self.0.lock().map(|opt| opt.is_some()).unwrap_or(false);
        f.debug_struct("RescoreHandle").field("loaded", &loaded).finish()
    }
}

#[derive(Debug)]
struct ZenzContextSnapshot {
    text: String,
    diagnostics: ZenzContextDiagnostics,
}

#[derive(Debug)]
struct ZenzContextTurn {
    turn_session_id: u64,
    turn_id: u64,
    text: String,
}

#[derive(Debug)]
struct ZenzContextSession {
    session_id: String,
    capture_generation: Option<u64>,
    finalized_turns: VecDeque<ZenzContextTurn>,
}

impl ZenzContextSession {
    fn new(session_id: &str, capture_generation: Option<u64>) -> Self {
        Self {
            session_id: session_id.to_string(),
            capture_generation,
            finalized_turns: VecDeque::new(),
        }
    }

    fn matches(&self, session_id: &str, capture_generation: Option<u64>) -> bool {
        self.session_id == session_id && self.capture_generation == capture_generation
    }
}

fn ensure_zenz_context_session(
    context: &mut Option<ZenzContextSession>,
    session_id: &str,
    capture_generation: Option<u64>,
) -> bool {
    if context.as_ref().is_some_and(|current| current.matches(session_id, capture_generation)) {
        return false;
    }
    let discarded = context.is_some();
    *context = Some(ZenzContextSession::new(session_id, capture_generation));
    discarded
}

fn contributing_zenz_turn_count(turns: &[&ZenzContextTurn], character_count: usize) -> usize {
    let mut remaining = character_count;
    turns
        .iter()
        .rev()
        .take_while(|turn| {
            if remaining == 0 {
                return false;
            }
            remaining = remaining.saturating_sub(grapheme_count(&turn.text));
            true
        })
        .filter(|turn| !turn.text.is_empty())
        .count()
}

impl Default for RescoreHandle {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

impl RescoreHandle {
    /// Returns the rescorer, loading the model on first call.
    fn get_or_load(&self, config: &RescoreConfig) -> Result<Arc<InputLmRescorer>, String> {
        let mut guard = self.0.lock().map_err(|_| "rescorer lock poisoned".to_string())?;
        if let Some(ref r) = *guard {
            return Ok(Arc::clone(r));
        }
        let rescorer = Self::load(config)?;
        *guard = Some(Arc::clone(&rescorer));
        Ok(rescorer)
    }

    fn load(config: &RescoreConfig) -> Result<Arc<InputLmRescorer>, String> {
        let base =
            config.model_path.as_deref().map(expand_model_path).unwrap_or_else(default_model_path);
        let params = NgramParams::default();
        let model =
            open_model(&base, params).map_err(|e| format!("input-LM model load failed: {e}"))?;
        let tokenizer = load_input_lm_tokenizer()?;
        let scorer = LmScorer::new(model, tokenizer);
        let rescorer = Rescorer::with_recommended_weights(scorer, AsrConfusionRules::default())
            .with_lm_weight(config.lm_weight)
            .with_confusion_weight(config.confusion_weight)
            .with_overcorrection_margin(config.overcorrection_margin);
        Ok(Arc::new(rescorer))
    }

    /// Drop a cached rescorer so the next enabled call reloads model + weights.
    fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

/// Process-wide counters shared by cloned [`Pipeline`] handles. Counters are
/// intentionally numeric only; no model prompt, candidate, or context text is
/// retained in diagnostics.
#[derive(Debug, Default)]
struct ZenzVerifierMetrics {
    load_failure: AtomicU64,
    load_failure_reason: AtomicU8,
    called: AtomicU64,
    skipped: AtomicU64,
    verified: AtomicU64,
    prefix_constraint_returned: AtomicU64,
    exhausted: AtomicU64,
    exhausted_with_constrained_candidate: AtomicU64,
    exhausted_with_dictionary_fallback: AtomicU64,
    skipped_by_policy: AtomicU64,
    deadline_exceeded: AtomicU64,
    capability_unavailable: AtomicU64,
    error: AtomicU64,
    unverified_fallback: AtomicU64,
    iterations: AtomicU64,
}

impl ZenzVerifierMetrics {
    fn record_load_failure(&self, reason: ZenzVerifierLoadFailureReason) {
        self.load_failure.fetch_add(1, Ordering::Relaxed);
        self.load_failure_reason.store(reason.code(), Ordering::Relaxed);
    }

    fn record_disabled(&self) {
        self.skipped.fetch_add(1, Ordering::Relaxed);
    }

    fn record_result(&self, state: &VerificationState, iterations: usize) {
        if matches!(state, VerificationState::SkippedByPolicy) {
            self.skipped.fetch_add(1, Ordering::Relaxed);
        } else {
            self.called.fetch_add(1, Ordering::Relaxed);
        }
        self.iterations.fetch_add(iterations as u64, Ordering::Relaxed);
        match state {
            VerificationState::Verified => {
                self.verified.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::PrefixConstraintReturned => {
                self.prefix_constraint_returned.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::Exhausted => {
                self.exhausted.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::ExhaustedWithConstrainedCandidate => {
                self.exhausted_with_constrained_candidate.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::ExhaustedWithDictionaryFallback => {
                self.exhausted_with_dictionary_fallback.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::SkippedByPolicy => {
                self.skipped_by_policy.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::DeadlineExceeded => {
                self.deadline_exceeded.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::CapabilityUnavailable => {
                self.capability_unavailable.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::Error => {
                self.error.fetch_add(1, Ordering::Relaxed);
            }
            VerificationState::UnverifiedFallback => {
                self.unverified_fallback.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn snapshot(&self, enabled: bool, loaded: bool) -> ZenzVerifierDiagnostics {
        ZenzVerifierDiagnostics {
            enabled,
            build_available: zenz_verifier_build_available(),
            loaded,
            load_failure_count: self.load_failure.load(Ordering::Relaxed),
            load_failure_reason: ZenzVerifierLoadFailureReason::from_code(
                self.load_failure_reason.load(Ordering::Relaxed),
            ),
            called_count: self.called.load(Ordering::Relaxed),
            skipped_count: self.skipped.load(Ordering::Relaxed),
            verified_count: self.verified.load(Ordering::Relaxed),
            prefix_constraint_returned_count: self
                .prefix_constraint_returned
                .load(Ordering::Relaxed),
            exhausted_count: self.exhausted.load(Ordering::Relaxed),
            exhausted_with_constrained_candidate_count: self
                .exhausted_with_constrained_candidate
                .load(Ordering::Relaxed),
            exhausted_with_dictionary_fallback_count: self
                .exhausted_with_dictionary_fallback
                .load(Ordering::Relaxed),
            skipped_by_policy_count: self.skipped_by_policy.load(Ordering::Relaxed),
            deadline_exceeded_count: self.deadline_exceeded.load(Ordering::Relaxed),
            capability_unavailable_count: self.capability_unavailable.load(Ordering::Relaxed),
            error_count: self.error.load(Ordering::Relaxed),
            unverified_fallback_count: self.unverified_fallback.load(Ordering::Relaxed),
            iteration_count: self.iterations.load(Ordering::Relaxed),
        }
    }
}

/// Shared mutable verifier slot. The Candle implementation is intentionally
/// hidden behind a mutex because the AzooKey contract is synchronous and a
/// model session is mutable across verification rounds.
struct ZenzVerifierHandle {
    inner: Arc<Mutex<Option<Box<dyn DraftVerifier + Send>>>>,
    model_path: Arc<Mutex<Option<PathBuf>>>,
    tokenizer_directory: Arc<Mutex<Option<PathBuf>>>,
}

impl Clone for ZenzVerifierHandle {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            model_path: Arc::clone(&self.model_path),
            tokenizer_directory: Arc::clone(&self.tokenizer_directory),
        }
    }
}

impl std::fmt::Debug for ZenzVerifierHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("ZenzVerifierHandle").field("loaded", &self.is_loaded()).finish()
    }
}

impl Default for ZenzVerifierHandle {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            model_path: Arc::new(Mutex::new(None)),
            tokenizer_directory: Arc::new(Mutex::new(None)),
        }
    }
}

impl ZenzVerifierHandle {
    fn is_loaded(&self) -> bool {
        self.inner.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    #[cfg(feature = "candle")]
    fn is_loaded_for(&self, model_path: &Path, tokenizer_directory: &Path) -> bool {
        let loaded = self.inner.lock().map(|guard| guard.is_some()).unwrap_or(false);
        let same_model = self
            .model_path
            .lock()
            .ok()
            .and_then(|path| path.as_deref().map(|path| path == model_path))
            .unwrap_or(false);
        let same_tokenizer = self
            .tokenizer_directory
            .lock()
            .ok()
            .and_then(|path| path.as_deref().map(|path| path == tokenizer_directory))
            .unwrap_or(false);
        loaded && same_model && same_tokenizer
    }

    #[cfg(feature = "candle")]
    fn install(
        &self,
        verifier: Box<dyn DraftVerifier + Send>,
        model_path: PathBuf,
        tokenizer_directory: PathBuf,
    ) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let Ok(mut path) = self.model_path.lock() else {
            return false;
        };
        let Ok(mut tokenizer) = self.tokenizer_directory.lock() else {
            return false;
        };
        *inner = Some(verifier);
        *path = Some(model_path);
        *tokenizer = Some(tokenizer_directory);
        true
    }

    #[cfg(feature = "candle")]
    fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = None;
        }
        if let Ok(mut path) = self.model_path.lock() {
            *path = None;
        }
        if let Ok(mut tokenizer) = self.tokenizer_directory.lock() {
            *tokenizer = None;
        }
    }
}

/// Prefer the user-cache tokenizer (copied from the app bundle / download),
/// then fall back to the source-tree submodule for developer builds.
fn load_input_lm_tokenizer() -> Result<ZenzTokenizer, String> {
    let cache = crate::model_runtime::input_lm_tokenizer_cache_dir();
    if let Some(tokenizer) = ZenzTokenizer::from_dir(&cache) {
        return Ok(tokenizer);
    }
    ZenzTokenizer::from_submodule().ok_or_else(|| {
        "input-LM tokenizer load failed (install Input N5 LM or keep the AzooKey submodule checked out)"
            .to_string()
    })
}

/// Default model location: `$HOME/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm`.
fn default_model_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join(".cache")
        .join("caption-bridge-input-lm")
        .join("input_n5_lm_v1")
        .join("lm")
}

/// Expand a user-supplied model path, resolving a leading `~` to `$HOME`.
fn expand_model_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[derive(Debug, Clone)]
pub struct Pipeline {
    client: Client,
    /// LOUDS loading reads the connection matrix and shard metadata. Keep the
    /// loaded dictionary for the lifetime of the native pipeline so each
    /// 640ms audio chunk only pays the Viterbi cost, not a multi-second disk
    /// load. The mutex is required because the converter's internal shard
    /// cache uses `RefCell`; conversions remain short and serialized here.
    azookey_dictionaries: Arc<Mutex<HashMap<String, AzooKeyDictionary>>>,
    /// Lazy-loaded input-LM rescorer. Only loaded when `RescoreConfig::enabled`
    /// is true; otherwise stays `None` and the pipeline path is unchanged.
    rescorer: RescoreHandle,
    /// Lazy-loaded Vibrato IPADIC reader for kanji → hiragana before AzooKey.
    vibrato: Arc<Mutex<Option<Arc<VibratoReader>>>>,
    /// Confirmed converted captions used as Zenz left context. Parapper does not
    /// expose a speaker ID, so context cannot currently reset on speaker changes.
    zenz_context: Arc<Mutex<Option<ZenzContextSession>>>,
    zenz_context_discarded_sessions: Arc<AtomicU64>,
    zenz_verifier: ZenzVerifierHandle,
    zenz_verifier_metrics: Arc<ZenzVerifierMetrics>,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self {
            client: Client::new(),
            azookey_dictionaries: Arc::new(Mutex::new(HashMap::new())),
            rescorer: RescoreHandle::default(),
            vibrato: Arc::new(Mutex::new(None)),
            zenz_context: Arc::new(Mutex::new(None)),
            zenz_context_discarded_sessions: Arc::new(AtomicU64::new(0)),
            zenz_verifier: ZenzVerifierHandle::default(),
            zenz_verifier_metrics: Arc::new(ZenzVerifierMetrics::default()),
        }
    }
}

impl Pipeline {
    /// Drop a cached input-LM rescorer so the next enabled caption reloads the
    /// model, tokenizer, and weights from the current `RescoreConfig`.
    pub fn invalidate_rescorer(&self) {
        self.rescorer.clear();
    }

    /// Drop loaded AzooKey dictionaries so a saved user TSV is visible on the
    /// next conversion without restarting capture or the application.
    pub fn invalidate_azookey_dictionaries(&self) {
        if let Ok(mut dictionaries) = self.azookey_dictionaries.lock() {
            dictionaries.clear();
        }
    }

    /// Convert kanji-bearing text to hiragana via Vibrato before AzooKey.
    ///
    /// Pure kana input is returned unchanged. On dictionary load failure the
    /// original text is returned (fail-open) so captions keep flowing.
    #[allow(clippy::excessive_nesting)]
    fn ensure_azookey_reading(&self, text: &str) -> String {
        if !contains_kanji(text) {
            return text.to_string();
        }
        let reader = {
            let mut guard = match self.vibrato.lock() {
                Ok(guard) => guard,
                Err(error) => {
                    log::warn!(
                        target: "pipeline_vibrato",
                        "vibrato lock poisoned, falling back: {error}"
                    );
                    return text.to_string();
                }
            };
            if let Some(ref reader) = *guard {
                Arc::clone(reader)
            } else {
                match crate::vibrato_runtime::try_default() {
                    Some(reader) => {
                        let reader = Arc::new(reader);
                        *guard = Some(Arc::clone(&reader));
                        reader
                    }
                    None => {
                        log::warn!(
                            target: "pipeline_vibrato",
                            "vibrato dictionary unavailable, falling back to raw text"
                        );
                        return text.to_string();
                    }
                }
            }
        };
        reader.reading_for_azookey(text)
    }

    fn zenz_left_context(
        &self,
        session_id: &str,
        capture_generation: Option<u64>,
        turn_session_id: u64,
        turn_id: u64,
        is_final: bool,
        enabled: bool,
    ) -> ZenzContextSnapshot {
        let empty_snapshot = || ZenzContextSnapshot {
            text: String::new(),
            diagnostics: ZenzContextDiagnostics {
                enabled,
                is_final,
                character_count: 0,
                turn_count: 0,
                discarded_session_count: self
                    .zenz_context_discarded_sessions
                    .load(Ordering::Relaxed),
            },
        };
        let Ok(mut context) = self.zenz_context.lock() else {
            log::warn!(target: "pipeline_normalize", "Zenz context lock poisoned; omitting context");
            return empty_snapshot();
        };
        let discarded = ensure_zenz_context_session(&mut context, session_id, capture_generation);
        self.zenz_context_discarded_sessions.fetch_add(u64::from(discarded), Ordering::Relaxed);
        let Some(current) = context.as_ref() else {
            return empty_snapshot();
        };
        if !enabled {
            return empty_snapshot();
        }
        let prior_turns = current
            .finalized_turns
            .iter()
            .filter(|turn| turn.turn_session_id != turn_session_id || turn.turn_id != turn_id)
            .collect::<Vec<_>>();
        let prior_text = prior_turns.iter().map(|turn| turn.text.as_str()).collect::<String>();
        let text = suffix_graphemes(&prior_text, ZENZ_CONTEXT_MAX_GRAPHEMES);
        let character_count = grapheme_count(&text);
        let turn_count = contributing_zenz_turn_count(&prior_turns, character_count);
        ZenzContextSnapshot {
            text,
            diagnostics: ZenzContextDiagnostics {
                enabled,
                is_final,
                character_count: u32::try_from(character_count).unwrap_or(u32::MAX),
                turn_count: u32::try_from(turn_count).unwrap_or(u32::MAX),
                discarded_session_count: self
                    .zenz_context_discarded_sessions
                    .load(Ordering::Relaxed),
            },
        }
    }

    fn append_zenz_context(
        &self,
        session_id: &str,
        capture_generation: Option<u64>,
        turn_session_id: u64,
        turn_id: u64,
        converted_text: &str,
    ) {
        let Ok(mut context) = self.zenz_context.lock() else {
            log::warn!(target: "pipeline_normalize", "Zenz context lock poisoned; dropping update");
            return;
        };
        let discarded = ensure_zenz_context_session(&mut context, session_id, capture_generation);
        self.zenz_context_discarded_sessions.fetch_add(u64::from(discarded), Ordering::Relaxed);
        let Some(current) = context.as_mut() else {
            return;
        };
        if let Some(turn) = current
            .finalized_turns
            .iter_mut()
            .find(|turn| turn.turn_session_id == turn_session_id && turn.turn_id == turn_id)
        {
            // A corrected final revises its existing entry instead of appending
            // the same turn twice to future prompts.
            turn.text = suffix_graphemes(converted_text, ZENZ_CONTEXT_MAX_GRAPHEMES);
            return;
        }
        current.finalized_turns.push_back(ZenzContextTurn {
            turn_session_id,
            turn_id,
            text: suffix_graphemes(converted_text, ZENZ_CONTEXT_MAX_GRAPHEMES),
        });
        if current.finalized_turns.len() > ZENZ_CONTEXT_MAX_TURNS {
            current.finalized_turns.pop_front();
        }
    }

    fn assign_caption_boundary_offsets(&self, ready: &mut CaptionPayload) {
        match self.vibrato_reader() {
            Some(reader) => {
                let bounds = reader.caption_boundary_offsets(&ready.source_text);
                ready.sentence_end_offsets = bounds.sentence_ends;
                ready.soft_break_offsets = bounds.soft_breaks;
            }
            None => {
                ready.sentence_end_offsets =
                    crate::sentence_boundary::heuristic_sentence_end_offsets(
                        &ready.source_text,
                        false,
                    );
                ready.soft_break_offsets =
                    crate::sentence_boundary::heuristic_soft_break_offsets(&ready.source_text);
            }
        }
    }

    fn vibrato_reader(&self) -> Option<Arc<crate::vibrato_runtime::VibratoReader>> {
        let mut guard = self.vibrato.lock().ok()?;
        if let Some(ref reader) = *guard {
            return Some(Arc::clone(reader));
        }
        let reader = crate::vibrato_runtime::try_default().map(Arc::new)?;
        *guard = Some(Arc::clone(&reader));
        Some(reader)
    }

    /// Load the selected AzooKey dictionary before the microphone starts.
    /// Public LOUDS files are intentionally loaded once on the capture
    /// boundary; otherwise the first 640ms chunk would pay the disk/matrix
    /// initialization cost and make the first Japanese caption appear late.
    /// A malformed optional path is recoverable and remains visible in the
    /// normalizer stage, so this warm-up never makes capture fail.
    pub fn warm_azookey_dictionary(&self, config: &AppConfig) -> Result<(), String> {
        // The verifier is optional and fail-open. Warm it on the same capture
        // boundary as the dictionary so a model load can never block a live
        // subtitle midway through an utterance.
        self.warm_zenz_verifier(config);
        if config.models.normalizer != "azookey-rust" {
            return Ok(());
        }
        let paths = azookey_dictionary_paths(config);
        if let Some(error) = azookey_dictionary_paths_error(&paths) {
            return Err(error);
        }
        let cache_key = azookey_dictionary_cache_key(&paths);
        let mut dictionaries = self
            .azookey_dictionaries
            .lock()
            .map_err(|_| "AzooKey dictionary cache lock poisoned".to_string())?;
        if dictionaries.contains_key(&cache_key) {
            return Ok(());
        }
        let dictionary = AzooKeyDictionary::from_paths(&paths)?;
        dictionaries.insert(cache_key, dictionary);
        Ok(())
    }

    /// Load the optional embedded Zenz verifier at the capture boundary. Model
    /// and tokenizer failures are deliberately recoverable: capture continues
    /// with the dictionary path and diagnostics expose the failure category.
    fn warm_zenz_verifier(&self, config: &AppConfig) {
        if config.models.normalizer != "azookey-rust" || !zenz_verifier_enabled() {
            return;
        }
        #[cfg(not(feature = "candle"))]
        {
            // An empty slot is an honest capability boundary, and the shared
            // converter reports `CapabilityUnavailable` instead of claiming a
            // dictionary-only result was verified.
            warn_zenz_verifier_load_once(
                "verifier runtime switch is on but this build has no zenz-verifier backend; using dictionary fallback",
            );
        }
        #[cfg(feature = "candle")]
        {
            self.load_zenz_verifier(config);
        }
    }

    #[cfg(feature = "candle")]
    fn load_zenz_verifier(&self, config: &AppConfig) {
        let Some(model_path) = zenz_verifier_model_path(config) else {
            self.zenz_verifier_metrics
                .record_load_failure(ZenzVerifierLoadFailureReason::ModelNotFound);
            warn_zenz_verifier_load_once(
                "embedded Zenz verifier load failed reason=model_not_found; using dictionary fallback",
            );
            return;
        };
        let tokenizer_directory = crate::model_runtime::input_lm_tokenizer_cache_dir();
        if self.zenz_verifier.is_loaded_for(&model_path, &tokenizer_directory) {
            return;
        }
        // Do not retain a verifier loaded from a previous model path while a
        // new identity is being checked. A failed replacement must fall back
        // to the dictionary, never silently use the old model.
        self.zenz_verifier.clear();
        if !model_path.is_file() {
            self.zenz_verifier_metrics
                .record_load_failure(ZenzVerifierLoadFailureReason::ModelNotFound);
            warn_zenz_verifier_load_once(
                "embedded Zenz verifier load failed reason=model_not_found; using dictionary fallback",
            );
            return;
        }
        let verifier = match EmbeddedZenzDraftVerifier::load(
            &model_path,
            &tokenizer_directory,
            ZENZ_VERIFIER_MODEL_REVISION,
            &Device::Cpu,
        ) {
            Ok(verifier) => verifier,
            Err(error) => {
                let reason = zenz_verifier_load_failure_reason(&error);
                self.zenz_verifier_metrics.record_load_failure(reason);
                warn_zenz_verifier_load_once(&format!(
                    "embedded Zenz verifier load failed reason={}; using dictionary fallback",
                    reason.as_str()
                ));
                return;
            }
        };
        let elapsed_ms = verifier.load_elapsed().as_millis();
        if !self.zenz_verifier.install(
            Box::new(verifier),
            model_path.clone(),
            tokenizer_directory.clone(),
        ) {
            self.zenz_verifier_metrics.record_load_failure(ZenzVerifierLoadFailureReason::Other);
            warn_zenz_verifier_load_once(
                "embedded Zenz verifier load failed reason=other; using dictionary fallback",
            );
            return;
        }
        log::info!(
            target: "pipeline_normalize",
            "embedded Zenz verifier loaded elapsed_ms={elapsed_ms}"
        );
    }

    fn zenz_verifier_diagnostics(&self) -> ZenzVerifierDiagnostics {
        self.zenz_verifier_metrics.snapshot(zenz_verifier_enabled(), self.zenz_verifier.is_loaded())
    }

    /// ASR → normalize only. Translation is intentionally left empty so the UI
    /// can show the normalized source without waiting on the translator.
    ///
    /// Returns `Ok(None)` when the chunk contained no usable speech (silence,
    /// noise-only, or Parapper `transcript_missing`). Callers must treat that as
    /// a soft skip — not a capture/session failure.
    ///
    /// `stages` is filled with independent ASR / normalizer events (including
    /// soft skips and failures) so debug mode can show per-stage latency.
    ///
    /// `on_stage` is invoked as soon as each stage completes so the UI can render
    /// progressive latency rows without waiting for the rest of the pipeline.
    ///
    /// `on_caption` is invoked once after normalization. Raw ASR text is retained
    /// in the `asr` stage event for DebugPanel inspection, but is never sent to
    /// the standard caption surface. This keeps user-facing text consistent with
    /// the selected AzooKey/zenz normalizer while preserving per-stage timings.
    pub async fn recognize_source(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
        on_caption: &mut (dyn FnMut(&CaptionPayload) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        self.recognize_source_with_id(config, wav, None, stages, on_stage, on_caption).await
    }

    /// ASR → normalize only with an optional caller-provided utterance ID.
    ///
    /// Live microphone chunks provide an ID generated at the capture boundary
    /// so retries and progressive source/translation events can be correlated
    /// with the originating audio. Empty or whitespace-only IDs are treated as
    /// missing and replaced with a UUID, preserving the historical behavior for
    /// callers that use [`Self::recognize_source`].
    pub async fn recognize_source_with_id(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
        provided_utterance_id: Option<&str>,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
        on_caption: &mut (dyn FnMut(&CaptionPayload) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let started_at = now_millis();
        let utterance_id = resolve_utterance_id(provided_utterance_id);
        let audio_snippet = format!("wavBytes={}", wav.len());
        let asr_model = config.models.asr.as_str();
        let normalize_model = config.models.normalizer.as_str();

        let asr_started = Instant::now();
        let recognized = match self.transcribe(config, wav).await {
            Ok(text) if text.trim().is_empty() => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "asr",
                        &utterance_id,
                        asr_model,
                        &audio_snippet,
                        "",
                        elapsed_ms(asr_started),
                        true,
                        None,
                    ),
                );
                return Ok(None);
            }
            Ok(text) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "asr",
                        &utterance_id,
                        asr_model,
                        &audio_snippet,
                        &text,
                        elapsed_ms(asr_started),
                        true,
                        None,
                    ),
                );
                text
            }
            Err(PipelineError::MissingText) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "asr",
                        &utterance_id,
                        asr_model,
                        &audio_snippet,
                        "",
                        elapsed_ms(asr_started),
                        true,
                        None,
                    ),
                );
                return Ok(None);
            }
            Err(error) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "asr",
                        &utterance_id,
                        asr_model,
                        &audio_snippet,
                        "",
                        elapsed_ms(asr_started),
                        false,
                        Some(error.to_string()),
                    ),
                );
                return Err(error);
            }
        };

        // AzooKey is sync/local and fast; zenz is remote. The normalizer is the
        // source of truth for user-facing Japanese, so do not emit raw ASR text
        // while it is still running. The completed stage below is emitted before
        // the command returns, allowing the frontend to measure normalize→paint.
        // Kanji-bearing ASR output is converted to hiragana via Vibrato first so
        // AzooKey receives a phonetic reading.
        let vibrato_started = Instant::now();
        let reading = self.ensure_azookey_reading(&recognized);
        if reading != recognized || contains_kanji(&recognized) {
            record_stage(
                stages,
                on_stage,
                stage_event(
                    "vibrato",
                    &utterance_id,
                    "vibrato-ipadic",
                    &recognized,
                    &reading,
                    elapsed_ms(vibrato_started),
                    true,
                    None,
                ),
            );
        }
        let normalize_input = repair_weather_reading_confusion(&reading);
        let normalize_started = Instant::now();
        let normalized = match self.normalize(config, &normalize_input, None).await {
            Ok(NormalizeOutcome::Success(text)) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "normalize",
                        &utterance_id,
                        normalize_model,
                        &normalize_input,
                        &text,
                        elapsed_ms(normalize_started),
                        true,
                        None,
                    )
                    .with_zenz_verifier(
                        (normalize_model == "azookey-rust")
                            .then(|| self.zenz_verifier_diagnostics()),
                    ),
                );
                text
            }
            Ok(NormalizeOutcome::Fallback { text, error }) => {
                // A broken optional dictionary must be visible in DebugPanel,
                // but it must not erase an otherwise usable source caption.
                // `ok = false` is deliberate: the configured dictionary stage
                // failed even though the built-in AzooKey fallback produced
                // displayable text.  The non-empty output distinguishes this
                // recoverable fallback from a hard normalizer failure below.
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "normalize",
                        &utterance_id,
                        normalize_model,
                        &normalize_input,
                        &text,
                        elapsed_ms(normalize_started),
                        false,
                        Some(error),
                    )
                    .with_zenz_verifier(
                        (normalize_model == "azookey-rust")
                            .then(|| self.zenz_verifier_diagnostics()),
                    ),
                );
                text
            }
            Err(error) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "normalize",
                        &utterance_id,
                        normalize_model,
                        &normalize_input,
                        "",
                        elapsed_ms(normalize_started),
                        false,
                        Some(error.to_string()),
                    )
                    .with_zenz_verifier(
                        (normalize_model == "azookey-rust")
                            .then(|| self.zenz_verifier_diagnostics()),
                    ),
                );
                // Do not fall back to raw ASR on the standard caption surface:
                // doing so would make displayed text differ from the selected
                // normalizer output. The command layer surfaces this concrete
                // failure while the `asr`/`normalize` stage rows remain visible
                // in DebugPanel; the existing caption remains on screen.
                return Err(error);
            }
        };
        if normalized.trim().is_empty() {
            // Empty normalization is a soft skip. No raw text was painted, so
            // the UI keeps the previous non-empty caption unchanged.
            return Ok(None);
        }
        let normalized = repair_caption_phrase_confusions(&normalized);
        let mut ready = source_ready_caption(config, normalized, started_at, utterance_id);
        self.assign_caption_boundary_offsets(&mut ready);
        // Always emit the normalized source, even when it happens to match the
        // raw ASR string, so first-caption timing is tied to normalization.
        on_caption(&ready);
        Ok(Some(ready))
    }

    /// Normalize a structured output from one persistent Parapper session.
    ///
    /// This is the live desktop path: Parapper owns VAD/Segment/Turn state and
    /// emits interim/final text over one WebSocket. The native pipeline starts
    /// at the explicit AzooKey phonetic input when the sidecar provides it,
    /// records the original Vibrato surface in the ASR stage input, and then
    /// runs the same cached AzooKey normalizer used by the legacy HTTP path.
    pub async fn normalize_parapper_output(
        &self,
        config: &AppConfig,
        output: ParapperRecognitionInput,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
        on_caption: &mut (dyn FnMut(&CaptionPayload) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let utterance_id =
            format!("parapper:{}:{}:{}", output.session_id, output.turn_session_id, output.turn_id);
        let recognized = output
            .azookey_input_text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(output.text.as_str())
            .trim()
            .to_string();
        let vibrato_surface =
            output.source_text.as_deref().map(str::trim).filter(|text| !text.is_empty());
        let source_surface = vibrato_surface.unwrap_or(recognized.as_str());
        log::trace!(
            target: "pipeline_asr",
            "Parapper turn session={} turn={} revision={} output_sequence={} segment={} previous_segment={:?} language={} detected_language={:?}",
            output.session_id,
            output.turn_id,
            output.revision,
            output.output_sequence,
            output.segment_id,
            output.previous_segment_id,
            output.source_language,
            output.detected_language,
        );
        let asr_model = if output.source_asr_model.trim().is_empty() {
            config.models.asr.as_str()
        } else {
            output.source_asr_model.as_str()
        };
        let asr_started = Instant::now();
        if recognized.is_empty() {
            record_stage(
                stages,
                on_stage,
                stage_event_with_surface(
                    "asr",
                    &utterance_id,
                    asr_model,
                    source_surface,
                    "",
                    elapsed_ms(asr_started),
                    true,
                    None,
                    None,
                ),
            );
            return Ok(None);
        }
        record_stage(
            stages,
            on_stage,
            stage_event_with_surface(
                "asr",
                &utterance_id,
                asr_model,
                source_surface,
                &recognized,
                output.elapsed_ms,
                true,
                None,
                vibrato_surface,
            ),
        );

        // --- Vibrato pre-pass (kanji → hiragana) ---
        // AzooKey expects a phonetic reading. When Parapper/ASR still carries
        // kanji, Vibrato IPADIC F[7] supplies hiragana before rescore/normalize.
        // Pure kana passes through unchanged. Merge key below is this reading
        // (post-vibrato, pre-rescore), not the original kanji surface.
        let vibrato_started = Instant::now();
        let reading = self.ensure_azookey_reading(&recognized);
        if reading != recognized || contains_kanji(&recognized) {
            record_stage(
                stages,
                on_stage,
                stage_event_with_surface(
                    "vibrato",
                    &utterance_id,
                    "vibrato-ipadic",
                    &recognized,
                    &reading,
                    elapsed_ms(vibrato_started),
                    true,
                    None,
                    None,
                ),
            );
        }

        // --- Rescore stage (opt-in, final only) ---
        // Interim windows are frequent and spawn_blocking work cannot be
        // cancelled after a timeout, so rescoring each one can accumulate CPU
        // tasks. The final runs once per turn with the configured timeout.
        // The merge key (`azookey_input_text`) always retains the post-vibrato,
        // unrescored reading, including when interim rescoring is skipped.
        let repaired_reading = repair_weather_reading_confusion(&reading);
        let normalize_input = if config.rescore.enabled && output.is_final {
            let rescore_started = Instant::now();
            let (rescored, rescore_error) = self.rescore_reading(config, &repaired_reading).await;
            record_stage(
                stages,
                on_stage,
                stage_event_with_surface(
                    "rescore",
                    &utterance_id,
                    "input-n5-lm-v1",
                    &repaired_reading,
                    &rescored,
                    elapsed_ms(rescore_started),
                    rescore_error.is_none(),
                    rescore_error,
                    None,
                ),
            );
            rescored
        } else {
            repaired_reading
        };

        let left_context = self.zenz_left_context(
            &output.session_id,
            output.capture_generation,
            output.turn_session_id,
            output.turn_id,
            output.is_final,
            zenz_left_context_enabled(),
        );
        let zenz_context_diagnostics = (config.models.normalizer.starts_with("zenz-")
            || (config.models.normalizer == "azookey-rust" && zenz_verifier_enabled()))
        .then_some(left_context.diagnostics);
        let normalize_started = Instant::now();
        let normalized =
            match self.normalize(config, &normalize_input, Some(&left_context.text)).await {
                Ok(NormalizeOutcome::Success(text)) => {
                    record_stage(
                        stages,
                        on_stage,
                        stage_event(
                            "normalize",
                            &utterance_id,
                            config.models.normalizer.as_str(),
                            &normalize_input,
                            &text,
                            elapsed_ms(normalize_started),
                            true,
                            None,
                        )
                        .with_zenz_context(zenz_context_diagnostics)
                        .with_zenz_verifier(
                            (config.models.normalizer == "azookey-rust")
                                .then(|| self.zenz_verifier_diagnostics()),
                        ),
                    );
                    text
                }
                Ok(NormalizeOutcome::Fallback { text, error }) => {
                    record_stage(
                        stages,
                        on_stage,
                        stage_event(
                            "normalize",
                            &utterance_id,
                            config.models.normalizer.as_str(),
                            &normalize_input,
                            &text,
                            elapsed_ms(normalize_started),
                            false,
                            Some(error),
                        )
                        .with_zenz_context(zenz_context_diagnostics)
                        .with_zenz_verifier(
                            (config.models.normalizer == "azookey-rust")
                                .then(|| self.zenz_verifier_diagnostics()),
                        ),
                    );
                    text
                }
                Err(error) => {
                    record_stage(
                        stages,
                        on_stage,
                        stage_event(
                            "normalize",
                            &utterance_id,
                            config.models.normalizer.as_str(),
                            &normalize_input,
                            "",
                            elapsed_ms(normalize_started),
                            false,
                            Some(error.to_string()),
                        )
                        .with_zenz_context(zenz_context_diagnostics)
                        .with_zenz_verifier(
                            (config.models.normalizer == "azookey-rust")
                                .then(|| self.zenz_verifier_diagnostics()),
                        ),
                    );
                    return Err(error);
                }
            };
        if normalized.trim().is_empty() {
            return Ok(None);
        }
        let normalized = repair_caption_phrase_confusions(&normalized);
        if output.is_final {
            self.append_zenz_context(
                &output.session_id,
                output.capture_generation,
                output.turn_session_id,
                output.turn_id,
                &normalized,
            );
        }

        let mut ready = source_ready_caption_with_input(
            config,
            normalized,
            now_millis().saturating_sub(output.audio_duration_ms.unwrap_or_default()),
            utterance_id,
            // Merge key invariant: post-vibrato reading, never the rescored
            // one. The frontend uses this field for
            // `hasSameOrExtendedAzookeyReading` caption-merge decisions; feeding
            // a corrected reading here would break replace-in-place and cause
            // captions to append instead of replacing (regression fixed at
            // commit e393070). When the ASR surface had kanji, this is the
            // Vibrato hiragana reading (stable phonetic merge key).
            Some(reading),
        );
        self.assign_caption_boundary_offsets(&mut ready);
        ready.is_final = output.is_final;
        on_caption(&ready);
        Ok(Some(ready))
    }

    /// Fill `translation_text` for an existing caption, preserving the same `id`
    /// so progressive UI updates stay correlated with one audio chunk.
    ///
    /// Appends a `translate` stage event to `stages` (success or failure) and
    /// invokes `on_stage` immediately when the translator finishes.
    pub async fn complete_translation(
        &self,
        config: &AppConfig,
        caption: CaptionPayload,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let translate_started = Instant::now();
        let source = caption.source_text.clone();
        let utterance_id = caption.id.clone();
        let translate_model = config.models.translator.as_str();
        if !has_translatable_content(&source) {
            record_stage(
                stages,
                on_stage,
                stage_event(
                    "translate",
                    &utterance_id,
                    translate_model,
                    &source,
                    "",
                    elapsed_ms(translate_started),
                    true,
                    None,
                ),
            );
            return Ok(None);
        }
        match self.translate(config, &source).await {
            Ok(translation) => {
                let finished = with_translation(caption, &translation, now_millis());
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "translate",
                        &utterance_id,
                        translate_model,
                        &source,
                        &finished.translation_text,
                        elapsed_ms(translate_started),
                        true,
                        None,
                    ),
                );
                Ok(Some(finished))
            }
            Err(error) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "translate",
                        &utterance_id,
                        translate_model,
                        &source,
                        "",
                        elapsed_ms(translate_started),
                        false,
                        Some(error.to_string()),
                    ),
                );
                Err(error)
            }
        }
    }

    /// Full pipeline (ASR → normalize → translate). Prefer staged
    /// `recognize_source` + `complete_translation` for live capture so source
    /// display is not blocked by translation latency.
    ///
    /// Kept for non-live / batch callers; live capture must not use this path.
    #[allow(dead_code)]
    pub async fn process(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
        on_caption: &mut (dyn FnMut(&CaptionPayload) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let Some(partial) =
            self.recognize_source(config, wav, stages, on_stage, on_caption).await?
        else {
            return Ok(None);
        };
        self.complete_translation(config, partial, stages, on_stage).await
    }

    async fn transcribe(&self, config: &AppConfig, wav: Vec<u8>) -> Result<String, PipelineError> {
        if config.models.asr != "parapper-ja" {
            return Err(PipelineError::UnsupportedModel(config.models.asr.clone()));
        }
        let url = endpoint_url(&config.endpoint.base_url, &config.endpoint.transcription_path);
        let part = multipart::Part::bytes(wav)
            .file_name("caption-bridge.wav")
            .mime_str("audio/wav")
            .map_err(|error| {
                PipelineError::Model(format!("could not create WAV multipart: {error}"))
            })?;
        let form = multipart::Form::new()
            .part("file", part)
            .text("model", config.models.asr.clone())
            .text("language", config.language.source.clone())
            .text("response_format", "json");
        let response =
            self.client.post(url).timeout(timeout(config)).multipart(form).send().await?;
        let status = response.status();
        let body = response.text().await?;
        // Live mic chunks often contain only ambient noise. Older gateways
        // returned HTTP 422 transcript_missing when Parapper finished without
        // a final — treat as empty ASR, not a pipeline fault. Current gateway
        // soft-returns 200 with empty text instead. A standards-compliant 204
        // has no body at all, so classify it before attempting JSON parsing;
        // otherwise an empty response body would become a spurious Json error.
        if is_no_speech_response(status.as_u16(), &body) {
            log::info!(
                target: "pipeline_asr",
                "no-speech soft-skip status={} body_chars={} body_prefix={}",
                status.as_u16(),
                body.len(),
                body.chars().take(120).collect::<String>()
            );
            return Ok(String::new());
        }
        if !status.is_success() {
            return Err(PipelineError::Http { status: status.as_u16(), body });
        }
        let parsed: TranscriptResponse = serde_json::from_str(&body).or_else(|_| {
            let value: Value = serde_json::from_str(&body)?;
            Ok::<TranscriptResponse, serde_json::Error>(TranscriptResponse {
                text: value.get("text").and_then(Value::as_str).map(str::to_string),
                transcript: value.get("transcript").and_then(Value::as_str).map(str::to_string),
            })
        })?;
        Ok(parsed
            .text
            .or(parsed.transcript)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_default())
    }

    async fn normalize(
        &self,
        config: &AppConfig,
        text: &str,
        left_context: Option<&str>,
    ) -> Result<NormalizeOutcome, PipelineError> {
        match config.models.normalizer.as_str() {
            "azookey-rust" => match zenz_verifier_enabled() {
                true => self.normalize_azookey_with_verifier(config, text, left_context),
                false => {
                    self.zenz_verifier_metrics.record_disabled();
                    normalize_azookey_with_cache(config, text, &self.azookey_dictionaries)
                }
            },
            "zenz-v2-q5-k-m-gguf" | "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf" => {
                // Zenz is a dedicated kana-kanji converter, not an instruction-tuned chat model.
                // Its model contract uses U+EE00 / U+EE01 delimiters around a
                // Katakana phonetic input (the upstream AzooKey prompt builder
                // calls `toKatakana()` before sending the composing text).
                let prompt =
                    zenz_prompt(&config.models.normalizer, text, left_context.unwrap_or_default());
                self.chat(config, &config.models.normalizer, prompt, ChatPurpose::Normalize)
                    .await
                    .map(NormalizeOutcome::Success)
            }
            other => Err(PipelineError::UnsupportedModel(other.to_string())),
        }
    }

    fn normalize_azookey_with_verifier(
        &self,
        config: &AppConfig,
        text: &str,
        left_context: Option<&str>,
    ) -> Result<NormalizeOutcome, PipelineError> {
        // Keep the same empty-input contract as the dictionary-only path. An
        // empty ASR result is not a verifier skip and should not inflate the
        // per-caption skipped counter.
        if text.trim().is_empty() {
            return Ok(NormalizeOutcome::Success(String::new()));
        }

        let paths = azookey_dictionary_paths(config);
        if let Some(error) = azookey_dictionary_paths_error(&paths) {
            self.zenz_verifier_metrics.record_disabled();
            return Ok(azookey_fallback(text, error));
        }

        let cache_key = azookey_dictionary_cache_key(&paths);
        let mut dictionaries = self.azookey_dictionaries.lock().map_err(|_| {
            PipelineError::Model("AzooKey dictionary cache lock poisoned".to_string())
        })?;
        let dictionary = match cached_azookey_dictionary(&mut dictionaries, &cache_key, &paths) {
            Ok(dictionary) => dictionary,
            Err(error) => {
                self.zenz_verifier_metrics.record_disabled();
                return Ok(azookey_fallback(text, error));
            }
        };

        let mut verifier_options = VerifierConversionOptions::new(
            ZENZ_VERIFIER_MAX_ITERATIONS,
            ZENZ_VERIFIER_INFERENCE_CONFIG_REVISION,
        )
        .with_policy(VerifierPolicy::require_left_context());
        if let Some(left_context) = left_context {
            // Do not decide in the desktop layer whether context is usable.
            // The shared AzooKey policy owns that decision and reports
            // `SkippedByPolicy` when the snapshot is empty or whitespace-only.
            verifier_options = verifier_options.with_left_context(left_context.as_bytes());
        }

        let conversion = match self.zenz_verifier.inner.lock() {
            Ok(mut verifier_guard) => {
                let verifier = verifier_guard
                    .as_mut()
                    .map(|verifier| verifier.as_mut() as &mut dyn DraftVerifier);
                convert_with_verifier_with_limit(
                    text,
                    dictionary,
                    ConversionOptions::default(),
                    verifier,
                    verifier_options,
                )
            }
            Err(_) => {
                warn_zenz_verifier_load_once(
                    "verifier lock was poisoned; using dictionary fallback",
                );
                convert_with_verifier_with_limit(
                    text,
                    dictionary,
                    ConversionOptions::default(),
                    None,
                    verifier_options,
                )
            }
        };

        self.zenz_verifier_metrics
            .record_result(&conversion.verification_state, conversion.verification_iterations);
        let converted = conversion.candidate.text;
        if conversion.verification_state == VerificationState::Verified {
            Ok(NormalizeOutcome::Success(converted))
        } else {
            Ok(NormalizeOutcome::Fallback {
                text: converted,
                error: format!(
                    "Zenz verifier state={} iterations={}",
                    verification_state_label(&conversion.verification_state),
                    conversion.verification_iterations
                ),
            })
        }
    }

    /// Rescore the ASR kana reading with the input-LM.
    ///
    /// Loads the 120 MB model on first call (memory-mapped), then runs the
    /// rescoring in a `spawn_blocking` task bounded by `timeout_ms`. Falls back
    /// to the original reading on any error, timeout, or panic so the caption
    /// path can never wedge. Returns `(reading, None)` on success or
    /// `(original, Some(error))` when the stage had to fall back so DebugPanel
    /// can show that Input N5 LM did not actually rewrite the hypothesis.
    async fn rescore_reading(&self, config: &AppConfig, reading: &str) -> (String, Option<String>) {
        let rescorer = match self.rescorer.get_or_load(&config.rescore) {
            Ok(r) => r,
            Err(e) => {
                log::warn!(target: "pipeline_rescore", "rescorer unavailable, falling back: {e}");
                return (reading.to_string(), Some(e));
            }
        };
        let reading_for_work = reading.to_string();
        let rescorer_for_work = Arc::clone(&rescorer);
        let timeout_ms = config.rescore.timeout_ms;
        let original = reading.to_string();
        match run_rescore_with_timeout(timeout_ms, original.clone(), move || {
            rescorer_for_work.best(&reading_for_work)
        })
        .await
        {
            Ok(rescored) => (rescored, None),
            Err(error) => (original, Some(error)),
        }
    }

    async fn translate(&self, config: &AppConfig, text: &str) -> Result<String, PipelineError> {
        if !config.models.translator.starts_with("hy-mt2-") {
            return Err(PipelineError::UnsupportedModel(config.models.translator.clone()));
        }
        let source = language_name(&config.language.source);
        let target = language_name(&config.language.target);
        let prompt = format!(
            "Translate the following text from {source} into {target}. \
             Note that you must ONLY output the translated result without any \
             additional explanation:\n{text}"
        );
        self.chat(config, &config.models.translator, prompt, ChatPurpose::Translate).await
    }

    async fn chat(
        &self,
        config: &AppConfig,
        model: &str,
        prompt: String,
        purpose: ChatPurpose,
    ) -> Result<String, PipelineError> {
        let url = endpoint_url(&config.endpoint.base_url, &config.endpoint.chat_path);
        let request = chat_request(config, model, prompt, purpose);
        let response = self.client.post(url).timeout(timeout(config)).json(&request).send().await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(PipelineError::Http { status: status.as_u16(), body });
        }
        let parsed: ChatResponse = serde_json::from_str(&body)?;
        parsed
            .choices
            .first()
            .map(|choice| choice.message.content.clone())
            .filter(|text| has_translatable_content(text))
            .ok_or(PipelineError::MissingText)
    }
}

/// Runs a rescore work closure in a `spawn_blocking` task bounded by
/// `timeout_ms`. Fail-open: any completion error (panic from the closure) or
/// timeout returns the original reading unchanged. This is the single chokepoint
/// that guarantees a rescore can never drop or wedge a caption.
async fn run_rescore_with_timeout<F>(
    timeout_ms: u64,
    original: String,
    work: F,
) -> Result<String, String>
where
    F: FnOnce() -> String + Send + 'static,
{
    let timeout = Duration::from_millis(timeout_ms);
    match tokio::time::timeout(timeout, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(rescored)) => Ok(rescored),
        Ok(Err(error)) => {
            log::warn!(target: "pipeline_rescore", "rescore task panicked: {error}");
            let _ = original;
            Err(format!("rescore task panicked: {error}"))
        }
        Err(_) => {
            log::warn!(
                target: "pipeline_rescore",
                "rescore timed out after {}ms, falling back",
                timeout_ms
            );
            let _ = original;
            Err(format!("rescore timed out after {timeout_ms}ms"))
        }
    }
}

fn parse_zenz_left_context_setting(value: Option<&str>) -> Option<bool> {
    let value = value?.trim();
    if ["1", "true", "on"].iter().any(|candidate| value.eq_ignore_ascii_case(candidate)) {
        return Some(true);
    }
    if ["0", "false", "off"].iter().any(|candidate| value.eq_ignore_ascii_case(candidate)) {
        return Some(false);
    }
    None
}

fn zenz_left_context_enabled_for(
    runtime_setting: Option<&str>,
    build_disable_flag: Option<&str>,
) -> bool {
    parse_zenz_left_context_setting(runtime_setting)
        .unwrap_or_else(|| !parse_zenz_left_context_setting(build_disable_flag).unwrap_or(false))
}

fn zenz_left_context_enabled() -> bool {
    *ZENZ_LEFT_CONTEXT_ENABLED.get_or_init(|| {
        let runtime_setting = std::env::var("CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT").ok();
        let enabled = zenz_left_context_enabled_for(
            runtime_setting.as_deref(),
            option_env!("CAPTION_BRIDGE_DISABLE_ZENZ_LEFT_CONTEXT"),
        );
        if runtime_setting
            .as_deref()
            .is_some_and(|value| parse_zenz_left_context_setting(Some(value)).is_none())
        {
            log::warn!(
                target: "pipeline_normalize",
                "ignoring invalid CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT value; expected on/off, true/false, or 1/0"
            );
        }
        enabled
    })
}

fn zenz_verifier_enabled_for(
    runtime_setting: Option<&str>,
    build_enable_flag: Option<&str>,
) -> bool {
    parse_zenz_left_context_setting(runtime_setting)
        .unwrap_or_else(|| parse_zenz_left_context_setting(build_enable_flag).unwrap_or(true))
}

fn zenz_verifier_enabled() -> bool {
    *ZENZ_VERIFIER_ENABLED.get_or_init(|| {
        let runtime_setting = std::env::var("CAPTION_BRIDGE_ZENZ_VERIFIER").ok();
        let enabled = zenz_verifier_enabled_for(
            runtime_setting.as_deref(),
            option_env!("CAPTION_BRIDGE_ENABLE_ZENZ_VERIFIER"),
        );
        if runtime_setting
            .as_deref()
            .is_some_and(|value| parse_zenz_left_context_setting(Some(value)).is_none())
        {
            log::warn!(
                target: "pipeline_normalize",
                "ignoring invalid CAPTION_BRIDGE_ZENZ_VERIFIER value; expected on/off, true/false, or 1/0"
            );
        }
        enabled
    })
}

#[cfg(feature = "candle")]
fn zenz_verifier_model_path(config: &AppConfig) -> Option<PathBuf> {
    let spec = crate::model_runtime::spec(ZENZ_VERIFIER_MODEL_ID)?;
    if let Some(path) = config
        .models
        .paths
        .get(ZENZ_VERIFIER_MODEL_ID)
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return Some(resolve_zenz_model_path_override(expand_model_path(path), spec.hf_file));
    }
    if let Ok(path) = std::env::var(ZENZ_VERIFIER_MODEL_PATH_ENV) {
        let path = expand_model_path(path.trim());
        if !path.as_os_str().is_empty() {
            return Some(resolve_zenz_model_path_override(path, spec.hf_file));
        }
    }
    default_zenz_model_runtime_dir()
        .map(|models_dir| crate::model_runtime::model_path(&models_dir, spec))
}

#[cfg(feature = "candle")]
fn resolve_zenz_model_path_override(path: PathBuf, file_name: &str) -> PathBuf {
    if path.is_dir() {
        path.join(file_name)
    } else {
        path
    }
}

#[cfg(feature = "candle")]
fn default_zenz_model_runtime_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(ZENZ_VERIFIER_MODEL_RUNTIME_DIR_ENV) {
        let path = expand_model_path(path.trim());
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    // `warm_azookey_dictionary` intentionally has no AppHandle dependency.
    // Mirror `model_runtime::model_runtime_dir` here using Tauri's documented
    // per-platform app-data layout; the explicit env override remains useful
    // for tests and unpackaged developer runs.
    #[cfg(target_os = "macos")]
    let default = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Application Support/com.kotobabeacon.desktop/models"));
    #[cfg(target_os = "windows")]
    let default = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|app_data| app_data.join("com.kotobabeacon.desktop/models"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let default = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .map(|data_dir| data_dir.join("com.kotobabeacon.desktop/models"));
    default
}

#[cfg(feature = "candle")]
fn zenz_verifier_load_failure_reason(
    error: &EmbeddedVerifierLoadError,
) -> ZenzVerifierLoadFailureReason {
    match error {
        EmbeddedVerifierLoadError::TokenizerMismatch(_) => {
            ZenzVerifierLoadFailureReason::TokenizerMismatch
        }
        EmbeddedVerifierLoadError::Model(_) => ZenzVerifierLoadFailureReason::DecodeError,
        EmbeddedVerifierLoadError::Io(_)
        | EmbeddedVerifierLoadError::Tokenizer(_)
        | EmbeddedVerifierLoadError::InvalidRevision(_) => ZenzVerifierLoadFailureReason::Other,
    }
}

fn verification_state_label(state: &VerificationState) -> &'static str {
    match state {
        VerificationState::Verified => "verified",
        VerificationState::PrefixConstraintReturned => "prefix_constraint_returned",
        VerificationState::Exhausted => "exhausted",
        VerificationState::ExhaustedWithConstrainedCandidate => {
            "exhausted_with_constrained_candidate"
        }
        VerificationState::ExhaustedWithDictionaryFallback => "exhausted_with_dictionary_fallback",
        VerificationState::SkippedByPolicy => "skipped_by_policy",
        VerificationState::DeadlineExceeded => "deadline_exceeded",
        VerificationState::CapabilityUnavailable => "capability_unavailable",
        VerificationState::Error => "error",
        VerificationState::UnverifiedFallback => "unverified_fallback",
    }
}

fn zenz_verifier_build_available() -> bool {
    cfg!(feature = "candle")
}

fn warn_zenz_verifier_load_once(message: &str) {
    ZENZ_VERIFIER_LOAD_WARNING.call_once(|| {
        log::warn!(target: "pipeline_normalize", "{message}");
    });
}

fn grapheme_count(text: &str) -> usize {
    UnicodeSegmentation::graphemes(text, true).count()
}

fn suffix_graphemes(text: &str, max_graphemes: usize) -> String {
    let graphemes = UnicodeSegmentation::graphemes(text, true).collect::<Vec<_>>();
    graphemes[graphemes.len().saturating_sub(max_graphemes)..].concat()
}

/// Build the upstream Zenz candidate-evaluation prompt. V2 places left context
/// after the composing input; v3/v3.2 conditions precede it. Real-time captions
/// have no future utterance, so the optional v3 right-context tag is omitted.
fn zenz_prompt(model: &str, input: &str, left_context: &str) -> String {
    let input = to_katakana(input);
    let context = suffix_graphemes(left_context, ZENZ_CONTEXT_MAX_GRAPHEMES);
    if context.is_empty() {
        return format!("\u{EE00}{input}\u{EE01}");
    }
    if model == "zenz-v2-q5-k-m-gguf" {
        format!("\u{EE00}{input}\u{EE02}{context}\u{EE01}")
    } else {
        format!("\u{EE02}{context}\u{EE00}{input}\u{EE01}")
    }
}

/// ReazonSpeech often drops the initial き of 聞こえる (`あえますか` /
/// `おえますか`); ZenZ may then pick 会えますか / 終えますか. Restore the
/// intended hearing check before the caption is published.
///
/// ZenZ also inserts a sentence period after fixed greetings
/// (`こんにちは。聞こえますか。`), which pages the plate onto only the second
/// clause and hides the greeting the speaker already said.
fn repair_weather_reading_confusion(text: &str) -> String {
    // ReazonSpeech occasionally confuses the vowel in the highly constrained
    // weather phrase. Restrict the repair to 天気は晴れ…確率 so ordinary
    // こうせい words (構成・校正・公正) remain untouched. If contextual ASR
    // repairs grow beyond this isolated phrase, move them into reviewed data
    // instead of extending this function into a general rewrite list.
    text.replace("てんきははれこうせいかくりつ", "てんきははれこうすいかくりつ")
}

fn repair_weather_surface_confusion(text: &str) -> String {
    // The official AzooKey dictionary can rank the stem-only 晴 immediately
    // before 降水. Restore the spoken れ only in this weather collocation.
    text.replace("晴降水確率", "晴れ降水確率")
}

fn repair_caption_phrase_confusions(text: &str) -> String {
    repair_weather_surface_confusion(&repair_hearing_phrase_confusion(text))
}

#[allow(clippy::excessive_nesting)]
fn repair_hearing_phrase_confusion(text: &str) -> String {
    let greetings = ["こんにちは", "こんばんは", "おはようございます", "おはよう", "さようなら"];
    let mut next = text.to_string();
    for greeting in greetings {
        for (wrong, right) in [
            ("あえますか", "きこえますか"),
            ("おえますか", "きこえますか"),
            ("会えますか", "聞こえますか"),
            ("終えますか", "聞こえますか"),
        ] {
            let pattern_plain = format!("{greeting}{wrong}");
            let replacement_plain = format!("{greeting}{right}");
            next = next.replace(&pattern_plain, &replacement_plain);
            for mark in ['ー', '〜', '～'] {
                let pattern = format!("{greeting}{mark}{wrong}");
                let replacement = format!("{greeting}{mark}{right}");
                next = next.replace(&pattern, &replacement);
            }
        }
        // Keep greeting + hearing check as one caption sentence.
        for hearing in ["きこえますか", "聞こえますか"] {
            for punct in ['。', '．', '.', '、'] {
                let split = format!("{greeting}{punct}{hearing}");
                let joined = format!("{greeting}{hearing}");
                next = next.replace(&split, &joined);
                for mark in ['ー', '〜', '～'] {
                    let split_mark = format!("{greeting}{mark}{punct}{hearing}");
                    let joined_mark = format!("{greeting}{mark}{hearing}");
                    next = next.replace(&split_mark, &joined_mark);
                }
            }
        }
    }
    match next.trim() {
        "あえますか" | "おえますか" => "きこえますか".to_string(),
        "会えますか" | "終えますか" => "聞こえますか".to_string(),
        _ => next,
    }
}

fn to_katakana(input: &str) -> String {
    input
        .chars()
        .map(|character| {
            let code = character as u32;
            if (0x3041..=0x3096).contains(&code) {
                char::from_u32(code + 0x60).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

type AzooKeyDictionaryCache = Arc<Mutex<HashMap<String, AzooKeyDictionary>>>;

fn cached_azookey_dictionary<'a>(
    dictionaries: &'a mut HashMap<String, AzooKeyDictionary>,
    cache_key: &str,
    paths: &DictionaryPaths,
) -> Result<&'a AzooKeyDictionary, String> {
    match dictionaries.entry(cache_key.to_owned()) {
        Entry::Occupied(entry) => Ok(entry.into_mut()),
        Entry::Vacant(entry) => Ok(entry.insert(AzooKeyDictionary::from_paths(paths)?)),
    }
}

/// Compatibility wrapper used by focused unit tests and non-live callers.
/// The live `Pipeline` passes its long-lived cache through
/// `normalize_azookey_with_cache` so a public dictionary is loaded once.
#[cfg(test)]
fn normalize_azookey(config: &AppConfig, text: &str) -> Result<NormalizeOutcome, PipelineError> {
    let cache = Arc::new(Mutex::new(HashMap::new()));
    normalize_azookey_with_cache(config, text, &cache)
}

fn normalize_azookey_with_cache(
    config: &AppConfig,
    text: &str,
    cache: &AzooKeyDictionaryCache,
) -> Result<NormalizeOutcome, PipelineError> {
    // Empty recognition text is a soft skip.  Check it before opening any
    // optional dictionary so a stale/broken path cannot turn silence into a
    // pipeline error (and so direct callers retain the same contract).
    if text.trim().is_empty() {
        return Ok(NormalizeOutcome::Success(String::new()));
    }

    let paths = azookey_dictionary_paths(config);

    if let Some(error) = azookey_dictionary_paths_error(&paths) {
        return Ok(azookey_fallback(text, error));
    }

    let cache_key = azookey_dictionary_cache_key(&paths);
    let mut dictionaries = cache
        .lock()
        .map_err(|_| PipelineError::Model("AzooKey dictionary cache lock poisoned".to_string()))?;
    if !dictionaries.contains_key(&cache_key) {
        let dictionary = match AzooKeyDictionary::from_paths(&paths) {
            Ok(dictionary) => dictionary,
            Err(error) => return Ok(azookey_fallback(text, error)),
        };
        dictionaries.insert(cache_key.clone(), dictionary);
    }
    let dictionary =
        dictionaries.get(&cache_key).expect("AzooKey dictionary inserted or already present");
    let converted = convert_with_dictionary(text, dictionary, ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .unwrap_or_else(|| text.trim().to_string());
    Ok(NormalizeOutcome::Success(converted))
}

fn azookey_dictionary_cache_key(paths: &DictionaryPaths) -> String {
    [paths.system.as_deref(), paths.user.as_deref(), paths.memory.as_deref()]
        .into_iter()
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn azookey_dictionary_paths(config: &AppConfig) -> DictionaryPaths {
    use crate::dictionary_resolve::configured_or_resolved_path;

    DictionaryPaths {
        system: configured_or_resolved_path(config, "azookey-rust"),
        user: configured_or_resolved_path(config, "azookey-user-dictionary"),
        memory: configured_or_resolved_path(config, "azookey-learning-memory"),
    }
    .with_defaults()
}

/// Return a diagnostic for an explicitly configured dictionary path that is
/// absent or clearly incomplete.  The AzooKey crate intentionally treats a
/// missing system root as optional, which is useful at library boundaries but
/// hides a typo in the app's user setting.  Detect it here so DebugPanel still
/// explains why the built-in fallback was selected.
fn azookey_dictionary_paths_error(paths: &DictionaryPaths) -> Option<String> {
    let mut errors = Vec::new();
    if let Some(path) = paths.system.as_deref() {
        if let Some(error) = azookey_dictionary_path_error("system", path) {
            errors.push(error);
        }
    }
    if let Some(path) = paths.user.as_deref() {
        if let Some(error) = azookey_dictionary_path_error("user", path) {
            errors.push(error);
        }
    }
    if let Some(path) = paths.memory.as_deref() {
        if let Some(error) = azookey_dictionary_path_error("learning-memory", path) {
            errors.push(error);
        }
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

fn azookey_dictionary_path_error(kind: &str, path: &Path) -> Option<String> {
    if !path.exists() {
        return Some(format!("AzooKey {kind} dictionary path does not exist: {}", path.display()));
    }
    if path.is_file() {
        // TSV parsing (including an empty/malformed file) is validated by the
        // AzooKey loader and will produce a richer error there.
        return None;
    }
    if !path.is_dir() {
        return Some(format!(
            "AzooKey {kind} dictionary path is not a regular file or directory: {}",
            path.display()
        ));
    }

    let complete = match kind {
        "system" => {
            system_dictionary_layout_present(path)
                || system_dictionary_layout_present(&path.join("Dictionary"))
        }
        "user" => external_dictionary_layout_present(path, "user"),
        "learning-memory" => external_dictionary_layout_present(path, "memory"),
        _ => false,
    };
    (!complete).then(|| {
        format!(
            "AzooKey {kind} dictionary path is incomplete or missing required files: {}",
            path.display()
        )
    })
}

fn system_dictionary_layout_present(path: &Path) -> bool {
    path.join("louds").join("charID.chid").is_file() && path.join("mm.binary").is_file()
}

fn external_dictionary_layout_present(path: &Path, name: &str) -> bool {
    let has_shard =
        std::fs::read_dir(path).ok().into_iter().flatten().filter_map(Result::ok).any(|entry| {
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            filename.starts_with(name) && filename.ends_with(".loudstxt3")
        });
    // External dictionaries inherit char IDs from a valid system dictionary,
    // so `charID.chid` is optional here.  The LOUDS pair plus at least one
    // record shard are the files the loader must be able to open.
    path.join(format!("{name}.louds")).is_file()
        && path.join(format!("{name}.loudschars2")).is_file()
        && has_shard
}

fn azookey_fallback(text: &str, dictionary_error: impl AsRef<str>) -> NormalizeOutcome {
    let fallback = convert_kana_to_kanji(text);
    let detail = format!(
        "AzooKey dictionary conversion failed; falling back to built-in dictionary: {}",
        dictionary_error.as_ref()
    );
    log::warn!(target: "pipeline_normalize", "{detail}");
    NormalizeOutcome::Fallback { text: fallback, error: detail }
}

/// Build the intermediate caption emitted as soon as the normalizer is ready.
/// `translation_text` is intentionally empty until `complete_translation`.
/// `id` must be stable across progressive stages (ASR/normalize → translate).
#[allow(dead_code)]
pub fn source_ready_caption(
    config: &AppConfig,
    source_text: String,
    started_at: u64,
    id: String,
) -> CaptionPayload {
    source_ready_caption_with_input(config, source_text, started_at, id, None)
}

/// Build a source caption while retaining the phonetic input used by the
/// normalizer.  HTTP/batch callers do not have a separate reading and use the
/// compatibility wrapper above; the persistent Parapper path passes its
/// explicit `azookey_input_text` here.
pub fn source_ready_caption_with_input(
    config: &AppConfig,
    source_text: String,
    started_at: u64,
    id: String,
    azookey_input_text: Option<String>,
) -> CaptionPayload {
    let source_text = source_text.trim().to_string();
    let sentence_end_offsets =
        crate::sentence_boundary::heuristic_sentence_end_offsets(&source_text, false);
    let soft_break_offsets = crate::sentence_boundary::heuristic_soft_break_offsets(&source_text);
    CaptionPayload {
        id,
        // Normalizers should already return a trimmed result, but remote Zenz
        // responses can carry a trailing newline. Keep caption identity and
        // display text canonical so an otherwise identical partial/final pair
        // cannot look like two different rows to downstream merge logic.
        source_text,
        azookey_input_text: azookey_input_text
            .and_then(|text| (!text.trim().is_empty()).then(|| text.trim().to_string())),
        translation_text: String::new(),
        source_language: config.language.source.clone(),
        target_language: config.language.target.clone(),
        started_at,
        received_at: now_millis(),
        stage: "source",
        sequence: 0,
        is_final: false,
        confidence: None,
        sentence_end_offsets,
        soft_break_offsets,
    }
}

#[allow(clippy::too_many_arguments)]
fn stage_event(
    stage: &'static str,
    utterance_id: &str,
    model_id: &str,
    input: &str,
    output: &str,
    duration_ms: u64,
    ok: bool,
    error: Option<String>,
) -> PipelineStageEvent {
    stage_event_with_surface(
        stage,
        utterance_id,
        model_id,
        input,
        output,
        duration_ms,
        ok,
        error,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn stage_event_with_surface(
    stage: &'static str,
    utterance_id: &str,
    model_id: &str,
    input: &str,
    output: &str,
    duration_ms: u64,
    ok: bool,
    error: Option<String>,
    surface: Option<&str>,
) -> PipelineStageEvent {
    let ended_at = now_millis();
    let started_at = ended_at.saturating_sub(duration_ms);
    PipelineStageEvent {
        stage,
        utterance_id: utterance_id.to_string(),
        model_id: model_id.to_string(),
        input_snippet: snippet(input),
        output_text: snippet(output),
        // `surface_text` is consumed by the frontend's immediate provisional
        // caption paint, so retain the complete surface instead of applying
        // the bounded debug sample truncation used by input/output fields.
        surface_text: surface.map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned),
        started_at,
        at: ended_at,
        duration_ms,
        ok,
        error,
        zenz_context: None,
        zenz_verifier: None,
    }
}

/// Emit + retain a stage event as soon as the stage finishes.
fn record_stage(
    stages: &mut Vec<PipelineStageEvent>,
    on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
    event: PipelineStageEvent,
) {
    on_stage(&event);
    stages.push(event);
}

fn snippet(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= STAGE_SNIPPET_CHARS {
        return trimmed.to_string();
    }
    let mut out = String::new();
    for (index, ch) in trimmed.chars().enumerate() {
        if index >= STAGE_SNIPPET_CHARS {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Apply a finished translation onto an existing progressive caption (same id).
pub fn with_translation(
    mut caption: CaptionPayload,
    translation: &str,
    received_at: u64,
) -> CaptionPayload {
    caption.translation_text = clean_model_text(translation);
    caption.received_at = received_at;
    caption.stage = "translation";
    caption.sequence = 1;
    caption.is_final = true;
    caption
}

fn timeout(config: &AppConfig) -> Duration {
    Duration::from_millis(config.endpoint.timeout_ms.clamp(1_000, 120_000))
}

fn endpoint_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Translation requires at least one Unicode letter or number.
///
/// Empty, whitespace-only, punctuation-only, and symbol-only fragments carry no
/// translatable content and can make small local models emit degenerate output
/// such as `.`. The same predicate guards both model input and output.
fn has_translatable_content(text: &str) -> bool {
    text.trim().chars().any(char::is_alphanumeric)
}

fn language_name(code: &str) -> &str {
    match code {
        "ja" => "Japanese",
        "en" => "English",
        "zh" => "Chinese",
        "ko" => "Korean",
        _ => code,
    }
}

fn clean_model_text(text: &str) -> String {
    text.trim().trim_matches('`').trim().to_string()
}

fn is_no_speech_response(status: u16, body: &str) -> bool {
    // 204 is an explicit empty response by definition. There is normally no
    // JSON body to inspect, and treating that empty body as a transcript
    // failure would turn ordinary silence into a user-visible error. Keep a
    // non-empty malformed 204 body on the inspection path below so it cannot
    // hide an unrelated server failure.
    if status == 204 && body.trim().is_empty() {
        return true;
    }
    if !(status == 204 || status == 404 || status == 422) {
        return false;
    }

    // Prefer structured inspection when a gateway returns a top-level empty
    // transcript field. This covers `null`, whitespace-only strings, and JSON
    // spacing/escaping variants without broadening the no-speech match to an
    // arbitrary error body.
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        let error = value.get("error");
        if let Some(code) = error.and_then(|error| error.get("code")).and_then(Value::as_str) {
            return code.eq_ignore_ascii_case("transcript_missing");
        }
        if let Some(value) = ["text", "transcript"].into_iter().find_map(|field| value.get(field)) {
            return value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty());
        }
        if error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .is_some_and(is_no_speech_message)
        {
            return true;
        }
    }

    let lower = body.to_ascii_lowercase();
    contains_bounded_token(&lower, "transcript_missing") || is_no_speech_message(&lower)
}

fn is_no_speech_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let normalized = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(
        normalized.as_str(),
        "completed without a final transcript"
            | "parapper completed without a final transcript"
            | "no final transcript"
            | "empty transcript"
            | "no transcript"
            | "no transcript available"
            | "no transcript returned"
            | "no transcript received"
            | "no usable speech"
            | "no speech"
            | "no-speech"
    )
}

fn contains_bounded_token(input: &str, token: &str) -> bool {
    input.match_indices(token).any(|(index, _)| {
        let before = input[..index].chars().next_back();
        let after = input[index + token.len()..].chars().next();
        !before.is_some_and(is_token_character) && !after.is_some_and(is_token_character)
    })
}

fn is_token_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Keep a caller-provided chunk identity when it is meaningful, while
/// preserving UUID-backed IDs for legacy callers and malformed metadata.
fn resolve_utterance_id(provided: Option<&str>) -> String {
    provided
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        chat_request, clean_model_text, has_translatable_content, is_no_speech_response,
        normalize_azookey, normalize_azookey_with_cache, record_stage,
        repair_caption_phrase_confusions, repair_hearing_phrase_confusion,
        repair_weather_reading_confusion, resolve_utterance_id, run_rescore_with_timeout, snippet,
        source_ready_caption, source_ready_caption_with_input, stage_event,
        stage_event_with_surface, verification_state_label, with_translation,
        zenz_left_context_enabled_for, zenz_prompt, zenz_verifier_build_available,
        zenz_verifier_enabled_for, CaptionPayload, ChatPurpose, NormalizeOutcome,
        ParapperRecognitionInput, Pipeline, PipelineStageEvent, ZenzVerifierDiagnostics,
        ZenzVerifierMetrics, STAGE_SNIPPET_CHARS,
    };
    use crate::config::AppConfig;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tokio::sync::Mutex as AsyncMutex;
    use uuid::Uuid;

    static DICTIONARY_ENV_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

    fn ignore_pipeline_stage(_: &PipelineStageEvent) {}

    fn ignore_caption(_: &CaptionPayload) {}

    fn temporary_dictionary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "caption-bridge-pipeline-{label}-{}-{}",
            std::process::id(),
            super::now_millis()
        ))
    }

    #[allow(clippy::excessive_nesting)]
    fn official_system_dictionary_path() -> PathBuf {
        if let Ok(raw) = std::env::var("AZOOKEY_DICTIONARY_ROOT") {
            let candidate = PathBuf::from(raw.trim());
            if crate::azookey_runtime::has_system_dictionary(&candidate) {
                return if candidate.join("mm.binary").is_file() {
                    candidate
                } else {
                    candidate.join("Dictionary")
                };
            }
        }
        let checked_in = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../submodules/azooKey_dictionary_storage/Dictionary");
        assert!(
            crate::azookey_runtime::has_system_dictionary(&checked_in),
            "official AzooKey dictionary is unavailable for pipeline regression; initialize {} or set AZOOKEY_DICTIONARY_ROOT",
            checked_in.display()
        );
        checked_in
    }

    #[test]
    fn translation_content_guard_rejects_empty_and_symbol_only_text() {
        for text in ["", "   \n\t", ".", "。", "!?", "！？", "___", "🗣️"] {
            assert!(!has_translatable_content(text), "expected {text:?} to be rejected");
        }
        for text in ["はい", "うん", "A", "OK", "Yes", "東京", "東京🗣️", "2026", "配信!", "€100"]
        {
            assert!(has_translatable_content(text), "expected {text:?} to be accepted");
        }
    }

    async fn assert_translation_soft_skips(
        pipeline: &Pipeline,
        config: &AppConfig,
        source: &str,
        index: usize,
    ) {
        let caption = source_ready_caption(config, source.to_string(), 42, format!("skip-{index}"));
        let mut stages = Vec::new();
        let result = pipeline
            .complete_translation(config, caption, &mut stages, &mut ignore_pipeline_stage)
            .await
            .expect("non-translatable input should be a successful no-op");

        assert!(result.is_none());
        assert_eq!(stages.len(), 1);
        assert!(stages[0].ok);
        assert_eq!(stages[0].stage, "translate");
        assert!(stages[0].output_text.is_empty());
        assert!(stages[0].error.is_none());
    }

    #[tokio::test]
    async fn complete_translation_soft_skips_non_translatable_source() {
        let config = AppConfig::default();
        let pipeline = Pipeline::default();

        assert_translation_soft_skips(&pipeline, &config, "", 0).await;
        assert_translation_soft_skips(&pipeline, &config, "   ", 1).await;
        assert_translation_soft_skips(&pipeline, &config, ".", 2).await;
        assert_translation_soft_skips(&pipeline, &config, "。", 3).await;
        assert_translation_soft_skips(&pipeline, &config, "!?", 4).await;
    }

    #[test]
    fn detects_parapper_no_speech_payloads() {
        // Exact user toast payload body from live capture:
        // inference returned HTTP 422: {"error":{"code":"transcript_missing",...}}
        let exact = r#"{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}"#;
        assert!(is_no_speech_response(422, exact));
        // Message-only variants (code field missing / differently shaped bodies).
        assert!(is_no_speech_response(422, "Parapper completed without a final transcript"));
        assert!(is_no_speech_response(404, r#"{"error":{"message":"no transcript"}}"#));
        assert!(is_no_speech_response(204, ""));
        assert!(is_no_speech_response(204, r#"{"text":""}"#));
        assert!(!is_no_speech_response(204, r#"{"text":"unexpected body"}"#));
        assert!(is_no_speech_response(422, r#"{"text": ""}"#));
        assert!(is_no_speech_response(422, r#"{"text":null}"#));
        assert!(is_no_speech_response(422, r#"{"transcript":" \n\t "}"#));
        // Real faults must still fail the pipeline.
        assert!(!is_no_speech_response(500, exact));
        assert!(!is_no_speech_response(500, r#"{"error":{"code":"boom"}}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"invalid_audio"}}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"invalid_audio"},"text":""}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"parapper_timeout"}}"#));
        assert!(!is_no_speech_response(
            422,
            r#"{"error":{"code":"transcript_missing_timeout","message":"Parapper completed without a final transcript"}}"#,
        ));
        assert!(!is_no_speech_response(422, r#"{"text":"partial result"}"#));
        // Do not hide unrelated gateway failures that merely contain a
        // transcript-like substring. The frontend uses the same bounded
        // classification contract.
        assert!(!is_no_speech_response(422, "transcript_missing_timeout"));
        assert!(!is_no_speech_response(422, "gateway no transcript buffer"));
        assert!(!is_no_speech_response(
            422,
            r#"{"error":{"message":"gateway no transcript buffer"}}"#,
        ));
    }

    #[test]
    fn empty_transcript_from_no_speech_is_soft_skip_signal() {
        // transcribe() maps transcript_missing → Ok("") and recognize_source
        // turns empty ASR text into Ok(None). Keep the classification pure so
        // the command layer can return a silence caption without last_error.
        let body = r#"{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}"#;
        assert!(is_no_speech_response(422, body));
        // Successful empty JSON must also soft-skip (not a hard HTTP error path).
        assert!(is_no_speech_response(422, r#"{"text":""}"#));
        assert!(is_no_speech_response(204, r#"{"transcript":""}"#));
    }

    #[tokio::test]
    async fn persistent_parapper_hiragana_output_reuses_azookey_and_turn_identity() {
        // DictionaryPaths::with_defaults reads a process-global environment
        // variable. Serialize this pipeline test with the fixture that mutates
        // AZOOKEY_DICTIONARY_ROOT so parallel test execution cannot change the
        // expected conversion mid-request.
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        let config = AppConfig::default();
        let pipeline = Pipeline::default();
        let output = ParapperRecognitionInput {
            text: "標準Parapper表示".into(),
            source_text: Some("今日は配信です".into()),
            azookey_input_text: Some("きょうははいしんです".into()),
            session_id: "socket-session".into(),
            turn_session_id: 7,
            turn_id: 3,
            revision: 0,
            output_sequence: 1,
            segment_id: 11,
            previous_segment_id: None,
            source_asr_model: "reazonspeech-k2-v2".into(),
            source_language: "ja".into(),
            detected_language: None,
            elapsed_ms: 12,
            audio_duration_ms: None,
            is_final: false,
            capture_generation: None,
        };
        let mut stages = Vec::new();
        let mut captions = Vec::new();
        let partial = pipeline
            .normalize_parapper_output(
                &config,
                output.clone(),
                &mut stages,
                &mut ignore_pipeline_stage,
                &mut |caption| captions.push(caption.clone()),
            )
            .await
            .expect("Parapper output should normalize")
            .expect("explicit AzooKey input should produce a caption");

        assert_eq!(partial.id, "parapper:socket-session:7:3");
        assert_eq!(partial.source_text, "今日は配信です");
        assert_eq!(partial.azookey_input_text.as_deref(), Some("きょうははいしんです"));
        assert!(!partial.is_final);
        assert_eq!(captions.len(), 1);
        assert_eq!(stages[0].stage, "asr");
        assert_eq!(stages[0].input_snippet, "今日は配信です");
        assert_eq!(stages[0].output_text, "きょうははいしんです");
        assert_eq!(stages[0].surface_text.as_deref(), Some("今日は配信です"));
        assert_eq!(stages[1].stage, "normalize");
        assert_eq!(stages[1].output_text, "今日は配信です");

        let mut final_output = output;
        final_output.revision = 1;
        final_output.is_final = true;
        final_output.audio_duration_ms = Some(640);
        let final_caption = pipeline
            .normalize_parapper_output(
                &config,
                final_output,
                &mut Vec::new(),
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("final Parapper output should normalize")
            .expect("final output should produce a caption");
        assert_eq!(final_caption.id, partial.id);
        assert!(final_caption.is_final);
    }

    #[tokio::test]
    async fn persistent_parapper_prefers_explicit_azookey_input_over_surface_text() {
        // Keep the persistent normalizer test from racing the environment-backed
        // dictionary fixture when the desktop test harness runs in parallel.
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        let config = AppConfig::default();
        let pipeline = Pipeline::default();
        // A surface-form sidecar may still populate `text` for compatibility
        // while carrying the exact Hiragana reading separately.  The
        // normalizer must consume only that phonetic field; otherwise a later
        // Vibrato/normalizer boundary can be mistaken for a suffix revision.
        let output = ParapperRecognitionInput {
            text: "明日は".into(),
            source_text: Some("明日は".into()),
            azookey_input_text: Some("あしたは".into()),
            session_id: "surface-session".into(),
            turn_session_id: 2,
            turn_id: 4,
            revision: 1,
            output_sequence: 1,
            segment_id: 9,
            previous_segment_id: None,
            source_asr_model: "reazonspeech-k2-v2".into(),
            source_language: "ja".into(),
            detected_language: None,
            elapsed_ms: 8,
            audio_duration_ms: None,
            is_final: false,
            capture_generation: None,
        };
        let mut stages = Vec::new();
        let caption = pipeline
            .normalize_parapper_output(
                &config,
                output,
                &mut stages,
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("surface payload should normalize")
            .expect("non-empty explicit reading should produce a caption");

        assert_eq!(caption.source_text, "明日は");
        assert_eq!(caption.azookey_input_text.as_deref(), Some("あしたは"));
        assert_eq!(stages[0].output_text, "あしたは");
        assert_eq!(stages[0].surface_text.as_deref(), Some("明日は"));
        assert_eq!(stages[1].input_snippet, "あしたは");
        assert_eq!(stages[1].output_text, "明日は");
    }

    #[test]
    fn pipeline_error_http_display_includes_body_for_frontend_matching() {
        // Frontend defense-in-depth matches this Display form when a no-speech
        // response somehow leaks past recognize_source as Err.
        let error = super::PipelineError::Http {
            status: 422,
            body: r#"{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}"#
                .into(),
        };
        let rendered = error.to_string();
        assert!(rendered.contains("inference returned HTTP 422"));
        assert!(rendered.contains("transcript_missing"));
        assert!(rendered.contains("Parapper completed without a final transcript"));
    }

    #[test]
    fn source_ready_caption_has_empty_translation_and_stable_identity_fields() {
        let config = AppConfig::default();
        let partial =
            source_ready_caption(&config, "こんにちは".into(), 1_700_000_000_000, "utt-1".into());
        assert_eq!(partial.source_text, "こんにちは");
        assert!(partial.translation_text.is_empty(), "translation must not block source emit");
        assert_eq!(partial.source_language, config.language.source);
        assert_eq!(partial.target_language, config.language.target);
        assert_eq!(partial.started_at, 1_700_000_000_000);
        assert_eq!(partial.id, "utt-1");
    }

    #[test]
    fn source_ready_caption_trims_remote_normalizer_whitespace() {
        let config = AppConfig::default();
        let partial = source_ready_caption(&config, "  こんにちは\n".into(), 1, "utt-trim".into());
        assert_eq!(partial.source_text, "こんにちは");
    }

    #[test]
    fn provided_utterance_id_is_trimmed_and_missing_ids_get_uuid() {
        assert_eq!(resolve_utterance_id(Some("  chunk-42  ")), "chunk-42");
        let generated = resolve_utterance_id(Some(" \n\t "));
        assert!(Uuid::parse_str(&generated).is_ok(), "missing id should use UUID");
        let generated_from_none = resolve_utterance_id(None);
        assert!(Uuid::parse_str(&generated_from_none).is_ok(), "legacy caller should use UUID");
    }

    #[test]
    fn caption_payload_text_is_not_limited_by_debug_snippet_length() {
        // Stage samples are intentionally bounded for diagnostics, but the
        // user-facing caption must retain the complete ASR/translation text.
        let config = AppConfig::default();
        let source = "あ".repeat(STAGE_SNIPPET_CHARS + 64);
        let partial = source_ready_caption(&config, source.clone(), 1, "utt-long".into());
        assert_eq!(partial.source_text, source);
        assert_eq!(partial.source_text.chars().count(), STAGE_SNIPPET_CHARS + 64);

        let translation = "A".repeat(STAGE_SNIPPET_CHARS + 64);
        let finished = with_translation(partial, &translation, 2);
        assert_eq!(finished.translation_text, translation);
        assert_eq!(finished.translation_text.chars().count(), STAGE_SNIPPET_CHARS + 64);
    }

    #[test]
    fn azookey_without_optional_paths_reports_success() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let config = AppConfig::default();
        let outcome = normalize_azookey(&config, "きょうははいしんです").expect("normalize");
        assert_eq!(outcome, NormalizeOutcome::Success("今日は配信です".to_string()));
    }

    #[test]
    fn azookey_weather_percent_conversion_avoids_zenz_garble() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().to_string_lossy().into_owned(),
        );

        assert_eq!(
            normalize_azookey(&config, "ろくじゅうぱーせんと").expect("percent normalize"),
            NormalizeOutcome::Success("60%".to_string())
        );
        let NormalizeOutcome::Success(weather) = normalize_azookey(
            &config,
            "あしたのてんきははれこうすいかくりつはろくじゅうぱーせんと",
        )
        .expect("weather normalize") else {
            panic!("official dictionary should normalize the weather phrase");
        };
        assert_eq!(repair_caption_phrase_confusions(&weather), "明日の天気は晴れ降水確率は60%");
        assert!(!weather.contains('蕨') && !weather.contains('丑') && !weather.contains('酉'));
    }

    #[test]
    fn azookey_official_dictionary_default_conversion_is_phrase_neutral_for_hashi_no_haji() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        // Official system dictionary only: no user/phrase or learning-memory rows.
        // ConversionOptions::default() is the live normalize_azookey path.
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().to_string_lossy().into_owned(),
        );

        let outcome =
            normalize_azookey(&config, "はしのはじからものがおちてます").expect("normalize");
        assert_eq!(outcome, NormalizeOutcome::Success("橋の端から物が落ちてます".to_string()));
    }

    #[test]
    fn azookey_official_dictionary_default_conversion_is_phrase_neutral_for_atsui_hi_nanode() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        // Official system dictionary only: no user/phrase or learning-memory rows.
        // ConversionOptions::default() is the live normalize_azookey path.
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().to_string_lossy().into_owned(),
        );

        let outcome = normalize_azookey(&config, "あついひなのであついすーぷをのみたくない")
            .expect("normalize");
        assert_eq!(
            outcome,
            NormalizeOutcome::Success("暑い日なので熱いスープを飲みたくない".to_string())
        );
    }

    #[test]
    fn azookey_official_dictionary_default_conversion_is_phrase_neutral_for_atsui_hi_nanoni() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        // Official system dictionary only: no user/phrase or learning-memory rows.
        // ConversionOptions::default() is the live normalize_azookey path.
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().to_string_lossy().into_owned(),
        );

        let outcome = normalize_azookey(&config, "あついひなのに").expect("normalize");
        assert_eq!(outcome, NormalizeOutcome::Success("暑い日なのに".to_string()));
    }

    #[test]
    fn azookey_reuses_the_loaded_dictionary_for_repeated_chunks() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("cache");
        fs::write(&path, "はいしん\t配信\t-1\n").expect("dictionary fixture should write");
        let mut config = AppConfig::default();
        config.models.paths.insert("azookey-rust".to_string(), path.to_string_lossy().into_owned());
        let cache = Arc::new(Mutex::new(HashMap::new()));

        let first = normalize_azookey_with_cache(&config, "はいしん", &cache)
            .expect("first normalization should succeed");
        let second = normalize_azookey_with_cache(&config, "はいしん", &cache)
            .expect("second normalization should succeed");
        assert_eq!(first, NormalizeOutcome::Success("配信".to_string()));
        assert_eq!(second, first);
        assert_eq!(cache.lock().expect("cache lock").len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn chat_requests_use_deterministic_normalization_without_changing_translation_sampling() {
        let config = AppConfig::default();
        let normalizer = chat_request(
            &config,
            &config.models.normalizer,
            "normalize".to_string(),
            ChatPurpose::Normalize,
        );
        let translator = chat_request(
            &config,
            &config.models.translator,
            "translate".to_string(),
            ChatPurpose::Translate,
        );

        assert_eq!(translator.temperature, 0.7);
        let normalizer_json =
            serde_json::to_value(normalizer).expect("serialize normalizer request");
        assert_eq!(normalizer_json["temperature"], 0.0);
    }

    #[test]
    fn zenz_prompt_uses_versioned_left_context_and_katakana_input() {
        assert_eq!(
            zenz_prompt("zenz-v2-q5-k-m-gguf", "きょうは配信です", "前の字幕"),
            "\u{EE00}キョウハ配信デス\u{EE02}前の字幕\u{EE01}"
        );
        assert_eq!(
            zenz_prompt("zenz-v3.2-small-gguf", "カタカナ", "前の字幕"),
            "\u{EE02}前の字幕\u{EE00}カタカナ\u{EE01}"
        );
        assert_eq!(zenz_prompt("zenz-v3.2-small-gguf", "きょう", ""), "\u{EE00}キョウ\u{EE01}");
        assert_eq!(
            zenz_prompt(
                "zenz-v3.2-small-gguf",
                "つづき",
                &format!("{}{}", "前".repeat(5), "後".repeat(40)),
            ),
            format!("\u{EE02}{}\u{EE00}ツヅキ\u{EE01}", "後".repeat(40))
        );
    }

    #[test]
    fn zenz_context_runtime_setting_overrides_the_build_default() {
        assert!(zenz_left_context_enabled_for(None, None));
        assert!(!zenz_left_context_enabled_for(None, Some("1")));
        assert!(!zenz_left_context_enabled_for(None, Some("true")));
        assert!(!zenz_left_context_enabled_for(None, Some("on")));

        assert!(zenz_left_context_enabled_for(Some("1"), Some("1")));
        assert!(zenz_left_context_enabled_for(Some(" TRUE "), Some("1")));
        assert!(zenz_left_context_enabled_for(Some("on"), Some("1")));
        assert!(!zenz_left_context_enabled_for(Some("0"), None));
        assert!(!zenz_left_context_enabled_for(Some("false"), None));
        assert!(!zenz_left_context_enabled_for(Some(" OFF "), None));
        assert!(zenz_left_context_enabled_for(Some("invalid"), None));
    }

    #[test]
    fn zenz_verifier_runtime_setting_defaults_on_and_runtime_wins() {
        assert!(zenz_verifier_enabled_for(None, None));
        assert!(zenz_verifier_enabled_for(None, Some("invalid")));
        assert!(zenz_verifier_enabled_for(None, Some("1")));
        assert!(zenz_verifier_enabled_for(None, Some(" TRUE ")));
        assert!(zenz_verifier_enabled_for(None, Some("on")));
        assert!(!zenz_verifier_enabled_for(None, Some("0")));
        assert!(!zenz_verifier_enabled_for(None, Some("false")));
        assert!(!zenz_verifier_enabled_for(None, Some(" OFF ")));
        assert!(zenz_verifier_enabled_for(Some("on"), Some("0")));
        assert!(!zenz_verifier_enabled_for(Some("off"), Some("1")));
        // Invalid runtime values deliberately fall back to the build default.
        assert!(zenz_verifier_enabled_for(Some("invalid"), Some("1")));
        assert!(zenz_verifier_enabled_for(Some("invalid"), None));
    }

    #[cfg(feature = "candle")]
    #[test]
    fn zenz_verifier_model_path_prefers_config_override() {
        let mut config = AppConfig::default();
        let override_path = PathBuf::from("/tmp/zenz-verifier-test.gguf");
        config
            .models
            .paths
            .insert(super::ZENZ_VERIFIER_MODEL_ID.to_string(), override_path.display().to_string());
        assert_eq!(super::zenz_verifier_model_path(&config), Some(override_path));
    }

    #[test]
    fn zenz_verifier_metrics_expose_each_state_without_text() {
        let metrics = ZenzVerifierMetrics::default();
        use crate::kana_kanji::VerificationState;
        let states = [
            VerificationState::Verified,
            VerificationState::PrefixConstraintReturned,
            VerificationState::Exhausted,
            VerificationState::ExhaustedWithConstrainedCandidate,
            VerificationState::ExhaustedWithDictionaryFallback,
            VerificationState::SkippedByPolicy,
            VerificationState::DeadlineExceeded,
            VerificationState::CapabilityUnavailable,
            VerificationState::Error,
            VerificationState::UnverifiedFallback,
        ];
        for (iterations, state) in states.iter().enumerate() {
            metrics.record_result(state, iterations + 1);
        }
        let diagnostics = metrics.snapshot(false, false);
        assert!(!diagnostics.enabled);
        assert_eq!(diagnostics.build_available, cfg!(feature = "candle"));
        assert!(!diagnostics.loaded);
        assert_eq!(diagnostics.load_failure_count, 0);
        assert_eq!(diagnostics.load_failure_reason, None);
        assert_eq!(diagnostics.called_count, states.len() as u64 - 1);
        assert_eq!(diagnostics.skipped_count, 1);
        assert_eq!(diagnostics.verified_count, 1);
        assert_eq!(diagnostics.prefix_constraint_returned_count, 1);
        assert_eq!(diagnostics.exhausted_count, 1);
        assert_eq!(diagnostics.exhausted_with_constrained_candidate_count, 1);
        assert_eq!(diagnostics.exhausted_with_dictionary_fallback_count, 1);
        assert_eq!(diagnostics.skipped_by_policy_count, 1);
        assert_eq!(diagnostics.deadline_exceeded_count, 1);
        assert_eq!(diagnostics.capability_unavailable_count, 1);
        assert_eq!(diagnostics.error_count, 1);
        assert_eq!(diagnostics.unverified_fallback_count, 1);
        assert_eq!(diagnostics.iteration_count, (1..=states.len()).sum::<usize>() as u64);
        assert_eq!(
            verification_state_label(&VerificationState::DeadlineExceeded),
            "deadline_exceeded"
        );
    }

    #[test]
    fn zenz_verifier_metrics_expose_load_failure_category_without_error_text() {
        let metrics = ZenzVerifierMetrics::default();
        metrics.record_load_failure(super::ZenzVerifierLoadFailureReason::TokenizerMismatch);
        metrics.record_load_failure(super::ZenzVerifierLoadFailureReason::DecodeError);
        let diagnostics = metrics.snapshot(false, false);
        assert_eq!(diagnostics.load_failure_count, 2);
        assert_eq!(
            diagnostics.load_failure_reason,
            Some(super::ZenzVerifierLoadFailureReason::DecodeError)
        );
    }

    #[test]
    fn verifier_slot_is_empty_before_capture_and_diagnostics_expose_default_build() {
        let pipeline = Pipeline::default();
        assert!(!pipeline.zenz_verifier.is_loaded());
        assert_eq!(zenz_verifier_build_available(), cfg!(feature = "candle"));
        let diagnostics: ZenzVerifierDiagnostics = pipeline.zenz_verifier_diagnostics();
        assert!(diagnostics.enabled);
        assert_eq!(diagnostics.build_available, cfg!(feature = "candle"));
        assert!(!diagnostics.loaded);
    }

    #[cfg(feature = "candle")]
    #[test]
    fn missing_zenz_model_fails_open_and_reports_model_not_found() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().display().to_string(),
        );
        config.models.paths.insert(
            super::ZENZ_VERIFIER_MODEL_ID.to_string(),
            temporary_dictionary_path("missing-zenz-model").display().to_string(),
        );
        let pipeline = Pipeline::default();
        pipeline.load_zenz_verifier(&config);

        let diagnostics = pipeline.zenz_verifier_diagnostics();
        assert!(!pipeline.zenz_verifier.is_loaded());
        assert_eq!(diagnostics.load_failure_count, 1);
        assert_eq!(
            diagnostics.load_failure_reason,
            Some(super::ZenzVerifierLoadFailureReason::ModelNotFound)
        );

        let outcome = pipeline
            .normalize_azookey_with_verifier(&config, "きょうははいしんです", Some("前の字幕"))
            .expect("missing verifier model must keep dictionary conversion alive");
        match outcome {
            NormalizeOutcome::Fallback { text, error } => {
                assert!(!text.is_empty());
                assert!(error.contains("capability_unavailable"));
            }
            NormalizeOutcome::Success(text) => {
                panic!("an unavailable verifier must not report success: {text}")
            }
        }
    }

    #[test]
    fn verifier_none_path_keeps_dictionary_caption_and_reports_capability_unavailable() {
        let dictionary = crate::kana_kanji::AzooKeyDictionary::default();
        let result = crate::kana_kanji::convert_with_verifier_with_limit(
            "かんじ",
            &dictionary,
            crate::kana_kanji::ConversionOptions::default(),
            None,
            crate::kana_kanji::VerifierConversionOptions::new(
                super::ZENZ_VERIFIER_MAX_ITERATIONS,
                super::ZENZ_VERIFIER_INFERENCE_CONFIG_REVISION,
            )
            .with_left_context("左文脈"),
        );
        assert_eq!(
            result.verification_state,
            crate::kana_kanji::VerificationState::CapabilityUnavailable
        );
        assert!(!result.candidate.text.is_empty());
    }

    #[test]
    fn pipeline_verifier_slot_falls_back_without_erasing_dictionary_text() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            official_system_dictionary_path().display().to_string(),
        );
        let pipeline = Pipeline::default();
        let outcome = pipeline
            .normalize_azookey_with_verifier(&config, "きょうははいしんです", Some("前の字幕"))
            .expect("dictionary conversion should remain available");
        match outcome {
            NormalizeOutcome::Fallback { text, error } => {
                assert!(!text.is_empty());
                assert!(error.contains("capability_unavailable"));
            }
            NormalizeOutcome::Success(text) => {
                panic!("an empty verifier slot must not report success: {text}")
            }
        }
        let diagnostics = pipeline.zenz_verifier_diagnostics();
        assert_eq!(diagnostics.called_count, 1);
        assert_eq!(diagnostics.capability_unavailable_count, 1);
        assert_eq!(diagnostics.iteration_count, 0);
    }

    #[test]
    fn zenz_context_keeps_each_final_turn_once_and_resets_at_capture_boundaries() {
        let pipeline = Pipeline::default();
        let empty = pipeline.zenz_left_context("session-a", Some(1), 10, 20, false, true);
        assert_eq!(empty.text, "");
        assert!(!empty.diagnostics.is_final);
        assert_eq!(empty.diagnostics.character_count, 0);
        assert_eq!(empty.diagnostics.turn_count, 0);
        assert_eq!(empty.diagnostics.discarded_session_count, 0);

        pipeline.append_zenz_context("session-a", Some(1), 10, 20, "今日は晴れです。");
        pipeline.append_zenz_context("session-a", Some(1), 10, 20, "今日は雨です。");
        let revised = pipeline.zenz_left_context("session-a", Some(1), 10, 21, false, true);
        assert_eq!(revised.text, "今日は雨です。");
        assert_eq!(revised.diagnostics.character_count, 7);
        assert_eq!(revised.diagnostics.turn_count, 1);

        pipeline.append_zenz_context("session-a", Some(1), 10, 21, "明日も晴れです。");
        let combined = pipeline.zenz_left_context("session-a", Some(1), 10, 22, false, true);
        assert_eq!(combined.text, "今日は雨です。明日も晴れです。");
        assert_eq!(combined.diagnostics.character_count, 15);
        assert_eq!(combined.diagnostics.turn_count, 2);
        let disabled = pipeline.zenz_left_context("session-a", Some(1), 10, 23, false, false);
        assert!(!disabled.diagnostics.enabled);
        assert_eq!(disabled.text, "");
        assert_eq!(disabled.diagnostics.character_count, 0);
        assert_eq!(disabled.diagnostics.turn_count, 0);
        assert_eq!(
            pipeline.zenz_left_context("session-a", Some(1), 10, 21, true, true).text,
            "今日は雨です。"
        );
        let new_capture = pipeline.zenz_left_context("session-a", Some(2), 11, 1, true, true);
        assert_eq!(new_capture.text, "");
        assert!(new_capture.diagnostics.is_final);
        assert_eq!(new_capture.diagnostics.discarded_session_count, 1);

        pipeline.append_zenz_context("session-a", Some(2), 11, 1, "新しい収録です。");
        let new_session = pipeline.zenz_left_context("session-b", Some(2), 12, 1, false, true);
        assert_eq!(new_session.text, "");
        assert_eq!(new_session.diagnostics.discarded_session_count, 2);
    }

    #[test]
    fn weather_phrase_repairs_are_narrow_and_preserve_percent_text() {
        assert_eq!(
            repair_weather_reading_confusion(
                "あしたのてんきははれこうせいかくりつはろくじゅうぱーせんと"
            ),
            "あしたのてんきははれこうすいかくりつはろくじゅうぱーせんと"
        );
        assert_eq!(
            repair_weather_reading_confusion("こうせいについてせつめいします"),
            "こうせいについてせつめいします"
        );
        assert_eq!(
            repair_caption_phrase_confusions("明日の天気は晴降水確率は60%"),
            "明日の天気は晴れ降水確率は60%"
        );
    }

    #[test]
    fn repair_hearing_phrase_confusion_restores_kikoemasu() {
        assert_eq!(repair_hearing_phrase_confusion("あえますか"), "きこえますか");
        assert_eq!(repair_hearing_phrase_confusion("おえますか"), "きこえますか");
        assert_eq!(repair_hearing_phrase_confusion("会えますか"), "聞こえますか");
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちはあえますか"),
            "こんにちはきこえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは会えますか"),
            "こんにちは聞こえますか"
        );
        assert_eq!(
            repair_hearing_phrase_confusion("こんにちは。聞こえますか。"),
            "こんにちは聞こえますか。"
        );
    }

    #[test]
    fn azookey_without_explicit_path_uses_environment_dictionary() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("env");
        fs::write(&path, "はいしん\t配信中\t-1\n").expect("fixture should write");
        let previous = std::env::var_os("AZOOKEY_DICTIONARY_ROOT");
        std::env::set_var("AZOOKEY_DICTIONARY_ROOT", &path);

        let outcome = normalize_azookey(&AppConfig::default(), "はいしん").expect("normalize");

        match previous {
            Some(value) => std::env::set_var("AZOOKEY_DICTIONARY_ROOT", value),
            None => std::env::remove_var("AZOOKEY_DICTIONARY_ROOT"),
        }
        let _ = fs::remove_file(path);
        assert_eq!(outcome, NormalizeOutcome::Success("配信中".to_string()));
    }

    #[test]
    fn azookey_valid_optional_tsv_path_remains_a_success() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("valid");
        fs::write(&path, "はいしん\t配信中\t-1\n").expect("fixture should write");
        let mut config = AppConfig::default();
        config
            .models
            .paths
            .insert("azookey-user-dictionary".to_string(), path.display().to_string());

        let outcome = normalize_azookey(&config, "はいしん").expect("normalize");
        assert_eq!(outcome, NormalizeOutcome::Success("配信中".to_string()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn default_vrc_sample_user_dictionary_converts_the_documented_reading() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("default-vrc-sample");
        fs::write(&path, "ぶいあーるちゃっと\tVRC\n").expect("fixture should write");
        let mut config = AppConfig::default();
        config
            .models
            .paths
            .insert("azookey-user-dictionary".to_string(), path.display().to_string());

        let outcome = normalize_azookey(&config, "ぶいあーるちゃっと").expect("normalize");
        assert_eq!(outcome, NormalizeOutcome::Success("VRC".to_string()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalidating_azookey_cache_reloads_an_updated_user_dictionary() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("cache-reload");
        fs::write(&path, "かすたむてすと\t最初\n").expect("first fixture should write");
        let mut config = AppConfig::default();
        config
            .models
            .paths
            .insert("azookey-user-dictionary".to_string(), path.display().to_string());
        let pipeline = Pipeline::default();

        let first =
            normalize_azookey_with_cache(&config, "かすたむてすと", &pipeline.azookey_dictionaries)
                .expect("first dictionary should normalize");
        assert_eq!(first, NormalizeOutcome::Success("最初".to_string()));

        fs::write(&path, "かすたむてすと\t更新後\n").expect("updated fixture should write");
        let cached =
            normalize_azookey_with_cache(&config, "かすたむてすと", &pipeline.azookey_dictionaries)
                .expect("cached dictionary should normalize");
        assert_eq!(cached, NormalizeOutcome::Success("最初".to_string()));

        pipeline.invalidate_azookey_dictionaries();
        let reloaded =
            normalize_azookey_with_cache(&config, "かすたむてすと", &pipeline.azookey_dictionaries)
                .expect("updated dictionary should normalize");
        assert_eq!(reloaded, NormalizeOutcome::Success("更新後".to_string()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn azookey_empty_input_is_a_soft_skip_even_with_a_broken_path() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let mut config = AppConfig::default();
        config.models.paths.insert(
            "azookey-rust".to_string(),
            "/definitely/not/an/azookey/dictionary".to_string(),
        );
        let outcome = normalize_azookey(&config, " \n\t ").expect("empty input should not fail");
        assert_eq!(outcome, NormalizeOutcome::Success(String::new()));
    }

    #[test]
    fn azookey_dictionary_error_falls_back_to_builtin_text_and_keeps_diagnostic() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("invalid");
        // An existing but empty TSV is a malformed optional dictionary.  The
        // built-in lexicon should still convert the recognized kana.
        fs::write(&path, b"\n# no usable entries\n").expect("fixture should write");
        let mut config = AppConfig::default();
        config.models.paths.insert("azookey-rust".to_string(), path.to_string_lossy().into_owned());

        let outcome = normalize_azookey(&config, "きょうははいしんです").expect("fallback");
        match outcome {
            NormalizeOutcome::Fallback { text, error } => {
                assert_eq!(text, "今日は配信です");
                assert!(error.contains("AzooKey dictionary"));
                assert!(error.contains("built-in dictionary"));
                assert!(error.contains("did not contain any usable dictionary entries"));
            }
            NormalizeOutcome::Success(text) => panic!("expected fallback, got success: {text}"),
        }
        let _ = fs::remove_file(path);
    }

    #[test]
    fn azookey_missing_optional_path_is_reported_before_loader_soft_skips_it() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("missing");
        let mut config = AppConfig::default();
        config
            .models
            .paths
            .insert("azookey-user-dictionary".to_string(), path.display().to_string());

        let outcome = normalize_azookey(&config, "きょうははいしんです").expect("fallback");
        match outcome {
            NormalizeOutcome::Fallback { text, error } => {
                assert_eq!(text, "今日は配信です");
                assert!(error.contains("user dictionary path does not exist"));
                assert!(error.contains("built-in dictionary"));
            }
            NormalizeOutcome::Success(text) => panic!("expected fallback, got success: {text}"),
        }
    }

    #[test]
    fn azookey_incomplete_directory_is_reported_as_a_fallback() {
        let _guard = DICTIONARY_ENV_LOCK.blocking_lock();
        let path = temporary_dictionary_path("incomplete");
        fs::create_dir_all(&path).expect("fixture directory should create");
        let mut config = AppConfig::default();
        config.models.paths.insert("azookey-rust".to_string(), path.display().to_string());

        let outcome = normalize_azookey(&config, "きょうははいしんです").expect("fallback");
        match outcome {
            NormalizeOutcome::Fallback { text, error } => {
                assert_eq!(text, "今日は配信です");
                assert!(error.contains("system dictionary path is incomplete"));
                assert!(error.contains("built-in dictionary"));
            }
            NormalizeOutcome::Success(text) => panic!("expected fallback, got success: {text}"),
        }
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn fallback_stage_contract_keeps_output_while_marking_dictionary_failure() {
        // A recoverable dictionary error is a failed configured stage, but its
        // output remains non-empty so recognize_source can emit a caption.  A
        // hard normalizer error has no output and returns PipelineError.
        let event = stage_event(
            "normalize",
            "utt-fallback",
            "azookey-rust",
            "きょうははいしんです",
            "今日は配信です",
            3,
            false,
            Some(
                "AzooKey dictionary conversion failed; falling back to built-in dictionary".into(),
            ),
        );
        assert!(!event.ok);
        assert_eq!(event.output_text, "今日は配信です");
        assert!(event
            .error
            .as_deref()
            .is_some_and(|error| { error.contains("dictionary") && error.contains("built-in") }));
    }

    #[test]
    fn progressive_translation_keeps_the_same_caption_id() {
        let config = AppConfig::default();
        let partial = source_ready_caption(&config, "こんにちは".into(), 42, "utt-42".into());
        assert_eq!(partial.stage, "source");
        assert_eq!(partial.sequence, 0);
        assert!(!partial.is_final);
        let final_caption = with_translation(partial.clone(), "  Hello  ", 99);
        assert_eq!(final_caption.id, partial.id);
        assert_eq!(final_caption.source_text, partial.source_text);
        assert_eq!(final_caption.translation_text, "Hello");
        assert_eq!(final_caption.started_at, partial.started_at);
        assert_eq!(final_caption.received_at, 99);
        assert_eq!(final_caption.stage, "translation");
        assert_eq!(final_caption.sequence, 1);
        assert!(final_caption.is_final);
    }

    #[test]
    fn clean_model_text_strips_wrappers() {
        assert_eq!(clean_model_text("  `Hello`  "), "Hello");
    }

    /// The deferred caption-publication path (`complete_translation` →
    /// `with_translation`) must preserve the caption-merge key. The Parapper
    /// producer sets a non-None `azookey_input_text` (the ORIGINAL unrescored
    /// ASR reading); a translation that drops it would turn the merge key into
    /// `None`, silently disabling the frontend's replace-in-place caption merge
    /// for every translated caption even though the source stage carried it.
    #[test]
    fn deferred_translation_preserves_the_caption_merge_key() {
        let config = AppConfig::default();
        let partial = source_ready_caption_with_input(
            &config,
            "今日は配信です".into(),
            42,
            "utt-keeps-key".into(),
            Some("きょうははいしんです".into()),
        );
        assert_eq!(partial.azookey_input_text.as_deref(), Some("きょうははいしんです"));

        let final_caption = with_translation(partial.clone(), "  Hello  ", 99);
        // The merge key must survive the deferred translation intact.
        assert_eq!(
            final_caption.azookey_input_text.as_deref(),
            Some("きょうははいしんです"),
            "with_translation must preserve azookey_input_text across deferred publication"
        );
        assert_eq!(final_caption.id, partial.id);
        assert_eq!(final_caption.stage, "translation");
        assert_eq!(final_caption.sequence, 1);
        assert!(final_caption.is_final);
    }

    #[test]
    fn caption_payload_serializes_camel_case_for_frontend() {
        let payload = CaptionPayload {
            id: "c1".into(),
            source_text: "源".into(),
            azookey_input_text: Some("みなもと".into()),
            translation_text: String::new(),
            source_language: "ja".into(),
            target_language: "en".into(),
            started_at: 1,
            received_at: 2,
            stage: "translation",
            sequence: 1,
            is_final: true,
            confidence: None,
            sentence_end_offsets: Vec::new(),
            soft_break_offsets: Vec::new(),
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(value["sourceText"], "源");
        assert_eq!(value["azookeyInputText"], "みなもと");
        assert_eq!(value["translationText"], "");
        assert_eq!(value["stage"], "translation");
        assert_eq!(value["sequence"], 1);
        assert_eq!(value["isFinal"], true);
        assert_eq!(value["startedAt"], 1);
        assert_eq!(value["receivedAt"], 2);
    }

    #[test]
    fn pipeline_stage_event_serializes_camel_case_for_frontend() {
        let event = PipelineStageEvent {
            stage: "asr",
            utterance_id: "u1".into(),
            model_id: "parapper-ja".into(),
            input_snippet: "wavBytes=12".into(),
            output_text: "こんにちは".into(),
            surface_text: Some("今日は".into()),
            started_at: 57,
            at: 99,
            duration_ms: 42,
            ok: true,
            error: None,
            zenz_context: Some(super::ZenzContextDiagnostics {
                enabled: true,
                is_final: false,
                character_count: 12,
                turn_count: 2,
                discarded_session_count: 1,
            }),
            zenz_verifier: Some(super::ZenzVerifierDiagnostics {
                enabled: false,
                build_available: false,
                loaded: false,
                load_failure_count: 0,
                load_failure_reason: None,
                called_count: 0,
                skipped_count: 1,
                verified_count: 0,
                prefix_constraint_returned_count: 0,
                exhausted_count: 0,
                exhausted_with_constrained_candidate_count: 0,
                exhausted_with_dictionary_fallback_count: 0,
                skipped_by_policy_count: 0,
                deadline_exceeded_count: 0,
                capability_unavailable_count: 0,
                error_count: 0,
                unverified_fallback_count: 0,
                iteration_count: 0,
            }),
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["stage"], "asr");
        assert_eq!(value["utteranceId"], "u1");
        assert_eq!(value["modelId"], "parapper-ja");
        assert_eq!(value["inputSnippet"], "wavBytes=12");
        assert_eq!(value["outputText"], "こんにちは");
        assert_eq!(value["surfaceText"], "今日は");
        assert_eq!(value["startedAt"], 57);
        assert_eq!(value["at"], 99);
        assert_eq!(value["durationMs"], 42);
        assert_eq!(value["ok"], true);
        assert_eq!(value["zenzContext"]["enabled"], true);
        assert_eq!(value["zenzContext"]["isFinal"], false);
        assert_eq!(value["zenzContext"]["characterCount"], 12);
        assert_eq!(value["zenzContext"]["turnCount"], 2);
        assert_eq!(value["zenzContext"]["discardedSessionCount"], 1);
        assert_eq!(value["zenzVerifier"]["enabled"], false);
        assert_eq!(value["zenzVerifier"]["buildAvailable"], false);
        assert_eq!(value["zenzVerifier"]["skippedCount"], 1);
        assert!(value["zenzVerifier"].get("text").is_none());
        assert!(value["error"].is_null());
    }

    #[test]
    fn stage_event_helper_truncates_snippets_and_records_failures() {
        let long = "あ".repeat(STAGE_SNIPPET_CHARS + 20);
        let event = stage_event(
            "normalize",
            "utt",
            "azookey-rust",
            &long,
            "out",
            7,
            false,
            Some("boom".into()),
        );
        assert_eq!(event.stage, "normalize");
        assert_eq!(event.model_id, "azookey-rust");
        assert_eq!(event.duration_ms, 7);
        assert!(event.at >= event.started_at);
        assert_eq!(event.at - event.started_at, 7);
        assert!(!event.ok);
        assert_eq!(event.error.as_deref(), Some("boom"));
        assert!(event.input_snippet.ends_with('…'));
        assert_eq!(snippet(" short "), "short");
        assert_eq!(event.output_text, "out");
    }

    #[test]
    fn stage_event_surface_retains_full_text_for_provisional_caption_paint() {
        let surface = "明".repeat(STAGE_SNIPPET_CHARS + 20);
        let event = stage_event_with_surface(
            "asr",
            "utt",
            "parapper-ja",
            &surface,
            "あ".repeat(STAGE_SNIPPET_CHARS + 20).as_str(),
            7,
            true,
            None,
            Some(&surface),
        );

        assert_eq!(event.surface_text.as_deref(), Some(surface.as_str()));
        assert!(event.output_text.ends_with('…'));
    }

    #[test]
    fn record_stage_notifies_callback_before_storing() {
        let mut stages = Vec::new();
        let mut seen = Vec::new();
        let event =
            stage_event("translate", "u2", "hy-mt2-1.8b-gguf", "源", "Hello", 11, true, None);
        record_stage(
            &mut stages,
            &mut |stage| {
                seen.push(stage.stage);
                assert_eq!(stage.model_id, "hy-mt2-1.8b-gguf");
                assert_eq!(stage.duration_ms, 11);
            },
            event,
        );
        assert_eq!(seen, vec!["translate"]);
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].output_text, "Hello");
    }

    #[test]
    fn normalized_source_caption_keeps_the_utterance_identity_for_translation() {
        // Contract for the live path: the normalized source and later translation
        // keep one utterance id so the UI can fill translation without flicker.
        let config = AppConfig::default();
        let normalized =
            source_ready_caption(&config, "こんにちは".into(), 10, "utt-progressive".into());
        let translated = with_translation(normalized.clone(), "Hello", 20);
        assert_eq!(normalized.id, translated.id);
        assert_eq!(normalized.stage, "source");
        assert!(normalized.translation_text.is_empty());
        assert_eq!(translated.stage, "translation");
        assert_eq!(translated.translation_text, "Hello");
    }

    // -----------------------------------------------------------------------
    // Input-LM rescorer integration tests
    // -----------------------------------------------------------------------

    /// Build a ParapperRecognitionInput with a hiragana reading for testing.
    fn parapper_test_output(reading: &str, surface: &str) -> ParapperRecognitionInput {
        ParapperRecognitionInput {
            text: surface.into(),
            source_text: Some(surface.into()),
            azookey_input_text: Some(reading.into()),
            session_id: "test-session".into(),
            turn_session_id: 1,
            turn_id: 1,
            revision: 0,
            output_sequence: 1,
            segment_id: 1,
            previous_segment_id: None,
            source_asr_model: "test-asr".into(),
            source_language: "ja".into(),
            detected_language: None,
            elapsed_ms: 5,
            audio_duration_ms: None,
            is_final: false,
            capture_generation: None,
        }
    }

    /// Check whether the input-LM model files are present in the default cache
    /// directory. Tests that need the real model skip when this returns false.
    fn input_lm_model_available() -> bool {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let base = std::path::Path::new(&home)
            .join(".cache")
            .join("caption-bridge-input-lm")
            .join("input_n5_lm_v1");
        base.join("lm_c_abc.marisa").exists()
            && base.join("lm_u_abx.marisa").exists()
            && base.join("lm_u_xbc.marisa").exists()
            && base.join("lm_r_xbx.marisa").exists()
    }

    /// When rescore is OFF (the default), no "rescore" stage event is emitted
    /// and the pipeline output is byte-identical to the pre-rescorer path.
    #[tokio::test]
    async fn rescore_disabled_produces_no_rescore_stage_and_preserves_behavior() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        let config = AppConfig::default();
        assert!(!config.rescore.enabled, "rescore must default to OFF");

        let pipeline = Pipeline::default();
        let output = parapper_test_output("きょうははいしんです", "今日は配信です");
        let mut stages = Vec::new();
        let partial = pipeline
            .normalize_parapper_output(
                &config,
                output,
                &mut stages,
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("Parapper output should normalize")
            .expect("should produce a caption");

        // No rescore stage event when the flag is off.
        assert!(
            !stages.iter().any(|s| s.stage == "rescore"),
            "rescore stage must not appear when the flag is off"
        );
        // The azookey_input_text is the original reading (merge key invariant).
        assert_eq!(partial.azookey_input_text.as_deref(), Some("きょうははいしんです"));
        // The source_text is the normalized form (same as pre-rescorer).
        assert_eq!(partial.source_text, "今日は配信です");
    }

    /// When rescore is ON but the model is unavailable, the pipeline falls
    /// back to the original reading. The "rescore" stage event is emitted,
    /// and the merge key (`azookey_input_text`) stays the original reading.
    #[tokio::test]
    async fn rescore_enabled_with_missing_model_falls_back_and_keeps_merge_key() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        let mut config = AppConfig::default();
        config.rescore.enabled = true;
        config.rescore.model_path = Some("/nonexistent/model/lm".into());

        let pipeline = Pipeline::default();
        let mut output = parapper_test_output("きょうははいしんです", "今日は配信です");
        output.is_final = true;
        let mut stages = Vec::new();
        let partial = pipeline
            .normalize_parapper_output(
                &config,
                output,
                &mut stages,
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("Parapper output should normalize even with a missing rescore model")
            .expect("should produce a caption");

        // A rescore stage event is emitted (the stage ran, even though it fell back).
        let rescore_stage =
            stages.iter().find(|s| s.stage == "rescore").expect("rescore stage should be emitted");
        // The rescore output equals the input (fallback to original).
        assert_eq!(rescore_stage.input_snippet, "きょうははいしんです");
        assert_eq!(rescore_stage.output_text, "きょうははいしんです");
        assert!(!rescore_stage.ok, "missing model must mark the rescore stage as failed");
        assert!(
            rescore_stage
                .error
                .as_deref()
                .is_some_and(|error| error.contains("input-LM") || error.contains("load")),
            "missing model should surface a load error, got {:?}",
            rescore_stage.error
        );

        // Merge key invariant: azookey_input_text is the ORIGINAL reading.
        assert_eq!(partial.azookey_input_text.as_deref(), Some("きょうははいしんです"));
        // The source_text is the normalized form of the original reading
        // (same as rescore-off, because the rescore fell back).
        assert_eq!(partial.source_text, "今日は配信です");
    }

    /// Interim outputs skip rescore without changing the merge key. This is the
    /// invariant that prevents the caption-append regression fixed at e393070.
    #[tokio::test]
    async fn merge_key_always_original_reading_regardless_of_rescore() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        let mut config = AppConfig::default();
        config.rescore.enabled = true;
        config.rescore.model_path = Some("/nonexistent/model/lm".into());

        let pipeline = Pipeline::default();

        // Both calls remain interim and must not invoke the missing model.
        let output1 = parapper_test_output("おはよございます", "おはようございます");
        let partial1 = pipeline
            .normalize_parapper_output(
                &config,
                output1,
                &mut Vec::new(),
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("first call should normalize")
            .expect("first call should produce a caption");

        // The merge key is the original reading, not any rescored version.
        assert_eq!(
            partial1.azookey_input_text.as_deref(),
            Some("おはよございます"),
            "merge key must be the original unrescored reading"
        );

        // Second call with a different reading to confirm each keeps its own
        // original — a corrected reading would break cross-caption merge.
        let output2 = parapper_test_output("きてください", "きってください");
        let partial2 = pipeline
            .normalize_parapper_output(
                &config,
                output2,
                &mut Vec::new(),
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("second call should normalize")
            .expect("second call should produce a caption");

        assert_eq!(
            partial2.azookey_input_text.as_deref(),
            Some("きてください"),
            "merge key must be the original unrescored reading for each caption"
        );
        assert!(
            pipeline.rescorer.0.lock().expect("rescorer lock").is_none(),
            "interim skip must not load or invoke the rescorer"
        );
    }

    /// When the real model is available and rescore is ON, the rescorer may
    /// change the kana reading. The merge key stays the original, and the
    /// normalize input is the rescored reading. This test is skipped when
    /// the 120 MB model is not cached locally.
    #[tokio::test]
    async fn rescore_enabled_with_real_model_preserves_merge_key_while_correcting() {
        let _dictionary_env_guard = DICTIONARY_ENV_LOCK.lock().await;
        match input_lm_model_available() {
            true => rescore_with_real_model_core().await,
            false => eprintln!("skipping: input-LM model not cached locally"),
        }
    }

    async fn rescore_with_real_model_core() {
        let mut config = AppConfig::default();
        config.rescore.enabled = true;
        // Use default model path (no override).

        let pipeline = Pipeline::default();
        // "おはよございます" (missing long-vowel う) is the one repair the sweep
        // measured: the rescorer should return "おはようございます".
        let mut output = parapper_test_output("おはよございます", "おはようございます");
        output.is_final = true;
        let mut stages = Vec::new();
        let partial = pipeline
            .normalize_parapper_output(
                &config,
                output,
                &mut stages,
                &mut ignore_pipeline_stage,
                &mut ignore_caption,
            )
            .await
            .expect("Parapper output should normalize with rescore")
            .expect("should produce a caption");

        // A rescore stage event is emitted.
        let rescore_stage =
            stages.iter().find(|s| s.stage == "rescore").expect("rescore stage should be emitted");
        assert_eq!(rescore_stage.input_snippet, "おはよございます");

        // The rescored reading may differ from the original. Whether it does
        // depends on the model, but the merge key must always be the original.
        assert_eq!(
            partial.azookey_input_text.as_deref(),
            Some("おはよございます"),
            "merge key must be the original unrescored reading even when the rescorer changes it"
        );

        // The normalize stage input should be the rescored reading, not the
        // original. (When the rescorer returns the original, this is the same
        // string — that's fine, the point is the wiring is correct.)
        let normalize_stage = stages
            .iter()
            .find(|s| s.stage == "normalize")
            .expect("normalize stage should be emitted");
        assert_eq!(
            normalize_stage.input_snippet, rescore_stage.output_text,
            "normalize stage must receive the rescored reading as input"
        );
    }
    /// Rescore work that always panics, used to drive the fail-open panic path.
    fn panicking_rescore_work() -> String {
        panic!("simulated rescorer failure");
    }

    /// Rescore work that outlives any sane timeout, used to drive the fail-open
    /// timeout path.
    fn slow_rescore_work() -> String {
        std::thread::sleep(std::time::Duration::from_millis(50));
        "rescored-after-timeout".to_string()
    }

    /// Fail-open: if the rescore work panics inside the blocking task, the
    /// caller falls back to the original reading. A panicking rescorer must never
    /// drop a caption.
    #[tokio::test]
    async fn rescore_panic_falls_open_to_the_original_reading() {
        let original = "きょうははいしんです".to_string();
        let result =
            run_rescore_with_timeout(5_000, original.clone(), panicking_rescore_work).await;
        assert!(
            result.is_err(),
            "panic in the rescorer must surface as an error for the caller to fall back"
        );
    }

    /// Fail-open: if the rescore work exceeds the configured timeout, the
    /// caller falls back to the original reading. A slow rescorer must not stall or
    /// drop the caption path.
    #[tokio::test]
    async fn rescore_timeout_falls_open_to_the_original_reading() {
        let original = "きょうははいしんです".to_string();
        let result = run_rescore_with_timeout(1, original.clone(), slow_rescore_work).await;
        assert!(
            result.is_err(),
            "a timed-out rescorer must surface as an error for the caller to fall back"
        );
    }

    /// A successful rescore returns the rescorer output verbatim, proving the
    /// helper's happy path is wired through without loss.
    #[tokio::test]
    async fn rescore_success_returns_the_rescored_reading() {
        let result =
            run_rescore_with_timeout(5_000, "original".to_string(), || "rescored".to_string())
                .await;
        assert_eq!(result, Ok("rescored".to_string()));
    }
}
