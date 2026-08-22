//! Sentence-end detection for live caption paging.
//!
//! Documented dual of `packages/sentence-boundary`. This is **not** a wrapper
//! around `caption-bridge-vibrato-core::sentence_boundary`: that crate still
//! treats polite ます as a copula and lacks 2× remainder-dominance.

use crate::grapheme::unicode_scalars;

/// Caption row used to pick Japanese vs English paging rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptionSentenceKey {
    Source,
    Translation,
}

/// Optional pipeline hints for sentence paging and soft wraps.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CaptionSentenceHints {
    pub key: Option<CaptionSentenceKey>,
    pub azookey_input_text: Option<String>,
    pub sentence_end_offsets: Option<Vec<usize>>,
    pub soft_break_offsets: Option<Vec<usize>>,
    pub defer_sentence_paging: Option<bool>,
    pub previous_text: Option<String>,
    pub previous_ends: Option<Vec<usize>>,
}

const SENTENCE_PUNCT: &[char] = &['。', '．', '！', '？', '!', '?'];
const MIN_SOFT_WRAP_PREFIX: usize = 8;

fn is_sentence_punct(character: char) -> bool {
    SENTENCE_PUNCT.contains(&character)
}

fn normalize_caption_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").trim().to_string()
}

fn dedupe_offsets(mut offsets: Vec<usize>) -> Vec<usize> {
    offsets.sort_unstable();
    offsets.dedup();
    offsets
}

fn last_char(text: &str) -> Option<char> {
    text.chars().next_back()
}

fn first_char(text: &str) -> Option<char> {
    text.chars().next()
}

fn is_combining_mark(character: char) -> bool {
    matches!(
        character,
        '\u{0300}'..='\u{036F}' | '\u{3099}' | '\u{309A}' | '\u{FE20}'..='\u{FE2F}'
    ) || unicode_general_category::get_general_category(character)
        == unicode_general_category::GeneralCategory::NonspacingMark
}

fn ends_with_copula(trimmed: &str) -> bool {
    const COPULAS: &[&str] = &[
        "ませんでした",
        "でした",
        "ました",
        "ません",
        "でしょう",
        "だろう",
        "だった",
        "である",
        "です",
    ];
    const PARTICLES: &[&str] = &["よ", "ね", "な", "わ", "ぞ", "さ", "か"];
    COPULAS.iter().any(|copula| {
        if trimmed.ends_with(copula) {
            return true;
        }
        PARTICLES.iter().any(|particle| trimmed.ends_with(&format!("{copula}{particle}")))
    })
}

fn ends_with_past_particle(trimmed: &str) -> bool {
    const STEMS: &[&str] = &["だ", "た", "ない"];
    const PARTICLES: &[&str] = &["よ", "ね", "な", "わ", "ぞ", "さ", "か"];
    STEMS.iter().any(|stem| {
        PARTICLES.iter().any(|particle| trimmed.ends_with(&format!("{stem}{particle}")))
    })
}

fn ends_with_polite_masu_auxiliary(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    if trimmed.ends_with("ます") {
        return true;
    }
    const PARTICLES: &[&str] = &["よ", "ね", "な", "わ", "ぞ", "さ", "か"];
    PARTICLES.iter().any(|particle| trimmed.ends_with(&format!("ます{particle}")))
}

fn prefix_ends_with_punct(prefix: &str) -> bool {
    last_char(prefix.trim_end()).is_some_and(is_sentence_punct)
}

fn remainder_dominates_prefix(prefix: &str, remainder: &str) -> bool {
    unicode_scalars(remainder.trim_start()).len() >= 2 * unicode_scalars(prefix.trim_end()).len()
}

fn starts_tara_continuation(prefix: &str, remainder: &str) -> bool {
    let next = remainder.trim_start();
    if !next.starts_with('ら') {
        return false;
    }
    let base = prefix.trim_end();
    base.ends_with('か') || base.ends_with('た') || base.ends_with("です")
}

