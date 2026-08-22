//! Headless live-caption session for a future GPUI app.
//!
//! Construction does not spawn sidecars, open a microphone, or create an
//! NSWindow. The proven vertical is [`CaptionSession::ingest_parapper_json`]:
//! parse a Parapper frame, queue it, merge/display/layout, emit a
//! `caption:update`, and rasterize an RGBA overlay buffer.

#![forbid(unsafe_code)]

use caption_bridge_captions::display::{create_empty_caption, sanitize_caption_display_text};
use caption_bridge_captions::layout::{
    caption_items, caption_text_lines, CaptionLayoutConfig, CaptionOrder as LayoutOrder,
};
use caption_bridge_captions::merge::merge_caption_payload;
use caption_bridge_captions::paging::{apply_overlay_sticky_display, OverlayStickyRefs};
use caption_bridge_captions::{CaptionPayload, CaptionRowKey, CaptionStage};
use caption_bridge_events::{CaptionEvent, CaptionSink, CaptionUpdate, EmitError, RecordingSink};
use caption_bridge_identity::{AppIdentity, Flavor};
use caption_bridge_parapper::queue::QueuedOutput;
use caption_bridge_parapper::{
    parse_server_frame, OutputQueue, QueueDecision, ServerEvent, TurnOutput,
};
use caption_bridge_render::{
    rasterize, CaptionFrame, CaptionOrder as RenderOrder, CaptionStyle, OverlayGeometry, RgbaImage,
};
use caption_bridge_sidecar::PortMap;
use thiserror::Error;

/// Default overlay width matching the rasterizer and overlay crates.
pub const DEFAULT_OVERLAY_WIDTH: u32 = 1_280;
/// Default overlay height matching the rasterizer and overlay crates.
pub const DEFAULT_OVERLAY_HEIGHT: u32 = 720;
const DEFAULT_TARGET_LANGUAGE: &str = "en";
const CAPTION_STAGE_SOURCE: &str = "source";
const CAPTION_STAGE_TRANSLATION: &str = "translation";

/// Failure while ingesting a Parapper JSON frame into the live session.
#[derive(Debug, Error)]
pub enum SessionError {
    /// The JSON was not a valid Parapper protocol v1 frame.
    #[error("invalid Parapper frame: {0}")]
    Protocol(#[from] caption_bridge_parapper::ProtocolError),
    /// The recording or broadcast sink rejected the caption event.
    #[error("caption sink failed: {0}")]
    Sink(#[from] EmitError),
}

/// Product flavor plus overlay geometry and style defaults.
///
/// [`SessionConfig::native`] binds [`PortMap::native`] and
/// [`AppIdentity::native`]. Construction never starts a sidecar.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub flavor: Flavor,
    pub identity: AppIdentity,
    pub ports: PortMap,
    pub overlay_geometry: OverlayGeometry,
    pub layout: CaptionLayoutConfig,
}

/// Headless live-caption session object a GPUI app can call.
///
/// Sidecars, the microphone, and `OverlayWindow` stay optional. Tests and a
/// future GUI both drive the same ingest path.
pub struct CaptionSession {
    config: SessionConfig,
    queue: OutputQueue,
    live: CaptionPayload,
    sticky: OverlayStickyRefs,
    sink: RecordingSink,
}

impl SessionConfig {
    /// Native (GPUI) identity: native ports and native bundle id.
    pub fn native() -> Self {
        Self::for_identity(AppIdentity::native(), PortMap::native())
    }

    /// Tauri desktop identity. Available so a caller can compare flavors.
    pub fn tauri() -> Self {
        Self::for_identity(AppIdentity::tauri(), PortMap::tauri())
    }

