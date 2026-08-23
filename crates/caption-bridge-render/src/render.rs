//! Core rasterizer: shapes captions with `cosmic-text` and blends them into an
//! RGBA buffer.

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use cosmic_text::fontdb;
use cosmic_text::{
    Align, Attrs, AttrsOwned, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache,
    Weight,
};

use crate::color::parse_hex;
use crate::types::{CaptionFrame, CaptionOrder, CaptionStyle, OverlayGeometry, RgbaImage};

/// Shared renderer state. `FontSystem` is expensive to create and `SwashCache`
/// is reusable, so both are kept behind one process-wide mutex.
struct RenderState {
    font_system: FontSystem,
    swash_cache: SwashCache,
}

impl RenderState {
    fn new() -> Self {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        load_japanese_fonts(&mut db);

        // "ja" locale primes the cosmic-text fallback machinery to prefer
        // Japanese-script faces (Hiragino, YuGothic, etc.) for Han/Hiragana/
        // Katakana when the configured family cannot be resolved exactly.
        let font_system = FontSystem::new_with_locale_and_db("ja".to_string(), db);
        let swash_cache = SwashCache::new();
        Self { font_system, swash_cache }
    }
}

fn init_render_state() -> Mutex<RenderState> {
    Mutex::new(RenderState::new())
}

static RENDER_STATE: LazyLock<Mutex<RenderState>> = LazyLock::new(init_render_state);

/// Return the family names resolved by the same font database used for caption rasterization.
pub fn font_families() -> Vec<String> {
    let guard = RENDER_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut families = guard
        .font_system
        .db()
        .faces()
        .flat_map(|face| face.families.iter().map(|(name, _language)| name.clone()))
        .collect::<Vec<_>>();
    families.sort_unstable();
    families.dedup();
    families
}

/// Candidate names for Japanese/Chinese-compatible fonts that cosmic-text
/// does not discover through `load_system_fonts()` on every platform.
const JP_FONT_CANDIDATES: &[&str] = &[
    "YuGothic-Medium.otf",
    "YuGothic-Bold.otf",
    "YuGothic.ttc",
    "HiraginoKakuGothic.ttc",
    "HiraginoSans.ttc",
    "Hiragino_Sans_JP.ttc",
    "Hiragino_Sans_CNS.ttc",
    "Hiragino_Maru_Gothic_Pro.ttc",
    "ToppanBunkyuGothicPr6N.ttc",
    ".Hiragino Kaku Gothic Pro.ttc",
    ".Hiragino Kaku Gothic ProN.ttc",
    ".Hiragino Mincho ProN.ttc",
];

/// Supplement `load_system_fonts()` with explicit attempts to load common
/// CJK/Japanese fonts. On macOS this searches the `MobileAsset` font bundles.
fn load_japanese_fonts(db: &mut fontdb::Database) {
    for base in [
        "/System/Library/AssetsV2/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font7",
        "/System/Library/AssetsV2/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font5",
        "/System/Library/AssetsV2/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font4",
        "/System/Library/AssetsV2/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font3",
    ] {
        let _ = load_named_fonts_from_dir(db, base);
    }

    for dir in ["/System/Library/Fonts", "/Library/Fonts"] {
        let _ = load_named_fonts_from_dir(db, dir);
    }

    for path in [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/NotoSansCJK/NotoSansCJK-Regular.ttc",
    ] {
        let _ = db.load_font_file(path);
    }
}

fn load_named_fonts_from_dir(db: &mut fontdb::Database, base: &str) -> std::io::Result<()> {
    let base_path = Path::new(base);
    if !base_path.is_dir() {
        return Ok(());
    }

    for entry in std::fs::read_dir(base_path)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if path.extension().and_then(|s| s.to_str()) == Some("asset") {
                let asset_data = path.join("AssetData");
                if asset_data.is_dir() {
                    for file in std::fs::read_dir(&asset_data)? {
                        let file = file?;
                        if let Some(name) = file.file_name().to_str() {
                            if JP_FONT_CANDIDATES.contains(&name) {
                                let _ = db.load_font_file(file.path());
                            }
                        }
                    }
                }
            } else {
                for inner in std::fs::read_dir(&path)? {
                    let inner = inner?;
                    if let Some(name) = inner.file_name().to_str() {
                        if JP_FONT_CANDIDATES.contains(&name) {
                            let _ = db.load_font_file(inner.path());
                        }
                    }
                }
            }
        } else if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if JP_FONT_CANDIDATES.contains(&name) {
                let _ = db.load_font_file(path);
            }
        }
    }

    Ok(())
}