fn starts_clause_continuation(remainder: &str, english: bool) -> bool {
    let next = remainder.trim_start();
    if next.is_empty() {
        return false;
    }
    if first_char(next)
        .is_some_and(|character| is_combining_mark(character) || is_sentence_punct(character))
    {
        return true;
    }
    if english {
        first_char(next).is_some_and(|character| {
            character.is_ascii_lowercase() || matches!(character, ',' | ';' | ':')
        })
    } else {
        next.starts_with('が')
            || next.starts_with('を')
            || next.starts_with('に')
            || next.starts_with('へ')
            || next.starts_with('で')
            || next.starts_with('と')
            || next.starts_with('も')
            || next.starts_with('の')
            || next.starts_with('や')
            || next.starts_with('て')
            || next.starts_with("けど")
            || next.starts_with("けれど")
            || next.starts_with("けれども")
            || next.starts_with("から")
            || next.starts_with("ので")
            || next.starts_with('し')
            || next.starts_with('ば')
            || next.starts_with("たり")
            || next.starts_with("つつ")
            || next.starts_with("ながら")
            || next.starts_with('よ')
            || next.starts_with('ね')
            || next.starts_with('な')
            || next.starts_with('わ')
            || next.starts_with('ぞ')
            || next.starts_with('さ')
            || next.starts_with('か')
            || next.starts_with('、')
            || next.starts_with('，')
            || next.starts_with(',')
    }
}

fn remainder_starts_with_elongation(remainder: &str) -> bool {
    first_char(remainder.trim_start())
        .is_some_and(|character| matches!(character, 'ー' | '〜' | '～'))
}

fn is_japanese_sentence_end(prefix: &str, allow_copula: bool) -> bool {
    let trimmed = prefix.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    if last_char(trimmed).is_some_and(is_sentence_punct) {
        return true;
    }
    if !allow_copula {
        return false;
    }
    ends_with_copula(trimmed) || ends_with_past_particle(trimmed)
}

fn is_english_sentence_end(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    let Some(last) = last_char(trimmed) else {
        return false;
    };
    if matches!(last, '"' | '\'' | ')' | ']') {
        return trimmed
            .chars()
            .rev()
            .nth(1)
            .is_some_and(|character| matches!(character, '.' | '!' | '?'));
    }
    matches!(last, '.' | '!' | '?')
}

fn should_ignore_sentence_end_before_continuation(
    prefix: &str,
    remainder: &str,
    english: bool,
) -> bool {
    if english {
        return false;
    }
    let next = remainder.trim_start();
    if next.is_empty() {
        return false;
    }
    if remainder_starts_with_elongation(next) {
        return true;
    }
    let trimmed_prefix = prefix.trim_end();
    if starts_clause_continuation(remainder, false) || starts_tara_continuation(prefix, remainder) {
        return true;
    }
    if ends_with_polite_masu_auxiliary(trimmed_prefix) && !prefix_ends_with_punct(trimmed_prefix) {
        return true;
    }
    if !prefix_ends_with_punct(trimmed_prefix) && !remainder_dominates_prefix(trimmed_prefix, next)
    {
        return true;
    }
    if last_char(trimmed_prefix).is_some_and(|character| matches!(character, 'は' | 'も'))
        && !is_japanese_sentence_end(trimmed_prefix, true)
    {
        return true;
    }
    false
}

fn detect_heuristic_ends(text: &str, english: bool, allow_copula: bool) -> Vec<usize> {
    let chars = unicode_scalars(text);
    if chars.is_empty() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    let mut prefix = String::new();
    let mut index = 0;
    while index < chars.len() {
        prefix.push(chars[index]);
        index += 1;
        let is_end = if english {
            is_english_sentence_end(&prefix)
        } else {
            is_japanese_sentence_end(&prefix, allow_copula)
        };
        if !is_end {
            continue;
        }
        let remainder: String = chars[index..].iter().collect();
        let punctuation_continues = if english {
            prefix.ends_with(['.', '!', '?']) && remainder.starts_with(['.', '!', '?'])
        } else {
            last_char(&prefix).is_some_and(is_sentence_punct)
                && first_char(&remainder).is_some_and(is_sentence_punct)
        };
        if punctuation_continues {
            continue;
        }
        if should_ignore_sentence_end_before_continuation(&prefix, &remainder, english) {
            continue;
        }
        if english && starts_clause_continuation(&remainder, true) {
            continue;
        }
        ends.push(index);
    }
    ends
}

fn resolve_previous_sentence_ends(text: &str, hints: &CaptionSentenceHints) -> Vec<usize> {
    let Some(previous_text) = hints.previous_text.as_deref() else {
        return Vec::new();
    };
    let normalized = normalize_caption_text(text);
    let previous = normalize_caption_text(previous_text);
    if previous.is_empty() || !normalized.starts_with(&previous) {
        return Vec::new();
    }
    let previous_length = unicode_scalars(&previous).len();
    let current_length = unicode_scalars(&normalized).len();
    dedupe_offsets(
        hints
            .previous_ends
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .copied()
            .filter(|offset| *offset > 0 && *offset <= previous_length && *offset <= current_length)
            .collect(),
    )
}

