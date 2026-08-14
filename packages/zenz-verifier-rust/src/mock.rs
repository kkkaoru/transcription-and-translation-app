use caption_bridge_azookey_rust::{
    Draft, DraftVerifier, SessionContext, Utf8BytePrefixConstraint, VerificationCacheKey,
    VerificationResult, VerificationState, VerifierCapabilities, VerifierError, VerifierSession,
};
use std::collections::{HashSet, VecDeque};

/// One deterministic result queued for [`MockDraftVerifier`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockDecision {
    Verified,
    PrefixConstraint(Utf8BytePrefixConstraint),
    Exhausted,
    CapabilityUnavailable,
    Error,
    UnverifiedFallback,
    Fail(String),
}

/// Model-free verifier used to exercise lattice retries and fail-open callers.
///
/// Decisions are consumed in FIFO order. Once the queue is empty the mock
/// returns `UnverifiedFallback`, making accidental extra evaluations explicit
/// without inventing a successful model verification.
#[derive(Debug)]
pub struct MockDraftVerifier {
    capabilities: VerifierCapabilities,
    decisions: VecDeque<MockDecision>,
    open_sessions: HashSet<u64>,
    next_session_id: u64,
    evaluation_count: usize,
}

impl MockDraftVerifier {
    pub fn new(decisions: impl IntoIterator<Item = MockDecision>) -> Self {
        Self::with_capabilities(
            VerifierCapabilities {
                prefix_constraints: true,
                session_kv: false,
                right_context: true,
                max_candidates: usize::MAX,
                model_revision: "mock-model-v1".to_string(),
                tokenizer_revision: "mock-tokenizer-v1".to_string(),
            },
            decisions,
        )
    }

    pub fn with_capabilities(
        capabilities: VerifierCapabilities,
        decisions: impl IntoIterator<Item = MockDecision>,
    ) -> Self {
        Self {
            capabilities,
            decisions: decisions.into_iter().collect(),
            open_sessions: HashSet::new(),
            next_session_id: 1,
            evaluation_count: 0,
        }
    }

    pub fn remaining_decisions(&self) -> usize {
        self.decisions.len()
    }

    pub fn evaluation_count(&self) -> usize {
        self.evaluation_count
    }

    fn ensure_open(&self, session: &VerifierSession) -> Result<(), VerifierError> {
        if self.open_sessions.contains(&session.session_id) {
            Ok(())
        } else {
            Err(VerifierError::SessionClosed)
        }
    }
}

impl DraftVerifier for MockDraftVerifier {
    fn capabilities(&self) -> VerifierCapabilities {
        self.capabilities.clone()
    }

    fn open_session(&mut self, context: SessionContext) -> Result<VerifierSession, VerifierError> {
        let session_id = self.next_session_id;
        self.next_session_id = self.next_session_id.checked_add(1).ok_or_else(|| {
            VerifierError::Backend("mock verifier exhausted session identifiers".to_string())
        })?;
        self.open_sessions.insert(session_id);
        Ok(VerifierSession {
            session_id,
            context,
            model_revision: self.capabilities.model_revision.clone(),
            tokenizer_revision: self.capabilities.tokenizer_revision.clone(),
            kv_reusable: self.capabilities.session_kv,
        })
    }

    fn evaluate(
        &mut self,
        session: &mut VerifierSession,
        draft: &Draft,
    ) -> Result<VerificationResult, VerifierError> {
        self.ensure_open(session)?;
        self.evaluation_count += 1;
        let decision = self.decisions.pop_front().unwrap_or(MockDecision::UnverifiedFallback);
        let cache_key = VerificationCacheKey::for_draft(session, draft);
        let (state, prefix_constraint) = match decision {
            MockDecision::Verified => (VerificationState::Verified, None),
            MockDecision::PrefixConstraint(constraint) => {
                (VerificationState::PrefixConstraintReturned, Some(constraint))
            }
            MockDecision::Exhausted => (VerificationState::Exhausted, None),
            MockDecision::CapabilityUnavailable => (VerificationState::CapabilityUnavailable, None),
            MockDecision::Error => (VerificationState::Error, None),
            MockDecision::UnverifiedFallback => (VerificationState::UnverifiedFallback, None),
            MockDecision::Fail(message) => return Err(VerifierError::Backend(message)),
        };
        Ok(VerificationResult {
            state,
            candidate_path: draft.candidate_path.clone(),
            prefix_constraint,
            cache_key,
        })
    }

