//! Layered, click-through Win32 overlay for OBS Window Capture.
//!
//! The public contract matches the macOS AppKit surface: chromeless, not
//! always-on-top (`HWND_TOPMOST` is never used), `WS_EX_LAYERED` +
//! `WS_EX_TRANSPARENT` for click-through, and per-pixel alpha via
//! `UpdateLayeredWindow`.
//!
//! OBS Windows Window Capture (`plugins/win-capture/window-capture.c`) offers
//! Automatic / BitBlt / WGC (`WindowsGraphicsCapture`). Automatic picks WGC
//! only for known classes (Chrome, Mozilla, UWP/WinUI, Office, `SDL_app`,
//! `GAMINGSERVICESUI_HOSTING_WINDOW_CLASS`); otherwise BitBlt. There is no
//! "allow transparency" setting. Game Capture is a separate Windows-only
//! source and is not this overlay. Spout remains the guaranteed alpha path
//! on Windows, matching Syphon on macOS.
//!
//! This module compiles on every host so unit tests can lock the chrome flags
//! and error variants. Live `CreateWindowExW` only runs on Windows. Do not
//! change the chrome contract (`HWND_NOTOPMOST`, layered click-through) when
//! wiring the live path.

use crate::chrome::WindowChrome;
use crate::error::OverlayError;
use crate::options::OverlayWindowOptions;

/// `WS_POPUP` — borderless overlapping window.
pub const WS_POPUP: u32 = 0x8000_0000;
/// `WS_EX_LAYERED` — per-pixel alpha via `UpdateLayeredWindow`.
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
/// `WS_EX_TRANSPARENT` — hit-test skip so clicks pass through.
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
/// `WS_EX_TOOLWINDOW` — hide from the taskbar.
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
/// `WS_EX_NOACTIVATE` — do not steal keyboard focus.
pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
/// `HWND_NOTOPMOST` — explicitly not always-on-top.
pub const HWND_NOTOPMOST: isize = -2;
/// `HWND_TOPMOST` — forbidden for this overlay.
pub const HWND_TOPMOST: isize = -1;
/// `ULW_ALPHA` — blend using the per-pixel alpha channel.
pub const ULW_ALPHA: u32 = 0x0000_0002;

/// Win32 chrome the live window must apply. Encoded as a plain Rust type so
/// tests can assert the policy without a display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Win32OverlayChrome {
    /// Combined `CreateWindowExW` extended style.
    pub ex_style: u32,
    /// Combined `CreateWindowExW` style.
    pub style: u32,
    /// Insert-after HWND. Must be [`HWND_NOTOPMOST`], never [`HWND_TOPMOST`].
    pub insert_after: isize,
    /// `UpdateLayeredWindow` flags.
    pub update_flags: u32,
}

/// Extended styles for a click-through layered overlay.
pub const fn layered_click_through_ex_style() -> u32 {
    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
}

/// Chrome required by the Native Windows capture surface.
pub const fn capture_win32_chrome() -> Win32OverlayChrome {
    Win32OverlayChrome {
        ex_style: layered_click_through_ex_style(),
        style: WS_POPUP,
        insert_after: HWND_NOTOPMOST,
        update_flags: ULW_ALPHA,
    }
}

/// Confirm the encoded chrome is click-through and not always-on-top.
pub fn validate_win32_chrome(chrome: Win32OverlayChrome) -> Result<(), OverlayError> {
    if chrome.insert_after == HWND_TOPMOST {
        return Err(OverlayError::NativeWindow(
            "overlay must not use HWND_TOPMOST; OBS Window Capture does not require always-on-top",
        ));
    }
    if chrome.insert_after != HWND_NOTOPMOST {
        return Err(OverlayError::NativeWindow("overlay insert-after must be HWND_NOTOPMOST"));
    }
    if chrome.ex_style & WS_EX_LAYERED == 0 {
        return Err(OverlayError::NativeWindow("overlay must set WS_EX_LAYERED"));
    }
    if chrome.ex_style & WS_EX_TRANSPARENT == 0 {
        return Err(OverlayError::NativeWindow(
            "overlay must set WS_EX_TRANSPARENT so clicks pass through",
        ));
    }
    if chrome.style != WS_POPUP {
        return Err(OverlayError::NativeWindow("overlay must be WS_POPUP (borderless)"));
    }
    Ok(())
}

/// Map [`WindowChrome`] onto the Win32 capture chrome. Non-capture values are
/// rejected so a caller cannot request always-on-top.
pub fn win32_chrome_from_options(
    options: &OverlayWindowOptions,
) -> Result<Win32OverlayChrome, OverlayError> {
    options.validate()?;
    let expected = WindowChrome::capture_surface();
    if options.chrome != expected {
        return Err(OverlayError::NativeWindow(
            "Windows overlay only supports capture-surface chrome (click-through, not always-on-top)",
        ));
    }
    let chrome = capture_win32_chrome();
    validate_win32_chrome(chrome)?;
    Ok(chrome)
}

/// Owned handle reserved for a live Win32 window.
///
/// On non-Windows hosts [`Win32Overlay::open`] always returns
/// [`OverlayError::UnsupportedPlatform`]. Fields exist so a Windows host can
/// retain the last applied options without changing the public type.
pub struct Win32Overlay {
    options: OverlayWindowOptions,
    chrome: Win32OverlayChrome,
}