/// Exclusive Unicode-scalar offsets where a caption sentence completes.
pub fn detect_caption_sentence_ends(text: &str, hints: &CaptionSentenceHints) -> Vec<usize> {
    let english = hints.key == Some(CaptionSentenceKey::Translation);
    let allow_copula = hints.defer_sentence_paging != Some(true);
    let chars = unicode_scalars(text);
    let supplied: Vec<usize> = hints
        .sentence_end_offsets
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .copied()
        .filter(|offset| {
            if *offset == 0 || *offset > chars.len() {
                return false;
            }
            let prefix: String = chars[..*offset].iter().collect();
            let remainder: String = chars[*offset..].iter().collect();
            !should_ignore_sentence_end_before_continuation(&prefix, &remainder, english)
        })
        .collect();
    let current_ends = if supplied.is_empty() {
        detect_heuristic_ends(text, english, allow_copula)
    } else {
        supplied
    };
    let reading = hints.azookey_input_text.as_deref().map(str::trim).unwrap_or("");
    let reading_ends =
        if current_ends.is_empty() && !english && !reading.is_empty() && reading == text {
            detect_heuristic_ends(reading, false, allow_copula)
        } else {
            Vec::new()
        };
    let detected_ends =
        if !current_ends.is_empty() || english { current_ends } else { reading_ends };
    dedupe_offsets(
        detected_ends.into_iter().chain(resolve_previous_sentence_ends(text, hints)).collect(),
    )
}

fn slice_newest_sentence(normalized: &str, ends: &[usize]) -> String {
    let chars = unicode_scalars(normalized);
    if ends.is_empty() {
        return normalized.to_string();
    }
    let last_end = ends[ends.len() - 1];
    if last_end >= chars.len() {
        let previous_end = if ends.len() >= 2 { ends[ends.len() - 2] } else { 0 };
        chars[previous_end..last_end].iter().collect::<String>().trim().to_string()
    } else {
        let sliced: String = chars[last_end..].iter().collect();
        let trimmed = sliced.trim();
        if trimmed.is_empty() {
            normalized.to_string()
        } else {
            trimmed.to_string()
        }
    }
}

/// Newest complete sentence, or the in-progress sentence after the last end.
pub fn select_visible_caption_sentence(text: &str, hints: &CaptionSentenceHints) -> String {
    let normalized = normalize_caption_text(text);
    if normalized.is_empty() {
        return String::new();
    }
    slice_newest_sentence(&normalized, &detect_caption_sentence_ends(&normalized, hints))
}

fn should_ignore_short_prefix_soft_break(prefix: &str, remainder: &str) -> bool {
    let next = remainder.trim_start();
    if next.is_empty() {
        return false;
    }
    let trimmed = prefix.trim_end().trim_end_matches(['ー', '〜', '～']);
    if last_char(trimmed).is_some_and(|character| {
        is_sentence_punct(character) || matches!(character, '、' | '，' | ',')
    }) {
        return false;
    }
    unicode_scalars(trimmed).len() < MIN_SOFT_WRAP_PREFIX
}

fn soft_particle_suffix(trimmed: &str) -> bool {
    trimmed.ends_with("から")
        || trimmed.ends_with("まで")
        || trimmed.ends_with("より")
        || trimmed.ends_with("など")
        || trimmed.ends_with("って")
        || trimmed.ends_with("では")
        || trimmed.ends_with("には")
        || trimmed.ends_with("とは")
        || trimmed.ends_with("のは")
        || trimmed.ends_with("けど")
        || trimmed.ends_with("けれど")
        || trimmed.ends_with("けれども")
        || trimmed.ends_with("ので")
        || last_char(trimmed).is_some_and(|character| {
            matches!(
                character,
                'が' | 'を'
                    | 'に'
                    | 'へ'
                    | 'で'
                    | 'と'
                    | 'も'
                    | 'の'
                    | 'や'
                    | 'か'
                    | 'は'
                    | 'ね'
                    | 'よ'
                    | 'な'
                    | 'て'
                    | '、'
                    | '，'
                    | ','
            )
        })
}

fn copula_after_de(next: &str) -> bool {
    next.starts_with('す')
        || next.starts_with("した")
        || next.starts_with("して")
        || next.starts_with("しょう")
}

