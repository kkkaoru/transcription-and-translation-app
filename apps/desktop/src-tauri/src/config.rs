use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageConfig {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEndpoint {
    pub mode: String,
    pub base_url: String,
    pub transcription_path: String,
    pub chat_path: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub asr: String,
    pub normalizer: String,
    pub translator: String,
    #[serde(default)]
    pub paths: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub input_device_id: String,
    pub sample_rate: u32,
    pub chunk_ms: u32,
    pub silence_gate_db: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTextStyle {
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
    pub shadow_offset_x: f32,
    pub shadow_offset_y: f32,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub padding_x: f32,
    pub padding_y: f32,
    pub border_radius: f32,
}

impl CaptionTextStyle {
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
        Self {
            font_size_px: 29.0,
            font_weight: 650,
            color: "#bfe8ff".to_string(),
            culling_color: "#07121d".to_string(),
            ..Self::default_source()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfig {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub order: String,
    pub gap_px: f32,
    pub safe_area_px: f32,
    #[serde(default = "default_caption_x_percent")]
    pub caption_x_percent: f32,
    #[serde(default = "default_caption_y_percent")]
    pub caption_y_percent: f32,
    pub source: CaptionTextStyle,
    pub translation: CaptionTextStyle,
}

fn default_caption_x_percent() -> f32 {
    50.0
}

fn default_caption_y_percent() -> f32 {
    86.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub schema_version: u8,
    pub language: LanguageConfig,
    pub endpoint: BackendEndpoint,
    pub models: ModelSelection,
    pub audio: AudioConfig,
    pub overlay: OverlayConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            language: LanguageConfig { source: "ja".to_string(), target: "en".to_string() },
            endpoint: BackendEndpoint {
                mode: "local".to_string(),
                base_url: "http://127.0.0.1:8765".to_string(),
                transcription_path: "/v1/audio/transcriptions".to_string(),
                chat_path: "/v1/chat/completions".to_string(),
                timeout_ms: 18_000,
            },
            models: ModelSelection {
                asr: "parapper-ja".to_string(),
                normalizer: "azookey-rust".to_string(),
                translator: "hy-mt2-1.8b-gguf".to_string(),
                paths: HashMap::new(),
            },
            audio: AudioConfig {
                input_device_id: "default".to_string(),
                sample_rate: 16_000,
                // Keep in sync with apps/desktop/src/core/defaults.ts DEFAULT_AUDIO_CHUNK_MS.
                // ~900ms reduces time-to-first-subtitle while staying long enough for Parapper.
                chunk_ms: 900,
                silence_gate_db: -55.0,
            },
            overlay: OverlayConfig {
                width: 1_280,
                height: 720,
                x: 0,
                y: 0,
                order: "source-first".to_string(),
                gap_px: 8.0,
                safe_area_px: 42.0,
                caption_x_percent: default_caption_x_percent(),
                caption_y_percent: default_caption_y_percent(),
                source: CaptionTextStyle::default_source(),
                translation: CaptionTextStyle::default_translation(),
            },
        }
    }
}

impl AppConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported config schema version".to_string());
        }
        if self.language.source.trim().is_empty() || self.language.target.trim().is_empty() {
            return Err("source and target language codes are required".to_string());
        }
        if !(8_000..=96_000).contains(&self.audio.sample_rate) {
            return Err("sample rate is outside the supported range".to_string());
        }
        if !(250..=10_000).contains(&self.audio.chunk_ms) {
            return Err("audio chunk duration is outside the supported range".to_string());
        }
        validate_finite_range("audio silence gate", self.audio.silence_gate_db, -120.0, 0.0)?;
        if self.endpoint.mode != "local" && self.endpoint.mode != "remote" {
            return Err("endpoint mode must be local or remote".to_string());
        }
        if self.endpoint.base_url.trim().is_empty() {
            return Err("inference endpoint URL is required".to_string());
        }
        if !self.endpoint.base_url.starts_with("http://")
            && !self.endpoint.base_url.starts_with("https://")
        {
            return Err("inference endpoint URL must use HTTP or HTTPS".to_string());
        }
        if self.endpoint.timeout_ms < 100 || self.endpoint.timeout_ms > 120_000 {
            return Err("inference timeout is outside the supported range".to_string());
        }
        if self.models.asr.trim().is_empty()
            || self.models.normalizer.trim().is_empty()
            || self.models.translator.trim().is_empty()
        {
            return Err("all model selections are required".to_string());
        }
        if !(320..=7_680).contains(&self.overlay.width)
            || !(180..=4_320).contains(&self.overlay.height)
        {
            return Err("overlay dimensions are outside the supported range".to_string());
        }
        if self.overlay.order != "source-first" && self.overlay.order != "translation-first" {
            return Err("overlay order is invalid".to_string());
        }
        validate_finite_range("overlay gap", self.overlay.gap_px, 0.0, 500.0)?;
        validate_finite_range("overlay safe area", self.overlay.safe_area_px, 0.0, 2_000.0)?;
        validate_finite_range(
            "caption horizontal position",
            self.overlay.caption_x_percent,
            0.0,
            100.0,
        )?;
        validate_finite_range(
            "caption vertical position",
            self.overlay.caption_y_percent,
            0.0,
            100.0,
        )?;
        validate_text_style("source caption", &self.overlay.source)?;
        validate_text_style("translation caption", &self.overlay.translation)?;
        Ok(())
    }
}

