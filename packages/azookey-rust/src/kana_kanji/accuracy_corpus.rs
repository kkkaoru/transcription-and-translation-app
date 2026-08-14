//! Conversion accuracy corpus for measuring AzooKey kana-kanji conversion
//! quality against realistic Japanese live-caption utterances.
//!
//! Each case pairs an ASR-style hiragana reading with the expected natural
//! surface.  The harness converts the input through the public AzooKey
//! dictionary and compares the top candidate against the expected surface.
//! It prints a per-category breakdown and an explicit failure list so
//! remaining weak spots stay visible instead of being hidden behind a single
//! pass-rate number.
//!
//! CI visibility: `bun run rust:azookey:test` runs this module through
//! `cargo test` with `AZOOKEY_DICTIONARY_ROOT` pointing at the pinned
//! submodule dictionary.

use crate::{convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths};
use std::collections::BTreeMap;

struct AnchorFixture {
    category: &'static str,
    input: &'static str,
    expected: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextMode {
    None,
    LeftOnly,
    RightAvailableOffline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedOrigin {
    UnspecifiedLegacy,
    Dictionary,
    KnownIdentity,
    NumericSynthesized,
    OovIdentity,
    Boundary,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewStatus {
    AnchorLocked,
    PendingIndependentReview,
    IndependentlyReviewed,
}

struct CorpusCase {
    case_id: String,
    category: &'static str,
    input: &'static str,
    expected: &'static str,
    context_mode: ContextMode,
    expected_origin: ExpectedOrigin,
    requires_dictionary_origin: bool,
    source_kind: &'static str,
    provenance: &'static str,
    pair_id: Option<&'static str>,
    accepted_variants: &'static [&'static str],
    equivalence_group: Option<&'static str>,
    review_status: ReviewStatus,
    reviewed_by: Option<&'static str>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct AccuracyCount {
    strict_passed: usize,
    variant_passed: usize,
    total: usize,
}

/// The locked dictionary-only anchor gate. Extended cases stay report-only
/// until a separately reviewed phase-one baseline is committed. Changing an
/// anchor expectation or the fingerprint requires independent Japanese-quality
/// review; updating the hash only to make this test green is prohibited.
const ANCHOR_EXPECTED_TOTAL: usize = 119;
const ANCHOR_MINIMUM_STRICT_PASSED: usize = ANCHOR_EXPECTED_TOTAL;
const FNV1A_64_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV1A_64_PRIME: u64 = 0x100000001b3;
const ANCHOR_FINGERPRINT: u64 = 0xfbf0115acd1b873a;
const ANCHOR_CATEGORY_BASELINES: &[(&str, usize)] = &[
    ("compound_particles", 6),
    ("dates_times", 6),
    ("fillers_interjections", 6),
    ("full_sentences", 34),
    ("honorifics", 6),
    ("loanword_particle", 11),
    ("numbers_counters", 11),
    ("particle_tails", 12),
    ("proper_nouns", 7),
    ("sentence_final", 6),
    ("single_mora_kanji", 2),
    ("verbs_inflections", 12),
];

const CONTEXT_MODE_SCHEMA: &[ContextMode] =
    &[ContextMode::None, ContextMode::LeftOnly, ContextMode::RightAvailableOffline];
const EXPECTED_ORIGIN_SCHEMA: &[ExpectedOrigin] = &[
    ExpectedOrigin::UnspecifiedLegacy,
    ExpectedOrigin::Dictionary,
    ExpectedOrigin::KnownIdentity,
    ExpectedOrigin::NumericSynthesized,
    ExpectedOrigin::OovIdentity,
    ExpectedOrigin::Boundary,
    ExpectedOrigin::Mixed,
];
const REVIEW_STATUS_SCHEMA: &[ReviewStatus] = &[
    ReviewStatus::AnchorLocked,
    ReviewStatus::PendingIndependentReview,
    ReviewStatus::IndependentlyReviewed,
];

const ANCHOR_FIXTURES: &[AnchorFixture] = &[
    // -----------------------------------------------------------------------
    // Particle tails — a particle attached to a converted content word.
    // -----------------------------------------------------------------------
    AnchorFixture { category: "particle_tails", input: "きょうは", expected: "今日は" },
    AnchorFixture { category: "particle_tails", input: "わたしが", expected: "私が" },
    AnchorFixture { category: "particle_tails", input: "ほんを", expected: "本を" },
    AnchorFixture { category: "particle_tails", input: "えきに", expected: "駅に" },
    AnchorFixture { category: "particle_tails", input: "カフェで", expected: "カフェで" },
    AnchorFixture { category: "particle_tails", input: "ともだちと", expected: "友達と" },
    AnchorFixture {
        category: "particle_tails", input: "きょうから", expected: "今日から"
    },
    AnchorFixture {
        category: "particle_tails", input: "やまださんより", expected: "山田さんより"
    },
    AnchorFixture {
        category: "particle_tails", input: "としょかんへ", expected: "図書館へ"
    },
    AnchorFixture { category: "particle_tails", input: "がくせいの", expected: "学生の" },
    AnchorFixture {
        category: "particle_tails", input: "みずをのむ", expected: "水を飲む"
    },
    AnchorFixture {
        category: "particle_tails", input: "ねこがねる", expected: "猫が寝る"
    },
    // -----------------------------------------------------------------------
    // Loanword + particle — katakana loanwords followed by a particle.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "loanword_particle", input: "すーぷが", expected: "スープが"
    },
    AnchorFixture {
        category: "loanword_particle", input: "すーぷは", expected: "スープは"
    },
    AnchorFixture {
        category: "loanword_particle", input: "でーたを", expected: "データを"
    },
    AnchorFixture {
        category: "loanword_particle", input: "こーひーは", expected: "コーヒーは"
    },
    AnchorFixture {
        category: "loanword_particle", input: "めーるで", expected: "メールで"
    },
    AnchorFixture {
        category: "loanword_particle",
        input: "すーぷはのみたい",
        expected: "スープは飲みたい",
    },
    AnchorFixture {
        category: "loanword_particle",
        input: "すーぷはたべたくない",
        expected: "スープは食べたくない",
    },
    AnchorFixture {
        category: "loanword_particle",
        input: "すーぷはください",
        expected: "スープはください",
    },
    AnchorFixture {
        category: "loanword_particle", input: "ぱそこんが", expected: "パソコンが"
    },
    AnchorFixture {
        category: "loanword_particle", input: "かめらで", expected: "カメラで"
    },
    AnchorFixture {
        category: "loanword_particle", input: "ほてるに", expected: "ホテルに"
    },
    // -----------------------------------------------------------------------
    // Fillers / interjections — hesitation sounds that must stay hiragana.
    //
    // These share the prolonged sound mark `ー` with loanwords above, but
    // their dictionary identity rows carry a non-default CID.  Converting the
    // leading mora (`絵ーっと`) or emitting a katakana fragment (`エーッと`)
    // is spurious, so the katakana-preferring guard must not reach them.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "fillers_interjections", input: "えーっと", expected: "えーっと"
    },
    AnchorFixture { category: "fillers_interjections", input: "えーと", expected: "えーと" },
    AnchorFixture { category: "fillers_interjections", input: "あのー", expected: "あのー" },
    AnchorFixture { category: "fillers_interjections", input: "そのー", expected: "そのー" },
    AnchorFixture { category: "fillers_interjections", input: "うーん", expected: "うーん" },
    // Loanword counterpart: the same prolonged mark must still convert, so an
    // over-broad relaxation of the guard fails here instead of passing quietly.
    AnchorFixture { category: "fillers_interjections", input: "すーぷ", expected: "スープ" },
    // -----------------------------------------------------------------------
    // Single-mora lexical conversions — one-character readings that do have a
    // legitimate kanji spelling, guarding against the filler fix suppressing
    // genuine short conversions.
    //
    // `ひ` is deliberately not pinned here: its homophones (`火`/`日`/`非`)
    // are all frequent and context-free ranking currently yields `非`, so an
    // expectation either way would encode ranking noise rather than a
    // requirement.
    // -----------------------------------------------------------------------
    AnchorFixture { category: "single_mora_kanji", input: "き", expected: "木" },
    AnchorFixture { category: "single_mora_kanji", input: "て", expected: "手" },
    // -----------------------------------------------------------------------
    // Numbers / counters — spoken numerals followed by counters.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "numbers_counters", input: "いち、に、さん", expected: "1、2、3"
    },
    AnchorFixture { category: "numbers_counters", input: "ごねん", expected: "5年" },
    AnchorFixture { category: "numbers_counters", input: "しがつ", expected: "4月" },
    AnchorFixture { category: "numbers_counters", input: "じゅう、", expected: "10、" },
    AnchorFixture { category: "numbers_counters", input: "さんにん", expected: "3人" },
    AnchorFixture { category: "numbers_counters", input: "いちにち", expected: "1日" },
    AnchorFixture { category: "numbers_counters", input: "ごふん", expected: "5分" },
    AnchorFixture { category: "numbers_counters", input: "さんじ", expected: "3時" },
    AnchorFixture { category: "numbers_counters", input: "よっか", expected: "4日" },
    AnchorFixture {
        category: "numbers_counters", input: "さんびゃくえん", expected: "300円"
    },
    AnchorFixture { category: "numbers_counters", input: "にせんえん", expected: "2000円" },
    // -----------------------------------------------------------------------
    // Dates / times — full date and time expressions.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "dates_times", input: "さんがつついたち", expected: "3月1日"
    },
    AnchorFixture { category: "dates_times", input: "しちじはん", expected: "7時半" },
    AnchorFixture { category: "dates_times", input: "じゅうじ", expected: "10時" },
    AnchorFixture { category: "dates_times", input: "ごじはん", expected: "5時半" },
    AnchorFixture { category: "dates_times", input: "しちがつ", expected: "7月" },
    AnchorFixture { category: "dates_times", input: "じゅうがつ", expected: "10月" },
    // -----------------------------------------------------------------------
    // Common verbs and their inflections.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "verbs_inflections", input: "いきます", expected: "行きます"
    },
    AnchorFixture {
        category: "verbs_inflections", input: "たべたい", expected: "食べたい"
    },
    AnchorFixture { category: "verbs_inflections", input: "おもった", expected: "思った" },
    AnchorFixture { category: "verbs_inflections", input: "おこなわ", expected: "行わ" },
    AnchorFixture { category: "verbs_inflections", input: "つかった", expected: "使った" },
    AnchorFixture {
        category: "verbs_inflections", input: "みている", expected: "見ている"
    },
    AnchorFixture { category: "verbs_inflections", input: "きいて", expected: "聞いて" },
    AnchorFixture { category: "verbs_inflections", input: "かいて", expected: "書いて" },
    AnchorFixture { category: "verbs_inflections", input: "はしる", expected: "走る" },
    AnchorFixture { category: "verbs_inflections", input: "おしえて", expected: "教えて" },
    AnchorFixture {
        category: "verbs_inflections", input: "きをきって", expected: "木を切って"
    },
    AnchorFixture {
        category: "verbs_inflections",
        input: "でんわをかける",
        expected: "電話をかける",
    },
    // -----------------------------------------------------------------------
    // Honorifics / polite expressions.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "honorifics", input: "おつかれさまです", expected: "お疲れ様です"
    },
    AnchorFixture {
        category: "honorifics",
        input: "おつかれさまでした",
        expected: "お疲れ様でした",
    },
    AnchorFixture {
        category: "honorifics",
        input: "よろしくおねがいします",
        expected: "よろしくお願いします",
    },
    AnchorFixture {
        category: "honorifics", input: "いただきます", expected: "いただきます"
    },
    AnchorFixture {
        category: "honorifics", input: "ごめんなさい", expected: "ごめんなさい"
    },
    AnchorFixture {
        category: "honorifics",
        input: "ありがとうございます",
        expected: "ありがとうございます",
    },
    // -----------------------------------------------------------------------
    // Proper nouns — place names and common proper nouns.
    // -----------------------------------------------------------------------
    AnchorFixture { category: "proper_nouns", input: "とうきょう", expected: "東京" },
    AnchorFixture { category: "proper_nouns", input: "おおさか", expected: "大阪" },
    AnchorFixture { category: "proper_nouns", input: "よこはま", expected: "横浜" },
    AnchorFixture { category: "proper_nouns", input: "きょうと", expected: "京都" },
    AnchorFixture { category: "proper_nouns", input: "ほっかいどう", expected: "北海道" },
    AnchorFixture { category: "proper_nouns", input: "にほん", expected: "日本" },
    AnchorFixture {
        category: "proper_nouns", input: "とうきょうえき", expected: "東京駅"
    },
    // -----------------------------------------------------------------------
    // Compound particles — の/で/と/へ + particle combinations.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "compound_particles",
        input: "としょかんでの",
        expected: "図書館での",
    },
    AnchorFixture {
        category: "compound_particles", input: "ともだちとの", expected: "友達との"
    },
    AnchorFixture { category: "compound_particles", input: "えきへの", expected: "駅への" },
    AnchorFixture {
        category: "compound_particles", input: "がっこうでの", expected: "学校での"
    },
    AnchorFixture {
        category: "compound_particles", input: "せんせいへの", expected: "先生への"
    },
    AnchorFixture {
        category: "compound_particles", input: "かいしゃとの", expected: "会社との"
    },
    // -----------------------------------------------------------------------
    // Sentence-final forms — polite and plain endings.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "sentence_final",
        input: "たべるでしょう",
        expected: "食べるでしょう",
    },
    AnchorFixture { category: "sentence_final", input: "はれます", expected: "晴れます" },
    AnchorFixture {
        category: "sentence_final", input: "あめがふります", expected: "雨が降ります"
    },
    AnchorFixture {
        category: "sentence_final",
        input: "きょうははれです",
        expected: "今日は晴れです",
    },
    AnchorFixture {
        category: "sentence_final",
        input: "あしたははれるでしょう",
        expected: "明日は晴れるでしょう",
    },
    AnchorFixture {
        category: "sentence_final", input: "ほんをよみます", expected: "本を読みます"
    },
    // -----------------------------------------------------------------------
    // Full sentences — realistic ASR caption output.
    // -----------------------------------------------------------------------
    AnchorFixture {
        category: "full_sentences",
        input: "きょうのてんきはあつい",
        expected: "今日の天気は暑い",
    },
    AnchorFixture {
        category: "full_sentences", input: "すーぷがあつい", expected: "スープが熱い"
    },
    AnchorFixture {
        category: "full_sentences",
        input: "あついりょうりはおいしい",
        expected: "熱い料理は美味しい",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "わたしたちはがくせいです",
        expected: "私たちは学生です",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "かんじのしょりをかいぜん",
        expected: "漢字の処理を改善",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "おんりょうをちょうせい",
        expected: "音量を調整",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "しょうぼう、しょうか、ほのお",
        expected: "消防、消火、炎",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "かたち、こうし、もよう",
        expected: "形、格子、模様",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "せんそう、しんこう、しんりゃく",
        expected: "戦争、侵攻、侵略",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "かせん、かこう、かわべ",
        expected: "河川、河口、川辺",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "にゅうきん、しゅうし、かくにん",
        expected: "入金、収支、確認",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "もじ、かんじ、ぞくじ",
        expected: "文字、漢字、俗字",
    },
    AnchorFixture { category: "full_sentences", input: "かきくう", expected: "柿食う" },
    AnchorFixture {
        category: "full_sentences",
        input: "となりのきゃくはよくかきくうきゃくだ",
        expected: "隣の客は良く柿食う客だ",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "りょうりがあついのでさます",
        expected: "料理が熱いのでさます",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "きょうはとてもさむい",
        expected: "今日はとても寒い",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "すーぷはおいしい",
        expected: "スープは美味しい",
    },
    AnchorFixture {
        category: "full_sentences", input: "すーぷはあつい", expected: "スープは熱い"
    },
    AnchorFixture {
        category: "full_sentences",
        input: "おいしいすーぷは",
        expected: "美味しいスープは",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "あついすーぷはたべたくない",
        expected: "熱いスープは食べたくない",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "きょうははいしんです",
        expected: "今日は配信です",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "ほんじつはじかんの説明です",
        expected: "本日は時間の説明です",
    },
    AnchorFixture { category: "full_sentences", input: "にほんご", expected: "日本語" },
    AnchorFixture {
        category: "full_sentences",
        input: "おつかれさまでした",
        expected: "お疲れ様でした",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "とてもおいしい",
        expected: "とても美味しい",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "あしたははれるでしょう",
        expected: "明日は晴れるでしょう",
    },
    AnchorFixture { category: "full_sentences", input: "けいさん", expected: "計算" },
    AnchorFixture { category: "full_sentences", input: "そうじゅう", expected: "操縦" },
    AnchorFixture { category: "full_sentences", input: "しけい", expected: "死刑" },
    AnchorFixture { category: "full_sentences", input: "しじ", expected: "支持" },
    AnchorFixture { category: "full_sentences", input: "よけい", expected: "余計" },
    AnchorFixture {
        category: "full_sentences",
        input: "きょうははれです",
        expected: "今日は晴れです",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "あついりょうりはおいしい",
        expected: "熱い料理は美味しい",
    },
    AnchorFixture {
        category: "full_sentences",
        input: "きょうははいしんです",
        expected: "今日は配信です",
    },
];

