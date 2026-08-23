use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};

use super::pending::{PendingFinalization, PendingTurnCheck, RerecognitionPurpose};
use crate::{
    audio::ASR_SAMPLE_RATE,
    config::ParapperConfig,
    recognition::{
        segmentation::{segment::builder::SegmentCloseReason, vad::engine::VadResult},
        transcription::{
            asr::{
                input::NEMOTRON_CHUNK_MS,
                task::{AsrInFlight, AsrRequest, AudioRange, GlobalSampleIndex, VadFrameIndex},
            },
            planner::PendingAsrSegment,
            route::{RecognitionRoute, language_id::LanguageDetector},
        },
        turn::{Turn, boundary::JapaneseMorphAnalyzer},
    },
};

use super::{
    AsrRequestRunner, TurnDecisionRunner, TurnOutputSink, clock::CaptionClock,
    events::TurnCaptionLatency,
};

pub(crate) struct RecognitionSession {
    pub(in crate::recognition) config: ParapperConfig,
    /// Session-scoped feature flag from the network `session.start` frame.
    /// It is intentionally not part of persisted `ParapperConfig` so a new
    /// capture observes the caller's current setting and missing fields stay
    /// fail-closed.
    pub(in crate::recognition) partial_window_asr_enabled: bool,
    pub(in crate::recognition) pending: PendingRuntimeState,
    pub(in crate::recognition) io: RuntimeIo,
    pub(in crate::recognition) turn_store: TurnStore,
    pub(in crate::recognition) counters: RuntimeCounters,
    pub(in crate::recognition) activity: ActivityState,
    pub(in crate::recognition) requests: AsrRequestState,
    pub(in crate::recognition) clock: Arc<dyn CaptionClock>,
}

pub(in crate::recognition) struct RuntimeIo {
    pub(in crate::recognition) asr_runner: Box<dyn AsrRequestRunner>,
    pub(in crate::recognition) turn_decision_runner: Box<dyn TurnDecisionRunner>,
    pub(in crate::recognition) output_sink: Box<dyn TurnOutputSink>,
    pub(in crate::recognition) language_id_runtime: Option<Box<dyn LanguageIdRuntime>>,
    pub(in crate::recognition) language_id: Option<Box<dyn LanguageDetector>>,
    pub(in crate::recognition) japanese_morph: Option<JapaneseMorphAnalyzer>,
}

#[derive(Default)]
pub(in crate::recognition) struct PendingRuntimeState {
    pub(in crate::recognition) turn_check: Option<PendingTurnCheck>,
    pub(in crate::recognition) finalization: Option<PendingFinalization>,
    pub(in crate::recognition) asr_segments: VecDeque<PendingAsrSegment>,
    pub(in crate::recognition) interim_asr: InterimAsrState,
    /// The bounded audio snapshot used by the optional completion-model
    /// partial-window path.  It is deliberately independent from the
    /// streaming Nemotron cache and from the mutable `TurnDraft`.
    pub(in crate::recognition) partial_window: PartialWindowAsrState,
    /// Reset Nemotron streaming cache only after flushed `InterimChunkReached`
    /// requests for the closing utterance have been submitted.
    pub(in crate::recognition) deferred_streaming_session_reset: bool,
}

pub(in crate::recognition) const PARTIAL_WINDOW_MIN_GAP_MS: u128 = 400;
pub(in crate::recognition) const PARTIAL_WINDOW_MAX_AUDIO_SAMPLES: usize =
    ASR_SAMPLE_RATE as usize * 6;

#[derive(Default)]
pub(in crate::recognition) struct PartialWindowAsrState {
    active: Option<PartialWindowSegmentState>,
    next_due_tick: Option<u64>,
    gap_millis: u128,
    dispatched: u64,
    skipped_busy: u64,
    skipped_capped: u64,
    completed: u64,
    total_decode_millis: u128,
    /// A bounded recent sample is sufficient for adaptive scheduling telemetry;
    /// retaining every decode for a long-lived capture would make observability
    /// itself unbounded.
    recent_decode_millis: VecDeque<u128>,
    throttled_completed: u64,
}

const PARTIAL_WINDOW_DECODE_SAMPLE_CAPACITY: usize = 64;

