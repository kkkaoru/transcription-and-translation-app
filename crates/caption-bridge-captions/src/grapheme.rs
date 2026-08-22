//! Grapheme and Unicode-scalar helpers for caption budgets.
//!
//! Overlay budgets are human-visible grapheme clusters (`unicode-segmentation`),
//! never UTF-8 bytes or UTF-16 code units. Sentence offsets stay Unicode scalars
//! (`char`s), matching TypeScript `Array.from`.

use unicode_segmentation::UnicodeSegmentation;

/// User-visible grapheme clusters for caption budgets.
pub fn caption_graphemes(text: &str) -> Vec<String> {
    text.graphemes(true).map(str::to_string).collect()
}

/// Unicode scalar values (`char`s), matching TypeScript `Array.from(text)`.
pub fn unicode_scalars(text: &str) -> Vec<char> {
    text.chars().collect()
}

/// Number of Unicode scalars in `text`.
pub fn scalar_count(text: &str) -> usize {
    text.chars().count()
}
