//! Standalone test target for Caption Bridge's dependency-free AzooKey Rust port.
//!
//! The production module stays in `src-tauri` so Tauri owns the application
//! boundary. This crate deliberately compiles the same source without Tauri,
//! GTK, or platform SDK dependencies, making its dictionary-format and
//! Viterbi tests runnable in Linux CI and developer containers.

#[path = "../../src-tauri/src/kana_kanji.rs"]
pub mod kana_kanji;

pub use kana_kanji::*;
