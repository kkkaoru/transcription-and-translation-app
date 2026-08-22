//! Native caption rasterizer for live source/translation captions.
//!
//! This crate is intentionally independent of the desktop/Tauri/GPUI tree. It
//! uses `cosmic-text` for shaping and font fallback, and writes the result into
//! a straight-forward `RgbaImage` buffer for downstream Syphon/OBS output.

mod color;
mod render;
mod types;

pub use render::rasterize;
pub use types::{CaptionFrame, CaptionOrder, CaptionStyle, OverlayGeometry, RgbaImage};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_strings_are_transparent() {
        let geometry = OverlayGeometry::default_1280x720();
        let frame = CaptionFrame::default();
        let image = rasterize(&geometry, &frame);

        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
        assert_eq!(image.stride, image.width * 4);
        assert!(image.pixels.iter().all(|&p| p == 0));
    }

    #[test]
    fn ascii_and_japanese_render() {
        let geometry = OverlayGeometry::default_1280x720();
        let frame = CaptionFrame {
            source: "Hello, world!".to_string(),
            translation: "こんにちは".to_string(),
            partial: String::new(),
        };
        let image = rasterize(&geometry, &frame);

        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
        assert_eq!(image.stride, image.width * 4);
        assert!(image.pixels.iter().any(|&p| p != 0));

        let alpha_count = image.pixels.iter().skip(3).step_by(4).filter(|&&a| a > 0).count();
        assert!(alpha_count > 100);
    }

    #[test]
    fn plate_outline_shadow_do_not_panic() {
        let mut source = CaptionStyle::default_source();
        source.background_enabled = true;
        source.culling_enabled = true;
        source.shadow_enabled = true;

        let mut translation = CaptionStyle::default_translation();
        translation.background_enabled = true;
        translation.culling_enabled = true;
        translation.shadow_enabled = true;

        let mut geometry = OverlayGeometry::default_1280x720();
        geometry.source = source;
        geometry.translation = translation;

        let frame = CaptionFrame {
            source: "Outline, shadow, plate".to_string(),
            translation: "アウトライン".to_string(),
            partial: String::new(),
        };

        let image = rasterize(&geometry, &frame);
        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
    }

    #[test]
    fn translation_first_order_places_translation_lower() {
        let mut geometry = OverlayGeometry::default_1280x720();
        geometry.order = CaptionOrder::TranslationFirst;

        let frame = CaptionFrame {
            source: "source".to_string(),
            translation: "translation".to_string(),
            partial: String::new(),
        };

        let image = rasterize(&geometry, &frame);
        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
        assert!(image.pixels.iter().any(|&p| p != 0));
    }

    #[test]
    fn partial_text_appends_to_source() {
        let geometry = OverlayGeometry::default_1280x720();
        let frame = CaptionFrame {
            source: "hello".to_string(),
            translation: String::new(),
            partial: " world".to_string(),
        };

        let image = rasterize(&geometry, &frame);
        assert_eq!(image.width, 1280);
        assert_eq!(image.height, 720);
        assert!(image.pixels.iter().any(|&p| p != 0));
    }
}
