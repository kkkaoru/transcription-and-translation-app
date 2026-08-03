use crate::config::AppConfig;
use crate::native_output::NativeOutputHandle;
use crate::output::OutputStatus;
use crate::pipeline::{CaptionPayload, Pipeline, PipelineStageEvent};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Number of completed pipeline stages retained for diagnostics.
///
/// `pipeline:stage` is an ephemeral Tauri event. Keeping a bounded native
/// ring buffer means the Debug panel can recover stages that completed before
/// it subscribed (and keeps diagnostics from growing without bound during a
/// long capture session).
pub const PIPELINE_STAGE_HISTORY_LIMIT: usize = 96;

/// A Parapper stream only yields turn output after its VAD has identified
/// speech. A few empty turn outputs can still be legitimate revisions, but a
/// run of them is a useful signal that recognition has stopped producing
/// transcripts. Keep the observation bounded so an old turn cannot poison a
/// later capture session.
pub const ASR_EMPTY_RESULT_LIMIT: u8 = 3;
pub const ASR_EMPTY_RESULT_WINDOW: Duration = Duration::from_secs(20);
/// Stopping capture should preserve a translation that is already nearly
/// complete, without making Stop wait for the full inference timeout.
pub const TRANSLATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Do not let a slow translator accumulate unbounded detached work during a
/// long live-capture session. Source captions stay immediate when this cap is
/// reached; only their optional background translation is skipped.
pub const MAX_PENDING_TRANSLATIONS_PER_CAPTURE: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedEmptyAsrResult {
    Transient { consecutive: u8 },
    PersistentLoss { consecutive: u8 },
}

#[derive(Debug, Default)]
struct AsrHealthTracker {
    first_empty_at: Option<Instant>,
    last_empty_turn: Option<String>,
    consecutive_empty: u8,
    persistent_loss: bool,
}

