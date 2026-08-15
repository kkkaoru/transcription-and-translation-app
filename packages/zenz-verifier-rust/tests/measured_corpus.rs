#![cfg(feature = "candle")]

use candle_core::Device;
use caption_bridge_azookey_rust::{
    convert_with_dictionary, convert_with_verifier_with_limit, AzooKeyDictionary,
    ConversionOptions, DictionaryPaths, VerificationState, VerifierConversionOptions,
};
use caption_bridge_zenz_verifier::EmbeddedZenzDraftVerifier;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MODEL_REVISION: &str = "zenz-v3.2-small-gguf@c67e03e07d215c869f591b274c1631170d3e11fe";
const MAX_ITERATIONS: usize = 10;
const WORD_BOUNDARY_CATEGORY: &str = "completed_word_boundary_failures";

#[derive(Debug)]
struct MeasuredCase {
    case_id: &'static str,
    category: &'static str,
    input: &'static str,
    expected: &'static str,
    artificial_left_context: &'static str,
}

#[derive(Debug, Default)]
struct CategoryCount {
    total: usize,
    dictionary_passed: usize,
    hybrid_passed: usize,
}

fn measured_cases() -> Vec<MeasuredCase> {
    include_str!("../../azookey-rust/testdata/zenz_measured_completed.tsv")
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .skip(1)
        .map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            assert_eq!(columns.len(), 5, "invalid measured Zenz TSV row: {line:?}");
            MeasuredCase {
                case_id: columns[0],
                category: columns[1],
                input: columns[2],
                expected: columns[3],
                artificial_left_context: columns[4],
            }
        })
        .collect()
}

fn state_label(state: &VerificationState) -> &'static str {
    match state {
        VerificationState::Verified => "Verified",
        VerificationState::PrefixConstraintReturned => "PrefixConstraintReturned",
        VerificationState::Exhausted => "Exhausted",
        VerificationState::ExhaustedWithConstrainedCandidate => "ExhaustedWithConstrainedCandidate",
        VerificationState::ExhaustedWithDictionaryFallback => "ExhaustedWithDictionaryFallback",
        VerificationState::SkippedByPolicy => "SkippedByPolicy",
        VerificationState::DeadlineExceeded => "DeadlineExceeded",
        VerificationState::CapabilityUnavailable => "CapabilityUnavailable",
        VerificationState::Error => "Error",
        VerificationState::UnverifiedFallback => "UnverifiedFallback",
    }
}

#[test]
#[ignore = "requires ZENZ_V32_SMALL_GGUF; explicitly measures artificial-context corpus accuracy"]
fn measured_completed_corpus_reports_dictionary_and_embedded_verifier_accuracy() {
    let model_path = std::env::var("ZENZ_V32_SMALL_GGUF")
        .expect("ZENZ_V32_SMALL_GGUF must point to zenz-v3.2-small GGUF");
    let manifest_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let tokenizer_directory = manifest_directory
        .join("../../submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer");
    let dictionary_root =
        manifest_directory.join("../../submodules/azooKey_dictionary_storage/Dictionary");
    let dictionary = AzooKeyDictionary::from_paths(&DictionaryPaths {
        system: Some(dictionary_root),
        ..DictionaryPaths::default()
    })
    .expect("official AzooKey dictionary should load");
    let mut verifier = EmbeddedZenzDraftVerifier::load(
        Path::new(&model_path),
        &tokenizer_directory,
        MODEL_REVISION,
        &Device::Cpu,
    )
    .expect("embedded zenz-v3.2-small verifier should load");
    let cases = measured_cases();
    assert_eq!(cases.len(), 23);

    let mut category_counts: BTreeMap<&str, CategoryCount> = BTreeMap::new();
    let mut state_counts = BTreeMap::from([
        ("Verified", 0usize),
        ("PrefixConstraintReturned", 0),
        ("Exhausted", 0),
        ("ExhaustedWithConstrainedCandidate", 0),
        ("ExhaustedWithDictionaryFallback", 0),
        ("SkippedByPolicy", 0),
        ("DeadlineExceeded", 0),
        ("CapabilityUnavailable", 0),
        ("Error", 0),
        ("UnverifiedFallback", 0),
    ]);
    let mut dictionary_total = 0usize;
    let mut hybrid_total = 0usize;

    eprintln!(
        "case_id\tcategory\tdictionary_actual\tdictionary_pass\thybrid_actual\thybrid_pass\tstate\titerations"
    );
    for case in &cases {
        let dictionary_actual =
            convert_with_dictionary(case.input, &dictionary, ConversionOptions::default())
                .into_iter()
                .next()
                .map(|candidate| candidate.text)
                .unwrap_or_default();
        let result = convert_with_verifier_with_limit(
            case.input,
            &dictionary,
            ConversionOptions::default(),
            Some(&mut verifier),
            VerifierConversionOptions::new(MAX_ITERATIONS, "candle-greedy-v1")
                .with_left_context(case.artificial_left_context),
        );
        let dictionary_passed = dictionary_actual == case.expected;
        let hybrid_passed = result.text() == case.expected;
        dictionary_total += usize::from(dictionary_passed);
        hybrid_total += usize::from(hybrid_passed);
        let category = category_counts.entry(case.category).or_default();
        category.total += 1;
        category.dictionary_passed += usize::from(dictionary_passed);
        category.hybrid_passed += usize::from(hybrid_passed);
        *state_counts.entry(state_label(&result.verification_state)).or_default() += 1;
        eprintln!(
            "{}\t{}\t{:?}\t{}\t{:?}\t{}\t{}\t{}",
            case.case_id,
            case.category,
            dictionary_actual,
            dictionary_passed,
            result.text(),
            hybrid_passed,
            state_label(&result.verification_state),
            result.verification_iterations,
        );
    }

    eprintln!("Artificial-context strict accuracy by category:");
    for (category, count) in &category_counts {
        eprintln!(
            "  {category}: {}/{} dictionary -> {}/{} embedded verifier",
            count.dictionary_passed, count.total, count.hybrid_passed, count.total
        );
    }
    eprintln!(
        "Overall: {dictionary_total}/{} dictionary -> {hybrid_total}/{} embedded verifier",
        cases.len(),
        cases.len()
    );
    eprintln!("VerificationState counts (deadline disabled for accuracy ceiling):");
    for (state, count) in &state_counts {
        eprintln!("  {state}: {count}");
    }

    let word_boundary = category_counts
        .get(WORD_BOUNDARY_CATEGORY)
        .expect("word-boundary category should be present");
    assert_eq!(word_boundary.total, 7);
    assert_eq!(word_boundary.dictionary_passed, 0);
    assert_eq!(dictionary_total, 2);
    assert_eq!(state_counts["SkippedByPolicy"], 0);
    assert_eq!(state_counts["DeadlineExceeded"], 0);
}
