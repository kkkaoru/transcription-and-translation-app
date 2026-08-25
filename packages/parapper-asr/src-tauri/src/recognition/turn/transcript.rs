use caption_bridge_japanese_text::{
    completion_appended_suffix_is_repeated, strip_turn_surface_noise,
};

use crate::{
    audio::ASR_SAMPLE_RATE,
    recognition::{
        control::{RecognitionSession, RerecognitionPurpose},
        segmentation::segment::builder::SegmentCloseReason,
        segmentation::vad::engine::VadResult,
        transcription::asr::{
            engine::AsrTranscript,
            task::{AsrRequest, AsrTaskKind, AudioRange, GlobalSampleIndex},
        },
        turn::{
            Turn, boundary::candidates_for_transcript, boundary::candidates_for_visible_draft,
            turn_event_id,
        },
    },
};

impl RecognitionSession {
    #[expect(
        clippy::too_many_lines,
        reason = "segment transcript merge keeps replace/append and streaming-overlap paths together"
    )]
    #[expect(
        clippy::needless_pass_by_value,
        reason = "callers transfer ownership of the ASR transcript at the session boundary"
    )]
    pub(in crate::recognition) fn apply_segment_transcript(
        &mut self,
        request: &AsrRequest,
        transcript: AsrTranscript,
        elapsed_millis: u128,
    ) -> u64 {
        let turn_id = request.target.turn_id.0;
        self.counters.next_turn_id = self.counters.next_turn_id.max(turn_id.saturating_add(1));
        let completion_replaces_streaming_interim =
            self.completion_replaces_streaming_interim(turn_id, request);
        let streaming_interim_overlap = (!completion_replaces_streaming_interim)
            .then(|| self.streaming_interim_completion_overlap(turn_id, request))
            .flatten();
        let completion_is_duplicate_tail = streaming_interim_overlap.is_some_and(|overlap| {
            !vad_has_speech_after_sample(
                request.source_audio.len(),
                &request.source_vad_results,
                overlap.source_samples,
            )
        });
        let existing_audio_ranges =
            self.turn_store.audio_ranges.get(&turn_id).cloned().unwrap_or_default();
        let streaming_source_skip = streaming_chunk_uncovered_source_start(
            request.close_reason,
            &request.source_audio,
            &request.audio,
        );
        if request.close_reason == Some(SegmentCloseReason::InterimChunkReached) {
            self.merge_contiguous_turn_audio_range(
                turn_id,
                applied_streaming_chunk_range(request, streaming_source_skip),
            );
        } else if request.kind != AsrTaskKind::CompletionCheck {
            self.merge_contiguous_turn_audio_range(turn_id, request.target.range);
        }
        if completion_is_duplicate_tail {
            if request.kind == AsrTaskKind::CompletionCheck {
                self.refresh_visible_draft_boundary_from_completion(turn_id, &transcript);
            }
            return turn_id;
        }
        let mut completion_range_to_merge = None;
        {
            let revision = *self.turn_store.revisions.entry(turn_id).or_insert(0);
            let turn = self.turn_store.turns.entry(turn_id).or_insert_with(|| {
                Turn::new(turn_event_id(self.counters.turn_session_id, turn_id, revision), revision)
            });
            let draft = turn.draft_mut();
            draft.set_detected_language(request.detected_language.clone());
            let segment_id = request
                .target
                .last_segment_id
                .map_or(request.target.turn_id.0, |segment_id| segment_id.0);
            let previous_segment_id = request.target.first_segment_id.and_then(|segment_id| {
                (Some(segment_id) != request.target.last_segment_id).then_some(segment_id.0)
            });
            let latest_segment_audio_is_prefix = || {
                let Some(latest_audio_len) = draft.segment_audio_lens.last().copied() else {
                    return false;
                };
                if latest_audio_len > request.source_audio.len()
                    || latest_audio_len > draft.full_audio.len()
                {
                    return false;
                }
                let latest_start = draft.full_audio.len() - latest_audio_len;
                draft.full_audio[latest_start..]
                    .iter()
                    .zip(request.source_audio.iter())
                    .take(latest_audio_len)
                    .all(|(left, right)| left.to_bits() == right.to_bits())
            };
            let replace_latest_segment = draft.latest_segment_id == Some(segment_id)
                && latest_segment_audio_is_prefix()
                && (request.close_reason == Some(SegmentCloseReason::InterimChunkReached)
                    || request.kind == AsrTaskKind::CompletionCheck)
                || completion_replaces_streaming_interim;
            // Dual-ASR: ReazonSpeech completion can truncate a longer Nemotron draft
            // ("…ですね" tails vanish). Keep the longer streaming surface when the
            // completion is clearly a prefix truncation; still swap to completion audio.
            let incoming_text = if completion_replaces_streaming_interim
                && prefer_streaming_interim_text_over_truncated_completion(
                    &draft.combined_text,
                    &transcript.text,
                ) {
                draft.combined_text.clone()
            } else {
                text_after_audio_overlap(
                    &transcript,
                    streaming_interim_overlap
                        .map_or(0, |overlap| overlap.samples_for_transcript_tokens(&transcript)),
                )
            };
            let existing_text = draft.combined_text.clone();
            let completion_append =
                request.kind == AsrTaskKind::CompletionCheck && !replace_latest_segment;
            let replace_combined_with_longer_rewrite = completion_append
                && completion_is_full_longer_rewrite(&existing_text, &incoming_text);
            let skip_duplicate_completion_text = completion_append
                && (replace_combined_with_longer_rewrite
                    || completion_text_duplicates_existing(&existing_text, &incoming_text));
            let skip_blank_completion_append = completion_append
                && !replace_combined_with_longer_rewrite
                && (skip_duplicate_completion_text || completion_incoming_is_blank(&incoming_text));
            let recorded_text = if replace_latest_segment {
                let incoming = visible_text_for_blank_replace(
                    &incoming_text,
                    draft.segment_texts.last().map(String::as_str),
                    &existing_text,
                    draft.last_emitted_interim_text.as_deref(),
                    draft.segment_texts.len(),
                );
                if request.close_reason == Some(SegmentCloseReason::InterimChunkReached) {
                    streaming_chunk_text_keeping_visible_prefix(&existing_text, &incoming)
                } else {
                    incoming
                }
            } else if skip_duplicate_completion_text || skip_blank_completion_append {
                // Keep the visible utterance in combined_text. Appending the same
                // (or truncated) completion string doubled the final when
                // rerecognition did not run to replace the draft.
                String::new()
            } else {
                incoming_text.clone()
            };
            let earlier_prefix_segment_id = completion_earlier_segment_id(
                &draft.segment_ids,
                draft.latest_segment_id,
                request,
                segment_id,
            );
            let prefix_len = prefix_source_len_before_existing(&existing_audio_ranges, request);
            if completion_prefix_is_before_existing_range(&existing_audio_ranges, request)
                && prefix_len > 0
            {
                let prefix_audio = &request.source_audio[..prefix_len];
                let prefix_vad = vad_prefix_until_sample(
                    request.source_audio.len(),
                    &request.source_vad_results,
                    prefix_len,
                );
                draft.prepend_recognized_segment(
                    segment_id,
                    previous_segment_id,
                    prefix_audio,
                    &prefix_vad,
                    request.route,
                    recorded_text,
                    elapsed_millis,
                );
                completion_range_to_merge = Some(AudioRange::new(
                    request.target.range.start_sample,
                    GlobalSampleIndex(
                        request.target.range.start_sample.0.saturating_add(prefix_len as u64),
                    ),
                ));
            } else if let Some(prefix_segment_id) = earlier_prefix_segment_id {
                if !recorded_text.is_empty() {
                    let keep_visible_prefix = draft
                        .segment_ids
                        .iter()
                        .position(|id| *id == prefix_segment_id)
                        .and_then(|index| draft.segment_texts.get(index))
                        .is_some_and(|visible| {
                            prefer_streaming_interim_text_over_truncated_completion(
                                visible,
                                &incoming_text,
                            )
                        });
                    if !keep_visible_prefix {
                        draft.replace_segment_text_preserving_audio(
                            prefix_segment_id,
                            request.route,
                            incoming_text.clone(),
                            elapsed_millis,
                        );
                    }
                }
            } else if replace_latest_segment {
                draft.replace_latest_recognized_segment(
                    segment_id,
                    previous_segment_id,
                    &request.source_audio,
                    &request.source_vad_results,
                    request.route,
                    recorded_text,
                    elapsed_millis,
                );
                completion_range_to_merge = Some(request.target.range);
            } else {
                let append_source_start = if let Some(overlap) = streaming_interim_overlap {
                    overlap.source_samples
                } else {
                    let range_skip =
                        covered_completion_source_samples(&existing_audio_ranges, request);
                    let prefix_skip = if request.kind == AsrTaskKind::CompletionCheck {
                        uncovered_completion_source_start(
                            &draft.full_audio,
                            &request.source_audio,
                            draft.segment_audio_lens.last().copied().unwrap_or(0),
                        )
                    } else {
                        0
                    };
                    range_skip.max(prefix_skip).max(streaming_source_skip)
                };
                let append_vad_results;
                let source_vad_results = if append_source_start == 0 {
                    request.source_vad_results.as_slice()
                } else {
                    append_vad_results = vad_suffix_after_sample(
                        request.source_audio.len(),
                        &request.source_vad_results,
                        append_source_start,
                    );
                    append_vad_results.as_slice()
                };
                let uncovered_audio = &request.source_audio[append_source_start..];
                if skip_blank_completion_append {
                    // Blank or duplicate completion used to push an empty segment and
                    // advance latest_segment_id, so later silence/overlap checks missed
                    // the still-open utterance. Keep uncovered tail audio on the current
                    // segment instead.
                    if uncovered_audio.is_empty() || draft.latest_segment_id.is_none() {
                        draft.route = Some(request.route);
                        draft.processing_millis += elapsed_millis;
                    } else {
                        draft.extend_latest_segment_audio(
                            uncovered_audio,
                            source_vad_results,
                            request.route,
                            elapsed_millis,
                        );
                    }
                } else {
                    draft.append_recognized_segment(
                        segment_id,
                        previous_segment_id,
                        uncovered_audio,
                        source_vad_results,
                        request.route,
                        recorded_text,
                        elapsed_millis,
                    );
                    if replace_combined_with_longer_rewrite {
                        draft.replace_text_preserving_sources(request.route, incoming_text, 0);
                    }
                }
                completion_range_to_merge =
                    uncovered_completion_audio_range(request, append_source_start);
            }
        }
        if let Some(range) = completion_range_to_merge {
            self.merge_contiguous_turn_audio_range(turn_id, range);
        }
        if request.close_reason == Some(SegmentCloseReason::InterimChunkReached) {
            let applied_range = applied_streaming_chunk_range(request, streaming_source_skip);
            match self.turn_store.streaming_interim_ranges.entry(turn_id) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let current = *entry.get();
                    if ranges_are_contiguous(current, applied_range) {
                        entry.insert(current.merge(applied_range));
                    } else {
                        // A hole after a Reazon prefix must not inflate coverage to 0..emitted.
                        entry.insert(applied_range);
                    }
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(applied_range);
                }
            }
        } else if completion_replaces_streaming_interim {
            self.turn_store.streaming_interim_ranges.remove(&turn_id);
        }
        self.turn_store.last_recognition_route = Some(request.route);
        if request.kind == AsrTaskKind::CompletionCheck {
            self.refresh_visible_draft_boundary_from_completion(turn_id, &transcript);
        }
        turn_id
    }

    pub(in crate::recognition) fn park_yielded_max_chunk_audio_on_draft(
        &mut self,
        request: &AsrRequest,
    ) {
        if request.kind != AsrTaskKind::CompletionCheck
            || request.close_reason != Some(SegmentCloseReason::SegmentMaxChunksReached)
        {
            return;
        }
        let turn_id = request.target.turn_id.0;
        let existing_audio_ranges =
            self.turn_store.audio_ranges.get(&turn_id).cloned().unwrap_or_default();
        // A later 160ms may start inside this max-chunk (segment-builder padding).
        // Park only the uncovered prefix; the overlapping samples belong to the
        // 160ms grid so they are not double-counted when the chunk appends.
        let park_end = self
            .pending_streaming_chunk_start_sample()
            .filter(|chunk_start| {
                *chunk_start > request.target.range.start_sample
                    && *chunk_start < request.target.range.end_sample
            })
            .unwrap_or(request.target.range.end_sample);
        let park_range = AudioRange::new(request.target.range.start_sample, park_end);
        if park_end > request.target.range.start_sample {
            self.merge_turn_audio_range(turn_id, park_range);
        }
        let revision = *self.turn_store.revisions.entry(turn_id).or_insert(0);
        let turn = self.turn_store.turns.entry(turn_id).or_insert_with(|| {
            Turn::new(turn_event_id(self.counters.turn_session_id, turn_id, revision), revision)
        });
        let draft = turn.draft_mut();
        draft.set_detected_language(request.detected_language.clone());
        let segment_id = request
            .target
            .last_segment_id
            .map_or(request.target.turn_id.0, |segment_id| segment_id.0);
        let previous_segment_id = request.target.first_segment_id.and_then(|segment_id| {
            (Some(segment_id) != request.target.last_segment_id).then_some(segment_id.0)
        });
        let range_skip = covered_completion_source_samples(&existing_audio_ranges, request);
        let prefix_skip = uncovered_completion_source_start(
            &draft.full_audio,
            &request.source_audio,
            draft.segment_audio_lens.last().copied().unwrap_or(0),
        );
        let park_source_len = samples_between(request.target.range.start_sample, park_end)
            .min(request.source_audio.len());
        let append_source_start = range_skip.max(prefix_skip).min(park_source_len);
        if append_source_start < park_source_len {
            let parked_vad = vad_prefix_until_sample(
                request.source_audio.len(),
                &request.source_vad_results,
                park_source_len,
            );
            let uncovered_vad = if append_source_start == 0 {
                parked_vad
            } else {
                vad_suffix_after_sample(park_source_len, &parked_vad, append_source_start)
            };
            let uncovered_audio = &request.source_audio[append_source_start..park_source_len];
            if draft.latest_segment_id == Some(segment_id) {
                draft.extend_latest_segment_audio(
                    uncovered_audio,
                    uncovered_vad.as_slice(),
                    request.route,
                    0,
                );
            } else {
                draft.append_recognized_segment(
                    segment_id,
                    previous_segment_id,
                    uncovered_audio,
                    uncovered_vad.as_slice(),
                    request.route,
                    String::new(),
                    0,
                );
            }
        } else if park_source_len == 0 && draft.latest_segment_id != Some(segment_id) {
            // Full overlap with the later 160ms: keep a placeholder so resume
            // can attach max-chunk text before the uncovered tail.
            draft.append_recognized_segment(
                segment_id,
                previous_segment_id,
                &[],
                &[],
                request.route,
                String::new(),
                0,
            );
        }
        self.adopt_open_turn_after_completion(turn_id);
    }

    fn pending_streaming_chunk_start_sample(&self) -> Option<GlobalSampleIndex> {
        self.pending
            .asr_segments
            .iter()
            .filter(|segment| segment.reason == SegmentCloseReason::InterimChunkReached)
            .map(|segment| segment.range.start_sample)
            .min()
    }

    fn refresh_visible_draft_boundary_from_completion(
        &mut self,
        turn_id: u64,
        completion: &AsrTranscript,
    ) {
        if !matches!(
            self.rerecognition_purpose_after_completion(),
            Some(RerecognitionPurpose::GrammarAfterCompletion)
        ) {
            return;
        }
        self.refresh_visible_draft_boundary_candidates(turn_id, Some(completion));
    }

    pub(in crate::recognition) fn ensure_visible_draft_boundary_candidates(
        &mut self,
        turn_id: u64,
    ) {
        if self
            .turn_store
            .turns
            .get(&turn_id)
            .is_some_and(|turn| !turn.draft().boundary_candidates.is_empty())
        {
            return;
        }
        self.refresh_visible_draft_boundary_candidates(turn_id, None);
    }

    fn refresh_visible_draft_boundary_candidates(
        &mut self,
        turn_id: u64,
        completion: Option<&AsrTranscript>,
    ) {
        let Some((language, text, audio, vad_results)) =
            self.turn_store.turns.get(&turn_id).and_then(|turn| {
                let draft = turn.draft();
                Some((
                    draft.route?.language,
                    draft.combined_text.clone(),
                    draft.full_audio.clone(),
                    draft.vad_results.clone(),
                ))
            })
        else {
            return;
        };
        let token_aligned =
            completion.filter(|transcript| transcript.text == text).and_then(|transcript| {
                let candidates = candidates_for_transcript(
                    language,
                    transcript,
                    &audio,
                    &vad_results,
                    self.io.japanese_morph.as_ref(),
                );
                (!candidates.is_empty()).then_some(candidates)
            });
        let candidates = token_aligned.unwrap_or_else(|| {
            candidates_for_visible_draft(
                language,
                &text,
                &audio,
                &vad_results,
                self.io.japanese_morph.as_ref(),
            )
        });
        if let Some(turn) = self.turn_store.turns.get_mut(&turn_id) {
            turn.draft_mut().boundary_candidates = candidates;
        }
    }

    fn completion_replaces_streaming_interim(&self, turn_id: u64, request: &AsrRequest) -> bool {
        if request.kind != AsrTaskKind::CompletionCheck
            || request.close_reason != Some(SegmentCloseReason::EndSilenceReached)
        {
            return false;
        }
        let Some(streaming_range) = self.turn_store.streaming_interim_ranges.get(&turn_id).copied()
        else {
            return false;
        };
        if request.target.range.start_sample >= streaming_range.end_sample {
            return false;
        }
        if request.target.range.start_sample > streaming_range.start_sample {
            return false;
        }
        // A wide 0..emitted CompletionCheck must not replace the latest 160ms
        // delta with cumulative source that restacks the already-present tail.
        if request.target.range.start_sample < streaming_range.start_sample {
            return false;
        }
        // A prefix CompletionCheck that only covers the Reazon window must not
        // replace a later 160ms delta just because the chunk's cumulative range
        // was 0..emitted.
        if request.target.range.end_sample < streaming_range.end_sample {
            return false;
        }
        let Some(draft) = self.turn_store.turns.get(&turn_id).map(Turn::draft) else {
            return false;
        };
        let Some(first_segment_id) = request.target.first_segment_id.map(|segment_id| segment_id.0)
        else {
            return false;
        };
        draft.latest_segment_id == Some(first_segment_id)
    }

    fn streaming_interim_completion_overlap(
        &self,
        turn_id: u64,
        request: &AsrRequest,
    ) -> Option<StreamingCompletionOverlap> {
        if request.kind != AsrTaskKind::CompletionCheck
            || request.close_reason != Some(SegmentCloseReason::EndSilenceReached)
        {
            return None;
        }
        let streaming_range = self.turn_store.streaming_interim_ranges.get(&turn_id).copied()?;
        if request.target.range.start_sample >= streaming_range.end_sample {
            return None;
        }
        let draft = self.turn_store.turns.get(&turn_id).map(Turn::draft)?;
        let first_segment_id = request.target.first_segment_id.map(|segment_id| segment_id.0)?;
        if request.target.last_segment_id == request.target.first_segment_id {
            return None;
        }
        if draft.latest_segment_id != Some(first_segment_id) {
            return None;
        }
        // Prefix-trim only the leading completion samples that actually sit
        // inside the applied streaming delta. A cumulative 0..emitted range
        // must not make a later hole look already covered.
        if request.target.range.start_sample < streaming_range.start_sample {
            return None;
        }
        let overlap_end = request.target.range.end_sample.min(streaming_range.end_sample);
        if overlap_end <= request.target.range.start_sample {
            return None;
        }
        let geometric_overlap = samples_between(request.target.range.start_sample, overlap_end);
        let leading_padding =
            leading_asr_only_padding_samples(&request.audio, &request.source_audio);
        let source_samples =
            geometric_overlap.saturating_sub(leading_padding).min(request.source_audio.len());
        let audio_samples = if leading_padding > 0 {
            geometric_overlap.min(request.audio.len())
        } else {
            // No ASR-only padding relationship: range/source share one timeline.
            source_samples
        };
        Some(StreamingCompletionOverlap {
            audio_samples,
            source_samples,
            leading_asr_padding: leading_padding,
        })
    }

    fn merge_turn_audio_range(&mut self, turn_id: u64, range: AudioRange) {
        self.merge_contiguous_turn_audio_range(turn_id, range);
    }

    fn merge_contiguous_turn_audio_range(&mut self, turn_id: u64, range: AudioRange) {
        let ranges = self.turn_store.audio_ranges.entry(turn_id).or_default();
        insert_contiguous_audio_range(ranges, range);
    }

    pub(in crate::recognition) fn apply_rerecognition_transcript(
        &mut self,
        request: &AsrRequest,
        transcript: AsrTranscript,
        elapsed_millis: u128,
        refresh_boundary_candidates: bool,
    ) {
        let turn_id = request.target.turn_id.0;
        let candidates = refresh_boundary_candidates.then(|| {
            candidates_for_transcript(
                request.route.language,
                &transcript,
                &request.audio,
                &request.vad_results,
                self.io.japanese_morph.as_ref(),
            )
        });
        if let Some(turn) = self.turn_store.turns.get_mut(&turn_id) {
            let draft = turn.draft_mut();
            draft.set_detected_language(request.detected_language.clone());
            let longer_surface = longer_turn_surface_text(
                &draft.combined_text,
                draft.last_emitted_interim_text.as_deref(),
            );
            let keep_joined_tail = rerecognition_drops_joined_tail(
                &draft.combined_text,
                &transcript.text,
                &draft.segment_texts,
            );
            if prefer_streaming_interim_text_over_truncated_completion(
                &longer_surface,
                &transcript.text,
            ) || is_repeated_turn_append(&longer_surface, &transcript.text)
                || rerecognition_is_truncated_joined_caption(&longer_surface, &transcript.text)
                || keep_joined_tail
            {
                // Truncated, rewritten-shorter, same-length lead substitution,
                // or repeated-string full-turn rerecognition must not replace a
                // longer joined draft. Grammar ASR of prefix audio often returns
                // a punctuated lead that is not a prefix of the streaming concat
                // and would drop the same-utterance tail.
                let keep_text =
                    if keep_joined_tail { draft.combined_text.clone() } else { longer_surface };
                if draft.combined_text == keep_text {
                    draft.route = Some(request.route);
                    draft.processing_millis += elapsed_millis;
                } else {
                    draft.replace_text_preserving_sources(request.route, keep_text, elapsed_millis);
                }
            } else {
                draft.replace_text_preserving_sources(
                    request.route,
                    transcript.text,
                    elapsed_millis,
                );
                if let Some(candidates) = candidates {
                    draft.boundary_candidates = candidates;
                }
            }
            self.turn_store.last_recognition_route = Some(request.route);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StreamingCompletionOverlap {
    /// Overlap measured in `request.audio` / token-timestamp coordinates.
    audio_samples: usize,
    /// Same overlap expressed in `request.source_audio` coordinates after
    /// removing leading ASR-only padding that is absent from turn phrase audio.
    source_samples: usize,
    /// Leading ASR-only padding present in `request.audio` but not `source_audio`.
    leading_asr_padding: usize,
}

impl StreamingCompletionOverlap {
    /// Choose the overlap timeline that matches how token timestamps were produced.
    ///
    /// Completion audio may include copied end-silence padding. Token clocks
    /// sometimes stay on that padded audio timeline, and sometimes already start
    /// at the first source sample after ignoring silence. Use the same 80%
    /// padding heuristic as `maybe_shift_transcript_timestamps_for_leading_padding`
    /// so source-relative clocks are not trimmed against the padded overlap.
    fn samples_for_transcript_tokens(self, transcript: &AsrTranscript) -> usize {
        if self.leading_asr_padding == 0 || self.audio_samples == self.source_samples {
            return self.audio_samples;
        }
        let Some(first_start_sample) = transcript.tokens.iter().find_map(|token| {
            let start_sec = token.start_sec?;
            sample_index_from_seconds(start_sec)
        }) else {
            return self.audio_samples;
        };
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            clippy::cast_sign_loss,
            reason = "padding threshold mirrors the existing ASR timestamp-shift heuristic"
        )]
        let padding_threshold = (self.leading_asr_padding as f32 * 0.8).round() as usize;
        if first_start_sample < padding_threshold {
            self.source_samples
        } else {
            self.audio_samples
        }
    }
}