/// In-memory RGBA target for a single frame.
struct PixelBuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl PixelBuffer {
    fn new(width: u32, height: u32) -> Self {
        let pixels = vec![0; (width as usize) * (height as usize) * 4];
        Self { width, height, pixels }
    }

    /// Blend a single pixel over the current buffer contents using the
    /// source-over operator. Output is stored in pre-multiplied RGBA.
    fn blend(&mut self, x: i32, y: i32, color: Color, global_alpha: f32) {
        if x < 0 || y < 0 {
            return;
        }
        let x = x as u32;
        let y = y as u32;
        if x >= self.width || y >= self.height {
            return;
        }

        let idx = ((y * self.width + x) * 4) as usize;
        let src_a = (color.a() as f32 / 255.0) * global_alpha.clamp(0.0, 1.0);
        if src_a <= 0.0 {
            return;
        }

        let sr = color.r() as f32 / 255.0;
        let sg = color.g() as f32 / 255.0;
        let sb = color.b() as f32 / 255.0;

        let dst = &mut self.pixels[idx..idx + 4];
        let dr = dst[0] as f32 / 255.0;
        let dg = dst[1] as f32 / 255.0;
        let db = dst[2] as f32 / 255.0;
        let da = dst[3] as f32 / 255.0;

        let inv = 1.0 - src_a;
        let out_a = src_a + da * inv;
        if out_a <= 0.0 {
            dst.fill(0);
            return;
        }

        dst[0] = ((sr * src_a + dr * inv) * 255.0).clamp(0.0, 255.0) as u8;
        dst[1] = ((sg * src_a + dg * inv) * 255.0).clamp(0.0, 255.0) as u8;
        dst[2] = ((sb * src_a + db * inv) * 255.0).clamp(0.0, 255.0) as u8;
        dst[3] = (out_a * 255.0).clamp(0.0, 255.0) as u8;
    }

    /// Blend a solid rectangle, clipping to the buffer edges.
    fn blend_rect(&mut self, x: i32, y: i32, w: u32, h: u32, color: Color, global_alpha: f32) {
        let x0 = x.max(0) as u32;
        let y0 = y.max(0) as u32;
        let x1 = (x as i64 + w as i64).min(self.width as i64) as u32;
        let y1 = (y as i64 + h as i64).min(self.height as i64) as u32;

        for py in y0..y1 {
            for px in x0..x1 {
                self.blend(px as i32, py as i32, color, global_alpha);
            }
        }
    }
}

/// Position and size of a caption block inside the output image.
#[derive(Clone, Copy)]
struct BlockPlacement {
    content_width: f32,
    left: f32,
    top: f32,
}

/// Integer 2-D point for blit origins and offsets.
#[derive(Clone, Copy)]
struct IPoint {
    x: i32,
    y: i32,
}

/// The returned buffer has size `geometry.width * geometry.height * 4` and is
/// transparent everywhere that is not covered by a glyph, shadow, outline, or
/// background plate. Pixels are stored in pre-multiplied RGBA.
pub fn rasterize(geometry: &OverlayGeometry, frame: &CaptionFrame) -> RgbaImage {
    let source_text = build_source_text(frame);
    let translation_text = frame.translation.clone();

    // Blocks are always stored [source, translation].
    let source_block = (&geometry.source, source_text.as_str());
    let translation_block = (&geometry.translation, translation_text.as_str());

    // DOM / paint order: first element is painted first, so later elements
    // visually overlay earlier ones if they overlap.
    let blocks: [(&CaptionStyle, &str); 2] = match geometry.order {
        CaptionOrder::SourceFirst => [source_block, translation_block],
        CaptionOrder::TranslationFirst => [translation_block, source_block],
    };

    let mut guard = RENDER_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let RenderState { font_system, swash_cache } = &mut *guard;

    let mut content_widths = [0.0_f32; 2];
    let mut heights = [0.0_f32; 2];
    for (idx, (style, text)) in blocks.iter().enumerate() {
        content_widths[idx] = content_width(style, geometry);
        if !text.trim().is_empty() {
            heights[idx] = measure_block(font_system, style, text, content_widths[idx]);
        }
    }

    let center_x = (geometry.width as f32 * geometry.caption_x_percent / 100.0).floor();
    let container_bottom = (geometry.height as f32 * geometry.caption_y_percent / 100.0).floor();

    // Stack from the bottom up, honouring the configured gap.
    let mut tops = [0.0_f32; 2];
    let mut bottom = container_bottom;
    for idx in (0..2).rev() {
        let h = heights[idx];
        if h > 0.0 {
            tops[idx] = bottom - h;
            bottom = tops[idx] - geometry.gap_px;
        }
    }

    let mut output = PixelBuffer::new(geometry.width, geometry.height);

    // Paint in DOM order.
    for (idx, (style, text)) in blocks.iter().enumerate() {
        if heights[idx] > 0.0 {
            let left = center_x - content_widths[idx] / 2.0;
            let placement =
                BlockPlacement { content_width: content_widths[idx], left, top: tops[idx] };
            draw_block(font_system, swash_cache, &mut output, style, text, placement);
        }
    }

    RgbaImage {
        width: output.width,
        height: output.height,
        stride: output.width * 4,
        pixels: output.pixels,
    }
}

