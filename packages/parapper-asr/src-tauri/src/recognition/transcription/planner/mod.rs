use std::collections::VecDeque;

use crate::{
    config::ParapperConfig,
    recognition::{
        segmentation::{segment::builder::SegmentCloseReason, vad::engine::VadResult},
        transcription::{
            asr::{
                input::{AsrRequestEdgePadding, ensure_asr_request_edge_silence},
                task::{
                    AsrRequest, AsrRequestId, AsrTarget, AsrTaskKind, AudioRange,
                    GlobalSampleIndex, SegmentId, TurnId, TurnRevision, VadFrameIndex,
                },
            },
            route::RecognitionRouteSelection,
        },
    },
};

#[derive(Clone)]
pub(in crate::recognition) struct PendingAsrSegment {
    pub(in crate::recognition) segment_id: u64,
    pub(in crate::recognition) previous_segment_id: Option<u64>,
    pub(in crate::recognition) audio: Vec<f32>,
    pub(in crate::recognition) vad_results: Vec<VadResult>,
    pub(in crate::recognition) source_audio: Vec<f32>,
    pub(in crate::recognition) source_vad_results: Vec<VadResult>,
    pub(in crate::recognition) reason: SegmentCloseReason,
    pub(in crate::recognition) range: AudioRange,
    pub(in crate::recognition) created_at_frame: VadFrameIndex,
}

impl PendingAsrSegment {
    pub(in crate::recognition) fn kind(&self) -> AsrTaskKind {
        match self.reason {
            SegmentCloseReason::InterimChunkReached
            | SegmentCloseReason::InterimResultSilenceReached => AsrTaskKind::InterimDisplay,
            SegmentCloseReason::EndSilenceReached | SegmentCloseReason::SegmentMaxChunksReached => {
                AsrTaskKind::CompletionCheck
            }
        }
    }

    pub(in crate::recognition) fn turn_id(&self) -> TurnId {
        TurnId(self.previous_segment_id.unwrap_or(self.segment_id))
    }

    pub(in crate::recognition) fn first_segment_id(&self) -> SegmentId {
        SegmentId(self.previous_segment_id.unwrap_or(self.segment_id))
    }

    pub(in crate::recognition) fn last_segment_id(&self) -> SegmentId {
        SegmentId(self.segment_id)
    }

    pub(in crate::recognition) fn is_contiguous_with(&self, next: &Self) -> bool {
        // Breath-chained interims usually abut (`end == next.start`). Production
        // segment-builder padding can also copy prior end-silence into the next
        // segment as ASR-only leading audio, so `next.start` may land *before*
        // `self.end` (overlap) while previous_segment_id still chains them.
        next.previous_segment_id == Some(self.segment_id)
            && self.last_segment_id() <= next.last_segment_id()
            && next.range.start_sample <= self.range.end_sample
            && self.range.end_sample < next.range.end_sample
    }

    /// Fold a contiguous breath-chain interim into one segment so turn-check
    /// promotion can emit a single `CompletionCheck` over the full utterance.
    pub(in crate::recognition) fn merge_contiguous_interim(mut self, next: Self) -> Self {
        debug_assert!(self.is_contiguous_with(&next));
        let first_segment_id = self.first_segment_id().0;
        let overlap_samples = samples_between(next.range.start_sample, self.range.end_sample);
        let source_overlap = overlap_samples.saturating_sub(leading_padding_covered_by_overlap(
            overlap_samples,
            next.audio.len(),
            next.source_audio.len(),
        ));
        let (next_audio, next_vad) =
            trim_leading_samples(next.audio, next.vad_results, overlap_samples);
        let (next_source_audio, next_source_vad) =
            trim_leading_samples(next.source_audio, next.source_vad_results, source_overlap);
        self.audio.extend(next_audio);
        self.vad_results.extend(next_vad);
        self.source_audio.extend(next_source_audio);
        self.source_vad_results.extend(next_source_vad);
        self.range = self.range.merge(next.range);
        self.segment_id = next.segment_id;
        self.previous_segment_id =
            (first_segment_id != self.segment_id).then_some(first_segment_id);
        self.reason = next.reason;
        self
    }
}

fn samples_between(start: GlobalSampleIndex, end: GlobalSampleIndex) -> usize {
    usize::try_from(end.0.saturating_sub(start.0)).unwrap_or(usize::MAX)
}

