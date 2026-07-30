use crate::config::AppConfig;
use crate::kana_kanji::{convert_kana_to_kanji, convert_kana_to_kanji_with_paths, DictionaryPaths};
use reqwest::multipart;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
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
    pub async fn recognize_source(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let started_at = now_millis();
        let recognized = match self.transcribe(config, wav).await {
            Ok(text) if text.trim().is_empty() => return Ok(None),
            Ok(text) => text,
            Err(PipelineError::MissingText) => return Ok(None),
            Err(error) => return Err(error),
        };
        // AzooKey is sync/local and fast; zenz is still required before display so
        // source_text is readable. Never wait for translation here.
        let normalized = self.normalize(config, &recognized).await?;
        if normalized.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(source_ready_caption(config, normalized, started_at)))
    }

    /// Fill `translation_text` for an existing caption, preserving the same `id`
    /// so progressive UI updates stay correlated with one audio chunk.
    pub async fn complete_translation(
        &self,
        config: &AppConfig,
        mut caption: CaptionPayload,
    ) -> Result<CaptionPayload, PipelineError> {
        let translation = self.translate(config, &caption.source_text).await?;
        caption.translation_text = clean_model_text(&translation);
        caption.received_at = now_millis();
        caption.stage = "translation";
        caption.sequence = 1;
        caption.is_final = true;
        Ok(caption)
    }

    /// Full pipeline (ASR → normalize → translate). Prefer staged
    /// `recognize_source` + `complete_translation` for live capture so source
    /// display is not blocked by translation latency.
    pub async fn process(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
    ) -> Result<Option<CaptionPayload>, PipelineError> {
        let Some(partial) = self.recognize_source(config, wav).await? else {
            return Ok(None);
        };
        Ok(Some(self.complete_translation(config, partial).await?))
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
pub fn source_ready_caption(
    config: &AppConfig,
    source_text: String,
    started_at: u64,
) -> CaptionPayload {
    CaptionPayload {
        id: Uuid::new_v4().to_string(),
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
        || lower.contains("no transcript")
        || lower.contains("empty transcript")
        || lower.contains("\"text\":\"\"")
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
        clean_model_text, is_no_speech_response, source_ready_caption, with_translation,
        CaptionPayload,
    };
    use crate::config::AppConfig;

    #[test]
    fn detects_parapper_no_speech_payloads() {
        assert!(is_no_speech_response(
            422,
            r#"{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}"#
        ));
        assert!(!is_no_speech_response(500, r#"{"error":{"code":"boom"}}"#));
        assert!(!is_no_speech_response(422, r#"{"error":{"code":"invalid_audio"}}"#));
    }

    #[test]
    fn source_ready_caption_has_empty_translation_and_stable_identity_fields() {
        let config = AppConfig::default();
        let partial = source_ready_caption(&config, "こんにちは".into(), 1_700_000_000_000);
        assert_eq!(partial.source_text, "こんにちは");
        assert!(partial.translation_text.is_empty(), "translation must not block source emit");
        assert_eq!(partial.source_language, config.language.source);
        assert_eq!(partial.target_language, config.language.target);
        assert_eq!(partial.started_at, 1_700_000_000_000);
        assert!(!partial.id.is_empty());
    }

    #[test]
    fn progressive_translation_keeps_the_same_caption_id() {
        let config = AppConfig::default();
        let partial = source_ready_caption(&config, "こんにちは".into(), 42);
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
}