impl AsrHealthTracker {
    fn observe_expected_empty_at(&mut self, now: Instant, turn_id: &str) -> ExpectedEmptyAsrResult {
        if self.persistent_loss {
            return ExpectedEmptyAsrResult::PersistentLoss { consecutive: self.consecutive_empty };
        }
        if self
            .first_empty_at
            .is_none_or(|first| now.saturating_duration_since(first) > ASR_EMPTY_RESULT_WINDOW)
        {
            self.reset();
            self.first_empty_at = Some(now);
        }
        // A single sidecar turn can emit both an interim and final revision.
        // Count it once: repeated blank revisions of the same speech turn are
        // not evidence that three separate utterances lost transcription.
        if self.last_empty_turn.as_deref() == Some(turn_id) {
            return ExpectedEmptyAsrResult::Transient { consecutive: self.consecutive_empty };
        }
        self.last_empty_turn = Some(turn_id.to_string());
        self.consecutive_empty = self.consecutive_empty.saturating_add(1);
        if self.consecutive_empty >= ASR_EMPTY_RESULT_LIMIT {
            self.persistent_loss = true;
            ExpectedEmptyAsrResult::PersistentLoss { consecutive: self.consecutive_empty }
        } else {
            ExpectedEmptyAsrResult::Transient { consecutive: self.consecutive_empty }
        }
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranslationTicket {
    generation: u64,
    sequence: u64,
}

impl TranslationTicket {
    /// The capture generation this ticket was issued under. Exposed so a
    /// caller holding only the ticket (e.g. a spawned translation task) can
    /// tag its own diagnostics (`PipelineStageEvent`) with the generation
    /// they actually belong to, instead of re-reading whatever generation is
    /// current when the stage happens to complete.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Debug, Default)]
struct TranslationTracker {
    current_generation: u64,
    stopping_generation: Option<u64>,
    next_ticket_sequence: u64,
    pending_by_generation: HashMap<u64, VecDeque<u64>>,
    retired_count: u64,
}

impl TranslationTracker {
    fn start_capture(&mut self) {
        self.current_generation = self.current_generation.wrapping_add(1).max(1);
        self.stopping_generation = None;
        // A previous Stop may have hit its bounded wait. Those old tasks are
        // generation-invalid and no later Stop must wait on them, so discard
        // their counters rather than retaining an unbounded history.
        self.pending_by_generation.clear();
        // Retirement diagnostics describe only the active capture. A new
        // generation must not inherit drops from the previous session.
        self.retired_count = 0;
    }

    fn register(&mut self) -> Option<(TranslationTicket, Option<TranslationTicket>)> {
        if self.current_generation == 0 || self.stopping_generation == Some(self.current_generation)
        {
            return None;
        }
        let pending = self.pending_by_generation.entry(self.current_generation).or_default();
        let superseded = if pending.len() >= MAX_PENDING_TRANSLATIONS_PER_CAPTURE {
            pending
                .pop_front()
                .map(|sequence| TranslationTicket { generation: self.current_generation, sequence })
        } else {
            None
        };
        if superseded.is_some() {
            self.retired_count = self.retired_count.saturating_add(1);
        }
        self.next_ticket_sequence = self.next_ticket_sequence.wrapping_add(1).max(1);
        let ticket = TranslationTicket {
            generation: self.current_generation,
            sequence: self.next_ticket_sequence,
        };
        pending.push_back(ticket.sequence);
        Some((ticket, superseded))
    }

    fn begin_drain(&mut self) -> u64 {
        self.stopping_generation = Some(self.current_generation);
        self.current_generation
    }

    fn finish(&mut self, ticket: TranslationTicket) {
        let Some(pending) = self.pending_by_generation.get_mut(&ticket.generation) else {
            return;
        };
        let Some(index) = pending.iter().position(|sequence| *sequence == ticket.sequence) else {
            return;
        };
        pending.remove(index);
        if pending.is_empty() {
            self.pending_by_generation.remove(&ticket.generation);
        }
    }

    fn pending(&self, generation: u64) -> usize {
        self.pending_by_generation.get(&generation).map(VecDeque::len).unwrap_or_default()
    }

    fn is_current(&self, ticket: TranslationTicket) -> bool {
        self.current_generation == ticket.generation
            && self
                .pending_by_generation
                .get(&ticket.generation)
                .is_some_and(|pending| pending.contains(&ticket.sequence))
    }
}

/// A completed pipeline stage tagged with the capture generation active when
/// it was recorded.
///
/// Diagnostics must not be silently dropped merely because a capture session
/// ended: unlike a caption or a runtime status mutation (which are correctly
/// gated to the current generation only), a stage row is only ever appended
/// to a bounded history for debugging, so retaining a stale session's row
/// alongside the live one cannot mis-attribute user-facing output. Dropping
/// it instead would just be a different silent-loss bug. Tagging the row
/// with its generation preserves the diagnostic while letting a debug
/// consumer tell a stale row apart from the live session's rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedPipelineStage {
    pub capture_generation: u64,
    #[serde(flatten)]
    pub stage: PipelineStageEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub status: String,
    pub platform: String,
    pub backend_reachable: bool,
    /// Kind of the native output handle only: `spout2`, `syphon`, or
    /// `transparent-window`. This field describes the native lane and never
    /// reports the loopback OBS Browser Source fallback, which is served by
    /// `browser_source.rs` as a separate lane with its own listener state. On
    /// macOS the native Syphon lane is the primary caption path while the
    /// loopback Browser Source remains default-enabled as an OBS fallback;
    /// treat the two lanes as independent.
    pub native_output: String,
    pub last_error: Option<String>,
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Serialize config saves across the async model reconciliation and all
    /// listener/native-output replacement side effects. Without this guard, an
    /// older save can finish after a newer one and roll the app back.
    pub config_save_lock: tokio::sync::Mutex<()>,
    /// Serialize native capture start/stop commands. Both operations await
    /// sidecars or translation drains; without one lifecycle lock, an old Stop
    /// can pass its generation check and then reset a replacement Start to idle.
    pub capture_lifecycle_lock: tokio::sync::Mutex<()>,
    pub status: Mutex<RuntimeStatus>,
    pub pipeline: Pipeline,
    /// Completed ASR / normalizer / translator stages, oldest first, each
    /// tagged with the capture generation that produced it.
    pub pipeline_stage_history: Mutex<Vec<RecordedPipelineStage>>,
    /// Most recent normalized source/translation caption for overlay replay.
    /// Raw ASR text is never passed to this slot.
    pub latest_caption: Mutex<Option<CaptionPayload>>,
    pub native_output: Mutex<NativeOutputHandle>,
    /// Per-capture ASR health. This deliberately tracks only Parapper turn
    /// outputs, not ambient microphone chunks, so ordinary silence remains a
    /// soft skip while repeated empty results after VAD speech are visible.
    asr_health: Mutex<AsrHealthTracker>,
    /// Bounded in-flight translation bookkeeping. A generation prevents a
    /// late detached task from publishing into a later capture session.
    translation_tracker: Mutex<TranslationTracker>,
    translation_notify: Notify,
    /// Set when an update is ready but capture is still active. The frontend
    /// stops the microphone first; `stop_capture` then consumes this flag and
    /// requests a graceful Tauri restart.
    pub relaunch_after_capture: Mutex<bool>,
    /// Parapper turn outputs dropped because the capture generation the
    /// frontend queue (`parapper-output-queue.ts`) captured at enqueue time
    /// had already been superseded by a Stop+Start before this command
    /// processed them. Exposed in `get_debug_info` alongside
    /// `translationRetired` so a silent-loss investigation is not limited to
    /// log scraping.
    parapper_output_superseded: AtomicU64,
    /// Source captions dropped as stale: their stamped capture generation was
    /// already superseded when `publish_source_caption_gated` ran. The drop
    /// itself is silent by design, so a producer stamping a wrong generation
    /// would otherwise lose every caption with no signal; this counter makes
    /// that failure visible in `get_debug_info`.
    source_caption_stale_dropped: AtomicU64,
    /// Captions and Parapper turn outputs accepted through the legacy
    /// no-generation path. That path is deliberately never fenced (rejecting
    /// `None` would convert mis-attribution into silent caption loss, which
    /// is strictly worse), so the unfenced volume is counted instead to keep
    /// `get_debug_info` able to distinguish legacy producers from modern
    /// generation-checked ones.
    unfenced_caption_accepted: AtomicU64,
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

        // A delayed interim revision must never overwrite an already-final
        // source caption for the same Parapper turn, even when its receipt
        // timestamp happens to be newer.
        if current_sequence == 0
            && candidate_sequence == 0
            && current.stage == "source"
            && candidate.stage == "source"
            && current.is_final
            && !candidate.is_final
        {
            return true;
        }

        // Parapper partials have no measured duration and use their receipt
        // time as `started_at`; finals backdate that field by the completed
        // turn duration. A same-id source final therefore wins over its
        // non-final interim even when its timestamp is earlier. The frontend
        // merge applies the same completion precedence.
        if current_sequence == 0
            && candidate_sequence == 0
            && current.stage == "source"
            && candidate.stage == "source"
            && !current.is_final
            && candidate.is_final
        {
            return false;
        }

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
            config_save_lock: tokio::sync::Mutex::new(()),
            capture_lifecycle_lock: tokio::sync::Mutex::new(()),
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
            asr_health: Mutex::new(AsrHealthTracker::default()),
            translation_tracker: Mutex::new(TranslationTracker::default()),
            translation_notify: Notify::new(),
            relaunch_after_capture: Mutex::new(false),
            parapper_output_superseded: AtomicU64::new(0),
            source_caption_stale_dropped: AtomicU64::new(0),
            unfenced_caption_accepted: AtomicU64::new(0),
        }
    }