    fn for_identity(identity: AppIdentity, ports: PortMap) -> Self {
        Self {
            flavor: identity.flavor,
            identity,
            ports,
            overlay_geometry: OverlayGeometry {
                width: DEFAULT_OVERLAY_WIDTH,
                height: DEFAULT_OVERLAY_HEIGHT,
                caption_x_percent: 50.0,
                caption_y_percent: 88.0,
                safe_area_px: 42.0,
                gap_px: 14.0,
                order: RenderOrder::SourceFirst,
                source: CaptionStyle::default_source(),
                translation: CaptionStyle::default_translation(),
            },
            layout: CaptionLayoutConfig {
                order: LayoutOrder::SourceFirst,
                source_max_chars: caption_bridge_captions::layout::SOURCE_CAPTION_MAX_CHARS,
                translation_max_chars:
                    caption_bridge_captions::layout::TRANSLATION_CAPTION_MAX_CHARS,
            },
        }
    }
}

impl CaptionSession {
    /// Build a session from config without spawning sidecars or opening a window.
    pub fn new(config: SessionConfig) -> Self {
        Self {
            config,
            queue: OutputQueue::new(),
            live: create_empty_caption(),
            sticky: OverlayStickyRefs::default(),
            sink: RecordingSink::new(),
        }
    }

    /// Native session with default overlay geometry and style.
    pub fn native() -> Self {
        Self::new(SessionConfig::native())
    }

    /// Immutable session configuration.
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    /// In-memory event log filled by ingest.
    pub fn sink(&self) -> &RecordingSink {
        &self.sink
    }

    /// Current merged caption after the last accepted turn.
    pub fn live_caption(&self) -> &CaptionPayload {
        &self.live
    }

    /// Replace overlay geometry and line budgets used by the next rasterize.
    pub fn apply_style(&mut self, geometry: OverlayGeometry, layout: CaptionLayoutConfig) {
        self.config.overlay_geometry = geometry;
        self.config.layout = layout;
    }

    /// Rasterize the current live caption with the session style.
    pub fn rasterize_overlay(&self) -> RgbaImage {
        self.rasterize_live()
    }

    /// Parse one Parapper JSON frame, queue it, merge/display/layout, emit, and
    /// rasterize. Control frames return `Ok(None)`. Turn frames that the queue
    /// drops also return `Ok(None)`.
    pub fn ingest_parapper_json(
        &mut self,
        json: &str,
        now_ms: u64,
    ) -> Result<Option<RgbaImage>, SessionError> {
        let event = parse_server_frame(json)?;
        let Some((output, is_final)) = turn_from_server_event(event) else {
            return Ok(None);
        };
        if !matches!(
            self.queue.enqueue(QueuedOutput { output, is_final }),
            QueueDecision::Accepted(_)
        ) {
            return Ok(None);
        }
        let mut image = None;
        while let Some(item) = self.queue.pop_next() {
            image = Some(self.apply_queued_output(&item, now_ms)?);
            self.queue.complete_current();
        }
        Ok(image)
    }

    fn apply_queued_output(
        &mut self,
        item: &QueuedOutput,
        now_ms: u64,
    ) -> Result<RgbaImage, SessionError> {
        let incoming = payload_from_turn(&item.output, item.is_final, now_ms);
        let merged =
            merge_caption_payload(&self.live, &incoming).unwrap_or_else(|| incoming.clone());
        let displayed = apply_overlay_sticky_display(&merged, &mut self.sticky);
        self.live = displayed;
        self.emit_caption_update(now_ms)?;
        Ok(self.rasterize_live())
    }

    fn emit_caption_update(&self, now_ms: u64) -> Result<(), SessionError> {
        let stage = match self.live.stage {
            Some(CaptionStage::Translation) => CAPTION_STAGE_TRANSLATION,
            Some(CaptionStage::Source) | None => CAPTION_STAGE_SOURCE,
        };
        let sequence = u16::try_from(self.live.sequence.unwrap_or(0)).unwrap_or(0);
        self.sink.emit(CaptionEvent::CaptionUpdate(CaptionUpdate {
            id: self.live.id.clone(),
            source_text: self.live.source_text.clone(),
            translation_text: self.live.translation_text.clone(),
            source_language: self.live.source_language.clone(),
            target_language: self.live.target_language.clone(),
            started_at: i64_to_u64(self.live.started_at),
            received_at: now_ms,
            stage: stage.to_string(),
            sequence,
            is_final: self.live.is_final_true(),
            confidence: None,
        }))?;
        Ok(())
    }

