//! Shared caption *display* logic for a future GPUI app and the existing Tauri overlay.
//!
//! Algorithms are a line-by-line port of the TypeScript overlay/core display path.
//! Time is injected (`now_ms`) so tests can drive hold-clear and freshness timers.
//!
//! Sentence paging is a documented dual of `packages/sentence-boundary` (TypeScript).
//! It is **not** a call into `caption-bridge-vibrato-core::sentence_boundary`: that
//! crate still treats polite ます as a copula and lacks the 2× remainder-dominance
//! rule that the overlay tests lock.

pub mod display;
pub mod freshness;
pub mod hold_clear;
pub mod layout;
pub mod merge;
pub mod progressive;
pub mod sticky;

mod grapheme;
mod payload;
mod relay;
mod sentence;

/// Sticky + sentence paging facade. Sentence heuristics live in `sentence`
/// (documented dual of `packages/sentence-boundary`); Overlay sticky carry lives
/// in `sticky` (OverlayApp lines 94–257).
pub mod paging {
    pub use crate::sentence::{
        detect_caption_sentence_ends, detect_caption_soft_breaks,
        rebase_caption_soft_break_offsets, select_visible_caption_sentence, CaptionSentenceHints,
        CaptionSentenceKey,
    };
    pub use crate::sticky::{
        apply_overlay_sticky_display, apply_overlay_sticky_field, compatible_overlay_sticky_state,
        remember_overlay_sticky_state, reset_overlay_sticky_refs,
        should_keep_overlay_head_after_sticky_page, OverlayStickyOwner, OverlayStickyRefs,
        OverlayStickyState,
    };
}

pub use grapheme::{caption_graphemes, scalar_count, unicode_scalars};
pub use payload::{CaptionPayload, CaptionRowKey, CaptionStage};
pub use relay::{
    partial_window_relay_fence, should_apply_partial_window_relay, PartialWindowCaption,
    PartialWindowRelayFence,
};

/// Injected millisecond clock used by display algorithms.
pub type NowMs = i64;
