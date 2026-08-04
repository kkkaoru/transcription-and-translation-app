//! Compares each trie's stored distinct-continuation count against the number
//! of continuations actually present in the count trie.
//!
//! Kneser-Ney only sums to exactly 1 when `u_abx(ab)` equals the number of `w`
//! with `c(abw) > 0`. If the shipped tries were pruned, the stored count is the
//! larger of the two and the interpolation weight is correspondingly too big —
//! which would explain a total slightly above 1 without implying a port error.
//!
//! ```sh
//! cargo run --release --features rsmarisa --example check_consistency -- \
//!   ~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm
//! ```

use caption_bridge_input_lm::codec::{decode_key, KEY_VALUE_DELIMITER};
use caption_bridge_input_lm::marisa::MarisaTrie;
use caption_bridge_input_lm::model::{lookup_continuations, lookup_value};
use caption_bridge_input_lm::NgramTrie;

const VOCAB: usize = 6000;

fn open(base: &str, suffix: &str) -> MarisaTrie {
    MarisaTrie::open(format!("{base}{suffix}.marisa")).expect("open trie")
}

fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: check_consistency <trie-base-path>");
        std::process::exit(2);
    });

    let c_abc = open(&base, "_c_abc");
    let u_abx = open(&base, "_u_abx");

    // Pull real 4-token contexts out of the count trie.
    let samples = c_abc.predictive_search(&[]);
    println!("c_abc has {} entries", samples.len());

    let mut agree = 0usize;
    let mut stored_bigger = 0usize;
    let mut stored_smaller = 0usize;
    let mut inspected = 0usize;

    for entry in samples.iter().step_by(9_973).take(40) {
        // Key digits are the non-negative run before the value delimiter.
        let Some(kv) = entry.iter().position(|&d| d == KEY_VALUE_DELIMITER) else {
            continue;
        };
        let digits: Vec<i8> = entry[..kv].iter().copied().filter(|&d| d >= 0).collect();
        if digits.len() < 4 || !digits.len().is_multiple_of(2) {
            continue;
        }
        let tokens: Vec<usize> =
            digits.chunks_exact(2).map(|pair| decode_key(pair[0], pair[1])).collect();
        let context = &tokens[..tokens.len() - 1];

        let (counts, _sum) = lookup_continuations(&c_abc, context, VOCAB);
        let present = counts.iter().filter(|&&c| c > 0).count();
        let stored = lookup_value(&u_abx, context) as usize;

        inspected += 1;
        match stored.cmp(&present) {
            std::cmp::Ordering::Equal => agree += 1,
            std::cmp::Ordering::Greater => {
                stored_bigger += 1;
                if stored_bigger <= 5 {
                    println!("  context {context:?}: stored u_abx={stored} present={present}");
                }
            }
            std::cmp::Ordering::Less => stored_smaller += 1,
        }
    }

    println!(
        "inspected={inspected} agree={agree} stored>present={stored_bigger} \
         stored<present={stored_smaller}"
    );
}