    /// Retain one completed stage before publishing its best-effort event.
    ///
    /// A poisoned diagnostics lock must not make transcription fail. The
    /// event stream remains best effort, while callers can still emit the
    /// `pipeline:stage` event and return a caption normally.
    pub fn record_pipeline_stage(&self, generation: u64, stage: &PipelineStageEvent) {
        let Ok(mut history) = self.pipeline_stage_history.lock() else {
            return;
        };
        history
            .push(RecordedPipelineStage { capture_generation: generation, stage: stage.clone() });
        if history.len() > PIPELINE_STAGE_HISTORY_LIMIT {
            let excess = history.len() - PIPELINE_STAGE_HISTORY_LIMIT;
            history.drain(0..excess);
        }
    }

    /// Return retained stages newest first, matching the frontend diagnostic
    /// store's snapshot order. A poisoned lock degrades to an empty snapshot.
    pub fn pipeline_stage_history(&self) -> Vec<RecordedPipelineStage> {
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

    /// Begin a fresh bounded observation window for a capture session.
    pub fn reset_asr_health(&self) {
        if let Ok(mut health) = self.asr_health.lock() {
            health.reset();
        }
    }

    /// A displayable ASR result is the only event that clears persistent
    /// transcript loss. Ambient silence must never make a degraded ASR state
    /// look healthy again.
    pub fn record_asr_success(&self) {
        self.reset_asr_health();
    }

    /// Snapshot the capture generation at the beginning of asynchronous ASR
    /// work. A later start increments it, so delayed work cannot make the new
    /// capture look healthy or overwrite its source caption.
    pub fn current_capture_generation(&self) -> u64 {
        self.translation_tracker
            .lock()
            .map(|tracker| tracker.current_generation)
            .unwrap_or_default()
    }

    pub fn is_capture_generation_current(&self, generation: u64) -> bool {
        self.translation_tracker
            .lock()
            .map(|tracker| generation_is_current(&tracker, generation))
            .unwrap_or(false)
    }

    /// Apply a transcription/normalizer failure to runtime status only when
    /// `generation` is still the active capture generation.
    ///
    /// Lock order: `translation_tracker` then `status` (never reverse). Holding
    /// the tracker lock while mutating status makes the generation check atomic
    /// with the write because `begin_capture_generation` needs the same tracker
    /// lock to bump the generation.
    pub fn apply_transcription_error_for_generation(
        &self,
        generation: u64,
        detail: &str,
    ) -> Option<RuntimeStatus> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        let mut status = self.status.lock().ok()?;
        if status.status == "idle" {
            return None;
        }
        if status.status != "starting" {
            status.status = "capturing".to_string();
        }
        status.backend_reachable = false;
        status.last_error = Some(detail.to_string());
        Some(status.clone())
    }

