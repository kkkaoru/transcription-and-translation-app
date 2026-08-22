//! Grapheme-budget layout and two-line plate wrapping.
//!
//! Port of segmentation / wrapping in `apps/desktop/src/overlay/captions.ts`.

use crate::display::{
    has_displayable_translation_text, restore_collapsed_continuation, sanitize_caption_display_text,
};
use crate::grapheme::{caption_graphemes, unicode_scalars};
use crate::payload::{CaptionPayload, CaptionRowKey};
use crate::sentence::{
    detect_caption_soft_breaks, rebase_caption_soft_break_offsets, select_visible_caption_sentence,
    CaptionSentenceHints, CaptionSentenceKey,
};

/// Character budget for one logical Japanese source line.
pub const SOURCE_CAPTION_MAX_CHARS: usize = 28;
/// Character budget for one logical English translation line.
pub const TRANSLATION_CAPTION_MAX_CHARS: usize = 48;
/// Narrowest useful line.
pub const CAPTION_MAX_CHARS_MIN: usize = 4;
/// Widest supported logical line.
pub const CAPTION_MAX_CHARS_MAX: usize = 200;
/// How many logical lines the overlay keeps on screen at once.
pub const CAPTION_MAX_VISIBLE_LINES: usize = 2;

const PREFERRED_BREAK: &[char] =
    &['。', '．', '！', '？', '!', '?', '、', ',', '，', '；', ';', '：', ':'];

const VIBRATO_MORPH_BREAK_AFTER: &[&str] = &[
    "から",
    "まで",
    "より",
    "など",
    "って",
    "では",
    "には",
    "とは",
    "のは",
    "が",
    "を",
    "に",
    "へ",
    "で",
    "と",
    "も",
    "の",
    "や",
    "か",
    "は",
    "ね",
    "よ",
    "な",
    "て",
    "た",
    "だ",
    "です",
    "ます",
    "でした",
    "ました",
];

/// One caption row ready for wrapping.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptionItem {
    pub key: CaptionRowKey,
    pub text: String,
    pub max_chars: usize,
    pub azookey_input_text: Option<String>,
    pub sentence_end_offsets: Option<Vec<usize>>,
    pub soft_break_offsets: Option<Vec<usize>>,
    pub defer_sentence_paging: bool,
    pub max_lines: Option<usize>,
    pub partial_window_text: Option<String>,
}

/// One styled span inside a logical line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptionTextSegment {
    pub text: String,
    pub dimmed: bool,
}

/// Overlay order for source vs translation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionOrder {
    SourceFirst,
    TranslationFirst,
}

/// Minimal config needed to build caption items.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptionLayoutConfig {
    pub order: CaptionOrder,
    pub source_max_chars: usize,
    pub translation_max_chars: usize,
}

impl Default for CaptionLayoutConfig {
    fn default() -> Self {
        Self {
            order: CaptionOrder::SourceFirst,
            source_max_chars: SOURCE_CAPTION_MAX_CHARS,
            translation_max_chars: TRANSLATION_CAPTION_MAX_CHARS,
        }
    }
}

/// Per-row fallback used whenever a configured budget is missing or unusable.
pub fn default_caption_max_chars(key: CaptionRowKey) -> usize {
    match key {
        CaptionRowKey::Translation => TRANSLATION_CAPTION_MAX_CHARS,
        CaptionRowKey::Source | CaptionRowKey::Prediction => SOURCE_CAPTION_MAX_CHARS,
    }
}

/// Clamp one caption budget into the supported range.
pub fn clamp_caption_max_chars(value: Option<i64>, key: CaptionRowKey) -> usize {
    match value {
        Some(number) if number >= 0 => {
            let floored = number as usize;
            floored.clamp(CAPTION_MAX_CHARS_MIN, CAPTION_MAX_CHARS_MAX)
        }
        _ => default_caption_max_chars(key),
    }
}

/// Resolve the configured budget for one caption row.
pub fn resolve_caption_max_chars(config: &CaptionLayoutConfig, key: CaptionRowKey) -> usize {
    let style_key = if key == CaptionRowKey::Prediction { CaptionRowKey::Source } else { key };
    match style_key {
        CaptionRowKey::Translation => {
            clamp_caption_max_chars(Some(config.translation_max_chars as i64), style_key)
        }
        _ => clamp_caption_max_chars(Some(config.source_max_chars as i64), style_key),
    }
}

fn is_vibrato_morph_break(graphemes: &[String], end_exclusive: usize) -> bool {
    if end_exclusive == 0 || end_exclusive > graphemes.len() {
        return false;
    }
    let prefix = graphemes[..end_exclusive].join("");
    VIBRATO_MORPH_BREAK_AFTER.iter().any(|suffix| prefix.ends_with(suffix))
}

fn is_preferred_break(character: &str) -> bool {
    character.chars().next().is_some_and(|first| PREFERRED_BREAK.contains(&first))
        || character.chars().any(char::is_whitespace)
}

