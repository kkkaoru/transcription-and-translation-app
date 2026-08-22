//! Chromeless overlay window for OBS Window Capture.
//!
//! GPUI cannot express a click-through, fully transparent capture surface.
//! This crate is the native-window bridge:
//! - macOS: AppKit `NSWindow` at `NSNormalWindowLevel`, `ignoresMouseEvents`,
//!   `NSWindowSharingReadOnly`, on-screen, titled, non-zero size. Pixel upload
//!   is straight (non-premultiplied) RGBA8 via `NSBitmapFormat::AlphaNonpremultiplied`.
//! - Windows: documented Win32 layered chrome (`WS_EX_LAYERED` +
//!   `WS_EX_TRANSPARENT`, never `HWND_TOPMOST`). Live `CreateWindowExW` is
//!   completed on a Windows host; this Mac compiles and tests the contract.
//! - Linux: [`OverlayError::UnsupportedPlatform`] pointing at Native
//!   browser-source (`http://127.0.0.1:1521`).
//!
//! Chrome is never always-on-top. Clicks pass through by default.
//!
//! # What OBS actually lists and captures (macOS)
//!
//! Sourced from current OBS `plugins/mac-capture` and the Sources Guide — not
//! invented flags:
//! - macOS 12.6 and earlier: **Window Capture**
//!   (`mac-window-capture.m` + `window-utils.m`) lists
//!   `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)` and grabs
//!   `CGWindowListCreateImage` as `VIDEO_FORMAT_BGRA`. Untitled windows are
//!   hidden unless `show_empty_names` is on. There is no sharing-type,
//!   layer, or "allow transparency" setting.
//! - macOS 13+: the Sources Guide says use **macOS Screen Capture**
//!   (`mac-sck-video-capture.m`). The picker is `SCShareableContent` with
//!   desktop windows excluded and `onScreenWindowsOnly` unless
//!   `show_hidden_windows`. Empty owner/title rows are dropped unless
//!   `show_empty_names`. Stream config uses `kCGColorClear` and FourCC `l10r`
//!   (no alpha). Cursor is a separate `show_cursor` toggle.
//!
//! Per-pixel alpha of a borderless clear `NSWindow` is **not** a documented
//! OBS guarantee. Classic Window Capture has a BGRA plane; Screen Capture's
//! `l10r` format does not. Keep Syphon as the guaranteed alpha path.
//!
//! # Opening a debug overlay
//!
//! ```ignore
//! use caption_bridge_overlay::{test_pattern_rgba, OverlayWindow, OverlayWindowOptions};
//!
//! let mut window = OverlayWindow::open(OverlayWindowOptions::debug_capture())?;
//! let pixels = test_pattern_rgba(1280, 720)?;
//! window.set_pixels(1280, 720, &pixels)?;
//! // Window is click-through, not always-on-top, and transparent outside the plate.
//! ```
//!
//! Verify: clicks pass through; the window sits at normal stacking (not floating);
//! only the centered plate and corner marks are opaque. Title is
//! `Kotoba Beacon Native Transparent Capture`.

#[cfg(target_os = "macos")]
mod appkit;
mod chrome;
mod debug;
mod error;
mod options;
mod pixels;
mod surface;
mod win32;

pub use chrome::{
    WindowChrome, WindowLevel, WindowSharingType, CAPTURE_COLLECTION_BEHAVIOR,
    NS_COLLECTION_CAN_JOIN_ALL_SPACES, NS_COLLECTION_FULL_SCREEN_AUXILIARY,
    NS_COLLECTION_STATIONARY, NS_NORMAL_WINDOW_LEVEL, NS_WINDOW_SHARING_NONE,
    NS_WINDOW_SHARING_READ_ONLY,
};
pub use debug::{
    half_alpha_pixel_rgba, test_pattern_rgba, DebugOverlayFrame, DEBUG_OVERLAY_TITLE,
    HALF_ALPHA_PIXEL_RGBA, STRAIGHT_HALF_ALPHA,
};
pub use error::{
    OverlayError, LINUX_OVERLAY_UNSUPPORTED, MACOS_OVERLAY_ONLY, WINDOWS_OVERLAY_HOST_ONLY,
};
pub use options::{
    OverlayWindowOptions, DEFAULT_OVERLAY_HEIGHT, DEFAULT_OVERLAY_TITLE, DEFAULT_OVERLAY_WIDTH,
};
pub use surface::{pump_native_events, OverlayWindow};
pub use win32::{
    capture_win32_chrome, layered_click_through_ex_style, validate_win32_chrome,
    win32_chrome_from_options, Win32Overlay, Win32OverlayChrome, HWND_NOTOPMOST, HWND_TOPMOST,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

/// Drain pending native events so a CLI host can keep the overlay visible.
///
/// On macOS this is the AppKit run-loop pump. Other targets return
/// [`OverlayError::UnsupportedPlatform`].
pub fn pump_appkit_events() -> Result<(), OverlayError> {
    pump_native_events()
}
