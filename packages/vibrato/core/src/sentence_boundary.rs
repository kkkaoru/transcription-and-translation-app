//! Sentence-end detection for live caption paging.
//!
//! Tauri desktop is the source of truth. Overlay TypeScript keeps a heuristic
//! fallback; WASM/Worker should call this module through vibrato-wasm.

use caption_bridge_japanese_text::{comma_separated_feature_field, MorphFeature};

const SENTENCE_PUNCT: &[char] = &['。', '．', '！', '？', '!', '?'];

fn strip_sentence_punct(text: &str) -> &str {
    text.trim_end()
        .trim_end_matches(|character: char| SENTENCE_PUNCT.contains(&character))
        .trim_end()
}

fn ends_with_any(text: &str, suffixes: &[&str]) -> bool {
    suffixes.iter().any(|suffix| text.ends_with(suffix))
}

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
    "ます",
];
const FINAL_PARTICLES: &[&str] = &["よ", "ね", "な", "わ", "ぞ", "さ", "か"];

fn copula_with_particle(base: &str, copula: &str) -> bool {
    FINAL_PARTICLES.iter().any(|particle| base.ends_with(&format!("{copula}{particle}")))
}

fn japanese_copula_end(text: &str) -> bool {
    let base = strip_sentence_punct(text);
    COPULAS.iter().any(|copula| base.ends_with(copula) || copula_with_particle(base, copula))
}

fn japanese_past_with_particle(text: &str) -> bool {
    let base = strip_sentence_punct(text);
    ends_with_any(base, &["だよ", "だね", "だな", "だわ", "だぞ", "ださ", "だか"])
        || ends_with_any(base, &["たよ", "たね", "たな", "たわ", "たぞ", "たさ", "たか"])
        || ends_with_any(
            base,
            &["ないよ", "ないね", "ないな", "ないわ", "ないぞ", "ないさ", "ないか"],
        )
}

fn is_japanese_sentence_end(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().last().is_some_and(|character| SENTENCE_PUNCT.contains(&character)) {
        return true;
    }
    japanese_copula_end(trimmed) || japanese_past_with_particle(trimmed)
}

