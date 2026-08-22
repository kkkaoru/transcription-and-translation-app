//! Display-free debug frame for the Native/GPUI OBS Window Capture surface.
//!
//! A fully transparent window is invisible to a human and easy to miss in OBS.
//! [`test_pattern_rgba`] paints a known, non-zero-alpha fixture so a caller can
//! open the overlay and confirm click-through, stacking, and alpha without live
//! captions. Buffers are straight (non-premultiplied) RGBA8.
//! [`half_alpha_pixel_rgba`] is the mutation fixture for that contract: full red
//! at alpha `128`, not the premultiplied `[128, 0, 0, 128]`.
//!
//! # How to verify a debug overlay
//!
//! 1. Open with [`crate::OverlayWindowOptions::debug_capture`] and push
//!    [`test_pattern_rgba`] through [`crate::OverlayWindow::set_pixels`].
//! 2. Click-through: the window ignores mouse events. Clicks land on the desktop
//!    or the app behind it, including over the opaque plate.
//! 3. Not floating: chrome stays at [`crate::WindowLevel::Normal`]. The surface
//!    is not always-on-top; it can sit behind other windows.
//! 4. Transparent outside the plate: pixels around the centered plate and
//!    outside the corner marks have alpha `0`. OBS Window Capture should keep
//!    that alpha when the source actually keeps it. Current OBS macOS Screen
//!    Capture uses FourCC `l10r` (no alpha); classic Window Capture emits BGRA
//!    but does not document per-pixel alpha of a clear `NSWindow`. Syphon is
//!    the guaranteed alpha path. The title is
//!    [`DEBUG_OVERLAY_TITLE`] (`Kotoba Beacon Native Transparent Capture`),
//!    distinct from the desktop Tauri title
//!    (`Kotoba Beacon Transparent Capture`).

use crate::error::OverlayError;

/// OBS Window Capture title for the Native/GPUI debug surface.
///
/// Must stay distinct from the desktop Tauri overlay title
/// (`Kotoba Beacon Transparent Capture`) so both windows can appear in the
/// picker at once.
pub const DEBUG_OVERLAY_TITLE: &str = "Kotoba Beacon Native Transparent Capture";

/// RGBA channel count for tightly packed 8-bit pixels.
pub const RGBA_CHANNELS: usize = 4;

/// Straight (non-premultiplied) half-alpha channel used by the mutation fixture.
///
/// `128 / 255` is the mid-alpha sample that would become `[128, 0, 0, 128]` if
/// AppKit treated the buffer as premultiplied. Overlay pixels stay unscaled.
pub const STRAIGHT_HALF_ALPHA: u8 = 128;

/// One-pixel straight RGBA fixture: full red, half alpha, not premultiplied.
pub const HALF_ALPHA_PIXEL_RGBA: [u8; RGBA_CHANNELS] = [255, 0, 0, STRAIGHT_HALF_ALPHA];

/// Corner-mark arm length in pixels.
pub const CORNER_MARK_SIZE: u32 = 24;

/// Corner-mark stroke thickness in pixels.
pub const CORNER_MARK_THICKNESS: u32 = 4;

/// Centered plate width as a fraction of the frame width.
pub const PLATE_WIDTH_RATIO: f64 = 0.5;

/// Centered plate height as a fraction of the frame height.
pub const PLATE_HEIGHT_RATIO: f64 = 0.25;

/// Owned tightly packed top-to-bottom RGBA8 buffer matching `width` × `height`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugOverlayFrame {
    /// Integer pixel width.
    pub width: u32,
    /// Integer pixel height.
    pub height: u32,
    /// Tightly packed RGBA8, length `width * height * 4`.
    pub pixels: Vec<u8>,
}

/// Corner-mark RGBA (opaque magenta). Visible even on a dark OBS preview.
const CORNER_MARK_RGBA: [u8; RGBA_CHANNELS] = [255, 0, 255, 255];
/// Centered plate RGBA (opaque teal). The only large non-transparent region.
const PLATE_RGBA: [u8; RGBA_CHANNELS] = [0, 160, 160, 255];

impl DebugOverlayFrame {
    /// Build a known test pattern for `width` × `height`.
    ///
    /// The frame is fully transparent except for:
    /// - L-shaped opaque marks in each corner
    /// - a centered opaque plate occupying half the width and a quarter of the
    ///   height
    pub fn test_pattern(width: u32, height: u32) -> Result<Self, OverlayError> {
        Ok(Self { width, height, pixels: test_pattern_rgba(width, height)? })
    }
}

/// Allocate a tightly packed RGBA8 test pattern.
///
/// Returns [`OverlayError::InvalidFrame`] when either dimension is zero.
/// The buffer is owned so a Native/GPUI caller can pass it to
/// [`crate::OverlayWindow::set_pixels`] without depending on the rasterizer.
pub fn test_pattern_rgba(width: u32, height: u32) -> Result<Vec<u8>, OverlayError> {
    if width == 0 {
        return Err(OverlayError::InvalidFrame("width must be a finite number greater than 0"));
    }
    if height == 0 {
        return Err(OverlayError::InvalidFrame("height must be a finite number greater than 0"));
    }
    let len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|area| area.checked_mul(RGBA_CHANNELS))
        .ok_or(OverlayError::PixelSizeMismatch("pixel buffer dimensions overflow"))?;
    let mut pixels = vec![0_u8; len];
    paint_centered_plate(&mut pixels, width, height);
    paint_corner_marks(&mut pixels, width, height);
    Ok(pixels)
}

