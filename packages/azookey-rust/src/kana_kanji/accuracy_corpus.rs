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
use std::collections::{BTreeMap, BTreeSet};

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

/// The locked dictionary-only anchor gate. Expansion cases remain report-only
/// until their labels and phase-one baseline are independently reviewed.
/// Changing an expectation or fingerprint requires independent Japanese-quality
/// review; updating a hash only to make this test green is prohibited.
const ANCHOR_EXPECTED_TOTAL: usize = 119;
const ANCHOR_MINIMUM_STRICT_PASSED: usize = 118;
const FNV1A_64_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV1A_64_PRIME: u64 = 0x100000001b3;
const ANCHOR_FINGERPRINT: u64 = 0x58dd29431e71c2c7;
const INCOMPLETE_STREAMING_EXPECTED_TOTAL: usize = 20;
const INCOMPLETE_STREAMING_MINIMUM_STRICT_PASSED: usize = 9;
const INCOMPLETE_STREAMING_MINIMUM_VARIANT_PASSED: usize = 10;
const INCOMPLETE_STREAMING_FINGERPRINT: u64 = 0x2269f712efa11d40;
const MEASURED_COMPLETED_FAILURE_EXPECTED_TOTAL: usize = 23;
const MEASURED_COMPLETED_FAILURE_MINIMUM_VARIANT_PASSED: usize = 5;
const MEASURED_COMPLETED_FAILURE_FINGERPRINT: u64 = 0xdd6076306c0823db;
const MEASURED_WORD_BOUNDARY_EXPECTED_TOTAL: usize = 7;

