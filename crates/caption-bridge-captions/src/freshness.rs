//! Display-only 5s freshness window.
//!
//! Port of `apps/desktop/src/core/caption-freshness.ts`.

use crate::grapheme::{caption_graphemes, scalar_count, unicode_scalars};
use crate::payload::CaptionPayload;

/// Display-only TTL for completed caption chunks. Not a hold-clear epoch.
pub const CAPTION_FRESHNESS_MS: i64 = 5_000;

/// Hook tick used by `useCaptionFreshness`.
pub const FRESHNESS_TICK_MS: i64 = 250;

/// Inputs for the display-only freshness window.
pub struct CaptionFreshnessInput<'a> {
    pub caption: CaptionPayload,
    pub now: i64,
    pub grapheme_painted_at: &'a [i64],
    pub last_growth_at: i64,
    pub previous_source_text: &'a str,
    pub token_char_ends: Option<&'a [usize]>,
}

fn is_elongation(character: char) -> bool {
    matches!(character, 'ー' | '〜' | '～')
}

fn is_sentence_punct(character: char) -> bool {
    matches!(character, '。' | '．' | '！' | '？' | '!' | '?')
}

fn ends_with_polite_masu(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    if trimmed.ends_with("ます") {
        return true;
    }
    const PARTICLES: &[&str] = &["よ", "ね", "な", "わ", "ぞ", "さ", "か"];
    PARTICLES.iter().any(|particle| trimmed.ends_with(&format!("ます{particle}")))
}

/// Non-final captions without translation stay TTL-exempt.
pub fn is_caption_freshness_ttl_exempt(caption: &CaptionPayload) -> bool {
    !caption.is_final_true() && caption.translation_text.trim().is_empty()
}

/// Stamp grapheme appearance times. Prefix growth keeps earlier stamps.
pub fn stamp_grapheme_painted_at(
    previous_text: &str,
    previous_painted_at: &[i64],
    next_text: &str,
    now: i64,
) -> Vec<i64> {
    let next = caption_graphemes(next_text);
    if next.is_empty() {
        return Vec::new();
    }
    let prev = caption_graphemes(previous_text);
    if previous_text == next_text && previous_painted_at.len() == next.len() {
        return previous_painted_at.to_vec();
    }
    let mut shared = 0;
    let limit = prev.len().min(next.len());
    while shared < limit && prev[shared] == next[shared] {
        shared += 1;
    }
    next.iter()
        .enumerate()
        .map(|(index, _)| {
            if index < shared {
                previous_painted_at.get(index).copied().unwrap_or(now)
            } else {
                now
            }
        })
        .collect()
}

/// Freshness close offsets: IPADIC completes with `E < textLen`, without 2× KEEP.
pub fn freshness_close_offsets(text: &str, sentence_end_offsets: Option<&[usize]>) -> Vec<usize> {
    let chars = unicode_scalars(text);
    let text_len = chars.len();
    let mut ends: Vec<usize> = sentence_end_offsets
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|end| {
            if *end == 0 || *end >= text_len {
                return false;
            }
            let remainder: String = chars[*end..].iter().collect();
            if first_non_ws(&remainder).is_some_and(is_elongation) {
                return false;
            }
            let prefix: String = chars[..*end].iter().collect();
            let prefix = prefix.trim_end();
            if last_char(prefix).is_some_and(is_sentence_punct) {
                return true;
            }
            if ends_with_polite_masu(prefix) {
                return false;
            }
            true
        })
        .collect();
    ends.sort_unstable();
    ends.dedup();
    ends
}

fn first_non_ws(text: &str) -> Option<char> {
    text.trim_start().chars().next()
}

fn last_char(text: &str) -> Option<char> {
    text.chars().next_back()
}

