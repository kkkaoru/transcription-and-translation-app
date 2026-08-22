//! Framework-agnostic caption event bus.
//!
//! This crate locks the event *names* and the *payloads the bus must carry*.
//! A Tauri adapter can later implement [`CaptionSink`] with `Emitter`; a GPUI
//! adapter can push the same [`CaptionEvent`] values into its model. Neither
//! adapter belongs in this crate.
//!
//! Full [`AppConfig`] still lives in desktop core
//! (`apps/desktop/src-tauri/src/config.rs` and `apps/desktop/src/core/types.ts`)
//! and can be added here when that type is extracted. [`ConfigUpdate`] is only
//! the identifying slice a bus consumer needs.

#![forbid(unsafe_code)]

use std::sync::mpsc::{self, Receiver, SendError, Sender};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde::Serialize;
use thiserror::Error;

/// Locked IPC name for a persisted config notice.
pub const EVENT_CONFIG_UPDATE: &str = "config:update";
/// Locked IPC name for capture / backend runtime status.
pub const EVENT_RUNTIME_STATUS: &str = "runtime:status";
/// Locked IPC name for a user-facing caption row.
pub const EVENT_CAPTION_UPDATE: &str = "caption:update";
/// Locked IPC name for a display-only OPEN-segment suffix.
pub const EVENT_PARTIAL_WINDOW: &str = "caption:partial-window";
/// Locked IPC name for one completed pipeline stage row.
pub const EVENT_PIPELINE_STAGE: &str = "pipeline:stage";
/// Locked IPC name for an intentional drop / back-pressure signal.
pub const EVENT_PIPELINE_DROP: &str = "pipeline:drop";
/// Locked IPC name for model-download byte progress.
pub const EVENT_MODEL_DOWNLOAD_PROGRESS: &str = "model:download:progress";
/// Locked IPC name for native updater status.
pub const EVENT_UPDATE_STATUS: &str = "update:status";
/// Locked IPC name for a deferred post-install relaunch.
pub const EVENT_UPDATE_RELAUNCH_DEFERRED: &str = "update:relaunch-deferred";

/// Failure while delivering one [`CaptionEvent`] to a [`CaptionSink`].
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EmitError {
    /// The in-memory recording lock was poisoned by a previous panic.
    #[error("caption sink lock was poisoned")]
    LockPoisoned,
    /// Every broadcast receiver has been dropped.
    #[error("caption sink has no remaining receivers")]
    Disconnected,
}

/// Identifying slice of a config save, carried on `config:update`.
///
/// This is intentionally not the full desktop `AppConfig`. Overlay, audio,
/// endpoint, and rescore fields stay in core until that type is extracted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdate {
    pub schema_version: u8,
    pub recognition_mode: String,
    pub source_language: String,
    pub target_language: String,
}

/// Capture and backend health snapshot carried on `runtime:status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub status: String,
    pub platform: String,
    pub backend_reachable: bool,
    pub native_output: String,
    pub last_error: Option<String>,
}

/// User-facing caption row carried on `caption:update`.
///
/// Field names match the camelCase wire payload the desktop frontend already
/// listens for. Optional overlay-only hints are omitted until a consumer needs
/// them on this bus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionUpdate {
    pub id: String,
    pub source_text: String,
    pub translation_text: String,
    pub source_language: String,
    pub target_language: String,
    pub started_at: u64,
    pub received_at: u64,
    pub stage: String,
    pub sequence: u16,
    pub is_final: bool,
    pub confidence: Option<f32>,
}

/// Display-only OPEN-segment suffix carried on `caption:partial-window`.
///
/// This must not enter source/translation merge. The bus only forwards it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialWindow {
    pub session_id: String,
    pub turn_session_id: u64,
    pub turn_id: u64,
    pub segment_id: u64,
    pub revision: u64,
    pub output_sequence: u64,
    pub relay_sequence: u64,
    pub text: String,
    pub capture_generation: Option<u64>,
}

