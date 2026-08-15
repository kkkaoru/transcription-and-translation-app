//! Embedded and test-double implementations of AzooKey's verifier boundary.
//!
//! The default feature set intentionally has no inference runtime. It provides
//! prompt/tokenizer wiring and [`MockDraftVerifier`] so caller integration and
//! fail-open behavior can be tested without a model. GGUF loading is isolated
//! behind the opt-in `candle` feature so `caption-bridge-azookey-rust` and its
//! WebAssembly consumer never acquire a Candle dependency.

mod mock;
mod prompt;
mod tokenizer;

#[cfg(feature = "candle")]
mod forward;
#[cfg(feature = "candle")]
pub mod gguf;

pub use mock::{MockDecision, MockDraftVerifier};
pub use prompt::{
    build_candidate_prompt, CandidatePrompt, PromptError, DEFAULT_CONTEXT_MAX_GRAPHEMES,
};
pub use tokenizer::{PromptTokenizerError, ZenzPromptTokenizer};

#[cfg(feature = "candle")]
pub use forward::ZenzForwardModel;
