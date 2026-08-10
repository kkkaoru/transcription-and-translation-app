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

struct CorpusCase {
    category: &'static str,
    input: &'static str,
    expected: &'static str,
}

/// Minimum fraction of cases that must pass.  Set just below the measured
/// baseline (93/106 = 87.7%) so the test is a regression guard; raised as
/// accuracy improves.
const MINIMUM_PASS_RATE: f32 = 0.87;

const CORPUS: &[CorpusCase] = &[
    // -----------------------------------------------------------------------
    // Particle tails — a particle attached to a converted content word.
    // -----------------------------------------------------------------------
    CorpusCase { category: "particle_tails", input: "きょうは", expected: "今日は" },
    CorpusCase { category: "particle_tails", input: "わたしが", expected: "私が" },
    CorpusCase { category: "particle_tails", input: "ほんを", expected: "本を" },
    CorpusCase { category: "particle_tails", input: "えきに", expected: "駅に" },
    CorpusCase { category: "particle_tails", input: "カフェで", expected: "カフェで" },
    CorpusCase { category: "particle_tails", input: "ともだちと", expected: "友達と" },
    CorpusCase { category: "particle_tails", input: "きょうから", expected: "今日から" },
    CorpusCase {
        category: "particle_tails", input: "やまださんより", expected: "山田さんより"
    },
    CorpusCase {
        category: "particle_tails", input: "としょかんへ", expected: "図書館へ"
    },
    CorpusCase { category: "particle_tails", input: "がくせいの", expected: "学生の" },
    CorpusCase { category: "particle_tails", input: "みずをのむ", expected: "水を飲む" },
    CorpusCase { category: "particle_tails", input: "ねこがねる", expected: "猫が寝る" },
    // -----------------------------------------------------------------------
    // Loanword + particle — katakana loanwords followed by a particle.
    // -----------------------------------------------------------------------
    CorpusCase { category: "loanword_particle", input: "すーぷが", expected: "スープが" },
    CorpusCase { category: "loanword_particle", input: "すーぷは", expected: "スープは" },
    CorpusCase { category: "loanword_particle", input: "でーたを", expected: "データを" },
    CorpusCase {
        category: "loanword_particle", input: "こーひーは", expected: "コーヒーは"
    },
    CorpusCase { category: "loanword_particle", input: "めーるで", expected: "メールで" },
    CorpusCase {
        category: "loanword_particle",
        input: "すーぷはのみたい",
        expected: "スープは飲みたい",
    },
    CorpusCase {
        category: "loanword_particle",
        input: "すーぷはたべたくない",
        expected: "スープは食べたくない",
    },
    CorpusCase {
        category: "loanword_particle",
        input: "すーぷはください",
        expected: "スープはください",
    },
    CorpusCase {
        category: "loanword_particle", input: "ぱそこんが", expected: "パソコンが"
    },
    CorpusCase { category: "loanword_particle", input: "かめらで", expected: "カメラで" },
    CorpusCase { category: "loanword_particle", input: "ほてるに", expected: "ホテルに" },
    // -----------------------------------------------------------------------
    // Fillers / interjections — hesitation sounds that must stay hiragana.
    //
    // These share the prolonged sound mark `ー` with loanwords above, but
    // their dictionary identity rows carry a non-default CID.  Converting the
    // leading mora (`絵ーっと`) or emitting a katakana fragment (`エーッと`)
    // is spurious, so the katakana-preferring guard must not reach them.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "fillers_interjections", input: "えーっと", expected: "えーっと"
    },
    CorpusCase { category: "fillers_interjections", input: "えーと", expected: "えーと" },
    CorpusCase { category: "fillers_interjections", input: "あのー", expected: "あのー" },
    CorpusCase { category: "fillers_interjections", input: "そのー", expected: "そのー" },
    CorpusCase { category: "fillers_interjections", input: "うーん", expected: "うーん" },
    // Loanword counterpart: the same prolonged mark must still convert, so an
    // over-broad relaxation of the guard fails here instead of passing quietly.
    CorpusCase { category: "fillers_interjections", input: "すーぷ", expected: "スープ" },
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
    CorpusCase { category: "single_mora_kanji", input: "き", expected: "木" },
    CorpusCase { category: "single_mora_kanji", input: "て", expected: "手" },
    // -----------------------------------------------------------------------
    // Numbers / counters — spoken numerals followed by counters.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "numbers_counters", input: "いち、に、さん", expected: "1、2、3"
    },
    CorpusCase { category: "numbers_counters", input: "ごねん", expected: "5年" },
    CorpusCase { category: "numbers_counters", input: "しがつ", expected: "4月" },
    CorpusCase { category: "numbers_counters", input: "じゅう、", expected: "10、" },
    CorpusCase { category: "numbers_counters", input: "さんにん", expected: "3人" },
    CorpusCase { category: "numbers_counters", input: "いちにち", expected: "1日" },
    CorpusCase { category: "numbers_counters", input: "ごふん", expected: "5分" },
    CorpusCase { category: "numbers_counters", input: "さんじ", expected: "3時" },
    CorpusCase { category: "numbers_counters", input: "よっか", expected: "4日" },
    CorpusCase { category: "numbers_counters", input: "さんびゃくえん", expected: "300円" },
    CorpusCase { category: "numbers_counters", input: "にせんえん", expected: "2000円" },
    // -----------------------------------------------------------------------
    // Dates / times — full date and time expressions.
    // -----------------------------------------------------------------------
    CorpusCase { category: "dates_times", input: "さんがつついたち", expected: "3月1日" },
    CorpusCase { category: "dates_times", input: "しちじはん", expected: "7時半" },
    CorpusCase { category: "dates_times", input: "じゅうじ", expected: "10時" },
    CorpusCase { category: "dates_times", input: "ごじはん", expected: "5時半" },
    CorpusCase { category: "dates_times", input: "しちがつ", expected: "7月" },
    CorpusCase { category: "dates_times", input: "じゅうがつ", expected: "10月" },
    // -----------------------------------------------------------------------
    // Common verbs and their inflections.
    // -----------------------------------------------------------------------
    CorpusCase { category: "verbs_inflections", input: "いきます", expected: "行きます" },
    CorpusCase { category: "verbs_inflections", input: "たべたい", expected: "食べたい" },
    CorpusCase { category: "verbs_inflections", input: "おもった", expected: "思った" },
    CorpusCase { category: "verbs_inflections", input: "おこなわ", expected: "行わ" },
    CorpusCase { category: "verbs_inflections", input: "つかった", expected: "使った" },
    CorpusCase { category: "verbs_inflections", input: "みている", expected: "見ている" },
    CorpusCase { category: "verbs_inflections", input: "きいて", expected: "聞いて" },
    CorpusCase { category: "verbs_inflections", input: "かいて", expected: "書いて" },
    CorpusCase { category: "verbs_inflections", input: "はしる", expected: "走る" },
    CorpusCase { category: "verbs_inflections", input: "おしえて", expected: "教えて" },
    CorpusCase {
        category: "verbs_inflections", input: "きをきって", expected: "木を切って"
    },
    CorpusCase {
        category: "verbs_inflections", input: "でんわをかける", expected: "電話をかける"
    },
    // -----------------------------------------------------------------------
    // Honorifics / polite expressions.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "honorifics", input: "おつかれさまです", expected: "お疲れ様です"
    },
    CorpusCase {
        category: "honorifics", input: "おつかれさまでした", expected: "お疲れ様でした"
    },
    CorpusCase {
        category: "honorifics",
        input: "よろしくおねがいします",
        expected: "よろしくお願いします",
    },
    CorpusCase {
        category: "honorifics", input: "いただきます", expected: "いただきます"
    },
    CorpusCase {
        category: "honorifics", input: "ごめんなさい", expected: "ごめんなさい"
    },
    CorpusCase {
        category: "honorifics",
        input: "ありがとうございます",
        expected: "ありがとうございます",
    },
    // -----------------------------------------------------------------------
    // Proper nouns — place names and common proper nouns.
    // -----------------------------------------------------------------------
    CorpusCase { category: "proper_nouns", input: "とうきょう", expected: "東京" },
    CorpusCase { category: "proper_nouns", input: "おおさか", expected: "大阪" },
    CorpusCase { category: "proper_nouns", input: "よこはま", expected: "横浜" },
    CorpusCase { category: "proper_nouns", input: "きょうと", expected: "京都" },
    CorpusCase { category: "proper_nouns", input: "ほっかいどう", expected: "北海道" },
    CorpusCase { category: "proper_nouns", input: "にほん", expected: "日本" },
    CorpusCase { category: "proper_nouns", input: "とうきょうえき", expected: "東京駅" },
    // -----------------------------------------------------------------------
    // Compound particles — の/で/と/へ + particle combinations.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "compound_particles", input: "としょかんでの", expected: "図書館での"
    },
    CorpusCase {
        category: "compound_particles", input: "ともだちとの", expected: "友達との"
    },
    CorpusCase { category: "compound_particles", input: "えきへの", expected: "駅への" },
    CorpusCase {
        category: "compound_particles", input: "がっこうでの", expected: "学校での"
    },
    CorpusCase {
        category: "compound_particles", input: "せんせいへの", expected: "先生への"
    },
    CorpusCase {
        category: "compound_particles", input: "かいしゃとの", expected: "会社との"
    },
    // -----------------------------------------------------------------------
    // Sentence-final forms — polite and plain endings.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "sentence_final", input: "たべるでしょう", expected: "食べるでしょう"
    },
    CorpusCase { category: "sentence_final", input: "はれます", expected: "晴れます" },
    CorpusCase {
        category: "sentence_final", input: "あめがふります", expected: "雨が降ります"
    },
    CorpusCase {
        category: "sentence_final",
        input: "きょうははれです",
        expected: "今日は晴れです",
    },
    CorpusCase {
        category: "sentence_final",
        input: "あしたははれるでしょう",
        expected: "明日は晴れるでしょう",
    },
    CorpusCase {
        category: "sentence_final", input: "ほんをよみます", expected: "本を読みます"
    },
    // -----------------------------------------------------------------------
    // Full sentences — realistic ASR caption output.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "full_sentences",
        input: "きょうのてんきはあつい",
        expected: "今日の天気は暑い",
    },
    CorpusCase {
        category: "full_sentences", input: "すーぷがあつい", expected: "スープが熱い"
    },
    CorpusCase {
        category: "full_sentences",
        input: "あついりょうりはおいしい",
        expected: "熱い料理は美味しい",
    },
    CorpusCase {
        category: "full_sentences",
        input: "わたしたちはがくせいです",
        expected: "私たちは学生です",
    },
    CorpusCase {
        category: "full_sentences",
        input: "かんじのしょりをかいぜん",
        expected: "漢字の処理を改善",
    },
    CorpusCase {
        category: "full_sentences",
        input: "おんりょうをちょうせい",
        expected: "音量を調整",
    },
    CorpusCase {
        category: "full_sentences",
        input: "しょうぼう、しょうか、ほのお",
        expected: "消防、消火、炎",
    },
    CorpusCase {
        category: "full_sentences",
        input: "かたち、こうし、もよう",
        expected: "形、格子、模様",
    },
    CorpusCase {
        category: "full_sentences",
        input: "せんそう、しんこう、しんりゃく",
        expected: "戦争、侵攻、侵略",
    },
    CorpusCase {
        category: "full_sentences",
        input: "かせん、かこう、かわべ",
        expected: "河川、河口、川辺",
    },
    CorpusCase {
        category: "full_sentences",
        input: "にゅうきん、しゅうし、かくにん",
        expected: "入金、収支、確認",
    },
    CorpusCase {
        category: "full_sentences",
        input: "もじ、かんじ、ぞくじ",
        expected: "文字、漢字、俗字",
    },
    CorpusCase {
        category: "full_sentences",
        input: "となりのきゃくはよくかきくうきゃくだ",
        expected: "隣の客は良くかきくう客だ",
    },
    CorpusCase {
        category: "full_sentences",
        input: "りょうりがあついのでさます",
        expected: "料理が暑いのでさます",
    },
    CorpusCase {
        category: "full_sentences",
        input: "きょうはとてもさむい",
        expected: "今日はとても寒い",
    },
    CorpusCase {
        category: "full_sentences",
        input: "すーぷはおいしい",
        expected: "スープは美味しい",
    },
    CorpusCase {
        category: "full_sentences", input: "すーぷはあつい", expected: "スープは熱い"
    },
    CorpusCase {
        category: "full_sentences",
        input: "おいしいすーぷは",
        expected: "美味しいスープは",
    },
    CorpusCase {
        category: "full_sentences",
        input: "あついすーぷはたべたくない",
        expected: "熱いスープは食べたくない",
    },
    CorpusCase {
        category: "full_sentences",
        input: "きょうははいしんです",
        expected: "今日は配信です",
    },
    CorpusCase {
        category: "full_sentences",
        input: "ほんじつはじかんの説明です",
        expected: "本日は時間の説明です",
    },
    CorpusCase { category: "full_sentences", input: "にほんご", expected: "日本語" },
    CorpusCase {
        category: "full_sentences",
        input: "おつかれさまでした",
        expected: "お疲れ様でした",
    },
    CorpusCase {
        category: "full_sentences", input: "とてもおいしい", expected: "とても美味しい"
    },
    CorpusCase {
        category: "full_sentences",
        input: "あしたははれるでしょう",
        expected: "明日は晴れるでしょう",
    },
    CorpusCase { category: "full_sentences", input: "けいさん", expected: "計算" },
    CorpusCase { category: "full_sentences", input: "そうじゅう", expected: "操縦" },
    CorpusCase { category: "full_sentences", input: "しけい", expected: "死刑" },
    CorpusCase { category: "full_sentences", input: "しじ", expected: "支持" },
    CorpusCase { category: "full_sentences", input: "よけい", expected: "余計" },
    CorpusCase {
        category: "full_sentences",
        input: "きょうははれです",
        expected: "今日は晴れです",
    },
    CorpusCase {
        category: "full_sentences",
        input: "あついりょうりはおいしい",
        expected: "熱い料理は美味しい",
    },
    CorpusCase {
        category: "full_sentences",
        input: "きょうははいしんです",
        expected: "今日は配信です",
    },
];