/// One completed ASR / normalize / translate row carried on `pipeline:stage`.
///
/// Desktop tags the live event with `captureGeneration` so a debug consumer can
/// tell a stale session's row apart from the current one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStage {
    pub capture_generation: u64,
    pub stage: String,
    pub utterance_id: String,
    pub model_id: String,
    pub input_snippet: String,
    pub output_text: String,
    pub started_at: u64,
    pub at: u64,
    pub duration_ms: u64,
    pub ok: bool,
    pub error: Option<String>,
}

/// Intentional drop / back-pressure signal carried on `pipeline:drop`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDrop {
    pub source: String,
    pub reason: String,
    pub count: u64,
}

/// Model-download byte progress carried on `model:download:progress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
    pub speed_bps: u64,
    pub elapsed_ms: u64,
}

/// Optional updater metadata nested under [`UpdateStatus`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub target: Option<String>,
    pub source: Option<String>,
    pub channel: Option<String>,
}

/// Native updater snapshot carried on `update:status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub status: String,
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    pub checked_at: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub source: Option<String>,
    pub channel: Option<String>,
    pub switch_result: Option<String>,
    pub relaunch_deferred: Option<bool>,
    pub metadata: Option<UpdateMetadata>,
}

/// Deferred post-install relaunch notice carried on `update:relaunch-deferred`.
///
/// Desktop currently emits the string `"capture-active"`. The structured form
/// keeps that reason without inventing extra fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelaunchDeferred {
    pub reason: String,
}

/// Every event the caption bus can deliver.
///
/// Variant names are stable for adapters. Wire names live in [`CaptionEvent::name`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CaptionEvent {
    ConfigUpdate(ConfigUpdate),
    RuntimeStatus(RuntimeStatus),
    CaptionUpdate(CaptionUpdate),
    PartialWindow(PartialWindow),
    PipelineStage(PipelineStage),
    PipelineDrop(PipelineDrop),
    ModelDownloadProgress(ModelDownloadProgress),
    UpdateStatus(UpdateStatus),
    UpdateRelaunchDeferred(UpdateRelaunchDeferred),
}

/// Framework-agnostic emit target.
///
/// Tauri will implement this with `Emitter`. GPUI will push into its model.
/// This crate only defines the contract.
pub trait CaptionSink {
    fn emit(&self, event: CaptionEvent) -> Result<(), EmitError>;
}

/// In-memory sink that records every event in order.
///
/// Intended for tests and for a GPUI model that wants a replayable log.
#[derive(Debug, Clone, Default)]
pub struct RecordingSink {
    events: Arc<Mutex<Vec<CaptionEvent>>>,
}

/// Multi-producer broadcast sink backed by `std::sync::mpsc`.
///
/// Clone the sink to share the sender. Dropping every [`Receiver`] makes the
/// next [`CaptionSink::emit`] return [`EmitError::Disconnected`].
#[derive(Debug, Clone)]
pub struct BroadcastSink {
    sender: Sender<CaptionEvent>,
}

impl CaptionEvent {
    /// Locked IPC name for this variant.
    pub fn name(&self) -> &'static str {
        match self {
            Self::ConfigUpdate(_) => EVENT_CONFIG_UPDATE,
            Self::RuntimeStatus(_) => EVENT_RUNTIME_STATUS,
            Self::CaptionUpdate(_) => EVENT_CAPTION_UPDATE,
            Self::PartialWindow(_) => EVENT_PARTIAL_WINDOW,
            Self::PipelineStage(_) => EVENT_PIPELINE_STAGE,
            Self::PipelineDrop(_) => EVENT_PIPELINE_DROP,
            Self::ModelDownloadProgress(_) => EVENT_MODEL_DOWNLOAD_PROGRESS,
            Self::UpdateStatus(_) => EVENT_UPDATE_STATUS,
            Self::UpdateRelaunchDeferred(_) => EVENT_UPDATE_RELAUNCH_DEFERRED,
        }
    }
}

impl RecordingSink {
    /// Empty recording sink.
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of events received so far, oldest first.
    pub fn recorded(&self) -> Result<Vec<CaptionEvent>, EmitError> {
        recorded_snapshot(&self.events)
    }
}

