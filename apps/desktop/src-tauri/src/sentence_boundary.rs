//! Desktop re-export of shared caption sentence paging.
//!
//! Implementation lives in `caption-bridge-vibrato-core`. Real IPADIC paging
//! tests stay here so they can load the bundled dictionary.

pub use caption_bridge_vibrato_core::sentence_boundary::{
    heuristic_sentence_end_offsets, heuristic_soft_break_offsets, visible_caption_sentence,
};

#[cfg(test)]
mod tests {
    use super::visible_caption_sentence;

    #[test]
    fn real_ipadic_pages_messy_live_speech() {
        let reader = crate::vibrato_runtime::try_default()
            .expect("bundled IPADIC system.dic.zst must be available");
        let cases: &[(&str, &str, &str)] = &[
            ("clean copula then next topic", "今日は晴れです明日は雨", "明日は雨"),
            ("punctuated pair", "今日は晴れです。明日は雨です。", "明日は雨です。"),
            ("adjective + time topic", "今日は寒い明日は", "明日は"),
            ("よ then 今日は", "行きましたよ今日は", "今日は"),
            ("ですね今日は", "ですね今日は", "今日は"),
            ("rain then tomorrow topic", "雨が降る明日は晴れ", "明日は晴れ"),
            ("filler then incomplete topic stays open", "えー今日は", "えー今日は"),
            ("case particle mid-utterance stays open", "となりのきゃくは", "となりのきゃくは"),
            ("te-form stays open", "ちょっと待って", "ちょっと待って"),
            ("desu ga continuation stays open", "晴れですが寒い", "晴れですが寒い"),
            ("terminal noun-stop", "明日は雨", "明日は雨"),
            ("kana-only ASR copula", "きょうははれですあしたはあめ", "あしたはあめ"),
        ];

        for (label, text, expected_visible) in cases {
            let offsets = reader.sentence_end_offsets(text);
            let visible = visible_caption_sentence(text, false, Some(offsets.as_slice()));
            assert_eq!(
                visible,
                *expected_visible,
                "{label}: text={text:?} tokens={:?} offsets={offsets:?}",
                reader.tokenize(text)
            );
        }
    }

    #[test]
    fn real_ipadic_does_not_make_awkward_splits() {
        let reader = crate::vibrato_runtime::try_default()
            .expect("bundled IPADIC system.dic.zst must be available");
        let cases: &[&str] = &[
            "走る人だ",
            "寒い日だった",
            "できる人",
            "見た人は",
            "食べた後",
            "行ったこと",
            "少なくない人",
            "行きたいところ",
            "思うんだけど",
            "だったら行く",
            "でしたらお願いします",
            "ですからね",
            "ですら知らない",
            "ましたら連絡します",
            "うん今日行く",
            "行きましたよ次",
            "もう走る次いく",
            "学生です田中さん",
            "ありがとうございます次",
            "見たよあの人",
        ];
        for text in cases {
            let offsets = reader.sentence_end_offsets(text);
            let visible = visible_caption_sentence(text, false, Some(offsets.as_slice()));
            assert_eq!(
                visible,
                *text,
                "awkward split: text={text:?} tokens={:?} offsets={offsets:?}",
                reader.tokenize(text)
            );
        }
    }

    #[test]
    fn caption_boundary_offsets_matches_sentence_and_soft_helpers() {
        let reader = crate::vibrato_runtime::try_default()
            .expect("bundled IPADIC system.dic.zst must be available");
        let text = "今日は晴れです明日は雨";
        let bounds = reader.caption_boundary_offsets(text);
        assert_eq!(bounds.sentence_ends, reader.sentence_end_offsets(text));
        assert_eq!(bounds.soft_breaks, reader.soft_break_offsets(text));
        assert!(!bounds.tokens.is_empty());
        assert!(
            bounds.sentence_ends.contains(&7),
            "です should close before 明日は: {:?}",
            bounds.sentence_ends
        );
    }
}