fn round_right_to_grapheme(text: &str, scalar_offset: usize) -> usize {
    if scalar_offset == 0 {
        return 0;
    }
    let graphemes = caption_graphemes(text);
    let mut scalar = 0;
    for grapheme in graphemes {
        let length = scalar_count(&grapheme);
        if scalar_offset <= scalar {
            return scalar;
        }
        if scalar_offset < scalar + length {
            return scalar + length;
        }
        scalar += length;
    }
    scalar_count(text)
}

fn walk_back_elongation_start(text: &str, cut: usize) -> usize {
    let chars = unicode_scalars(text);
    let mut next = cut;
    while next > 0 && next < chars.len() {
        if is_elongation(chars[next]) {
            next -= 1;
            continue;
        }
        break;
    }
    next
}

fn snap_keep_from(
    keep_from: usize,
    closes: &[usize],
    softs: &[usize],
    token_char_ends: &[usize],
    text_len: usize,
) -> usize {
    if keep_from == 0 {
        return 0;
    }
    if let Some(close_left) =
        closes.iter().copied().filter(|end| *end > 0 && *end <= keep_from).max()
    {
        return close_left;
    }
    if let Some(soft_left) = softs.iter().copied().filter(|end| *end > 0 && *end <= keep_from).max()
    {
        return soft_left;
    }
    let next_token_end =
        token_char_ends.iter().copied().find(|end| *end > keep_from).unwrap_or(text_len);
    if let Some(soft_inside) =
        softs.iter().copied().filter(|end| *end >= keep_from && *end < next_token_end).min()
    {
        return soft_inside;
    }
    keep_from
}

fn transform_offsets(
    offsets: Option<&[usize]>,
    keep_from: usize,
    paint_len: usize,
) -> Option<Vec<usize>> {
    let Some(offsets) = offsets else {
        return None;
    };
    if offsets.is_empty() {
        return Some(Vec::new());
    }
    let next: Vec<usize> = offsets
        .iter()
        .filter_map(|offset| offset.checked_sub(keep_from))
        .filter(|offset| *offset > 0 && *offset <= paint_len)
        .collect();
    if next.is_empty() {
        None
    } else {
        Some(next)
    }
}

fn slice_source_from(caption: &CaptionPayload, keep_from: usize) -> CaptionPayload {
    let chars = unicode_scalars(&caption.source_text);
    if keep_from == 0 {
        return caption.clone();
    }
    if keep_from >= chars.len() {
        let mut next = caption.clone();
        next.source_text.clear();
        next.translation_text.clear();
        return next;
    }
    let paint: String = chars[keep_from..].iter().collect();
    let paint_len = chars.len() - keep_from;
    let mut next = caption.clone();
    next.source_text = paint;
    next.sentence_end_offsets =
        transform_offsets(caption.sentence_end_offsets.as_deref(), keep_from, paint_len);
    next.soft_break_offsets =
        transform_offsets(caption.soft_break_offsets.as_deref(), keep_from, paint_len);
    next
}

fn newest_chunk_start(closes: &[usize]) -> usize {
    closes.last().copied().unwrap_or(0)
}