impl CaptionSink for RecordingSink {
    fn emit(&self, event: CaptionEvent) -> Result<(), EmitError> {
        record_event(&self.events, event)
    }
}

impl BroadcastSink {
    /// Create a connected sender / receiver pair.
    pub fn channel() -> (Self, Receiver<CaptionEvent>) {
        let (sender, receiver) = mpsc::channel();
        (Self { sender }, receiver)
    }
}

impl CaptionSink for BroadcastSink {
    fn emit(&self, event: CaptionEvent) -> Result<(), EmitError> {
        send_broadcast(&self.sender, event)
    }
}

fn recorded_snapshot(events: &Mutex<Vec<CaptionEvent>>) -> Result<Vec<CaptionEvent>, EmitError> {
    let guard = events.lock().map_err(|_| EmitError::LockPoisoned)?;
    Ok(guard.clone())
}

fn record_event(events: &Mutex<Vec<CaptionEvent>>, event: CaptionEvent) -> Result<(), EmitError> {
    let mut guard = events.lock().map_err(|_| EmitError::LockPoisoned)?;
    guard.push(event);
    Ok(())
}

fn send_broadcast(sender: &Sender<CaptionEvent>, event: CaptionEvent) -> Result<(), EmitError> {
    sender.send(event).map_err(emit_error_from_send)
}

fn emit_error_from_send(_error: SendError<CaptionEvent>) -> EmitError {
    EmitError::Disconnected
}

#[cfg(test)]
mod tests {
    use super::BroadcastSink;
    use super::CaptionEvent;
    use super::CaptionSink;
    use super::CaptionUpdate;
    use super::ConfigUpdate;
    use super::EmitError;
    use super::ModelDownloadProgress;
    use super::PartialWindow;
    use super::PipelineDrop;
    use super::PipelineStage;
    use super::RecordingSink;
    use super::RuntimeStatus;
    use super::UpdateMetadata;
    use super::UpdateRelaunchDeferred;
    use super::UpdateStatus;

    #[test]
    fn config_update_name_is_locked_string() {
        let event = CaptionEvent::ConfigUpdate(ConfigUpdate {
            schema_version: 2,
            recognition_mode: String::from("web-speech"),
            source_language: String::from("ja"),
            target_language: String::from("en"),
        });
        assert_eq!(event.name(), "config:update");
    }

    #[test]
    fn runtime_status_name_is_locked_string() {
        let event = CaptionEvent::RuntimeStatus(RuntimeStatus {
            status: String::from("capturing"),
            platform: String::from("macos"),
            backend_reachable: true,
            native_output: String::from("syphon"),
            last_error: None,
        });
        assert_eq!(event.name(), "runtime:status");
    }

    #[test]
    fn caption_update_name_is_locked_string() {
        let event = CaptionEvent::CaptionUpdate(CaptionUpdate {
            id: String::from("cap-1"),
            source_text: String::from("こんにちは"),
            translation_text: String::from("hello"),
            source_language: String::from("ja"),
            target_language: String::from("en"),
            started_at: 1,
            received_at: 2,
            stage: String::from("source"),
            sequence: 0,
            is_final: true,
            confidence: None,
        });
        assert_eq!(event.name(), "caption:update");
    }

    #[test]
    fn partial_window_name_is_locked_string() {
        let event = CaptionEvent::PartialWindow(PartialWindow {
            session_id: String::from("sess-1"),
            turn_session_id: 1,
            turn_id: 2,
            segment_id: 3,
            revision: 4,
            output_sequence: 5,
            relay_sequence: 6,
            text: String::from("途中"),
            capture_generation: Some(7),
        });
        assert_eq!(event.name(), "caption:partial-window");
    }

    #[test]
    fn pipeline_stage_name_is_locked_string() {
        let event = CaptionEvent::PipelineStage(PipelineStage {
            capture_generation: 9,
            stage: String::from("asr"),
            utterance_id: String::from("utt-1"),
            model_id: String::from("parapper-ja"),
            input_snippet: String::from("wavBytes=12"),
            output_text: String::from("あ"),
            started_at: 10,
            at: 20,
            duration_ms: 10,
            ok: true,
            error: None,
        });
        assert_eq!(event.name(), "pipeline:stage");
    }

