use crate::config::AppConfig;
use crate::native_output::NativeOutputHandle;
use crate::output::OutputStatus;
use crate::pipeline::{CaptionPayload, Pipeline, PipelineStageEvent};
use serde::Serialize;
use std::sync::Mutex;

/// Number of completed pipeline stages retained for diagnostics.
///
/// `pipeline:stage` is an ephemeral Tauri event. Keeping a bounded native
/// ring buffer means the Debug panel can recover stages that completed before
/// it subscribed (and keeps diagnostics from growing without bound during a
/// long capture session).
pub const PIPELINE_STAGE_HISTORY_LIMIT: usize = 96;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub status: String,
    pub platform: String,
    pub backend_reachable: bool,
    pub native_output: String,
    pub last_error: Option<String>,
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub status: Mutex<RuntimeStatus>,
    pub pipeline: Pipeline,
    /// Completed ASR / normalizer / translator stages, oldest first.
    pub pipeline_stage_history: Mutex<Vec<PipelineStageEvent>>,
    /// Most recent normalized source/translation caption for overlay replay.
    /// Raw ASR text is never passed to this slot.
    pub latest_caption: Mutex<Option<CaptionPayload>>,
    pub native_output: Mutex<NativeOutputHandle>,
    /// Set when an update is ready but capture is still active. The frontend
    /// stops the microphone first; `stop_capture` then consumes this flag and
    /// requests a graceful Tauri restart.
    pub relaunch_after_capture: Mutex<bool>,
}

/// Match the frontend caption merge ordering before replacing the replay slot.
fn caption_sequence(caption: &CaptionPayload) -> u16 {
    if caption.sequence > 0 {
        return caption.sequence;
    }
    // Explicit source-stage payloads (including raw/Web Speech final text)
    // remain sequence 0. `is_final` describes recognition completion, not a
    // translation revision; treating it as sequence 1 could hide a later
    // progressive source update in native replay.
    if caption.stage == "source" {
        return 0;
    }
    if caption.stage == "translation"
        || caption.is_final
        || !caption.translation_text.trim().is_empty()
    {
        return 1;
    }
    0
}

fn caption_is_stale(current: &CaptionPayload, candidate: &CaptionPayload) -> bool {
    if current.id == candidate.id {
        let current_sequence = caption_sequence(current);
        let candidate_sequence = caption_sequence(candidate);
        if candidate_sequence > current_sequence {
            // A translation for an older rolling-context window can finish
            // after a newer source revision has already been replayed.  The
            // frontend drops that event because its source text belongs to a
            // different revision; keep the native replay slot in lockstep.
            return current_sequence == 0 && is_stale_translation_revision(current, candidate);
        }
        if candidate_sequence == current_sequence {
            // Same-id revisions are ordered by the chunk's recognition start,
            // then receipt time. This prevents a late translation for an older
            // rolling-context chunk from replacing a newer translation merely
            // because its network response arrived later.
            return is_older_same_sequence(current, candidate);
        }

        // Sequence 0 normally must not regress a translated caption. A changed
        // source received no earlier than the current translation is an explicit
        // progressive revision, however, so keep it for native replay parity
        // with the frontend merge path.
        return !is_newer_source_revision(current, candidate);
    }
    if current.started_at == 0 || candidate.started_at == 0 {
        return false;
    }
    candidate.started_at < current.started_at
        || (candidate.started_at == current.started_at
            && candidate.received_at < current.received_at)
}

fn is_newer_source_revision(current: &CaptionPayload, candidate: &CaptionPayload) -> bool {
    candidate.stage == "source"
        && !candidate.source_text.trim().is_empty()
        && !current.source_text.trim().is_empty()
        && current.source_text.trim() != candidate.source_text.trim()
        && is_newer_revision(current, candidate)
}

fn is_stale_translation_revision(current: &CaptionPayload, candidate: &CaptionPayload) -> bool {
    current.stage == "source"
        && !current.source_text.trim().is_empty()
        && !candidate.source_text.trim().is_empty()
        && current.source_text.trim() != candidate.source_text.trim()
}

