//! Adversarial conversion-accuracy corpus for the Rust AzooKey port.
//!
//! `accuracy_corpus.rs` is a regression guard: it is intentionally kept to
//! cases the converter already handles so a drop is always a real
//! regression. This module is the opposite instrument. It pulls a large,
//! independently-authored set of hard cases from two sources so the corpus
//! itself cannot be gamed by tuning against it:
//!
//! 1. `upstream_realistic` / `upstream_colloquial` / `upstream_homophones`
//!    are transcribed from AzooKeyKanaKanjiConverter's own
//!    `testAccuracy` / `testVerbalAccuracy` /
//!    `testMeaningBasedConversionAccuracy` suites
//!    (`submodules/AzooKeyKanaKanjiConverter/Tests/...ConverterTests.swift`).
//!    Notably, upstream itself only asserts `accuracy > 0.7` on these suites
//!    with its full N-gram model and much larger dictionary path table, so a
//!    100% pass rate here was never a realistic bar even for the reference
//!    implementation.
//! 2. The remaining categories are original cases written for this port,
//!    covering caption/ASR-specific shapes the upstream suites do not
//!    emphasize: particle tails after katakana loanwords, source text that
//!    already mixes katakana/kanji with hiragana, extended numeral+counter
//!    forms, sentence-final forms, honorifics, and long multi-clause
//!    compounds.
//!
//! Unlike `accuracy_corpus.rs`, this module does not gate on a fixed
//! minimum pass rate: its purpose is to keep the *real*, non-trivial
//! failure list visible so future dictionary/scoring work has honest
//! targets. Run with `--nocapture` to see the full breakdown.

use crate::{convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths};
use std::collections::BTreeMap;

struct CorpusCase {
    category: &'static str,
    input: &'static str,
    expected: &'static str,
}