fn build_source_text(frame: &CaptionFrame) -> String {
    let source = frame.source.trim();
    let partial = frame.partial.trim();

    if source.is_empty() && partial.is_empty() {
        return String::new();
    }
    if source.is_empty() {
        return partial.to_string();
    }
    if partial.is_empty() {
        return source.to_string();
    }
    format!("{source} {partial}")
}

fn content_width(style: &CaptionStyle, geometry: &OverlayGeometry) -> f32 {
    let container_width = (geometry.width as f32 - 2.0 * geometry.safe_area_px).max(0.0);
    let max_width = style.max_width_percent / 100.0 * container_width;
    (max_width - 2.0 * style.padding_x).max(1.0)
}

fn parse_text_align(s: &str) -> Align {
    if s.eq_ignore_ascii_case("left") {
        Align::Left
    } else if s.eq_ignore_ascii_case("right") {
        Align::Right
    } else {
        Align::Center
    }
}

fn build_attrs<'a>(style: &'a CaptionStyle, font_system: &FontSystem) -> Attrs<'a> {
    let mut result = Attrs::new();

    for part in style.font_family.split(',') {
        let name = part.trim().trim_matches(&['"', '\''][..]).trim();
        if name.is_empty() {
            continue;
        }

        if name.eq_ignore_ascii_case("sans-serif") {
            result = result.family(Family::SansSerif);
        } else if name.eq_ignore_ascii_case("serif") {
            result = result.family(Family::Serif);
        } else if name.eq_ignore_ascii_case("monospace") {
            result = result.family(Family::Monospace);
        } else if name.eq_ignore_ascii_case("cursive") {
            result = result.family(Family::Cursive);
        } else if name.eq_ignore_ascii_case("fantasy") {
            result = result.family(Family::Fantasy);
        } else if font_system
            .db()
            .faces()
            .any(|face| face.families.iter().any(|(family, _language)| family == name))
        {
            result = result.family(Family::Name(name));
        } else {
            continue;
        }
        break;
    }

    result
        .weight(Weight(style.font_weight))
        .letter_spacing(style.letter_spacing_px / style.font_size_px.max(1.0))
}

fn measure_block(
    font_system: &mut FontSystem,
    style: &CaptionStyle,
    text: &str,
    content_width: f32,
) -> f32 {
    let attrs = build_attrs(style, font_system);
    let metrics = Metrics::new(style.font_size_px, style.font_size_px * style.line_height);
    let mut buffer = Buffer::new(font_system, metrics);
    let mut buffer = buffer.borrow_with(font_system);
    buffer.set_size(Some(content_width), None);

    let attrs_owned = AttrsOwned::new(&attrs);
    buffer.set_text(
        text,
        &attrs_owned.as_attrs(),
        Shaping::Advanced,
        Some(parse_text_align(&style.text_align)),
    );

    buffer.shape_until_scroll(true);

    let mut height = 0.0_f32;
    for run in buffer.layout_runs() {
        height = height.max(run.line_top + run.line_height);
    }
    height
}