/// Cut the display surface to the last 5s of speech, snapped to POS close/soft boundaries.
pub fn apply_caption_freshness_window(input: CaptionFreshnessInput<'_>) -> CaptionPayload {
    let caption = input.caption;
    let now = input.now;
    let last_growth_at = input.last_growth_at;
    let previous_source_text = input.previous_source_text;
    let source_text = caption.source_text.clone();
    if source_text.trim().is_empty() {
        let mut next = caption;
        next.source_text.clear();
        next.translation_text.clear();
        return next;
    }
    if caption.id == "preview" || caption.id == "empty" {
        return caption;
    }
    let graphemes = caption_graphemes(&source_text);
    let painted_at = if previous_source_text == source_text
        && input.grapheme_painted_at.len() == graphemes.len()
    {
        input.grapheme_painted_at.to_vec()
    } else {
        stamp_grapheme_painted_at(
            previous_source_text,
            input.grapheme_painted_at,
            &source_text,
            now,
        )
    };
    if is_caption_freshness_ttl_exempt(&caption) {
        return caption;
    }
    let text_len = scalar_count(&source_text);
    let closes = freshness_close_offsets(&source_text, caption.sentence_end_offsets.as_deref());
    let mut softs: Vec<usize> = caption
        .soft_break_offsets
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|offset| *offset > 0 && *offset <= text_len)
        .collect();
    softs.sort_unstable();
    softs.dedup();
    let mut token_char_ends: Vec<usize> = input
        .token_char_ends
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|offset| *offset > 0 && *offset <= text_len)
        .collect();
    token_char_ends.sort_unstable();
    token_char_ends.dedup();

    let mut keep_grapheme = graphemes
        .iter()
        .enumerate()
        .find(|(index, _)| {
            now - painted_at.get(*index).copied().unwrap_or(0) < CAPTION_FRESHNESS_MS
        })
        .map(|(index, _)| index)
        .unwrap_or(graphemes.len());
    if keep_grapheme > graphemes.len() {
        keep_grapheme = graphemes.len();
    }
    let mut keep_from = scalar_count(&graphemes[..keep_grapheme].join(""));
    let grew_this_tick = source_text != previous_source_text;
    let chunk_start = newest_chunk_start(&closes);
    if grew_this_tick && keep_from > chunk_start && keep_from < text_len {
        keep_from = chunk_start;
    }
    keep_from = round_right_to_grapheme(&source_text, keep_from);
    keep_from = snap_keep_from(keep_from, &closes, &softs, &token_char_ends, text_len);
    keep_from = walk_back_elongation_start(&source_text, keep_from);

    let mut display = slice_source_from(&caption, keep_from);
    if display.source_text.trim().is_empty() {
        display = if grew_this_tick {
            slice_source_from(&caption, chunk_start)
        } else if now >= last_growth_at + CAPTION_FRESHNESS_MS {
            let mut empty = caption.clone();
            empty.source_text.clear();
            empty.translation_text.clear();
            empty
        } else {
            slice_source_from(&caption, chunk_start)
        };
    }
    if display.source_text.trim().is_empty() {
        display.translation_text.clear();
    } else {
        display.translation_text = caption.translation_text.clone();
    }
    display
}

#[cfg(test)]
mod tests {
    use super::{
        apply_caption_freshness_window, freshness_close_offsets, stamp_grapheme_painted_at,
        CaptionFreshnessInput, CAPTION_FRESHNESS_MS,
    };
    use crate::grapheme::caption_graphemes;
    use crate::payload::{CaptionPayload, CaptionStage};
    use crate::sentence::{select_visible_caption_sentence, CaptionSentenceHints};

    fn caption(source_text: &str, extra: CaptionExtra) -> CaptionPayload {
        CaptionPayload {
            id: extra.id.unwrap_or_else(|| "parapper:session:turn:1".to_string()),
            source_text: source_text.to_string(),
            azookey_input_text: None,
            translation_text: extra.translation_text.unwrap_or_else(|| "It is sunny".to_string()),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 1,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: extra.is_final,
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: extra.sentence_end_offsets,
            soft_break_offsets: extra.soft_break_offsets,
        }
    }

    struct CaptionExtra {
        id: Option<String>,
        translation_text: Option<String>,
        is_final: Option<bool>,
        sentence_end_offsets: Option<Vec<usize>>,
        soft_break_offsets: Option<Vec<usize>>,
    }

    impl Default for CaptionExtra {
        fn default() -> Self {
            Self {
                id: None,
                translation_text: None,
                is_final: Some(false),
                sentence_end_offsets: None,
                soft_break_offsets: None,
            }
        }
    }

    fn painted_at(text: &str, at: i64) -> Vec<i64> {
        caption_graphemes(text).into_iter().map(|_| at).collect()
    }

