//! Rust port of azooKey's `EfficientNGram` Kneser-Ney character n-gram model.
//!
//! The reference implementation lives in
//! `submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/`, and targets
//! the model published at `Miwa-Keita/input_n5_lm_v1`.
//!
//! This crate is deliberately standalone: it is not wired into the caption
//! pipeline and is not a dependency of `azookey-rust`, whose wasm target would
//! break on a MARISA C++ FFI.
//!
//! Trie access is abstracted behind [`NgramTrie`], so the smoothing math runs
//! against an in-memory fixture without needing the 120 MB model archive.
//!
//! ```
//! use caption_bridge_input_lm::{EfficientNGram, MemoryTrie, NgramParams};
//!
//! let params = NgramParams { n: 3, d: 0.5, vocab_size: 4, start_token_id: 0 };
//! let mut counts = MemoryTrie::new();
//! counts.insert_predictive(&[1, 2, 3], 4);
//!
//! let model = EfficientNGram::new(
//!     params,
//!     counts,
//!     MemoryTrie::new(),
//!     MemoryTrie::new(),
//!     MemoryTrie::new(),
//! );
//! let probabilities = model.bulk_predict(&[1, 2]);
//! assert_eq!(probabilities.len(), params.vocab_size);
//! assert!(probabilities[3] > probabilities[0]);
//! ```

pub mod codec;
#[cfg(feature = "rsmarisa")]
pub mod marisa;
pub mod model;
pub mod trie;

pub use codec::{
    decode_key, decode_value, encode_key, encode_value, point_entry, point_prefix,
    predictive_entry, predictive_prefix, KEY_VALUE_DELIMITER, PREDICTIVE_DELIMITER, RADIX,
    VALUE_LEN,
};
pub use model::{EfficientNGram, NgramParams};
pub use trie::{MemoryTrie, NgramTrie};
