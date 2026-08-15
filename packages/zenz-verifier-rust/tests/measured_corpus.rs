#![cfg(feature = "candle")]

use candle_core::{Device, IndexOp};
use caption_bridge_azookey_rust::{
    convert_with_dictionary, convert_with_verifier_with_limit, AzooKeyDictionary,
    ConversionOptions, DictionaryPaths, Draft, DraftVerifier, SessionContext,
    Utf8BytePrefixConstraint, VerificationCacheKey, VerificationResult, VerificationState,
    VerifierCapabilities, VerifierConversionOptions, VerifierError, VerifierSession,
};
use caption_bridge_zenz_verifier::{
    CandidatePrompt, EmbeddedZenzDraftVerifier, ZenzForwardModel, ZenzPromptTokenizer,
};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

const MODEL_REVISION: &str = "zenz-v3.2-small-gguf@c67e03e07d215c869f591b274c1631170d3e11fe";
const MAX_ITERATIONS: usize = 10;
const WORD_BOUNDARY_CATEGORY: &str = "completed_word_boundary_failures";
const GREEDY_MAX_TOKENS: usize = 128;

struct SingleCompletionVerifier {
    model: ZenzForwardModel,
    tokenizer: ZenzPromptTokenizer,
    next_session_id: u64,
    completions: HashMap<u64, String>,
}

impl SingleCompletionVerifier {
    fn load(model_path: &Path, tokenizer_directory: &Path) -> Self {
        Self {
            model: ZenzForwardModel::load(model_path, &Device::Cpu)
                .expect("greedy completion model should load"),
            tokenizer: ZenzPromptTokenizer::from_dir(tokenizer_directory)
                .expect("greedy completion tokenizer should load"),
            next_session_id: 1,
            completions: HashMap::new(),
        }
    }

