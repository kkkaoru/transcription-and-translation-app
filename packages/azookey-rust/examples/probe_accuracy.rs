//! Fast dev probe: load the real dictionary once and report the top candidates
//! for a set of readings. Lets scoring hypotheses be tested in seconds instead
//! of the ~12-minute full-corpus run.
//!
//! Run with:
//! ```sh
//! AZOOKEY_DICTIONARY_ROOT=../../submodules/azooKey_dictionary_storage/Dictionary \
//!   cargo run --example probe_accuracy --manifest-path packages/azookey-rust/Cargo.toml [input...]
//! ```

use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};

fn main() {
    let root =
        std::env::var_os("AZOOKEY_DICTIONARY_ROOT").map(std::path::PathBuf::from).unwrap_or_else(
            || std::path::PathBuf::from("../../submodules/azooKey_dictionary_storage/Dictionary"),
        );
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("dictionary should load");

    let args: Vec<String> = std::env::args().skip(1).collect();
    let inputs: Vec<String> = if args.is_empty() {
        vec![
            "ぱそこん".into(),
            "ぱそこんが".into(),
            "きりん".into(),
            "きりんさんがすきです".into(),
            "あいふぉん".into(),
            "ぷらすちっく".into(),
            "ぱいそん".into(),
            "まじ".into(),
            "まじか".into(),
            "とくほ".into(),
            "れあめたる".into(),
            "こんてすと".into(),
            "あいどる".into(),
            "ちけっと".into(),
            "すぽーつ".into(),
            "ないふ".into(),
            "いべんと".into(),
            "さーびす".into(),
            "きしょう".into(),
            "とうごてきかなかんじへんかん".into(),
        ]
    } else {
        args
    };

    for input in inputs {
        let candidates =
            convert_with_dictionary(input.trim(), &dictionary, ConversionOptions::default());
        let top = candidates
            .iter()
            .take(3)
            .map(|c| format!("{}({:.1})", c.text, c.score))
            .collect::<Vec<_>>()
            .join(" | ");
        println!("{:?} -> {}", input, top);
    }
}