// Raise either expansion minimum after the same inputs produce the same higher
// score in three consecutive runs. Never lower a minimum to accommodate a
// regression, and never use equality: improvements must remain able to pass.
const ANCHOR_CATEGORY_BASELINES: &[(&str, usize, usize)] = &[
    ("compound_particles", 6, 6),
    ("dates_times", 6, 6),
    ("fillers_interjections", 6, 6),
    ("full_sentences", 18, 17),
    ("isolated_words_phrases", 16, 16),
    ("honorifics", 6, 6),
    ("loanword_particle", 11, 11),
    ("numbers_counters", 11, 11),
    ("particle_tails", 12, 12),
    ("proper_nouns", 7, 7),
    ("sentence_final", 6, 6),
    ("single_mora_kanji", 2, 2),
    ("verbs_inflections", 12, 12),
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
    // Full sentences and isolated dictionary coverage.
    //
    // `full_sentences` previously held single words alongside sentences, so
    // its pass rate said nothing about sentence conversion. The verifier only
    // runs with left context, which isolated entries never have; splitting the
    // groups makes their dictionary-coverage and sentence-quality roles clear.
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
        category: "isolated_words_phrases",
        input: "かんじのしょりをかいぜん",
        expected: "漢字の処理を改善",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "おんりょうをちょうせい",
        expected: "音量を調整",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "しょうぼう、しょうか、ほのお",
        expected: "消防、消火、炎",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "かたち、こうし、もよう",
        expected: "形、格子、模様",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "せんそう、しんこう、しんりゃく",
        expected: "戦争、侵攻、侵略",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "かせん、かこう、かわべ",
        expected: "河川、河口、川辺",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "にゅうきん、しゅうし、かくにん",
        expected: "入金、収支、確認",
    },
    AnchorFixture {
        category: "isolated_words_phrases",
        input: "もじ、かんじ、ぞくじ",
        expected: "文字、漢字、俗字",
    },
    // `柿食う` drops the particle from `柿を食う` and only occurs as a
    // fragment of the tongue twister, unlike a complete predicate utterance.
    AnchorFixture {
        category: "isolated_words_phrases", input: "かきくう", expected: "柿食う"
    },
    AnchorFixture {
        category: "full_sentences",
        input: "となりのきゃくはよくかきくうきゃくだ",
        expected: "隣の客は良く柿食う客だ",
    },
    // `さます` is not converted by the dictionary. Correcting the expected
    // Japanese to `冷ます` intentionally exposes that dictionary-only miss.
    AnchorFixture {
        category: "full_sentences",
        input: "りょうりがあついのでさます",
        expected: "料理が熱いので冷ます",
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
        category: "isolated_words_phrases",
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
    AnchorFixture {
        category: "isolated_words_phrases", input: "にほんご", expected: "日本語"
    },
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
    AnchorFixture { category: "isolated_words_phrases", input: "けいさん", expected: "計算" },
    AnchorFixture {
        category: "isolated_words_phrases", input: "そうじゅう", expected: "操縦"
    },
    AnchorFixture { category: "isolated_words_phrases", input: "しけい", expected: "死刑" },
    AnchorFixture { category: "isolated_words_phrases", input: "しじ", expected: "支持" },
    AnchorFixture { category: "isolated_words_phrases", input: "よけい", expected: "余計" },
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

/// Product policy for incomplete live-caption readings:
///
/// Convert completed words, but do not predict a kanji completion for the final
/// incomplete morpheme. Unlike an IME, live captions give the viewer no chance
/// to select or reject a candidate. A short-lived kana suffix is less harmful
/// than a guessed kanji that visibly flickers away when the final audio arrives.
fn incomplete_streaming_case(
    case_id: &str,
    input: &'static str,
    expected: &'static str,
) -> CorpusCase {
    CorpusCase {
        case_id: case_id.to_string(),
        category: "incomplete_streaming",
        input,
        expected,
        context_mode: ContextMode::LeftOnly,
        expected_origin: ExpectedOrigin::Mixed,
        requires_dictionary_origin: false,
        source_kind: "hand_authored_caption_prefix",
        provenance: "specialist_advisor_category_plan_2026-08-14",
        pair_id: None,
        accepted_variants: &[],
        equivalence_group: None,
        review_status: ReviewStatus::PendingIndependentReview,
        reviewed_by: None,
    }
}

fn incomplete_streaming_cases() -> Vec<CorpusCase> {
    [
        ("stream-001", "かいぎのしりょうをかくに", "会議の資料をかくに"),
        ("stream-002", "あしたのよていをちょうせ", "明日の予定をちょうせ"),
        ("stream-003", "ぷろじぇくとのしんちょくをほうこ", "プロジェクトの進捗をほうこ"),
        ("stream-004", "しすてむのしょうがいをちょうさちゅ", "システムの障害を調査ちゅ"),
        ("stream-005", "でんしゃがちえんしているた", "電車が遅延しているた"),
        ("stream-006", "よやくのへんこうをおねがいし", "予約の変更をお願いし"),
        ("stream-007", "あたらしいきのうをついかしてい", "新しい機能を追加してい"),
        ("stream-008", "せつめいしょをよんでからそうさし", "説明書を読んでから操作し"),
        ("stream-009", "かいしゃにもどってしりょうをつく", "会社に戻って資料をつく"),
        ("stream-010", "たいおうほうほうをけんとうしてお", "対応方法を検討してお"),
        ("stream-011", "しょうさいはのちほどごれんらくいたし", "詳細は後ほどご連絡いたし"),
        ("stream-012", "ごふめいなてんがございましたらおし", "ご不明な点がございましたらおし"),
        ("stream-013", "でーたのばっくあっぷをかくにんしてく", "データのバックアップを確認してく"),
        ("stream-014", "もんだいのげんいんをとくていするた", "問題の原因を特定するた"),
        ("stream-015", "あんぜんをかくにんしてからさぎょうをはじ", "安全を確認してから作業をはじ"),
        ("stream-016", "けいやくしょのないようをさいどかくにんし", "契約書の内容を再度確認し"),
        ("stream-017", "あぷりをさいきどうしてもういちどためし", "アプリを再起動してもう一度試し"),
        ("stream-018", "しんせいしょるいをきげんまでにていしゅつし", "申請書類を期限までに提出し"),
        ("stream-019", "かいぎがおわりしだいけっかをきょうゆうし", "会議が終わり次第結果を共有し"),
        (
            "stream-020",
            "たんとうしゃにかくにんしておりかえしごれんらくし",
            "担当者に確認して折り返しご連絡し",
        ),
    ]
    .into_iter()
    .map(|(case_id, input, expected)| {
        let mut case = incomplete_streaming_case(case_id, input, expected);
        if case_id == "stream-017" {
            case.accepted_variants = &["アプリを再起動してもう1度試し"];
        }
        case.review_status = ReviewStatus::IndependentlyReviewed;
        case.reviewed_by = Some("specialist-advisor");
        case
    })
    .collect()
}

fn measured_completed_failure_cases() -> Vec<CorpusCase> {
    [
        (
            "measured-001",
            "completed_numeric_symbols",
            "こうすいかくりつはろくじゅっぱーせんとです",
            "降水確率は60%です",
            ExpectedOrigin::NumericSynthesized,
            "contracted-juttu-percent",
        ),
        // Live-caption numerals use ASCII digits for faster scanning, matching
        // the existing numeric-synthesis policy; prefer `3分の2` to `三分の二`.
        (
            "measured-002",
            "completed_numeric_symbols",
            "さんぶんのにがさんせいしました",
            "3分の2が賛成しました",
            ExpectedOrigin::NumericSynthesized,
            "fraction-numeric",
        ),
        (
            "measured-003",
            "completed_contextual_homophones",
            "こどもがあめをなめています",
            "子供が飴を舐めています",
            ExpectedOrigin::Mixed,
            "ame-candy",
        ),
        (
            "measured-004",
            "completed_contextual_homophones",
            "せんきょはこうせいにおこなわれました",
            "選挙は公正に行われました",
            ExpectedOrigin::Mixed,
            "kousei-fair",
        ),
        // This category isolates measured segmentation mistakes: the
        // dictionary chooses plausible smaller pieces, while a sentence model
        // can score the intended whole-word boundary.
        (
            "measured-005",
            "completed_word_boundary_failures",
            "こうせいどなそくていがひつようです",
            "高精度な測定が必要です",
            ExpectedOrigin::Mixed,
            "high-precision",
        ),
        (
            "measured-006",
            "completed_contextual_homophones",
            "かみをとかしてからでかけます",
            "髪をとかしてから出かけます",
            ExpectedOrigin::Mixed,
            "hair-context",
        ),
        (
            "measured-007",
            "completed_contextual_homophones",
            "はしでぱすたをたべます",
            "箸でパスタを食べます",
            ExpectedOrigin::Mixed,
            "chopsticks-context",
        ),
        (
            "measured-008",
            "completed_contextual_homophones",
            "せいかうりばはにかいです",
            "青果売り場は2階です",
            ExpectedOrigin::Mixed,
            "produce-context",
        ),
        (
            "measured-009",
            "completed_contextual_homophones",
            "じどうはんばいきにこうかをいれます",
            "自動販売機に硬貨を入れます",
            ExpectedOrigin::Mixed,
            "coin-context",
        ),
        (
            "measured-010",
            "completed_contextual_homophones",
            "あたらしいきのうのしようしょをかくにんします",
            "新しい機能の仕様書を確認します",
            ExpectedOrigin::Mixed,
            "function-specification-context",
        ),
        (
            "measured-011",
            "completed_accepted_variants",
            "さんじゅうどをこえるあつさです",
            "30度を超える暑さです",
            ExpectedOrigin::Mixed,
            "koeru-orthography",
        ),
        (
            "measured-012",
            "completed_accepted_variants",
            "ひゃくにじゅうさんまんえんをうりあげました",
            "123万円を売り上げました",
            ExpectedOrigin::Mixed,
            "large-number-notation",
        ),
        (
            "measured-013",
            "completed_accepted_variants",
            "えきのちかくにしょうがいしゃようのすろーぷがあります",
            "駅の近くに障害者用のスロープがあります",
            ExpectedOrigin::Mixed,
            "disability-orthography",
        ),
        // Expanded and contracted readings of the same age must follow the
        // live-caption ASCII-numeral policy documented by measured-002.
        (
            "measured-014",
            "completed_numeric_symbols",
            "ごじゅうさい",
            "50歳",
            ExpectedOrigin::NumericSynthesized,
            "expanded-age-notation",
        ),
        (
            "measured-015",
            "completed_numeric_symbols",
            "きょうのさいこうきおんはさんじゅうごどです",
            "今日の最高気温は35度です",
            ExpectedOrigin::Mixed,
            "today-before-numeric-temperature",
        ),
        (
            "measured-016",
            "completed_word_boundary_failures",
            "ひとりあたりにせんごひゃくえんです",
            "一人当たり2500円です",
            ExpectedOrigin::Mixed,
            "person-counter-boundary",
        ),
        (
            "measured-017",
            "completed_contextual_homophones",
            "あついおちゃをゆっくりのみます",
            "熱いお茶をゆっくり飲みます",
            ExpectedOrigin::Mixed,
            "sentence-final-drink",
        ),
        (
            "measured-018",
            "completed_word_boundary_failures",
            "しんせいしょのきげんをかくにんしてください",
            "申請書の期限を確認してください",
            ExpectedOrigin::Mixed,
            "application-form-boundary",
        ),
        (
            "measured-019",
            "completed_word_boundary_failures",
            "このしようではどうさしません",
            "この仕様では動作しません",
            ExpectedOrigin::Mixed,
            "deictic-specification-boundary",
        ),
        // The bare reading `きしゃ` is not uniquely convertible. The complete
        // sentence makes the first occurrence a reporter employed by a company
        // and the second a train, so this is useful language-model context.
        // `汽車` is valid but dated; everyday modern speech more often uses
        // `電車`, while this construction deliberately measures the homophone.
        (
            "measured-020",
            "completed_contextual_homophones",
            "かいしゃのきしゃがきしゃでかえりました",
            "会社の記者が汽車で帰りました",
            ExpectedOrigin::Mixed,
            "reporter-train-context",
        ),
        (
            "measured-021",
            "completed_word_boundary_failures",
            "じゅうようなかいぎをひらきます",
            "重要な会議を開きます",
            ExpectedOrigin::Mixed,
            "important-meeting-boundary",
        ),
        // Word-boundary cases are measured rather than invented: each input
        // below failed the official dictionary probe. They represent distinct
        // segmentation errors so one fix cannot erase the whole category.
        (
            "measured-022",
            "completed_word_boundary_failures",
            "ぷれぜんとをかみでつつみます",
            "プレゼントを紙で包みます",
            ExpectedOrigin::Mixed,
            "paper-wrapping-boundary",
        ),
        (
            "measured-023",
            "completed_word_boundary_failures",
            "てんぽのかいてんじかんをしらべます",
            "店舗の開店時間を調べます",
            ExpectedOrigin::Mixed,
            "opening-hours-boundary",
        ),
    ]
    .into_iter()
    .map(|(case_id, category, input, expected, expected_origin, equivalence_group)| CorpusCase {
        case_id: case_id.to_string(),
        category,
        input,
        expected,
        context_mode: ContextMode::None,
        expected_origin,
        requires_dictionary_origin: false,
        source_kind: "measured_dictionary_failure",
        provenance: "official_dictionary_probe_2026-08-14",
        pair_id: None,
        accepted_variants: &[],
        equivalence_group: Some(equivalence_group),
        review_status: ReviewStatus::PendingIndependentReview,
        reviewed_by: None,
    })
    .map(|mut case| {
        match case.case_id.as_str() {
            // `超える` is standard for exceeding a numeric threshold, while
            // the widely used `越える` remains acceptable caption text.
            "measured-011" => case.accepted_variants = &["30度を越える暑さです"],
            // The values are numerically equivalent and `123万円` is easier to
            // read in captions, but the current `1230000円` remains acceptable.
            "measured-012" => case.accepted_variants = &["1230000円を売り上げました"],
            "measured-013" => {
                case.accepted_variants = &["駅の近くに障がい者用のスロープがあります"];
            }
            // Quantities use scanning-friendly Arabic numerals (`2500円`),
            // while numbers inside idioms follow convention (`一人当たり`).
            // ASCII `1人` remains a semantically equivalent caption variant.
            "measured-016" => case.accepted_variants = &["1人当たり2500円です"],
            _ => {}
        }
        case
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

fn expansion_fingerprint(cases: &[CorpusCase]) -> u64 {
    cases.iter().fold(FNV1A_64_OFFSET_BASIS, |hash, case| {
        let hash = fnv1a_update(hash, &case.case_id);
        let hash = fnv1a_update(hash, case.category);
        let hash = fnv1a_update(hash, case.input);
        let hash = fnv1a_update(hash, case.expected);
        let hash =
            case.accepted_variants.iter().fold(hash, |hash, variant| fnv1a_update(hash, variant));
        let hash = fnv1a_update(hash, case.source_kind);
        let hash = fnv1a_update(hash, case.provenance);
        fnv1a_update(hash, case.reviewed_by.unwrap_or(""))
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
    // Expanded and contracted numeral units must reach the same ASCII counter
    // surface instead of splitting the leading digit into an unrelated word.
    ("ろくじゅうぱーせんと", "60%"),
    ("ろくじゅっぱーせんと", "60%"),
    ("ろくじゅうこ", "60個"),
    ("ろくじゅっこ", "60個"),
    ("ひゃくぱーせんと", "100%"),
    ("ひゃっぱーせんと", "100%"),
    // Age notation follows the same ASCII-numeral policy for both readings.
    ("ごじゅうさい", "50歳"),
    ("ごじゅっさい", "50歳"),
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
    let mut case_ids = BTreeSet::new();
    for case in &cases {
        assert!(case_ids.insert(case.case_id.as_str()), "duplicate case ID: {}", case.case_id);
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

    let expansion_cases = incomplete_streaming_cases();
    assert_eq!(expansion_cases.len(), INCOMPLETE_STREAMING_EXPECTED_TOTAL);
    assert_eq!(expansion_fingerprint(&expansion_cases), INCOMPLETE_STREAMING_FINGERPRINT);
    for case in &expansion_cases {
        assert!(case_ids.insert(case.case_id.as_str()), "duplicate case ID: {}", case.case_id);
        assert!(case.case_id.starts_with("stream-"));
        assert_eq!(case.category, "incomplete_streaming");
        assert_eq!(case.context_mode, ContextMode::LeftOnly);
        assert_eq!(case.expected_origin, ExpectedOrigin::Mixed);
        assert_eq!(case.source_kind, "hand_authored_caption_prefix");
        assert_eq!(case.provenance, "specialist_advisor_category_plan_2026-08-14");
        assert_eq!(case.review_status, ReviewStatus::IndependentlyReviewed);
        assert_eq!(case.reviewed_by, Some("specialist-advisor"));
        assert!(included_in_live_gate(case));
    }

    let measured_cases = measured_completed_failure_cases();
    assert_eq!(measured_cases.len(), MEASURED_COMPLETED_FAILURE_EXPECTED_TOTAL);
    assert_eq!(expansion_fingerprint(&measured_cases), MEASURED_COMPLETED_FAILURE_FINGERPRINT);
    for case in &measured_cases {
        assert!(case_ids.insert(case.case_id.as_str()), "duplicate case ID: {}", case.case_id);
        assert!(case.case_id.starts_with("measured-"));
        assert!(case.category.starts_with("completed_"));
        assert_eq!(case.context_mode, ContextMode::None);
        assert_eq!(case.source_kind, "measured_dictionary_failure");
        assert_eq!(case.provenance, "official_dictionary_probe_2026-08-14");
        assert!(case.equivalence_group.is_some());
        assert_eq!(case.review_status, ReviewStatus::PendingIndependentReview);
        assert_eq!(case.reviewed_by, None);
        assert!(!included_in_live_gate(case));
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

    let expansion_cases = incomplete_streaming_cases();
    let mut expansion_stats: BTreeMap<&str, AccuracyCount> = BTreeMap::new();
    let mut expansion_failures: Vec<(&CorpusCase, String)> = Vec::new();
    let mut expansion_totals = AccuracyCount::default();
    let mut pending_review = 0usize;
    let mut independently_reviewed = 0usize;
    let mut right_context_offline = 0usize;
    let mut live_gate_eligible = 0usize;
    for case in &expansion_cases {
        let candidate =
            convert_with_dictionary(case.input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next();
        let actual = candidate.as_ref().map(|candidate| candidate.text.as_str()).unwrap_or("");
        let strict_passed = actual == case.expected;
        let variant_passed = matches_accepted_variant(case, actual);
        let category = expansion_stats.entry(case.category).or_default();
        category.total += 1;
        expansion_totals.total += 1;
        if strict_passed {
            category.strict_passed += 1;
            expansion_totals.strict_passed += 1;
        } else {
            expansion_failures.push((case, actual.to_string()));
        }
        if variant_passed {
            category.variant_passed += 1;
            expansion_totals.variant_passed += 1;
        }
        match case.review_status {
            ReviewStatus::PendingIndependentReview => pending_review += 1,
            ReviewStatus::IndependentlyReviewed => independently_reviewed += 1,
            ReviewStatus::AnchorLocked => {}
        }
        if case.context_mode == ContextMode::RightAvailableOffline {
            right_context_offline += 1;
        }
        if included_in_live_gate(case) {
            live_gate_eligible += 1;
        }
    }

    eprintln!("=== Reviewed Expansion Corpus Report ===");
    eprintln!(
        "Strict: {}/{} ({:.1}%), normalized variant: {}/{} ({:.1}%)",
        expansion_totals.strict_passed,
        expansion_totals.total,
        expansion_totals.strict_passed as f32 / expansion_totals.total as f32 * 100.0,
        expansion_totals.variant_passed,
        expansion_totals.total,
        expansion_totals.variant_passed as f32 / expansion_totals.total as f32 * 100.0,
    );
    eprintln!(
        "Review: {pending_review} pending, {independently_reviewed} independently reviewed; \
         context: {right_context_offline} right-offline; live-gate eligible: {live_gate_eligible}"
    );
    for (category, count) in &expansion_stats {
        eprintln!(
            "  {category:<22} {:>2}/{:<2} strict / {:>2}/{:<2} normalized variant",
            count.strict_passed, count.total, count.variant_passed, count.total,
        );
    }
    if expansion_failures.is_empty() {
        eprintln!("Expansion strict failures: none");
    } else {
        eprintln!("Expansion strict failures:");
        for (case, actual) in &expansion_failures {
            eprintln!(
                "  [{}] {} {:?} -> expected {:?}, got {:?}",
                case.category, case.case_id, case.input, case.expected, actual
            );
        }
    }
    eprintln!();

    assert_eq!(
        expansion_totals.total, INCOMPLETE_STREAMING_EXPECTED_TOTAL,
        "reviewed incomplete-streaming corpus size changed"
    );
    assert_eq!(pending_review, 0, "reviewed live-gate cases became pending");
    assert_eq!(independently_reviewed, INCOMPLETE_STREAMING_EXPECTED_TOTAL);
    assert_eq!(right_context_offline, 0);
    assert_eq!(live_gate_eligible, INCOMPLETE_STREAMING_EXPECTED_TOTAL);
    assert!(
        expansion_totals.strict_passed >= INCOMPLETE_STREAMING_MINIMUM_STRICT_PASSED,
        "incomplete-streaming strict accuracy regressed: {}/{} is below {}/{}",
        expansion_totals.strict_passed,
        expansion_totals.total,
        INCOMPLETE_STREAMING_MINIMUM_STRICT_PASSED,
        INCOMPLETE_STREAMING_EXPECTED_TOTAL,
    );
    assert!(
        expansion_totals.variant_passed >= INCOMPLETE_STREAMING_MINIMUM_VARIANT_PASSED,
        "incomplete-streaming variant accuracy regressed: {}/{} is below {}/{}",
        expansion_totals.variant_passed,
        expansion_totals.total,
        INCOMPLETE_STREAMING_MINIMUM_VARIANT_PASSED,
        INCOMPLETE_STREAMING_EXPECTED_TOTAL,
    );

    assert_eq!(totals.total, ANCHOR_EXPECTED_TOTAL, "locked anchor size changed");
    for (category, expected_total, minimum_strict_passed) in ANCHOR_CATEGORY_BASELINES {
        let count = category_stats
            .get(category)
            .unwrap_or_else(|| panic!("locked anchor category {category:?} disappeared"));
        assert_eq!(count.total, *expected_total, "locked anchor category size changed");
        assert!(
            count.strict_passed >= *minimum_strict_passed,
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
fn measured_completed_failure_corpus_report() {
    let root = crate::dictionary::test_system_dictionary_path();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");
    let cases = measured_completed_failure_cases();
    let mut strict_passed = 0usize;
    let mut variant_passed = 0usize;
    let mut category_stats: BTreeMap<&str, AccuracyCount> = BTreeMap::new();
    for case in &cases {
        let category = category_stats.entry(case.category).or_default();
        category.total += 1;
        let actual = convert_with_dictionary(case.input, &dictionary, ConversionOptions::default())
            .into_iter()
            .next()
            .map(|candidate| candidate.text)
            .unwrap_or_default();
        if actual == case.expected {
            strict_passed += 1;
            category.strict_passed += 1;
        } else {
            eprintln!(
                "[{}] {} {:?} -> expected {:?}, got {:?}",
                case.category, case.case_id, case.input, case.expected, actual
            );
        }
        if matches_accepted_variant(case, &actual) {
            variant_passed += 1;
            category.variant_passed += 1;
        }
    }
    eprintln!(
        "Measured completed dictionary baseline: {strict_passed}/{} strict, {variant_passed}/{} variant",
        cases.len(),
        cases.len()
    );
    for (category, count) in &category_stats {
        eprintln!(
            "  {category:<34} {:>2}/{:<2} strict / {:>2}/{:<2} variant",
            count.strict_passed, count.total, count.variant_passed, count.total
        );
    }

    assert_eq!(cases.len(), MEASURED_COMPLETED_FAILURE_EXPECTED_TOTAL);
    assert_eq!(
        category_stats.get("completed_word_boundary_failures").map(|count| count.total),
        Some(MEASURED_WORD_BOUNDARY_EXPECTED_TOTAL),
        "measured word-boundary category size changed"
    );
    // These cases were selected from measured failures. Gate the aggregate
    // accepted-variant score with a lower bound; pending category baselines
    // remain report-only until independent review.
    assert!(
        variant_passed >= MEASURED_COMPLETED_FAILURE_MINIMUM_VARIANT_PASSED,
        "measured completed-sentence variant baseline regressed: {variant_passed}/{} is below {}/{}",
        cases.len(),
        MEASURED_COMPLETED_FAILURE_MINIMUM_VARIANT_PASSED,
        MEASURED_COMPLETED_FAILURE_EXPECTED_TOTAL,
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

#[test]
#[ignore = "manual filesystem dictionary I/O and timing benchmark"]
fn benchmark_filesystem_dictionary_lookups() {
    use crate::dictionary::{filesystem_source_read_count, reset_filesystem_source_read_count};
    use std::time::Instant;

    let root = crate::dictionary::test_system_dictionary_path();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");

    let stream_input = "ぷろじぇくとのしんちょくをほうこ";
    reset_filesystem_source_read_count();
    for iteration in 1..=10 {
        let reads_before = filesystem_source_read_count();
        let started = Instant::now();
        let _ = convert_with_dictionary(stream_input, &dictionary, ConversionOptions::default());
        eprintln!(
            "stream003 iteration={iteration} elapsed_us={} filesystem_reads={}",
            started.elapsed().as_micros(),
            filesystem_source_read_count() - reads_before,
        );
    }

    let mut cases = anchor_cases();
    cases.extend(measured_completed_failure_cases());
    reset_filesystem_source_read_count();
    let started = Instant::now();
    for case in &cases {
        let _ = convert_with_dictionary(case.input, &dictionary, ConversionOptions::default());
    }
    eprintln!(
        "corpus cases={} elapsed_ms={} filesystem_reads={}",
        cases.len(),
        started.elapsed().as_millis(),
        filesystem_source_read_count(),
    );
}