fn is_english_sentence_end(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    let Some(last) = trimmed.chars().last() else {
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

fn is_combining_mark(character: char) -> bool {
    matches!(
        character,
        '\u{0300}'..='\u{036F}' | '\u{3099}' | '\u{309A}' | '\u{FE20}'..='\u{FE2F}'
    )
}

fn is_tara_connective_remainder(prefix: &str, remainder: &str) -> bool {
    let next = remainder.trim_start();
    if !next.starts_with('ら') {
        return false;
    }
    let base = strip_sentence_punct(prefix);
    base.ends_with('か') || base.ends_with('た') || base.ends_with("です")
}

fn starts_strong_utterance_lexeme(next: &str) -> bool {
    const HEADS: &[&str] = &[
        "今日",
        "明日",
        "昨日",
        "あした",
        "あす",
        "きょう",
        "きのう",
        "いま",
        "今",
        "あとで",
        "あと",
        "今度",
        "次回",
        "じゃあ",
        "でも",
        "そして",
        "それで",
        "だから",
    ];
    HEADS.iter().any(|head| next.starts_with(head))
}

fn japanese_copula_allows_remainder(prefix: &str, remainder: &str) -> bool {
    let next = remainder.trim_start();
    if next.is_empty() {
        return true;
    }
    if prefix.trim_end().chars().last().is_some_and(|character| SENTENCE_PUNCT.contains(&character))
    {
        return true;
    }
    starts_strong_utterance_lexeme(next)
}

fn starts_japanese_continuation(remainder: &str) -> bool {
    let next = remainder.trim_start();
    if next.is_empty() {
        return false;
    }
    if next.chars().next().is_some_and(|character| {
        SENTENCE_PUNCT.contains(&character) || is_combining_mark(character)
    }) {
        return true;
    }
    const CONTINUATIONS: &[&str] = &[
        "が",
        "を",
        "に",
        "へ",
        "で",
        "と",
        "も",
        "の",
        "や",
        "て",
        "けど",
        "けれど",
        "けれども",
        "から",
        "ので",
        "し",
        "ば",
        "たり",
        "つつ",
        "ながら",
        "よ",
        "ね",
        "な",
        "わ",
        "ぞ",
        "さ",
        "か",
        "、",
        "，",
        ",",
    ];
    CONTINUATIONS.iter().any(|token| next.starts_with(token))
}

fn starts_english_continuation(remainder: &str) -> bool {
    let next = remainder.trim_start();
    if next.is_empty() {
        return false;
    }
    if next.chars().next().is_some_and(|character| {
        SENTENCE_PUNCT.contains(&character) || is_combining_mark(character)
    }) {
        return true;
    }
    next.chars().next().is_some_and(|character| {
        character.is_ascii_lowercase() || matches!(character, ',' | ';' | ':')
    })
}

/// Exclusive Unicode-scalar offsets where a caption sentence completes.
pub fn heuristic_sentence_end_offsets(text: &str, english: bool) -> Vec<usize> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    for index in 1..=chars.len() {
        let prefix: String = chars[..index].iter().collect();
        let is_end = if english {
            is_english_sentence_end(&prefix)
        } else {
            is_japanese_sentence_end(&prefix)
        };
        if !is_end {
            continue;
        }
        let remainder: String = chars[index..].iter().collect();
        let continuation = if english {
            starts_english_continuation(&remainder)
        } else {
            starts_japanese_continuation(&remainder)
                || is_tara_connective_remainder(&prefix, &remainder)
        };
        if continuation {
            continue;
        }
        if !english && !japanese_copula_allows_remainder(&prefix, &remainder) {
            continue;
        }
        ends.push(index);
    }
    ends
}

/// Newest complete sentence, or the in-progress sentence after the last end.
pub fn visible_caption_sentence(text: &str, english: bool, offsets: Option<&[usize]>) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = normalized.chars().collect();
    let detected = offsets
        .map(|values| {
            values
                .iter()
                .copied()
                .filter(|offset| *offset > 0 && *offset <= chars.len())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| heuristic_sentence_end_offsets(normalized, english));
    if detected.is_empty() {
        return normalized.to_string();
    }
    let last_end = *detected.last().unwrap_or(&chars.len());
    if last_end >= chars.len() {
        let previous_end = if detected.len() >= 2 { detected[detected.len() - 2] } else { 0 };
        return chars[previous_end..last_end].iter().collect::<String>().trim().to_string();
    }
    let next: String = chars[last_end..].iter().collect();
    let next = next.trim();
    if next.is_empty() {
        normalized.to_string()
    } else {
        next.to_string()
    }
}

/// IPADIC feature view. Field order is 品詞,細分類1,細分類2,細分類3,活用型,活用形,...
#[derive(Clone, Copy, Debug)]
struct IpadicPos<'a> {
    surface: &'a str,
    pos1: &'a str,
    pos2: &'a str,
    cform: &'a str,
}

impl<'a> IpadicPos<'a> {
    fn parse(surface: &'a str, feature: &'a str) -> Self {
        let parsed = MorphFeature::parse(feature);
        Self { surface, pos1: parsed.pos1, pos2: parsed.pos2, cform: parsed.conjugation_form }
    }

    fn is_kuten(self) -> bool {
        self.pos1 == "記号" && self.pos2 == "句点"
            || SENTENCE_PUNCT.iter().any(|character| self.surface.contains(*character))
    }

    fn is_touten(self) -> bool {
        self.pos1 == "記号" && self.pos2 == "読点"
    }

    fn is_final_particle(self) -> bool {
        self.pos1 == "助詞" && self.pos2 == "終助詞"
    }

    fn is_conjunctive_particle(self) -> bool {
        self.pos1 == "助詞" && self.pos2 == "接続助詞"
    }

    fn is_case_or_binding_particle(self) -> bool {
        self.pos1 == "助詞" && matches!(self.pos2, "格助詞" | "係助詞" | "副助詞" | "並立助詞")
    }

    fn is_binding_particle(self) -> bool {
        self.pos1 == "助詞" && self.pos2 == "係助詞"
    }

    fn is_predicate(self) -> bool {
        matches!(self.pos1, "動詞" | "形容詞" | "助動詞")
    }

    fn is_conclusive_form(self) -> bool {
        matches!(self.cform, "基本形" | "終止形" | "命令形" | "意志推量形")
    }

    fn is_adnominal_or_continuative_form(self) -> bool {
        matches!(
            self.cform,
            "未然形" | "連用形" | "連用タ接続" | "仮定形" | "体言接続" | "連体形" | "ガル接続"
        )
    }

    fn is_nounish(self) -> bool {
        matches!(self.pos1, "名詞" | "代名詞")
    }