    /// Mark the sidecar healthy for a still-current capture generation.
    /// Returns a status snapshot only when a visible field changed.
    ///
    /// Lock order: `translation_tracker`, then `status`, then `asr_health`.
    pub fn mark_backend_healthy_for_generation(&self, generation: u64) -> Option<RuntimeStatus> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        let mut status = self.status.lock().ok()?;
        if !capture_status_is_active(status.status.as_str()) {
            return None;
        }
        // Success is generation-scoped: only clear empty-turn loss for the
        // session that actually produced a displayable ASR caption.
        // `record_asr_success` takes `asr_health` after tracker+status (never reverse).
        self.record_asr_success();
        let mut dirty = false;
        if !status.backend_reachable {
            status.backend_reachable = true;
            dirty = true;
        }
        if status.last_error.is_some() {
            status.last_error = None;
            dirty = true;
        }
        if !dirty {
            return None;
        }
        Some(status.clone())
    }

    /// Reachability without clearing `last_error`. Same generation atomicity
    /// contract as [`Self::mark_backend_healthy_for_generation`].
    ///
    /// Lock order: `translation_tracker` then `status`.
    pub fn mark_backend_reachable_for_generation(&self, generation: u64) -> Option<RuntimeStatus> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        let mut status = self.status.lock().ok()?;
        if !capture_status_is_active(status.status.as_str()) || status.backend_reachable {
            return None;
        }
        status.backend_reachable = true;
        Some(status.clone())
    }

    /// Persistent VAD-confirmed empty ASR loss for a still-current generation.
    ///
    /// Lock order: `translation_tracker` then `status`.
    pub fn apply_persistent_asr_loss_for_generation(
        &self,
        generation: u64,
        detail: &str,
    ) -> Option<RuntimeStatus> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        let mut status = self.status.lock().ok()?;
        if !capture_status_is_active(status.status.as_str()) {
            return None;
        }
        status.backend_reachable = false;
        status.last_error = Some(detail.to_string());
        Some(status.clone())
    }

    /// Accept a user-facing caption into native replay only when generation is
    /// current and capture is still active. Invokes `emit` while the status
    /// lock is held so `stop_capture`'s idle transition stays ordered after an
    /// accepted caption (same contract as the previous emit path).
    ///
    /// Lock order: `translation_tracker`, then `status`, then `latest_caption`.
    pub fn publish_caption_for_generation(
        &self,
        generation: u64,
        caption: &CaptionPayload,
        emit: impl FnOnce(&CaptionPayload),
    ) -> bool {
        let Ok(tracker) = self.translation_tracker.lock() else {
            return false;
        };
        if !generation_is_current(&tracker, generation) {
            return false;
        }
        let Ok(status) = self.status.lock() else {
            return false;
        };
        if !capture_status_is_active(status.status.as_str()) {
            return false;
        }
        // Record under the active-session guard so a concurrent successful stop
        // cannot clear the replay slot before we decide the caption is live.
        self.record_latest_caption(caption);
        emit(caption);
        // Keep `status` (and generation) held through emit so idle cannot race
        // ahead of a caption that was accepted for this generation.
        drop(status);
        drop(tracker);
        true
    }

    /// Record an empty result from a Parapper turn for which VAD had already
    /// identified speech. Lock failures degrade to a transient soft skip;
    /// transcription itself must remain available even if diagnostics fail.
    #[allow(dead_code)]
    pub fn record_expected_empty_asr(&self, turn_id: &str) -> ExpectedEmptyAsrResult {
        self.asr_health
            .lock()
            .map(|mut health| health.observe_expected_empty_at(Instant::now(), turn_id))
            .unwrap_or(ExpectedEmptyAsrResult::Transient { consecutive: 0 })
    }

    /// Begin a new capture generation before work is accepted. Tasks from an
    /// earlier generation may still finish after a bounded stop drain, but
    /// cannot update a later session. The replay slot is cleared at the same
    /// lifecycle boundary so a replacement capture cannot expose stale text.
    pub fn begin_capture_generation(&self) -> u64 {
        let generation = self
            .translation_tracker
            .lock()
            .map(|mut tracker| {
                tracker.start_capture();
                tracker.current_generation
            })
            .unwrap_or_default();
        self.clear_latest_caption();
        generation
    }

    /// Register a detached translation directly for state-machine tests. Production
    /// callers must use `register_translation_for_generation` so a stale source
    /// completion cannot acquire a ticket for a replacement capture.
    #[cfg(test)]
    pub fn register_translation(&self) -> Option<(TranslationTicket, Option<TranslationTicket>)> {
        self.translation_tracker.lock().ok()?.register()
    }

    /// Register work only for the generation that produced the source caption.
    ///
    /// The caller may have observed that generation as current before an async
    /// spawn, but a Stop+Start can advance the tracker in between those two
    /// operations. Checking the supplied generation while holding the same
    /// tracker lock as `register` closes that time-of-check/time-of-use gap: a
    /// stale completion is dropped instead of receiving a ticket belonging to
    /// the replacement capture.
    pub fn register_translation_for_generation(
        &self,
        generation: u64,
    ) -> Option<(TranslationTicket, Option<TranslationTicket>)> {
        let mut tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        tracker.register()
    }

    /// Total translation tickets retired by the bounded latest-wins queue,
    /// surfaced in the debug snapshot to explain dropped translations.
    pub fn translation_retired_count(&self) -> u64 {
        self.translation_tracker.lock().map(|tracker| tracker.retired_count).unwrap_or_default()
    }

    /// Record a Parapper turn output dropped because the generation the
    /// frontend queue captured at enqueue time was superseded before this
    /// command processed it. See [`Self::parapper_output_superseded_count`].
    pub fn record_parapper_output_superseded(&self) -> u64 {
        self.parapper_output_superseded.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Total Parapper turn outputs dropped for a superseded enqueue-time
    /// generation, surfaced in the debug snapshot alongside
    /// `translation_retired_count` to explain output that never became a
    /// caption.
    pub fn parapper_output_superseded_count(&self) -> u64 {
        self.parapper_output_superseded.load(Ordering::Relaxed)
    }

    /// Record a source caption dropped as stale because its stamped capture
    /// generation was superseded before `publish_source_caption_gated` ran.
    /// See [`Self::source_caption_stale_dropped_count`].
    pub fn record_source_caption_stale_dropped(&self) -> u64 {
        self.source_caption_stale_dropped.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Total source captions dropped for a superseded stamped generation,
    /// surfaced in the debug snapshot so a producer stamping a wrong
    /// generation is visible instead of silently losing every caption.
    pub fn source_caption_stale_dropped_count(&self) -> u64 {
        self.source_caption_stale_dropped.load(Ordering::Relaxed)
    }

    /// Record a caption or Parapper turn output accepted through the legacy
    /// no-generation path, which is deliberately never generation-fenced.
    /// See [`Self::unfenced_caption_accepted_count`].
    pub fn record_unfenced_caption_accepted(&self) -> u64 {
        self.unfenced_caption_accepted.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Total legacy unfenced accepts across `publish_source_caption_gated`
    /// and `normalize_parapper_output`, surfaced in the debug snapshot to
    /// quantify the producers that cannot be generation-checked.
    pub fn unfenced_caption_accepted_count(&self) -> u64 {
        self.unfenced_caption_accepted.load(Ordering::Relaxed)
    }

    /// Freeze the current generation against new translations and return the
    /// generation whose existing work Stop should briefly drain.
    pub fn begin_translation_drain(&self) -> u64 {
        self.translation_tracker.lock().map(|mut tracker| tracker.begin_drain()).unwrap_or_default()
    }

    pub fn finish_translation(&self, ticket: TranslationTicket) {
        if let Ok(mut tracker) = self.translation_tracker.lock() {
            tracker.finish(ticket);
        }
        // `notify_one` retains a permit when the drain loop is between its
        // count check and await, avoiding a missed completion wake-up.
        self.translation_notify.notify_one();
    }

    /// Wait until all translations registered before Stop have finished, or
    /// until the caller's explicit bounded timeout expires.
    pub async fn drain_translations(&self, generation: u64, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, wait_for_translation_drain(self, generation)).await.is_ok()
    }

    /// Translation publication is generation-aware. Stopping a generation is
    /// still publishable while Stop waits for it; only a later start invalidates
    /// the task.
    #[allow(dead_code)]
    pub fn translation_is_current(&self, ticket: TranslationTicket) -> bool {
        self.translation_tracker.lock().map(|tracker| tracker.is_current(ticket)).unwrap_or(false)
    }

    /// Publish a translation result only when its ticket remains current.
    /// Invokes `emit` while the tracker lock is held so generation-awareness is
    /// atomic with publication.
    ///
    /// Lock order: `translation_tracker` then `status` then `latest_caption`.
    pub fn publish_translation_for_ticket(
        &self,
        ticket: TranslationTicket,
        caption: &CaptionPayload,
        emit: impl FnOnce(&CaptionPayload),
    ) {
        let Ok(tracker) = self.translation_tracker.lock() else {
            return;
        };
        if !tracker.is_current(ticket) {
            return;
        }
        let Ok(status) = self.status.lock() else {
            return;
        };
        if !capture_status_is_active(status.status.as_str()) {
            return;
        }
        self.record_latest_caption(caption);
        emit(caption);
        drop(status);
        drop(tracker);
    }

    /// Surface a translation failure only when its ticket remains current. A
    /// stop-bounded task may finish during the next capture session; its error
    /// must not poison the replacement session's runtime status.
    ///
    /// Lock order: `translation_tracker` then `status`.
    pub fn apply_translation_error_for_ticket(
        &self,
        ticket: TranslationTicket,
        detail: &str,
    ) -> Option<RuntimeStatus> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !tracker.is_current(ticket) {
            return None;
        }
        let mut status = self.status.lock().ok()?;
        if status.status == "idle" {
            return None;
        }
        let mut dirty = false;
        if !matches!(status.status.as_str(), "idle" | "starting" | "capturing") {
            status.status = "capturing".to_string();
            dirty = true;
        }
        if status.last_error.as_deref() != Some(detail) {
            status.last_error = Some(detail.to_string());
            dirty = true;
        }
        if !dirty {
            return None;
        }
        Some(status.clone())
    }

    /// Record an empty result from a Parapper turn for a still-current generation,
    /// returning None if the generation has been superseded. This prevents a
    /// Stop+Start between the generation check and the empty-asr record from
    /// poisoning the new session's health tracker.
    ///
    /// Lock order: `translation_tracker` then `asr_health`.
    pub fn record_expected_empty_asr_for_generation(
        &self,
        generation: u64,
        turn_id: &str,
    ) -> Option<ExpectedEmptyAsrResult> {
        let tracker = self.translation_tracker.lock().ok()?;
        if !generation_is_current(&tracker, generation) {
            return None;
        }
        let mut health = self.asr_health.lock().ok()?;
        Some(health.observe_expected_empty_at(Instant::now(), turn_id))
    }
}