impl Win32Overlay {
    /// Create and show the layered overlay. Only succeeds on Windows.
    pub fn open(options: OverlayWindowOptions) -> Result<Self, OverlayError> {
        let chrome = win32_chrome_from_options(&options)?;
        #[cfg(target_os = "windows")]
        {
            return live::create(options, chrome);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = chrome;
            let _ = options;
            Err(OverlayError::windows_unavailable_on_host())
        }
    }

    /// Options last successfully applied.
    pub fn options(&self) -> &OverlayWindowOptions {
        &self.options
    }

    /// Encoded Win32 chrome last applied.
    pub fn chrome(&self) -> Win32OverlayChrome {
        self.chrome
    }
}

#[cfg(target_os = "windows")]
mod live {
    use super::{Win32Overlay, Win32OverlayChrome};
    use crate::error::OverlayError;
    use crate::options::OverlayWindowOptions;

    pub(super) fn create(
        _options: OverlayWindowOptions,
        _chrome: Win32OverlayChrome,
    ) -> Result<Win32Overlay, OverlayError> {
        // A full CreateWindowExW + UpdateLayeredWindow path needs a carefully
        // scoped `unsafe` FFI surface and a message pump. Ship the validated
        // chrome contract first; live window creation is the next Windows-host
        // increment and must not pretend to succeed from a non-Windows builder.
        Err(OverlayError::NativeWindow(
            "Win32 CreateWindowExW overlay is compiled for Windows hosts only; complete the live path on a Windows builder",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_win32_chrome, layered_click_through_ex_style, validate_win32_chrome,
        win32_chrome_from_options, Win32Overlay, HWND_NOTOPMOST, HWND_TOPMOST, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
    };
    use crate::chrome::{WindowChrome, WindowLevel};
    use crate::error::OverlayError;
    use crate::options::OverlayWindowOptions;

    #[test]
    fn capture_chrome_is_layered_click_through_and_not_topmost() {
        let chrome = capture_win32_chrome();
        assert_eq!(chrome.style, 0x8000_0000);
        assert_eq!(chrome.style, WS_POPUP);
        assert_eq!(chrome.ex_style & WS_EX_LAYERED, WS_EX_LAYERED);
        assert_eq!(chrome.ex_style & WS_EX_TRANSPARENT, WS_EX_TRANSPARENT);
        assert_eq!(chrome.ex_style & WS_EX_TOOLWINDOW, WS_EX_TOOLWINDOW);
        assert_eq!(chrome.ex_style & WS_EX_NOACTIVATE, WS_EX_NOACTIVATE);
        assert_eq!(
            chrome.ex_style,
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        );
        assert_eq!(chrome.ex_style, layered_click_through_ex_style());
        assert_eq!(chrome.insert_after, -2);
        assert_eq!(chrome.insert_after, HWND_NOTOPMOST);
        assert_ne!(chrome.insert_after, HWND_TOPMOST);
        assert_eq!(chrome.update_flags, 0x0000_0002);
        assert_eq!(validate_win32_chrome(chrome), Ok(()));
    }

    #[test]
    fn validate_rejects_hwnd_topmost() {
        let mut chrome = capture_win32_chrome();
        chrome.insert_after = HWND_TOPMOST;
        assert_eq!(
            validate_win32_chrome(chrome),
            Err(OverlayError::NativeWindow(
                "overlay must not use HWND_TOPMOST; OBS Window Capture does not require always-on-top"
            ))
        );
    }

    #[test]
    fn validate_rejects_missing_click_through() {
        let mut chrome = capture_win32_chrome();
        chrome.ex_style = WS_EX_LAYERED;
        assert_eq!(
            validate_win32_chrome(chrome),
            Err(OverlayError::NativeWindow(
                "overlay must set WS_EX_TRANSPARENT so clicks pass through"
            ))
        );
    }

    #[test]
    fn debug_capture_options_map_to_win32_chrome() {
        let options = OverlayWindowOptions::debug_capture();
        assert_eq!(options.title, "Kotoba Beacon Native Transparent Capture");
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, WindowLevel::Normal);
        assert_eq!(options.chrome, WindowChrome::capture_surface());
        let chrome = win32_chrome_from_options(&options).expect("debug capture chrome");
        assert_eq!(chrome, capture_win32_chrome());
        assert_ne!(chrome.insert_after, HWND_TOPMOST);
    }

    #[test]
    fn open_on_non_windows_host_is_unsupported() {
        match Win32Overlay::open(OverlayWindowOptions::debug_capture()) {
            Err(OverlayError::UnsupportedPlatform(message)) => {
                assert_eq!(
                    message,
                    "Windows layered overlay is only created on Windows; this host cannot open a Win32 window"
                );
            }
            Err(OverlayError::NativeWindow(message)) => {
                assert_eq!(
                    message,
                    "Win32 CreateWindowExW overlay is compiled for Windows hosts only; complete the live path on a Windows builder"
                );
            }
            Ok(_) => panic!("Win32 overlay must not open on this host"),
            Err(other) => panic!("unexpected open error: {other}"),
        }
    }
}