/// Recognition start is the primary revision signal. Receipt time is only a
/// tie-breaker because an older translation can complete after a newer source
/// request and therefore have a later network arrival timestamp.
fn is_newer_revision(current: &CaptionPayload, candidate: &CaptionPayload) -> bool {
    if current.started_at > 0
        && candidate.started_at > 0
        && candidate.started_at != current.started_at
    {
        return candidate.started_at > current.started_at;
    }
    candidate.received_at >= current.received_at
}

fn is_older_same_sequence(current: &CaptionPayload, candidate: &CaptionPayload) -> bool {
    if current.started_at > 0 && candidate.started_at > 0 {
        return candidate.started_at < current.started_at
            || (candidate.started_at == current.started_at
                && candidate.received_at < current.received_at);
    }
    candidate.received_at < current.received_at
}

impl AppState {
    pub fn new(config: AppConfig, output: OutputStatus) -> Self {
        let native_output = NativeOutputHandle::new(config.overlay.width, config.overlay.height);
        let native_output_kind = native_output.kind().to_string();
        Self {
            config: Mutex::new(config),
            status: Mutex::new(RuntimeStatus {
                status: "idle".to_string(),
                platform: output.platform,
                backend_reachable: false,
                native_output: native_output_kind,
                last_error: None,
            }),
            pipeline: Pipeline::default(),
            pipeline_stage_history: Mutex::new(Vec::new()),
            latest_caption: Mutex::new(None),
            native_output: Mutex::new(native_output),
            relaunch_after_capture: Mutex::new(false),
        }
    }

    /// Retain one completed stage before publishing its best-effort event.
    ///
    /// A poisoned diagnostics lock must not make transcription fail. The
    /// event stream remains best effort, while callers can still emit the
    /// `pipeline:stage` event and return a caption normally.
    pub fn record_pipeline_stage(&self, stage: &PipelineStageEvent) {
        let Ok(mut history) = self.pipeline_stage_history.lock() else {
            return;
        };
        history.push(stage.clone());
        if history.len() > PIPELINE_STAGE_HISTORY_LIMIT {
            let excess = history.len() - PIPELINE_STAGE_HISTORY_LIMIT;
            history.drain(0..excess);
        }
    }