fn leading_padding_covered_by_overlap(
    overlap_samples: usize,
    audio_len: usize,
    source_len: usize,
) -> usize {
    // When request/full audio is longer than source audio, the prefix is ASR-only
    // padding copied from the previous segment. Geometric overlap that falls inside
    // that padding must not trim continued speech from source_audio.
    audio_len.saturating_sub(source_len).min(overlap_samples)
}

fn trim_leading_samples(
    mut audio: Vec<f32>,
    mut vad_results: Vec<VadResult>,
    skip_samples: usize,
) -> (Vec<f32>, Vec<VadResult>) {
    if skip_samples == 0 || audio.is_empty() {
        return (audio, vad_results);
    }
    let skip = skip_samples.min(audio.len());
    audio.drain(..skip);
    if !vad_results.is_empty() && audio.is_empty() {
        vad_results.clear();
    }
    (audio, vad_results)
}

pub(in crate::recognition) struct AsrRequestSegmentPlan {
    pub(in crate::recognition) kind: AsrTaskKind,
    segments: Vec<PendingAsrSegment>,
}

impl AsrRequestSegmentPlan {
    pub(in crate::recognition) fn target_turn_id(
        &self,
        config: &ParapperConfig,
        open_turn_id: Option<u64>,
        open_turn_accepts_root_segment: bool,
    ) -> u64 {
        let first =
            self.segments.first().expect("ASR request plan requires at least one pending segment");
        if !config.can_connect_interim_after_completion() && first.previous_segment_id.is_none() {
            return first.segment_id;
        }
        if first.previous_segment_id.is_none() && !open_turn_accepts_root_segment {
            // Production Nemotron 160ms / max-chunk restart as a new root after
            // EndSilence flushes the stream. Keep them on the still-open
            // utterance instead of reminting a same-turn tail. After a
            // next-utterance remint, that open id is the new turn.
            if matches!(
                first.reason,
                SegmentCloseReason::InterimChunkReached
                    | SegmentCloseReason::SegmentMaxChunksReached
            ) && let Some(open_turn_id) = open_turn_id
            {
                return open_turn_id;
            }
            return first.segment_id;
        }
        open_turn_id.unwrap_or_else(|| first.turn_id().0)
    }

    pub(in crate::recognition) fn first_segment_id(&self) -> u64 {
        self.first().segment_id
    }

    #[cfg(test)]
    pub(in crate::recognition) fn audio(&self) -> Vec<f32> {
        let mut audio = Vec::new();
        for segment in &self.segments {
            audio.extend_from_slice(&segment.audio);
        }
        audio
    }

    pub(in crate::recognition) fn source_audio(&self) -> Vec<f32> {
        let mut audio = Vec::new();
        for segment in &self.segments {
            audio.extend_from_slice(&segment.source_audio);
        }
        audio
    }

    pub(in crate::recognition) fn first_reason(&self) -> SegmentCloseReason {
        self.first().reason
    }

    pub(in crate::recognition) fn range(&self) -> AudioRange {
        self.first().range.merge(self.last().range)
    }

    pub(in crate::recognition) fn into_request(
        self,
        config: &ParapperConfig,
        request_id: AsrRequestId,
        target_turn_id: u64,
        target_revision: u64,
        route_selection: RecognitionRouteSelection,
    ) -> AsrRequest {
        let first = self.first();
        let last = self.last();
        let close_reason = first.reason;
        let created_at_frame = first.created_at_frame;
        let target = AsrTarget::new(
            TurnId(target_turn_id),
            TurnRevision(target_revision),
            first.range.merge(last.range),
            Some(first.first_segment_id()),
            Some(last.last_segment_id()),
        );
        let mut audio = Vec::new();
        let mut vad_results = Vec::new();
        let mut source_audio = Vec::new();
        let mut source_vad_results = Vec::new();
        for segment in self.segments {
            audio.extend_from_slice(&segment.audio);
            vad_results.extend_from_slice(&segment.vad_results);
            source_audio.extend_from_slice(&segment.source_audio);
            source_vad_results.extend_from_slice(&segment.source_vad_results);
        }
        if self.kind == AsrTaskKind::InterimDisplay && !route_selection.route.model.is_nemotron() {
            ensure_asr_request_edge_silence(
                config,
                &mut audio,
                &mut vad_results,
                AsrRequestEdgePadding::LeadingAndTrailing,
            );
        }
        AsrRequest {
            request_id,
            kind: self.kind,
            target,
            route: route_selection.route,
            detected_language: route_selection.detected_language,
            audio,
            vad_results,
            source_audio,
            source_vad_results,
            close_reason: Some(close_reason),
            created_at_frame,
        }
    }

    fn first(&self) -> &PendingAsrSegment {
        self.segments.first().expect("ASR request plan requires at least one pending segment")
    }