    #[test]
    fn pipeline_drop_name_is_locked_string() {
        let event = CaptionEvent::PipelineDrop(PipelineDrop {
            source: String::from("translation"),
            reason: String::from("retired"),
            count: 1,
        });
        assert_eq!(event.name(), "pipeline:drop");
    }

    #[test]
    fn model_download_progress_name_is_locked_string() {
        let event = CaptionEvent::ModelDownloadProgress(ModelDownloadProgress {
            model_id: String::from("parapper-ja"),
            downloaded_bytes: 50,
            total_bytes: 100,
            percent: 50,
            speed_bps: 10,
            elapsed_ms: 1_000,
        });
        assert_eq!(event.name(), "model:download:progress");
    }

    #[test]
    fn update_status_name_is_locked_string() {
        let event = CaptionEvent::UpdateStatus(UpdateStatus {
            status: String::from("idle"),
            current_version: Some(String::from("0.1.0")),
            available_version: None,
            checked_at: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            source: None,
            channel: Some(String::from("stable")),
            switch_result: None,
            relaunch_deferred: Some(false),
            metadata: None,
        });
        assert_eq!(event.name(), "update:status");
    }

    #[test]
    fn update_relaunch_deferred_name_is_locked_string() {
        let event = CaptionEvent::UpdateRelaunchDeferred(UpdateRelaunchDeferred {
            reason: String::from("capture-active"),
        });
        assert_eq!(event.name(), "update:relaunch-deferred");
    }

    #[test]
    fn recording_sink_records_events_in_order() {
        let sink = RecordingSink::new();
        sink.emit(CaptionEvent::ConfigUpdate(ConfigUpdate {
            schema_version: 2,
            recognition_mode: String::from("parapper-azookey"),
            source_language: String::from("ja"),
            target_language: String::from("en"),
        }))
        .expect("config emit");
        sink.emit(CaptionEvent::CaptionUpdate(CaptionUpdate {
            id: String::from("cap-2"),
            source_text: String::from("はい"),
            translation_text: String::from(""),
            source_language: String::from("ja"),
            target_language: String::from("en"),
            started_at: 3,
            received_at: 4,
            stage: String::from("source"),
            sequence: 0,
            is_final: false,
            confidence: Some(0.9),
        }))
        .expect("caption emit");
        sink.emit(CaptionEvent::PipelineDrop(PipelineDrop {
            source: String::from("audio"),
            reason: String::from("silence-gate"),
            count: 2,
        }))
        .expect("drop emit");

        let recorded = sink.recorded().expect("recorded snapshot");
        assert_eq!(recorded.len(), 3);
        assert_eq!(recorded[0].name(), "config:update");
        assert_eq!(recorded[1].name(), "caption:update");
        assert_eq!(recorded[2].name(), "pipeline:drop");
        assert_eq!(
            recorded[0],
            CaptionEvent::ConfigUpdate(ConfigUpdate {
                schema_version: 2,
                recognition_mode: String::from("parapper-azookey"),
                source_language: String::from("ja"),
                target_language: String::from("en"),
            })
        );
        assert_eq!(
            recorded[2],
            CaptionEvent::PipelineDrop(PipelineDrop {
                source: String::from("audio"),
                reason: String::from("silence-gate"),
                count: 2,
            })
        );
    }

