//! Geometry and title for the OBS capture surface.

use crate::chrome::WindowChrome;
use crate::debug::DEBUG_OVERLAY_TITLE;
use crate::error::OverlayError;

/// Default title shown in the OBS Window Capture picker.
pub const DEFAULT_OVERLAY_TITLE: &str = "Kotoba Beacon Transparent Capture";

/// Default capture width matching the desktop overlay default.
pub const DEFAULT_OVERLAY_WIDTH: f64 = 1280.0;
/// Default capture height matching the desktop overlay default.
pub const DEFAULT_OVERLAY_HEIGHT: f64 = 720.0;

/// Caller-supplied frame and title for [`crate::OverlayWindow::open`].
#[derive(Debug, Clone, PartialEq)]
pub struct OverlayWindowOptions {
    /// Left edge in screen points (AppKit origin is bottom-left).
    pub x: f64,
    /// Bottom edge in screen points.
    pub y: f64,
    /// Content width in points. Must be finite and greater than zero.
    pub width: f64,
    /// Content height in points. Must be finite and greater than zero.
    pub height: f64,
    /// Window title. OBS Window Capture lists this name.
    pub title: String,
    /// Encoded AppKit chrome. Defaults to click-through + Normal level.
    pub chrome: WindowChrome,
}

impl OverlayWindowOptions {
    /// Construct options with the capture-surface chrome defaults.
    pub fn new(x: f64, y: f64, width: f64, height: f64, title: impl Into<String>) -> Self {
        Self { x, y, width, height, title: title.into(), chrome: WindowChrome::capture_surface() }
    }

    /// Validate geometry before talking to AppKit.
    pub fn validate(&self) -> Result<(), OverlayError> {
        if !self.width.is_finite() || self.width <= 0.0 {
            return Err(OverlayError::InvalidFrame("width must be a finite number greater than 0"));
        }
        if !self.height.is_finite() || self.height <= 0.0 {
            return Err(OverlayError::InvalidFrame(
                "height must be a finite number greater than 0",
            ));
        }
        if !self.x.is_finite() {
            return Err(OverlayError::InvalidFrame("x must be finite"));
        }
        if !self.y.is_finite() {
            return Err(OverlayError::InvalidFrame("y must be finite"));
        }
        Ok(())
    }

    /// Options for a Native/GPUI debug Window Capture surface.
    ///
    /// Size matches the desktop overlay default (1280×720). Title is
    /// [`DEBUG_OVERLAY_TITLE`], which is intentionally different from
    /// [`DEFAULT_OVERLAY_TITLE`] so OBS can list both windows. Chrome stays
    /// click-through, chromeless, transparent, and at [`crate::WindowLevel::Normal`].
    ///
    /// After [`crate::OverlayWindow::open`], push [`crate::test_pattern_rgba`] so
    /// the window is visible without live captions. Clicks still pass through;
    /// pixels outside the centered plate stay fully transparent.
    pub fn debug_capture() -> Self {
        Self::new(0.0, 0.0, DEFAULT_OVERLAY_WIDTH, DEFAULT_OVERLAY_HEIGHT, DEBUG_OVERLAY_TITLE)
    }
}

impl Default for OverlayWindowOptions {
    fn default() -> Self {
        Self::new(0.0, 0.0, DEFAULT_OVERLAY_WIDTH, DEFAULT_OVERLAY_HEIGHT, DEFAULT_OVERLAY_TITLE)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        OverlayWindowOptions, DEFAULT_OVERLAY_HEIGHT, DEFAULT_OVERLAY_TITLE, DEFAULT_OVERLAY_WIDTH,
    };
    use crate::chrome::{WindowChrome, WindowLevel};
    use crate::debug::DEBUG_OVERLAY_TITLE;
    use crate::error::OverlayError;

    #[test]
    fn default_options_match_desktop_capture_surface() {
        let options = OverlayWindowOptions::default();
        assert_eq!(options.x, 0.0);
        assert_eq!(options.y, 0.0);
        assert_eq!(options.width, 1280.0);
        assert_eq!(options.height, 720.0);
        assert_eq!(options.title, "Kotoba Beacon Transparent Capture");
        assert_eq!(options.width, DEFAULT_OVERLAY_WIDTH);
        assert_eq!(options.height, DEFAULT_OVERLAY_HEIGHT);
        assert_eq!(options.title, DEFAULT_OVERLAY_TITLE);
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, WindowLevel::Normal);
        assert_eq!(options.chrome.sharing_type, crate::chrome::WindowSharingType::ReadOnly);
        assert_eq!(options.chrome.collection_behavior, 273);
        assert_eq!(options.chrome, WindowChrome::capture_surface());
    }

    #[test]
    fn new_applies_capture_chrome() {
        let options = OverlayWindowOptions::new(12.0, 34.0, 640.0, 360.0, "Custom Capture");
        assert_eq!(options.x, 12.0);
        assert_eq!(options.y, 34.0);
        assert_eq!(options.width, 640.0);
        assert_eq!(options.height, 360.0);
        assert_eq!(options.title, "Custom Capture");
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, WindowLevel::Normal);
        assert!(options.validate().is_ok());
    }

    #[test]
    fn reject_non_positive_width() {
        let options = OverlayWindowOptions::new(0.0, 0.0, 0.0, 720.0, "bad");
        assert_eq!(
            options.validate(),
            Err(OverlayError::InvalidFrame("width must be a finite number greater than 0"))
        );
    }

    #[test]
    fn reject_non_positive_height() {
        let options = OverlayWindowOptions::new(0.0, 0.0, 1280.0, -1.0, "bad");
        assert_eq!(
            options.validate(),
            Err(OverlayError::InvalidFrame("height must be a finite number greater than 0"))
        );
    }

    #[test]
    fn reject_non_finite_origin() {
        let options = OverlayWindowOptions::new(f64::NAN, 0.0, 1280.0, 720.0, "bad");
        assert_eq!(options.validate(), Err(OverlayError::InvalidFrame("x must be finite")));
        let options = OverlayWindowOptions::new(0.0, f64::INFINITY, 1280.0, 720.0, "bad");
        assert_eq!(options.validate(), Err(OverlayError::InvalidFrame("y must be finite")));
    }

    #[test]
    fn debug_capture_uses_native_title_and_default_size() {
        let options = OverlayWindowOptions::debug_capture();
        assert_eq!(options.x, 0.0);
        assert_eq!(options.y, 0.0);
        assert_eq!(options.width, 1280.0);
        assert_eq!(options.height, 720.0);
        assert_eq!(options.title, "Kotoba Beacon Native Transparent Capture");
        assert_ne!(options.title, "Kotoba Beacon Transparent Capture");
        assert_ne!(options.title, DEFAULT_OVERLAY_TITLE);
        assert_eq!(options.title, DEBUG_OVERLAY_TITLE);
        assert_eq!(options.width, DEFAULT_OVERLAY_WIDTH);
        assert_eq!(options.height, DEFAULT_OVERLAY_HEIGHT);
        assert_eq!(options.chrome, WindowChrome::capture_surface());
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, WindowLevel::Normal);
        assert_eq!(options.chrome.sharing_type, crate::chrome::WindowSharingType::ReadOnly);
        assert_eq!(options.chrome.ns_window_sharing_type(), 1);
        assert_eq!(options.chrome.collection_behavior, 273);
        assert!(options.validate().is_ok());
    }
}