    fn last(&self) -> &PendingAsrSegment {
        self.segments.last().expect("ASR request plan requires at least one pending segment")
    }
}

pub(in crate::recognition) fn drop_front_interim_segments_covered_by_completion(
    pending: &mut VecDeque<PendingAsrSegment>,
) {
    while let Some(front) = pending.front() {
        if front.kind() != AsrTaskKind::InterimDisplay {
            break;
        }
        // Nemotron streaming chunks carry the utterance tail. Never skip them
        // just because a later Reazon completion covers the same sample range.
        if front.reason == SegmentCloseReason::InterimChunkReached {
            break;
        }
        let Some(covering_completion_index) = pending
            .iter()
            .skip(1)
            .position(|candidate| {
                candidate.kind() == AsrTaskKind::CompletionCheck
                    && candidate.turn_id() == front.turn_id()
                    && candidate.range.contains(front.range)
            })
            .map(|index_after_front| index_after_front + 1)
        else {
            break;
        };

        let covering_completion = pending
            .remove(covering_completion_index)
            .expect("covering completion should still be present");
        while pending.front().is_some_and(|candidate| {
            candidate.kind() == AsrTaskKind::InterimDisplay
                && candidate.reason != SegmentCloseReason::InterimChunkReached
                && candidate.turn_id() == covering_completion.turn_id()
                && covering_completion.range.contains(candidate.range)
        }) {
            pending.pop_front();
        }
        pending.push_front(covering_completion);
    }
}

pub(in crate::recognition) fn take_next_request_segment_plan(
    config: &ParapperConfig,
    pending: &mut VecDeque<PendingAsrSegment>,
    open_turn_id: Option<u64>,
) -> Option<AsrRequestSegmentPlan> {
    let first = pending.pop_front()?;
    let kind = first.kind();
    let mut segments = vec![first];

    match kind {
        AsrTaskKind::CompletionCheck if config.can_connect_interim_after_completion() => {
            take_following_interim_segments(pending, &mut segments, open_turn_id);
        }
        AsrTaskKind::InterimDisplay => {
            take_following_interim_segments(pending, &mut segments, open_turn_id);
        }
        AsrTaskKind::CompletionCheck | AsrTaskKind::Rerecognition => {}
    }

    Some(AsrRequestSegmentPlan { kind, segments })
}

