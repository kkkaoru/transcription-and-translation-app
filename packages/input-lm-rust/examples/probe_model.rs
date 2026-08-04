//! Reads the real `input_n5_lm_v1` tries and sanity-checks the port.
//!
//! ```sh
//! cargo run --release --features rsmarisa --example probe_model -- \
//!   ~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm
//! ```
//!
//! The strongest signal here is that each distribution sums to 1: Kneser-Ney is
//! a proper probability distribution, so a mis-ported discount or back-off
//! weight shows up immediately as a total that drifts off 1.0.

fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: probe_model <trie-base-path>");
        std::process::exit(2);
    });

    let params = caption_bridge_input_lm::NgramParams::default();
    let model = match caption_bridge_input_lm::marisa::open_model(&base, params) {
        Ok(model) => model,
        Err(error) => {
            eprintln!("failed to open tries at {base}: {error}");
            std::process::exit(1);
        }
    };

    println!("params: {params:?}");

    for context in [
        vec![],
        vec![params.start_token_id],
        vec![259usize, 11, 4],
        vec![280, 330, 367, 279],
        vec![280, 330, 450],
    ] {
        let probabilities = model.bulk_predict(&context);
        let total: f64 = probabilities.iter().sum();

        let mut ranked: Vec<(usize, f64)> = probabilities.iter().copied().enumerate().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let top: Vec<String> =
            ranked.iter().take(5).map(|(id, p)| format!("{id}:{p:.5}")).collect();

        let uniform = 1.0 / params.vocab_size as f64;
        let peaked = ranked[0].1 > uniform * 2.0;

        println!("context {context:?}\n  sum={total:.9} peaked={peaked} top5=[{}]", top.join(" "));
    }
}