#[derive(Clone)]
pub(in crate::recognition) struct PartialWindowSnapshot {
    pub(in crate::recognition) segment_id: u64,
    pub(in crate::recognition) previous_segment_id: Option<u64>,
    pub(in crate::recognition) audio: Vec<f32>,
    pub(in crate::recognition) vad_results: Vec<VadResult>,
    pub(in crate::recognition) range: AudioRange,
    pub(in crate::recognition) created_at_frame: VadFrameIndex,
}

struct PartialWindowSegmentState {
    segment_id: u64,
    previous_segment_id: Option<u64>,
    audio: Vec<f32>,
    vad_results: Vec<VadResult>,
    range_start: GlobalSampleIndex,
    range_end: GlobalSampleIndex,
    created_at_frame: VadFrameIndex,
    capped: bool,
}

impl PartialWindowAsrState {
    pub(in crate::recognition) fn reset(&mut self) {
        self.active = None;
        self.next_due_tick = None;
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::recognition) fn start_segment(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        audio: Vec<f32>,
        vad_results: Vec<VadResult>,
        end_sample: GlobalSampleIndex,
        created_at_frame: VadFrameIndex,
        current_tick: u64,
        vad_interval_ms: u32,
    ) {
        self.reset();
        if audio.is_empty() {
            return;
        }
        let capped = audio.len() >= PARTIAL_WINDOW_MAX_AUDIO_SAMPLES;
        let mut audio = audio;
        audio.truncate(PARTIAL_WINDOW_MAX_AUDIO_SAMPLES);
        let range_start = GlobalSampleIndex(end_sample.0.saturating_sub(audio.len() as u64));
        self.active = Some(PartialWindowSegmentState {
            segment_id,
            previous_segment_id,
            audio,
            vad_results,
            range_start,
            range_end: end_sample,
            created_at_frame,
            capped,
        });
        self.gap_millis = PARTIAL_WINDOW_MIN_GAP_MS;
        self.next_due_tick = Some(
            current_tick
                .saturating_add(ticks_for_partial_window_gap(self.gap_millis, vad_interval_ms)),
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::recognition) fn extend_segment(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        new_audio: Vec<f32>,
        vad_result: VadResult,
        end_sample: GlobalSampleIndex,
        created_at_frame: VadFrameIndex,
        current_tick: u64,
        vad_interval_ms: u32,
    ) {
        if new_audio.is_empty() {
            return;
        }
        let continues = self.active.as_ref().is_some_and(|active| active.segment_id == segment_id);
        if !continues {
            self.start_segment(
                segment_id,
                previous_segment_id,
                new_audio,
                vec![vad_result],
                end_sample,
                created_at_frame,
                current_tick,
                vad_interval_ms,
            );
            return;
        }
        let active = self.active.as_mut().expect("active segment checked above");
        active.range_end = end_sample;
        active.vad_results.push(vad_result);
        if active.capped {
            return;
        }
        let remaining = PARTIAL_WINDOW_MAX_AUDIO_SAMPLES.saturating_sub(active.audio.len());
        if new_audio.len() > remaining {
            active.audio.extend_from_slice(&new_audio[..remaining]);
            active.capped = true;
        } else {
            active.audio.extend_from_slice(&new_audio);
            active.capped = active.audio.len() >= PARTIAL_WINDOW_MAX_AUDIO_SAMPLES;
        }
        // The request range always describes the bounded current snapshot, not
        // the full segment that may have grown past the safety cap.
        active.range_start =
            GlobalSampleIndex(end_sample.0.saturating_sub(active.audio.len() as u64));
    }

    pub(in crate::recognition) fn close_segment(&mut self, segment_id: u64) {
        if self.active.as_ref().is_some_and(|active| active.segment_id == segment_id) {
            self.reset();
        }
    }

    pub(in crate::recognition) fn matches_segment(&self, segment_id: u64) -> bool {
        self.active.as_ref().is_some_and(|active| active.segment_id == segment_id)
    }

    pub(in crate::recognition) fn take_due(
        &mut self,
        current_tick: u64,
        vad_interval_ms: u32,
    ) -> Option<PartialWindowSnapshot> {
        let due_tick = self.next_due_tick?;
        if current_tick < due_tick {
            return None;
        }
        self.next_due_tick = Some(current_tick.saturating_add(ticks_for_partial_window_gap(
            self.gap_millis.max(PARTIAL_WINDOW_MIN_GAP_MS),
            vad_interval_ms,
        )));
        let active = self.active.as_ref()?;
        if active.capped {
            self.skipped_capped = self.skipped_capped.saturating_add(1);
            log::info!(
                "{}",
                serde_json::json!({
                    "event": "partial_window_asr_skip",
                    "skip_reason": "cap",
                    "segment_id": active.segment_id,
                    "input_duration_ms": u64::try_from(active.audio.len()).unwrap_or(u64::MAX).saturating_mul(1_000) / u64::from(ASR_SAMPLE_RATE),
                    "cap_samples": PARTIAL_WINDOW_MAX_AUDIO_SAMPLES,
                    "dispatched": self.dispatched,
                    "completed": self.completed,
                    "skipped_busy": self.skipped_busy,
                    "skipped_capped": self.skipped_capped,
                })
            );
            return None;
        }
        Some(PartialWindowSnapshot {
            segment_id: active.segment_id,
            previous_segment_id: active.previous_segment_id,
            audio: active.audio.clone(),
            vad_results: active.vad_results.clone(),
            range: AudioRange::new(active.range_start, active.range_end),
            created_at_frame: active.created_at_frame,
        })
    }

    pub(in crate::recognition) fn skip_busy(&mut self, current_tick: u64, vad_interval_ms: u32) {
        self.skipped_busy = self.skipped_busy.saturating_add(1);
        self.next_due_tick = Some(current_tick.saturating_add(ticks_for_partial_window_gap(
            self.gap_millis.max(PARTIAL_WINDOW_MIN_GAP_MS),
            vad_interval_ms,
        )));
        log::info!(
            "{}",
            serde_json::json!({
                "event": "partial_window_asr_skip",
                "skip_reason": "in_flight",
                "gap_ms": self.gap_millis.max(PARTIAL_WINDOW_MIN_GAP_MS),
                "dispatched": self.dispatched,
                "completed": self.completed,
                "skipped_busy": self.skipped_busy,
                "skipped_capped": self.skipped_capped,
            })
        );
    }

    pub(in crate::recognition) fn skip_due_if_busy(
        &mut self,
        current_tick: u64,
        vad_interval_ms: u32,
    ) {
        let Some(due_tick) = self.next_due_tick else {
            return;
        };
        if current_tick < due_tick {
            return;
        }
        if self.active.as_ref().is_some_and(|active| active.capped) {
            // Let take_due own the cap metric/logging when the caller is not
            // competing with another ASR task.  A busy clipped tick is still a
            // cap skip, never a request that may be silently joined later.
            let _ = self.take_due(current_tick, vad_interval_ms);
            return;
        }
        self.skip_busy(current_tick, vad_interval_ms);
    }

    pub(in crate::recognition) fn gap_millis(&self) -> u128 {
        self.gap_millis.max(PARTIAL_WINDOW_MIN_GAP_MS)
    }

    pub(in crate::recognition) fn mark_dispatched(&mut self) {
        self.dispatched = self.dispatched.saturating_add(1);
    }

    pub(in crate::recognition) fn record_decode(
        &mut self,
        current_tick: u64,
        end_to_end_millis: u128,
        decode_millis: u128,
        input_samples: usize,
        vad_interval_ms: u32,
    ) {
        self.completed = self.completed.saturating_add(1);
        self.total_decode_millis = self.total_decode_millis.saturating_add(decode_millis);
        self.gap_millis = PARTIAL_WINDOW_MIN_GAP_MS.max(decode_millis.saturating_mul(2));
        let throttle_applied = self.gap_millis > PARTIAL_WINDOW_MIN_GAP_MS;
        if throttle_applied {
            self.throttled_completed = self.throttled_completed.saturating_add(1);
        }
        if self.recent_decode_millis.len() == PARTIAL_WINDOW_DECODE_SAMPLE_CAPACITY {
            self.recent_decode_millis.pop_front();
        }
        self.recent_decode_millis.push_back(decode_millis);
        let decode_p95_millis = self.decode_p95_millis();
        let throttle_rate = self.throttle_rate();
        self.next_due_tick = Some(
            current_tick
                .saturating_add(ticks_for_partial_window_gap(self.gap_millis, vad_interval_ms)),
        );
        log::info!(
            "{}",
            serde_json::json!({
                "event": "partial_window_asr_completed",
                "input_duration_ms": u64::try_from(input_samples).unwrap_or(u64::MAX).saturating_mul(1_000) / u64::from(ASR_SAMPLE_RATE),
                "decode_ms": decode_millis,
                "decode_p95_ms": decode_p95_millis,
                "end_to_end_ms": end_to_end_millis,
                "gap_ms": self.gap_millis,
                "throttle_applied": throttle_applied,
                "throttle_rate": throttle_rate,
                "dispatched": self.dispatched,
                "completed": self.completed,
                "skipped_busy": self.skipped_busy,
                "skipped_capped": self.skipped_capped,
            })
        );
    }

    #[cfg(test)]
    pub(in crate::recognition) fn metrics(&self) -> (u64, u64, u64, u64, u128, u128, u128, f64) {
        (
            self.dispatched,
            self.skipped_busy,
            self.skipped_capped,
            self.completed,
            self.gap_millis,
            self.total_decode_millis,
            self.decode_p95_millis(),
            self.throttle_rate(),
        )
    }

    fn decode_p95_millis(&self) -> u128 {
        if self.recent_decode_millis.is_empty() {
            return 0;
        }
        let mut samples: Vec<_> = self.recent_decode_millis.iter().copied().collect();
        samples.sort_unstable();
        let index = (samples.len() * 95).div_ceil(100).saturating_sub(1);
        samples[index]
    }

    fn throttle_rate(&self) -> f64 {
        if self.completed == 0 {
            0.0
        } else {
            #[allow(clippy::cast_precision_loss)]
            {
                self.throttled_completed as f64 / self.completed as f64
            }
        }
    }
}

fn ticks_for_partial_window_gap(gap_millis: u128, vad_interval_ms: u32) -> u64 {
    let interval = u128::from(vad_interval_ms.max(1));
    gap_millis.div_ceil(interval).max(1).try_into().unwrap_or(u64::MAX)
}

#[derive(Default)]
pub(in crate::recognition) struct InterimAsrState {
    streaming: StreamingInterimState,
}

#[derive(Default)]
struct StreamingInterimState {
    active: Option<StreamingInterimSegmentState>,
}

struct StreamingInterimSegmentState {
    display_segment_id: u64,
    current_segment_id: u64,
    chunks: Vec<StreamingInterimAudioChunk>,
    emitted_samples: usize,
    range_start: GlobalSampleIndex,
    created_at_frame: VadFrameIndex,
}

struct StreamingInterimAudioChunk {
    audio: Vec<f32>,
    vad: VadResult,
}

impl InterimAsrState {
    pub(in crate::recognition) fn start_streaming_segment(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        audio_so_far: Vec<f32>,
        vad_results: Vec<VadResult>,
        end_sample: GlobalSampleIndex,
        created_at_frame: VadFrameIndex,
    ) -> Vec<PendingAsrSegment> {
        if audio_so_far.is_empty() {
            return Vec::new();
        }
        if let Some(active) = self.streaming.active.as_mut()
            && active.can_continue_with(previous_segment_id)
        {
            let chunks = streaming_chunks_from_flattened_audio(audio_so_far.clone(), vad_results);
            let overlap_samples = active.suffix_prefix_overlap_samples(&audio_so_far);
            active.current_segment_id = segment_id;
            active.append_chunks(drop_prefix_from_chunks(chunks, overlap_samples));
            return self.take_ready_streaming_segments();
        }

        let audio_len = audio_so_far.len() as u64;
        let range_start = GlobalSampleIndex(end_sample.0.saturating_sub(audio_len));
        self.streaming.active = Some(StreamingInterimSegmentState {
            display_segment_id: segment_id,
            current_segment_id: segment_id,
            chunks: streaming_chunks_from_flattened_audio(audio_so_far, vad_results),
            emitted_samples: 0,
            range_start,
            created_at_frame,
        });
        self.take_ready_streaming_segments()
    }