fn anchor_cases() -> Vec<CorpusCase> {
    ANCHOR_FIXTURES
        .iter()
        .enumerate()
        .map(|(index, fixture)| CorpusCase {
            case_id: format!("anchor-{:03}", index + 1),
            category: fixture.category,
            input: fixture.input,
            expected: fixture.expected,
            context_mode: ContextMode::None,
            expected_origin: ExpectedOrigin::UnspecifiedLegacy,
            requires_dictionary_origin: false,
            source_kind: "legacy_anchor",
            provenance: "accuracy_corpus_v1",
            pair_id: None,
            accepted_variants: &[],
            equivalence_group: None,
            review_status: ReviewStatus::AnchorLocked,
            reviewed_by: Some("legacy_anchor_lock"),
        })
        .collect()
}

fn normalized_variant(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '％' => '%',
            '０'..='９' => {
                char::from_u32(u32::from(character) - u32::from('０') + u32::from('0'))
                    .unwrap_or(character)
            }
            _ => character,
        })
        .collect()
}

fn matches_accepted_variant(case: &CorpusCase, actual: &str) -> bool {
    let actual = normalized_variant(actual);
    std::iter::once(case.expected)
        .chain(case.accepted_variants.iter().copied())
        .any(|variant| normalized_variant(variant) == actual)
}