    #[test]
    fn caption_update_serde_round_trip() {
        let original = CaptionUpdate {
            id: String::from("cap-round"),
            source_text: String::from("東京"),
            translation_text: String::from("Tokyo"),
            source_language: String::from("ja"),
            target_language: String::from("en"),
            started_at: 100,
            received_at: 200,
            stage: String::from("translation"),
            sequence: 1,
            is_final: true,
            confidence: Some(1.0),
        };
        let json = serde_json::to_string(&original).expect("serialize caption");
        let decoded: CaptionUpdate = serde_json::from_str(&json).expect("deserialize caption");
        assert_eq!(
            decoded,
            CaptionUpdate {
                id: String::from("cap-round"),
                source_text: String::from("東京"),
                translation_text: String::from("Tokyo"),
                source_language: String::from("ja"),
                target_language: String::from("en"),
                started_at: 100,
                received_at: 200,
                stage: String::from("translation"),
                sequence: 1,
                is_final: true,
                confidence: Some(1.0),
            }
        );
        let value: serde_json::Value = serde_json::from_str(&json).expect("caption json object");
        assert_eq!(value["id"], "cap-round");
        assert_eq!(value["sourceText"], "東京");
        assert_eq!(value["translationText"], "Tokyo");
        assert_eq!(value["sourceLanguage"], "ja");
        assert_eq!(value["targetLanguage"], "en");
        assert_eq!(value["startedAt"], 100);
        assert_eq!(value["receivedAt"], 200);
        assert_eq!(value["stage"], "translation");
        assert_eq!(value["sequence"], 1);
        assert_eq!(value["isFinal"], true);
        assert_eq!(value["confidence"], 1.0);
    }

    #[test]
    fn pipeline_drop_serde_round_trip() {
        let original = PipelineDrop {
            source: String::from("chunk-queue"),
            reason: String::from("pending-replaced"),
            count: 4,
        };
        let json = serde_json::to_string(&original).expect("serialize drop");
        let decoded: PipelineDrop = serde_json::from_str(&json).expect("deserialize drop");
        assert_eq!(
            decoded,
            PipelineDrop {
                source: String::from("chunk-queue"),
                reason: String::from("pending-replaced"),
                count: 4,
            }
        );
        let value: serde_json::Value = serde_json::from_str(&json).expect("drop json object");
        assert_eq!(value["source"], "chunk-queue");
        assert_eq!(value["reason"], "pending-replaced");
        assert_eq!(value["count"], 4);
    }

    #[test]
    fn broadcast_sink_delivers_one_event() {
        let (sink, receiver) = BroadcastSink::channel();
        sink.emit(CaptionEvent::UpdateRelaunchDeferred(UpdateRelaunchDeferred {
            reason: String::from("capture-active"),
        }))
        .expect("broadcast emit");
        let received = receiver.recv().expect("broadcast recv");
        assert_eq!(received.name(), "update:relaunch-deferred");
        assert_eq!(
            received,
            CaptionEvent::UpdateRelaunchDeferred(UpdateRelaunchDeferred {
                reason: String::from("capture-active"),
            })
        );
    }

    #[test]
    fn broadcast_sink_reports_disconnect() {
        let (sink, receiver) = BroadcastSink::channel();
        drop(receiver);
        let error = sink
            .emit(CaptionEvent::PipelineDrop(PipelineDrop {
                source: String::from("parapper-output-queue"),
                reason: String::from("stale-final-cursor"),
                count: 3,
            }))
            .expect_err("disconnected sink");
        assert_eq!(error, EmitError::Disconnected);
        assert_eq!(error.to_string(), "caption sink has no remaining receivers");
    }

    #[test]
    fn emit_error_lock_poisoned_display_is_stable() {
        assert_eq!(EmitError::LockPoisoned.to_string(), "caption sink lock was poisoned");
    }