    pub(in crate::recognition) fn extend_streaming_segment(
        &mut self,
        segment_id: u64,
        previous_segment_id: Option<u64>,
        new_audio: Vec<f32>,
        vad_result: VadResult,
        end_sample: GlobalSampleIndex,
        created_at_frame: VadFrameIndex,
    ) -> Vec<PendingAsrSegment> {
        if new_audio.is_empty() {
            return Vec::new();
        }
        if let Some(active) = self.streaming.active.as_mut()
            && (active.current_segment_id == segment_id
                || active.can_continue_with(previous_segment_id))
        {
            active.current_segment_id = segment_id;
            active.chunks.push(StreamingInterimAudioChunk { audio: new_audio, vad: vad_result });
        } else {
            let audio_len = new_audio.len() as u64;
            let range_start = GlobalSampleIndex(end_sample.0.saturating_sub(audio_len));
            self.streaming.active = Some(StreamingInterimSegmentState {
                display_segment_id: segment_id,
                current_segment_id: segment_id,
                chunks: vec![StreamingInterimAudioChunk { audio: new_audio, vad: vad_result }],
                emitted_samples: 0,
                range_start,
                created_at_frame,
            });
        }
        self.take_ready_streaming_segments()
    }

    #[expect(
        clippy::unused_self,
        reason = "interim request policy stays behind the interim ASR state boundary even when the first branch only depends on the selected mode"
    )]
    pub(in crate::recognition) fn interim_request(
        &self,
        streaming_interim_enabled: bool,
        segment: PendingAsrSegment,
    ) -> Option<PendingAsrSegment> {
        debug_assert_eq!(segment.reason, SegmentCloseReason::InterimResultSilenceReached);
        (!streaming_interim_enabled).then_some(segment)
    }

    #[allow(dead_code)]
    pub(in crate::recognition) fn clear_streaming_if_segment(
        &mut self,
        segment_id: u64,
    ) -> Option<u64> {
        let active = self.streaming.active.as_ref()?;
        if active.current_segment_id != segment_id {
            return None;
        }
        let display_segment_id = active.display_segment_id;
        self.streaming.active = None;
        Some(display_segment_id)
    }

    /// Emit any ready full chunks plus a final remainder chunk, then clear the
    /// active streaming buffer for `segment_id`. Used on end-silence so the
    /// utterance tail is not dropped before Nemotron can decode it.
    pub(in crate::recognition) fn flush_streaming_if_segment(
        &mut self,
        segment_id: u64,
    ) -> Option<(u64, Vec<PendingAsrSegment>)> {
        let active = self.streaming.active.as_ref()?;
        if active.current_segment_id != segment_id {
            return None;
        }
        let display_segment_id = active.display_segment_id;
        let mut segments = self.take_ready_streaming_segments();
        if let Some(remainder) = self.take_streaming_remainder_segment() {
            segments.push(remainder);
        }
        self.streaming.active = None;
        Some((display_segment_id, segments))
    }

    pub(in crate::recognition) fn clear_streaming(&mut self) {
        self.streaming.active = None;
    }

    fn take_ready_streaming_segments(&mut self) -> Vec<PendingAsrSegment> {
        let Some(active) = self.streaming.active.as_mut() else {
            return Vec::new();
        };
        let mut segments = Vec::new();
        let chunk_samples = nemotron_interim_chunk_samples();
        while active.emitted_samples + chunk_samples <= active.audio_len() {
            let delta_start = active.emitted_samples;
            active.emitted_samples += chunk_samples;
            segments.push(active.pending_chunk_segment(delta_start, active.emitted_samples));
        }
        segments
    }

    fn take_streaming_remainder_segment(&mut self) -> Option<PendingAsrSegment> {
        let active = self.streaming.active.as_mut()?;
        let audio_len = active.audio_len();
        if active.emitted_samples >= audio_len {
            return None;
        }
        let delta_start = active.emitted_samples;
        active.emitted_samples = audio_len;
        Some(active.pending_chunk_segment(delta_start, audio_len))
    }
}