fn take_following_interim_segments(
    pending: &mut VecDeque<PendingAsrSegment>,
    segments: &mut Vec<PendingAsrSegment>,
    open_turn_id: Option<u64>,
) {
    while let Some(next) = pending.front() {
        let Some(last) = segments.last() else {
            break;
        };
        if next.kind() != AsrTaskKind::InterimDisplay || !last.is_contiguous_with(next) {
            break;
        }
        // Nemotron 160ms chunks are a fixed ASR grid. Folding a later chunk
        // into this request would run 320ms as one worker call and drop the
        // second tick. Breath-chained InterimResultSilenceReached can still merge
        // onto a root max-chunk CompletionCheck when no turn is open yet
        // (same-utterance join). After remint the open turn already exists, so a
        // stream-reset root max-chunk must not swallow the following
        // AfterInterimSilence InterimDisplay. EndSilence and a child max-chunk
        // also keep that silence off CompletionCheck.
        if last.reason == SegmentCloseReason::InterimChunkReached
            || next.reason == SegmentCloseReason::InterimChunkReached
            || last.reason == SegmentCloseReason::EndSilenceReached
            || (last.reason == SegmentCloseReason::SegmentMaxChunksReached
                && last.previous_segment_id.is_some())
            || (last.reason == SegmentCloseReason::SegmentMaxChunksReached
                && last.previous_segment_id.is_none()
                && open_turn_id.is_some())
        {
            break;
        }
        let next = pending.pop_front().expect("front pending segment should still exist");
        segments.push(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::TurnDetector,
        recognition::transcription::asr::task::{GlobalSampleIndex, VadFrameIndex},
    };

    #[test]
    fn request_plan_stops_at_non_contiguous_segment() {
        let mut pending = VecDeque::from([
            pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..10),
            pending_segment(2, Some(99), SegmentCloseReason::InterimResultSilenceReached, 10..20),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("first interim request should be planned");

        assert_eq!(plan.kind, AsrTaskKind::InterimDisplay);
        assert_eq!(plan.audio(), vec![1.0; 10]);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.front().map(|segment| segment.segment_id), Some(2));
    }

    #[test]
    fn request_plan_does_not_merge_contiguous_160ms_chunks() {
        let mut pending = VecDeque::from([
            pending_segment(2, Some(1), SegmentCloseReason::InterimChunkReached, 150..310),
            pending_segment(3, Some(2), SegmentCloseReason::InterimChunkReached, 310..470),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("first 160ms chunk should be planned");

        assert_eq!(plan.kind, AsrTaskKind::InterimDisplay);
        assert_eq!(plan.first_reason(), SegmentCloseReason::InterimChunkReached);
        assert_eq!(plan.range().start_sample, GlobalSampleIndex(150));
        assert_eq!(plan.range().end_sample, GlobalSampleIndex(310));
        assert_eq!(plan.audio().len(), 160);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.front().map(|segment| segment.segment_id), Some(3));
    }

    #[test]
    fn request_plan_does_not_fold_160ms_into_end_silence_completion() {
        let mut pending = VecDeque::from([
            pending_segment(1, None, SegmentCloseReason::EndSilenceReached, 0..150),
            pending_segment(2, Some(1), SegmentCloseReason::InterimChunkReached, 150..310),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("end-silence completion should be planned");

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.audio().len(), 150);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.front().map(|segment| segment.segment_id), Some(2));
    }

    #[test]
    fn request_plan_does_not_fold_after_interim_silence_into_end_silence_completion() {
        let mut pending = VecDeque::from([
            pending_segment(3, Some(2), SegmentCloseReason::EndSilenceReached, 310..410),
            pending_segment(4, Some(3), SegmentCloseReason::InterimResultSilenceReached, 410..510),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("end-silence completion should be planned");

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.first_reason(), SegmentCloseReason::EndSilenceReached);
        assert_eq!(plan.range().start_sample, GlobalSampleIndex(310));
        assert_eq!(plan.range().end_sample, GlobalSampleIndex(410));
        assert_eq!(plan.audio().len(), 100);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().map(|segment| (segment.segment_id, segment.reason)),
            Some((4, SegmentCloseReason::InterimResultSilenceReached))
        );
    }

    #[test]
    fn request_plan_does_not_fold_after_interim_silence_into_child_max_chunk_completion() {
        let mut pending = VecDeque::from([
            pending_segment(4, Some(3), SegmentCloseReason::SegmentMaxChunksReached, 410..510),
            pending_segment(5, Some(4), SegmentCloseReason::InterimResultSilenceReached, 510..610),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("child max-chunk completion should be planned");

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.first_reason(), SegmentCloseReason::SegmentMaxChunksReached);
        assert_eq!(plan.range().start_sample, GlobalSampleIndex(410));
        assert_eq!(plan.range().end_sample, GlobalSampleIndex(510));
        assert_eq!(plan.audio().len(), 100);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().map(|segment| (segment.segment_id, segment.reason)),
            Some((5, SegmentCloseReason::InterimResultSilenceReached))
        );
    }

    #[test]
    fn request_plan_still_joins_after_interim_silence_onto_root_max_chunk() {
        let mut pending = VecDeque::from([
            pending_segment(1, None, SegmentCloseReason::SegmentMaxChunksReached, 0..100),
            pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 100..200),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            None,
        )
        .expect("root max-chunk completion should be planned");

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.first_reason(), SegmentCloseReason::SegmentMaxChunksReached);
        assert_eq!(plan.range().start_sample, GlobalSampleIndex(0));
        assert_eq!(plan.range().end_sample, GlobalSampleIndex(200));
        assert_eq!(plan.audio().len(), 200);
        assert!(pending.is_empty());
    }

    #[test]
    fn request_plan_does_not_fold_after_interim_silence_into_root_max_chunk_when_turn_is_open() {
        let mut pending = VecDeque::from([
            pending_segment(4, None, SegmentCloseReason::SegmentMaxChunksReached, 410..510),
            pending_segment(5, Some(4), SegmentCloseReason::InterimResultSilenceReached, 510..610),
        ]);

        let plan = take_next_request_segment_plan(
            &parapper_config! {
                turn_detector: TurnDetector::Namo,
                ..ParapperConfig::default()
            },
            &mut pending,
            Some(2),
        )
        .expect("root max-chunk completion should be planned");

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.first_reason(), SegmentCloseReason::SegmentMaxChunksReached);
        assert_eq!(plan.range().start_sample, GlobalSampleIndex(410));
        assert_eq!(plan.range().end_sample, GlobalSampleIndex(510));
        assert_eq!(plan.audio().len(), 100);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().map(|segment| (segment.segment_id, segment.reason)),
            Some((5, SegmentCloseReason::InterimResultSilenceReached))
        );
    }

    #[test]
    fn merge_contiguous_interim_preserves_first_last_segment_ids_and_audio() {
        let left = pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..10);
        let right =
            pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 10..25);
        assert!(left.is_contiguous_with(&right));

        let merged = left.merge_contiguous_interim(right);
        assert_eq!(merged.first_segment_id().0, 1);
        assert_eq!(merged.last_segment_id().0, 2);
        assert_eq!(merged.turn_id().0, 1);
        assert_eq!(merged.range.start_sample, GlobalSampleIndex(0));
        assert_eq!(merged.range.end_sample, GlobalSampleIndex(25));
        assert_eq!(merged.source_audio, [vec![1.0; 10], vec![2.0; 15]].concat());
        assert_eq!(merged.reason, SegmentCloseReason::InterimResultSilenceReached);
    }

    #[test]
    fn merge_contiguous_interim_trims_padding_overlap_without_dropping_source_speech() {
        let left =
            pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..100);
        let mut right =
            pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 80..200);
        // 20-sample geometric overlap is only ASR-only leading padding on `audio`.
        right.audio = [vec![0.0; 20], vec![2.0; 100]].concat();
        right.source_audio = vec![2.0; 100];
        right.source_vad_results = vec![VadResult { probability: 0.9, is_speech: true }];
        assert!(left.is_contiguous_with(&right));

        let merged = left.merge_contiguous_interim(right);
        assert_eq!(merged.range.start_sample, GlobalSampleIndex(0));
        assert_eq!(merged.range.end_sample, GlobalSampleIndex(200));
        assert_eq!(merged.audio, [vec![1.0; 100], vec![2.0; 100]].concat());
        assert_eq!(
            merged.source_audio,
            [vec![1.0; 100], vec![2.0; 100]].concat(),
            "ASR-only leading padding overlap must not trim the next segment's source speech"
        );
    }

    #[test]
    fn covered_front_interim_segments_are_replaced_by_covering_completion() {
        let mut pending = VecDeque::from([
            pending_segment(1, None, SegmentCloseReason::InterimResultSilenceReached, 0..10),
            pending_segment(2, Some(1), SegmentCloseReason::InterimResultSilenceReached, 10..20),
            pending_segment(2, Some(1), SegmentCloseReason::EndSilenceReached, 0..20),
        ]);

        drop_front_interim_segments_covered_by_completion(&mut pending);
        let plan =
            take_next_request_segment_plan(&ParapperConfig::default(), &mut pending, None).unwrap();

        assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
        assert_eq!(plan.audio(), vec![2.0; 20]);
        assert!(pending.is_empty());
    }

    #[test]
    fn turn_detector_does_not_fold_after_interim_silence_into_end_silence() {
        for turn_detector in [TurnDetector::Namo, TurnDetector::Simple] {
            let mut pending = VecDeque::from([
                pending_segment(1, None, SegmentCloseReason::EndSilenceReached, 0..10),
                pending_segment(
                    2,
                    Some(1),
                    SegmentCloseReason::InterimResultSilenceReached,
                    10..20,
                ),
            ]);

            let plan = take_next_request_segment_plan(
                &parapper_config! {
                    turn_detector: turn_detector,
                    ..ParapperConfig::default()
                },
                &mut pending,
                None,
            )
            .expect("completion request should be planned");

            assert_eq!(plan.kind, AsrTaskKind::CompletionCheck);
            assert_eq!(plan.audio().len(), 10, "turn_detector={turn_detector:?}");
            assert_eq!(pending.len(), 1, "turn_detector={turn_detector:?}");
        }
    }

    fn pending_segment(
        segment_id: u64,
        previous_segment_id: Option<u64>,
        reason: SegmentCloseReason,
        range: std::ops::Range<u64>,
    ) -> PendingAsrSegment {
        let sample_value =
            f32::from(u16::try_from(segment_id).expect("test segment id should fit u16"));
        let audio = vec![
            sample_value;
            usize::try_from(range.end - range.start)
                .expect("test range should fit usize")
        ];
        let vad_results = vec![VadResult { probability: 0.9, is_speech: true }];
        PendingAsrSegment {
            segment_id,
            previous_segment_id,
            source_audio: audio.clone(),
            source_vad_results: vad_results.clone(),
            audio,
            vad_results,
            reason,
            range: AudioRange::new(GlobalSampleIndex(range.start), GlobalSampleIndex(range.end)),
            created_at_frame: VadFrameIndex(segment_id),
        }
    }
}
