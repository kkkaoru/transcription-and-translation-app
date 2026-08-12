use crate::{
    audio::ASR_SAMPLE_RATE,
    recognition::{
        control::RecognitionSession,
        segmentation::segment::builder::SegmentCloseReason,
        segmentation::vad::engine::VadResult,
        transcription::asr::{
            engine::AsrTranscript,
            task::{AsrRequest, AsrTaskKind, AudioRange, GlobalSampleIndex},
        },
        turn::{boundary::candidates_for_transcript, turn_event_id, Turn},
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
        let existing_audio_range = self.turn_store.audio_ranges.get(&turn_id).copied();
        self.merge_turn_audio_range(turn_id, request.target.range);
        if completion_is_duplicate_tail {
            return turn_id;
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
            && (request.close_reason == Some(SegmentCloseReason::InterimChunkReached)
                || (request.kind == AsrTaskKind::CompletionCheck
                    && latest_segment_audio_is_prefix()))
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
        let replace_combined_with_longer_rewrite =
            completion_append && completion_is_full_longer_rewrite(&existing_text, &incoming_text);
        let skip_duplicate_completion_text = completion_append
            && (replace_combined_with_longer_rewrite
                || completion_text_duplicates_existing(&existing_text, &incoming_text));
        let skip_blank_completion_append = completion_append
            && !replace_combined_with_longer_rewrite
            && (skip_duplicate_completion_text || completion_incoming_is_blank(&incoming_text));
        let recorded_text = if replace_latest_segment {
            incoming_text.clone()
        } else if skip_duplicate_completion_text || skip_blank_completion_append {
            // Keep the visible utterance in combined_text. Appending the same
            // (or truncated) completion string doubled the final when
            // rerecognition did not run to replace the draft.
            String::new()
        } else {
            incoming_text.clone()
        };
        if replace_latest_segment {
            draft.replace_latest_recognized_segment(
                segment_id,
                previous_segment_id,
                &request.source_audio,
                &request.source_vad_results,
                request.route,
                recorded_text,
                elapsed_millis,
            );
        } else {
            let append_source_start = if let Some(overlap) = streaming_interim_overlap {
                overlap.source_samples
            } else {
                let range_skip = covered_completion_source_samples(existing_audio_range, request);
                let prefix_skip = if skip_duplicate_completion_text || skip_blank_completion_append
                {
                    uncovered_completion_source_start(&draft.full_audio, &request.source_audio)
                } else {
                    0
                };
                range_skip.max(prefix_skip)
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
        }
        if request.close_reason == Some(SegmentCloseReason::InterimChunkReached) {
            self.turn_store
                .streaming_interim_ranges
                .entry(turn_id)
                .and_modify(|range| *range = range.merge(request.target.range))
                .or_insert(request.target.range);
        } else if completion_replaces_streaming_interim {
            self.turn_store.streaming_interim_ranges.remove(&turn_id);
        }
        self.turn_store.last_recognition_route = Some(request.route);
        turn_id
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
        // Completion ranges are measured over request.audio, which may start with
        // ASR-only copied silence that source_audio deliberately omits. Token
        // timestamps live in that audio space; turn-phrase audio uses source space.
        let geometric_overlap =
            samples_between(request.target.range.start_sample, streaming_range.end_sample);
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
        self.turn_store
            .audio_ranges
            .entry(turn_id)
            .and_modify(|current| *current = current.merge(range))
            .or_insert(range);
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
            if prefer_streaming_interim_text_over_truncated_completion(
                &longer_surface,
                &transcript.text,
            ) || is_repeated_turn_append(&longer_surface, &transcript.text)
            {
                // Truncated or repeated-string full-turn rerecognition must not
                // replace a longer (or already-clean) draft. Doubled completion
                // audio used to make ASR hear the utterance twice.
                if draft.combined_text != longer_surface {
                    draft.replace_text_preserving_sources(
                        request.route,
                        longer_surface,
                        elapsed_millis,
                    );
                } else {
                    draft.route = Some(request.route);
                    draft.processing_millis += elapsed_millis;
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
    if waveforms_match_allowing_edge_fade(&audio[padding..], source_audio) {
        padding
    } else {
        0
    }
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
    if existing.is_empty() || completion.is_empty() {
        return false;
    }
    let existing_chars = existing.chars().count();
    let completion_chars = completion.chars().count();
    if completion_chars >= existing_chars {
        return false;
    }
    existing.starts_with(completion) && existing != completion
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
    is_repeated_turn_append(existing, &format!("{existing}{incoming}"))
        || is_repeated_turn_append(existing, &format!("{existing} {incoming}"))
}

fn completion_incoming_is_blank(incoming: &str) -> bool {
    strip_turn_surface_noise(incoming).is_empty()
}

fn strip_turn_surface_noise(text: &str) -> &str {
    text.trim().trim_end_matches(['.', '。', '…', '⋯']).trim_end_matches("...").trim()
}

fn covered_completion_source_samples(
    existing_range: Option<AudioRange>,
    request: &AsrRequest,
) -> usize {
    if request.kind != AsrTaskKind::CompletionCheck {
        return 0;
    }
    let leading_padding = leading_asr_only_padding_samples(&request.audio, &request.source_audio);
    source_samples_covered_by_range_overlap(
        existing_range,
        request.target.range,
        request.source_audio.len(),
        leading_padding,
    )
}

fn source_samples_covered_by_range_overlap(
    existing_range: Option<AudioRange>,
    request_range: AudioRange,
    source_len: usize,
    leading_padding: usize,
) -> usize {
    // Copied previous-segment silence lives in request.audio, not source_audio.
    // That child window can geometrically overlap the draft even though its
    // source speech is new; do not treat it as a same-window re-ASR.
    if leading_padding > 0 {
        return 0;
    }
    let Some(existing) = existing_range else {
        return 0;
    };
    if request_range.start_sample >= existing.end_sample {
        return 0;
    }
    let overlap_end = request_range.end_sample.min(existing.end_sample);
    if overlap_end <= request_range.start_sample {
        return 0;
    }
    samples_between(request_range.start_sample, overlap_end).min(source_len)
}

fn uncovered_completion_source_start(draft_audio: &[f32], source_audio: &[f32]) -> usize {
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
    0
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
        leading_asr_only_padding_samples, longer_turn_surface_text,
        prefer_streaming_interim_text_over_truncated_completion,
        source_samples_covered_by_range_overlap, uncovered_completion_source_start,
    };
    use crate::recognition::transcription::asr::task::{AudioRange, GlobalSampleIndex};

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
            uncovered_completion_source_start(&[0.0, 1.0, 2.0], &[0.0, 1.0, 2.0, 3.0, 4.0]),
            3
        );
        assert_eq!(uncovered_completion_source_start(&[0.0, 1.0, 2.0], &[0.0, 1.0, 2.0]), 3);
        assert_eq!(uncovered_completion_source_start(&[0.0, 1.0], &[2.0, 3.0]), 0);
        assert_eq!(
            source_samples_covered_by_range_overlap(Some(range(0, 100)), range(0, 150), 150, 0),
            100
        );
        assert_eq!(
            source_samples_covered_by_range_overlap(Some(range(0, 100)), range(100, 150), 50, 0),
            0
        );
        assert_eq!(
            source_samples_covered_by_range_overlap(
                Some(range(0, 1024)),
                range(512, 2560),
                1536,
                512
            ),
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