    fn window_of(source_text: &str, now: i64, extra: WindowExtra) -> CaptionPayload {
        apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                source_text,
                CaptionExtra {
                    translation_text: extra.translation_text.clone(),
                    sentence_end_offsets: extra.sentence_end_offsets.clone(),
                    soft_break_offsets: extra.soft_break_offsets.clone(),
                    ..CaptionExtra::default()
                },
            ),
            now,
            grapheme_painted_at: extra
                .grapheme_painted_at
                .as_deref()
                .unwrap_or(&painted_at(source_text, 0)),
            last_growth_at: extra.last_growth_at.unwrap_or(0),
            previous_source_text: extra.previous_source_text.unwrap_or(source_text),
            token_char_ends: extra.token_char_ends.as_deref(),
        })
    }

    struct WindowExtra {
        sentence_end_offsets: Option<Vec<usize>>,
        soft_break_offsets: Option<Vec<usize>>,
        token_char_ends: Option<Vec<usize>>,
        grapheme_painted_at: Option<Vec<i64>>,
        last_growth_at: Option<i64>,
        previous_source_text: Option<&'static str>,
        translation_text: Option<String>,
    }

    impl Default for WindowExtra {
        fn default() -> Self {
            Self {
                sentence_end_offsets: None,
                soft_break_offsets: None,
                token_char_ends: None,
                grapheme_painted_at: None,
                last_growth_at: None,
                previous_source_text: None,
                translation_text: None,
            }
        }
    }

    #[test]
    fn closes_after_desu_and_shows_ashita_after_5s_even_when_2x_keep_would_retain_the_lead() {
        let text = "今日は晴れです明日は雨";
        assert_eq!(
            select_visible_caption_sentence(
                text,
                &CaptionSentenceHints {
                    sentence_end_offsets: Some(vec![7]),
                    ..CaptionSentenceHints::default()
                }
            ),
            text
        );
        assert_eq!(
            window_of(
                text,
                0,
                WindowExtra { sentence_end_offsets: Some(vec![7]), ..WindowExtra::default() }
            )
            .source_text,
            text
        );
        assert_eq!(
            window_of(
                text,
                CAPTION_FRESHNESS_MS,
                WindowExtra { sentence_end_offsets: Some(vec![7]), ..WindowExtra::default() }
            )
            .source_text,
            "明日は雨"
        );
        assert_eq!(
            window_of(
                text,
                CAPTION_FRESHNESS_MS,
                WindowExtra { sentence_end_offsets: Some(vec![7]), ..WindowExtra::default() }
            )
            .translation_text,
            "It is sunny"
        );
    }

    #[test]
    fn closes_adjective_basic_form_plus_ashita() {
        assert_eq!(
            window_of(
                "今日は寒い明日は",
                CAPTION_FRESHNESS_MS,
                WindowExtra { sentence_end_offsets: Some(vec![5]), ..WindowExtra::default() }
            )
            .source_text,
            "明日は"
        );
    }

    #[test]
    fn lets_punctuation_page_immediately_after_freshness_without_waiting_5s() {
        let text = "終わりです。次";
        let fresh = window_of(
            text,
            0,
            WindowExtra { sentence_end_offsets: Some(vec![6]), ..WindowExtra::default() },
        );
        assert_eq!(fresh.source_text, text);
        assert_eq!(
            select_visible_caption_sentence(
                &fresh.source_text,
                &CaptionSentenceHints {
                    sentence_end_offsets: fresh.sentence_end_offsets.clone(),
                    ..CaptionSentenceHints::default()
                }
            ),
            "次"
        );
    }

    #[test]
    fn does_not_close_open_continuations() {
        assert_eq!(freshness_close_offsets("晴れですが寒い", Some(&[])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("食べて", Some(&[])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("隣の客は", Some(&[])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("水を", Some(&[])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("えー今日は", Some(&[])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("東京駅は", Some(&[])), Vec::<usize>::new());
        assert_eq!(
            window_of(
                "晴れですが寒い",
                0,
                WindowExtra { sentence_end_offsets: Some(vec![]), ..WindowExtra::default() }
            )
            .source_text,
            "晴れですが寒い"
        );
    }

    #[test]
    fn does_not_close_konnichiwa_or_snap_on_interior_ni_ha() {
        let text = "こんにちはーきこえますかー";
        assert_eq!(freshness_close_offsets(text, Some(&[5])), Vec::<usize>::new());
        let mid_keep = window_of(
            text,
            1_000,
            WindowExtra {
                sentence_end_offsets: Some(vec![5]),
                soft_break_offsets: Some(vec![2, 4]),
                grapheme_painted_at: Some(painted_at(text, 0)),
                ..WindowExtra::default()
            },
        );
        assert_eq!(mid_keep.source_text, text);
        assert!(!mid_keep.source_text.starts_with('ー'));
    }

    #[test]
    fn does_not_close_mou_hashiru_from_a_surface_copula_guess() {
        let text = "もう走る次いく";
        assert_eq!(freshness_close_offsets(text, Some(&[])), Vec::<usize>::new());
        assert_eq!(
            window_of(
                text,
                0,
                WindowExtra { sentence_end_offsets: Some(vec![]), ..WindowExtra::default() }
            )
            .source_text,
            text
        );
        assert_eq!(
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: caption(
                    text,
                    CaptionExtra {
                        is_final: Some(true),
                        translation_text: Some("It is sunny".to_string()),
                        ..CaptionExtra::default()
                    }
                ),
                now: CAPTION_FRESHNESS_MS,
                grapheme_painted_at: &painted_at(text, 0),
                last_growth_at: 0,
                previous_source_text: text,
                token_char_ends: None,
            })
            .source_text,
            ""
        );
    }

    #[test]
    fn keeps_a_pure_interim_without_translation_after_5s() {
        let text = "もう走る次いく";
        let display = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    is_final: Some(false),
                    translation_text: Some(String::new()),
                    ..CaptionExtra::default()
                },
            ),
            now: CAPTION_FRESHNESS_MS,
            grapheme_painted_at: &painted_at(text, 0),
            last_growth_at: 0,
            previous_source_text: text,
            token_char_ends: None,
        });
        assert_eq!(display.source_text, text);
    }

    #[test]
    fn allows_a_finalized_standalone_un_to_expire_after_5s_idle_without_a_translation() {
        let finalized = |source_text: &str, now: i64| {
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: caption(
                    source_text,
                    CaptionExtra {
                        is_final: Some(true),
                        translation_text: Some(String::new()),
                        ..CaptionExtra::default()
                    },
                ),
                now,
                grapheme_painted_at: &painted_at(source_text, 0),
                last_growth_at: 0,
                previous_source_text: source_text,
                token_char_ends: None,
            })
        };
        assert_eq!(finalized("うん", 0).source_text, "うん");
        assert_eq!(finalized("うん", CAPTION_FRESHNESS_MS).source_text, "");
        assert_eq!(finalized("うん", CAPTION_FRESHNESS_MS).translation_text, "");
    }

    #[test]
    fn allows_a_non_final_translated_caption_to_expire_after_5s_idle() {
        let text = "うん";
        let held = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    is_final: Some(false),
                    translation_text: Some("yeah".to_string()),
                    ..CaptionExtra::default()
                },
            ),
            now: CAPTION_FRESHNESS_MS - 1,
            grapheme_painted_at: &painted_at(text, 0),
            last_growth_at: 0,
            previous_source_text: text,
            token_char_ends: None,
        });
        assert_eq!(held.source_text, text);
        assert_eq!(held.translation_text, "yeah");
        let expired = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    is_final: Some(false),
                    translation_text: Some("yeah".to_string()),
                    ..CaptionExtra::default()
                },
            ),
            now: CAPTION_FRESHNESS_MS,
            grapheme_painted_at: &painted_at(text, 0),
            last_growth_at: 0,
            previous_source_text: text,
            token_char_ends: None,
        });
        assert_eq!(expired.source_text, "");
        assert_eq!(expired.translation_text, "");
    }

    #[test]
    fn does_not_close_jodoushi_masu_and_does_close_desu_deshita_datta() {
        assert_eq!(freshness_close_offsets("しています今日は", Some(&[5])), Vec::<usize>::new());
        assert_eq!(freshness_close_offsets("今日は晴れです明日は", Some(&[7])), vec![7]);
        assert_eq!(freshness_close_offsets("昨日は雨でした今日は", Some(&[8])), vec![8]);
        assert_eq!(freshness_close_offsets("学生だった次", Some(&[5])), vec![5]);
        assert_eq!(
            window_of(
                "しています今日は",
                CAPTION_FRESHNESS_MS,
                WindowExtra { sentence_end_offsets: Some(vec![5]), ..WindowExtra::default() }
            )
            .source_text,
            ""
        );
    }

    #[test]
    fn keeps_the_newest_chunk_while_the_source_is_still_growing_instead_of_going_empty() {
        let lead = "今日は晴れです";
        let text = "今日は晴れです明日は";
        let mut painted = painted_at(lead, 0);
        painted.extend(caption_graphemes("明日は").into_iter().map(|_| CAPTION_FRESHNESS_MS));
        let display = window_of(
            text,
            CAPTION_FRESHNESS_MS,
            WindowExtra {
                sentence_end_offsets: Some(vec![7]),
                previous_source_text: Some(lead),
                last_growth_at: Some(CAPTION_FRESHNESS_MS),
                grapheme_painted_at: Some(painted),
                ..WindowExtra::default()
            },
        );
        assert_eq!(display.source_text, "明日は");
        assert!(!display.source_text.is_empty());
    }

    #[test]
    fn keeps_the_newest_open_chunk_when_a_rewrite_would_otherwise_empty_the_plate() {
        let text = "明日は";
        let display = window_of(
            text,
            CAPTION_FRESHNESS_MS,
            WindowExtra {
                previous_source_text: Some("昨日"),
                last_growth_at: Some(CAPTION_FRESHNESS_MS),
                grapheme_painted_at: Some(painted_at(text, 0)),
                ..WindowExtra::default()
            },
        );
        assert_eq!(display.source_text, text);
    }

    #[test]
    fn restores_the_newest_chunk_when_every_grapheme_expires_on_a_growth_tick() {
        let lead = "今日は晴れです";
        let text = format!("{lead}明日は");
        let display = window_of(
            &text,
            CAPTION_FRESHNESS_MS,
            WindowExtra {
                sentence_end_offsets: Some(vec![7]),
                previous_source_text: Some(lead),
                last_growth_at: Some(CAPTION_FRESHNESS_MS),
                grapheme_painted_at: Some(painted_at(&text, 0)),
                ..WindowExtra::default()
            },
        );
        assert_eq!(display.source_text, "明日は");
    }

    #[test]
    fn empties_an_idle_open_chunk_at_last_growth_plus_5000_and_clears_translation_with_it() {
        let text = "食べて";
        let empty = window_of(
            text,
            CAPTION_FRESHNESS_MS,
            WindowExtra {
                last_growth_at: Some(0),
                previous_source_text: Some(text),
                translation_text: Some("eating".to_string()),
                ..WindowExtra::default()
            },
        );
        assert_eq!(empty.source_text, "");
        assert_eq!(empty.translation_text, "");
        let still_held = window_of(
            text,
            CAPTION_FRESHNESS_MS - 1,
            WindowExtra {
                last_growth_at: Some(0),
                previous_source_text: Some(text),
                translation_text: Some("eating".to_string()),
                ..WindowExtra::default()
            },
        );
        assert_eq!(still_held.source_text, text);
        assert_eq!(still_held.translation_text, "eating");
        let waiting_for_idle = window_of(
            text,
            CAPTION_FRESHNESS_MS,
            WindowExtra {
                last_growth_at: Some(1_000),
                previous_source_text: Some(text),
                translation_text: Some("eating".to_string()),
                grapheme_painted_at: Some(painted_at(text, 0)),
                ..WindowExtra::default()
            },
        );
        assert_eq!(waiting_for_idle.source_text, text);
        assert_eq!(waiting_for_idle.translation_text, "eating");
    }

    #[test]
    fn snaps_to_a_soft_break_then_walks_back_so_the_plate_does_not_start_with_chouon() {
        let text = "今日はー続く";
        let display = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    sentence_end_offsets: Some(vec![]),
                    soft_break_offsets: Some(vec![3]),
                    ..CaptionExtra::default()
                },
            ),
            now: CAPTION_FRESHNESS_MS,
            grapheme_painted_at: &painted_at(text, 0),
            last_growth_at: 0,
            previous_source_text: text,
            token_char_ends: None,
        });
        assert!(!display.source_text.starts_with('ー'));
    }

    #[test]
    fn snaps_to_the_leftmost_soft_inside_the_current_token_when_no_left_close_exists() {
        let text = "今日はとても良い";
        let mut painted = painted_at("今日はと", 0);
        painted.extend(painted_at("ても良い", 7_500));
        let display = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    sentence_end_offsets: Some(vec![]),
                    soft_break_offsets: Some(vec![5]),
                    ..CaptionExtra::default()
                },
            ),
            now: 8_000,
            grapheme_painted_at: &painted,
            last_growth_at: 7_500,
            previous_source_text: text,
            token_char_ends: Some(&[8]),
        });
        assert_eq!(display.source_text, "も良い");
    }

    #[test]
    fn stamps_prefix_growth_and_rewrites_grapheme_painted_at_without_sleeping() {
        assert_eq!(
            stamp_grapheme_painted_at("こん", &[1, 1], "こんにちは", 9),
            vec![1, 1, 9, 9, 9]
        );
        assert_eq!(stamp_grapheme_painted_at("あした", &[1, 1, 1], "明日は", 4), vec![4, 4, 4]);
        assert_eq!(
            stamp_grapheme_painted_at("こんにちは", &[1, 2, 3, 4, 5], "こんにちは", 9),
            vec![1, 2, 3, 4, 5]
        );
        assert_eq!(stamp_grapheme_painted_at("x", &[1], "", 9), Vec::<i64>::new());
    }

    #[test]
    fn returns_an_empty_plate_for_blank_source_and_restamps_mismatched_painted_at() {
        assert_eq!(
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: caption(
                    "  ",
                    CaptionExtra {
                        translation_text: Some("kept".to_string()),
                        ..CaptionExtra::default()
                    }
                ),
                now: 10,
                grapheme_painted_at: &[0],
                last_growth_at: 0,
                previous_source_text: "",
                token_char_ends: None,
            })
            .source_text,
            ""
        );
        let restamped = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                "明日は",
                CaptionExtra { sentence_end_offsets: Some(vec![]), ..CaptionExtra::default() },
            ),
            now: 10,
            grapheme_painted_at: &[0],
            last_growth_at: 10,
            previous_source_text: "",
            token_char_ends: None,
        });
        assert_eq!(restamped.source_text, "明日は");
    }

    #[test]
    fn keeps_preview_and_empty_plates_outside_the_freshness_ttl() {
        let preview = caption(
            "表示を維持",
            CaptionExtra {
                id: Some("preview".to_string()),
                translation_text: Some("keep visible".to_string()),
                ..CaptionExtra::default()
            },
        );
        let empty = caption(
            "表示を維持",
            CaptionExtra {
                id: Some("empty".to_string()),
                translation_text: Some("keep visible".to_string()),
                ..CaptionExtra::default()
            },
        );
        assert_eq!(
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: preview.clone(),
                now: CAPTION_FRESHNESS_MS * 2,
                grapheme_painted_at: &painted_at("表示を維持", 0),
                last_growth_at: 0,
                previous_source_text: "表示を維持",
                token_char_ends: None,
            }),
            preview
        );
        assert_eq!(
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: empty.clone(),
                now: CAPTION_FRESHNESS_MS * 2,
                grapheme_painted_at: &painted_at("表示を維持", 0),
                last_growth_at: 0,
                previous_source_text: "表示を維持",
                token_char_ends: None,
            }),
            empty
        );
    }

    #[test]
    fn keeps_a_same_length_grammar_lead_substitution_instead_of_inheriting_stale_painted_at() {
        let previous = "アイウ今日は晴れ";
        let next = "エオカ今日は晴れ";
        let display = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                next,
                CaptionExtra {
                    translation_text: Some("sunny".to_string()),
                    ..CaptionExtra::default()
                },
            ),
            now: 5_001,
            grapheme_painted_at: &painted_at(previous, 0),
            last_growth_at: 4_900,
            previous_source_text: previous,
            token_char_ends: None,
        });
        assert!(display.source_text.starts_with("エオカ"));
    }

    #[test]
    fn clamps_keep_from_back_to_the_newest_chunk_start_while_that_chunk_is_still_growing() {
        let text = "今日は晴れです明日は雨です";
        let mut painted = painted_at("今日は晴れです", 0);
        painted.extend(painted_at("明日は", 1_000));
        painted.extend(painted_at("雨です", 7_500));
        let display = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra { sentence_end_offsets: Some(vec![7]), ..CaptionExtra::default() },
            ),
            now: 8_000,
            grapheme_painted_at: &painted,
            last_growth_at: 8_000,
            previous_source_text: "今日は晴れです明日は雨",
            token_char_ends: None,
        });
        assert_eq!(display.source_text, "明日は雨です");
    }

    #[test]
    fn blanks_at_t_5001_when_clocks_stay_at_first_paint_after_a_late_translation() {
        let text = "食べて";
        let frozen = apply_caption_freshness_window(CaptionFreshnessInput {
            caption: caption(
                text,
                CaptionExtra {
                    is_final: Some(false),
                    translation_text: Some("eating".to_string()),
                    ..CaptionExtra::default()
                },
            ),
            now: 5_001,
            grapheme_painted_at: &painted_at(text, 0),
            last_growth_at: 0,
            previous_source_text: text,
            token_char_ends: None,
        });
        assert_eq!(frozen.source_text, "");
        assert_eq!(frozen.translation_text, "");
    }

    #[test]
    fn keeps_hook_restamped_clocks_visible_at_t_5001_and_t_9400_then_blanks_at_t_9600() {
        let text = "食べて";
        let later = |now: i64| {
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: caption(
                    text,
                    CaptionExtra {
                        is_final: Some(false),
                        translation_text: Some("eating".to_string()),
                        ..CaptionExtra::default()
                    },
                ),
                now,
                grapheme_painted_at: &painted_at(text, 4_500),
                last_growth_at: 4_500,
                previous_source_text: text,
                token_char_ends: None,
            })
        };
        assert_eq!(later(5_001).source_text, text);
        assert_eq!(later(9_400).source_text, text);
        assert_eq!(later(9_600).source_text, "");
        assert_eq!(later(9_600).translation_text, "");
    }

    #[test]
    fn keeps_a_restamped_finalized_caption_visible_at_t_5001() {
        let text = "うん";
        assert_eq!(
            apply_caption_freshness_window(CaptionFreshnessInput {
                caption: caption(
                    text,
                    CaptionExtra {
                        is_final: Some(true),
                        translation_text: Some(String::new()),
                        ..CaptionExtra::default()
                    },
                ),
                now: 5_001,
                grapheme_painted_at: &painted_at(text, 4_500),
                last_growth_at: 4_500,
                previous_source_text: text,
                token_char_ends: None,
            })
            .source_text,
            text
        );
    }
}
