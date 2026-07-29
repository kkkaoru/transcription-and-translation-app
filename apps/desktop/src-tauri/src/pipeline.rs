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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPayload {
    pub id: String,
    pub source_text: String,
    pub translation_text: String,
    pub source_language: String,
    pub target_language: String,
    pub started_at: u64,
    pub received_at: u64,
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
    pub async fn process(
        &self,
        config: &AppConfig,
        wav: Vec<u8>,
    ) -> Result<CaptionPayload, PipelineError> {
        let started_at = now_millis();
        let recognized = self.transcribe(config, wav).await?;
        let normalized = self.normalize(config, &recognized).await?;
        let translation = self.translate(config, &normalized).await?;
        Ok(CaptionPayload {
            id: Uuid::new_v4().to_string(),
            source_text: normalized,
            translation_text: clean_model_text(&translation),
            source_language: config.language.source.clone(),
            target_language: config.language.target.clone(),
            started_at,
            received_at: now_millis(),
            confidence: None,
        })
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
            return Err(PipelineError::Http { status: status.as_u16(), body });
        }
        let parsed: TranscriptResponse = serde_json::from_str(&body).or_else(|_| {
            let value: Value = serde_json::from_str(&body)?;
            Ok::<TranscriptResponse, serde_json::Error>(TranscriptResponse {
                text: value.get("text").and_then(Value::as_str).map(str::to_string),
                transcript: value.get("transcript").and_then(Value::as_str).map(str::to_string),
            })
        })?;
        parsed
            .text
            .or(parsed.transcript)
            .filter(|text| !text.trim().is_empty())
            .ok_or(PipelineError::MissingText)
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
            "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf" => {
                let prompt = format!(
                    "音声認識結果を自然な日本語の漢字かな交じり文に変換してください。意味を変えず、変換後の本文だけを出力してください。\n入力: {text}"
                );
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
