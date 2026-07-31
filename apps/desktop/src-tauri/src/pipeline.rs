use crate::config::AppConfig;
use crate::kana_kanji::{convert_kana_to_kanji, convert_kana_to_kanji_with_paths, DictionaryPaths};
use reqwest::multipart;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use thiserror::Error;
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
    pub duration_ms: u64,
    pub ok: bool,
    pub error: Option<String>,
    pub at: u64,
}

const STAGE_SNIPPET_CHARS: usize = 160;

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

#[derive(Debug, Clone)]
pub struct Pipeline {
    client: Client,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self { client: Client::new() }
    }
}

impl Pipeline {
    /// ASR → normalize only. Translation is intentionally left empty so the UI
    /// can show source text immediately without waiting on the translator.
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
    pub async fn recognize_source(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
        stages: &mut Vec<PipelineStageEvent>,
        on_stage: &mut (dyn FnMut(&PipelineStageEvent) + Send),
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let started_at = now_millis();
        let utterance_id = Uuid::new_v4().to_string();
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

        // AzooKey is sync/local and fast; zenz is still required before display so
        // source_text is readable. Never wait for translation here.
        let normalize_started = Instant::now();
        let normalized = match self.normalize(config, &recognized).await {
            Ok(text) => {
                record_stage(
                    stages,
                    on_stage,
                    stage_event(
                        "normalize",
                        &utterance_id,
                        normalize_model,
                        &recognized,
                        &text,
                        elapsed_ms(normalize_started),
                        true,
                        None,
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
                        &recognized,
                        "",
                        elapsed_ms(normalize_started),
                        false,
                        Some(error.to_string()),
                    ),
                );
                return Err(error);
            }
        };
        if normalized.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(source_ready_caption(config, normalized, started_at, utterance_id)))
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
    ) -> Result<CaptionPayload, PipelineError> {
        let translate_started = Instant::now();
        let source = caption.source_text.clone();
        let utterance_id = caption.id.clone();
        let translate_model = config.models.translator.as_str();
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
                Ok(finished)
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
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let Some(partial) = self.recognize_source(config, wav, stages, on_stage).await? else {
            return Ok(None);
        };
        Ok(Some(self.complete_translation(config, partial, stages, on_stage).await?))
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
        if !status.is_success() {
            // Live mic chunks often contain only ambient noise. Parapper finishes
            // without a final transcript (HTTP 422 transcript_missing) — that is
            // not a pipeline fault for continuous capture.
            if is_no_speech_response(status.as_u16(), &body) {
                return Ok(String::new());
            }
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

    async fn normalize(&self, config: &AppConfig, text: &str) -> Result<String, PipelineError> {
        match config.models.normalizer.as_str() {
            "azookey-rust" => {
                let paths = DictionaryPaths {
                    system: config
                        .models
                        .paths
                        .get("azookey-rust")
                        .filter(|path| !path.trim().is_empty())
                        .map(Into::into),
                    user: config
                        .models
                        .paths
                        .get("azookey-user-dictionary")
                        .filter(|path| !path.trim().is_empty())
                        .map(Into::into),
                    memory: config
                        .models
                        .paths
                        .get("azookey-learning-memory")
                        .filter(|path| !path.trim().is_empty())
                        .map(Into::into),
                };
                if paths.system.is_none() && paths.user.is_none() && paths.memory.is_none() {
                    Ok(convert_kana_to_kanji(text))
                } else {
                    convert_kana_to_kanji_with_paths(text, paths).map_err(PipelineError::Model)
                }
            }
            "zenz-v2-q5-k-m-gguf" | "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf" => {
                // Zenz is a dedicated kana-kanji converter, not an instruction-tuned chat model.
                // Its model contract uses U+EE00 / U+EE01 delimiters around the phonetic input.
                let prompt = format!("\u{EE00}{text}\u{EE01}");
                self.chat(config, &config.models.normalizer, prompt).await
            }
            other => Err(PipelineError::UnsupportedModel(other.to_string())),
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
        self.chat(config, &config.models.translator, prompt).await
    }

    async fn chat(
        &self,
        config: &AppConfig,
        model: &str,
        prompt: String,
    ) -> Result<String, PipelineError> {
        let url = endpoint_url(&config.endpoint.base_url, &config.endpoint.chat_path);
        let request = ChatRequest {
            model,
            model_path: config
                .models
                .paths
                .get(model)
                .map(String::as_str)
                .filter(|path| !path.trim().is_empty()),
            messages: vec![ChatMessageRequest { role: "user", content: prompt }],
            temperature: 0.7,
            top_p: 0.6,
            max_tokens: 512,
            stream: false,
        };
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
            .filter(|text| !text.trim().is_empty())
            .ok_or(PipelineError::MissingText)
    }
}

/// Build the intermediate caption emitted as soon as normalized ASR is ready.
/// `translation_text` is intentionally empty until `complete_translation`.
/// `id` must be stable across progressive stages (ASR/normalize → translate).
pub fn source_ready_caption(
    config: &AppConfig,
    source_text: String,
    started_at: u64,
    id: String,
) -> CaptionPayload {
    CaptionPayload {
        id,
        source_text,
        translation_text: String::new(),
        source_language: config.language.source.clone(),
        target_language: config.language.target.clone(),
        started_at,
        received_at: now_millis(),
        stage: "source",
        sequence: 0,
        is_final: false,
        confidence: None,
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
    PipelineStageEvent {
        stage,
        utterance_id: utterance_id.to_string(),
        model_id: model_id.to_string(),
        input_snippet: snippet(input),
        output_text: snippet(output),
        duration_ms,
        ok,
        error,
        at: now_millis(),
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
    if !(status == 404 || status == 422 || status == 204) {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("transcript_missing")
        || lower.contains("without a final transcript")
        || lower.contains("no final transcript")
        || lower.contains("no transcript")
        || lower.contains("empty transcript")
        || lower.contains("\"text\":\"\"")
        || lower.contains("\"text\": \"\"")
        || lower.contains("\"transcript\":\"\"")
        || lower.contains("\"transcript\": \"\"")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        clean_model_text, is_no_speech_response, record_stage, snippet, source_ready_caption,
        stage_event, with_translation, CaptionPayload, PipelineStageEvent, STAGE_SNIPPET_CHARS,
    };
    use crate::config::AppConfig;

    #[test]
    fn detects_parapper_no_speech_payloads() {
        // Exact user toast payload body from live capture:
        // inference returned HTTP 422: {"error":{"code":"transcript_missing",...}}
        let exact = r#"{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}"#;
        assert!(is_no_speech_response(422, exact));
        // Message-only variants (code field missing / differently shaped bodies).
        assert!(is_no_speech_response(422, "Parapper completed without a final transcript"));
        assert!(is_no_speech_response(404, r#"{"error":{"message":"no transcript"}}"#));
        assert!(is_no_speech_response(204, r#"{"text":""}"#));
        assert!(is_no_speech_response(422, r#"{"text": ""}"#));
        // Real faults must still fail the pipeline.
        assert!(!is_no_speech_response(500, exact));
        assert!(!is_no_speech_response(500, r#"{"error":{"code":"boom"}}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"invalid_audio"}}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"parapper_timeout"}}"#));
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

    #[test]
    fn caption_payload_serializes_camel_case_for_frontend() {
        let payload = CaptionPayload {
            id: "c1".into(),
            source_text: "源".into(),
            translation_text: String::new(),
            source_language: "ja".into(),
            target_language: "en".into(),
            started_at: 1,
            received_at: 2,
            stage: "translation",
            sequence: 1,
            is_final: true,
            confidence: None,
        };
        let value = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(value["sourceText"], "源");
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
            duration_ms: 42,
            ok: true,
            error: None,
            at: 99,
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["stage"], "asr");
        assert_eq!(value["utteranceId"], "u1");
        assert_eq!(value["modelId"], "parapper-ja");
        assert_eq!(value["inputSnippet"], "wavBytes=12");
        assert_eq!(value["outputText"], "こんにちは");
        assert_eq!(value["durationMs"], 42);
        assert_eq!(value["ok"], true);
        assert!(value["error"].is_null());
        assert_eq!(value["at"], 99);
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
        assert!(!event.ok);
        assert_eq!(event.error.as_deref(), Some("boom"));
        assert!(event.input_snippet.ends_with('…'));
        assert_eq!(snippet(" short "), "short");
        assert_eq!(event.output_text, "out");
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
}