    fn is_proper_noun(self) -> bool {
        self.pos1 == "名詞" && self.pos2 == "固有名詞"
    }

    fn is_adverbial_noun(self) -> bool {
        self.pos1 == "名詞" && self.pos2 == "副詞可能"
    }

    fn is_filler(self) -> bool {
        if self.is_ack() {
            return false;
        }
        self.pos1 == "フィラー"
            || (self.pos1 == "感動詞"
                && matches!(self.surface, "えー" | "あの" | "あのー" | "えっと" | "うーん"))
    }

    fn is_ack(self) -> bool {
        // IPADIC tags うん/はい as フィラー or 感動詞 depending on context.
        matches!(self.surface, "はい" | "うん" | "ええ" | "いいえ")
            && matches!(self.pos1, "感動詞" | "フィラー")
    }

    fn is_conjunction(self) -> bool {
        self.pos1 == "接続詞"
    }

    fn is_rentaishi(self) -> bool {
        self.pos1 == "連体詞"
    }
}

fn is_strong_utterance_start(next: IpadicPos<'_>, next_next: Option<IpadicPos<'_>>) -> bool {
    // Relativizers (走る人 / 見たこと) look like 基本形+名詞. Only page when
    // the next span is a real new utterance: 接続詞, 連体詞, or 明日は.
    next.is_conjunction()
        || next.is_rentaishi()
        || (next.is_adverbial_noun() && next_next.is_some_and(IpadicPos::is_binding_particle))
}

fn next_absorbs_predicate_end(next: IpadicPos<'_>) -> bool {
    next.is_final_particle()
        || next.is_conjunctive_particle()
        || next.is_case_or_binding_particle()
        || next.is_kuten()
        || next.is_touten()
}

/// POS ends plus heuristic copulas that do not cut inside a dictionary token.
pub fn caption_sentence_end_offsets(tokens: &[(String, String, usize)], text: &str) -> Vec<usize> {
    let mut ends = ipadic_sentence_end_offsets(tokens, text.chars().count());
    ends.extend(
        heuristic_sentence_end_offsets(text, false)
            .into_iter()
            .filter(|offset| heuristic_offset_is_plausible(*offset, tokens)),
    );
    ends.sort_unstable();
    ends.dedup();
    ends
}

/// Soft wrap / early-page points from IPADIC POS combinations.
///
/// Unlike {@link ipadic_sentence_end_offsets}, these fire inside a still-open
/// sentence so captions can break before the hard `maxChars` budget — after
/// 読点, case/binding particles, or conjunctive て/で when content follows.
pub fn caption_soft_break_offsets(tokens: &[(String, String, usize)], text: &str) -> Vec<usize> {
    let chars: Vec<char> = text.chars().collect();
    let mut ends = ipadic_soft_break_offsets(tokens, text.chars().count());
    ends.extend(
        heuristic_soft_break_offsets(text)
            .into_iter()
            .filter(|offset| heuristic_offset_is_plausible(*offset, tokens)),
    );
    // Sentence ends are also valid soft wrap sites.
    ends.extend(caption_sentence_end_offsets(tokens, text));
    ends.retain(|offset| {
        if *offset == 0 || *offset > chars.len() {
            return false;
        }
        let prefix: String = chars[..*offset].iter().collect();
        let remainder: String = chars[*offset..].iter().collect();
        !should_ignore_soft_break_in_greeting(prefix.trim_end(), remainder.trim_start())
    });
    ends.sort_unstable();
    ends.dedup();
    ends
}

