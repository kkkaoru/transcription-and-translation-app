use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use super::{
    AsrRequestRunner, AsrWorkerStartupSender, EngineAsrRequestRunner, EngineTurnDecisionRunner,
    RecognitionSession, TurnDecisionRunner, TurnOutputSink,
    clock::MonotonicCaptionClock,
    session::{
        ActivityState, AsrRequestState, LanguageIdRuntime, PendingRuntimeState, RuntimeCounters,
        RuntimeIo, TurnStore,
    },
};
use crate::{
    config::ParapperConfig,
    recognition::{
        transcription::route::{
            language_id::{LanguageDetectionWarningSink, LanguageDetector},
            selection::build_id_detector,
        },
        turn::boundary::load_japanese_morph_analyzer,
    },
};

static NEXT_TURN_SESSION_ID: AtomicU64 = AtomicU64::new(1);

struct RuntimeParts {
    asr_runner: Box<dyn AsrRequestRunner>,
    turn_decision_runner: Box<dyn TurnDecisionRunner>,
    output_sink: Box<dyn TurnOutputSink>,
    language_id_runtime: Option<Box<dyn LanguageIdRuntime>>,
    language_id: Option<Box<dyn LanguageDetector>>,
}

struct PortableLanguageIdRuntime {
    models_root: PathBuf,
}

impl RecognitionSession {
    pub(crate) fn new_portable(
        models_root: &Path,
        config: &ParapperConfig,
        asr_startup_sender: Option<AsrWorkerStartupSender>,
        partial_window_asr_enabled: bool,
        output_sink: Box<dyn TurnOutputSink>,
    ) -> Self {
        let parts = RuntimeParts {
            asr_runner: Box::new(EngineAsrRequestRunner::new(
                models_root,
                config,
                asr_startup_sender,
            )),
            turn_decision_runner: Box::new(EngineTurnDecisionRunner::new(models_root, config)),
            output_sink,
            language_id_runtime: Some(Box::new(PortableLanguageIdRuntime {
                models_root: models_root.to_path_buf(),
            })),
            language_id: build_id_detector(models_root, config),
        };
        let mut runtime = Self::with_parts(
            config,
            take_next_turn_session_id(),
            partial_window_asr_enabled,
            parts,
        );
        if config.requires_japanese_morph_analyzer() {
            runtime.io.japanese_morph = load_japanese_morph_analyzer(models_root);
        }
        runtime
    }

    #[cfg(test)]
    pub(crate) fn new(config: &ParapperConfig) -> Self {
        use super::{NoopAsrRequestRunner, NoopTurnDecisionRunner, NoopTurnOutputSink};
        Self::with_parts(
            config,
            1,
            false,
            RuntimeParts {
                asr_runner: Box::new(NoopAsrRequestRunner),
                turn_decision_runner: Box::new(NoopTurnDecisionRunner),
                output_sink: Box::new(NoopTurnOutputSink),
                language_id_runtime: None,
                language_id: None,
            },
        )
    }

    fn with_parts(
        config: &ParapperConfig,
        turn_session_id: u64,
        partial_window_asr_enabled: bool,
        parts: RuntimeParts,
    ) -> Self {
        Self {
            config: config.clone(),
            partial_window_asr_enabled,
            pending: PendingRuntimeState::default(),
            io: RuntimeIo {
                asr_runner: parts.asr_runner,
                turn_decision_runner: parts.turn_decision_runner,
                output_sink: parts.output_sink,
                language_id_runtime: parts.language_id_runtime,
                language_id: parts.language_id,
                japanese_morph: None,
            },
            turn_store: TurnStore::default(),
            counters: RuntimeCounters::new(turn_session_id),
            activity: ActivityState::default(),
            requests: AsrRequestState::default(),
            clock: std::sync::Arc::new(MonotonicCaptionClock::new()),
        }
    }
}

fn take_next_turn_session_id() -> u64 {
    NEXT_TURN_SESSION_ID.fetch_add(1, Ordering::Relaxed)
}

impl LanguageDetectionWarningSink for PortableLanguageIdRuntime {
    fn emit_language_detection_warning(&self, error: &anyhow::Error) {
        log::warn!("Language identification failed: {error}");
    }
}

impl LanguageIdRuntime for PortableLanguageIdRuntime {
    fn build_language_id(&self, config: &ParapperConfig) -> Option<Box<dyn LanguageDetector>> {
        build_id_detector(&self.models_root, config)
    }
}

#[cfg(test)]
mod tests {
    use super::take_next_turn_session_id;

    #[test]
    fn production_turn_session_ids_are_monotonic() {
        let first = take_next_turn_session_id();
        let second = take_next_turn_session_id();
        assert!(second > first);
    }
}
