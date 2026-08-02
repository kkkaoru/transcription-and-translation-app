use std::{collections::HashMap, sync::Arc, time::Instant};

use anyhow::{Context, Result};
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    config::{LocalTranslationModel, TranslationLanguage},
    connect::YncPluginClient,
    delivery::common::TranslationProviderId,
    processing::ProcessingContext,
};

use super::local;

const TRANSLATION_PROVIDER_AGENT_ID: &str = "parapper-translation-provider";

#[derive(Debug, Clone)]
pub(crate) struct TranslationTask {
    pub(crate) id: String,
    pub(crate) context: ProcessingContext,
    pub(crate) source_lang: TranslationLanguage,
    pub(crate) target_lang: TranslationLanguage,
    pub(crate) text: String,
    pub(crate) is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranslationResult {
    pub(crate) task_id: String,
    pub(crate) context: ProcessingContext,
    pub(crate) target_lang: TranslationLanguage,
    pub(crate) text: String,
    pub(crate) elapsed_millis: u128,
}

pub(crate) trait TranslationProvider: Send + Sync {
    fn translate(&self, task: &TranslationTask) -> Result<Option<TranslationResult>>;
}

pub(crate) struct TranslationProviderRegistry {
    providers: HashMap<TranslationProviderId, Arc<dyn TranslationProvider>>,
}

impl TranslationProviderRegistry {
    pub(crate) fn for_request(
        handle: Option<&AppHandle>,
        ync_port: u16,
        provider_ids: impl IntoIterator<Item = TranslationProviderId>,
    ) -> Self {
        let mut registry = Self::empty();
        for provider_id in provider_ids {
            registry.providers.entry(provider_id).or_insert_with(|| match provider_id {
                TranslationProviderId::Ync => Arc::new(YncTranslationProvider { port: ync_port }),
                TranslationProviderId::Local(model) => {
                    Arc::new(InProcessTranslationProvider { handle: handle.cloned(), model })
                }
            });
        }
        registry
    }

    fn empty() -> Self {
        Self { providers: HashMap::new() }
    }

    pub(crate) fn translate(
        &self,
        provider_id: TranslationProviderId,
        task: &TranslationTask,
    ) -> Result<Option<TranslationResult>> {
        let request_id = Uuid::new_v4().to_string();
        let started_at = Instant::now();
        log_provider_turn_start(&request_id, provider_id, task);

        let result = self
            .providers
            .get(&provider_id)
            .with_context(|| format!("translation provider is not registered: {provider_id:?}"))
            .and_then(|provider| provider.translate(task));
        let duration_ms = started_at.elapsed().as_millis();

        match &result {
            Ok(Some(output)) => log_provider_turn_end(
                &request_id,
                provider_id,
                task,
                duration_ms,
                Some(output.text.chars().count()),
                None,
            ),
            Ok(None) => log_provider_turn_skip(
                &request_id,
                provider_id,
                task,
                duration_ms,
                if task.is_final { "not_ready" } else { "non_final" },
            ),
            Err(error) => {
                let error_message = error.to_string();
                log_provider_turn_end(
                    &request_id,
                    provider_id,
                    task,
                    duration_ms,
                    None,
                    Some(error_message.as_str()),
                );
            }
        }

        result
    }
}

#[derive(Clone, Copy)]
struct ProviderTurnOutcome<'a> {
    status: Option<&'a str>,
    duration_ms: Option<u128>,
    output_chars: Option<usize>,
    error: Option<&'a str>,
    reason: Option<&'a str>,
}

fn provider_turn_payload(
    event: &str,
    request_id: &str,
    provider_id: TranslationProviderId,
    task: &TranslationTask,
    outcome: &ProviderTurnOutcome<'_>,
) -> serde_json::Value {
    serde_json::json!({
        "event": event,
        "request_id": request_id,
        "agent_id": TRANSLATION_PROVIDER_AGENT_ID,
        "parent_agent_id": serde_json::Value::Null,
        "provider": format!("{provider_id:?}"),
        "session_id": task.context.turn_session_id,
        "turn_session_id": task.context.turn_session_id,
        "source_id": task.id,
        "turn_id": task.context.turn_id,
        "revision": task.context.turn_revision,
        "segment_id": task.context.segment_id,
        "source_kind": format!("{:?}", task.context.source_kind),
        "source_language": task.context.source_language,
        "target_lang": task.target_lang.as_code(),
        "is_final": task.is_final,
        "text_chars": task.text.chars().count(),
        "status": outcome.status,
        "duration_ms": outcome.duration_ms,
        "output_chars": outcome.output_chars,
        "error": outcome.error,
        "reason": outcome.reason,
    })
}

fn log_provider_turn_start(
    request_id: &str,
    provider_id: TranslationProviderId,
    task: &TranslationTask,
) {
    let payload = provider_turn_payload(
        "provider_turn_start",
        request_id,
        provider_id,
        task,
        &ProviderTurnOutcome {
            status: None,
            duration_ms: None,
            output_chars: None,
            error: None,
            reason: None,
        },
    );
    log::info!(target: "translation_provider", "{payload}");
}

fn log_provider_turn_end(
    request_id: &str,
    provider_id: TranslationProviderId,
    task: &TranslationTask,
    duration_ms: u128,
    output_chars: Option<usize>,
    error: Option<&str>,
) {
    let failed = error.is_some();
    let payload = provider_turn_payload(
        "provider_turn_end",
        request_id,
        provider_id,
        task,
        &ProviderTurnOutcome {
            status: Some(if failed { "error" } else { "success" }),
            duration_ms: Some(duration_ms),
            output_chars,
            error,
            reason: None,
        },
    );
    if failed {
        log::warn!(target: "translation_provider", "{payload}");
    } else {
        log::info!(target: "translation_provider", "{payload}");
    }
}

