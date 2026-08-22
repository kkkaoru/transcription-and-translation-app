//! Overlay window handle. Live AppKit is macOS-only; Win32 chrome is tested
//! everywhere; Linux is a documented stub.

#[cfg(target_os = "macos")]
use crate::appkit;
use crate::error::OverlayError;
use crate::options::OverlayWindowOptions;

/// Owned handle to the chromeless capture window.
///
/// On Linux every mutating method returns
/// [`OverlayError::UnsupportedPlatform`] naming browser-source port 1521.
pub struct OverlayWindow {
    #[cfg(target_os = "macos")]
    inner: Option<appkit::MacOverlay>,
    #[cfg(not(target_os = "macos"))]
    _private: (),
    options: OverlayWindowOptions,
    click_through: bool,
}

impl OverlayWindow {
    /// Create and show the overlay. Click-through defaults to `true`.
    pub fn open(options: OverlayWindowOptions) -> Result<Self, OverlayError> {
        options.validate()?;
        let click_through = options.chrome.ignores_mouse_events;
        #[cfg(target_os = "macos")]
        {
            let inner = appkit::MacOverlay::open(&options)?;
            Ok(Self { inner: Some(inner), options, click_through })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = options;
            let _ = click_through;
            Err(open_unsupported())
        }
    }

    /// Move and resize the content frame in screen points.
    pub fn set_frame(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), OverlayError> {
        let mut next = self.options.clone();
        next.x = x;
        next.y = y;
        next.width = width;
        next.height = height;
        next.validate()?;
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.as_mut().ok_or(OverlayError::Closed)?;
            inner.set_frame(x, y, width, height)?;
            self.options = next;
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = next;
            Err(open_unsupported())
        }
    }

    /// Replace the window contents with a tightly packed top-to-bottom RGBA buffer.
    ///
    /// Samples are straight (non-premultiplied) 8-bit RGBA. `pixels.len()` must
    /// equal `width * height * 4`. Dimensions must match the current integer
    /// content size.
    pub fn set_pixels(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), OverlayError> {
        crate::pixels::validate_pixel_buffer(
            self.options.width,
            self.options.height,
            width,
            height,
            pixels,
        )?;
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.as_mut().ok_or(OverlayError::Closed)?;
            inner.set_pixels(width, height, pixels)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = pixels;
            Err(open_unsupported())
        }
    }

    /// Ask AppKit to redraw the current contents without replacing pixels.
    pub fn redraw(&mut self) -> Result<(), OverlayError> {
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.as_mut().ok_or(OverlayError::Closed)?;
            inner.redraw()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(open_unsupported())
        }
    }

    /// Enable or disable click-through (`ignoresMouseEvents`).
    pub fn set_click_through(&mut self, enabled: bool) -> Result<(), OverlayError> {
        #[cfg(target_os = "macos")]
        {
            let inner = self.inner.as_mut().ok_or(OverlayError::Closed)?;
            inner.set_click_through(enabled)?;
            self.click_through = enabled;
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = enabled;
            Err(open_unsupported())
        }
    }

    /// Close and release the native window.
    pub fn close(&mut self) -> Result<(), OverlayError> {
        #[cfg(target_os = "macos")]
        {
            if let Some(inner) = self.inner.take() {
                inner.close();
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(open_unsupported())
        }
    }

    /// Current options last successfully applied.
    pub fn options(&self) -> &OverlayWindowOptions {
        &self.options
    }

    /// Whether the window currently ignores mouse events.
    pub fn click_through(&self) -> bool {
        self.click_through
    }
}

#[cfg(not(target_os = "macos"))]
fn open_unsupported() -> OverlayError {
    #[cfg(target_os = "linux")]
    {
        OverlayError::linux_unsupported()
    }
    #[cfg(target_os = "windows")]
    {
        OverlayError::windows_unavailable_on_host()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        OverlayError::macos_only()
    }
}

/// Drain pending native events so a CLI host can keep the overlay visible.
///
/// Safe to call when no overlay exists. Non-macOS returns
/// [`OverlayError::UnsupportedPlatform`].
pub fn pump_native_events() -> Result<(), OverlayError> {
    #[cfg(target_os = "macos")]
    {
        crate::appkit::pump_events()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(open_unsupported())
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::OverlayWindow;
    use crate::debug::test_pattern_rgba;
    use crate::error::OverlayError;
    use crate::options::OverlayWindowOptions;

    #[test]
    fn open_without_main_thread_does_not_panic() {
        let result = OverlayWindow::open(OverlayWindowOptions::default());
        match result {
            Ok(mut window) => {
                let _ = window.close();
            }
            Err(OverlayError::UnsupportedPlatform(_)) | Err(OverlayError::NativeWindow(_)) => {}
            Err(other) => panic!("unexpected open error: {other}"),
        }
    }

    #[test]
    #[ignore = "requires a live macOS display / window server"]
    fn live_nswindow_opens_as_click_through_normal_level() {
        let window = OverlayWindow::open(OverlayWindowOptions::default())
            .expect("live NSWindow should open on a macOS display");
        assert!(window.click_through());
        assert_eq!(window.options().chrome.ignores_mouse_events, true);
        assert_eq!(window.options().chrome.level, crate::chrome::WindowLevel::Normal);
        assert_eq!(window.options().chrome.ns_window_level(), 0);
        drop(window);
    }

    #[test]
    fn debug_pattern_validates_against_debug_capture_frame() {
        let options = OverlayWindowOptions::debug_capture();
        let pixels = test_pattern_rgba(1280, 720).expect("debug pattern");
        assert_eq!(
            crate::pixels::validate_pixel_buffer(options.width, options.height, 1280, 720, &pixels,),
            Ok(())
        );
        assert_eq!(options.title, "Kotoba Beacon Native Transparent Capture");
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, crate::chrome::WindowLevel::Normal);
    }

    #[test]
    #[ignore = "requires a live macOS display / window server"]
    fn live_debug_overlay_opens_with_test_pattern() {
        let mut window = OverlayWindow::open(OverlayWindowOptions::debug_capture())
            .expect("live debug NSWindow should open on a macOS display");
        let pixels = test_pattern_rgba(1280, 720).expect("debug pattern");
        window.set_pixels(1280, 720, &pixels).expect("debug pattern should paint");
        assert!(window.click_through());
        assert_eq!(window.options().title, "Kotoba Beacon Native Transparent Capture");
        assert_eq!(window.options().chrome.level, crate::chrome::WindowLevel::Normal);
        let _ = window.close();
    }
}