/// Heuristic soft breaks when Vibrato tokens are not yet available.
///
/// Prefer wrapping after punctuation or common particles so the TypeScript
/// overlay can page/wrap before the hard character budget without waiting on
/// IPADIC offsets from the native pipeline.
pub fn heuristic_soft_break_offsets(text: &str) -> Vec<usize> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    const PARTICLE_SUFFIXES: &[&str] = &[
        "から",
        "まで",
        "より",
        "など",
        "って",
        "では",
        "には",
        "とは",
        "のは",
        "けど",
        "けれど",
        "けれども",
        "ので",
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
        "、",
        "，",
        ",",
    ];
    let mut ends = Vec::new();
    for index in 1..=chars.len() {
        let prefix: String = chars[..index].iter().collect();
        let trimmed = prefix.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let last = trimmed.chars().last();
        if last.is_some_and(|character| SENTENCE_PUNCT.contains(&character) || character == '、') {
            ends.push(index);
            continue;
        }
        if PARTICLE_SUFFIXES.iter().any(|suffix| trimmed.ends_with(suffix)) {
            let remainder: String = chars[index..].iter().collect();
            let next = remainder.trim_start();
            // Keep an open trailing particle on the same line until more speech
            // arrives; soft-break only when content already follows.
            if !next.is_empty()
                && next.chars().next().is_some_and(|character| {
                    !SENTENCE_PUNCT.contains(&character) && !is_combining_mark(character)
                })
            {
                // Keep です/でした/でしょう intact — soft で is not a wrap point.
                if trimmed.ends_with('で')
                    && (next.starts_with("す")
                        || next.starts_with("した")
                        || next.starts_with("して")
                        || next.starts_with("しょう"))
                {
                    continue;
                }
                // 「こんにちはきこえますか」— interior に/は must not wrap so the
                // greeting stays with its continuation on one plate row.
                if should_ignore_soft_break_in_greeting(trimmed, next) {
                    continue;
                }
                ends.push(index);
            }
        }
    }
    ends.sort_unstable();
    ends.dedup();
    ends
}

const FIXED_GREETINGS: &[&str] =
    &["こんにちは", "こんばんは", "おはようございます", "おはよう", "さようなら"];

fn should_ignore_soft_break_in_greeting(prefix: &str, remainder: &str) -> bool {
    if remainder.trim_start().is_empty() {
        return false;
    }
    let trimmed = prefix.trim_end().trim_end_matches(['ー', '〜', '～']);
    FIXED_GREETINGS.iter().any(|greeting| greeting.starts_with(trimmed) || *greeting == trimmed)
}

/// Vibrato IPADIC POS combinations that are safe mid-sentence wrap points.
pub fn ipadic_soft_break_offsets(
    tokens: &[(String, String, usize)],
    text_len: usize,
) -> Vec<usize> {
    let mut ends = Vec::new();
    for (index, (surface, feature, char_end)) in tokens.iter().enumerate() {
        if *char_end == 0 || *char_end > text_len {
            continue;
        }
        let current = IpadicPos::parse(surface, feature);
        let next = tokens
            .get(index + 1)
            .map(|(next_surface, next_feature, _)| IpadicPos::parse(next_surface, next_feature));
        if ipadic_combination_soft_breaks(current, next) {
            ends.push(*char_end);
        }
    }
    ends
}

fn ipadic_combination_soft_breaks(current: IpadicPos<'_>, next: Option<IpadicPos<'_>>) -> bool {
    let Some(following) = next else {
        return false;
    };
    if following.is_filler() {
        return false;
    }
    // Relativizers must stay glued: 走る人 / 見たこと.
    if current.is_predicate() && current.is_conclusive_form() && following.is_nounish() {
        return false;
    }
    if current.is_rentaishi()
        || (current.is_predicate() && current.is_adnominal_or_continuative_form())
    {
        return false;
    }
    current.is_touten()
        || current.is_kuten()
        || (current.is_case_or_binding_particle() && soft_break_content_follows(following))
        || (current.is_conjunctive_particle() && soft_break_content_follows(following))
        || (current.is_final_particle() && soft_break_content_follows(following))
}

fn soft_break_content_follows(next: IpadicPos<'_>) -> bool {
    next.is_nounish()
        || next.is_predicate()
        || next.is_conjunction()
        || next.is_rentaishi()
        || next.is_ack()
        || next.pos1 == "副詞"
        || next.pos1 == "感動詞"
}

fn heuristic_offset_is_plausible(offset: usize, tokens: &[(String, String, usize)]) -> bool {
    if tokens.is_empty() {
        return true;
    }
    for (_surface, feature, end) in tokens {
        if offset <= *end {
            return offset == *end || ipadic_lemma_is_unknown(feature);
        }
    }
    false
}

fn ipadic_lemma_is_unknown(feature: &str) -> bool {
    comma_separated_feature_field(feature, 6).unwrap_or("*") == "*"
}