impl StreamingInterimSegmentState {
    fn can_continue_with(&self, previous_segment_id: Option<u64>) -> bool {
        previous_segment_id == Some(self.current_segment_id)
    }

    fn audio_len(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.audio.len()).sum()
    }

    fn pending_chunk_segment(
        &self,
        delta_start: usize,
        emitted_samples: usize,
    ) -> PendingAsrSegment {
        let (source_audio, source_vad_results) = self.audio_and_vad_range(0, emitted_samples);
        let (audio, vad_results) = self.audio_and_vad_range(delta_start, emitted_samples);
        let range = AudioRange::new(
            GlobalSampleIndex(self.range_start.0 + delta_start as u64),
            GlobalSampleIndex(self.range_start.0 + emitted_samples as u64),
        );
        PendingAsrSegment {
            segment_id: self.display_segment_id,
            previous_segment_id: None,
            source_audio,
            source_vad_results,
            audio,
            vad_results,
            reason: SegmentCloseReason::InterimChunkReached,
            range,
            created_at_frame: self.created_at_frame,
        }
    }

    fn append_chunks(&mut self, chunks: Vec<StreamingInterimAudioChunk>) {
        self.chunks.extend(chunks);
    }

    fn suffix_prefix_overlap_samples(&self, prefix_audio: &[f32]) -> usize {
        let max_overlap = self.audio_len().min(prefix_audio.len());
        if max_overlap == 0 {
            return 0;
        }
        let suffix_start = self.audio_len() - max_overlap;
        let (suffix_audio, _) = self.audio_and_vad_range(suffix_start, self.audio_len());
        (1..=max_overlap)
            .rev()
            .find(|overlap| {
                suffix_audio[max_overlap - overlap..]
                    .iter()
                    .zip(&prefix_audio[..*overlap])
                    .all(|(left, right)| left.to_bits() == right.to_bits())
            })
            .unwrap_or(0)
    }

    fn audio_and_vad_range(&self, start: usize, end: usize) -> (Vec<f32>, Vec<VadResult>) {
        let end = end.min(self.audio_len());
        if start >= end {
            return (Vec::new(), Vec::new());
        }
        let mut consumed = 0;
        let mut audio = Vec::with_capacity(end - start);
        let mut vad_results = Vec::new();
        for chunk in &self.chunks {
            let chunk_start = consumed;
            let chunk_end = consumed + chunk.audio.len();
            consumed = chunk_end;
            if chunk_end <= start {
                continue;
            }
            if chunk_start >= end {
                break;
            }
            let local_start = start.saturating_sub(chunk_start);
            let local_end = (end - chunk_start).min(chunk.audio.len());
            if local_start < local_end {
                audio.extend_from_slice(&chunk.audio[local_start..local_end]);
                vad_results.push(chunk.vad);
            }
        }
        (audio, vad_results)
    }
}