fn prefer_natural_break_index(
    graphemes: &[String],
    limit: usize,
    floor: usize,
    soft_break_offsets: &[usize],
) -> usize {
    let soft_set: Vec<usize> = soft_break_offsets
        .iter()
        .copied()
        .filter(|offset| *offset > floor && *offset <= limit)
        .collect();
    let mut punctuation_break = 0;
    let mut index = limit;
    loop {
        if soft_set.contains(&index) {
            return index;
        }
        if is_vibrato_morph_break(graphemes, index) {
            return index;
        }
        if punctuation_break == 0 {
            if let Some(character) = graphemes.get(index.saturating_sub(1)) {
                if is_preferred_break(character) {
                    punctuation_break = index;
                }
            }
        }
        if index == 0 || index <= floor {
            break;
        }
        index -= 1;
    }
    if punctuation_break == 0 {
        limit
    } else {
        punctuation_break
    }
}

fn soft_break_grapheme_offsets(text: &str, scalar_offsets: &[usize]) -> Vec<usize> {
    if scalar_offsets.is_empty() {
        return Vec::new();
    }
    let scalars = unicode_scalars(text);
    let graphemes = caption_graphemes(text);
    if scalars.len() == graphemes.len() {
        return scalar_offsets
            .iter()
            .copied()
            .filter(|offset| *offset > 0 && *offset <= graphemes.len())
            .collect();
    }
    let mut mapped = Vec::new();
    let mut scalar_index = 0;
    let mut grapheme_index = 0;
    let mut wanted: Vec<usize> = scalar_offsets.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    let mut want_at = 0;
    while grapheme_index < graphemes.len() && want_at < wanted.len() {
        let cluster = graphemes[grapheme_index].as_str();
        let cluster_scalars = cluster.chars().count();
        scalar_index += cluster_scalars;
        grapheme_index += 1;
        while want_at < wanted.len() && wanted[want_at] <= scalar_index {
            mapped.push(grapheme_index);
            want_at += 1;
        }
    }
    mapped
}

fn is_whitespace_grapheme(grapheme: &str) -> bool {
    grapheme.trim().is_empty()
}

fn trim_graphemes(graphemes: &[String]) -> Vec<String> {
    let mut start = 0;
    let mut end = graphemes.len();
    while start < end && is_whitespace_grapheme(&graphemes[start]) {
        start += 1;
    }
    while end > start && is_whitespace_grapheme(&graphemes[end - 1]) {
        end -= 1;
    }
    graphemes[start..end].to_vec()
}

fn trim_start_graphemes(graphemes: &[String]) -> Vec<String> {
    let mut start = 0;
    while start < graphemes.len() && is_whitespace_grapheme(&graphemes[start]) {
        start += 1;
    }
    graphemes[start..].to_vec()
}

fn split_long_line(line: &str, max_chars: usize, soft_break_offsets: &[usize]) -> Vec<String> {
    let characters = caption_graphemes(line);
    let soft_graphemes = soft_break_grapheme_offsets(line, soft_break_offsets);
    if characters.len() <= max_chars {
        return if characters.is_empty() {
            vec![line.to_string()]
        } else {
            vec![characters.join("")]
        };
    }
    let mut segments = Vec::new();
    let mut remaining = characters;
    let mut consumed = 0;
    while remaining.len() > max_chars {
        let early_floor = (max_chars * 7 / 10).max(1);
        let relative_soft: Vec<usize> = soft_graphemes
            .iter()
            .filter_map(|offset| offset.checked_sub(consumed))
            .filter(|offset| *offset > 0)
            .collect();
        let break_at =
            prefer_natural_break_index(&remaining, max_chars, early_floor, &relative_soft);
        let segment = trim_graphemes(&remaining[..break_at]).join("");
        if !segment.is_empty() {
            segments.push(segment);
        }
        remaining = trim_start_graphemes(&remaining[break_at..]);
        consumed += break_at;
    }
    let tail = trim_graphemes(&remaining).join("");
    if !tail.is_empty() {
        segments.push(tail);
    }
    if segments.is_empty() {
        vec![line.trim().to_string()]
    } else {
        segments
    }
}

/// Keep only the newest sentence, then the newest grapheme window.
pub fn trim_caption_to_display_window(
    text: &str,
    max_chars: usize,
    max_lines: usize,
    hints: &CaptionSentenceHints,
) -> String {
    let sanitized = sanitize_caption_display_text(text);
    let normalized = restore_collapsed_continuation(
        &sanitized,
        &select_visible_caption_sentence(&sanitized, hints),
    );
    if normalized.is_empty() {
        return String::new();
    }
    let safe_max_chars = max_chars.max(1);
    let safe_max_lines = max_lines.max(1);
    let budget = safe_max_chars * safe_max_lines;
    let graphemes = caption_graphemes(&normalized);
    if graphemes.len() <= budget {
        return normalized;
    }
    let soft_scalar = detect_caption_soft_breaks(&normalized, hints);
    let soft_graphemes = soft_break_grapheme_offsets(&normalized, &soft_scalar);
    let mut start = graphemes.len() - budget;
    let search_end = graphemes.len().min(start + safe_max_chars / 2);
    let soft_near_cut: Vec<usize> = soft_graphemes
        .into_iter()
        .filter(|offset| *offset >= start && *offset < search_end)
        .collect();
    let mut index = start;
    while index < search_end {
        if soft_near_cut.contains(&index) || is_vibrato_morph_break(&graphemes, index) {
            start = index;
            break;
        }
        if let Some(character) = graphemes.get(index) {
            if is_preferred_break(character) && !character.trim().is_empty() {
                start = index + 1;
                break;
            }
        }
        index += 1;
    }
    trim_start_graphemes(&graphemes[start..]).join("")
}