/// Allocate a 1×1 straight RGBA8 buffer with half alpha and unscaled color.
///
/// The pixel is `[255, 0, 0, 128]`, not the premultiplied `[128, 0, 0, 128]`.
/// [`crate::pixels::validate_pixel_buffer`] accepts it so a unit test can lock
/// the contract without opening an `NSWindow`.
pub fn half_alpha_pixel_rgba() -> [u8; RGBA_CHANNELS] {
    HALF_ALPHA_PIXEL_RGBA
}

fn paint_centered_plate(pixels: &mut [u8], width: u32, height: u32) {
    let plate_w = ((width as f64) * PLATE_WIDTH_RATIO).round().max(1.0) as u32;
    let plate_h = ((height as f64) * PLATE_HEIGHT_RATIO).round().max(1.0) as u32;
    let plate_w = plate_w.min(width);
    let plate_h = plate_h.min(height);
    let origin_x = (width - plate_w) / 2;
    let origin_y = (height - plate_h) / 2;
    fill_rect(pixels, width, origin_x, origin_y, plate_w, plate_h, PLATE_RGBA);
}

fn paint_corner_marks(pixels: &mut [u8], width: u32, height: u32) {
    let arm = CORNER_MARK_SIZE.min(width).min(height);
    let stroke = CORNER_MARK_THICKNESS.min(arm);
    if arm == 0 || stroke == 0 {
        return;
    }
    let right = width.saturating_sub(arm);
    let bottom = height.saturating_sub(arm);

    fill_rect(pixels, width, 0, 0, arm, stroke, CORNER_MARK_RGBA);
    fill_rect(pixels, width, 0, 0, stroke, arm, CORNER_MARK_RGBA);

    fill_rect(pixels, width, right, 0, arm, stroke, CORNER_MARK_RGBA);
    fill_rect(pixels, width, width.saturating_sub(stroke), 0, stroke, arm, CORNER_MARK_RGBA);

    fill_rect(pixels, width, 0, height.saturating_sub(stroke), arm, stroke, CORNER_MARK_RGBA);
    fill_rect(pixels, width, 0, bottom, stroke, arm, CORNER_MARK_RGBA);

    fill_rect(pixels, width, right, height.saturating_sub(stroke), arm, stroke, CORNER_MARK_RGBA);
    fill_rect(pixels, width, width.saturating_sub(stroke), bottom, stroke, arm, CORNER_MARK_RGBA);
}

fn fill_rect(
    pixels: &mut [u8],
    stride_width: u32,
    origin_x: u32,
    origin_y: u32,
    rect_width: u32,
    rect_height: u32,
    rgba: [u8; RGBA_CHANNELS],
) {
    let max_x = origin_x.saturating_add(rect_width).min(stride_width);
    let max_y = origin_y.saturating_add(rect_height);
    let stride = stride_width as usize;
    let start = origin_x as usize;
    let end = max_x as usize;
    if start >= end {
        return;
    }
    let mut y = origin_y;
    while y < max_y {
        let row = (y as usize).saturating_mul(stride).saturating_add(start);
        let row_end = (y as usize).saturating_mul(stride).saturating_add(end);
        let byte_start = row.saturating_mul(RGBA_CHANNELS);
        let byte_end = row_end.saturating_mul(RGBA_CHANNELS);
        if byte_end > pixels.len() {
            return;
        }
        fill_row(&mut pixels[byte_start..byte_end], rgba);
        y += 1;
    }
}

