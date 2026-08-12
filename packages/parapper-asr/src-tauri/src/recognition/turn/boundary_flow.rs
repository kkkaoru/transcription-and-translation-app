use crate::recognition::{
    control::RecognitionSession,
    turn::{GrammarBoundaryClass, TurnBoundaryCandidate, policy::grammar},
};

impl RecognitionSession {
    pub(in crate::recognition) fn process_grammar_boundaries_after_rerecognition(
        &mut self,
        turn_id: u64,
    ) {
        let Some(candidates) = self
            .turn_store
            .turns
            .get(&turn_id)
            .map(|turn| turn.draft().boundary_candidates.clone())
        else {
            return;
        };
        match self.grammar_boundary_action(turn_id, candidates) {
            grammar::Action::CompleteTurn => {
                self.complete_whole_turn_after_grammar_boundary(turn_id);
            }
            grammar::Action::ContinueOpen { emit_interim } => {
                self.keep_turn_open(turn_id, emit_interim);
            }
            grammar::Action::DecideWithNamo => {
                self.complete_or_continue_turn_with_namo(turn_id);
            }
        }
    }

    fn grammar_boundary_action(
        &mut self,
        turn_id: u64,
        candidates: Vec<TurnBoundaryCandidate>,
    ) -> grammar::Action {
        let text_len = self
            .turn_store
            .turns
            .get(&turn_id)
            .map(|turn| turn.draft().combined_text.chars().count())
            .unwrap_or_default();
        let no_candidate_action = if self.config.uses_namo_turn_detector() {
            grammar::NoCandidateAction::DecideWithNamo
        } else {
            grammar::NoCandidateAction::ContinueOpen
        };
        let mut evaluated = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let is_at_text_end = candidate.char_end >= text_len;
            // Explicit split-after-genuine-end-silence policy: this grammar
            // decision is reached only after the turn-check silence
            // (`turn_check_silence_ms`) that marks a genuine utterance end, so
            // a grammar `NormalEnd` at the completion-ASR text end (e.g. a
            // terminal noun such as 晴れ) is treated as a confirmed utterance
            // end and finalizes the turn. Namo is no longer allowed to veto
            // that boundary: the veto kept the turn open and let the
            // following utterance attach to the same turn, merging two
            // utterances into one caption. Namo continuation is still
            // retained for mid-phrase breath, where grammar has no completing
            // boundary at the text end and the `DecideWithNamo` fallback
            // above asks Namo on the full text.
            let normal_end_is_confirmed =
                is_at_text_end && matches!(candidate.class, GrammarBoundaryClass::NormalEnd);
            evaluated.push(grammar::Candidate {
                class: candidate.class,
                is_at_text_end,
                normal_end_is_confirmed,
            });
        }
        grammar::action_after_rerecognition(evaluated, no_candidate_action)
    }

    fn complete_whole_turn_after_grammar_boundary(&mut self, turn_id: u64) {
        // Share deferred finalization with the non-grammar complete path so
        // multi-hop pending / in-flight ASR for this turn can still extend it.
        self.complete_turn_without_grammar(turn_id);
    }
}