const CORPUS: &[CorpusCase] = &[
    // -----------------------------------------------------------------------
    // Upstream realistic-utterance corpus (AzooKeyKanaKanjiConverter testAccuracy).
    // -----------------------------------------------------------------------
    CorpusCase { category: "upstream_realistic", input: "3がつ8にち", expected: "3月8日" },
    CorpusCase {
        category: "upstream_realistic",
        input: "いっていのわりあい",
        expected: "一定の割合",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "あいふぉんをこうにゅうする",
        expected: "iPhoneを購入する",
    },
    CorpusCase {
        category: "upstream_realistic", input: "それはくさ", expected: "それは草"
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "おにんぎょうさんみたいだね",
        expected: "お人形さんみたいだね",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "にほんごぶんぽうのけいしきりろん",
        expected: "日本語文法の形式理論",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ぷらすちっくをさくげんするひつようがある",
        expected: "プラスチックを削減する必要がある",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "きりんさんがすきです",
        expected: "キリンさんが好きです",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "しんらばんしょうをすべるかみとなる",
        expected: "森羅万象を統べる神となる",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "よねづけんしのしんきょく",
        expected: "米津玄師の新曲",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "へいろをけんしゅつするもんだい",
        expected: "閉路を検出する問題",
    },
    CorpusCase {
        category: "upstream_realistic", input: "それなすぎる", expected: "それなすぎる"
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "きたねえんだよやりかたが",
        expected: "汚ねえんだよやり方が",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "なにわらってんだよ",
        expected: "何笑ってんだよ",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "えもみがふかい",
        expected: "エモみが深い",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "とうごてきかなかんじへんかん",
        expected: "統語的かな漢字変換",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "あなたとふたりでいきをしていたい",
        expected: "あなたとふたりで息をしていたい",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "こんごきをつけます",
        expected: "今後気をつけます",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ごめいわくをおかけしてもうしわけありません",
        expected: "ご迷惑をおかけして申し訳ありません",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "どうぞよろしくおねがいいたします",
        expected: "どうぞよろしくお願いいたします",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "らいぶへんかんでにゅうりょくがかいてきです",
        expected: "ライブ変換で入力が快適です",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "にんちかがくがえがきだすにんげんのすがた",
        expected: "認知科学が描き出す人間の姿",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "せいしゃいんになりました",
        expected: "正社員になりました",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "しけんにでないえいたんご",
        expected: "試験に出ない英単語",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "あかるくげんきなせいかつ",
        expected: "明るく元気な生活",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "はるがきたのでかふんがつらい",
        expected: "春が来たので花粉が辛い",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "しょうぼうたいがひっしにかじをしょうかした",
        expected: "消防隊が必死に火事を消火した",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "たけとりものがたりはにほんのこてんぶんがくです",
        expected: "竹取物語は日本の古典文学です",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "よとうもやとうもでぃすればちゅうりつ",
        expected: "与党も野党もディスれば中立",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "だいすきなえしさん",
        expected: "大好きな絵師さん",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ぱいそんでかかれたそーすこーど",
        expected: "Pythonで書かれたソースコード",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "かんじょうなんてむだなもん",
        expected: "感情なんて無駄なもん",
    },
    CorpusCase {
        category: "upstream_realistic", input: "ひびをすごす", expected: "日々を過ごす"
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "あたらしいほんをかった",
        expected: "新しい本を買った",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "かれのはなしはおもしろい",
        expected: "彼の話は面白い",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ろーかるでうごかす",
        expected: "ローカルで動かす",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "よのなかにひつようなのはてすうりょうぜろのでんしけっさい",
        expected: "世の中に必要なのは手数料ゼロの電子決済",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "こんしゅうはとてもそーしゃる",
        expected: "今週はとてもソーシャル",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "でかすぎるそーすこーど",
        expected: "デカすぎるソースコード",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "らちがあかないんだよね",
        expected: "埒が明かないんだよね",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "まいなんばーかーどでじゅうみんひょうだせてべんり",
        expected: "マイナンバーカードで住民票出せて便利",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "でじたるかなんですか",
        expected: "デジタル化なんですか",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "じぶんのひとつしたのせだいがゆうしゅうすぎる",
        expected: "自分の一つ下の世代が優秀すぎる",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "みんなしごととごらくとべんきょうをぜんぶやってる",
        expected: "みんな仕事と娯楽と勉強を全部やってる",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ばいようにくたべてみたいね",
        expected: "培養肉食べてみたいね",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "おどらされははらすめんと",
        expected: "踊らされはハラスメント",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "じんじょうならびょういんにいくれべるのいたみ",
        expected: "尋常なら病院に行くレベルの痛み",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "ろぐいんぼーなすてきなしくみがきらい",
        expected: "ログインボーナス的な仕組みが嫌い",
    },
    CorpusCase {
        category: "upstream_realistic",
        input: "かいにいくのはおまえね",
        expected: "買いに行くのはお前ね",
    },
    // -----------------------------------------------------------------------
    // Upstream colloquial/verbal corpus (testVerbalAccuracy).
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "upstream_colloquial",
        input: "うわああああ、まじか",
        expected: "うわああああ、マジか",
    },
    CorpusCase { category: "upstream_colloquial", input: "は？", expected: "は？" },
    CorpusCase {
        category: "upstream_colloquial",
        input: "おまえなんなん",
        expected: "お前なんなん",
    },
    CorpusCase {
        category: "upstream_colloquial", input: "めっちゃくさ", expected: "めっちゃ草"
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "はやってんだなぁやっぱり",
        expected: "流行ってんだなぁやっぱり",
    },
    CorpusCase {
        category: "upstream_colloquial", input: "そっちかぁ", expected: "そっちかぁ"
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "かみすぎます…！",
        expected: "神すぎます…！",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "うおー、りかいした",
        expected: "うおー、理解した",
    },
    CorpusCase {
        category: "upstream_colloquial", input: "あ、なるほど", expected: "あ、なるほど"
    },
    CorpusCase { category: "upstream_colloquial", input: "あらま", expected: "あらま" },
    CorpusCase {
        category: "upstream_colloquial", input: "さすがやな…", expected: "流石やな…"
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "のれないんでしょうね。",
        expected: "乗れないんでしょうね。",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "おつかれさまですわら",
        expected: "お疲れ様です笑",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "よううれたのぉわらわら",
        expected: "よう売れたのぉ笑笑",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "わーそれはもう",
        expected: "わーそれはもう",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "よねんまえやで？？",
        expected: "4年前やで？？",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "おうしょうもいいなぁ",
        expected: "王将もいいなぁ",
    },
    CorpusCase {
        category: "upstream_colloquial", input: "それなすぎる", expected: "それなすぎる"
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "じじつなんでしゃーないです",
        expected: "事実なんでしゃーないです",
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "がんばりまーーーす！",
        expected: "がんばりまーーーす！",
    },
    CorpusCase {
        category: "upstream_colloquial", input: "うるさいよな", expected: "うるさいよな"
    },
    CorpusCase {
        category: "upstream_colloquial",
        input: "ほんとどゆことわらわら",
        expected: "ほんとどゆこと笑笑",
    },
    // -----------------------------------------------------------------------
    // Upstream homophone-disambiguation corpus (testMeaningBasedConversionAccuracy).
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "upstream_homophones",
        input: "いえき、しょうか、こうそ",
        expected: "胃液、消化、酵素",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "さいばん、こうそ、さいこうさい",
        expected: "裁判、控訴、最高裁",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "すいみん、こうそ、けんこう",
        expected: "睡眠、酵素、健康",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "そりゅうし、こうし、げんし",
        expected: "素粒子、光子、原子",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せんせい、こうし、じゅぎょう",
        expected: "先生、講師、授業",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けんり、こうし、ぎむ",
        expected: "権利、行使、義務",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じこ、しぼう、てんごく",
        expected: "事故、死亡、天国",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "とくほ、しぼう、ねんしょう",
        expected: "トクホ、脂肪、燃焼",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おんしゃ、しぼう、だいがく",
        expected: "御社、志望、大学",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しょくぶつ、しゅし、かふん",
        expected: "植物、種子、花粉",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぎろん、しゅし、ろんてん",
        expected: "議論、趣旨、論点",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんたい、しゅし、てさき",
        expected: "身体、手指、手先",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "とくしゃ、おんしゃ、しけい",
        expected: "特赦、恩赦、死刑",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かんじ、おんしゃ、ぶっきょう",
        expected: "漢字、音写、仏教",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅうでん、きしゃ、ていしゃ",
        expected: "終電、汽車、停車",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "はっぴょう、きしゃ、しつもん",
        expected: "発表、記者、質問",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がくぶ、しゅうし、はかせ",
        expected: "学部、修士、博士",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じかん、しゅうし、ふそく",
        expected: "時間、終始、不足",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ないかく、しじ、ていめい",
        expected: "内閣、支持、低迷",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じょうし、しじ、ぶか",
        expected: "上司、指示、部下",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "てんこう、きしょう、じょうほう",
        expected: "天候、気象、情報",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かれ、きしょう、りょうこう",
        expected: "彼、気性、良好",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "れあめたる、きしょう、じゅうよう",
        expected: "レアメタル、希少、重要",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "あさ、きしょう、しっぱい",
        expected: "朝、起床、失敗",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かみ、へんざい、ばんぶつ",
        expected: "神、遍在、万物",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "とみ、へんざい、けいざい",
        expected: "富、偏在、経済",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おうよう、きそ、はってん",
        expected: "応用、基礎、発展",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "たいほ、きそ、さいばん",
        expected: "逮捕、起訴、裁判",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じこ、ちめい、しぼう",
        expected: "事故、致命、死亡",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちず、ちめい、ちり",
        expected: "地図、地名、地理",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "なんべい、ちり、りょこう",
        expected: "南米、チリ、旅行",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "よごれ、ちり、そうじ",
        expected: "汚れ、塵、掃除",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちがく、ちり、べんきょう",
        expected: "地学、地理、勉強",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ごおん、ほうこう、ばくふ",
        expected: "御恩、奉公、幕府",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "なんせい、ほうこう、いどう",
        expected: "南西、方向、移動",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こうすい、ほうこう、におい",
        expected: "香水、芳香、匂い",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けもの、ほうこう、おたけび",
        expected: "獣、咆哮、雄叫び",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "つみ、りょうしん、かしゃく",
        expected: "罪、良心、呵責",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちち、りょうしん、はは",
        expected: "父、両親、母",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいじ、さんかく、みんしゅう",
        expected: "政治、参画、民衆",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "すうがく、さんかく、しかく",
        expected: "数学、三角、四角",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "さんかく、しかく、ろっかく",
        expected: "三角、四角、六角",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じゅけん、しかく、べんきょう",
        expected: "受験、資格、勉強",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちょうかく、しかく、きゅうかく",
        expected: "聴覚、視覚、嗅覚",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "あんさつ、しかく、すぱい",
        expected: "暗殺、刺客、スパイ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "どうろ、しかく、ちゅうい",
        expected: "道路、死角、注意",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいじ、かくしん、かくめい",
        expected: "政治、革新、革命",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅちょう、かくしん、ぎろん",
        expected: "主張、核心、議論",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいこう、かくしん、おうえん",
        expected: "成功、確信、応援",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいじ、せいとう、せんきょ",
        expected: "政治、政党、選挙",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいぎ、せいとう、だとう",
        expected: "正義、正当、妥当",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おうけ、せいとう、しょうめい",
        expected: "王家、正統、証明",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "てすと、せいとう、さいてん",
        expected: "テスト、正答、採点",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "くーでたー、せんきょ、ていこう",
        expected: "クーデター、占拠、抵抗",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かいさん、せんきょ、かいし",
        expected: "解散、選挙、開始",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "まつり、さいてん、えんにち",
        expected: "祭り、祭典、縁日",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "てすと、さいてん、まるつけ",
        expected: "テスト、採点、丸つけ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "やきゅう、しゅうきゅう、てにす",
        expected: "野球、蹴球、テニス",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かいしゃ、しゅうきゅう、ふつか",
        expected: "会社、週休、二日",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "きぶん、かんじ、きもち",
        expected: "気分、感じ、気持ち",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅさい、かんじ、のみかい",
        expected: "主催、幹事、飲み会",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぎろん、よち、ざんぞん",
        expected: "議論、余地、残存",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "よげん、よち、みらい",
        expected: "予言、予知、未来",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "もしゃ、せいぶつ、すけっち",
        expected: "模写、静物、スケッチ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "どうぶつ、せいぶつ、しよくぶつ",
        expected: "動物、生物、植物",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かんのうてき、せいてき、えろ",
        expected: "官能的、性的、エロ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "どうてき、せいてき、すたてぃっく",
        expected: "動的、静的、スタティック",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいじか、せいてき、さくりゃく",
        expected: "政治家、政敵、策略",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "えくせる、ちかん、けつごう",
        expected: "Excel、置換、結合",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "でんしゃ、ちかん、たいほ",
        expected: "電車、痴漢、逮捕",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ふぁんたじー、ようせい、どらごん",
        expected: "ファンタジー、妖精、ドラゴン",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ころな、ようせい、いんせい",
        expected: "コロナ、陽性、陰性",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じしゅく、ようせい、むし",
        expected: "自粛、要請、無視",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いじん、ようせい、わかさ",
        expected: "偉人、夭逝、若さ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いじめ、むし、ほうち",
        expected: "いじめ、無視、放置",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こんちゅう、むし、ようちゅう",
        expected: "昆虫、虫、幼虫",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けんぼう、かいせい、ろんぎ",
        expected: "憲法、改正、論議",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "みょうじ、かいせい、かいめい",
        expected: "苗字、改姓、改名",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ほんじつ、かいせい、てんき",
        expected: "本日、快晴、天気",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぶれーき、かいせい、えんじん",
        expected: "ブレーキ、回生、エンジン",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "なまえ、かいめい、てつづき",
        expected: "名前、改名、手続き",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けんきゅう、かいめい、ろんぶん",
        expected: "研究、解明、論文",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ごみ、ほうき、きんし",
        expected: "ゴミ、放棄、禁止",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "べんごし、ほうき、ほうりつ",
        expected: "弁護士、法規、法律",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "まじょ、ほうき、まほう",
        expected: "魔女、箒、魔法",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "みんしゅう、ほうき、かくめい",
        expected: "民衆、蜂起、革命",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こうじ、しこう、ごねん",
        expected: "工事、施工、5年",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんぽう、しこう、しがつ",
        expected: "新法、施行、4月",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "てつがく、しこう、ぎろん",
        expected: "哲学、思考、議論",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かくりつ、しこう、かいすう",
        expected: "確率、試行、回数",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "あじわい、しこう、わいん",
        expected: "味わい、嗜好、ワイン",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "たいほ、こうりゅう、さいばん",
        expected: "逮捕、勾留、裁判",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "でんげん、こうりゅう、ちょくりゅう",
        expected: "電源、交流、直流",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いでんし、ぶんか、きのう",
        expected: "遺伝子、分化、機能",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かがく、ぶんか、ぶんげい",
        expected: "科学、文化、文芸",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かがく、ゆうき、むき",
        expected: "化学、有機、無機",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いし、ゆうき、しんねん",
        expected: "意思、勇気、信念",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かわべ、いし、いわ",
        expected: "川辺、石、岩",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんねん、いし、しそう",
        expected: "信念、意思、思想",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "びょういん、いし、しんさつ",
        expected: "病院、医師、診察",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しかい、しんこう、こうえん",
        expected: "司会、進行、講演",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅうきょう、しんこう、しんねん",
        expected: "宗教、信仰、信念",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "きんねん、しんこう、しゅうきょう",
        expected: "近年、新興、宗教",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "びょういん、しかい、はいしゃ",
        expected: "病院、歯科医、歯医者",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "もや、しかい、あっか",
        expected: "モヤ、視界、悪化",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ばんぐみ、しかい、げいにん",
        expected: "番組、司会、芸人",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こども、こうえん、おにごっこ",
        expected: "子供、公園、鬼ごっこ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいじか、こうえん、しちょう",
        expected: "政治家、講演、視聴",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちけっと、こうえん、よやく",
        expected: "チケット、公演、予約",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "くるま、はいしゃ、すくらっぷ",
        expected: "車、廃車、スクラップ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "むしば、はいしゃ、ちりょう",
        expected: "虫歯、歯医者、治療",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こんてすと、はいしゃ、ふっかつ",
        expected: "コンテスト、敗者、復活",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "むりょう、はいしゃ、たくしー",
        expected: "無料、配車、タクシー",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じんせい、しょうがい、ろうねん",
        expected: "人生、生涯、老年",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちょうかく、しょうがい、ほじょ",
        expected: "聴覚、障害、補助",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぐんたい、ぶたい、ぜんめつ",
        expected: "軍隊、部隊、全滅",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "あいどる、ぶたい、おうえん",
        expected: "アイドル、舞台、応援",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けいざい、かぶ、げらく",
        expected: "経済、株、下落",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "やさい、かぶ、りょうり",
        expected: "野菜、カブ、料理",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぺーじ、かぶ、がぞう",
        expected: "ページ、下部、画像",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "きまつ、かだい、ていしゅつ",
        expected: "期末、課題、提出",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "のうりょく、かだい、ひょうか",
        expected: "能力、過大、評価",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんらばんしょうをすべるかみ",
        expected: "森羅万象を統べる神",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こおりをすべるすけーと",
        expected: "氷を滑るスケート",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おわらいをすべるげいにん",
        expected: "お笑いをスベる芸人",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ざっしにのるないよう",
        expected: "雑誌に載る内容",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "くるまにのるひと",
        expected: "車に乗る人",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "つなみ、てんさい、わざわい",
        expected: "津波、天災、災い",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "さいのう、てんさい、のうりょく",
        expected: "才能、天才、能力",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がぞう、てんさい、きょか",
        expected: "画像、転載、許可",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ひょうしき、きんし、かんばん",
        expected: "標識、禁止、看板",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こんたくと、きんし、ろうがん",
        expected: "コンタクト、近視、老眼",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいぶつ、きんし、ばくてりあ",
        expected: "生物、菌糸、バクテリア",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しょり、こうそく、はんてい",
        expected: "処理、高速、判定",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぶつり、こうそく、げんかい",
        expected: "物理、光速、限界",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんたい、こうそく、たいほ",
        expected: "身体、拘束、逮捕",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がっこう、こうそく、るーる",
        expected: "学校、校則、ルール",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しへい、こうか、じゅうえん",
        expected: "紙幣、硬貨、10円",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ねだん、こうか、かいとり",
        expected: "値段、高価、買取",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "くすり、こうか、けんしょう",
        expected: "薬、効果、検証",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "でんちゅう、こうか、かせん",
        expected: "電柱、高架、架線",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がっこう、こうか、がっしょう",
        expected: "学校、校歌、合唱",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぱらしゅーと、こうか、らっか",
        expected: "パラシュート、降下、落下",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がぞう、かこう、へんしゅう",
        expected: "画像、加工、編集",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じょうしょう、かこう、けんしょう",
        expected: "上昇、下降、減少",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かざん、かこう、ふんか",
        expected: "火山、火口、噴火",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いっとうしょう、けんしょう、おうぼ",
        expected: "一等賞、懸賞、応募",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かせつ、けんしょう、じっし",
        expected: "仮説、検証、実施",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けんぽう、けんしょう、じょうやく",
        expected: "憲法、憲章、条約",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じんこう、げんしょう、りゆう",
        expected: "人口、減少、理由",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かがく、げんしょう、けんきゅう",
        expected: "科学、現象、研究",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ないふ、きょうき、さつがい",
        expected: "ナイフ、凶器、殺害",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せいしん、きょうき、はっきょう",
        expected: "精神、狂気、発狂",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅうきょう、きょうぎ、きょうそ",
        expected: "宗教、教義、教祖",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "たいおう、きょうぎ、けんとう",
        expected: "対応、協議、検討",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "すぽーつ、きょうぎ、しょうぶ",
        expected: "スポーツ、競技、勝負",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じしょ、きょうぎ、いみ",
        expected: "辞書、狭義、意味",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じんじゃ、じしゃ、ぶっきよう",
        expected: "神社、寺社、仏教",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "へいしゃ、じしゃ、せいひん",
        expected: "弊社、自社、製品",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こうぎょう、きかく、とういつ",
        expected: "工業、規格、統一",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "いべんと、きかく、かいさい",
        expected: "イベント、企画、開催",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "めがさめたあさ",
        expected: "目が覚めた朝",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ねつがさめたりょうり",
        expected: "熱が冷めた料理",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "どうぶつがないたこえ。",
        expected: "動物が鳴いた声。",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かれがないたこえ。",
        expected: "彼が泣いた声。",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "だいこんがあついのでうすくきる",
        expected: "大根が厚いので薄く切る",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "へやがあついのですずしくする",
        expected: "部屋が暑いので涼しくする",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "みらい、こだい、げんだい",
        expected: "未来、古代、現代",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "せんでん、こだい、こうこく",
        expected: "宣伝、誇大、広告",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かじょう、せいさん、しゅうりょう",
        expected: "過剰、生産、終了",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "さんげき、せいさん、じけん",
        expected: "惨劇、凄惨、事件",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "けいひ、せいさん、れしーと",
        expected: "経費、生産、レシート",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しんぷ、せいしょく、きょうかい",
        expected: "神父、聖職、教会",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "こうび、せいしょく、しゅっさん",
        expected: "交尾、生殖、出産",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "やさいをきるほうちょう",
        expected: "野菜を切る包丁",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "きものをきるしゅみ",
        expected: "着物を着る趣味",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "さーびす、たいかい、てつづき",
        expected: "サービス、退会、手続き",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "はなび、たいかい、ゆかた",
        expected: "花火、大会、浴衣",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "しゅみ、はいかい、はいく",
        expected: "趣味、俳諧、俳句",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ろうじん、はいかい、にんちしょう",
        expected: "老人、徘徊、認知症",
    },
    CorpusCase {
        category: "upstream_homophones", input: "おやににたかお", expected: "親に似た顔"
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "じっくりにたにく",
        expected: "じっくり煮た肉",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ちりょう、なんこう、しゅじゅつ",
        expected: "治療、難航、手術",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ぬりぐすり、なんこう、ききめ",
        expected: "塗り薬、軟膏、効き目",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ようえき、ようかい、ようしつ",
        expected: "溶液、溶解、溶質",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おばけ、ようかい、ゆうれい",
        expected: "お化け、妖怪、幽霊",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "りょうち、りょうかい、りょうど",
        expected: "領地、領海、領土",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おーけー、りょうかい、しょうち",
        expected: "OK、了解、承知",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "がっこう、こうしょう、ばっじ",
        expected: "学校、校章、バッジ",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かいぎ、こうしょう、しっぱい",
        expected: "会議、交渉、失敗",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "ようちえん、ようじ、よういく",
        expected: "幼稚園、幼児、養育",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "きんきゅう、ようじ、きたく",
        expected: "緊急、用事、帰宅",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "おやぶん、こぶん",
        expected: "親分、子分",
    },
    CorpusCase {
        category: "upstream_homophones",
        input: "かんぶん、こぶん",
        expected: "漢文、古文",
    },
    // -----------------------------------------------------------------------
    // Particle tails after katakana loanwords not already covered.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "katakana_particle_tails", input: "ぱそこんが", expected: "パソコンが"
    },
    CorpusCase {
        category: "katakana_particle_tails", input: "たくしーで", expected: "タクシーで"
    },
    CorpusCase {
        category: "katakana_particle_tails", input: "めにゅーを", expected: "メニューを"
    },
    CorpusCase {
        category: "katakana_particle_tails", input: "さーびすは", expected: "サービスは"
    },
    CorpusCase {
        category: "katakana_particle_tails",
        input: "いんたーねっとが",
        expected: "インターネットが",
    },
    CorpusCase {
        category: "katakana_particle_tails",
        input: "すまーとふぉんを",
        expected: "スマートフォンを",
    },
    CorpusCase {
        category: "katakana_particle_tails", input: "かめらで", expected: "カメラで"
    },
    CorpusCase {
        category: "katakana_particle_tails", input: "ほてるに", expected: "ホテルに"
    },
    CorpusCase {
        category: "katakana_particle_tails",
        input: "えれべーたーで",
        expected: "エレベーターで",
    },
    CorpusCase {
        category: "katakana_particle_tails",
        input: "すけじゅーるを",
        expected: "スケジュールを",
    },
    // -----------------------------------------------------------------------
    // Mixed katakana/kanji source input with adjacent hiragana to convert.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "mixed_katakana_kanji_input",
        input: "東京えきへいきます",
        expected: "東京駅へ行きます",
    },
    CorpusCase {
        category: "mixed_katakana_kanji_input",
        input: "パソコンをつかう",
        expected: "パソコンを使う",
    },
    CorpusCase {
        category: "mixed_katakana_kanji_input",
        input: "友達とあそぶ",
        expected: "友達と遊ぶ",
    },
    CorpusCase {
        category: "mixed_katakana_kanji_input",
        input: "スープがあつくなる",
        expected: "スープが熱くなる",
    },
    CorpusCase {
        category: "mixed_katakana_kanji_input",
        input: "会社にちこくする",
        expected: "会社に遅刻する",
    },
    // -----------------------------------------------------------------------
    // Additional numeral + counter combinations.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "numbers_counters_extended", input: "ひゃくえん", expected: "100円"
    },
    CorpusCase {
        category: "numbers_counters_extended",
        input: "せんにひゃくえん",
        expected: "1200円",
    },
    CorpusCase {
        category: "numbers_counters_extended", input: "だいにかい", expected: "第2回"
    },
    CorpusCase {
        category: "numbers_counters_extended", input: "ろくじゅっさい", expected: "60歳"
    },
    CorpusCase {
        category: "numbers_counters_extended",
        input: "はちがつじゅうごにち",
        expected: "8月15日",
    },
    CorpusCase {
        category: "numbers_counters_extended",
        input: "にせんにじゅうねん",
        expected: "2020年",
    },
    CorpusCase {
        category: "numbers_counters_extended",
        input: "じゅっぷんかん",
        expected: "10分間",
    },
    CorpusCase {
        category: "numbers_counters_extended",
        input: "よんじゅうごふん",
        expected: "45分",
    },
    // -----------------------------------------------------------------------
    // Additional sentence-final forms.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "sentence_final_extended",
        input: "いきたいとおもいます",
        expected: "行きたいと思います",
    },
    CorpusCase {
        category: "sentence_final_extended",
        input: "たべたことがあります",
        expected: "食べたことがあります",
    },
    CorpusCase {
        category: "sentence_final_extended",
        input: "みなさんこんにちは",
        expected: "皆さんこんにちは",
    },
    CorpusCase {
        category: "sentence_final_extended",
        input: "かんがえておきます",
        expected: "考えておきます",
    },
    CorpusCase {
        category: "sentence_final_extended",
        input: "つづけていきましょう",
        expected: "続けていきましょう",
    },
    // -----------------------------------------------------------------------
    // Additional honorific / polite expressions.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "honorifics_extended", input: "しつれいします", expected: "失礼します"
    },
    CorpusCase {
        category: "honorifics_extended",
        input: "おせわになりました",
        expected: "お世話になりました",
    },
    CorpusCase {
        category: "honorifics_extended",
        input: "しょうちいたしました",
        expected: "承知いたしました",
    },
    CorpusCase {
        category: "honorifics_extended",
        input: "かしこまりました",
        expected: "かしこまりました",
    },
    CorpusCase {
        category: "honorifics_extended",
        input: "おまたせしました",
        expected: "お待たせしました",
    },
    // -----------------------------------------------------------------------
    // Long multi-clause compounds resembling real captions.
    // -----------------------------------------------------------------------
    CorpusCase {
        category: "long_compounds",
        input: "にほんごしょりのせいどをこうじょうさせる",
        expected: "日本語処理の精度を向上させる",
    },
    CorpusCase {
        category: "long_compounds",
        input: "じんこうちのうのはってんについてはなします",
        expected: "人工知能の発展について話します",
    },
    CorpusCase {
        category: "long_compounds",
        input: "かいぎのしりょうをじゅんびしておきます",
        expected: "会議の資料を準備しておきます",
    },
    CorpusCase {
        category: "long_compounds",
        input: "あたらしいきのうをついかしました",
        expected: "新しい機能を追加しました",
    },
];

#[test]
fn adversarial_corpus_report() {
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

    eprintln!();
    eprintln!("=== AzooKey Adversarial Corpus Report ===");
    eprintln!(
        "Total: {total} cases, {total_passed} passed, {} failed ({:.1}%)",
        total - total_passed,
        pass_rate * 100.0
    );
    eprintln!();
    eprintln!("Per-category:");
    for (category, (passed, total_cat)) in &category_stats {
        let rate = if *total_cat > 0 { *passed as f32 / *total_cat as f32 * 100.0 } else { 0.0 };
        eprintln!("  {category:<22} {passed:>3}/{total_cat:<3} ({rate:>5.1}%)");
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

    // Intentionally no pass-rate assertion: see module docs. This test
    // exists to keep the honest failure list visible, not to gate CI on a
    // number that could be trivially inflated by pruning hard cases.
}