fn fnv1a_update(mut hash: u64, value: &str) -> u64 {
    for byte in value.as_bytes().iter().copied().chain(std::iter::once(0)) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV1A_64_PRIME);
    }
    hash
}

fn anchor_fingerprint(cases: &[CorpusCase]) -> u64 {
    cases.iter().fold(FNV1A_64_OFFSET_BASIS, |hash, case| {
        let hash = fnv1a_update(hash, &case.case_id);
        let hash = fnv1a_update(hash, case.category);
        let hash = fnv1a_update(hash, case.input);
        fnv1a_update(hash, case.expected)
    })
}

fn included_in_live_gate(case: &CorpusCase) -> bool {
    let independently_approved =
        case.review_status == ReviewStatus::IndependentlyReviewed && case.reviewed_by.is_some();
    case.context_mode != ContextMode::RightAvailableOffline
        && (case.review_status == ReviewStatus::AnchorLocked || independently_approved)
}

/// Cases that must convert exactly, not merely often enough.
///
/// The locked anchor now gates every strict case, while these pairs keep the
/// most safety-critical invariants explicit and independently diagnosable:
///
/// * hesitation fillers keep their natural hiragana spelling, and
/// * loanwords sharing the same prolonged sound mark still become katakana.
///
/// Suppressing the hiragana identity of a `ー` span is what makes `すーぷ`
/// convert to `スープ`; keying that suppression too broadly is what turned
/// `えーっと` into `エーッと`.  Breaking either direction fails here loudly.
const EXACT_CONVERSIONS: &[(&str, &str)] = &[
    // Fillers must not gain a stray conversion.
    ("えーっと", "えーっと"),
    ("えーと", "えーと"),
    ("あのー", "あのー"),
    ("そのー", "そのー"),
    ("うーん", "うーん"),
    // Loanwords with the same prolonged mark must still convert.
    ("すーぷ", "スープ"),
    ("でーた", "データ"),
    // Hiragana ASR loanwords without `ー` still use the Katakana / Latin ruby.
    ("ぱそこん", "パソコン"),
    ("かめら", "カメラ"),
    ("きりん", "キリン"),
    ("あいふぉん", "iPhone"),
    ("です", "です"),
    // Genuine single-mora conversions must survive.
    ("き", "木"),
    ("て", "手"),
    // Official-dictionary weather / numeral lists must not fall back to kana.
    ("はれ", "晴れ"),
    ("はれです", "晴れです"),
    ("はれます", "晴れます"),
    ("いち、に、さん", "1、2、3"),
    // Phrase-neutral official system dictionary + ConversionOptions::default().
    ("はしのはじからものがおちてます", "橋の端から物が落ちてます"),
    ("あついひなのであついすーぷをのみたくない", "暑い日なので熱いスープを飲みたくない"),
    ("あついひなのに", "暑い日なのに"),
    ("あついひなら", "暑い日なら"),
    // Dual-あつい homophone selection: weather あつい → 暑い, food あつい → 熱い.
    // Both occurrences must convert — a mora must never be swallowed between
    // the particle は and the following word あつい.
    ("あついひはあついたべものをたべたくない", "暑い日は熱い食べ物を食べたくない"),
    ("あついたべもの", "熱い食べ物"),
    ("りょうりがあついのでさます", "料理が熱いのでさます"),
    ("はしをわたる", "橋を渡る"),
    ("あついかべ", "厚い壁"),
    ("かべがあつい", "壁が厚い"),
    ("かいてください", "書いてください"),
    ("みちのはじ", "道の端"),
    ("つくえのはじ", "机の端"),
    ("えをかいて", "絵を描いて"),
    ("はじをかく", "恥を掻く"),
    ("かみのはじ", "紙の端"),
    ("かみをきる", "髪を切る"),
    // Past-auxiliary + から must not grow a copula だ at the segment boundary.
    // The intact reading converts; a duplicated だ (してただ) is a rescore /
    // offset bug, not a dictionary gap.
    (
        "でんしゃがちえんしてたからぼくはがっこうにいかない",
        "電車が遅延してたから僕は学校に行かない",
    ),
    ("ひな", "雛"),
    // Compact-unknown after a predicate must not outrank multi-Kanji lexical
    // paths; single-Kanji object + colloquial verb wins over written compounds.
    ("かきくう", "柿食う"),
    ("となりのきゃくはよくかきくうきゃくだ", "隣の客は良く柿食う客だ"),
    // Bare noun/adjective roots must not beat conjugational stems before ます.
    ("あめがふります", "雨が降ります"),
    ("ふります", "降ります"),
    // Hiragana identity before ます must not beat a conjugational Kanji stem.
    ("のみます", "飲みます"),
    ("みずをのみます", "水を飲みます"),
    // Bare roots / one-mora Kanji must not absorb stem + evidential そうです.
    // Weather context must keep precipitation, not the wave/shake homophone.
    ("ふりそうです", "振りそうです"),
    ("あめがふりそうです", "雨が降りそうです"),
    ("ゆきがふりそうです", "雪が降りそうです"),
    // Full-span person plural must outrank rare short heads + たち.
    ("わたしたちはがくせいです", "私たちは学生です"),
    ("わたしたち", "私たち"),
];