/// Shared active-capture predicate for generation-gated status mutations.
fn capture_status_is_active(status: &str) -> bool {
    matches!(status, "starting" | "capturing")
}

fn generation_is_current(tracker: &TranslationTracker, generation: u64) -> bool {
    tracker.current_generation == generation && generation != 0
}

async fn wait_for_translation_drain(state: &AppState, generation: u64) {
    loop {
        let notified = state.translation_notify.notified();
        let pending = state
            .translation_tracker
            .lock()
            .map(|tracker| tracker.pending(generation))
            .unwrap_or_default();
        if pending == 0 {
            return;
        }
        notified.await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AppState, AsrHealthTracker, ExpectedEmptyAsrResult, ASR_EMPTY_RESULT_WINDOW,
        MAX_PENDING_TRANSLATIONS_PER_CAPTURE, PIPELINE_STAGE_HISTORY_LIMIT,
    };
    use crate::config::AppConfig;
    use crate::output::OutputStatus;
    use crate::pipeline::{CaptionPayload, PipelineStageEvent};
    use std::sync::Arc;

    async fn finish_translation_after_delay(
        state: Arc<AppState>,
        ticket: super::TranslationTicket,
    ) {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        state.finish_translation(ticket);
    }

    fn stage(index: usize) -> PipelineStageEvent {
        PipelineStageEvent {
            stage: "asr",
            utterance_id: format!("utterance-{index}"),
            model_id: "parapper-ja".to_string(),
            input_snippet: format!("input-{index}"),
            output_text: format!("output-{index}"),
            surface_text: None,
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
            state.record_pipeline_stage(1, &stage(index));
        }
        let history = state.pipeline_stage_history();
        assert_eq!(history.len(), PIPELINE_STAGE_HISTORY_LIMIT);
        assert_eq!(
            history.first().map(|event| event.stage.utterance_id.as_str()),
            Some("utterance-97")
        );
        assert_eq!(
            history.last().map(|event| event.stage.utterance_id.as_str()),
            Some("utterance-2")
        );
    }

    #[test]
    fn recorded_pipeline_stage_flattens_capture_generation_alongside_stage_fields() {
        // The frontend's `normalizePipelineStageEvent` reads fields directly
        // off the top-level `pipeline:stage` payload (see
        // `apps/desktop/src/core/pipelineStages.ts`). If `#[serde(flatten)]`
        // ever regressed to a nested `stage` object instead of flattening its
        // fields, every existing consumer would silently stop matching
        // `stage`/`utteranceId`/etc. and no Rust test would catch it without
        // asserting the actual serialized shape here.
        let recorded = super::RecordedPipelineStage { capture_generation: 7, stage: stage(1) };
        let value = serde_json::to_value(&recorded).expect("RecordedPipelineStage serializes");
        let object = value.as_object().expect("flat JSON object, not a nested wrapper");

        assert_eq!(object.get("captureGeneration").and_then(|v| v.as_u64()), Some(7));
        assert_eq!(object.get("stage").and_then(|v| v.as_str()), Some("asr"));
        assert!(object.contains_key("utteranceId"));
        assert!(object.contains_key("modelId"));
        assert!(object.contains_key("inputSnippet"));
        assert!(object.contains_key("outputText"));
        assert!(object.contains_key("startedAt"));
        assert!(object.contains_key("at"));
        assert!(object.contains_key("durationMs"));
        assert!(object.contains_key("ok"));
        // `surface_text: None` in the fixture must still be skipped, matching
        // PipelineStageEvent's own `skip_serializing_if`, not emitted as null.
        assert!(!object.contains_key("surfaceText"));
        // No nested "stage" object: flatten must not double-wrap the payload.
        assert!(object.get("stage").is_some_and(|v| v.is_string()));
    }

    #[test]
    fn stale_generation_stage_is_retained_and_tagged_not_dropped() {
        // A stage row from a superseded capture generation is a diagnostic,
        // not a user-facing publish: dropping it would be a silent-loss bug
        // in its own right, so it must remain in history but be tagged with
        // the generation that actually produced it.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let stale_generation = state.current_capture_generation();
        state.record_pipeline_stage(stale_generation, &stage(1));
        state.begin_capture_generation();
        let live_generation = state.current_capture_generation();
        assert_ne!(stale_generation, live_generation);
        state.record_pipeline_stage(live_generation, &stage(2));

        let history = state.pipeline_stage_history();
        assert_eq!(history.len(), 2);
        // Newest first.
        assert_eq!(history[0].capture_generation, live_generation);
        assert_eq!(history[1].capture_generation, stale_generation);
    }

    #[test]
    fn superseded_parapper_output_is_counted() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        assert_eq!(state.parapper_output_superseded_count(), 0);
        assert_eq!(state.record_parapper_output_superseded(), 1);
        assert_eq!(state.record_parapper_output_superseded(), 2);
        assert_eq!(state.parapper_output_superseded_count(), 2);
    }

    #[test]
    fn stale_source_caption_drop_and_unfenced_accept_are_counted() {
        // Pins the two observability counters that make the silent caption
        // loss paths visible: fenced stale drops and legacy no-generation
        // accepts are both counted independently of each other.
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        assert_eq!(state.source_caption_stale_dropped_count(), 0);
        assert_eq!(state.unfenced_caption_accepted_count(), 0);
        assert_eq!(state.record_source_caption_stale_dropped(), 1);
        assert_eq!(state.record_source_caption_stale_dropped(), 2);
        assert_eq!(state.record_unfenced_caption_accepted(), 1);
        assert_eq!(state.source_caption_stale_dropped_count(), 2);
        assert_eq!(state.unfenced_caption_accepted_count(), 1);
    }

    #[test]
    fn empty_turns_only_become_a_loss_when_they_repeat_in_the_bounded_window() {
        let mut health = AsrHealthTracker::default();
        let now = std::time::Instant::now();
        assert_eq!(
            health.observe_expected_empty_at(now, "turn-1"),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 }
        );
        assert_eq!(
            health.observe_expected_empty_at(now + std::time::Duration::from_secs(2), "turn-2"),
            ExpectedEmptyAsrResult::Transient { consecutive: 2 }
        );
        assert_eq!(
            health.observe_expected_empty_at(now + std::time::Duration::from_secs(4), "turn-3"),
            ExpectedEmptyAsrResult::PersistentLoss { consecutive: 3 }
        );

        health.reset();
        assert_eq!(
            health.observe_expected_empty_at(now, "turn-1"),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 }
        );
        assert_eq!(
            health.observe_expected_empty_at(
                now + ASR_EMPTY_RESULT_WINDOW + std::time::Duration::from_secs(1),
                "turn-2",
            ),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 },
            "an old empty turn must not carry into a new observation window"
        );
    }

    #[test]
    fn successful_asr_resets_a_persistent_empty_turn_loss() {
        let mut health = AsrHealthTracker::default();
        let now = std::time::Instant::now();
        for offset in [0, 1, 2] {
            health.observe_expected_empty_at(
                now + std::time::Duration::from_secs(offset),
                &format!("turn-{offset}"),
            );
        }
        health.reset();
        assert_eq!(
            health.observe_expected_empty_at(now + std::time::Duration::from_secs(3), "turn-4"),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 }
        );
    }

    #[test]
    fn blank_interim_and_final_revisions_count_as_one_speech_turn() {
        let mut health = AsrHealthTracker::default();
        let now = std::time::Instant::now();
        assert_eq!(
            health.observe_expected_empty_at(now, "session:1:7"),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 }
        );
        assert_eq!(
            health
                .observe_expected_empty_at(now + std::time::Duration::from_secs(1), "session:1:7"),
            ExpectedEmptyAsrResult::Transient { consecutive: 1 }
        );
    }

    #[test]
    fn final_source_caption_does_not_regress_to_a_late_partial_revision() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        let final_caption = CaptionPayload {
            id: "parapper:session:1:7".to_string(),
            source_text: "最終字幕".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 100,
            received_at: 200,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
        };
        let late_partial = CaptionPayload {
            source_text: "遅延した途中字幕".to_string(),
            received_at: 300,
            is_final: false,
            ..final_caption.clone()
        };

        state.record_latest_caption(&final_caption);
        state.record_latest_caption(&late_partial);
        assert_eq!(state.latest_caption(), Some(final_caption));
    }

    #[test]
    fn delayed_asr_work_is_rejected_after_a_new_capture_generation_starts() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let delayed_generation = state.current_capture_generation();
        assert!(state.is_capture_generation_current(delayed_generation));

        state.begin_capture_generation();
        assert!(
            !state.is_capture_generation_current(delayed_generation),
            "a delayed ASR/normalizer completion belongs to the old capture"
        );
        assert!(state.is_capture_generation_current(state.current_capture_generation()));
    }

    #[test]
    fn starting_a_new_capture_clears_the_previous_replay_caption() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.record_latest_caption(&CaptionPayload {
            id: "old-session".to_string(),
            source_text: "前の字幕".to_string(),
            azookey_input_text: None,
            translation_text: "old caption".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "translation",
            sequence: 1,
            is_final: true,
            confidence: None,
        });
        assert!(state.latest_caption().is_some());

        state.begin_capture_generation();

        assert_eq!(
            state.latest_caption(),
            None,
            "a replacement capture must not replay the prior session"
        );
    }

    fn capturing_state() -> AppState {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }
        state
    }

    #[test]
    fn stale_generation_does_not_poison_status_with_a_late_transcription_error() {
        let state = capturing_state();
        let delayed_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }

        assert!(
            state
                .apply_transcription_error_for_generation(delayed_generation, "stale ASR failure")
                .is_none(),
            "an old Err completion must not emit runtime:status into the replacement session"
        );
        let status = state.status.lock().expect("status lock");
        assert!(status.backend_reachable);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn current_generation_transcription_error_still_marks_backend_unreachable() {
        let state = capturing_state();
        let generation = state.current_capture_generation();
        let next = state
            .apply_transcription_error_for_generation(generation, "live ASR failure")
            .expect("current generation may surface last_error");
        assert!(!next.backend_reachable);
        assert_eq!(next.last_error.as_deref(), Some("live ASR failure"));
        assert_eq!(next.status, "capturing");
    }

    #[test]
    fn stale_generation_does_not_mark_backend_healthy_or_clear_errors() {
        let state = capturing_state();
        let delayed_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = false;
            status.last_error = Some("new session error".to_string());
        }

        assert!(state.mark_backend_healthy_for_generation(delayed_generation).is_none());
        let status = state.status.lock().expect("status lock");
        assert!(!status.backend_reachable);
        assert_eq!(status.last_error.as_deref(), Some("new session error"));
    }

    #[test]
    fn stale_generation_does_not_apply_persistent_asr_loss() {
        let state = capturing_state();
        let delayed_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }

        assert!(state
            .apply_persistent_asr_loss_for_generation(delayed_generation, "stale ASR loss")
            .is_none());
        let status = state.status.lock().expect("status lock");
        assert!(status.backend_reachable);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn stale_generation_does_not_publish_a_late_source_caption() {
        let state = capturing_state();
        let delayed_generation = state.current_capture_generation();
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
        }
        let caption = CaptionPayload {
            id: "stale".to_string(),
            source_text: "遅延した字幕".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
        };
        let mut emitted = false;
        assert!(!state.publish_caption_for_generation(delayed_generation, &caption, |_| {
            emitted = true;
        }));
        assert!(!emitted);
        assert_eq!(state.latest_caption(), None);
    }

    #[test]
    fn current_generation_publishes_caption_while_capture_is_active() {
        let state = capturing_state();
        let generation = state.current_capture_generation();
        let caption = CaptionPayload {
            id: "live".to_string(),
            source_text: "現行字幕".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
        };
        let mut emitted = false;
        assert!(state.publish_caption_for_generation(generation, &caption, |_| {
            emitted = true;
        }));
        assert!(emitted);
        assert_eq!(state.latest_caption(), Some(caption));
    }

    #[test]
    fn paused_capture_drops_a_late_caption_and_resume_publishes_fresh_work() {
        // A chunk that straddles the pause boundary can finish its pipeline
        // run while the runtime is idle.  Its generation is still current
        // (no replacement start has happened yet), but the caption must not
        // be emitted or replayed.  After resume — start_capture bumps the
        // generation and the status returns to capturing — fresh work
        // publishes normally while the paused session's generation stays
        // permanently superseded.
        let state = capturing_state();
        let paused_generation = state.current_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "idle".to_string();
        }
        let late = CaptionPayload {
            id: "paused-late".to_string(),
            source_text: "停止中に完成した字幕".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
        };
        let mut emitted = false;
        assert!(!state.publish_caption_for_generation(paused_generation, &late, |_| {
            emitted = true;
        }));
        assert!(!emitted, "a chunk completed during pause must not reach the caption surface");
        assert_eq!(state.latest_caption(), None);

        let resumed_generation = state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
        }
        assert!(
            !state.publish_caption_for_generation(paused_generation, &late, |_| {
                emitted = true;
            }),
            "paused-session audio must not affect the resumed session's transcription"
        );
        assert!(!emitted);
        assert_eq!(state.latest_caption(), None);

        let fresh = CaptionPayload {
            id: "resumed-fresh".to_string(),
            source_text: "再開後の字幕".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 3,
            received_at: 4,
            stage: "source",
            sequence: 0,
            is_final: true,
            confidence: None,
        };
        assert!(state.publish_caption_for_generation(resumed_generation, &fresh, |_| {
            emitted = true;
        }));
        assert!(emitted, "resumed capture must process new chunks again");
        assert_eq!(state.latest_caption(), Some(fresh));
    }

    #[test]
    fn generation_fenced_translation_registration_rejects_stale_work() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let stale_generation = state.current_capture_generation();

        state.begin_capture_generation();
        let current_generation = state.current_capture_generation();
        assert_ne!(stale_generation, current_generation);
        assert!(
            state.register_translation_for_generation(stale_generation).is_none(),
            "a source completion from the prior capture must not receive a new ticket"
        );
        assert!(
            state.register_translation_for_generation(current_generation).is_some(),
            "work from the active capture should still be accepted"
        );

        let stopping_generation = state.begin_translation_drain();
        assert_eq!(stopping_generation, current_generation);
        assert!(
            state.register_translation_for_generation(current_generation).is_none(),
            "Stop must fence registration before its bounded translation drain"
        );
    }

    #[tokio::test]
    async fn stopping_capture_drains_a_delayed_translation_before_idle_can_win() {
        let state = Arc::new(AppState::new(
            AppConfig::default(),
            OutputStatus { platform: "test".to_string() },
        ));
        state.begin_capture_generation();
        let (ticket, superseded) =
            state.register_translation().expect("active capture accepts translation");
        assert!(superseded.is_none());
        let generation = state.begin_translation_drain();
        assert!(
            state.register_translation().is_none(),
            "Stop must reject work that would otherwise miss the drain"
        );

        tokio::spawn(finish_translation_after_delay(Arc::clone(&state), ticket));

        assert!(
            state.drain_translations(generation, std::time::Duration::from_millis(100)).await,
            "Stop should retain an already-started translation that completes shortly after it"
        );
        assert!(
            !state.translation_is_current(ticket),
            "a completed translation is no longer pending or publishable"
        );

        state.begin_capture_generation();
        assert!(
            !state.translation_is_current(ticket),
            "a delayed old task may never publish into the next capture generation"
        );
    }

    #[test]
    fn translation_backlog_retires_the_oldest_ticket_and_accepts_the_latest_work() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        assert_eq!(state.translation_retired_count(), 0);
        let mut tickets = Vec::new();
        for _ in 0..MAX_PENDING_TRANSLATIONS_PER_CAPTURE {
            let (ticket, superseded) = state.register_translation().expect("active capture");
            assert!(superseded.is_none());
            tickets.push(ticket);
        }
        let (latest, superseded) = state.register_translation().expect("latest work is accepted");
        assert_eq!(superseded, Some(tickets[0]));
        assert!(
            !state.translation_is_current(tickets[0]),
            "the oldest slow translation cannot publish after latest-wins retirement"
        );
        assert!(state.translation_is_current(latest));
        assert_eq!(state.translation_retired_count(), 1);

        // A late (or duplicate) completion of an already-retired ticket is a
        // no-op and must not increment the retirement diagnostic again.
        state.finish_translation(tickets[0]);
        state.finish_translation(tickets[0]);
        assert_eq!(state.translation_retired_count(), 1);

        // Starting a second capture resets the generation-scoped diagnostic;
        // an old task finishing afterwards cannot resurrect the old count.
        state.begin_capture_generation();
        assert_eq!(state.translation_retired_count(), 0);
        state.finish_translation(latest);
        assert_eq!(state.translation_retired_count(), 0);
    }

    #[test]
    fn latest_caption_replaces_source_with_translation_without_raw_asr() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        let source = CaptionPayload {
            id: "u1".to_string(),
            source_text: "正規化済み".to_string(),
            azookey_input_text: None,
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

        // A Parapper final backdates started_at by its turn duration. It must
        // replace a same-id interim in native replay despite that timestamp.
        let backdated_state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        let backdated_interim = CaptionPayload {
            id: "parapper-session".to_string(),
            source_text: "あしたは".to_string(),
            azookey_input_text: Some("あしたは".to_string()),
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 2_000,
            received_at: 2_010,
            stage: "source",
            sequence: 0,
            is_final: false,
            confidence: None,
        };
        backdated_state.record_latest_caption(&backdated_interim);
        let final_source = CaptionPayload {
            id: "parapper-session".to_string(),
            source_text: "明日は晴れです".to_string(),
            started_at: 1_360,
            received_at: 2_020,
            is_final: true,
            ..backdated_interim
        };
        backdated_state.record_latest_caption(&final_source);
        assert_eq!(backdated_state.latest_caption(), Some(final_source));

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

    #[test]
    fn publish_translation_for_ticket_rejects_stale_generations() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let (ticket_gen_1, _) = state.register_translation().expect("active capture");
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
        }

        let caption = CaptionPayload {
            id: "test".to_string(),
            source_text: "src".to_string(),
            azookey_input_text: None,
            translation_text: "trans".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "translation",
            sequence: 1,
            is_final: true,
            confidence: None,
        };

        let mut emitted_count = 0;
        state.publish_translation_for_ticket(ticket_gen_1, &caption, |_| {
            emitted_count += 1;
        });
        assert_eq!(
            emitted_count, 0,
            "translation from old generation must never emit into new capture session"
        );
        assert_eq!(
            state.latest_caption(),
            None,
            "translation from old generation must not update replay slot"
        );
    }

    #[test]
    fn current_ticket_translation_publishes_and_records() {
        let state = capturing_state();
        let (ticket, _) = state.register_translation().expect("active capture");
        let caption = CaptionPayload {
            id: "u1".to_string(),
            source_text: "正規化済み".to_string(),
            azookey_input_text: None,
            translation_text: "normalized".to_string(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: "translation",
            sequence: 1,
            is_final: true,
            confidence: None,
        };
        let mut emitted = 0;
        state.publish_translation_for_ticket(ticket, &caption, |_| {
            emitted += 1;
        });
        assert_eq!(emitted, 1, "a current ticket's translation must publish");
        assert_eq!(state.latest_caption(), Some(caption));
    }

    #[test]
    fn stale_ticket_translation_error_does_not_poison_replacement_session() {
        let state = capturing_state();
        let (ticket, _) = state.register_translation().expect("active capture");
        state.begin_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
            status.backend_reachable = true;
            status.last_error = None;
        }

        assert!(state
            .apply_translation_error_for_ticket(ticket, "stale translation error")
            .is_none());
        let status = state.status.lock().expect("status lock");
        assert!(status.backend_reachable);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn current_ticket_translation_error_surfaces_last_error_without_backend_loss() {
        let state = capturing_state();
        let (ticket, _) = state.register_translation().expect("active capture");
        let next = state
            .apply_translation_error_for_ticket(ticket, "live translation error")
            .expect("current ticket may surface last_error");
        assert_eq!(next.status, "capturing");
        assert!(
            next.backend_reachable,
            "source ASR already succeeded; translation failure must not mark the backend unreachable"
        );
        assert_eq!(next.last_error.as_deref(), Some("live translation error"));
    }

    #[test]
    fn record_expected_empty_asr_for_generation_atomically_checks_and_records() {
        let state =
            AppState::new(AppConfig::default(), OutputStatus { platform: "test".to_string() });
        state.begin_capture_generation();
        let gen1 = state.current_capture_generation();
        {
            let mut status = state.status.lock().expect("status lock");
            status.status = "capturing".to_string();
        }

        let result1 = state.record_expected_empty_asr_for_generation(gen1, "turn1");
        assert!(matches!(result1, Some(ExpectedEmptyAsrResult::Transient { consecutive: 1 })));

        let result2 = state.record_expected_empty_asr_for_generation(gen1, "turn2");
        assert!(matches!(result2, Some(ExpectedEmptyAsrResult::Transient { consecutive: 2 })));

        state.begin_capture_generation();
        let result_stale = state.record_expected_empty_asr_for_generation(gen1, "turn3");
        assert!(
            result_stale.is_none(),
            "generation must be checked atomically with record; old generation must be rejected"
        );

        let gen2 = state.current_capture_generation();
        state.reset_asr_health();
        let result_new_gen = state.record_expected_empty_asr_for_generation(gen2, "turn4");
        assert!(
            matches!(result_new_gen, Some(ExpectedEmptyAsrResult::Transient { consecutive: 1 })),
            "new generation starts fresh with consecutive count 1 after health reset"
        );
    }
}