/// Leading samples present in ASR `audio` but omitted from turn `source_audio`
/// (copied end-silence padding from the segment builder).
///
/// `request.audio` may already have an edge fade applied to the source body, so
/// bit-identical suffix matching is not enough to recognize that padding.
fn leading_asr_only_padding_samples(audio: &[f32], source_audio: &[f32]) -> usize {
    if source_audio.len() >= audio.len() {
        return 0;
    }
    let padding = audio.len() - source_audio.len();
    if waveforms_match_allowing_edge_fade(&audio[padding..], source_audio) { padding } else { 0 }
}

fn waveforms_match_allowing_edge_fade(faded: &[f32], source: &[f32]) -> bool {
    if faded.len() != source.len() {
        return false;
    }
    if faded.iter().zip(source).all(|(left, right)| left.to_bits() == right.to_bits()) {
        return true;
    }
    let fade_samples = max_asr_edge_fade_samples().min(faded.len());
    let interior_end = faded.len().saturating_sub(fade_samples);
    if fade_samples > interior_end {
        return faded.iter().zip(source).all(|(left, right)| sample_is_edge_fade_of(*left, *right));
    }
    faded[..fade_samples]
        .iter()
        .zip(&source[..fade_samples])
        .all(|(left, right)| sample_is_edge_fade_of(*left, *right))
        && faded[fade_samples..interior_end]
            .iter()
            .zip(&source[fade_samples..interior_end])
            .all(|(left, right)| left.to_bits() == right.to_bits())
        && faded[interior_end..]
            .iter()
            .zip(&source[interior_end..])
            .all(|(left, right)| sample_is_edge_fade_of(*left, *right))
}