fn validate_text_style(label: &str, style: &CaptionTextStyle) -> Result<(), String> {
    if style.font_family.trim().is_empty() {
        return Err(format!("{label} font family is required"));
    }
    if !matches!(style.text_align.as_str(), "left" | "center" | "right") {
        return Err(format!("{label} text alignment is invalid"));
    }
    for (name, color) in [
        ("color", style.color.as_str()),
        ("culling color", style.culling_color.as_str()),
        ("shadow color", style.shadow_color.as_str()),
        ("background color", style.background_color.as_str()),
    ] {
        if !is_hex_color(color) {
            return Err(format!("{label} {name} must be a #RRGGBB color"));
        }
    }
    validate_finite_range(&format!("{label} font size"), style.font_size_px, 8.0, 256.0)?;
    if !(100..=900).contains(&style.font_weight) {
        return Err(format!("{label} font weight is outside the supported range"));
    }
    validate_finite_range(&format!("{label} opacity"), style.opacity, 0.0, 1.0)?;
    validate_finite_range(
        &format!("{label} letter spacing"),
        style.letter_spacing_px,
        -20.0,
        100.0,
    )?;
    validate_finite_range(&format!("{label} line height"), style.line_height, 0.5, 4.0)?;
    validate_finite_range(&format!("{label} maximum width"), style.max_width_percent, 1.0, 100.0)?;
    validate_finite_range(&format!("{label} culling width"), style.culling_width_px, 0.0, 50.0)?;
    validate_finite_range(&format!("{label} culling opacity"), style.culling_opacity, 0.0, 1.0)?;
    validate_finite_range(&format!("{label} shadow blur"), style.shadow_blur_px, 0.0, 100.0)?;
    validate_finite_range(
        &format!("{label} shadow horizontal offset"),
        style.shadow_offset_x,
        -500.0,
        500.0,
    )?;
    validate_finite_range(
        &format!("{label} shadow vertical offset"),
        style.shadow_offset_y,
        -500.0,
        500.0,
    )?;
    validate_finite_range(
        &format!("{label} background opacity"),
        style.background_opacity,
        0.0,
        1.0,
    )?;
    validate_finite_range(&format!("{label} horizontal padding"), style.padding_x, 0.0, 200.0)?;
    validate_finite_range(&format!("{label} vertical padding"), style.padding_y, 0.0, 200.0)?;
    validate_finite_range(&format!("{label} border radius"), style.border_radius, 0.0, 200.0)
}

fn validate_finite_range(name: &str, value: f32, minimum: f32, maximum: f32) -> Result<(), String> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(format!("{name} is outside the supported range"));
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[test]
    fn default_config_is_valid() {
        assert!(AppConfig::default().validate().is_ok());
    }

    #[test]
    fn rejects_non_finite_style_values() {
        let mut config = AppConfig::default();
        config.overlay.source.font_size_px = f32::NAN;

        assert_eq!(
            config.validate(),
            Err("source caption font size is outside the supported range".to_string())
        );
    }

    #[test]
    fn rejects_unsafe_overlay_dimensions() {
        let mut config = AppConfig::default();
        config.overlay.width = 100_000;

        assert_eq!(
            config.validate(),
            Err("overlay dimensions are outside the supported range".to_string())
        );
    }

    #[test]
    fn rejects_invalid_colors() {
        let mut config = AppConfig::default();
        config.overlay.translation.color = "transparent".to_string();

        assert_eq!(
            config.validate(),
            Err("translation caption color must be a #RRGGBB color".to_string())
        );
    }
}