#[test]
fn exact_conversions_hold() {
    let root = crate::dictionary::test_system_dictionary_path();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");

    let mut mismatches: Vec<String> = Vec::new();
    for (input, expected) in EXACT_CONVERSIONS {
        let actual = convert_with_dictionary(input, &dictionary, ConversionOptions::default())
            .into_iter()
            .next()
            .map(|candidate| candidate.text)
            .unwrap_or_default();
        if actual != *expected {
            mismatches.push(format!("{input:?} -> expected {expected:?}, got {actual:?}"));
        }
    }

    assert!(
        mismatches.is_empty(),
        "{} of {} exact conversions regressed:\n  {}",
        mismatches.len(),
        EXACT_CONVERSIONS.len(),
        mismatches.join("\n  "),
    );
}

#[test]
fn official_dictionary_default_conversion_is_phrase_neutral_for_hashi_no_haji() {
    let root = crate::dictionary::test_system_dictionary_path();
    // Official system dictionary only: no user/phrase or learning-memory rows.
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        user: None,
        memory: None,
    })
    .expect("official AzooKey dictionary should load");

    let actual = convert_with_dictionary(
        "はしのはじからものがおちてます",
        &dictionary,
        ConversionOptions::default(),
    )
    .into_iter()
    .next()
    .map(|candidate| candidate.text)
    .unwrap_or_default();

    assert_eq!(actual, "橋の端から物が落ちてます");
}

