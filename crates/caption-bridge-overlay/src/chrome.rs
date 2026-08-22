//! Encoded chrome for the OBS capture surface.
//!
//! These values are the contract the live `NSWindow` must apply. Encoding them
//! as a plain Rust type lets unit tests assert the policy without a display.
//!
//! Numeric encodings match AppKit:
//! - [`NS_WINDOW_SHARING_READ_ONLY`] is `NSWindowSharingReadOnly` (1).
//! - Collection bits match `NSWindowCollectionBehaviorCanJoinAllSpaces` (1<<0),
//!   `FullScreenAuxiliary` (1<<8), and `Stationary` (1<<4).
//!
//! # OBS Window Capture on macOS
//!
//! Current OBS (`plugins/mac-capture`) has two window sources:
//! - Legacy **Window Capture** (`mac-window-capture.m`) uses
//!   `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)` to fill the
//!   picker and `CGWindowListCreateImage(..., kCGWindowListOptionIncludingWindow)`
//!   to grab BGRA. Off-screen windows never appear. Empty titles are hidden
//!   unless `show_empty_names` is on.
//! - **macOS Screen Capture** (`mac-sck-*.m`, macOS 12.5+; the Sources Guide
//!   tells users on macOS 13+ to use this instead of Window Capture) lists
//!   `SCShareableContent` windows with desktop surfaces excluded and
//!   `onScreenWindowsOnly = !show_hidden_windows`. Empty owner or title is
//!   dropped unless `show_empty_names` is on. The stream sets
//!   `backgroundColor = kCGColorClear` and pixel format FourCC `l10r`
//!   (`kCVPixelFormatType_64RGBALE`, 16-bit little-endian RGB, no alpha).
//!
//! Neither source exposes an "allow transparency" toggle. Classic Window
//! Capture emits `VIDEO_FORMAT_BGRA` (32 bpp) so an alpha plane exists, but
//! AppKit/CoreGraphics compositing of a clear `NSWindow` is not documented as
//! preserving per-pixel alpha for another process. Screen Capture's `l10r`
//! format has no alpha channel. Treat Window Capture as a stable, titled,
//! on-screen surface; use Syphon when the compositor must keep true alpha.

/// Window stacking level used by the overlay.
///
/// The capture surface must stay at the normal desktop stacking level so it
/// is not always-on-top. OBS Window Capture still sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowLevel {
    /// `NSNormalWindowLevel` (0). Explicitly not floating or status-bar.
    Normal,
}

/// AppKit `NSWindowSharingType` encoding for the capture surface.
///
/// OBS does not read this field itself. AppKit does: `NSWindowSharingNone` (0)
/// hides the window from other-process capture (`CGWindowList` / ScreenCaptureKit).
/// The default, and the value this overlay must keep, is
/// [`WindowSharingType::ReadOnly`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowSharingType {
    /// `NSWindowSharingNone` (0). Content cannot be captured.
    None,
    /// `NSWindowSharingReadOnly` (1). Other processes may read the window.
    ReadOnly,
}

/// AppKit chrome applied to the overlay `NSWindow`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowChrome {
    /// When `true`, the window sets `ignoresMouseEvents` so clicks pass through.
    pub ignores_mouse_events: bool,
    /// Stacking level. Always [`WindowLevel::Normal`] for this crate.
    pub level: WindowLevel,
    /// Window is fully transparent (`opaque = false`, clear background).
    pub transparent: bool,
    /// Chromeless: no title bar, close button, or resize handles.
    pub borderless: bool,
    /// Shadow is disabled so OBS does not capture a drop shadow halo.
    pub has_shadow: bool,
    /// Other-process capture eligibility. Must stay [`WindowSharingType::ReadOnly`].
    pub sharing_type: WindowSharingType,
    /// Encoded `NSWindowCollectionBehavior` bits. Must include CanJoinAllSpaces
    /// so the window stays on-screen (and therefore in the OBS picker) across
    /// Spaces.
    pub collection_behavior: u64,
}

impl WindowChrome {
    /// Chrome required by the OBS Window Capture surface.
    pub const fn capture_surface() -> Self {
        Self {
            ignores_mouse_events: true,
            level: WindowLevel::Normal,
            transparent: true,
            borderless: true,
            has_shadow: false,
            sharing_type: WindowSharingType::ReadOnly,
            collection_behavior: CAPTURE_COLLECTION_BEHAVIOR,
        }
    }

    /// Numeric AppKit window level (`NSNormalWindowLevel` is 0 / `isize`).
    pub const fn ns_window_level(self) -> isize {
        match self.level {
            WindowLevel::Normal => NS_NORMAL_WINDOW_LEVEL,
        }
    }

    /// Numeric `NSWindowSharingType` (`NSUInteger`).
    pub const fn ns_window_sharing_type(self) -> usize {
        match self.sharing_type {
            WindowSharingType::None => NS_WINDOW_SHARING_NONE,
            WindowSharingType::ReadOnly => NS_WINDOW_SHARING_READ_ONLY,
        }
    }
}

