use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};

fn main() {
    let samples = [
        "とても",
        "とてもおいしい",
        "すーぷは",
        "は",
        "すーぷ",
        "きょうは",
        "てんきは",
        "あついすーぷは",
        "おいしいすーぷは",
        "あついすーぷはたべたくない",
        "きょうはとてもさむい",
        "と",
        "とて",
        "とてもお",
        "すーぷはおいしい",
    ];
    let dictionary =
        AzooKeyDictionary::from_paths(&DictionaryPaths::default()).expect("dictionary should load");
    for s in samples {
        let candidates = convert_with_dictionary(s, &dictionary, ConversionOptions::default());
        println!("{s:?}:");
        for (rank, candidate) in candidates.iter().take(10).enumerate() {
            println!(
                "  {:>2}. {:?} score={:.3} trailing={:?}",
                rank + 1,
                candidate.text,
                candidate.score,
                candidate.trailing
            );
        }
    }
}