fn log_provider_turn_skip(
    request_id: &str,
    provider_id: TranslationProviderId,
    task: &TranslationTask,
    duration_ms: u128,
    reason: &str,
) {
    let payload = provider_turn_payload(
        "provider_turn_skip",
        request_id,
        provider_id,
        task,
        &ProviderTurnOutcome {
            status: Some("skipped"),
            duration_ms: Some(duration_ms),
            output_chars: None,
            error: None,
            reason: Some(reason),
        },
    );
    log::info!(target: "translation_provider", "{payload}");
}

struct InProcessTranslationProvider {
    handle: Option<AppHandle>,
    model: LocalTranslationModel,
}

impl TranslationProvider for InProcessTranslationProvider {
    fn translate(&self, task: &TranslationTask) -> Result<Option<TranslationResult>> {
        if !task.is_final {
            return Ok(None);
        }
        let handle = self
            .handle
            .as_ref()
            .context("local translation requires an application handle for model loading")?;
        let started_at = Instant::now();
        let text = local::translate_text(
            handle,
            self.model,
            task.source_lang,
            task.target_lang,
            &task.text,
        )?;
        Ok(Some(result(task, text, started_at)))
    }
}

struct YncTranslationProvider {
    port: u16,
}

impl TranslationProvider for YncTranslationProvider {
    fn translate(&self, task: &TranslationTask) -> Result<Option<TranslationResult>> {
        let started_at = Instant::now();
        let mut client = YncPluginClient::for_command(self.port)?;
        let response = client.translate(&task.id, task.target_lang.as_code(), &task.text)?;
        Ok(Some(result(task, response.text, started_at)))
    }
}

fn result(task: &TranslationTask, text: String, started_at: Instant) -> TranslationResult {
    TranslationResult {
        task_id: task.id.clone(),
        context: task.context.clone(),
        target_lang: task.target_lang,
        text,
        elapsed_millis: started_at.elapsed().as_millis(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SpeechSourceKind;

    fn task() -> TranslationTask {
        TranslationTask {
            id: "turn-1|en".to_string(),
            context: ProcessingContext {
                turn_session_id: 1,
                turn_id: 2,
                turn_revision: 3,
                segment_id: 4,
                source_kind: SpeechSourceKind::Recognition,
                source_language: Some("ja".to_string()),
            },
            source_lang: TranslationLanguage::Ja,
            target_lang: TranslationLanguage::En,
            text: "こんにちは".to_string(),
            is_final: true,
        }
    }

    #[test]
    fn unknown_translation_provider_is_an_error_without_fallback() {
        let error = TranslationProviderRegistry::empty()
            .translate(TranslationProviderId::Ync, &task())
            .expect_err("an unregistered provider must not fall back");

        assert!(error.to_string().contains("not registered"));
    }

    #[test]
    fn provider_turn_payload_preserves_turn_and_agent_correlation() {
        let payload = provider_turn_payload(
            "provider_turn_start",
            "request-1",
            TranslationProviderId::Ync,
            &task(),
            &ProviderTurnOutcome {
                status: None,
                duration_ms: None,
                output_chars: None,
                error: None,
                reason: None,
            },
        );

        assert_eq!(payload["event"], "provider_turn_start");
        assert_eq!(payload["request_id"], "request-1");
        assert_eq!(payload["agent_id"], TRANSLATION_PROVIDER_AGENT_ID);
        assert_eq!(payload["parent_agent_id"], serde_json::Value::Null);
        assert_eq!(payload["session_id"], 1);
        assert_eq!(payload["turn_session_id"], 1);
        assert_eq!(payload["source_id"], "turn-1|en");
        assert_eq!(payload["turn_id"], 2);
        assert_eq!(payload["revision"], 3);
        assert_eq!(payload["segment_id"], 4);
        assert_eq!(payload["target_lang"], "en");
        assert_eq!(payload["text_chars"], 5);
        assert!(payload["duration_ms"].is_null());
    }

    #[test]
    fn provider_turn_skip_payload_is_explicit_about_non_final_work() {
        let mut task = task();
        task.is_final = false;
        let payload = provider_turn_payload(
            "provider_turn_skip",
            "request-2",
            TranslationProviderId::Local(LocalTranslationModel::Lfm2Q4),
            &task,
            &ProviderTurnOutcome {
                status: Some("skipped"),
                duration_ms: Some(3),
                output_chars: None,
                error: None,
                reason: Some("non_final"),
            },
        );

        assert_eq!(payload["status"], "skipped");
        assert_eq!(payload["reason"], "non_final");
        assert_eq!(payload["is_final"], false);
        assert_eq!(payload["duration_ms"], 3);
        assert!(payload["error"].is_null());
        assert!(payload["output_chars"].is_null());
    }

    #[test]
    fn provider_turn_end_payload_marks_failures_without_logging_text() {
        let payload = provider_turn_payload(
            "provider_turn_end",
            "request-3",
            TranslationProviderId::Ync,
            &task(),
            &ProviderTurnOutcome {
                status: Some("error"),
                duration_ms: Some(7),
                output_chars: None,
                error: Some("provider unavailable"),
                reason: None,
            },
        );

        assert_eq!(payload["status"], "error");
        assert_eq!(payload["error"], "provider unavailable");
        assert_eq!(payload["duration_ms"], 7);
        assert!(payload.get("text").is_none());
        assert!(payload["output_chars"].is_null());
    }
}