fn draw_block(
    font_system: &mut FontSystem,
    swash_cache: &mut SwashCache,
    output: &mut PixelBuffer,
    style: &CaptionStyle,
    text: &str,
    placement: BlockPlacement,
) {
    if text.trim().is_empty() {
        return;
    }

    let attrs = build_attrs(style, font_system);
    let metrics = Metrics::new(style.font_size_px, style.font_size_px * style.line_height);
    let mut buffer = Buffer::new(font_system, metrics);
    let mut buffer = buffer.borrow_with(font_system);
    buffer.set_size(Some(placement.content_width), None);

    let attrs_owned = AttrsOwned::new(&attrs);
    buffer.set_text(
        text,
        &attrs_owned.as_attrs(),
        Shaping::Advanced,
        Some(parse_text_align(&style.text_align)),
    );
    buffer.shape_until_scroll(true);

    // 1) Background plate (if enabled).
    if style.background_enabled {
        let mut text_height = 0.0_f32;
        for run in buffer.layout_runs() {
            text_height = text_height.max(run.line_top + run.line_height);
        }

        if let Some((r, g, b)) = parse_hex(&style.background_color) {
            let alpha = (style.background_opacity.clamp(0.0, 1.0) * 255.0) as u8;
            let color = Color::rgba(r, g, b, alpha);
            let plate_left = (placement.left - style.padding_x) as i32;
            let plate_top = (placement.top - style.padding_y) as i32;
            let plate_w = (placement.content_width + 2.0 * style.padding_x).max(0.0) as u32;
            let plate_h = (text_height + 2.0 * style.padding_y).max(0.0) as u32;
            output.blend_rect(plate_left, plate_top, plate_w, plate_h, color, 1.0);
        }
    }

    let origin = IPoint { x: placement.left as i32, y: placement.top as i32 };

    // 2) Shadow. Render one antialiased glyph mask and blur its alpha with
    // separable box passes. This avoids the jagged, disconnected silhouettes
    // produced by stamping glyphs at a handful of integer offsets.
    if style.shadow_enabled {
        if let Some((r, g, b)) = parse_hex(&style.shadow_color) {
            let color = Color::rgb(r, g, b);
            let offset =
                IPoint { x: style.shadow_offset_x as i32, y: style.shadow_offset_y as i32 };
            let mut shadow_layer = PixelBuffer::new(output.width, output.height);
            draw_pass(
                &mut buffer,
                swash_cache,
                &mut shadow_layer,
                origin,
                color,
                style.opacity.clamp(0.0, 1.0),
                offset,
            );
            let passes = usize::from(style.shadow_antialias.clamp(1, 4));
            let radius =
                (style.shadow_blur_px.max(0.0) / (2.0 * (passes as f32).sqrt())).ceil() as usize;
            let alpha = blur_alpha(&shadow_layer, radius, passes);
            composite_shadow(output, &alpha, color);
        }
    }

    // 3) Culling / outline. Browser engines paint a continuous glyph stroke,
    // then paint the fill over its inner half for `paint-order: stroke fill`.
    // Dilating the antialiased glyph coverage with a circular kernel provides
    // the same centered-stroke geometry without disconnected offset stamps.
    if style.culling_enabled && style.culling_width_px > 0.0 {
        if let Some((r, g, b)) = parse_hex(&style.culling_color) {
            let color = Color::rgb(r, g, b);
            let mut glyph_mask = PixelBuffer::new(output.width, output.height);
            draw_pass(
                &mut buffer,
                swash_cache,
                &mut glyph_mask,
                origin,
                Color::rgb(255, 255, 255),
                1.0,
                IPoint { x: 0, y: 0 },
            );
            let alpha = stroke_alpha(&glyph_mask, style.culling_width_px);
            composite_colored_alpha(output, &alpha, color, style.culling_opacity.clamp(0.0, 1.0));
        }
    }

    // 4) Fill.
    if let Some((r, g, b)) = parse_hex(&style.color) {
        let color = Color::rgb(r, g, b);
        let global_alpha = style.opacity.clamp(0.0, 1.0);
        draw_pass(
            &mut buffer,
            swash_cache,
            output,
            origin,
            color,
            global_alpha,
            IPoint { x: 0, y: 0 },
        );
    }
}

fn stroke_alpha(layer: &PixelBuffer, width: f32) -> Vec<u8> {
    let radius = width.max(0.0);
    let extent = (radius + 1.0).ceil() as isize;
    let kernel = (-extent..=extent)
        .flat_map(|y| {
            (-extent..=extent).filter_map(move |x| {
                let distance = (x as f32).hypot(y as f32);
                let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
                (coverage > 0.0).then_some((x, y, (coverage * 255.0).round() as u8))
            })
        })
        .collect::<Vec<_>>();
    let mut output = vec![0; (layer.width * layer.height) as usize];
    for (index, alpha) in layer
        .pixels
        .chunks_exact(4)
        .map(|pixel| pixel[3])
        .enumerate()
        .filter(|(_, alpha)| *alpha > 0)
    {
        stamp_stroke_pixel(&mut output, layer.width, layer.height, index, alpha, &kernel);
    }
    output
}