#[test]
fn accuracy_corpus_schema_and_anchor_fingerprint_are_stable() {
    assert_eq!(CONTEXT_MODE_SCHEMA.len(), 3);
    assert_eq!(EXPECTED_ORIGIN_SCHEMA.len(), 7);
    assert_eq!(REVIEW_STATUS_SCHEMA.len(), 3);

    let cases = anchor_cases();
    assert_eq!(cases.len(), ANCHOR_EXPECTED_TOTAL);
    assert_eq!(anchor_fingerprint(&cases), ANCHOR_FINGERPRINT);
    for case in &cases {
        assert!(case.case_id.starts_with("anchor-"));
        assert_eq!(case.context_mode, ContextMode::None);
        assert_eq!(case.expected_origin, ExpectedOrigin::UnspecifiedLegacy);
        assert!(!case.requires_dictionary_origin);
        assert_eq!(case.source_kind, "legacy_anchor");
        assert_eq!(case.provenance, "accuracy_corpus_v1");
        assert_eq!(case.pair_id, None);
        assert!(case.accepted_variants.is_empty());
        assert_eq!(case.equivalence_group, None);
        assert_eq!(case.review_status, ReviewStatus::AnchorLocked);
        assert_eq!(case.reviewed_by, Some("legacy_anchor_lock"));
        assert!(included_in_live_gate(case));
    }
}