    #[test]
    fn remaining_payloads_round_trip_through_json() {
        let status = RuntimeStatus {
            status: String::from("error"),
            platform: String::from("windows"),
            backend_reachable: false,
            native_output: String::from("spout2"),
            last_error: Some(String::from("backend down")),
        };
        let status_json = serde_json::to_string(&status).expect("serialize status");
        let status_decoded: RuntimeStatus =
            serde_json::from_str(&status_json).expect("deserialize status");
        assert_eq!(
            status_decoded,
            RuntimeStatus {
                status: String::from("error"),
                platform: String::from("windows"),
                backend_reachable: false,
                native_output: String::from("spout2"),
                last_error: Some(String::from("backend down")),
            }
        );

        let window = PartialWindow {
            session_id: String::from("sess-2"),
            turn_session_id: 8,
            turn_id: 9,
            segment_id: 10,
            revision: 11,
            output_sequence: 12,
            relay_sequence: 13,
            text: String::from("suffix"),
            capture_generation: None,
        };
        let window_json = serde_json::to_string(&window).expect("serialize window");
        let window_decoded: PartialWindow =
            serde_json::from_str(&window_json).expect("deserialize window");
        assert_eq!(
            window_decoded,
            PartialWindow {
                session_id: String::from("sess-2"),
                turn_session_id: 8,
                turn_id: 9,
                segment_id: 10,
                revision: 11,
                output_sequence: 12,
                relay_sequence: 13,
                text: String::from("suffix"),
                capture_generation: None,
            }
        );

        let stage = PipelineStage {
            capture_generation: 1,
            stage: String::from("normalize"),
            utterance_id: String::from("utt-2"),
            model_id: String::from("azookey-rust"),
            input_snippet: String::from("あ"),
            output_text: String::from("亜"),
            started_at: 30,
            at: 40,
            duration_ms: 10,
            ok: false,
            error: Some(String::from("fallback")),
        };
        let stage_json = serde_json::to_string(&stage).expect("serialize stage");
        let stage_decoded: PipelineStage =
            serde_json::from_str(&stage_json).expect("deserialize stage");
        assert_eq!(
            stage_decoded,
            PipelineStage {
                capture_generation: 1,
                stage: String::from("normalize"),
                utterance_id: String::from("utt-2"),
                model_id: String::from("azookey-rust"),
                input_snippet: String::from("あ"),
                output_text: String::from("亜"),
                started_at: 30,
                at: 40,
                duration_ms: 10,
                ok: false,
                error: Some(String::from("fallback")),
            }
        );

        let progress = ModelDownloadProgress {
            model_id: String::from("hy-mt2"),
            downloaded_bytes: 1,
            total_bytes: 2,
            percent: 50,
            speed_bps: 3,
            elapsed_ms: 4,
        };
        let progress_json = serde_json::to_string(&progress).expect("serialize progress");
        let progress_decoded: ModelDownloadProgress =
            serde_json::from_str(&progress_json).expect("deserialize progress");
        assert_eq!(
            progress_decoded,
            ModelDownloadProgress {
                model_id: String::from("hy-mt2"),
                downloaded_bytes: 1,
                total_bytes: 2,
                percent: 50,
                speed_bps: 3,
                elapsed_ms: 4,
            }
        );

        let update = UpdateStatus {
            status: String::from("available"),
            current_version: Some(String::from("1.0.0")),
            available_version: Some(String::from("1.1.0")),
            checked_at: Some(String::from("10")),
            downloaded_bytes: Some(5),
            total_bytes: Some(10),
            error: None,
            source: Some(String::from("https://example.invalid/app")),
            channel: Some(String::from("stable")),
            switch_result: None,
            relaunch_deferred: Some(true),
            metadata: Some(UpdateMetadata {
                version: String::from("1.1.0"),
                date: Some(String::from("2026-08-19")),
                body: Some(String::from("fixes")),
                target: Some(String::from("aarch64-apple-darwin")),
                source: Some(String::from("https://example.invalid/app")),
                channel: Some(String::from("stable")),
            }),
        };
        let update_json = serde_json::to_string(&update).expect("serialize update");
        let update_decoded: UpdateStatus =
            serde_json::from_str(&update_json).expect("deserialize update");
        assert_eq!(
            update_decoded,
            UpdateStatus {
                status: String::from("available"),
                current_version: Some(String::from("1.0.0")),
                available_version: Some(String::from("1.1.0")),
                checked_at: Some(String::from("10")),
                downloaded_bytes: Some(5),
                total_bytes: Some(10),
                error: None,
                source: Some(String::from("https://example.invalid/app")),
                channel: Some(String::from("stable")),
                switch_result: None,
                relaunch_deferred: Some(true),
                metadata: Some(UpdateMetadata {
                    version: String::from("1.1.0"),
                    date: Some(String::from("2026-08-19")),
                    body: Some(String::from("fixes")),
                    target: Some(String::from("aarch64-apple-darwin")),
                    source: Some(String::from("https://example.invalid/app")),
                    channel: Some(String::from("stable")),
                }),
            }
        );
    }
}
