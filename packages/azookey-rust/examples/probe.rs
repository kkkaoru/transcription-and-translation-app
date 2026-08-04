use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};

fn main() {
    let cli = std::env::args().skip(1).collect::<Vec<_>>();
    let samples: Vec<String> = if cli.is_empty() {
        [
            "とても",
            "とてもおいしい",
            "すーぷは",
            "すーぷはください",
            "すーぷはのみたい",
            "は",
            "すーぷ",
            "きょうは",
            "てんきは",
            "あついすーぷは",
            "おいしいすーぷは",
            "あついすーぷはたべたくない",
            "きょうはとてもさむい",
            "すーぷはおいしい",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    } else {
        cli
    };
    let dictionary =
        AzooKeyDictionary::from_paths(&DictionaryPaths::default()).expect("dictionary should load");
    for s in samples {
        let candidates = convert_with_dictionary(&s, &dictionary, ConversionOptions::default());
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