fn sample_is_edge_fade_of(faded: f32, source: f32) -> bool {
    if faded.to_bits() == source.to_bits() {
        return true;
    }
    if faded.abs() > source.abs() + f32::EPSILON {
        return false;
    }
    faded.abs() <= f32::EPSILON || faded.is_sign_positive() == source.is_sign_positive()
}

fn max_asr_edge_fade_samples() -> usize {
    // Covers Reazon 10ms and Nemotron 80ms edge fades on 16 kHz audio.
    usize::try_from(ASR_SAMPLE_RATE).unwrap_or(16_000).saturating_mul(80) / 1_000
}

/// Keep only transcript tokens whose audio begins after an already-applied
/// streaming prefix. Completion ASR may be run over a source range that starts
/// inside the range already covered by a streaming interim; its text therefore
/// includes tokens from that covered prefix as well.
///
/// When every usable token starts inside the overlap, return an empty string so
/// the covered prefix is not appended again. Missing timestamps/char ranges
/// still fall back to the full transcript text, because the seam cannot be
/// resolved from audio geometry.
fn text_after_audio_overlap(transcript: &AsrTranscript, overlap_samples: usize) -> String {
    if overlap_samples == 0 || transcript.tokens.is_empty() {
        return transcript.text.clone();
    }

    let text_len = transcript.text.chars().count();
    let mut saw_usable_token = false;
    let mut first_uncovered_char = None;
    for token in &transcript.tokens {
        let Some(char_range) = token.char_range.as_ref() else {
            continue;
        };
        let Some(start_sec) = token.start_sec else {
            continue;
        };
        let Some(start_sample) = sample_index_from_seconds(start_sec) else {
            continue;
        };
        saw_usable_token = true;
        if start_sample >= overlap_samples {
            first_uncovered_char = Some(char_range.start);
            break;
        }
    }
    if !saw_usable_token {
        return transcript.text.clone();
    }
    let Some(first_uncovered_char) = first_uncovered_char else {
        return String::new();
    };
    if first_uncovered_char > text_len {
        return transcript.text.clone();
    }
    transcript.text.chars().skip(first_uncovered_char).collect()
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "ASR token timestamps are converted to bounded sample offsets for overlap merging"
)]
fn sample_index_from_seconds(seconds: f32) -> Option<usize> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some((seconds * ASR_SAMPLE_RATE as f32).round() as usize)
}

