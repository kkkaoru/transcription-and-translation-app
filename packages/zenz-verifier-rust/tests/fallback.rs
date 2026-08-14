use caption_bridge_azookey_rust::{
    convert_with_verifier, convert_with_verifier_with_limit, AzooKeyDictionary, ConversionOptions,
    DictionaryPaths, Utf8BytePrefixConstraint, VerificationState, VerifierConversionOptions,
};
use caption_bridge_zenz_verifier::{MockDecision, MockDraftVerifier};

fn dictionary() -> AzooKeyDictionary {
    AzooKeyDictionary::from_paths(&DictionaryPaths::default())
        .expect("built-in fallback dictionary should load")
}

#[test]
fn every_terminal_mock_state_preserves_non_empty_conversion() {
    let cases = [
        (MockDecision::Verified, VerificationState::Verified),
        (MockDecision::Exhausted, VerificationState::Exhausted),
        (MockDecision::CapabilityUnavailable, VerificationState::CapabilityUnavailable),
        (MockDecision::Error, VerificationState::Error),
        (MockDecision::UnverifiedFallback, VerificationState::UnverifiedFallback),
    ];
    let dictionary = dictionary();
    for (decision, expected_state) in cases {
        let mut verifier = MockDraftVerifier::new([decision]);
        let result = convert_with_verifier(
            "かんじ",
            &dictionary,
            ConversionOptions::default(),
            Some(&mut verifier),
        );
        assert_eq!(result.verification_state, expected_state);
        assert!(!result.text().is_empty());
    }
}

#[test]
fn prefix_retry_exhaustion_and_backend_failure_preserve_non_empty_conversion() {
    let dictionary = dictionary();
    let mut prefix_verifier = MockDraftVerifier::new([MockDecision::PrefixConstraint(
        Utf8BytePrefixConstraint::from_surface(0, "漢"),
    )]);
    let exhausted = convert_with_verifier_with_limit(
        "かんじ",
        &dictionary,
        ConversionOptions::default(),
        Some(&mut prefix_verifier),
        VerifierConversionOptions { max_iterations: 1 },
    );
    assert_eq!(exhausted.verification_state, VerificationState::Exhausted);
    assert!(!exhausted.text().is_empty());

    let mut failed_verifier =
        MockDraftVerifier::new([MockDecision::Fail("model unavailable".to_string())]);
    let failed = convert_with_verifier(
        "かんじ",
        &dictionary,
        ConversionOptions::default(),
        Some(&mut failed_verifier),
    );
    assert_eq!(failed.verification_state, VerificationState::Error);
    assert!(!failed.text().is_empty());

    let unavailable =
        convert_with_verifier("かんじ", &dictionary, ConversionOptions::default(), None);
    assert_eq!(unavailable.verification_state, VerificationState::CapabilityUnavailable);
    assert!(!unavailable.text().is_empty());
}