/// Vibrato IPADIC POS combinations that complete a caption sentence.
///
/// Live ASR is messy: no punctuation, fillers, noun-stop, mid-repair. The
/// classifier uses pos1/pos2/cform pairs rather than fixed surface lists so
/// 走る/寒い/だった still complete without matching です/ます.
pub fn ipadic_sentence_end_offsets(
    tokens: &[(String, String, usize)],
    text_len: usize,
) -> Vec<usize> {
    let mut ends = Vec::new();
    for (index, (surface, feature, char_end)) in tokens.iter().enumerate() {
        if *char_end == 0 || *char_end > text_len {
            continue;
        }
        let current = IpadicPos::parse(surface, feature);
        let next = tokens
            .get(index + 1)
            .map(|(next_surface, next_feature, _)| IpadicPos::parse(next_surface, next_feature));
        let next_next = tokens
            .get(index + 2)
            .map(|(next_surface, next_feature, _)| IpadicPos::parse(next_surface, next_feature));
        let terminal = next.is_none() || *char_end >= text_len;
        if ipadic_combination_completes(current, next, next_next, terminal) {
            ends.push(*char_end);
        }
    }
    ends
}

fn ipadic_combination_completes(
    current: IpadicPos<'_>,
    next: Option<IpadicPos<'_>>,
    next_next: Option<IpadicPos<'_>>,
    terminal: bool,
) -> bool {
    if keeps_sentence_open(current) {
        return false;
    }
    current.is_kuten()
        || ack_completes(current, terminal)
        || final_particle_completes(current, next, next_next, terminal)
        || conclusive_predicate_completes(current, next, next_next, terminal)
        || noun_stop_completes(current, next, next_next, terminal)
}

fn keeps_sentence_open(current: IpadicPos<'_>) -> bool {
    current.is_touten()
        || current.is_conjunctive_particle()
        || current.is_case_or_binding_particle()
        || current.is_filler()
        || (current.is_predicate() && current.is_adnominal_or_continuative_form())
}

fn ack_completes(current: IpadicPos<'_>, terminal: bool) -> bool {
    current.is_ack() && terminal
}

fn final_particle_completes(
    current: IpadicPos<'_>,
    next: Option<IpadicPos<'_>>,
    next_next: Option<IpadicPos<'_>>,
    terminal: bool,
) -> bool {
    if !current.is_final_particle() {
        return false;
    }
    if next.is_some_and(|token| {
        token.is_final_particle() || token.is_kuten() || token.is_conjunctive_particle()
    }) {
        return false;
    }
    terminal || next.is_some_and(|token| is_strong_utterance_start(token, next_next))
}

fn conclusive_predicate_completes(
    current: IpadicPos<'_>,
    next: Option<IpadicPos<'_>>,
    next_next: Option<IpadicPos<'_>>,
    terminal: bool,
) -> bool {
    current.is_predicate()
        && current.is_conclusive_form()
        && !next.is_some_and(next_absorbs_predicate_end)
        && (terminal || next.is_some_and(|token| is_strong_utterance_start(token, next_next)))
}

fn noun_stop_completes(
    current: IpadicPos<'_>,
    next: Option<IpadicPos<'_>>,
    next_next: Option<IpadicPos<'_>>,
    terminal: bool,
) -> bool {
    if !current.is_nounish() {
        return false;
    }
    terminal || adverbial_topic_restart(current, next, next_next)
}

fn adverbial_topic_restart(
    current: IpadicPos<'_>,
    next: Option<IpadicPos<'_>>,
    next_next: Option<IpadicPos<'_>>,
) -> bool {
    // 晴れ + 明日は. Skip 固有名詞+一般 (東京+駅).
    !current.is_proper_noun()
        && next.is_some_and(IpadicPos::is_adverbial_noun)
        && next_next.is_some_and(IpadicPos::is_binding_particle)
}

#[cfg(test)]
mod tests {
    use super::{
        heuristic_sentence_end_offsets, heuristic_soft_break_offsets, ipadic_sentence_end_offsets,
        ipadic_soft_break_offsets, visible_caption_sentence,
    };

    fn tokens(pairs: &[(&str, &str)]) -> (String, Vec<(String, String, usize)>) {
        let mut text = String::new();
        let mut out = Vec::new();
        for (surface, feature) in pairs {
            text.push_str(surface);
            out.push(((*surface).to_string(), (*feature).to_string(), text.chars().count()));
        }
        (text, out)
    }