fn nemotron_interim_chunk_samples() -> usize {
    ASR_SAMPLE_RATE as usize * NEMOTRON_CHUNK_MS / 1_000
}

fn streaming_chunks_from_flattened_audio(
    audio: Vec<f32>,
    vad_results: Vec<VadResult>,
) -> Vec<StreamingInterimAudioChunk> {
    if audio.is_empty() {
        return Vec::new();
    }
    if vad_results.is_empty() {
        return vec![StreamingInterimAudioChunk {
            audio,
            vad: VadResult { probability: 1.0, is_speech: true },
        }];
    }
    let Some(ranges) = even_chunk_ranges(audio.len(), vad_results.len()) else {
        return vec![StreamingInterimAudioChunk {
            audio,
            vad: vad_results
                .last()
                .copied()
                .expect("non-empty VAD results should have a last value"),
        }];
    };
    ranges
        .into_iter()
        .zip(vad_results)
        .filter_map(|(range, vad)| {
            (!range.is_empty())
                .then(|| StreamingInterimAudioChunk { audio: audio[range].to_vec(), vad })
        })
        .collect()
}

fn drop_prefix_from_chunks(
    chunks: Vec<StreamingInterimAudioChunk>,
    mut samples_to_drop: usize,
) -> Vec<StreamingInterimAudioChunk> {
    chunks
        .into_iter()
        .filter_map(|chunk| {
            if samples_to_drop >= chunk.audio.len() {
                samples_to_drop -= chunk.audio.len();
                return None;
            }
            if samples_to_drop == 0 {
                return Some(chunk);
            }
            let audio = chunk.audio[samples_to_drop..].to_vec();
            samples_to_drop = 0;
            (!audio.is_empty()).then_some(StreamingInterimAudioChunk { audio, vad: chunk.vad })
        })
        .collect()
}