/// Heuristic soft wrap offsets when Vibrato POS offsets are not yet present.
pub fn detect_caption_soft_breaks(text: &str, hints: &CaptionSentenceHints) -> Vec<usize> {
    let normalized = normalize_caption_text(text);
    let chars = unicode_scalars(&normalized);
    let allow_soft_break = |offset: usize| -> bool {
        if offset == 0 || offset > chars.len() {
            return false;
        }
        let prefix: String = chars[..offset].iter().collect();
        let remainder: String = chars[offset..].iter().collect();
        !should_ignore_short_prefix_soft_break(&prefix, &remainder)
    };
    let raw_supplied = hints.soft_break_offsets.as_deref().unwrap_or(&[]);
    if !raw_supplied.is_empty() {
        return dedupe_offsets(
            raw_supplied.iter().copied().filter(|offset| allow_soft_break(*offset)).collect(),
        );
    }
    if chars.is_empty() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    let mut prefix = String::new();
    let mut index = 0;
    while index < chars.len() {
        prefix.push(chars[index]);
        index += 1;
        let trimmed = prefix.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if last_char(trimmed)
            .is_some_and(|character| is_sentence_punct(character) || character == '、')
        {
            ends.push(index);
            continue;
        }
        if !soft_particle_suffix(trimmed) {
            continue;
        }
        let remainder: String = chars[index..].iter().collect();
        let next = remainder.trim_start();
        if let Some(first) = first_char(next) {
            if !is_sentence_punct(first) && !is_combining_mark(first) {
                if trimmed.ends_with('で') && copula_after_de(next) {
                    continue;
                }
                if should_ignore_short_prefix_soft_break(&prefix, &remainder) {
                    continue;
                }
                ends.push(index);
            }
        }
    }
    let sentence_ends = detect_caption_sentence_ends(&normalized, hints);
    dedupe_offsets(
        ends.into_iter().chain(sentence_ends).filter(|offset| allow_soft_break(*offset)).collect(),
    )
}