fn stamp_stroke_pixel(
    output: &mut [u8],
    width: u32,
    height: u32,
    index: usize,
    alpha: u8,
    kernel: &[(isize, isize, u8)],
) {
    let origin_x = (index % width as usize) as isize;
    let origin_y = (index / width as usize) as isize;
    for (offset_x, offset_y, coverage) in kernel.iter().copied() {
        let x = origin_x + offset_x;
        let y = origin_y + offset_y;
        if x < 0 || y < 0 || x >= width as isize || y >= height as isize {
            continue;
        }
        let target = y as usize * width as usize + x as usize;
        let candidate = (u16::from(alpha) * u16::from(coverage) / 255) as u8;
        output[target] = output[target].max(candidate);
    }
}

fn blur_alpha(layer: &PixelBuffer, radius: usize, passes: usize) -> Vec<u8> {
    let width = layer.width as usize;
    let height = layer.height as usize;
    let mut alpha = layer.pixels.chunks_exact(4).map(|pixel| pixel[3]).collect::<Vec<_>>();
    if radius == 0 {
        return alpha;
    }
    for _ in 0..passes {
        alpha = box_blur_horizontal(&alpha, width, height, radius);
        alpha = box_blur_vertical(&alpha, width, height, radius);
    }
    alpha
}

fn box_blur_horizontal(input: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut output = vec![0; input.len()];
    for y in 0..height {
        blur_horizontal_row(input, &mut output, width, y, radius);
    }
    output
}

fn blur_horizontal_row(input: &[u8], output: &mut [u8], width: usize, y: usize, radius: usize) {
    let divisor = (radius * 2 + 1) as u32;
    let row = y * width;
    let mut sum =
        (0..=radius.min(width.saturating_sub(1))).map(|x| u32::from(input[row + x])).sum::<u32>();
    for x in 0..width {
        output[row + x] = (sum / divisor) as u8;
        if x >= radius {
            sum -= u32::from(input[row + x - radius]);
        }
        if x + radius + 1 < width {
            sum += u32::from(input[row + x + radius + 1]);
        }
    }
}

fn box_blur_vertical(input: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut output = vec![0; input.len()];
    for x in 0..width {
        blur_vertical_column(input, &mut output, width, height, x, radius);
    }
    output
}

fn blur_vertical_column(
    input: &[u8],
    output: &mut [u8],
    width: usize,
    height: usize,
    x: usize,
    radius: usize,
) {
    let divisor = (radius * 2 + 1) as u32;
    let mut sum = (0..=radius.min(height.saturating_sub(1)))
        .map(|y| u32::from(input[y * width + x]))
        .sum::<u32>();
    for y in 0..height {
        output[y * width + x] = (sum / divisor) as u8;
        if y >= radius {
            sum -= u32::from(input[(y - radius) * width + x]);
        }
        if y + radius + 1 < height {
            sum += u32::from(input[(y + radius + 1) * width + x]);
        }
    }
}

fn composite_shadow(output: &mut PixelBuffer, alpha: &[u8], color: Color) {
    composite_colored_alpha(output, alpha, color, 1.0);
}

fn composite_colored_alpha(output: &mut PixelBuffer, alpha: &[u8], color: Color, opacity: f32) {
    for (index, value) in alpha.iter().copied().enumerate().filter(|(_, value)| *value > 0) {
        let x = (index % output.width as usize) as i32;
        let y = (index / output.width as usize) as i32;
        output.blend(x, y, color, f32::from(value) / 255.0 * opacity);
    }
}

fn draw_pass(
    buffer: &mut cosmic_text::BorrowedWithFontSystem<'_, Buffer>,
    swash_cache: &mut SwashCache,
    output: &mut PixelBuffer,
    origin: IPoint,
    color: Color,
    global_alpha: f32,
    offset: IPoint,
) {
    buffer.draw(swash_cache, color, |x, y, w, h, c| {
        let x = x + origin.x + offset.x;
        let y = y + origin.y + offset.y;
        if w == 1 && h == 1 {
            output.blend(x, y, c, global_alpha);
        } else {
            output.blend_rect(x, y, w, h, c, global_alpha);
        }
    });
}
