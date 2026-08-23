/// A complete RGBA pixel buffer returned by [`rasterize`](crate::rasterize).
///
/// Pixels are stored top-to-bottom, left-to-right, in pre-multiplied RGBA order
/// (`[r, g, b, a]`) to match the expectations of downstream Syphon/OBS consumers.
#[derive(Debug, Clone, Default)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixels: Vec<u8>,
}

/// Ordering of the two caption blocks within the overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptionOrder {
    #[default]
    SourceFirst,
    TranslationFirst,
}

impl CaptionOrder {
    /// Parse a persisted order string.
    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("translation-first") {
            Self::TranslationFirst
        } else {
            Self::SourceFirst
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceFirst => "source-first",
            Self::TranslationFirst => "translation-first",
        }
    }
}

impl std::str::FromStr for CaptionOrder {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self::parse(s))
    }
}

/// Visual style for a single caption line.
///
/// Mirrors the persisted `CaptionTextStyle` defaults from the desktop
/// implementation without depending on the Tauri tree.
#[derive(Debug, Clone)]
pub struct CaptionStyle {
    pub font_family: String,
    pub font_size_px: f32,
    pub font_weight: u16,
    pub color: String,
    pub opacity: f32,
    pub letter_spacing_px: f32,
    pub line_height: f32,
    pub text_align: String,
    pub max_width_percent: f32,
    pub culling_enabled: bool,
    pub culling_color: String,
    pub culling_width_px: f32,
    pub culling_opacity: f32,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur_px: f32,
    pub shadow_antialias: u8,
    pub shadow_offset_x: f32,
    pub shadow_offset_y: f32,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub padding_x: f32,
    pub padding_y: f32,
    pub border_radius: f32,
}

impl CaptionStyle {
    pub fn default_source() -> Self {
        Self {
            font_family: "\"Noto Sans JP Variable\", \"Noto Sans JP\", sans-serif".to_string(),
            font_size_px: 36.0,
            font_weight: 750,
            color: "#ffffff".to_string(),
            opacity: 1.0,
            letter_spacing_px: 0.2,
            line_height: 1.3,
            text_align: "center".to_string(),
            max_width_percent: 86.0,
            culling_enabled: true,
            culling_color: "#061018".to_string(),
            culling_width_px: 3.0,
            culling_opacity: 0.92,
            shadow_enabled: true,
            shadow_color: "#000000".to_string(),
            shadow_blur_px: 8.0,
            shadow_antialias: 3,
            shadow_offset_x: 0.0,
            shadow_offset_y: 3.0,
            background_enabled: false,
            background_color: "#061018".to_string(),
            background_opacity: 0.72,
            padding_x: 14.0,
            padding_y: 7.0,
            border_radius: 9.0,
        }
    }

    pub fn default_translation() -> Self {
        let mut s = Self::default_source();
        s.font_size_px = 29.0;
        s.font_weight = 650;
        s.color = "#bfe8ff".to_string();
        s.culling_color = "#07121d".to_string();
        s
    }
}

/// Geometry of the overlay frame.
#[derive(Debug, Clone)]
pub struct OverlayGeometry {
    pub width: u32,
    pub height: u32,
    pub caption_x_percent: f32,
    pub caption_y_percent: f32,
    pub safe_area_px: f32,
    pub gap_px: f32,
    pub order: CaptionOrder,
    pub source: CaptionStyle,
    pub translation: CaptionStyle,
}

impl OverlayGeometry {
    pub fn default_1280x720() -> Self {
        Self {
            width: 1_280,
            height: 720,
            caption_x_percent: 50.0,
            caption_y_percent: 88.0,
            safe_area_px: 42.0,
            gap_px: 14.0,
            order: CaptionOrder::SourceFirst,
            source: CaptionStyle::default_source(),
            translation: CaptionStyle::default_translation(),
        }
    }
}

/// The caption payload to rasterize.
#[derive(Debug, Clone, Default)]
pub struct CaptionFrame {
    pub source: String,
    pub translation: String,
    pub partial: String,
}