impl Default for WindowChrome {
    fn default() -> Self {
        Self::capture_surface()
    }
}

/// `NSNormalWindowLevel` from AppKit. Kept as a named constant so tests and
/// the live window share one encoding.
pub const NS_NORMAL_WINDOW_LEVEL: isize = 0;

/// `NSWindowSharingNone` — window content cannot be captured by other processes.
pub const NS_WINDOW_SHARING_NONE: usize = 0;
/// `NSWindowSharingReadOnly` — default; other processes may read the window.
pub const NS_WINDOW_SHARING_READ_ONLY: usize = 1;

/// `NSWindowCollectionBehaviorCanJoinAllSpaces` (1 << 0).
pub const NS_COLLECTION_CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
/// `NSWindowCollectionBehaviorStationary` (1 << 4).
pub const NS_COLLECTION_STATIONARY: u64 = 1 << 4;
/// `NSWindowCollectionBehaviorFullScreenAuxiliary` (1 << 8).
pub const NS_COLLECTION_FULL_SCREEN_AUXILIARY: u64 = 1 << 8;

/// Collection bits applied to the live capture `NSWindow`.
///
/// CanJoinAllSpaces keeps a non-zero on-screen frame after Space switches so
/// OBS `kCGWindowListOptionOnScreenOnly` / `onScreenWindowsOnly` still lists
/// the window. FullScreenAuxiliary lets it coexist with a full-screen app.
/// Stationary matches a capture plate that should not be swept with Exposé.
pub const CAPTURE_COLLECTION_BEHAVIOR: u64 = NS_COLLECTION_CAN_JOIN_ALL_SPACES
    | NS_COLLECTION_STATIONARY
    | NS_COLLECTION_FULL_SCREEN_AUXILIARY;

#[cfg(test)]
mod tests {
    use super::{
        WindowChrome, WindowLevel, WindowSharingType, CAPTURE_COLLECTION_BEHAVIOR,
        NS_COLLECTION_CAN_JOIN_ALL_SPACES, NS_COLLECTION_FULL_SCREEN_AUXILIARY,
        NS_COLLECTION_STATIONARY, NS_NORMAL_WINDOW_LEVEL, NS_WINDOW_SHARING_NONE,
        NS_WINDOW_SHARING_READ_ONLY,
    };

    #[test]
    fn capture_surface_encodes_click_through_and_normal_level() {
        let chrome = WindowChrome::capture_surface();
        assert_eq!(
            chrome,
            WindowChrome {
                ignores_mouse_events: true,
                level: WindowLevel::Normal,
                transparent: true,
                borderless: true,
                has_shadow: false,
                sharing_type: WindowSharingType::ReadOnly,
                collection_behavior: 273,
            }
        );
        assert_eq!(chrome.ns_window_level(), 0);
        assert_eq!(chrome.ns_window_level(), NS_NORMAL_WINDOW_LEVEL);
        assert_eq!(chrome.ns_window_sharing_type(), 1);
        assert_eq!(chrome.ns_window_sharing_type(), NS_WINDOW_SHARING_READ_ONLY);
        assert_ne!(chrome.ns_window_sharing_type(), NS_WINDOW_SHARING_NONE);
        assert_eq!(chrome.collection_behavior, CAPTURE_COLLECTION_BEHAVIOR);
        assert_eq!(chrome.collection_behavior & NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(chrome.collection_behavior & NS_COLLECTION_STATIONARY, 16);
        assert_eq!(chrome.collection_behavior & NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
    }

    #[test]
    fn default_chrome_is_the_capture_surface() {
        assert_eq!(WindowChrome::default(), WindowChrome::capture_surface());
        assert!(WindowChrome::default().ignores_mouse_events);
        assert_eq!(WindowChrome::default().level, WindowLevel::Normal);
        assert_eq!(WindowChrome::default().sharing_type, WindowSharingType::ReadOnly);
        assert_eq!(WindowChrome::default().collection_behavior, 273);
    }

    #[test]
    fn sharing_none_encodes_zero_and_is_not_the_capture_default() {
        let none = WindowSharingType::None;
        let readonly = WindowSharingType::ReadOnly;
        assert_ne!(none, readonly);
        let mut chrome = WindowChrome::capture_surface();
        chrome.sharing_type = WindowSharingType::None;
        assert_eq!(chrome.ns_window_sharing_type(), 0);
        assert_eq!(chrome.ns_window_sharing_type(), NS_WINDOW_SHARING_NONE);
        assert_ne!(chrome, WindowChrome::capture_surface());
    }

    #[test]
    fn collection_behavior_bits_match_appkit_shifts() {
        assert_eq!(NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(NS_COLLECTION_STATIONARY, 16);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
        assert_eq!(CAPTURE_COLLECTION_BEHAVIOR, 273);
        assert_eq!(1u64 | 16u64 | 256u64, 273);
    }
}
