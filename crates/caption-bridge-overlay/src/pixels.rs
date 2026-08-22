//! Pixel-buffer checks that do not require AppKit.

use crate::error::OverlayError;

/// Confirm `pixels` is tightly packed RGBA8 matching `width` × `height` and the
/// current overlay frame (rounded to integer points).
pub(crate) fn validate_pixel_buffer(
    frame_width: f64,
    frame_height: f64,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> Result<(), OverlayError> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|area| area.checked_mul(4))
        .ok_or(OverlayError::PixelSizeMismatch("pixel buffer dimensions overflow"))?;
    if pixels.len() != expected {
        return Err(OverlayError::PixelSizeMismatch(
            "pixel buffer length must equal width * height * 4",
        ));
    }
    let frame_w = frame_width.round() as u32;
    let frame_h = frame_height.round() as u32;
    if width != frame_w || height != frame_h {
        return Err(OverlayError::PixelSizeMismatch(
            "pixel buffer size does not match the current overlay frame",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_pixel_buffer;
    use crate::error::OverlayError;

    #[test]
    fn reject_wrong_length() {
        assert_eq!(
            validate_pixel_buffer(1280.0, 720.0, 1280, 720, &[0, 0, 0]),
            Err(OverlayError::PixelSizeMismatch(
                "pixel buffer length must equal width * height * 4"
            ))
        );
    }

    #[test]
    fn reject_mismatched_frame() {
        let pixels = [0_u8; 16];
        assert_eq!(
            validate_pixel_buffer(10.0, 10.0, 2, 2, &pixels),
            Err(OverlayError::PixelSizeMismatch(
                "pixel buffer size does not match the current overlay frame"
            ))
        );
    }

    #[test]
    fn accept_matching_rgba_buffer() {
        let pixels = [0_u8; 16];
        assert_eq!(validate_pixel_buffer(2.0, 2.0, 2, 2, &pixels), Ok(()));
    }
}