/// Keep a longer Nemotron (or other streaming) draft when completion ASR
/// returns a shorter prefix of the same utterance.
fn prefer_streaming_interim_text_over_truncated_completion(
    existing: &str,
    completion: &str,
) -> bool {
    let existing = strip_turn_surface_noise(existing);
    let completion = strip_turn_surface_noise(completion);
    if existing.is_empty() {
        return false;
    }
    if completion.is_empty() {
        // Blank completion is a total truncation of the streaming hypothesis.
        return true;
    }
    let existing_chars = existing.chars().count();
    let completion_chars = completion.chars().count();
    if completion_chars >= existing_chars {
        return false;
    }
    existing.starts_with(completion) && existing != completion
}

/// Keep a longer joined caption when full-turn rerecognition returns a shorter
/// rewrite of the same lead. Streaming concat ("全体。 続き 後半") and grammar
/// ("全体続き") often disagree on punctuation/spacing, so a raw prefix check
/// misses the truncation and would drop the tail. A full shorter rewrite of a
/// short utterance ("句読点つき。" → "再認識後。") must still replace.
fn rerecognition_is_truncated_joined_caption(existing: &str, incoming: &str) -> bool {
    let existing = compact_turn_surface_for_prefix(existing);
    let incoming = compact_turn_surface_for_prefix(incoming);
    if existing.is_empty() || incoming.is_empty() {
        return false;
    }
    incoming.chars().count() < existing.chars().count() && existing.starts_with(&incoming)
}