/// Cases that must convert exactly, not merely often enough.
///
/// `accuracy_corpus_report` only enforces an aggregate pass rate, so a
/// handful of broken cases can hide inside a healthy percentage.  These pairs
/// encode the two halves of one invariant and are asserted individually:
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
    ("ひな", "雛"),
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
fn accuracy_corpus_report() {
    let root = crate::dictionary::test_system_dictionary_path();
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");

    let mut category_stats: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut failures: Vec<(&CorpusCase, String)> = Vec::new();
    let mut total_passed = 0usize;

    for case in CORPUS {
        let candidate =
            convert_with_dictionary(case.input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next();

        let actual = candidate.as_ref().map(|candidate| candidate.text.as_str()).unwrap_or("");

        let passed = actual == case.expected;
        let (mut passed_count, mut total_count) =
            *category_stats.entry(case.category).or_insert((0, 0));
        total_count += 1;
        if passed {
            total_passed += 1;
            passed_count += 1;
        } else {
            failures.push((case, actual.to_string()));
        }
        category_stats.insert(case.category, (passed_count, total_count));
    }

    let total = CORPUS.len();
    let pass_rate = if total > 0 { total_passed as f32 / total as f32 } else { 0.0 };

    // Always print the full report so the numbers are visible with --nocapture.
    eprintln!();
    eprintln!("=== AzooKey Accuracy Corpus Report ===");
    eprintln!(
        "Total: {total} cases, {total_passed} passed, {} failed ({:.1}%)",
        total - total_passed,
        pass_rate * 100.0
    );
    eprintln!();
    eprintln!("Per-category:");
    for (category, (passed, total_cat)) in &category_stats {
        let rate = if *total_cat > 0 { *passed as f32 / *total_cat as f32 * 100.0 } else { 0.0 };
        eprintln!("  {category:<22} {passed:>2}/{total_cat:<2} ({rate:>5.1}%)");
    }
    eprintln!();
    if failures.is_empty() {
        eprintln!("Failures: none");
    } else {
        eprintln!("Failures:");
        for (case, actual) in &failures {
            eprintln!(
                "  [{}] {:?} -> expected {:?}, got {:?}",
                case.category, case.input, case.expected, actual
            );
        }
    }
    eprintln!();

    assert!(
        pass_rate >= MINIMUM_PASS_RATE,
        "accuracy corpus pass rate {pass_rate:.1}% is below the minimum {:.1}%",
        MINIMUM_PASS_RATE * 100.0,
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