fn even_chunk_ranges(audio_len: usize, chunk_count: usize) -> Option<Vec<std::ops::Range<usize>>> {
    if audio_len == 0 || chunk_count == 0 {
        return None;
    }
    let base = audio_len / chunk_count;
    if base == 0 {
        return None;
    }
    let remainder = audio_len % chunk_count;
    let mut start = 0;
    Some(
        (0..chunk_count)
            .map(|index| {
                let len = base + usize::from(index < remainder);
                let end = (start + len).min(audio_len);
                let range = start..end;
                start = end;
                range
            })
            .collect(),
    )
}

pub(in crate::recognition) trait LanguageIdRuntime:
    crate::recognition::transcription::route::language_id::LanguageDetectionWarningSink
{
    fn build_language_id(&self, config: &ParapperConfig) -> Option<Box<dyn LanguageDetector>>;
}

const RETAINED_FINALIZED_TURNS: u64 = 64;

pub(in crate::recognition) struct TurnStore {
    pub(in crate::recognition) turns: HashMap<u64, Turn>,
    pub(in crate::recognition) audio_ranges: HashMap<u64, Vec<AudioRange>>,
    pub(in crate::recognition) revisions: HashMap<u64, u64>,
    pub(in crate::recognition) finalized_turns: HashSet<u64>,
    pub(in crate::recognition) streaming_interim_ranges: HashMap<u64, AudioRange>,
    pub(in crate::recognition) confirmed_until_sample: GlobalSampleIndex,
    pub(in crate::recognition) last_recognition_route: Option<RecognitionRoute>,
    pub(in crate::recognition) open_turn_id: Option<u64>,
    pub(in crate::recognition) open_turn_accepts_root_segment: bool,
    pub(in crate::recognition) open_turn_is_closing: bool,
    pub(in crate::recognition) caption_latency: HashMap<u64, TurnCaptionLatency>,
}