/// Keep a multi-segment joined caption when grammar rerecognition does not
/// carry the already-applied tail. Same-length lead substitution
/// ("全体。 続き 後半" vs "全体ですよね") is not a compact prefix, so
/// `rerecognition_is_truncated_joined_caption` misses it. A single-segment
/// short-utterance rewrite ("句読点つき。" → "再認識後。") still replaces.
fn rerecognition_drops_joined_tail(
    combined: &str,
    incoming: &str,
    segment_texts: &[String],
) -> bool {
    if segment_texts.len() < 2 {
        return false;
    }
    let incoming = compact_turn_surface_for_prefix(incoming);
    if incoming.is_empty() {
        return false;
    }
    let tail = compact_turn_surface_for_prefix(&segment_texts[1..].join(""));
    if tail.is_empty() {
        return false;
    }
    compact_turn_surface_for_prefix(combined).contains(&tail) && !incoming.contains(&tail)
}

fn compact_turn_surface_for_prefix(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_whitespace() && !matches!(*ch, '.' | '。' | '、' | ',' | '…' | '⋯'))
        .collect()
}

fn longer_turn_surface_text(combined: &str, last_emitted: Option<&str>) -> String {
    let Some(visible) = last_emitted else {
        return combined.to_string();
    };
    if is_longer_turn_rewrite(visible, combined) {
        combined.to_string()
    } else {
        visible.to_string()
    }
}

/// True when `candidate` is a longer rewrite of `visible` that should replace
/// the on-screen interim while rerecognition is still in flight.
///
/// Shorter prefix truncations stay off-screen (keep-longer). A completion that
/// merely concatenates the visible text onto itself is not a real tail.
pub(in crate::recognition) fn is_longer_turn_rewrite(visible: &str, candidate: &str) -> bool {
    let visible = strip_turn_surface_noise(visible);
    let candidate = strip_turn_surface_noise(candidate);
    if candidate.is_empty() {
        return false;
    }
    if visible.is_empty() {
        return true;
    }
    if candidate.chars().count() <= visible.chars().count() {
        return false;
    }
    !is_repeated_turn_append(visible, candidate)
}

