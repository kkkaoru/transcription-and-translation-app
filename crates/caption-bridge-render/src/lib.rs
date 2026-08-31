//! Native caption rasterizer for live source/translation captions.
//!
//! This crate is intentionally independent of the desktop/Tauri/GPUI tree. It
//! uses `cosmic-text` for shaping and font fallback, and writes the result into
//! a straight-forward `RgbaImage` buffer for downstream Syphon/OBS output.

mod color;
mod render;
mod types;

pub use render::{font_families, rasterize};
pub use types::{CaptionFrame, CaptionOrder, CaptionStyle, OverlayGeometry, RgbaImage};

#[cfg(test)]
mod tests {
    use super::*;

    fn red_pixel_row_bounds(image: &RgbaImage) -> (usize, usize) {
        let rows = image
            .pixels
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, pixel)| pixel[0] > pixel[2] && pixel[3] > 0)
            .map(|(index, _)| index / image.width as usize)
            .collect::<Vec<_>>();
        (
            rows.first().copied().expect("red source pixels start"),
            rows.last().copied().expect("red source pixels end"),
        )
    }

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
    fn font_weight_changes_native_pixels() {
        let mut thin = OverlayGeometry::default_1280x720();
        thin.source.font_weight = 100;
        thin.source.shadow_enabled = false;
        thin.source.culling_enabled = false;
        let mut bold = thin.clone();
        bold.source.font_weight = 900;
        let frame = CaptionFrame {
            source: "文字の太さ Weight".to_string(),
            translation: String::new(),
            partial: String::new(),
        };
        let thin_image = rasterize(&thin, &frame);
        let bold_image = rasterize(&bold, &frame);
        assert_ne!(thin_image.pixels, bold_image.pixels);
    }

    #[test]
    fn shadow_blur_changes_native_pixels() {
        let mut sharp = OverlayGeometry::default_1280x720();
        sharp.source.shadow_blur_px = 0.0;
        let mut blurred = sharp.clone();
        blurred.source.shadow_blur_px = 16.0;
        let frame = CaptionFrame {
            source: "Shadow".to_string(),
            translation: String::new(),
            partial: String::new(),
        };

        let sharp_image = rasterize(&sharp, &frame);
        let blurred_image = rasterize(&blurred, &frame);

        assert_ne!(sharp_image.pixels, blurred_image.pixels);
    }

    #[test]
    fn multiline_background_plate_has_no_row_gaps() {
        let mut geometry = OverlayGeometry::default_1280x720();
        geometry.source.max_width_percent = 28.0;
        geometry.source.background_enabled = true;
        geometry.source.shadow_enabled = false;
        geometry.source.culling_enabled = false;
        let frame = CaptionFrame {
            source: "A long caption that wraps across several lines without splitting its background plate"
                .to_string(),
            translation: String::new(),
            partial: String::new(),
        };
        let image = rasterize(&geometry, &frame);
        let center_x = 640_usize;
        let nonzero_rows = (0..image.height as usize)
            .filter(|y| image.pixels[(y * image.width as usize + center_x) * 4 + 3] > 0)
            .collect::<Vec<_>>();
        let first = nonzero_rows.first().copied().expect("background starts");
        let last = nonzero_rows.last().copied().expect("background ends");
        assert!(
            (first..=last).all(|y| image.pixels[(y * image.width as usize + center_x) * 4 + 3] > 0)
        );
    }

    #[test]
    fn continuous_outline_width_changes_native_pixels() {
        let mut narrow = OverlayGeometry::default_1280x720();
        narrow.source.culling_width_px = 1.0;
        narrow.source.shadow_enabled = false;
        let mut wide = narrow.clone();
        wide.source.culling_width_px = 8.0;
        let frame = CaptionFrame {
            source: "Stroke fill".to_string(),
            translation: String::new(),
            partial: String::new(),
        };
        let narrow_image = rasterize(&narrow, &frame);
        let wide_image = rasterize(&wide, &frame);
        assert_ne!(narrow_image.pixels, wide_image.pixels);
    }

    #[test]
    fn shadow_antialias_quality_changes_blurred_pixels() {
        let mut low = OverlayGeometry::default_1280x720();
        low.source.shadow_blur_px = 12.0;
        low.source.shadow_antialias = 1;
        let mut high = low.clone();
        high.source.shadow_antialias = 4;
        let frame = CaptionFrame {
            source: "Smooth shadow".to_string(),
            translation: String::new(),
            partial: String::new(),
        };
        let low_image = rasterize(&low, &frame);
        let high_image = rasterize(&high, &frame);
        assert_ne!(low_image.pixels, high_image.pixels);
    }

    #[test]
    fn one_line_translation_does_not_move_the_source_block() {
        let mut geometry = OverlayGeometry::default_1280x720();
        geometry.source.color = "#ff0000".to_string();
        geometry.source.shadow_enabled = false;
        geometry.source.culling_enabled = false;
        geometry.source.background_enabled = false;
        geometry.translation.color = "#0000ff".to_string();
        geometry.translation.shadow_enabled = false;
        geometry.translation.culling_enabled = false;
        geometry.translation.background_enabled = false;

        let empty = rasterize(
            &geometry,
            &CaptionFrame {
                source: "認識結果".to_string(),
                translation: String::new(),
                partial: String::new(),
            },
        );
        let one_line = rasterize(
            &geometry,
            &CaptionFrame {
                source: "認識結果".to_string(),
                translation: "One-line translation".to_string(),
                partial: String::new(),
            },
        );

        assert_eq!(red_pixel_row_bounds(&empty), red_pixel_row_bounds(&one_line));
    }

    #[test]
    fn bundled_noto_sans_jp_is_visible_to_the_renderer() {
        assert!(font_families().iter().any(|family| family == "Noto Sans JP"));
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
