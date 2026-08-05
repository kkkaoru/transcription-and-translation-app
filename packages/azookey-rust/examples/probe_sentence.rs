use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};
use std::path::PathBuf;

fn main() {
    let root = std::env::var_os("AZOOKEY_DICTIONARY_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../submodules/azooKey_dictionary_storage/Dictionary"));
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("dictionary should load");

    let cases: &[&str] = &[
        "にほんご",
        "にほんごしょり",
        "にほんごしょりのせいどをこうじょうさせる",
        "すべる",
        "しんらばんしょうをすべるかみとなる",
    ];
    for input in cases {
        let results = convert_with_dictionary(input, &dictionary, ConversionOptions { n_best: 5, ..ConversionOptions::default() });
        println!("=== {:?} ===", input);
        for (i, c) in results.iter().enumerate() {
            println!("  {}. score={:.3} text={:?}", i+1, c.score, c.text);
        }
    }
}
