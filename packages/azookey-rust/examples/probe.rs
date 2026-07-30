use caption_bridge_azookey_rust::convert_kana_to_kanji;

fn main() {
    let samples = [
        "きょうははいしんです",
        "にほんご",
        "おんせい",
        "わたしはがくせいです",
        "これはてすとです",
        "こんにちはせかい",
        "ほんじつはじかんの説明です",
        "きょうはいいてんきです",
        "カタカナ",
        "　きょう　",
        "今日ははいしんです",
        "１２３",
    ];
    for s in samples {
        println!("{:?} -> {:?}", s, convert_kana_to_kanji(s));
    }
}
