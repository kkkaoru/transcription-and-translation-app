#![cfg(feature = "candle")]

use candle_core::{Device, IndexOp};
use caption_bridge_azookey_rust::{
    CandidatePath, Draft, DraftVerifier, SessionContext, VerificationState,
};
use caption_bridge_zenz_verifier::EmbeddedZenzDraftVerifier;
use std::path::{Path, PathBuf};

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
    let tokenizer_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer");
    let mut verifier = EmbeddedZenzDraftVerifier::load(
        Path::new(&model_path),
        &tokenizer_directory,
        "zenz-v3.2-small-gguf@c67e03e07d215c869f591b274c1631170d3e11fe",
        &Device::Cpu,
    )
    .expect("zenz-v3.2-small verifier should load");
    let capabilities = verifier.capabilities();
    assert!(capabilities.prefix_constraints);
    assert!(!capabilities.session_kv);
    assert!(capabilities.right_context);
    assert_eq!(capabilities.max_candidates, 1);
    assert!(verifier.load_elapsed().as_nanos() > 0);
    let manifest = verifier.model().manifest();
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

    let logits =
        verifier.model().forward(TOKYO_EVALUATION_IDS).expect("Candle forward should succeed");
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

    // Activation policy belongs to the caller. Even without left context, an
    // explicitly opened verifier session evaluates rather than self-skipping.
    let mut session = verifier
        .open_session(SessionContext::new("とうきょう", 1, "candle-greedy-v1"))
        .expect("session should open");
    let candidate_path = |text: &str| CandidatePath {
        edge_handles: Vec::new(),
        text: text.to_string(),
        score: 0.0,
        trailing: None,
    };
    let rejected = verifier
        .evaluate(&mut session, &Draft::new("とうきょう", candidate_path("トウキョウ")))
        .expect("kana-echo candidate evaluation should succeed");
    assert_eq!(rejected.state, VerificationState::PrefixConstraintReturned);
    let constraint =
        rejected.prefix_constraint.expect("a rejected candidate should return a prefix constraint");
    assert_eq!(constraint.prefix, "東".as_bytes());

    let mut corrected = Draft::new("とうきょう", candidate_path("東京"));
    corrected.constraints.push(constraint);
    let verified = verifier
        .evaluate(&mut session, &corrected)
        .expect("corrected candidate evaluation should succeed");
    assert_eq!(verified.state, VerificationState::Verified);
    assert_eq!(verified.prefix_constraint, None);
    verifier.close_session(session).expect("session should close");
}