    fn rasterize_live(&self) -> RgbaImage {
        let items = caption_items(&self.config.layout, &self.live, false, "");
        let source_text = items
            .iter()
            .find(|item| item.key == CaptionRowKey::Source)
            .map(|item| caption_text_lines(item).join("\n"))
            .unwrap_or_else(|| sanitize_caption_display_text(&self.live.source_text));
        let translation_text = items
            .iter()
            .find(|item| item.key == CaptionRowKey::Translation)
            .map(|item| caption_text_lines(item).join("\n"))
            .unwrap_or_else(|| sanitize_caption_display_text(&self.live.translation_text));
        rasterize(
            &self.config.overlay_geometry,
            &CaptionFrame {
                source: source_text,
                translation: translation_text,
                partial: String::new(),
            },
        )
    }
}

fn turn_from_server_event(event: ServerEvent) -> Option<(TurnOutput, bool)> {
    match event {
        ServerEvent::TurnFinal(output) => Some((output, true)),
        ServerEvent::TurnPartial(output) | ServerEvent::TurnPartialWindow(output) => {
            Some((output, false))
        }
        ServerEvent::SessionReady { .. }
        | ServerEvent::SpeechStarted { .. }
        | ServerEvent::SegmentClosed { .. }
        | ServerEvent::SessionDone { .. }
        | ServerEvent::SessionCancelled { .. }
        | ServerEvent::Pong { .. }
        | ServerEvent::Error { .. } => None,
    }
}

fn payload_from_turn(output: &TurnOutput, is_final: bool, now_ms: u64) -> CaptionPayload {
    let source_text = output
        .source_text
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or(output.text.as_str())
        .to_string();
    let started_at =
        output.latency.speech_start_at.or(output.latency.speech_start).unwrap_or(now_ms);
    CaptionPayload {
        id: format!("parapper:{}:{}:{}", output.session_id, output.turn_session_id, output.turn_id),
        source_text,
        azookey_input_text: output.azookey_input_text.clone(),
        translation_text: String::new(),
        source_language: output.source_language.clone(),
        target_language: DEFAULT_TARGET_LANGUAGE.to_string(),
        started_at: u64_to_i64(started_at),
        received_at: u64_to_i64(now_ms),
        stage: Some(CaptionStage::Source),
        sequence: Some(0),
        is_final: Some(is_final),
        provisional: Some(!is_final),
        capture_generation: None,
        sentence_end_offsets: None,
        soft_break_offsets: None,
    }
}

fn u64_to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn i64_to_u64(value: i64) -> u64 {
    u64::try_from(value.max(0)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{CaptionSession, SessionConfig, DEFAULT_OVERLAY_HEIGHT, DEFAULT_OVERLAY_WIDTH};
    use caption_bridge_events::{CaptionEvent, EVENT_CAPTION_UPDATE};
    use caption_bridge_identity::Flavor;
    use caption_bridge_parapper::recognition_url;
    use caption_bridge_sidecar::PortMap;

    const FINAL_JSON_FIXTURE: &str = r#"{"version":1,"type":"turn.final","session_id":"fixture-session","turn_session_id":7,"turn_id":3,"revision":2,"output_sequence":2,"segment_id":8,"previous_segment_id":7,"text":"こんにちは。","source_asr_model":"reazonspeech_k2_v2","source_language":"ja","detected_language":null,"audio_duration_ms":1280,"elapsed_ms":96}"#;

    #[test]
    fn native_config_uses_native_ports_and_bundle_id() {
        let config = SessionConfig::native();
        assert_eq!(config.flavor, Flavor::Native);
        assert_eq!(config.identity.bundle_id, "com.kotobabeacon.native");
        assert_eq!(config.identity.product_name, "Kotoba Beacon Native");
        assert_eq!(config.ports, PortMap::native());
        assert_eq!(config.ports.gateway, 8865);
        assert_eq!(config.ports.parapper, 18_182);
        assert_eq!(config.ports.zenz_xsmall, 8181);
        assert_eq!(config.ports.zenz_small, 8182);
        assert_eq!(config.ports.llama_1_8b, 8183);
        assert_eq!(config.ports.llama_7b, 8186);
        assert_eq!(config.ports.browser_source, 1521);
        assert_eq!(config.overlay_geometry.width, 1280);
        assert_eq!(config.overlay_geometry.height, 720);
        assert_eq!(recognition_url(config.ports.parapper), "ws://127.0.0.1:18182/ws/recognition");
    }

    #[test]
    fn constructs_without_spawning_sidecars() {
        let session = CaptionSession::native();
        assert_eq!(session.config().identity.bundle_id, "com.kotobabeacon.native");
        assert_eq!(session.config().ports.parapper, 18182);
        assert_eq!(session.live_caption().id, "empty");
        assert!(session.sink().recorded().expect("empty sink").is_empty());
    }

    #[test]
    fn ingest_final_fixture_rasterizes_configured_buffer() {
        let mut session = CaptionSession::native();
        let image = session
            .ingest_parapper_json(FINAL_JSON_FIXTURE, 1_700_000_000_000)
            .expect("fixture must parse")
            .expect("final turn must produce a frame");
        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
        assert_eq!(image.stride, 1280 * 4);
        assert_eq!(image.pixels.len(), 1280 * 720 * 4);
        assert_eq!(DEFAULT_OVERLAY_WIDTH, 1280);
        assert_eq!(DEFAULT_OVERLAY_HEIGHT, 720);
        assert_eq!(session.live_caption().source_text, "こんにちは。");
        assert_eq!(session.live_caption().is_final, Some(true));
        assert_eq!(session.live_caption().id, "parapper:fixture-session:7:3");
    }

    #[test]
    fn ingest_final_fixture_emits_caption_update() {
        let mut session = CaptionSession::native();
        let _image = session
            .ingest_parapper_json(FINAL_JSON_FIXTURE, 42)
            .expect("fixture must parse")
            .expect("final turn must produce a frame");
        let recorded = session.sink().recorded().expect("recorded events");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].name(), "caption:update");
        assert_eq!(EVENT_CAPTION_UPDATE, "caption:update");
        let CaptionEvent::CaptionUpdate(update) = &recorded[0] else {
            panic!("expected caption:update");
        };
        assert_eq!(update.id, "parapper:fixture-session:7:3");
        assert_eq!(update.source_text, "こんにちは。");
        assert_eq!(update.translation_text, "");
        assert_eq!(update.source_language, "ja");
        assert_eq!(update.target_language, "en");
        assert_eq!(update.started_at, 42);
        assert_eq!(update.received_at, 42);
        assert_eq!(update.stage, "source");
        assert_eq!(update.sequence, 0);
        assert_eq!(update.is_final, true);
        assert_eq!(update.confidence, None);
    }