    const NOUN: &str = "名詞,一般,*,*,*,*,*,*,*";
    const ADVERBIAL_NOUN: &str = "名詞,副詞可能,*,*,*,*,*,*,*";
    const PROPER: &str = "名詞,固有名詞,地域,一般,*,*,*,*,*";
    const BINDING: &str = "助詞,係助詞,*,*,*,*,は,ハ,ワ";
    const CASE: &str = "助詞,格助詞,一般,*,*,*,を,ヲ,ヲ";
    const FINAL_PARTICLE: &str = "助詞,終助詞,*,*,*,*,よ,ヨ,ヨ";
    const CONJ_PARTICLE: &str = "助詞,接続助詞,*,*,*,*,て,テ,テ";
    const DESU: &str = "助動詞,*,*,*,特殊・デス,基本形,です,デス,デス";
    const TA: &str = "助動詞,*,*,*,特殊・タ,基本形,た,タ,タ";
    const MASU_RENYOU: &str = "助動詞,*,*,*,特殊・マス,連用形,ます,マシ,マシ";
    const DA_CONJ: &str = "助動詞,*,*,*,特殊・ダ,基本形,だ,ダ,ダ";
    const VERB_BASE: &str = "動詞,自立,*,*,五段・ラ行,基本形,走る,ハシル,ハシル";
    const VERB_RENYOU: &str = "動詞,自立,*,*,一段,連用形,食べる,タベ,タベ";
    const ADJ_BASE: &str = "形容詞,自立,*,*,形容詞・アウオ段,基本形,寒い,サムイ,サムイ";
    const KUTEN: &str = "記号,句点,*,*,*,*,。,。,。";
    const TOUTEN: &str = "記号,読点,*,*,*,*,、,、,、";
    const FILLER: &str = "フィラー,*,*,*,*,*,えー,エー,エー";
    const ACK: &str = "感動詞,*,*,*,*,*,うん,ウン,ウン";
    const ADVERB: &str = "副詞,一般,*,*,*,*,よく,ヨク,ヨク";

    #[test]
    fn copula_and_punctuation_complete_japanese_sentences() {
        assert_eq!(heuristic_sentence_end_offsets("今日は晴れです", false), vec![7]);
        assert_eq!(heuristic_sentence_end_offsets("今日は晴れです。", false), vec![8]);
        assert_eq!(heuristic_sentence_end_offsets("行きましたよ", false), vec![6]);
    }

    #[test]
    fn past_auxiliary_before_kara_is_not_a_sentence_end() {
        // Splitting してた | だから would duplicate だ when the two pages are
        // concatenated. The exclusive end after してた must stay glued to から.
        let train = "でんしゃがちえんしてたからぼくはがっこうにいかない";
        let weather = "あついひはあついたべものをたべたくない";
        assert!(
            heuristic_sentence_end_offsets(train, false).is_empty(),
            "してたから must not page before から: {:?}",
            heuristic_sentence_end_offsets(train, false)
        );
        assert_eq!(visible_caption_sentence(train, false, None), train);
        assert!(
            heuristic_sentence_end_offsets(weather, false).is_empty(),
            "は+あつい must not page between the particle and the next word: {:?}",
            heuristic_sentence_end_offsets(weather, false)
        );
        assert_eq!(visible_caption_sentence(weather, false, None), weather);
    }

    #[test]
    fn continuations_are_not_sentence_ends() {
        assert!(heuristic_sentence_end_offsets("晴れですが寒い", false).is_empty());
        assert!(heuristic_sentence_end_offsets("明日また", false).is_empty());
        assert!(heuristic_sentence_end_offsets("だったら行く", false).is_empty());
        assert!(heuristic_sentence_end_offsets("ですからね", false).is_empty());
        assert!(heuristic_sentence_end_offsets("ですら知らない", false).is_empty());
        assert_eq!(
            visible_caption_sentence("ましたら連絡します", false, None),
            "ましたら連絡します"
        );
        assert_eq!(visible_caption_sentence("行きましたよ次", false, None), "行きましたよ次");
    }

    #[test]
    fn ipadic_pos_ends_sentences_without_desu_masu_surface() {
        assert!(heuristic_sentence_end_offsets("今日は寒い明日は", false).is_empty());

        let (adj_text, adj_tokens) = tokens(&[
            ("今日", ADVERBIAL_NOUN),
            ("は", BINDING),
            ("寒い", ADJ_BASE),
            ("明日", ADVERBIAL_NOUN),
            ("は", BINDING),
        ]);
        let adj_offsets = ipadic_sentence_end_offsets(&adj_tokens, adj_text.chars().count());
        assert!(
            adj_offsets.contains(&5),
            "形容詞基本形 + 明日は should complete: offsets={adj_offsets:?}"
        );
        assert_eq!(
            visible_caption_sentence(&adj_text, false, Some(adj_offsets.as_slice())),
            "明日は"
        );
    }