impl TurnStore {
    pub(in crate::recognition) fn mark_finalized(&mut self, turn_id: u64) {
        self.finalized_turns.insert(turn_id);
        let newest_finalized = self.finalized_turns.iter().copied().max().unwrap_or(turn_id);
        let oldest_retained = newest_finalized.saturating_sub(RETAINED_FINALIZED_TURNS - 1);
        self.finalized_turns.retain(|id| *id >= oldest_retained);
        self.revisions.retain(|id, _| *id >= oldest_retained);
    }
}

impl Default for TurnStore {
    fn default() -> Self {
        Self {
            turns: HashMap::new(),
            audio_ranges: HashMap::new(),
            revisions: HashMap::new(),
            finalized_turns: HashSet::new(),
            streaming_interim_ranges: HashMap::new(),
            confirmed_until_sample: GlobalSampleIndex(0),
            last_recognition_route: None,
            open_turn_id: None,
            open_turn_accepts_root_segment: false,
            open_turn_is_closing: false,
            caption_latency: HashMap::new(),
        }
    }
}

pub(in crate::recognition) struct RuntimeCounters {
    pub(in crate::recognition) turn_session_id: u64,
    pub(in crate::recognition) next_turn_id: u64,
    pub(in crate::recognition) next_output_sequence: u64,
    pub(in crate::recognition) next_partial_window_sequence: u64,
    pub(in crate::recognition) next_request_id: u64,
    pub(in crate::recognition) next_vad_frame_index: u64,
    pub(in crate::recognition) next_runtime_tick: u64,
    pub(in crate::recognition) global_sample_cursor: u64,
}

impl RuntimeCounters {
    pub(in crate::recognition) fn new(turn_session_id: u64) -> Self {
        Self {
            turn_session_id,
            next_turn_id: 1,
            next_output_sequence: 1,
            next_partial_window_sequence: 1,
            next_request_id: 1,
            next_vad_frame_index: 0,
            next_runtime_tick: 0,
            global_sample_cursor: 0,
        }
    }
}

#[derive(Default)]
pub(in crate::recognition) struct ActivityState {
    pub(in crate::recognition) segment_activity_epoch: u64,
    pub(in crate::recognition) open_turn_activity_epoch: u64,
    pub(in crate::recognition) open_turn_since_tick: Option<u64>,
    pub(in crate::recognition) vad_was_speech: bool,
    pub(in crate::recognition) pending_speech_onset_at: Option<u64>,
}

#[derive(Default)]
pub(in crate::recognition) struct AsrRequestState {
    pub(in crate::recognition) in_flight_request: Option<AsrRequest>,
    pub(in crate::recognition) pending_rerecognition_purpose: Option<RerecognitionPurpose>,
    pub(in crate::recognition) last_dispatched: Option<AsrInFlight>,
    /// Follow-up rerecognition deferred so same-utterance tail ASR can run first.
    /// Restart once the slot is idle and no max-chunk / streaming chunk remains,
    /// including `TimeoutFinal` / `SimpleTurnCheckFinal` / `GrammarAfterCompletion`.
    pub(in crate::recognition) deferred_rerecognition: Option<(u64, RerecognitionPurpose)>,
    /// End-silence / max-chunk `CompletionCheck` requests deferred so a later
    /// same-utterance 160ms tail can run first. Stack: later tails resume first
    /// so prefix audio prepends in order. Late original results mismatch the
    /// new request id.
    pub(in crate::recognition) deferred_completion: VecDeque<AsrRequest>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn speech_vad() -> VadResult {
        VadResult { probability: 0.99, is_speech: true }
    }