    fn generate_completion(&mut self, context: &SessionContext) -> Result<String, VerifierError> {
        let prompt = CandidatePrompt::try_from(context)
            .map_err(|error| VerifierError::InvalidDraft(error.to_string()))?;
        let katakana_input = to_katakana(prompt.input);
        let mut token_ids = self
            .tokenizer
            .encode_candidate_prompt(CandidatePrompt {
                left_context: prompt.left_context,
                right_context: prompt.right_context,
                input: &katakana_input,
            })
            .into_iter()
            .map(|token| {
                u32::try_from(token)
                    .map_err(|_| VerifierError::InvalidDraft(format!("token {token} exceeds u32")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut bytes = Vec::new();
        let mut reached_eos = false;
        for _ in 0..GREEDY_MAX_TOKENS {
            let logits = self
                .model
                .forward(&token_ids)
                .map_err(|error| VerifierError::Backend(error.to_string()))?;
            let row = logits
                .i(token_ids.len() - 1)
                .and_then(|row| row.to_vec1::<f32>())
                .map_err(|error| VerifierError::Backend(error.to_string()))?;
            let predicted = row
                .iter()
                .copied()
                .enumerate()
                .max_by(|left, right| left.1.total_cmp(&right.1))
                .map(|(token, _)| token)
                .ok_or_else(|| VerifierError::Backend("model returned empty logits".to_string()))?;
            if predicted == self.tokenizer.eos_token_id() {
                reached_eos = true;
                break;
            }
            let piece = self.tokenizer.token_bytes(predicted).ok_or_else(|| {
                VerifierError::Backend(format!("predicted token {predicted} is out of range"))
            })?;
            bytes.extend_from_slice(&piece);
            token_ids.push(u32::try_from(predicted).map_err(|_| {
                VerifierError::Backend(format!("predicted token {predicted} exceeds u32"))
            })?);
        }
        if !reached_eos {
            return Err(VerifierError::Backend(format!(
                "greedy completion exceeded {GREEDY_MAX_TOKENS} tokens"
            )));
        }
        String::from_utf8(bytes)
            .map_err(|error| VerifierError::Backend(format!("invalid completion UTF-8: {error}")))
    }

    fn completion_for(
        &mut self,
        input: &str,
        left_context: &str,
        dictionary_revision: u64,
    ) -> String {
        let mut context =
            SessionContext::new(input.as_bytes(), dictionary_revision, "c-abi-one-completion-v1");
        context.left_context = Some(left_context.as_bytes().to_vec());
        let session = self.open_session(context).expect("one-completion session should open");
        let completion = self
            .completions
            .get(&session.session_id)
            .cloned()
            .expect("one-completion should retain generated text");
        self.close_session(session).expect("one-completion session should close");
        completion
    }
}

impl DraftVerifier for SingleCompletionVerifier {
    fn capabilities(&self) -> VerifierCapabilities {
        VerifierCapabilities {
            prefix_constraints: true,
            session_kv: false,
            right_context: true,
            max_candidates: 1,
            model_revision: MODEL_REVISION.to_string(),
            tokenizer_revision: "measured-tokenizer".to_string(),
        }
    }

    fn open_session(&mut self, context: SessionContext) -> Result<VerifierSession, VerifierError> {
        let session_id = self.next_session_id;
        self.next_session_id = self
            .next_session_id
            .checked_add(1)
            .ok_or_else(|| VerifierError::Backend("session identifier exhausted".to_string()))?;
        let completion = self.generate_completion(&context)?;
        self.completions.insert(session_id, completion);
        Ok(VerifierSession {
            session_id,
            context,
            model_revision: MODEL_REVISION.to_string(),
            tokenizer_revision: "measured-tokenizer".to_string(),
            kv_reusable: false,
        })
    }

    fn evaluate(
        &mut self,
        session: &mut VerifierSession,
        draft: &Draft,
    ) -> Result<VerificationResult, VerifierError> {
        let completion =
            self.completions.get(&session.session_id).ok_or(VerifierError::SessionClosed)?;
        let cache_key = VerificationCacheKey::for_draft(session, draft);
        if draft.candidate_path.text == *completion {
            return Ok(VerificationResult {
                state: VerificationState::Verified,
                candidate_path: draft.candidate_path.clone(),
                prefix_constraint: None,
                cache_key,
            });
        }
        let common_bytes = draft
            .candidate_path
            .text
            .chars()
            .zip(completion.chars())
            .take_while(|(candidate, generated)| candidate == generated)
            .map(|(character, _)| character.len_utf8())
            .sum::<usize>();
        let next_scalar = completion[common_bytes..].chars().next().ok_or_else(|| {
            VerifierError::Backend("completion is a strict candidate prefix".into())
        })?;
        let prefix_end = common_bytes + next_scalar.len_utf8();
        Ok(VerificationResult {
            state: VerificationState::PrefixConstraintReturned,
            candidate_path: draft.candidate_path.clone(),
            prefix_constraint: Some(Utf8BytePrefixConstraint::output_prefix(
                completion.as_bytes()[..prefix_end].to_vec(),
            )),
            cache_key,
        })
    }

    fn close_session(&mut self, session: VerifierSession) -> Result<(), VerifierError> {
        self.completions.remove(&session.session_id).map(|_| ()).ok_or(VerifierError::SessionClosed)
    }
}

fn to_katakana(input: &str) -> String {
    input
        .chars()
        .map(|character| match character {
            '\u{3041}'..='\u{3096}' => {
                char::from_u32(u32::from(character) + 0x60).unwrap_or(character)
            }
            _ => character,
        })
        .collect()
}

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

#[test]
#[ignore = "requires ZENZ_V32_SMALL_GGUF; measures one-fetch scalar-prefix equivalence"]
fn measured_completed_corpus_compares_single_completion_scalar_prefix_loop() {
    let model_path = std::env::var("ZENZ_V32_SMALL_GGUF")
        .expect("ZENZ_V32_SMALL_GGUF must point to zenz-v3.2-small GGUF");
    let model_path = Path::new(&model_path);
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
    let cases = measured_cases();

    let mut embedded = EmbeddedZenzDraftVerifier::load(
        model_path,
        &tokenizer_directory,
        MODEL_REVISION,
        &Device::Cpu,
    )
    .expect("embedded verifier should load");
    let embedded_results = cases
        .iter()
        .map(|case| {
            convert_with_verifier_with_limit(
                case.input,
                &dictionary,
                ConversionOptions::default(),
                Some(&mut embedded),
                VerifierConversionOptions::new(MAX_ITERATIONS, "candle-greedy-v1")
                    .with_left_context(case.artificial_left_context),
            )
        })
        .collect::<Vec<_>>();
    drop(embedded);

    let mut single_completion = SingleCompletionVerifier::load(model_path, &tokenizer_directory);
    let single_results = cases
        .iter()
        .map(|case| {
            convert_with_verifier_with_limit(
                case.input,
                &dictionary,
                ConversionOptions::default(),
                Some(&mut single_completion),
                VerifierConversionOptions::new(MAX_ITERATIONS, "single-completion-scalar-v1")
                    .with_left_context(case.artificial_left_context),
            )
        })
        .collect::<Vec<_>>();

    let mut exact_output_matches = 0usize;
    let mut embedded_passed = 0usize;
    let mut single_passed = 0usize;
    let mut embedded_word_boundary_passed = 0usize;
    let mut single_word_boundary_passed = 0usize;
    eprintln!(
        "case_id\tcategory\tembedded_actual\tsingle_actual\texact_match\tembedded_iterations\tsingle_iterations"
    );
    for ((case, embedded), single) in cases.iter().zip(&embedded_results).zip(&single_results) {
        let exact_match = embedded.text() == single.text();
        exact_output_matches += usize::from(exact_match);
        embedded_passed += usize::from(embedded.text() == case.expected);
        single_passed += usize::from(single.text() == case.expected);
        if case.category == WORD_BOUNDARY_CATEGORY {
            embedded_word_boundary_passed += usize::from(embedded.text() == case.expected);
            single_word_boundary_passed += usize::from(single.text() == case.expected);
        }
        eprintln!(
            "{}\t{}\t{:?}\t{:?}\t{}\t{}\t{}",
            case.case_id,
            case.category,
            embedded.text(),
            single.text(),
            exact_match,
            embedded.verification_iterations,
            single.verification_iterations,
        );
    }
    eprintln!(
        "single-completion equivalence: exact_outputs={exact_output_matches}/{} strict={embedded_passed}/{} embedded -> {single_passed}/{} single; word_boundary={embedded_word_boundary_passed}/7 embedded -> {single_word_boundary_passed}/7 single; remote_fetches={} (one per case)",
        cases.len(),
        cases.len(),
        cases.len(),
        cases.len(),
    );

    assert_eq!(embedded_passed, 21, "embedded accuracy ceiling drifted");
    assert_eq!(embedded_word_boundary_passed, 7, "embedded word-boundary ceiling drifted");
    assert_eq!(single_passed, embedded_passed, "strict accuracy is not equivalent");
    assert_eq!(
        single_word_boundary_passed, embedded_word_boundary_passed,
        "word-boundary accuracy is not equivalent"
    );
    assert_eq!(exact_output_matches, cases.len(), "case outputs are not equivalent");
}

fn next_output_prefix(candidate: &str, completion: &str) -> Option<Vec<u8>> {
    let common_bytes = candidate
        .chars()
        .zip(completion.chars())
        .take_while(|(left, right)| left == right)
        .map(|(character, _)| character.len_utf8())
        .sum::<usize>();
    let next_scalar = completion[common_bytes..].chars().next()?;
    Some(completion.as_bytes()[..common_bytes + next_scalar.len_utf8()].to_vec())
}

fn convert_with_c_abi_one_completion(input: &str, completion: &str) -> String {
    let handle = unsafe {
        caption_bridge_azookey_wasm::azookey_lattice_open(
            input.as_ptr(),
            input.len(),
            0,
            0,
            0,
            64,
            1,
        )
    };
    let result = (|| {
        if handle == 0 {
            return None;
        }
        let (status, unconstrained) =
            caption_bridge_azookey_wasm::search_lattice_output_prefix(handle, &[], 64, 1);
        if status != 0 {
            return None;
        }
        let mut candidate = unconstrained.into_iter().next()?.text;
        if candidate == completion {
            return Some(candidate);
        }
        for _ in 0..MAX_ITERATIONS {
            let Some(prefix) = next_output_prefix(&candidate, completion) else {
                return Some(candidate);
            };
            let (status, constrained) =
                caption_bridge_azookey_wasm::search_lattice_output_prefix(handle, &prefix, 64, 1);
            if status != 0 {
                return None;
            }
            let Some(next) = constrained.into_iter().next() else {
                return Some(candidate);
            };
            if next.text == candidate {
                return Some(candidate);
            }
            candidate = next.text;
            if candidate == completion {
                return Some(candidate);
            }
        }
        Some(candidate)
    })();
    if handle != 0 {
        let _ = caption_bridge_azookey_wasm::azookey_lattice_close(handle);
    }
    result.unwrap_or_else(|| input.to_string())
}

#[test]
#[ignore = "requires ZENZ_V32_SMALL_GGUF; measures C ABI one-fetch scalar-prefix equivalence"]
fn measured_completed_corpus_c_abi_one_completion_matches_embedded() {
    let model_path = std::env::var("ZENZ_V32_SMALL_GGUF")
        .expect("ZENZ_V32_SMALL_GGUF must point to zenz-v3.2-small GGUF");
    let model_path = Path::new(&model_path);
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
    let previous = caption_bridge_azookey_wasm::replace_active_dictionary(Some(dictionary.clone()));
    let cases = measured_cases();
    let mut embedded = EmbeddedZenzDraftVerifier::load(
        model_path,
        &tokenizer_directory,
        MODEL_REVISION,
        &Device::Cpu,
    )
    .expect("embedded verifier should load");
    let mut single_completion = SingleCompletionVerifier::load(model_path, &tokenizer_directory);
    let mut rust_vs_abi = 0usize;
    let mut embedded_vs_abi = 0usize;
    let mut rust_passed = 0usize;
    let mut abi_passed = 0usize;
    let mut rust_word_boundary = 0usize;
    let mut abi_word_boundary = 0usize;
    eprintln!("case_id\tcategory\trust_one\tabi_one\tembedded\trust_eq_abi");
    for case in &cases {
        let completion = single_completion.completion_for(
            case.input,
            case.artificial_left_context,
            dictionary.revision(),
        );
        let rust_one = convert_with_verifier_with_limit(
            case.input,
            &dictionary,
            ConversionOptions::default(),
            Some(&mut single_completion),
            VerifierConversionOptions::new(MAX_ITERATIONS, "single-completion-scalar-v1")
                .with_left_context(case.artificial_left_context),
        );
        let embedded_one = convert_with_verifier_with_limit(
            case.input,
            &dictionary,
            ConversionOptions::default(),
            Some(&mut embedded),
            VerifierConversionOptions::new(MAX_ITERATIONS, "candle-greedy-v1")
                .with_left_context(case.artificial_left_context),
        );
        let abi = convert_with_c_abi_one_completion(case.input, &completion);
        rust_vs_abi += usize::from(rust_one.text() == abi);
        embedded_vs_abi += usize::from(embedded_one.text() == abi);
        rust_passed += usize::from(rust_one.text() == case.expected);
        abi_passed += usize::from(abi == case.expected);
        if case.category == WORD_BOUNDARY_CATEGORY {
            rust_word_boundary += usize::from(rust_one.text() == case.expected);
            abi_word_boundary += usize::from(abi == case.expected);
        }
        eprintln!(
            "{}\t{}\t{:?}\t{:?}\t{:?}\t{}",
            case.case_id,
            case.category,
            rust_one.text(),
            abi,
            embedded_one.text(),
            rust_one.text() == abi,
        );
    }
    let _ = caption_bridge_azookey_wasm::replace_active_dictionary(previous);
    eprintln!(
        "c-abi vs rust-one: {rust_vs_abi}/{} ; c-abi vs embedded: {embedded_vs_abi}/{} ; strict rust={rust_passed}/{} abi={abi_passed}/{} ; word_boundary rust={rust_word_boundary}/7 abi={abi_word_boundary}/7",
        cases.len(),
        cases.len(),
        cases.len(),
        cases.len(),
    );
    assert_eq!(rust_vs_abi, cases.len(), "C ABI one-completion diverged from Rust one-completion");
    assert_eq!(
        abi_passed, rust_passed,
        "C ABI strict accuracy is not equivalent to Rust one-completion"
    );
    assert_eq!(
        abi_word_boundary, rust_word_boundary,
        "C ABI word-boundary accuracy is not equivalent to Rust one-completion"
    );
}