fn fill_row(row: &mut [u8], rgba: [u8; RGBA_CHANNELS]) {
    let mut offset = 0;
    while offset + 3 < row.len() {
        row[offset] = rgba[0];
        row[offset + 1] = rgba[1];
        row[offset + 2] = rgba[2];
        row[offset + 3] = rgba[3];
        offset += RGBA_CHANNELS;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        half_alpha_pixel_rgba, test_pattern_rgba, DebugOverlayFrame, HALF_ALPHA_PIXEL_RGBA,
        RGBA_CHANNELS, STRAIGHT_HALF_ALPHA,
    };
    use crate::chrome::{WindowChrome, WindowLevel};
    use crate::error::OverlayError;
    use crate::options::OverlayWindowOptions;
    use crate::pixels::validate_pixel_buffer;

    fn pixel_at(pixels: &[u8], width: u32, x: u32, y: u32) -> [u8; RGBA_CHANNELS] {
        let index = ((y as usize) * (width as usize) + (x as usize)) * RGBA_CHANNELS;
        [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]
    }

    #[test]
    fn debug_title_is_not_the_desktop_tauri_title() {
        assert_eq!(super::DEBUG_OVERLAY_TITLE, "Kotoba Beacon Native Transparent Capture");
        assert_ne!(super::DEBUG_OVERLAY_TITLE, "Kotoba Beacon Transparent Capture");
    }

    #[test]
    fn debug_capture_options_use_native_title_and_capture_chrome() {
        let options = OverlayWindowOptions::debug_capture();
        assert_eq!(options.x, 0.0);
        assert_eq!(options.y, 0.0);
        assert_eq!(options.width, 1280.0);
        assert_eq!(options.height, 720.0);
        assert_eq!(options.title, "Kotoba Beacon Native Transparent Capture");
        assert_ne!(options.title, "Kotoba Beacon Transparent Capture");
        assert_eq!(options.chrome, WindowChrome::capture_surface());
        assert!(options.chrome.ignores_mouse_events);
        assert_eq!(options.chrome.level, WindowLevel::Normal);
        assert!(options.chrome.transparent);
        assert!(options.chrome.borderless);
        assert!(!options.chrome.has_shadow);
        assert_eq!(options.chrome.ns_window_level(), 0);
        assert_eq!(options.chrome.ns_window_sharing_type(), 1);
        assert_eq!(options.chrome.collection_behavior, 273);
        assert!(options.validate().is_ok());
    }

    #[test]
    fn test_pattern_matches_default_debug_frame() {
        let pixels = test_pattern_rgba(1280, 720).expect("1280x720 is a valid debug frame");
        assert_eq!(pixels.len(), 3686400);
        assert_eq!(validate_pixel_buffer(1280.0, 720.0, 1280, 720, &pixels), Ok(()));
        let frame = DebugOverlayFrame::test_pattern(1280, 720).expect("owned frame");
        assert_eq!(frame.width, 1280);
        assert_eq!(frame.height, 720);
        assert_eq!(frame.pixels, pixels);
    }

    #[test]
    fn test_pattern_paints_opaque_corners_and_centered_plate() {
        let pixels = test_pattern_rgba(80, 40).expect("80x40 is a valid debug frame");
        assert_eq!(pixels.len(), 12800);

        assert_eq!(pixel_at(&pixels, 80, 0, 0), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 80, 79, 0), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 80, 0, 39), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 80, 79, 39), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 80, 23, 0), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 80, 0, 3), [255, 0, 255, 255]);

        assert_eq!(pixel_at(&pixels, 80, 20, 15), [0, 160, 160, 255]);
        assert_eq!(pixel_at(&pixels, 80, 59, 24), [0, 160, 160, 255]);

        assert_eq!(pixel_at(&pixels, 80, 40, 2), [0, 0, 0, 0]);
        assert_eq!(pixel_at(&pixels, 80, 10, 20), [0, 0, 0, 0]);
        assert_eq!(pixel_at(&pixels, 80, 40, 5), [0, 0, 0, 0]);
        assert_eq!(pixels[1763], 0);
    }

    #[test]
    fn test_pattern_rejects_zero_dimensions() {
        assert_eq!(
            test_pattern_rgba(0, 720),
            Err(OverlayError::InvalidFrame("width must be a finite number greater than 0"))
        );
        assert_eq!(
            test_pattern_rgba(1280, 0),
            Err(OverlayError::InvalidFrame("height must be a finite number greater than 0"))
        );
        assert_eq!(
            DebugOverlayFrame::test_pattern(0, 1),
            Err(OverlayError::InvalidFrame("width must be a finite number greater than 0"))
        );
    }

    #[test]
    fn one_by_one_pattern_is_the_opaque_corner_mark() {
        let pixels = test_pattern_rgba(1, 1).expect("1x1 still paints a visible pixel");
        assert_eq!(pixels, vec![255, 0, 255, 255]);
    }

    #[test]
    fn thirty_two_square_keeps_plate_and_transparent_field() {
        let pixels = test_pattern_rgba(32, 32).expect("32x32 is a valid debug frame");
        assert_eq!(pixels.len(), 4096);
        assert_eq!(pixel_at(&pixels, 32, 0, 0), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 32, 31, 0), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 32, 0, 31), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 32, 31, 31), [255, 0, 255, 255]);
        assert_eq!(pixel_at(&pixels, 32, 8, 12), [0, 160, 160, 255]);
        assert_eq!(pixel_at(&pixels, 32, 23, 19), [0, 160, 160, 255]);
        assert_eq!(pixel_at(&pixels, 32, 16, 6), [0, 0, 0, 0]);
        assert_eq!(pixel_at(&pixels, 32, 5, 16), [0, 0, 0, 0]);
    }

    #[test]
    fn half_alpha_pixel_is_straight_rgba_not_premultiplied() {
        let pixel = half_alpha_pixel_rgba();
        assert_eq!(pixel, [255, 0, 0, 128]);
        assert_eq!(HALF_ALPHA_PIXEL_RGBA, [255, 0, 0, 128]);
        assert_eq!(STRAIGHT_HALF_ALPHA, 128);
        assert_ne!(pixel, [128, 0, 0, 128]);
        assert_eq!(validate_pixel_buffer(1.0, 1.0, 1, 1, &pixel), Ok(()));
    }
}