fn is_repeated_turn_append(visible: &str, candidate: &str) -> bool {
    if visible.is_empty() || candidate.chars().count() <= visible.chars().count() {
        return false;
    }
    if !candidate.starts_with(visible) {
        return false;
    }
    let rest = candidate[visible.len()..].trim();
    rest.is_empty() || visible.starts_with(rest) || rest.starts_with(visible)
}

fn completion_is_full_longer_rewrite(existing: &str, incoming: &str) -> bool {
    let existing = strip_turn_surface_noise(existing);
    let incoming = strip_turn_surface_noise(incoming);
    is_longer_turn_rewrite(existing, incoming) && incoming.starts_with(existing)
}

fn completion_prefix_is_before_existing_range(
    existing: &[AudioRange],
    request: &AsrRequest,
) -> bool {
    let Some(existing_start) = existing.iter().map(|range| range.start_sample).min() else {
        return false;
    };
    let is_yielded_prefix = request.kind == AsrTaskKind::CompletionCheck
        || request.close_reason == Some(SegmentCloseReason::InterimResultSilenceReached);
    // Padding can copy prior end-silence into the later 160ms, so the prefix
    // end may sit past existing.start. Prepend the uncovered prefix anyway.
    is_yielded_prefix && request.target.range.start_sample < existing_start
}

fn prefix_source_len_before_existing(existing: &[AudioRange], request: &AsrRequest) -> usize {
    let Some(existing_start) = existing.iter().map(|range| range.start_sample).min() else {
        return request.source_audio.len();
    };
    if request.target.range.start_sample >= existing_start {
        return 0;
    }
    samples_between(
        request.target.range.start_sample,
        existing_start.min(request.target.range.end_sample),
    )
    .min(request.source_audio.len())
}

fn completion_earlier_segment_id(
    segment_ids: &[u64],
    latest_segment_id: Option<u64>,
    request: &AsrRequest,
    segment_id: u64,
) -> Option<u64> {
    if request.kind != AsrTaskKind::CompletionCheck {
        return None;
    }
    if segment_ids.contains(&segment_id) && latest_segment_id != Some(segment_id) {
        return Some(segment_id);
    }
    if request.close_reason != Some(SegmentCloseReason::EndSilenceReached) {
        return None;
    }
    let first_id = request.target.first_segment_id.map_or(segment_id, |id| id.0);
    (segment_ids.contains(&first_id) && latest_segment_id != Some(first_id)).then_some(first_id)
}

fn completion_text_duplicates_existing(existing: &str, incoming: &str) -> bool {
    let existing = strip_turn_surface_noise(existing);
    let incoming = strip_turn_surface_noise(incoming);
    if existing.is_empty() || incoming.is_empty() {
        return false;
    }
    if existing == incoming {
        return true;
    }
    if prefer_streaming_interim_text_over_truncated_completion(existing, incoming) {
        return true;
    }
    completion_appended_suffix_is_repeated(existing, incoming)
}

fn visible_text_for_blank_replace(
    incoming: &str,
    latest_segment_text: Option<&str>,
    combined: &str,
    last_emitted: Option<&str>,
    segment_count: usize,
) -> String {
    if !completion_incoming_is_blank(incoming) {
        return incoming.to_string();
    }
    if let Some(latest) = latest_segment_text
        && !completion_incoming_is_blank(latest)
    {
        return latest.to_string();
    }
    let surface = longer_turn_surface_text(combined, last_emitted);
    if segment_count <= 1 && !completion_incoming_is_blank(&surface) {
        surface
    } else {
        incoming.to_string()
    }
}

/// Same-display-id Nemotron 160ms ASR is run on the delta, so the transcript
/// often does not repeat the already-visible prefix. Keep that prefix instead
/// of letting `replace_latest` shrink the caption to the short tail.
fn streaming_chunk_text_keeping_visible_prefix(existing: &str, incoming: &str) -> String {
    let existing_surface = strip_turn_surface_noise(existing);
    let incoming_surface = strip_turn_surface_noise(incoming);
    if existing_surface.is_empty() {
        return incoming.to_string();
    }
    if incoming_surface.is_empty() {
        return existing.to_string();
    }
    if incoming_surface.starts_with(existing_surface) {
        return incoming.to_string();
    }
    if prefer_streaming_interim_text_over_truncated_completion(existing, incoming)
        || completion_text_duplicates_existing(existing, incoming)
    {
        return existing.to_string();
    }
    format!("{existing}{incoming}")
}

fn completion_incoming_is_blank(incoming: &str) -> bool {
    strip_turn_surface_noise(incoming).is_empty()
}

fn covered_completion_source_samples(
    existing_ranges: &[AudioRange],
    request: &AsrRequest,
) -> usize {
    if request.kind != AsrTaskKind::CompletionCheck {
        return 0;
    }
    let leading_padding = leading_asr_only_padding_samples(&request.audio, &request.source_audio);
    if leading_padding > 0 {
        return 0;
    }
    leading_covered_source_samples(
        existing_ranges,
        request.target.range,
        request.source_audio.len(),
    )
}

fn leading_covered_source_samples(
    existing_ranges: &[AudioRange],
    request_range: AudioRange,
    source_len: usize,
) -> usize {
    let mut cursor = request_range.start_sample;
    let end = request_range.end_sample;
    while let Some(hit) = existing_ranges
        .iter()
        .find(|range| range.start_sample <= cursor && cursor < range.end_sample)
    {
        let next = hit.end_sample.min(end);
        if next <= cursor {
            break;
        }
        cursor = next;
    }
    samples_between(request_range.start_sample, cursor.min(end)).min(source_len)
}

fn uncovered_completion_source_start(
    draft_audio: &[f32],
    source_audio: &[f32],
    latest_audio_len: usize,
) -> usize {
    if source_audio.is_empty() || draft_audio.is_empty() {
        return 0;
    }
    if source_audio.len() >= draft_audio.len()
        && source_audio[..draft_audio.len()]
            .iter()
            .zip(draft_audio)
            .all(|(left, right)| left.to_bits() == right.to_bits())
    {
        return draft_audio.len();
    }
    if draft_audio.len() >= source_audio.len()
        && draft_audio[..source_audio.len()]
            .iter()
            .zip(source_audio)
            .all(|(left, right)| left.to_bits() == right.to_bits())
    {
        return source_audio.len();
    }
    if draft_audio.len() >= source_audio.len()
        && f32_slices_equal(&draft_audio[draft_audio.len() - source_audio.len()..], source_audio)
    {
        return source_audio.len();
    }
    let latest_len = latest_audio_len.min(draft_audio.len()).min(source_audio.len());
    if latest_len == 0 {
        return 0;
    }
    let latest = &draft_audio[draft_audio.len() - latest_len..];
    if let Some(start) = find_f32_slice(source_audio, latest) {
        return (start + latest_len).min(source_audio.len());
    }
    0
}