#[test]
fn variant_and_review_metrics_remain_separate_from_the_live_gate() {
    let mut cases = anchor_cases();
    let mut case = cases.remove(0);
    case.expected = "60%";
    case.accepted_variants = &["六十％"];

    assert_ne!("６０％", case.expected);
    assert!(matches_accepted_variant(&case, "６０％"));

    case.review_status = ReviewStatus::PendingIndependentReview;
    case.reviewed_by = None;
    assert!(!included_in_live_gate(&case));
    case.review_status = ReviewStatus::IndependentlyReviewed;
    assert!(!included_in_live_gate(&case));
    case.reviewed_by = Some("specialist-advisor");
    assert!(included_in_live_gate(&case));
    case.context_mode = ContextMode::RightAvailableOffline;
    assert!(!included_in_live_gate(&case));
}

#[test]
fn accuracy_corpus_report() {
    let root = crate::dictionary::test_system_dictionary_path();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");

    let cases = anchor_cases();
    let mut category_stats: BTreeMap<&str, AccuracyCount> = BTreeMap::new();
    let mut strict_failures: Vec<(&CorpusCase, String)> = Vec::new();
    let mut totals = AccuracyCount::default();

    for case in &cases {
        let candidate =
            convert_with_dictionary(case.input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next();
        let actual = candidate.as_ref().map(|candidate| candidate.text.as_str()).unwrap_or("");
        let strict_passed = actual == case.expected;
        let variant_passed = matches_accepted_variant(case, actual);
        let category = category_stats.entry(case.category).or_default();
        category.total += 1;
        totals.total += 1;
        if strict_passed {
            category.strict_passed += 1;
            totals.strict_passed += 1;
        } else {
            strict_failures.push((case, actual.to_string()));
        }
        if variant_passed {
            category.variant_passed += 1;
            totals.variant_passed += 1;
        }
    }

    eprintln!();
    eprintln!("=== AzooKey Accuracy Corpus Report ===");
    eprintln!(
        "Anchor strict: {}/{} ({:.1}%), normalized variant: {}/{} ({:.1}%)",
        totals.strict_passed,
        totals.total,
        totals.strict_passed as f32 / totals.total as f32 * 100.0,
        totals.variant_passed,
        totals.total,
        totals.variant_passed as f32 / totals.total as f32 * 100.0,
    );
    eprintln!();
    eprintln!("Per-category (strict / normalized variant):");
    for (category, count) in &category_stats {
        eprintln!(
            "  {category:<22} {:>2}/{:<2} / {:>2}/{:<2}",
            count.strict_passed, count.total, count.variant_passed, count.total,
        );
    }
    eprintln!();
    if strict_failures.is_empty() {
        eprintln!("Strict failures: none");
    } else {
        eprintln!("Strict failures:");
        for (case, actual) in &strict_failures {
            eprintln!(
                "  [{}] {} {:?} -> expected {:?}, got {:?}",
                case.category, case.case_id, case.input, case.expected, actual
            );
        }
    }
    eprintln!();

    assert_eq!(totals.total, ANCHOR_EXPECTED_TOTAL, "locked anchor size changed");
    for (category, baseline_passed) in ANCHOR_CATEGORY_BASELINES {
        let count = category_stats
            .get(category)
            .unwrap_or_else(|| panic!("locked anchor category {category:?} disappeared"));
        assert_eq!(count.total, *baseline_passed, "locked anchor category size changed");
        assert_eq!(
            count.strict_passed, *baseline_passed,
            "anchor category {category:?} strict baseline regressed"
        );
    }
    assert_eq!(category_stats.len(), ANCHOR_CATEGORY_BASELINES.len());
    assert_eq!(
        totals.strict_passed, ANCHOR_MINIMUM_STRICT_PASSED,
        "locked anchor strict baseline regressed"
    );
}

#[test]
fn portable_archive_matches_filesystem_on_caption_fixtures() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = crate::dictionary::test_system_dictionary_path();
    let filesystem = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("filesystem dictionary");

    let archive_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/cloudflare-worker-server/public/azookey/system.azkdict.gz");
    assert!(archive_path.is_file(), "portable archive missing at {}", archive_path.display());
    let output = Command::new("gzip")
        .args(["-dc", archive_path.to_str().expect("utf-8 archive path")])
        .output()
        .expect("gzip");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let portable = AzooKeyDictionary::from_portable_system_dictionary(output.stdout)
        .expect("portable dictionary");

    let fixtures = [
        "とても",
        "すーぷは",
        "おつかれさまでした",
        "あしたのてんきははれ",
        "きょうははいしんです",
        "きょうのてんきはあつい",
        "あついひなのであついすーぷをのみたくない",
        "あついひなのに",
        "ひなのに",
        "あついひなら",
        "ひな",
        "はしのはじからものがおちてます",
        "しへい、こうか、じゅうえん",
        "いっとうしょう、けんしょう、おうぼ",
        "こうぎょう、きかく、とういつ",
    ];
    let mut diffs = Vec::new();
    for input in fixtures {
        let filesystem_text =
            convert_with_dictionary(input, &filesystem, ConversionOptions::default())
                .into_iter()
                .next()
                .map(|candidate| candidate.text)
                .unwrap_or_default();
        let portable_text = convert_with_dictionary(input, &portable, ConversionOptions::default())
            .into_iter()
            .next()
            .map(|candidate| candidate.text)
            .unwrap_or_default();
        if filesystem_text != portable_text {
            diffs.push(format!(
                "{input:?}: filesystem={filesystem_text:?} portable={portable_text:?}"
            ));
        }
    }
    assert!(
        diffs.is_empty(),
        "portable dictionary drifted from filesystem:\n  {}",
        diffs.join("\n  ")
    );
}