    #[test]
    fn finalized_turn_history_is_bounded() {
        let mut store = TurnStore::default();
        store.finalized_turns.extend(1..=99);
        store.revisions.extend((1..=99).map(|id| (id, 1)));

        store.mark_finalized(100);

        assert_eq!(store.finalized_turns.len(), 64);
        assert_eq!(store.revisions.len(), 63);
        assert!(!store.finalized_turns.contains(&36));
        assert!(store.finalized_turns.contains(&37));
        assert!(store.finalized_turns.contains(&100));
    }

    #[test]
    fn partial_window_uses_only_the_current_segment_and_resets_on_close() {
        let mut state = PartialWindowAsrState::default();
        state.start_segment(
            7,
            Some(6),
            vec![0.1; 100],
            vec![speech_vad()],
            GlobalSampleIndex(1_000),
            VadFrameIndex(3),
            0,
            100,
        );

        assert!(state.matches_segment(7));
        assert!(!state.matches_segment(6));
        assert!(state.take_due(3, 100).is_none());
        let snapshot = state.take_due(4, 100).expect("400 ms tick should be due");
        assert_eq!(snapshot.segment_id, 7);
        assert_eq!(snapshot.previous_segment_id, Some(6));
        assert_eq!(snapshot.audio.len(), 100);

        state.close_segment(7);
        assert!(!state.matches_segment(7));
        assert!(state.take_due(100, 100).is_none());
    }

    #[test]
    fn exact_six_second_cap_consumes_due_tick_as_a_skip_without_dispatch() {
        let mut state = PartialWindowAsrState::default();
        state.start_segment(
            8,
            None,
            vec![0.0; PARTIAL_WINDOW_MAX_AUDIO_SAMPLES],
            vec![speech_vad()],
            GlobalSampleIndex(PARTIAL_WINDOW_MAX_AUDIO_SAMPLES as u64),
            VadFrameIndex(0),
            0,
            100,
        );

        assert!(state.take_due(4, 100).is_none());
        let (_, _, skipped_capped, _, _, _, _, _) = state.metrics();
        assert_eq!(skipped_capped, 1);
        assert_eq!(state.gap_millis(), PARTIAL_WINDOW_MIN_GAP_MS);
    }

    #[test]
    fn decode_duration_sets_adaptive_gap_and_busy_tick_is_not_queued() {
        let mut state = PartialWindowAsrState::default();
        state.start_segment(
            9,
            None,
            vec![0.0; 100],
            vec![speech_vad()],
            GlobalSampleIndex(100),
            VadFrameIndex(0),
            0,
            100,
        );
        state.skip_due_if_busy(4, 100);
        let (_, skipped_busy, _, _, _, _, _, _) = state.metrics();
        assert_eq!(skipped_busy, 1);
        assert!(state.take_due(4, 100).is_none());

        state.record_decode(8, 250, 250, 100, 100);
        let (_, _, _, completed, gap, total, p95, throttle_rate) = state.metrics();
        assert_eq!(completed, 1);
        assert_eq!(gap, 500);
        assert_eq!(total, 250);
        assert_eq!(p95, 250);
        assert!((throttle_rate - 1.0).abs() < f64::EPSILON);
        assert!(state.take_due(12, 100).is_none());
        assert!(state.take_due(13, 100).is_some());
    }

    #[test]
    fn decode_telemetry_tracks_recent_p95_and_throttle_rate() {
        let mut state = PartialWindowAsrState::default();
        for (tick, decode_millis) in [(1, 100), (2, 250), (3, 500)] {
            state.record_decode(tick, decode_millis, decode_millis, 1_600, 100);
        }

        let (_, _, _, completed, _, total, p95, throttle_rate) = state.metrics();
        assert_eq!(completed, 3);
        assert_eq!(total, 850);
        assert_eq!(p95, 500, "p95 must report the high end of recent decode samples");
        assert!(
            (throttle_rate - (2.0 / 3.0)).abs() < f64::EPSILON,
            "only decodes above the 400 ms minimum gap should count as throttled"
        );
    }
}