fn f32_slices_equal(left: &[f32], right: &[f32]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| a.to_bits() == b.to_bits())
}

fn find_f32_slice(haystack: &[f32], needle: &[f32]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| f32_slices_equal(window, needle))
}

fn insert_contiguous_audio_range(ranges: &mut Vec<AudioRange>, range: AudioRange) {
    if let Some(index) = ranges.iter().position(|current| ranges_are_contiguous(*current, range)) {
        let merged = ranges.remove(index).merge(range);
        insert_contiguous_audio_range(ranges, merged);
        return;
    }
    ranges.push(range);
    ranges.sort_by_key(|range| range.start_sample);
}

fn uncovered_completion_audio_range(
    request: &AsrRequest,
    append_source_start: usize,
) -> Option<AudioRange> {
    if request.kind != AsrTaskKind::CompletionCheck
        || append_source_start >= request.source_audio.len()
    {
        return None;
    }
    let start = GlobalSampleIndex(
        request.target.range.start_sample.0.saturating_add(append_source_start as u64),
    );
    if start >= request.target.range.end_sample {
        None
    } else {
        Some(AudioRange::new(start, request.target.range.end_sample))
    }
}

/// Production Nemotron 160ms chunks carry cumulative `source_audio` and a
/// delta `audio` tail. After a Reazon prefix the waveforms no longer match, so
/// `replace_latest` does not run; appending the full source would restack the
/// already-visible prefix. Keep only the uncovered delta.
fn streaming_chunk_uncovered_source_start(
    close_reason: Option<SegmentCloseReason>,
    source_audio: &[f32],
    audio: &[f32],
) -> usize {
    if close_reason != Some(SegmentCloseReason::InterimChunkReached)
        || audio.is_empty()
        || source_audio.len() < audio.len()
    {
        return 0;
    }
    let start = source_audio.len() - audio.len();
    if source_audio[start..]
        .iter()
        .zip(audio)
        .all(|(left, right)| left.to_bits() == right.to_bits())
    {
        start
    } else {
        0
    }
}

/// Map a cumulative `0..emitted` 160ms range onto the suffix that was actually
/// appended (`audio`). A 1-sample helper `audio` suffix must not collapse the
/// window; production deltas are the full 160ms grid.
fn applied_streaming_chunk_range(request: &AsrRequest, source_skip: usize) -> AudioRange {
    if request.close_reason != Some(SegmentCloseReason::InterimChunkReached) || source_skip == 0 {
        return request.target.range;
    }
    if request.audio.len() <= 1
        || request.source_audio.len()
            != samples_between(request.target.range.start_sample, request.target.range.end_sample)
    {
        return request.target.range;
    }
    let appended = request.source_audio.len() - source_skip;
    let end = request.target.range.end_sample;
    let start = GlobalSampleIndex(end.0.saturating_sub(appended as u64));
    if start < end && start >= request.target.range.start_sample {
        AudioRange::new(start, end)
    } else {
        request.target.range
    }
}

fn ranges_are_contiguous(left: AudioRange, right: AudioRange) -> bool {
    left.end_sample >= right.start_sample && right.end_sample >= left.start_sample
}

fn samples_between(start: GlobalSampleIndex, end: GlobalSampleIndex) -> usize {
    usize::try_from(end.0.saturating_sub(start.0)).unwrap_or(usize::MAX)
}

fn vad_has_speech_after_sample(
    audio_len: usize,
    vad_results: &[VadResult],
    start_sample: usize,
) -> bool {
    if start_sample >= audio_len {
        return false;
    }
    let Some(ranges) = even_chunk_ranges(audio_len, vad_results.len()) else {
        return true;
    };
    ranges
        .into_iter()
        .zip(vad_results)
        .any(|(range, vad)| vad.is_speech && range.end > start_sample)
}

fn vad_prefix_until_sample(
    audio_len: usize,
    vad_results: &[VadResult],
    end_sample: usize,
) -> Vec<VadResult> {
    if end_sample == 0 {
        return Vec::new();
    }
    if end_sample >= audio_len || vad_results.is_empty() {
        return vad_results.to_vec();
    }
    let Some(ranges) = even_chunk_ranges(audio_len, vad_results.len()) else {
        return vad_results.to_vec();
    };
    ranges
        .into_iter()
        .zip(vad_results)
        .filter_map(|(range, vad)| (range.start < end_sample).then_some(*vad))
        .collect()
}

fn vad_suffix_after_sample(
    audio_len: usize,
    vad_results: &[VadResult],
    start_sample: usize,
) -> Vec<VadResult> {
    if start_sample == 0 {
        return vad_results.to_vec();
    }
    if start_sample >= audio_len || vad_results.is_empty() {
        return Vec::new();
    }
    let Some(ranges) = even_chunk_ranges(audio_len, vad_results.len()) else {
        return vad_results.to_vec();
    };
    ranges
        .into_iter()
        .zip(vad_results)
        .filter_map(|(range, vad)| (range.end > start_sample).then_some(*vad))
        .collect()
}