    #[test]
    fn visible_sentence_switches_after_a_completed_ending() {
        assert_eq!(visible_caption_sentence("今日は晴れです明日は雨", false, None), "明日は雨");
        assert_eq!(
            visible_caption_sentence("今日は晴れです。明日は雨です。", false, None),
            "明日は雨です。"
        );
        assert_eq!(
            visible_caption_sentence("It is sunny today. It will rain tomorrow.", true, None),
            "It will rain tomorrow."
        );
    }

    type VisibleCase = (&'static str, &'static [(&'static str, &'static str)], &'static str);

    #[test]
    fn ipadic_pos_combinations_complete_without_fixed_copula_strings() {
        let cases: &[VisibleCase] = &[
            (
                "助動詞基本形 + 名詞 starts the next caption",
                &[
                    ("今日", ADVERBIAL_NOUN),
                    ("は", BINDING),
                    ("晴れ", NOUN),
                    ("です", DESU),
                    ("明日", ADVERBIAL_NOUN),
                    ("は", BINDING),
                    ("雨", NOUN),
                ],
                "明日は雨",
            ),
            (
                "形容詞基本形 + 明日は is a topic restart",
                &[
                    ("今日", ADVERBIAL_NOUN),
                    ("は", BINDING),
                    ("寒い", ADJ_BASE),
                    ("明日", ADVERBIAL_NOUN),
                    ("は", BINDING),
                ],
                "明日は",
            ),
            (
                "終助詞のあと今日はへ切り替える",
                &[
                    ("行き", "動詞,自立,*,*,五段・カ行促音便,連用形,行く,イキ,イキ"),
                    ("まし", MASU_RENYOU),
                    ("た", TA),
                    ("よ", FINAL_PARTICLE),
                    ("今日", ADVERBIAL_NOUN),
                    ("は", BINDING),
                ],
                "今日は",
            ),
            (
                "句点 pages even when ASR glued the next utterance",
                &[
                    ("終わり", NOUN),
                    ("。", KUTEN),
                    ("次", NOUN),
                    ("の", "助詞,連体化,*,*,*,*,の,ノ,ノ"),
                    ("話", NOUN),
                ],
                "次の話",
            ),
            (
                "terminal 名詞止め is a complete live utterance",
                &[("明日", ADVERBIAL_NOUN), ("は", BINDING), ("雨", NOUN)],
                "明日は雨",
            ),
            ("うんだけなら応答として完結する", &[("うん", ACK)], "うん"),
        ];

        for (label, pairs, expected_visible) in cases {
            let (text, toks) = tokens(pairs);
            let offsets = ipadic_sentence_end_offsets(&toks, text.chars().count());
            let visible = visible_caption_sentence(&text, false, Some(offsets.as_slice()));
            assert_eq!(visible, *expected_visible, "{label}: text={text:?} offsets={offsets:?}");
        }
    }

    type OpenCase = (&'static str, &'static [(&'static str, &'static str)]);

    #[test]
    fn ipadic_pos_combinations_do_not_split_incomplete_or_continuing_speech() {
        let cases: &[OpenCase] = &[
            (
                "格助詞で途切れた発話は未完",
                &[
                    ("隣", NOUN),
                    ("の", "助詞,連体化,*,*,*,*,の,ノ,ノ"),
                    ("客", NOUN),
                    ("は", BINDING),
                ],
            ),
            ("連用形 + 接続助詞て は未完", &[("食べ", VERB_RENYOU), ("て", CONJ_PARTICLE)]),
            (
                "ですが は接続助詞なので切らない",
                &[
                    ("晴れ", NOUN),
                    ("だ", DA_CONJ),
                    ("が", "助詞,接続助詞,*,*,*,*,が,ガ,ガ"),
                    ("寒い", ADJ_BASE),
                ],
            ),
            (
                "読点のあとにはまだ続く",
                &[("今日", ADVERBIAL_NOUN), ("は", BINDING), ("、", TOUTEN), ("雨", NOUN)],
            ),
            (
                "フィラーだけでは切らない",
                &[("えー", FILLER), ("今日", ADVERBIAL_NOUN), ("は", BINDING)],
            ),
            (
                "固有名詞+一般名詞の複合は切らない",
                &[("東京", PROPER), ("駅", NOUN), ("は", BINDING), ("混む", VERB_BASE)],
            ),
            ("目的格の途中切れ", &[("水", NOUN), ("を", CASE)]),
        ];

        for (label, pairs) in cases {
            let (text, toks) = tokens(pairs);
            let offsets = ipadic_sentence_end_offsets(&toks, text.chars().count());
            let visible = visible_caption_sentence(&text, false, Some(offsets.as_slice()));
            assert_eq!(visible, text, "{label}: text={text:?} offsets={offsets:?}");
        }
    }

    #[test]
    fn soft_breaks_prefer_particle_and_touten_before_max_chars() {
        assert!(
            heuristic_soft_break_offsets("今日は晴れです").contains(&3),
            "係助詞 は should soft-break before the following content"
        );
        assert!(heuristic_soft_break_offsets("今日は").is_empty());
        assert!(
            heuristic_soft_break_offsets("こんにちはきこえますか").is_empty(),
            "greeting interior に/は must not soft-wrap away the continuation"
        );
        assert!(heuristic_soft_break_offsets("こんにちはーきこえますか").is_empty());

        let (text, toks) = tokens(&[
            ("今日", ADVERBIAL_NOUN),
            ("は", BINDING),
            ("、", TOUTEN),
            ("雨", NOUN),
            ("が", CASE),
            ("降る", VERB_BASE),
        ]);
        let soft = ipadic_soft_break_offsets(&toks, text.chars().count());
        assert!(soft.contains(&4), "読点 soft break missing: {soft:?}");
        assert!(soft.contains(&6), "格助詞 soft break missing: {soft:?}");
        assert!(
            !soft.contains(&text.chars().count()),
            "terminal token must not soft-break alone: {soft:?}"
        );
    }

    #[test]
    fn soft_breaks_do_not_split_relativizers() {
        let (text, toks) = tokens(&[("走る", VERB_BASE), ("人", NOUN), ("だ", DA_CONJ)]);
        let soft = ipadic_soft_break_offsets(&toks, text.chars().count());
        assert!(!soft.contains(&2), "走る人 must stay glued: text={text:?} soft={soft:?}");
    }

    #[test]
    fn ipadic_pos_combinations_do_not_make_awkward_splits() {
        let cases: &[OpenCase] = &[
            ("連体修飾 走る人 は切らない", &[("走る", VERB_BASE), ("人", NOUN), ("だ", DA_CONJ)]),
            (
                "見た人は は連体修飾なので切らない",
                &[("見", VERB_RENYOU), ("た", TA), ("人", NOUN), ("は", BINDING)],
            ),
            (
                "行ったこと は形式名詞なので切らない",
                &[
                    ("行っ", "動詞,自立,*,*,五段・カ行促音便,連用タ接続,行く,イッ,イッ"),
                    ("た", TA),
                    ("こと", "名詞,非自立,一般,*,*,*,こと,コト,コト"),
                ],
            ),
            (
                "思うんだけど は切らない",
                &[
                    ("思う", VERB_BASE),
                    ("ん", "名詞,非自立,一般,*,*,*,ん,ン,ン"),
                    ("だ", DA_CONJ),
                    ("けど", "助詞,接続助詞,*,*,*,*,けど,ケド,ケド"),
                ],
            ),
            (
                "動詞基本形 + 次 だけでは切らない",
                &[("もう", ADVERB), ("走る", VERB_BASE), ("次", NOUN), ("いく", VERB_BASE)],
            ),
            (
                "うん今日行く は同一発話のまま",
                &[("うん", ACK), ("今日", ADVERBIAL_NOUN), ("行く", VERB_BASE)],
            ),
            (
                "よ次 だけでは切らない",
                &[
                    ("行き", "動詞,自立,*,*,五段・カ行促音便,連用形,行く,イキ,イキ"),
                    ("まし", MASU_RENYOU),
                    ("た", TA),
                    ("よ", FINAL_PARTICLE),
                    ("次", NOUN),
                ],
            ),
            (
                "学生です田中さん は切らない",
                &[
                    ("学生", NOUN),
                    ("です", DESU),
                    ("田中", PROPER),
                    ("さん", "名詞,接尾,人名,*,*,*,さん,サン,サン"),
                ],
            ),
        ];

        for (label, pairs) in cases {
            let (text, toks) = tokens(pairs);
            let offsets = ipadic_sentence_end_offsets(&toks, text.chars().count());
            let visible = visible_caption_sentence(&text, false, Some(offsets.as_slice()));
            assert_eq!(visible, text, "{label}: text={text:?} offsets={offsets:?}");
        }
    }
}