/// Rebase full-caption Unicode-scalar soft-break offsets onto a suffix window.
pub fn rebase_caption_soft_break_offsets(
    full_text: &str,
    windowed_text: &str,
    offsets: &[usize],
) -> Vec<usize> {
    if offsets.is_empty() {
        return Vec::new();
    }
    let full = unicode_scalars(&normalize_caption_text(full_text));
    let windowed = unicode_scalars(&normalize_caption_text(windowed_text));
    if windowed.len() > full.len() {
        return Vec::new();
    }
    let start = full.len() - windowed.len();
    if full[start..] != windowed[..] {
        return Vec::new();
    }
    dedupe_offsets(
        offsets
            .iter()
            .copied()
            .filter(|offset| *offset > start && *offset <= full.len())
            .map(|offset| offset - start)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        detect_caption_sentence_ends, detect_caption_soft_breaks,
        rebase_caption_soft_break_offsets, select_visible_caption_sentence, CaptionSentenceHints,
        CaptionSentenceKey,
    };

    fn hints_ends(ends: &[usize]) -> CaptionSentenceHints {
        CaptionSentenceHints {
            sentence_end_offsets: Some(ends.to_vec()),
            ..CaptionSentenceHints::default()
        }
    }

    #[test]
    fn treats_azookey_copula_endings_and_punctuation_as_completing_boundaries() {
        assert_eq!(
            detect_caption_sentence_ends("今日は晴れです", &CaptionSentenceHints::default()),
            vec![7]
        );
        assert_eq!(
            detect_caption_sentence_ends("今日は晴れです。", &CaptionSentenceHints::default()),
            vec![8]
        );
        assert_eq!(
            detect_caption_sentence_ends("行きましたよ", &CaptionSentenceHints::default()),
            vec![6]
        );
    }

    #[test]
    fn does_not_treat_polite_masu_auxiliary_as_a_sentence_end() {
        assert_eq!(
            detect_caption_sentence_ends("準備を進めています", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("確認できます", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("しています", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn does_not_split_mid_clause_desuga_continuations() {
        assert_eq!(
            detect_caption_sentence_ends("晴れですが寒い", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("晴れですので", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("だったら行く", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("ですからね", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("ですら知らない", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence("ましたら連絡します", &CaptionSentenceHints::default()),
            "ましたら連絡します"
        );
        assert_eq!(
            select_visible_caption_sentence("行きましたよ次", &CaptionSentenceHints::default()),
            "行きましたよ次"
        );
    }

    #[test]
    fn keeps_a_long_utterance_when_the_span_after_desu_masu_is_shorter_than_the_lead() {
        assert_eq!(
            select_visible_caption_sentence(
                "本日はウェビナーにご参加いただきありがとうございます最後に質問をお受けしますね",
                &CaptionSentenceHints::default()
            ),
            "本日はウェビナーにご参加いただきありがとうございます最後に質問をお受けしますね"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "本日はウェビナーにご参加いただきありがとうございます最後に質問を",
                &CaptionSentenceHints::default()
            ),
            "本日はウェビナーにご参加いただきありがとうございます最後に質問を"
        );
    }

    #[test]
    fn does_not_page_before_a_prolonged_sound_continuation() {
        assert_eq!(
            detect_caption_sentence_ends(
                "こんにちはーきこえますか",
                &CaptionSentenceHints::default()
            ),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence(
                "こんにちはーきこえますか",
                &CaptionSentenceHints::default()
            ),
            "こんにちはーきこえますか"
        );
        assert_eq!(
            select_visible_caption_sentence("こんにちはーきこえますか", &hints_ends(&[5])),
            "こんにちはーきこえますか"
        );
    }

    #[test]
    fn keeps_greetings_with_same_turn_continuations_despite_vibrato_offsets() {
        assert_eq!(
            select_visible_caption_sentence("こんにちはきこえますか", &hints_ends(&[5])),
            "こんにちはきこえますか"
        );
        assert_eq!(
            select_visible_caption_sentence("明日の天気は晴れ水確率は60%", &hints_ends(&[6])),
            "明日の天気は晴れ水確率は60%"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "明日の天気はこれから午後の予定と明日の議題についての確認",
                &hints_ends(&[6])
            ),
            "明日の天気はこれから午後の予定と明日の議題についての確認"
        );
    }

    #[test]
    fn does_not_treat_mata_as_a_past_tense_sentence_end() {
        assert_eq!(
            detect_caption_sentence_ends("明日また", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn does_not_page_past_auxiliary_ta_away_from_following_kara() {
        assert_eq!(
            detect_caption_sentence_ends(
                "でんしゃがちえんしてたからぼくはがっこうにいかない",
                &CaptionSentenceHints::default()
            ),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence(
                "でんしゃがちえんしてたからぼくはがっこうにいかない",
                &CaptionSentenceHints::default()
            ),
            "でんしゃがちえんしてたからぼくはがっこうにいかない"
        );
        assert_eq!(
            detect_caption_sentence_ends(
                "あついひはあついたべものをたべたくない",
                &CaptionSentenceHints::default()
            ),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence(
                "あついひはあついたべものをたべたくない",
                &CaptionSentenceHints::default()
            ),
            "あついひはあついたべものをたべたくない"
        );
    }

    #[test]
    fn pages_to_the_in_progress_sentence_after_punctuation_not_a_shorter_copula_tail() {
        assert_eq!(
            select_visible_caption_sentence(
                "今日は晴れです明日は雨",
                &CaptionSentenceHints::default()
            ),
            "今日は晴れです明日は雨"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "今日は晴れです。明日は雨です。",
                &CaptionSentenceHints::default()
            ),
            "明日は雨です。"
        );
    }

    #[test]
    fn keeps_a_single_incomplete_utterance_intact() {
        assert_eq!(
            select_visible_caption_sentence(
                "となりのきゃくはよく",
                &CaptionSentenceHints::default()
            ),
            "となりのきゃくはよく"
        );
    }

    #[test]
    fn prefers_vibrato_offsets_from_the_native_pipeline_when_the_next_span_dominates() {
        assert_eq!(
            select_visible_caption_sentence("短いです続く文", &hints_ends(&[4])),
            "短いです続く文"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "短いですこれから午後の予定と明日の議題",
                &hints_ends(&[4])
            ),
            "これから午後の予定と明日の議題"
        );
    }

    #[test]
    fn does_not_page_verb_adjective_stems_until_a_strong_topic_restart_arrives() {
        assert_eq!(
            detect_caption_sentence_ends("もう走る次いく", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence("もう走る次いく", &CaptionSentenceHints::default()),
            "もう走る次いく"
        );
        assert_eq!(
            detect_caption_sentence_ends("今日は寒い明日は", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence("今日は寒い明日は", &hints_ends(&[5])),
            "今日は寒い明日は"
        );
    }

    #[test]
    fn uses_the_azookey_reading_only_when_it_is_the_display_surface() {
        let reading = "きょうははれですこれから午後の予定と明日の議題についての確認";
        assert_eq!(
            detect_caption_sentence_ends(
                reading,
                &CaptionSentenceHints {
                    azookey_input_text: Some(reading.to_string()),
                    ..CaptionSentenceHints::default()
                }
            ),
            vec![8]
        );
        assert_eq!(
            detect_caption_sentence_ends(
                "今日は晴れですこれから午後の予定と明日の議題についての確認",
                &CaptionSentenceHints {
                    azookey_input_text: Some(reading.to_string()),
                    ..CaptionSentenceHints::default()
                }
            ),
            vec![7]
        );
    }

    #[test]
    fn vibrato_pos_offsets_page_messy_live_speech_cases() {
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです明日は雨", &hints_ends(&[7])),
            "今日は晴れです明日は雨"
        );
        assert_eq!(
            select_visible_caption_sentence("もう走る次いく", &hints_ends(&[])),
            "もう走る次いく"
        );
        assert_eq!(
            select_visible_caption_sentence("今日は寒い明日は", &hints_ends(&[5])),
            "今日は寒い明日は"
        );
        assert_eq!(
            select_visible_caption_sentence("行きましたよ今日は", &hints_ends(&[6])),
            "行きましたよ今日は"
        );
        assert_eq!(select_visible_caption_sentence("えー今日は", &hints_ends(&[])), "えー今日は");
        assert_eq!(
            select_visible_caption_sentence("となりのきゃくは", &hints_ends(&[])),
            "となりのきゃくは"
        );
        assert_eq!(
            select_visible_caption_sentence("ちょっと待って", &hints_ends(&[])),
            "ちょっと待って"
        );
        assert_eq!(
            select_visible_caption_sentence("うん今日行く", &hints_ends(&[])),
            "うん今日行く"
        );
        assert_eq!(
            select_visible_caption_sentence("きょうははれですあしたはあめ", &hints_ends(&[8])),
            "きょうははれですあしたはあめ"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "きょうははれですこれから午後の予定と明日の議題についての確認",
                &hints_ends(&[8])
            ),
            "これから午後の予定と明日の議題についての確認"
        );
    }

    #[test]
    fn keeps_consecutive_terminal_punctuation_as_one_sentence_end() {
        let translation = CaptionSentenceHints {
            key: Some(CaptionSentenceKey::Translation),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(select_visible_caption_sentence("Yes...", &translation), "Yes...");
        assert_eq!(select_visible_caption_sentence("Really!?", &translation), "Really!?");
        assert_eq!(select_visible_caption_sentence("Wait... Next", &translation), "Next");
        assert_eq!(
            select_visible_caption_sentence("本当！？", &CaptionSentenceHints::default()),
            "本当！？"
        );
    }

    #[test]
    fn switches_after_english_punctuation_without_splitting_abbreviations_mid_token() {
        let translation = CaptionSentenceHints {
            key: Some(CaptionSentenceKey::Translation),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(
            select_visible_caption_sentence(
                "It is sunny today. It will rain tomorrow.",
                &translation
            ),
            "It will rain tomorrow."
        );
        assert_eq!(select_visible_caption_sentence("Hello, world.", &translation), "Hello, world.");
        assert_eq!(detect_caption_sentence_ends("Hi! yes", &translation), Vec::<usize>::new());
        assert_eq!(select_visible_caption_sentence("Hi! Yes", &translation), "Yes");
    }

    #[test]
    fn treats_empty_or_whitespace_captions_as_having_no_visible_sentence() {
        assert_eq!(
            detect_caption_sentence_ends("", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("   ", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_sentence_ends("今日は", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(select_visible_caption_sentence("", &CaptionSentenceHints::default()), "");
        assert_eq!(select_visible_caption_sentence("   ", &CaptionSentenceHints::default()), "");
        assert_eq!(select_visible_caption_sentence("\r\n", &CaptionSentenceHints::default()), "");
    }

    #[test]
    fn keeps_a_copula_followed_by_punctuation_only_remainder_as_one_sentence() {
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです。", &CaptionSentenceHints::default()),
            "今日は晴れです。"
        );
        assert_eq!(
            select_visible_caption_sentence("です。あしたは", &CaptionSentenceHints::default()),
            "あしたは"
        );
    }

    #[test]
    fn keeps_the_lead_sentence_when_defer_sentence_paging_skips_copula_paging() {
        let defer = CaptionSentenceHints {
            defer_sentence_paging: Some(true),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです明日は雨", &defer),
            "今日は晴れです明日は雨"
        );
        assert_eq!(
            detect_caption_sentence_ends("今日は晴れです明日は雨", &defer),
            Vec::<usize>::new()
        );
        assert_eq!(
            select_visible_caption_sentence("それはとても良い天気だと思いますね今日は", &defer),
            "それはとても良い天気だと思いますね今日は"
        );
    }

    #[test]
    fn pages_past_explicit_punctuation_and_honors_vibrato_ipadic_sentence_ends() {
        let defer = CaptionSentenceHints {
            defer_sentence_paging: Some(true),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(select_visible_caption_sentence("今日は晴れです。明日は雨", &defer), "明日は雨");
        assert_eq!(
            select_visible_caption_sentence(
                "It is sunny today. It will rain tomorrow.",
                &CaptionSentenceHints {
                    key: Some(CaptionSentenceKey::Translation),
                    defer_sentence_paging: Some(true),
                    ..CaptionSentenceHints::default()
                }
            ),
            "It will rain tomorrow."
        );
        assert_eq!(
            select_visible_caption_sentence(
                "短いです続く文",
                &CaptionSentenceHints {
                    defer_sentence_paging: Some(true),
                    sentence_end_offsets: Some(vec![4]),
                    ..CaptionSentenceHints::default()
                }
            ),
            "短いです続く文"
        );
    }

    #[test]
    fn discards_breaks_before_a_retained_suffix_and_rebases_retained_breaks() {
        assert_eq!(
            rebase_caption_soft_break_offsets(&"あ".repeat(60), &"あ".repeat(20), &[8]),
            Vec::<usize>::new()
        );
        assert_eq!(
            rebase_caption_soft_break_offsets(&"あ".repeat(60), &"あ".repeat(20), &[8, 48, 60]),
            vec![8, 20]
        );
    }

    #[test]
    fn fails_closed_when_the_display_text_is_not_a_suffix() {
        assert_eq!(
            rebase_caption_soft_break_offsets("前半と後半", "別の表示", &[3]),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn marks_particle_plus_content_as_a_soft_break_only_after_a_long_enough_prefix() {
        assert_eq!(
            detect_caption_soft_breaks("今日は", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert!(!detect_caption_soft_breaks("今日は晴れ", &CaptionSentenceHints::default())
            .contains(&3));
        assert!(detect_caption_soft_breaks(
            "本日の会議の議題は予算です",
            &CaptionSentenceHints::default()
        )
        .iter()
        .any(|offset| *offset >= 8));
    }

    #[test]
    fn does_not_soft_break_inside_desu_deshita_deshou() {
        assert!(!detect_caption_soft_breaks(
            "これはプレビュー用の字幕です。",
            &CaptionSentenceHints::default()
        )
        .contains(&13));
        assert!(!detect_caption_soft_breaks("今日は晴れです", &CaptionSentenceHints::default())
            .contains(&6));
        assert!(!detect_caption_soft_breaks("準備でした", &CaptionSentenceHints::default())
            .contains(&2));
    }

    #[test]
    fn does_not_soft_break_a_short_prefix_away_from_its_same_turn_continuation() {
        assert!(!detect_caption_soft_breaks(
            "こんにちはきこえますか",
            &CaptionSentenceHints::default()
        )
        .contains(&3));
        assert!(!detect_caption_soft_breaks(
            "こんにちはきこえますか",
            &CaptionSentenceHints::default()
        )
        .contains(&5));
        assert!(!detect_caption_soft_breaks(
            "こんにちはーきこえますか",
            &CaptionSentenceHints::default()
        )
        .contains(&5));
        assert_eq!(
            detect_caption_soft_breaks(
                "準備です続き",
                &CaptionSentenceHints {
                    soft_break_offsets: Some(vec![3, 5]),
                    ..CaptionSentenceHints::default()
                }
            ),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn prefers_supplied_vibrato_soft_break_offsets_after_a_long_enough_prefix() {
        assert_eq!(
            detect_caption_soft_breaks(
                "本日の会議の議題は予算です",
                &CaptionSentenceHints {
                    soft_break_offsets: Some(vec![8, 12]),
                    ..CaptionSentenceHints::default()
                }
            ),
            vec![8, 12]
        );
    }

    #[test]
    fn covers_blank_input_whitespace_only_prefixes_and_punctuation_soft_breaks() {
        assert_eq!(
            detect_caption_soft_breaks("", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert_eq!(
            detect_caption_soft_breaks("  ", &CaptionSentenceHints::default()),
            Vec::<usize>::new()
        );
        assert!(
            detect_caption_soft_breaks("晴れ。次", &CaptionSentenceHints::default()).contains(&3)
        );
        assert!(
            detect_caption_soft_breaks("今日、明日", &CaptionSentenceHints::default()).contains(&3)
        );
        assert!(
            detect_caption_soft_breaks("晴れ，次", &CaptionSentenceHints::default()).contains(&3)
        );
        assert!(
            detect_caption_soft_breaks("ok, next", &CaptionSentenceHints::default()).contains(&3)
        );
    }

    #[test]
    fn never_pages_a_copula_split_unless_the_next_span_is_at_least_twice_the_lead() {
        assert_eq!(
            select_visible_caption_sentence("確認です次の議題", &CaptionSentenceHints::default()),
            "確認です次の議題"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "本日は説明しますこれから詳細を共有します",
                &CaptionSentenceHints::default()
            ),
            "本日は説明しますこれから詳細を共有します"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "準備を進めていますこれから詳細を共有します",
                &CaptionSentenceHints::default()
            ),
            "準備を進めていますこれから詳細を共有します"
        );
    }

    #[test]
    fn does_not_page_polite_masu_stems_even_when_the_next_span_is_twice_the_lead() {
        assert_eq!(
            select_visible_caption_sentence(
                "していますこれから午後の予定と明日の議題についての確認",
                &CaptionSentenceHints::default()
            ),
            "していますこれから午後の予定と明日の議題についての確認"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "できますこれから午後の予定と明日の議題についての確認",
                &hints_ends(&[4])
            ),
            "できますこれから午後の予定と明日の議題についての確認"
        );
        assert_eq!(
            select_visible_caption_sentence(
                "準備を進めています。次",
                &CaptionSentenceHints::default()
            ),
            "次"
        );
    }

    #[test]
    fn pages_after_a_copula_only_when_the_next_span_is_at_least_twice_the_lead() {
        assert_eq!(
            select_visible_caption_sentence(
                "終わりですこれから午後の予定と明日の議題を確認します",
                &CaptionSentenceHints::default()
            ),
            "これから午後の予定と明日の議題を確認します"
        );
    }

    #[test]
    fn still_pages_on_punctuation_even_when_the_next_span_is_shorter() {
        assert_eq!(
            select_visible_caption_sentence("終わりです。次", &CaptionSentenceHints::default()),
            "次"
        );
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです。雨", &CaptionSentenceHints::default()),
            "雨"
        );
    }

    #[test]
    fn does_not_honor_a_1_scalar_pipeline_offset_that_would_hide_a_longer_lead() {
        assert_eq!(select_visible_caption_sentence("今日はとて", &hints_ends(&[4])), "今日はとて");
        assert_eq!(
            select_visible_caption_sentence("行きましたよ次", &hints_ends(&[6])),
            "行きましたよ次"
        );
    }

    #[test]
    fn sticky_carries_the_prior_boundary_when_a_longer_prefix_loses_its_fresh_end() {
        let hints = CaptionSentenceHints {
            previous_text: Some("今日は晴れです".to_string()),
            previous_ends: Some(vec![7]),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(detect_caption_sentence_ends("今日は晴れです明日は雨", &hints), vec![7]);
        assert_eq!(select_visible_caption_sentence("今日は晴れです明日は雨", &hints), "明日は雨");
    }

    #[test]
    fn sticky_unions_the_prior_copula_boundary_with_a_fresh_terminal_boundary() {
        let hints = CaptionSentenceHints {
            previous_text: Some("今日は晴れです".to_string()),
            previous_ends: Some(vec![7]),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(
            detect_caption_sentence_ends("今日は晴れです明日も晴れる予報です", &hints),
            vec![7, 17]
        );
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです明日も晴れる予報です", &hints),
            "明日も晴れる予報です"
        );
    }

    #[test]
    fn sticky_keeps_both_carried_and_fresh_punctuation_boundaries() {
        let hints = CaptionSentenceHints {
            previous_text: Some("今日は晴れです".to_string()),
            previous_ends: Some(vec![7]),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(detect_caption_sentence_ends("今日は晴れです明日は雨。", &hints), vec![7, 12]);
        assert_eq!(
            select_visible_caption_sentence("今日は晴れです明日は雨。", &hints),
            "明日は雨。"
        );
    }

    #[test]
    fn sticky_does_not_carry_a_boundary_across_a_non_prefix_hypothesis() {
        let hints = CaptionSentenceHints {
            previous_text: Some("今日は晴れです".to_string()),
            previous_ends: Some(vec![7]),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(detect_caption_sentence_ends("明日は雨です", &hints), vec![6]);
        assert_eq!(select_visible_caption_sentence("明日は雨です", &hints), "明日は雨です");
    }

    #[test]
    fn sticky_keeps_carried_offsets_in_unicode_scalar_units() {
        let hints = CaptionSentenceHints {
            previous_text: Some("😀です".to_string()),
            previous_ends: Some(vec![3]),
            ..CaptionSentenceHints::default()
        };
        assert_eq!(detect_caption_sentence_ends("😀です次", &hints), vec![3]);
        assert_eq!(select_visible_caption_sentence("😀です次", &hints), "次");
    }
}
