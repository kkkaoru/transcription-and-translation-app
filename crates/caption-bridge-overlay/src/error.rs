//! Structured overlay errors.

use thiserror::Error;

/// Failures from constructing or mutating the overlay window.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum OverlayError {
    /// Overlay windows are not available on this operating system.
    #[error("{0}")]
    UnsupportedPlatform(&'static str),
    /// Width or height is zero or otherwise unusable.
    #[error("overlay frame is invalid: {0}")]
    InvalidFrame(&'static str),
    /// Pixel buffer dimensions do not match the window content size.
    #[error("pixel buffer size does not match the overlay frame: {0}")]
    PixelSizeMismatch(&'static str),
    /// Native windowing refused to create or mutate the window.
    #[error("native overlay failed: {0}")]
    NativeWindow(&'static str),
    /// The overlay has already been closed.
    #[error("overlay window is closed")]
    Closed,
}

/// Linux overlay is not in v1. Point users at Native browser-source port 1521.
pub const LINUX_OVERLAY_UNSUPPORTED: &str = "overlay windows are not available on Linux; use the Native browser-source on http://127.0.0.1:1521 or wait for a future PipeWire path";

/// Windows layered overlay can only be created on a Windows host.
pub const WINDOWS_OVERLAY_HOST_ONLY: &str =
    "Windows layered overlay is only created on Windows; this host cannot open a Win32 window";

/// Generic macOS-only message used when neither AppKit nor Win32 is compiled in.
pub const MACOS_OVERLAY_ONLY: &str = "overlay windows are only available on macOS";

impl OverlayError {
    /// Linux overlay is not in v1.
    pub const fn linux_unsupported() -> Self {
        Self::UnsupportedPlatform(LINUX_OVERLAY_UNSUPPORTED)
    }

    /// Windows overlay backend is compiled but this host is not Windows.
    pub const fn windows_unavailable_on_host() -> Self {
        Self::UnsupportedPlatform(WINDOWS_OVERLAY_HOST_ONLY)
    }

    /// Overlay is macOS-only when neither AppKit nor Win32 is compiled in.
    pub const fn macos_only() -> Self {
        Self::UnsupportedPlatform(MACOS_OVERLAY_ONLY)
    }

    /// Platform-specific unsupported error for the current compile target.
    pub const fn unsupported_on_this_os() -> Self {
        #[cfg(target_os = "linux")]
        {
            return Self::linux_unsupported();
        }
        #[cfg(target_os = "windows")]
        {
            return Self::windows_unavailable_on_host();
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Self::macos_only()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OverlayError, LINUX_OVERLAY_UNSUPPORTED, MACOS_OVERLAY_ONLY, WINDOWS_OVERLAY_HOST_ONLY,
    };

    #[test]
    fn linux_message_names_browser_source() {
        assert_eq!(
            OverlayError::linux_unsupported(),
            OverlayError::UnsupportedPlatform(LINUX_OVERLAY_UNSUPPORTED)
        );
        assert_eq!(
            OverlayError::linux_unsupported().to_string(),
            "overlay windows are not available on Linux; use the Native browser-source on http://127.0.0.1:1521 or wait for a future PipeWire path"
        );
    }

    #[test]
    fn windows_host_message_is_locked() {
        assert_eq!(
            OverlayError::windows_unavailable_on_host(),
            OverlayError::UnsupportedPlatform(WINDOWS_OVERLAY_HOST_ONLY)
        );
        assert_eq!(
            OverlayError::windows_unavailable_on_host().to_string(),
            "Windows layered overlay is only created on Windows; this host cannot open a Win32 window"
        );
    }

    #[test]
    fn macos_only_message_is_locked() {
        assert_eq!(
            OverlayError::macos_only(),
            OverlayError::UnsupportedPlatform(MACOS_OVERLAY_ONLY)
        );
        assert_eq!(
            OverlayError::macos_only().to_string(),
            "overlay windows are only available on macOS"
        );
    }
}