    #[test]
    fn control_frame_does_not_emit_or_rasterize() {
        let mut session = CaptionSession::native();
        let image = session
            .ingest_parapper_json(
                r#"{"version":1,"type":"session.ready","session_id":"s","capabilities":{"partial":true}}"#,
                10,
            )
            .expect("ready frame is valid");
        assert!(image.is_none());
        assert!(session.sink().recorded().expect("empty after control").is_empty());
        assert_eq!(session.live_caption().id, "empty");
    }

    #[test]
    fn invalid_json_is_a_session_error() {
        let mut session = CaptionSession::native();
        let error = session.ingest_parapper_json("{", 1).expect_err("invalid json");
        assert!(error.to_string().contains("invalid Parapper frame"));
    }

    #[test]
    fn apply_style_updates_geometry_used_by_rasterize_overlay() {
        let mut session = CaptionSession::native();
        let _image = session
            .ingest_parapper_json(FINAL_JSON_FIXTURE, 1_700_000_000_000)
            .expect("fixture must parse")
            .expect("final turn must produce a frame");
        let mut geometry = session.config().overlay_geometry.clone();
        geometry.caption_x_percent = 20.0;
        geometry.caption_y_percent = 30.0;
        let mut layout = session.config().layout.clone();
        layout.source_max_chars = 12;
        session.apply_style(geometry, layout);
        assert_eq!(session.config().overlay_geometry.caption_x_percent, 20.0);
        assert_eq!(session.config().overlay_geometry.caption_y_percent, 30.0);
        assert_eq!(session.config().layout.source_max_chars, 12);
        let image = session.rasterize_overlay();
        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
    }
}