/// Split caption text into readable logical lines without dropping content.
pub fn segment_caption_text(
    text: &str,
    max_chars: usize,
    soft_break_offsets: &[usize],
) -> Vec<String> {
    let normalized = sanitize_caption_display_text(text).trim().to_string();
    if normalized.is_empty() {
        return Vec::new();
    }
    let safe_max_chars = max_chars.max(1);
    if !normalized.contains('\n') {
        let soft = if soft_break_offsets.is_empty() {
            detect_caption_soft_breaks(&normalized, &CaptionSentenceHints::default())
        } else {
            soft_break_offsets.to_vec()
        };
        return split_long_line(&normalized, safe_max_chars, &soft);
    }
    normalized
        .split('\n')
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(split_long_line(
                    trimmed,
                    safe_max_chars,
                    &detect_caption_soft_breaks(trimmed, &CaptionSentenceHints::default()),
                ))
            }
        })
        .flatten()
        .filter(|line| !line.is_empty())
        .collect()
}

/// Keep only the newest logical lines so the plate never exceeds the visible budget.
pub fn keep_newest_caption_lines(lines: &[String], max_lines: usize) -> Vec<String> {
    let safe_max_lines = max_lines.max(1);
    if lines.len() <= safe_max_lines {
        return lines.to_vec();
    }
    lines[lines.len() - safe_max_lines..].to_vec()
}

fn style_key(key: CaptionRowKey) -> CaptionRowKey {
    if key == CaptionRowKey::Prediction {
        CaptionRowKey::Source
    } else {
        key
    }
}

fn sentence_key(key: CaptionRowKey) -> CaptionSentenceKey {
    if key == CaptionRowKey::Translation {
        CaptionSentenceKey::Translation
    } else {
        CaptionSentenceKey::Source
    }
}

/// Logical lines used by both the DOM overlay and the native canvas output.
pub fn caption_text_lines(item: &CaptionItem) -> Vec<String> {
    let style = style_key(item.key);
    let max_chars =
        if item.max_chars == 0 { default_caption_max_chars(style) } else { item.max_chars };
    let max_lines = item.max_lines.unwrap_or(CAPTION_MAX_VISIBLE_LINES).max(1);
    let hints = CaptionSentenceHints {
        key: Some(sentence_key(style)),
        azookey_input_text: item.azookey_input_text.clone(),
        sentence_end_offsets: item.sentence_end_offsets.clone(),
        soft_break_offsets: item.soft_break_offsets.clone(),
        defer_sentence_paging: Some(item.defer_sentence_paging),
        previous_text: None,
        previous_ends: None,
    };
    let windowed = trim_caption_to_display_window(&item.text, max_chars, max_lines, &hints);
    let window_hints = CaptionSentenceHints {
        soft_break_offsets: Some(rebase_caption_soft_break_offsets(
            &sanitize_caption_display_text(&item.text),
            &windowed,
            item.soft_break_offsets.as_deref().unwrap_or(&[]),
        )),
        ..hints
    };
    keep_newest_caption_lines(
        &segment_caption_text(
            &windowed,
            max_chars,
            &detect_caption_soft_breaks(&windowed, &window_hints),
        ),
        max_lines,
    )
}

/// Bound an OPEN prediction to one source-width line.
pub fn bound_partial_window_text(source_max_chars: usize, partial_window_text: &str) -> String {
    let prediction = partial_window_text.trim();
    if prediction.is_empty() {
        return String::new();
    }
    caption_graphemes(prediction).into_iter().take(source_max_chars).collect()
}

