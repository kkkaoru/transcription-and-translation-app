//! Dumps raw entries from a MARISA trie so the on-disk layout can be compared
//! against what [`caption_bridge_input_lm::codec`] produces.
//!
//! ```sh
//! cargo run --release --features rsmarisa --example dump_keys -- \
//!   ~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm_c_abc.marisa
//! ```

use caption_bridge_input_lm::codec::{decode_key, decode_value};
use caption_bridge_input_lm::marisa::MarisaTrie;
use caption_bridge_input_lm::NgramTrie;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: dump_keys <trie.marisa>");
        std::process::exit(2);
    });

    let trie = match MarisaTrie::open(&path) {
        Ok(trie) => trie,
        Err(error) => {
            eprintln!("failed to open {path}: {error}");
            std::process::exit(1);
        }
    };
    println!("{path}: {} keys", trie.num_keys());

    // An empty prefix matches every key; take the first handful.
    let entries = trie.predictive_search(&[]);
    println!("empty-prefix search returned {} entries", entries.len());

    for entry in entries.iter().take(8) {
        let digits: Vec<i32> = entry.iter().map(|&d| i32::from(d)).collect();
        println!("  raw={digits:?}");
        if entry.len() >= 7 {
            println!(
                "    as token+value: token={:?} value={:?}",
                decode_key(entry[0], entry[1]),
                decode_value(&entry[3..])
            );
        }
    }
}