    /// Return retained stages newest first, matching the frontend diagnostic
    /// store's snapshot order. A poisoned lock degrades to an empty snapshot.
    pub fn pipeline_stage_history(&self) -> Vec<PipelineStageEvent> {
        self.pipeline_stage_history
            .lock()
            .map(|history| history.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Retain the latest user-facing caption for a late overlay subscriber.
    /// Callers should pass only normalized source or translated payloads.
    pub fn record_latest_caption(&self, caption: &CaptionPayload) {
        if !matches!(caption.stage, "source" | "translation") {
            return;
        }
        let Ok(mut latest) = self.latest_caption.lock() else {
            return;
        };
        if latest.as_ref().is_some_and(|current| caption_is_stale(current, caption)) {
            // Background translation can finish out of order. Preserve the
            // newest utterance, matching frontend caption merging.
            return;
        }
        *latest = Some(caption.clone());
    }

    /// Return a cloned latest caption without allowing a poisoned lock to
    /// break an overlay/debug request.
    pub fn latest_caption(&self) -> Option<CaptionPayload> {
        self.latest_caption.lock().ok().and_then(|latest| latest.clone())
    }

    /// Drop the replay slot when a capture session ends normally. A late
    /// overlay subscriber must not resurrect a caption from the prior session.
    pub fn clear_latest_caption(&self) {
        if let Ok(mut latest) = self.latest_caption.lock() {
            *latest = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppState, PIPELINE_STAGE_HISTORY_LIMIT};
    use crate::config::AppConfig;
    use crate::output::OutputStatus;
    use crate::pipeline::{CaptionPayload, PipelineStageEvent};

    fn stage(index: usize) -> PipelineStageEvent {
        PipelineStageEvent {
            stage: "asr",
            utterance_id: format!("utterance-{index}"),
            model_id: "parapper-ja".to_string(),
            input_snippet: format!("input-{index}"),
            output_text: format!("output-{index}"),
            started_at: index as u64,
            at: index as u64 + 1,
            duration_ms: 1,
            ok: true,
            error: None,
        }
    }

    #[test]
    fn stage_history_is_bounded_and_newest_first() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        for index in 0..PIPELINE_STAGE_HISTORY_LIMIT + 2 {
            state.record_pipeline_stage(&stage(index));
        }
        let history = state.pipeline_stage_history();
        assert_eq!(history.len(), PIPELINE_STAGE_HISTORY_LIMIT);
        assert_eq!(history.first().map(|event| event.utterance_id.as_str()), Some("utterance-97"));
        assert_eq!(history.last().map(|event| event.utterance_id.as_str()), Some("utterance-2"));
    }

    #[test]
    fn latest_caption_replaces_source_with_translation_without_raw_asr() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        let source = CaptionPayload {
            id: "u1".to_string(),
            source_text: "正規化済み".to_string(),
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "source",
            sequence: 0,
            is_final: false,
            confidence: None,
        };
        state.record_latest_caption(&source);
        assert_eq!(state.latest_caption(), Some(source.clone()));

        let translated = CaptionPayload {
            translation_text: "normalized".to_string(),
            stage: "translation",
            sequence: 1,
            is_final: true,
            started_at: 10,
            received_at: 30,
            ..source.clone()
        };
        state.record_latest_caption(&translated);
        assert_eq!(state.latest_caption(), Some(translated.clone()));

        // A response for an older same-id chunk may arrive later over the
        // network. Recognition start ordering wins over its newer receipt time.
        let late_old_translation = CaptionPayload {
            source_text: "古いソース".to_string(),
            translation_text: "old source".to_string(),
            started_at: 9,
            received_at: 40,
            ..translated.clone()
        };
        state.record_latest_caption(&late_old_translation);
        assert_eq!(state.latest_caption(), Some(translated.clone()));

        let late_old_source_revision = CaptionPayload {
            source_text: "古いソース改訂".to_string(),
            translation_text: String::new(),
            started_at: 9,
            received_at: 31,
            stage: "source",
            sequence: 0,
            is_final: false,
            ..translated.clone()
        };
        state.record_latest_caption(&late_old_source_revision);
        assert_eq!(state.latest_caption(), Some(translated.clone()));

        // A newer normalized source revision may arrive after translation. Keep
        // it in the replay slot so native subscribers converge with frontend
        // mergeCaptionPayload rather than retaining the old source forever.
        let newer_source = CaptionPayload {
            source_text: "正規化済み（改訂）".to_string(),
            translation_text: String::new(),
            started_at: 11,
            // The newer audio window can finish before an older translation;
            // recognition start ordering must win over receipt time.
            received_at: 29,
            stage: "source",
            sequence: 0,
            is_final: false,
            ..translated.clone()
        };
        state.record_latest_caption(&newer_source);
        assert_eq!(state.latest_caption(), Some(newer_source.clone()));

        let late_old_translation = CaptionPayload {
            source_text: "正規化済み".to_string(),
            translation_text: "normalized".to_string(),
            received_at: 50,
            stage: "translation",
            sequence: 1,
            is_final: true,
            ..translated.clone()
        };
        state.record_latest_caption(&late_old_translation);
        assert_eq!(state.latest_caption(), Some(newer_source.clone()));

        let older_source = CaptionPayload {
            source_text: "古い改訂".to_string(),
            received_at: 3,
            ..newer_source.clone()
        };
        state.record_latest_caption(&older_source);
        assert_eq!(state.latest_caption(), Some(newer_source.clone()));

        let stale = CaptionPayload { id: "older".to_string(), received_at: 1, ..newer_source };
        state.record_latest_caption(&stale);
        assert_eq!(state.latest_caption().map(|caption| caption.id), Some("u1".to_string()));

        let raw_asr = CaptionPayload { stage: "asr", source_text: "raw".to_string(), ..stale };
        state.record_latest_caption(&raw_asr);
        assert_eq!(state.latest_caption().map(|caption| caption.id), Some("u1".to_string()));

        state.clear_latest_caption();
        assert_eq!(state.latest_caption(), None);
    }
}
