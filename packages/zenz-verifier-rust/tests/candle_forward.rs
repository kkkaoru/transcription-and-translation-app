#![cfg(feature = "candle")]

use candle_core::{Device, IndexOp};
use caption_bridge_zenz_verifier::ZenzForwardModel;
use std::path::Path;

// BOS + EE00 + トウキョウ + EE01 + 東京, measured with the shared tokenizer.
const TOKYO_EVALUATION_IDS: &[u32] =
    &[2, 172, 120, 202, 274, 400, 436, 504, 400, 172, 120, 203, 622, 738];
const TOKYO_PROMPT_LENGTH: usize = 12;
const TOKYO_CANDIDATE_IDS: &[usize] = &[622, 738];
#[test]
#[ignore = "requires ZENZ_V32_SMALL_GGUF; run this test explicitly with --ignored"]
fn small_gguf_keeps_untied_weights_and_verifies_tokyo() {
    let model_path = std::env::var("ZENZ_V32_SMALL_GGUF")
        .expect("ZENZ_V32_SMALL_GGUF must point to zenz-v3.2-small GGUF");
    let model = ZenzForwardModel::load(Path::new(&model_path), &Device::Cpu)
        .expect("zenz-v3.2-small GGUF should load");
    let manifest = model.manifest();
    assert_eq!(manifest.block_count, 12);
    assert_eq!(manifest.embedding_length, 768);
    assert_eq!(manifest.head_count, 12);
    assert_eq!(manifest.feed_forward_length, 3072);
    assert!((manifest.layer_norm_epsilon - 1e-5).abs() < 1e-10);
    assert_eq!(manifest.token_embedding_dtype, "Q5K");
    assert_eq!(manifest.output_projection_dtype, "Q6K");
    assert_ne!(
        manifest.token_embedding_dtype, manifest.output_projection_dtype,
        "the Q6_K output projection must never be tied to the Q5_K token embedding"
    );

    let logits = model.forward(TOKYO_EVALUATION_IDS).expect("Candle forward should succeed");
    assert_eq!(
        logits.dims2().expect("forward output should be a matrix"),
        (TOKYO_EVALUATION_IDS.len(), manifest.vocabulary_size)
    );
    let mut predicted = Vec::with_capacity(TOKYO_CANDIDATE_IDS.len());
    for offset in 0..TOKYO_CANDIDATE_IDS.len() {
        let row = logits
            .i(TOKYO_PROMPT_LENGTH + offset - 1)
            .expect("candidate prediction position should exist")
            .to_vec1::<f32>()
            .expect("logit row should be f32");
        let token = row
            .iter()
            .copied()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(token, _)| token)
            .expect("vocabulary must not be empty");
        predicted.push(token);
    }
    assert_eq!(
        predicted, TOKYO_CANDIDATE_IDS,
        "zenz-v3.2-small must verify 東京 for the reading トウキョウ"
    );
}