fn even_chunk_ranges(audio_len: usize, chunk_count: usize) -> Option<Vec<std::ops::Range<usize>>> {
    if chunk_count == 0 || audio_len < chunk_count {
        return None;
    }
    let base = audio_len / chunk_count;
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

#[cfg(test)]
mod tests {
    use super::{
        completion_incoming_is_blank, completion_is_full_longer_rewrite,
        completion_text_duplicates_existing, is_longer_turn_rewrite,
        leading_asr_only_padding_samples, leading_covered_source_samples, longer_turn_surface_text,
        prefer_streaming_interim_text_over_truncated_completion, rerecognition_drops_joined_tail,
        rerecognition_is_truncated_joined_caption, streaming_chunk_uncovered_source_start,
        uncovered_completion_source_start, visible_text_for_blank_replace,
    };
    use crate::recognition::{
        segmentation::segment::builder::SegmentCloseReason,
        transcription::asr::task::{AudioRange, GlobalSampleIndex},
    };

    fn range(start: u64, end: u64) -> AudioRange {
        AudioRange::new(GlobalSampleIndex(start), GlobalSampleIndex(end))
    }

    #[test]
    fn longer_rewrite_emits_a_real_tail_but_not_truncation_or_duplicate_append() {
        assert!(is_longer_turn_rewrite("長い発話の前半", "長い発話の前半と末尾"));
        assert!(is_longer_turn_rewrite("途中", "全体の長い結果"));
        assert!(!is_longer_turn_rewrite("今日はいい天気ですね", "今日はいい天気"));
        assert!(!is_longer_turn_rewrite(
            "五月五日はこどもの日です",
            "五月五日はこどもの日です五月五日はこどもの日です"
        ));
        assert!(!is_longer_turn_rewrite("同じ", "同じ"));
        assert!(prefer_streaming_interim_text_over_truncated_completion(
            "今日はいい天気ですね",
            "今日はいい天気"
        ));
        assert!(prefer_streaming_interim_text_over_truncated_completion(
            "今日はいい天気ですね",
            ""
        ));
        assert!(prefer_streaming_interim_text_over_truncated_completion(
            "今日はいい天気ですね",
            "。"
        ));
        assert!(rerecognition_is_truncated_joined_caption("全体。 続き 後半", "全体続き"));
        assert!(!rerecognition_is_truncated_joined_caption("句読点つき。", "再認識後。"));
        assert!(!rerecognition_is_truncated_joined_caption("全体。", "全体。続き後半"));
        assert!(rerecognition_drops_joined_tail(
            "全体。 続き 後半",
            "全体ですよね",
            &["全体。".into(), "続き".into(), "後半".into()],
        ));
        assert!(!rerecognition_drops_joined_tail(
            "句読点つき。",
            "再認識です。",
            &["句読点つき。".into()],
        ));
        assert!(!rerecognition_drops_joined_tail(
            "全体。 続き 後半",
            "全体続き後半です",
            &["全体。".into(), "続き".into(), "後半".into()],
        ));
        assert_eq!(
            visible_text_for_blank_replace(
                "。",
                Some("今日はいい天気ですね"),
                "今日はいい天気ですね",
                None,
                1
            ),
            "今日はいい天気ですね"
        );
        assert_eq!(
            longer_turn_surface_text("今日はいい天気", Some("今日はいい天気ですね")),
            "今日はいい天気ですね"
        );
        assert_eq!(
            longer_turn_surface_text("今日はいい天気ですね", Some("今日はいい天気ですね")),
            "今日はいい天気ですね"
        );
        assert_eq!(
            longer_turn_surface_text(
                "五月五日はこどもの日です五月五日はこどもの日です",
                Some("五月五日はこどもの日です")
            ),
            "五月五日はこどもの日です"
        );
    }

    #[test]
    fn completion_append_keeps_visible_text_and_real_tails() {
        assert!(completion_text_duplicates_existing(
            "五月五日はこどもの日です",
            "五月五日はこどもの日です"
        ));
        assert!(completion_text_duplicates_existing(
            "五月五日はこどもの日です",
            "五月五日はこどもの日です。"
        ));
        assert!(completion_text_duplicates_existing("今日はいい天気ですね", "今日はいい天気"));
        assert!(!completion_text_duplicates_existing("全体", "追加"));
        assert!(!completion_text_duplicates_existing("全体", ""));
        assert!(completion_incoming_is_blank(""));
        assert!(completion_incoming_is_blank("。"));
        assert!(completion_incoming_is_blank("..."));
        assert!(!completion_incoming_is_blank("追加"));
        assert!(completion_is_full_longer_rewrite("前半", "前半と末尾"));
        assert!(!completion_is_full_longer_rewrite("全体", "追加です"));
        assert_eq!(
            uncovered_completion_source_start(&[0.0, 1.0, 2.0], &[0.0, 1.0, 2.0, 3.0, 4.0], 3),
            3
        );
        assert_eq!(uncovered_completion_source_start(&[0.0, 1.0, 2.0], &[0.0, 1.0, 2.0], 3), 3);
        assert_eq!(uncovered_completion_source_start(&[0.0, 1.0], &[2.0, 3.0], 2), 0);
        assert_eq!(
            uncovered_completion_source_start(
                &[vec![1.0; 150], vec![3.0; 160]].concat(),
                &[vec![9.0; 250], vec![3.0; 160]].concat(),
                160,
            ),
            410
        );
        assert_eq!(leading_covered_source_samples(&[range(0, 100)], range(0, 150), 150), 100);
        assert_eq!(leading_covered_source_samples(&[range(0, 100)], range(100, 150), 50), 0);
        assert_eq!(
            leading_covered_source_samples(&[range(0, 150), range(250, 410)], range(250, 410), 160),
            160
        );
        assert_eq!(
            leading_covered_source_samples(&[range(0, 150), range(250, 410)], range(150, 250), 100),
            0
        );
        let source = vec![2.0; 200];
        let mut faded_source = source.clone();
        apply_test_fade(&mut faded_source, 16);
        let faded_audio = [vec![0.0; 50], faded_source].concat();
        assert_eq!(leading_asr_only_padding_samples(&faded_audio, &source), 50);
        assert_eq!(
            leading_asr_only_padding_samples(&[0.0, 3.0, 4.0], &[2.0, 3.0]),
            0,
            "a longer audio prefix must not count as padding unless the suffix matches the source"
        );
        assert_eq!(
            streaming_chunk_uncovered_source_start(
                Some(SegmentCloseReason::InterimChunkReached),
                &[vec![9.0; 150], vec![3.0; 160]].concat(),
                &[3.0; 160],
            ),
            150
        );
        assert_eq!(
            streaming_chunk_uncovered_source_start(
                Some(SegmentCloseReason::InterimChunkReached),
                &[3.0; 160],
                &[3.0; 160],
            ),
            0,
            "a non-cumulative chunk must keep its full source"
        );
        assert_eq!(
            streaming_chunk_uncovered_source_start(
                Some(SegmentCloseReason::InterimChunkReached),
                &[2.0; 320],
                &[1.0],
            ),
            0,
            "a helper audio stub that is not a source suffix must not skip the streaming source"
        );
    }

    #[expect(clippy::cast_precision_loss, reason = "test fade gains mirror ASR edge-fade ratios")]
    fn apply_test_fade(audio: &mut [f32], fade_samples: usize) {
        let fade_samples = fade_samples.min(audio.len());
        if fade_samples == 0 {
            return;
        }
        for (index, sample) in audio.iter_mut().take(fade_samples).enumerate() {
            *sample *= index as f32 / fade_samples as f32;
        }
        let start = audio.len() - fade_samples;
        for (index, sample) in audio[start..].iter_mut().enumerate() {
            *sample *= (fade_samples - index) as f32 / fade_samples as f32;
        }
    }
}
