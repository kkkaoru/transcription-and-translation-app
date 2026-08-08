//! Compare filesystem (Tauri) vs portable (WASM) dictionaries on the same readings.
//!
//! ```sh
//! AZOOKEY_DICTIONARY_ROOT=submodules/azooKey_dictionary_storage/Dictionary \
//!   cargo run --release --example probe_portable_parity --manifest-path packages/azookey-rust/Cargo.toml
//! ```

use caption_bridge_azookey_rust::{
    convert_with_dictionary, AzooKeyDictionary, ConversionOptions, DictionaryPaths,
};
use std::{path::PathBuf, process::Command};

fn gunzip_file(path: &PathBuf) -> Vec<u8> {
    let output = Command::new("gzip")
        .args(["-dc", path.to_str().expect("utf8 path")])
        .output()
        .expect("gzip");
    assert!(output.status.success(), "gzip failed: {}", String::from_utf8_lossy(&output.stderr));
    output.stdout
}

fn top1(dictionary: &AzooKeyDictionary, input: &str) -> String {
    convert_with_dictionary(input, dictionary, ConversionOptions::default())
        .into_iter()
        .next()
        .map(|candidate| candidate.text)
        .unwrap_or_else(|| input.trim().to_string())
}

fn main() {
    let root =
        std::env::var_os("AZOOKEY_DICTIONARY_ROOT").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../submodules/azooKey_dictionary_storage/Dictionary")
        });
    let archive_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/cloudflare-worker-server/public/azookey/system.azkdict.gz");

    let filesystem = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(root),
        ..DictionaryPaths::default()
    })
    .expect("filesystem dictionary");
    let portable = AzooKeyDictionary::from_portable_system_dictionary(gunzip_file(&archive_path))
        .expect("portable dictionary");

    let cases: Vec<(&str, &str)> = vec![
        ("とても", "とても"),
        ("すーぷは", "スープは"),
        ("おつかれさまでした", "お疲れ様でした"),
        ("あしたのてんきははれ", "明日の天気は晴れ"),
        ("あさってのてんきはあめです", "明後日の天気は雨です"),
        ("しへい、こうか、じゅうえん", "紙幣、硬貨、10円"),
        ("いっとうしょう、けんしょう、おうぼ", "一等賞、懸賞、応募"),
        ("こうぎょう、きかく、とういつ", "工業、規格、統一"),
        ("きょうははいしんです", "今日は配信です"),
        ("きょうのてんきはあつい", "今日の天気は暑い"),
        ("すーぷがあつい", "スープが熱い"),
        ("あついりょうりはおいしい", "熱い料理は美味しい"),
        ("とうきょう", "東京"),
        ("よろしくおねがいします", "よろしくお願いします"),
        ("あしたははれるでしょう", "明日は晴れるでしょう"),
        ("みずをのむ", "水を飲む"),
        ("ほんをよみます", "本を読みます"),
        ("わたしたちはがくせいです", "私たちは学生です"),
        ("ごねん", "5年"),
        ("さんびゃくえん", "300円"),
        ("ぱそこん", "パソコン"),
        ("あいふぉん", "iPhone"),
        ("きりん", "キリン"),
        ("こんにちは", "こんにちは"),
        ("きょうははれです", "今日は晴れです"),
        ("となりのきゃくはよくかきくうきゃくだ", "隣の客は良くかきくう客だ"),
        ("かんじのしょりをかいぜん", "漢字の処理を改善"),
        ("てんきは", "天気は"),
        ("はれ", "晴れ"),
        ("あめです", "雨です"),
    ];

    let mut mismatch = 0usize;
    let mut fs_miss = 0usize;
    let mut portable_miss = 0usize;
    println!("input\tfilesystem\tportable\texpected\tparity");
    for (input, expected) in &cases {
        let fs = top1(&filesystem, input);
        let port = top1(&portable, input);
        let same = fs == port;
        if !same {
            mismatch += 1;
        }
        if fs != *expected {
            fs_miss += 1;
        }
        if port != *expected {
            portable_miss += 1;
        }
        if !same || fs != *expected || port != *expected {
            println!("{input}\t{fs}\t{port}\t{expected}\t{}", if same { "same" } else { "DIFF" });
        }
    }
    println!();
    println!(
        "cases={} filesystem_vs_expected_miss={} portable_vs_expected_miss={} fs_vs_portable_diff={}",
        cases.len(),
        fs_miss,
        portable_miss,
        mismatch
    );
}