/// Wrap source and OPEN prediction as one bounded block.
pub fn caption_text_segment_lines(item: &CaptionItem) -> Vec<Vec<CaptionTextSegment>> {
    let prediction = if item.key == CaptionRowKey::Source {
        sanitize_caption_display_text(item.partial_window_text.as_deref().unwrap_or(""))
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let mut base_item = item.clone();
    base_item.partial_window_text = None;
    let base_lines = caption_text_lines(&base_item);
    if prediction.is_empty() {
        return base_lines
            .into_iter()
            .map(|line| vec![CaptionTextSegment { text: line, dimmed: false }])
            .collect();
    }
    let body = base_lines.join("").trim_end().to_string();
    let max_lines = item.max_lines.unwrap_or(CAPTION_MAX_VISIBLE_LINES);
    let budget = item.max_chars.max(1) * max_lines.max(1);
    let body_length = caption_graphemes(&body).len();
    let separator = if body.is_empty() { "" } else { " " };
    let available_prediction =
        budget.saturating_sub(body_length).saturating_sub(caption_graphemes(separator).len());
    let visible_prediction: String =
        caption_graphemes(&prediction).into_iter().take(available_prediction).collect();
    if visible_prediction.is_empty() {
        return base_lines
            .into_iter()
            .map(|line| vec![CaptionTextSegment { text: line, dimmed: false }])
            .collect();
    }
    let combined = format!("{body}{separator}{visible_prediction}");
    let lines = keep_newest_caption_lines(
        &segment_caption_text(
            &combined,
            item.max_chars,
            &detect_caption_soft_breaks(&combined, &CaptionSentenceHints::default()),
        ),
        max_lines,
    );
    let prediction_length = caption_graphemes(&visible_prediction).len();
    let total_length: usize = lines.iter().map(|line| caption_graphemes(line).len()).sum();
    let prediction_start = total_length.saturating_sub(prediction_length);
    let mut offset = 0;
    lines
        .into_iter()
        .map(|line| {
            let line_graphemes = caption_graphemes(&line);
            let line_start = offset;
            let line_end = line_start + line_graphemes.len();
            offset = line_end;
            if prediction_start <= line_start {
                vec![CaptionTextSegment { text: line, dimmed: true }]
            } else if prediction_start >= line_end {
                vec![CaptionTextSegment { text: line, dimmed: false }]
            } else {
                let split_at = prediction_start - line_start;
                [
                    CaptionTextSegment { text: line_graphemes[..split_at].join(""), dimmed: false },
                    CaptionTextSegment { text: line_graphemes[split_at..].join(""), dimmed: true },
                ]
                .into_iter()
                .filter(|segment| !segment.text.is_empty())
                .collect()
            }
        })
        .collect()
}

/// Build source + translation items from a caption payload.
pub fn caption_items(
    config: &CaptionLayoutConfig,
    caption: &CaptionPayload,
    placeholder: bool,
    partial_window_text: &str,
) -> Vec<CaptionItem> {
    let prediction = sanitize_caption_display_text(partial_window_text).trim().to_string();
    let defer_sentence_paging = caption.is_provisional();
    let mut source = CaptionItem {
        key: CaptionRowKey::Source,
        text: if placeholder {
            "日本語の音声認識結果がここに表示されます".to_string()
        } else {
            sanitize_caption_display_text(&caption.source_text)
        },
        max_chars: resolve_caption_max_chars(config, CaptionRowKey::Source),
        azookey_input_text: caption.azookey_input_text.clone(),
        sentence_end_offsets: caption.sentence_end_offsets.clone(),
        soft_break_offsets: caption.soft_break_offsets.clone(),
        defer_sentence_paging,
        max_lines: None,
        partial_window_text: None,
    };
    let sanitized_translation = sanitize_caption_display_text(&caption.translation_text);
    let translation_displayable = has_displayable_translation_text(&sanitized_translation);
    let displayed_translation =
        if translation_displayable { sanitized_translation } else { String::new() };
    let translation = CaptionItem {
        key: CaptionRowKey::Translation,
        text: if placeholder {
            "English translation will appear here".to_string()
        } else {
            displayed_translation
        },
        max_chars: resolve_caption_max_chars(config, CaptionRowKey::Translation),
        azookey_input_text: None,
        sentence_end_offsets: None,
        soft_break_offsets: None,
        defer_sentence_paging,
        max_lines: None,
        partial_window_text: None,
    };
    source.partial_window_text = if !placeholder && !prediction.is_empty() {
        Some(bound_partial_window_text(source.max_chars, &prediction))
    } else {
        Some(String::new())
    };
    if config.order == CaptionOrder::SourceFirst {
        vec![source, translation]
    } else {
        vec![translation, source]
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bound_partial_window_text, caption_items, caption_text_lines, caption_text_segment_lines,
        segment_caption_text, CaptionItem, CaptionLayoutConfig, CaptionOrder,
        SOURCE_CAPTION_MAX_CHARS,
    };
    use crate::display::{create_empty_caption, create_preview_caption};
    use crate::grapheme::caption_graphemes;
    use crate::payload::{CaptionPayload, CaptionRowKey, CaptionStage};

    fn source_item(text: &str, max_chars: usize) -> CaptionItem {
        CaptionItem {
            key: CaptionRowKey::Source,
            text: text.to_string(),
            max_chars,
            azookey_input_text: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
            defer_sentence_paging: false,
            max_lines: None,
            partial_window_text: None,
        }
    }

    #[test]
    fn wraps_before_max_chars_at_a_particle_soft_break_instead_of_mid_phrase() {
        let text = "今日はとても良い天気で明日も";
        let segments = segment_caption_text(text, 12, &[]);
        assert_eq!(segments.join(""), text);
        assert!(segments.len() > 1);
        assert!(segments[0].ends_with('は') || segments[0].ends_with('で'));
        assert!(segments.iter().all(|line| caption_graphemes(line).len() <= 12));
    }

    #[test]
    fn keeps_mid_utterance_characters_until_the_hard_max_chars_times_max_lines_budget_fills() {
        let text = "隣の客はよく柿を食べる客だそうですよ";
        let lines = caption_text_lines(&CaptionItem {
            soft_break_offsets: Some(vec![3, 5, 7, 10, 12]),
            ..source_item(text, 10)
        });
        assert_eq!(lines.join(""), text);
        assert!(lines.len() <= 2);
        assert!(lines.iter().all(|line| caption_graphemes(line).len() <= 10));
    }

    #[test]
    fn clamps_soft_wrapped_segments_to_caption_max_visible_lines() {
        let text = "あいうえおかきくけこさしすせそたちつてとなにぬねの";
        let lines = caption_text_lines(&CaptionItem {
            soft_break_offsets: Some(vec![5, 10, 15, 20, 25]),
            ..source_item(text, 12)
        });
        assert!(lines.len() <= 2);
        assert!(lines.join("").chars().count() <= 24);
        assert!(text.ends_with(&lines.join("")));
    }

    #[test]
    fn still_drops_older_graphemes_once_the_hard_display_window_overflows() {
        let text = "隣の客はよく柿を食べる客だそうですよみなさん";
        let lines = caption_text_lines(&CaptionItem {
            soft_break_offsets: Some(vec![3, 5, 7, 10, 12, 16]),
            ..source_item(text, 10)
        });
        assert!(lines.join("").chars().count() <= 20);
        assert!(
            lines.join("").ends_with("そうですよみなさん") || lines.join("").ends_with("みなさん")
        );
        assert_ne!(lines.join(""), text);
    }

    #[test]
    fn normalizes_crlf_cr_line_breaks_and_trims_surrounding_whitespace() {
        assert_eq!(
            segment_caption_text("first\n   \nsecond", 20, &[]),
            vec!["first".to_string(), "second".to_string()]
        );
        assert_eq!(
            segment_caption_text(" あいう\r\nえお \r ", 10, &[]),
            vec!["あいう".to_string(), "えお".to_string()]
        );
    }

    #[test]
    fn returns_an_empty_list_for_blank_input() {
        assert_eq!(segment_caption_text("   \n  ", 10, &[]), Vec::<String>::new());
        assert_eq!(segment_caption_text("", 10, &[]), Vec::<String>::new());
        assert_eq!(caption_text_lines(&source_item("", 10)), Vec::<String>::new());
    }

    #[test]
    fn splits_a_long_line_preferring_punctuation_near_the_limit() {
        let segments = segment_caption_text("ああああ。いいいい。ううううう", 10, &[]);
        assert_eq!(segments.join(""), "ああああ。いいいい。ううううう");
        assert!(segments.len() > 1);
    }

    #[test]
    fn keeps_a_single_short_line_intact() {
        assert_eq!(segment_caption_text("こんにちは", 10, &[]), vec!["こんにちは".to_string()]);
    }

    #[test]
    fn keeps_under_budget_phrases_on_one_line_even_when_particles_could_soft_wrap() {
        assert_eq!(
            segment_caption_text("今日の天気は晴れ。", 28, &[]),
            vec!["今日の天気は晴れ。".to_string()]
        );
        assert_eq!(
            segment_caption_text("最後に質問をお受けしますね", 28, &[]),
            vec!["最後に質問をお受けしますね".to_string()]
        );
    }

    #[test]
    fn breaks_after_a_preferred_break_punctuation_that_carries_a_combining_mark() {
        let punct = "ああああ！\u{0301}あああああ";
        assert_eq!(
            segment_caption_text(punct, 8, &[]),
            vec!["ああああ！\u{0301}".to_string(), "あああああ".to_string()]
        );
        let spaced = "ああああ \u{0301}あああああ";
        assert_eq!(
            segment_caption_text(spaced, 8, &[]),
            vec!["ああああ \u{0301}".to_string(), "あああああ".to_string()]
        );
    }

    #[test]
    fn does_not_split_zwj_emoji_or_combining_marks_across_the_character_budget() {
        let family = "👨‍👩‍👧";
        let family_lines = segment_caption_text(&family.repeat(3), 2, &[]);
        let family_graphemes: Vec<String> =
            family_lines.iter().flat_map(|line| caption_graphemes(line)).collect();
        assert_eq!(
            family_graphemes,
            vec![family.to_string(), family.to_string(), family.to_string()]
        );
        assert!(family_lines.iter().all(|line| caption_graphemes(line).len() <= 2));
        assert!(family_lines.iter().all(|line| !line.starts_with('\u{200D}')));

        let combining = "か\u{3099}き\u{3099}く\u{3099}け\u{3099}こ\u{3099}";
        let combining_lines = segment_caption_text(combining, 2, &[]);
        assert_eq!(
            combining_lines
                .iter()
                .flat_map(|line| caption_graphemes(line))
                .collect::<Vec<_>>()
                .join(""),
            combining
        );
        assert!(combining_lines.iter().all(|line| caption_graphemes(line).len() <= 2));
        assert!(combining_lines.iter().all(|line| !line.starts_with('\u{3099}')));
    }

    #[test]
    fn does_not_split_a_whitespace_grapheme_cluster_when_trimming_the_remaining_tail() {
        let text = "\u{3042}\u{3042}\u{3042} \u{0301}\u{3042}\u{3042}\u{3042}";
        let lines = segment_caption_text(text, 3, &[]);
        assert!(lines.iter().all(|line| !line.starts_with('\u{0301}')));
        assert_eq!(
            lines.iter().flat_map(|line| caption_graphemes(line)).collect::<Vec<_>>().join(""),
            text
        );
    }

    #[test]
    fn consumes_pure_whitespace_grapheme_clusters_at_break_boundaries() {
        let text = "\u{3042}\u{3042} \u{3042}\u{3042}\u{3042}  \u{3042}\u{3042}\u{3042}";
        let lines = segment_caption_text(text, 3, &[]);
        assert!(lines.iter().all(|line| !line.starts_with(' ') && !line.ends_with(' ')));
        assert_eq!(lines.join(""), text.replace(|character: char| character.is_whitespace(), ""));
    }

    #[test]
    fn uses_the_configured_budget_and_honours_the_display_order() {
        let mut config = CaptionLayoutConfig::default();
        config.order = CaptionOrder::TranslationFirst;
        let caption = create_preview_caption(1);
        let items = caption_items(&config, &caption, false, "");
        assert_eq!(items[0].key, CaptionRowKey::Translation);
        assert_eq!(items[1].key, CaptionRowKey::Source);

        let long_source = "あ".repeat(60);
        let lines = caption_text_lines(&source_item(&long_source, 20));
        assert_eq!(lines.join(""), "あ".repeat(40));
        assert_eq!(lines.len(), 2);

        let overflowing = "い".repeat(120);
        let windowed = caption_text_lines(&source_item(&overflowing, 20));
        assert_eq!(windowed.join("").chars().count(), 40);
        assert_eq!(windowed.join(""), "い".repeat(40));
    }

    #[test]
    fn rebases_full_caption_soft_breaks_after_trimming_to_the_display_window() {
        let lines = caption_text_lines(&CaptionItem {
            soft_break_offsets: Some(vec![8]),
            ..source_item(&"あ".repeat(60), 10)
        });
        assert_eq!(lines, vec!["あ".repeat(10), "あ".repeat(10)]);
        assert_eq!(lines.join(""), "あ".repeat(20));
    }

    #[test]
    fn does_not_add_a_prediction_row_when_no_open_text_is_present() {
        let config = CaptionLayoutConfig::default();
        let items = caption_items(&config, &create_empty_caption(), false, "   ");
        assert!(items.iter().all(|item| item.key != CaptionRowKey::Prediction));
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert_eq!(bound_partial_window_text(source.max_chars, "   "), "");
    }

    #[test]
    fn bounds_an_open_prediction_to_one_source_width_line_before_combined_wrapping() {
        let config = CaptionLayoutConfig {
            source_max_chars: 10,
            translation_max_chars: 10,
            ..CaptionLayoutConfig::default()
        };
        let mut caption = create_preview_caption(1);
        caption.source_text = "確定済み".to_string();
        caption.translation_text.clear();
        let items = caption_items(&config, &caption, false, &"あ".repeat(30));
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert_eq!(source.partial_window_text.as_deref(), Some("ああああああああああ"));
        let segments = caption_text_segment_lines(source);
        assert_eq!(segments.len(), 2);
        let dimmed: String = segments
            .iter()
            .flatten()
            .filter(|segment| segment.dimmed)
            .map(|segment| segment.text.as_str())
            .collect();
        assert_eq!(dimmed, "あ".repeat(10));
        assert!(segments.iter().all(|line| {
            caption_graphemes(&line.iter().map(|part| part.text.as_str()).collect::<String>()).len()
                <= 10
        }));
    }

    #[test]
    fn keeps_a_full_two_line_completed_source_instead_of_deleting_it_for_a_prediction() {
        let config = CaptionLayoutConfig {
            source_max_chars: 10,
            translation_max_chars: 10,
            ..CaptionLayoutConfig::default()
        };
        let mut caption = create_preview_caption(1);
        caption.source_text = "い".repeat(30);
        caption.translation_text.clear();
        let items = caption_items(&config, &caption, false, "新しい予測");
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        let segments = caption_text_segment_lines(source);
        assert_eq!(
            segments
                .iter()
                .map(|line| line.iter().map(|segment| segment.text.as_str()).collect::<String>())
                .collect::<Vec<_>>(),
            vec!["い".repeat(10), "い".repeat(10)]
        );
        assert!(segments.iter().flatten().all(|segment| !segment.dimmed));
    }

    #[test]
    fn clamps_an_external_prediction_item_to_one_line_with_the_source_default_budget() {
        assert_eq!(
            caption_text_lines(&CaptionItem {
                key: CaptionRowKey::Prediction,
                text: "あ".repeat(40),
                max_chars: 0,
                azookey_input_text: None,
                sentence_end_offsets: None,
                soft_break_offsets: None,
                defer_sentence_paging: false,
                max_lines: Some(0),
                partial_window_text: None,
            }),
            vec!["あ".repeat(SOURCE_CAPTION_MAX_CHARS)]
        );
    }

    #[test]
    fn keeps_translation_and_appends_the_open_prediction_inside_the_source_block() {
        let mut config = CaptionLayoutConfig::default();
        config.order = CaptionOrder::TranslationFirst;
        let mut caption = create_preview_caption(1);
        caption.id = "old-turn".to_string();
        caption.source_text = "古い確定字幕".to_string();
        caption.translation_text = "Old caption".to_string();
        caption.is_final = Some(true);
        let items = caption_items(&config, &caption, false, "新しい予測文字");
        assert_eq!(
            items.iter().map(|item| item.key).collect::<Vec<_>>(),
            vec![CaptionRowKey::Translation, CaptionRowKey::Source]
        );
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        let translation = items.iter().find(|item| item.key == CaptionRowKey::Translation).unwrap();
        assert_eq!(source.text, "古い確定字幕");
        assert_eq!(source.partial_window_text.as_deref(), Some("新しい予測文字"));
        assert_eq!(translation.text, "Old caption");
        assert_eq!(
            caption_text_segment_lines(source),
            vec![vec![
                crate::layout::CaptionTextSegment {
                    text: "古い確定字幕 ".to_string(),
                    dimmed: false,
                },
                crate::layout::CaptionTextSegment {
                    text: "新しい予測文字".to_string(),
                    dimmed: true,
                },
            ]]
        );
    }

    #[test]
    fn keeps_an_ellipsis_terminated_translation_displayable() {
        let mut caption = create_preview_caption(1);
        caption.translation_text = "Even so, the translation remains visible...".to_string();
        let items = caption_items(&CaptionLayoutConfig::default(), &caption, false, "");
        let translation = items.iter().find(|item| item.key == CaptionRowKey::Translation).unwrap();
        assert_eq!(translation.text, "Even so, the translation remains visible");
        assert_eq!(
            caption_text_lines(translation),
            vec!["Even so, the translation remains visible".to_string()]
        );
    }

    #[test]
    fn switches_to_the_newest_japanese_sentence_instead_of_stacking_two_finished_lines() {
        assert_eq!(
            caption_text_lines(&source_item("今日は晴れです。明日は雨です。", 28)),
            vec!["明日は雨です。".to_string()]
        );
    }

    #[test]
    fn keeps_the_longer_lead_after_a_completed_azookey_copula_when_the_tail_is_shorter() {
        let text = "今日は晴れです明日は雨";
        assert_eq!(
            caption_text_lines(&CaptionItem {
                azookey_input_text: Some("きょうははれですあしたはあめ".to_string()),
                ..source_item(text, 28)
            }),
            vec![text.to_string()]
        );
    }

    #[test]
    fn keeps_the_lead_sentence_when_live_interim_marks_defer_sentence_paging() {
        let text = "今日は晴れです明日は雨";
        assert_eq!(
            caption_text_lines(&CaptionItem {
                azookey_input_text: Some("きょうははれですあしたはあめ".to_string()),
                defer_sentence_paging: true,
                ..source_item(text, 28)
            }),
            vec![text.to_string()]
        );
    }

    #[test]
    fn keeps_the_longer_lead_on_non_final_caption_items_when_the_copula_tail_is_shorter() {
        let text = "今日は晴れです明日は雨";
        let caption = CaptionPayload {
            id: "u-1".to_string(),
            source_text: text.to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(false),
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        };
        let items = caption_items(&CaptionLayoutConfig::default(), &caption, false, "");
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert!(!source.defer_sentence_paging);
        assert_eq!(caption_text_lines(source), vec![text.to_string()]);
    }

    #[test]
    fn keeps_the_lead_sentence_on_a_provisional_first_hypothesis_with_desu_plus_next_clause() {
        let text = "今日は晴れです明日は雨";
        let caption = CaptionPayload {
            id: "u-1".to_string(),
            source_text: text.to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(false),
            provisional: Some(true),
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        };
        let items = caption_items(&CaptionLayoutConfig::default(), &caption, false, "");
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert!(source.defer_sentence_paging);
        assert_eq!(caption_text_lines(source), vec![text.to_string()]);
    }

    #[test]
    fn pages_past_explicit_punctuation_on_non_final_captions() {
        let caption = CaptionPayload {
            id: "u-1".to_string(),
            source_text: "今日は晴れです。明日は雨".to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(false),
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        };
        let items = caption_items(&CaptionLayoutConfig::default(), &caption, false, "");
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert_eq!(caption_text_lines(source), vec!["明日は雨".to_string()]);
    }

    #[test]
    fn keeps_the_longer_lead_on_finalized_captions_when_the_copula_tail_is_shorter() {
        let text = "今日は晴れです明日は雨";
        let caption = CaptionPayload {
            id: "u-1".to_string(),
            source_text: text.to_string(),
            azookey_input_text: None,
            translation_text: String::new(),
            source_language: "ja".to_string(),
            target_language: "en".to_string(),
            started_at: 1,
            received_at: 2,
            stage: Some(CaptionStage::Source),
            sequence: Some(0),
            is_final: Some(true),
            provisional: None,
            capture_generation: None,
            sentence_end_offsets: None,
            soft_break_offsets: None,
        };
        let items = caption_items(&CaptionLayoutConfig::default(), &caption, false, "");
        let source = items.iter().find(|item| item.key == CaptionRowKey::Source).unwrap();
        assert!(!source.defer_sentence_paging);
        assert_eq!(caption_text_lines(source), vec![text.to_string()]);
    }

    #[test]
    fn pages_english_translation_by_sentence_punctuation() {
        assert_eq!(
            caption_text_lines(&CaptionItem {
                key: CaptionRowKey::Translation,
                text: "It is sunny today. It will rain tomorrow.".to_string(),
                max_chars: 48,
                azookey_input_text: None,
                sentence_end_offsets: None,
                soft_break_offsets: None,
                defer_sentence_paging: false,
                max_lines: None,
                partial_window_text: None,
            }),
            vec!["It will rain tomorrow.".to_string()]
        );
    }

    #[test]
    fn keeps_a_long_translated_surface_within_its_two_line_display_window() {
        assert_eq!(
            caption_text_lines(&CaptionItem {
                key: CaptionRowKey::Translation,
                text: "A".repeat(120),
                max_chars: 48,
                azookey_input_text: None,
                sentence_end_offsets: None,
                soft_break_offsets: None,
                defer_sentence_paging: false,
                max_lines: None,
                partial_window_text: None,
            }),
            vec!["A".repeat(48), "A".repeat(48)]
        );
    }

    #[test]
    fn uses_vibrato_sentence_offsets_only_when_the_next_span_dominates_the_lead() {
        let short_tail = "短いです続く文";
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![4]),
                ..source_item(short_tail, 28)
            }),
            vec![short_tail.to_string()]
        );
        let lead = "短いです";
        let tail = "これから午後の予定と明日の議題";
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![4]),
                ..source_item(&format!("{lead}{tail}"), 28)
            }),
            vec![tail.to_string()]
        );
    }

    #[test]
    fn pages_messy_live_speech_from_vibrato_pos_offsets_rather_than_surface_copulas() {
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![]),
                ..source_item("もう走る次いく", 28)
            }),
            vec!["もう走る次いく".to_string()]
        );
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![]),
                ..source_item("えー今日は", 28)
            }),
            vec!["えー今日は".to_string()]
        );
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![]),
                ..source_item("ちょっと待って", 28)
            }),
            vec!["ちょっと待って".to_string()]
        );
    }

    #[test]
    fn drops_older_recognition_once_the_display_window_is_exceeded() {
        let older = "ふ".repeat(28);
        let newer = "あ".repeat(56);
        let lines = caption_text_lines(&source_item(&format!("{older}{newer}"), 28));
        assert_eq!(lines.join(""), newer);
        assert!(!lines.join("").contains('ふ'));
    }

    #[test]
    fn places_placeholder_copy_without_a_live_prediction_row_when_requested() {
        let items = caption_items(
            &CaptionLayoutConfig::default(),
            &create_preview_caption(1),
            true,
            "ignored prediction",
        );
        assert!(items[0].text.contains("日本語の音声認識"));
        assert!(items[1].text.contains("English translation"));
        assert!(items.iter().all(|item| item.key != CaptionRowKey::Prediction));
    }

    #[test]
    fn caption_text_lines_restores_collapsed_elongation_and_pages_period_remainders() {
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![5]),
                ..source_item("会議を始めますー続きがあります", 28)
            }),
            vec!["会議を始めますー続きがあります".to_string()]
        );
        assert_eq!(
            caption_text_lines(&CaptionItem {
                sentence_end_offsets: Some(vec![5]),
                ..source_item("こんにちはー", 28)
            }),
            vec!["こんにちはー".to_string()]
        );
        assert_eq!(
            caption_text_lines(&source_item("こんにちは！きこえますか", 28)),
            vec!["こんにちは！きこえますか".to_string()]
        );
        assert_eq!(
            caption_text_lines(&source_item("こんにちは。終えますか", 28)).join(""),
            "聞こえますか"
        );
        assert_eq!(
            caption_text_lines(&source_item("会議を始めます。続きがあります", 28)),
            vec!["続きがあります".to_string()]
        );
    }
}