    fn close_session(&mut self, session: VerifierSession) -> Result<(), VerifierError> {
        if self.open_sessions.remove(&session.session_id) {
            Ok(())
        } else {
            Err(VerifierError::SessionClosed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use caption_bridge_azookey_rust::{CandidatePath, Draft};

    fn draft(text: &str) -> Draft {
        Draft::new(
            "prompt",
            CandidatePath {
                edge_handles: vec![1],
                text: text.to_string(),
                score: -1.0,
                trailing: None,
            },
        )
    }

    #[test]
    fn mock_consumes_results_and_then_fails_open() {
        let constraint = Utf8BytePrefixConstraint::from_surface(0, "漢");
        let mut verifier = MockDraftVerifier::new([
            MockDecision::PrefixConstraint(constraint.clone()),
            MockDecision::Verified,
        ]);
        let mut session = verifier.open_session(SessionContext::new("かんじ", 7)).unwrap();

        let first = verifier.evaluate(&mut session, &draft("感じ")).unwrap();
        assert_eq!(first.state, VerificationState::PrefixConstraintReturned);
        assert_eq!(first.prefix_constraint, Some(constraint));
        let second = verifier.evaluate(&mut session, &draft("漢字")).unwrap();
        assert_eq!(second.state, VerificationState::Verified);
        let fallback = verifier.evaluate(&mut session, &draft("漢字")).unwrap();
        assert_eq!(fallback.state, VerificationState::UnverifiedFallback);
        assert_eq!(verifier.evaluation_count(), 3);
        assert_eq!(verifier.remaining_decisions(), 0);
    }

    #[test]
    fn closed_session_is_rejected() {
        let mut verifier = MockDraftVerifier::new([]);
        let mut session = verifier.open_session(SessionContext::new("かな", 1)).unwrap();
        verifier.close_session(session.clone()).unwrap();
        assert_eq!(
            verifier.evaluate(&mut session, &draft("仮名")),
            Err(VerifierError::SessionClosed)
        );
        assert_eq!(verifier.close_session(session), Err(VerifierError::SessionClosed));
    }

    #[test]
    fn every_non_constraint_state_is_returned_verbatim() {
        let decisions = [
            (MockDecision::Verified, VerificationState::Verified),
            (MockDecision::Exhausted, VerificationState::Exhausted),
            (MockDecision::CapabilityUnavailable, VerificationState::CapabilityUnavailable),
            (MockDecision::Error, VerificationState::Error),
            (MockDecision::UnverifiedFallback, VerificationState::UnverifiedFallback),
        ];
        let mut verifier =
            MockDraftVerifier::new(decisions.iter().map(|(decision, _)| decision.clone()));
        let mut session = verifier.open_session(SessionContext::new("かな", 1)).unwrap();
        for (_, expected) in decisions {
            let result = verifier.evaluate(&mut session, &draft("仮名")).unwrap();
            assert_eq!(result.state, expected);
            assert_eq!(result.prefix_constraint, None);
        }
    }

    #[test]
    fn backend_failure_is_not_disguised_as_verification() {
        let mut verifier = MockDraftVerifier::new([MockDecision::Fail("offline".to_string())]);
        let mut session = verifier.open_session(SessionContext::new("かな", 1)).unwrap();
        assert_eq!(
            verifier.evaluate(&mut session, &draft("仮名")),
            Err(VerifierError::Backend("offline".to_string()))
        );
    }
}
