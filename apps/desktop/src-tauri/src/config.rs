use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Recognition paths exposed by the desktop debug controls.
pub const RECOGNITION_MODES: [&str; 3] = ["parapper-raw", "web-speech", "parapper-azookey"];
/// Preserve the historical Parapper + AzooKey pipeline for new and legacy configs.
pub const DEFAULT_RECOGNITION_MODE: &str = "parapper-azookey";

fn default_recognition_mode() -> String {
    DEFAULT_RECOGNITION_MODE.to_string()
}

fn is_recognition_mode(value: &str) -> bool {
    RECOGNITION_MODES.contains(&value)
}

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

fn default_noise_suppression() -> bool {
    true
}

fn default_adaptive_noise_floor() -> bool {
    true
}

/// The Parapper headless sidecar evaluates VAD frames at this interval by
/// default. Keep the desktop contract explicit so it can be passed to the
/// sidecar command line rather than silently falling back to Parapper's
/// interactive configuration.
pub const DEFAULT_VAD_INTERVAL_MS: u32 = 32;
pub const MIN_VAD_INTERVAL_MS: u32 = 16;
pub const MAX_VAD_INTERVAL_MS: u32 = 128;
pub const VAD_INTERVAL_STEP_MS: u32 = 16;
pub const DEFAULT_VAD_THRESHOLD: f32 = 0.5;
pub const MIN_VAD_THRESHOLD: f32 = 0.0;
pub const MAX_VAD_THRESHOLD: f32 = 1.0;
/// Frontend-compatible fixed silence-gate bounds in dBFS.
///
/// Keep these bounds named (rather than inline at validation call sites) so
/// persisted desktop settings cannot drift from the settings UI contract.
pub const SILENCE_GATE_MIN_DB: f32 = -90.0;
pub const SILENCE_GATE_MAX_DB: f32 = 0.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub input_device_id: String,
    pub sample_rate: u32,
    pub chunk_ms: u32,
    pub silence_gate_db: f32,
    /// Parapper's internal VAD frame interval. This is independent from the
    /// frontend capture window (`chunk_ms`).
    #[serde(default = "default_vad_interval_ms")]
    pub vad_interval_ms: u32,
    /// Silero VAD speech probability threshold passed to Parapper.
    #[serde(default = "default_vad_threshold")]
    pub vad_threshold: f32,
    /// Browser getUserMedia noise suppression / echo cancellation (frontend applies).
    #[serde(default = "default_noise_suppression")]
    pub noise_suppression: bool,
    /// Adaptive noise-floor gate (default). When false, the frontend falls back
    /// to the fixed silence_gate_db threshold.
    #[serde(default = "default_adaptive_noise_floor")]
    pub adaptive_noise_floor: bool,
}

fn default_vad_interval_ms() -> u32 {
    DEFAULT_VAD_INTERVAL_MS
}

fn default_vad_threshold() -> f32 {
    DEFAULT_VAD_THRESHOLD
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

fn default_log_level() -> String {
    "info".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    /// When true, backend stage logs include truncated input/output samples.
    #[serde(default)]
    pub verbose_logging: bool,
    /// Structured log severity: error | warn | info | debug | trace.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

impl Default for DebugConfig {
    fn default() -> Self {
        Self { verbose_logging: false, log_level: default_log_level() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub schema_version: u8,
    /// Recognition path selected by the live/debug UI.
    #[serde(default = "default_recognition_mode")]
    pub recognition_mode: String,
    pub language: LanguageConfig,
    pub endpoint: BackendEndpoint,
    pub models: ModelSelection,
    pub audio: AudioConfig,
    pub overlay: OverlayConfig,
    #[serde(default)]
    pub debug: DebugConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            recognition_mode: default_recognition_mode(),
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
                // ~640ms reduces time-to-first-subtitle while staying long enough for Parapper.
                chunk_ms: 640,
                // Match frontend DEFAULT_SILENCE_GATE_DB: drop ambient ~-54 dBFS
                // so quiet raw-capture noise never hits Parapper.
                silence_gate_db: -50.0,
                vad_interval_ms: DEFAULT_VAD_INTERVAL_MS,
                vad_threshold: DEFAULT_VAD_THRESHOLD,
                // Match frontend: noise cancelling on by default.
                noise_suppression: true,
                // Match frontend DEFAULT_ADAPTIVE_NOISE_FLOOR: adaptive floor gate on.
                adaptive_noise_floor: true,
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
            debug: DebugConfig::default(),
        }
    }
}

impl AppConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported config schema version".to_string());
        }
        if !is_recognition_mode(&self.recognition_mode) {
            return Err("recognition mode is invalid".to_string());
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
        validate_finite_range(
            "audio silence gate",
            self.audio.silence_gate_db,
            SILENCE_GATE_MIN_DB,
            SILENCE_GATE_MAX_DB,
        )?;
        if !(MIN_VAD_INTERVAL_MS..=MAX_VAD_INTERVAL_MS).contains(&self.audio.vad_interval_ms)
            || !(self.audio.vad_interval_ms - MIN_VAD_INTERVAL_MS)
                .is_multiple_of(VAD_INTERVAL_STEP_MS)
        {
            return Err("audio VAD interval is outside the supported range".to_string());
        }
        validate_finite_range(
            "audio VAD threshold",
            self.audio.vad_threshold,
            MIN_VAD_THRESHOLD,
            MAX_VAD_THRESHOLD,
        )?;
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
    use super::{
        AppConfig, AudioConfig, DEFAULT_RECOGNITION_MODE, DEFAULT_VAD_INTERVAL_MS,
        DEFAULT_VAD_THRESHOLD, SILENCE_GATE_MAX_DB, SILENCE_GATE_MIN_DB,
    };

    #[test]
    fn default_config_is_valid() {
        let config = AppConfig::default();
        assert!(config.validate().is_ok());
        assert!(!config.debug.verbose_logging);
        assert_eq!(config.debug.log_level, "info");
        assert!(config.audio.noise_suppression);
        assert!(config.audio.adaptive_noise_floor);
        assert_eq!(config.audio.vad_interval_ms, DEFAULT_VAD_INTERVAL_MS);
        assert_eq!(config.audio.vad_threshold, DEFAULT_VAD_THRESHOLD);
        assert_eq!(config.recognition_mode, DEFAULT_RECOGNITION_MODE);
    }

    #[test]
    fn recognition_mode_round_trips_and_defaults_for_legacy_json() {
        let config =
            AppConfig { recognition_mode: "web-speech".to_string(), ..AppConfig::default() };
        let value = serde_json::to_value(&config).expect("desktop config should serialize");
        assert_eq!(value["recognitionMode"], "web-speech");
        assert!(!value.as_object().unwrap().contains_key("recognition_mode"));

        let roundtrip: AppConfig =
            serde_json::from_value(value).expect("desktop config should deserialize");
        assert_eq!(roundtrip.recognition_mode, "web-speech");

        let mut legacy = serde_json::to_value(AppConfig::default()).expect("serialize default");
        legacy.as_object_mut().expect("config object").remove("recognitionMode");
        let legacy_config: AppConfig =
            serde_json::from_value(legacy).expect("legacy config should deserialize");
        assert_eq!(legacy_config.recognition_mode, DEFAULT_RECOGNITION_MODE);
    }

    #[test]
    fn recognition_mode_validation_rejects_unknown_values() {
        let config =
            AppConfig { recognition_mode: "future-mode".to_string(), ..AppConfig::default() };
        assert_eq!(config.validate(), Err("recognition mode is invalid".to_string()));
    }

    #[test]
    fn legacy_audio_without_vad_fields_uses_safe_defaults() {
        let audio: AudioConfig = serde_json::from_str(
            r#"{
                "inputDeviceId": "default",
                "sampleRate": 16000,
                "chunkMs": 640,
                "silenceGateDb": -50
            }"#,
        )
        .expect("legacy audio config should deserialize");

        assert_eq!(audio.vad_interval_ms, DEFAULT_VAD_INTERVAL_MS);
        assert_eq!(audio.vad_threshold, DEFAULT_VAD_THRESHOLD);
        assert!(audio.noise_suppression);
        assert!(audio.adaptive_noise_floor);
    }

    #[test]
    fn vad_fields_validate_range_and_alignment() {
        let mut config = AppConfig::default();
        for interval in [16, 32, 64, 128] {
            config.audio.vad_interval_ms = interval;
            assert!(config.validate().is_ok(), "{interval}ms should be accepted");
        }
        for interval in [0, 15, 17, 129] {
            config.audio.vad_interval_ms = interval;
            assert!(config.validate().is_err(), "{interval}ms should be rejected");
        }

        config.audio.vad_interval_ms = DEFAULT_VAD_INTERVAL_MS;
        for threshold in [0.0, 0.5, 1.0] {
            config.audio.vad_threshold = threshold;
            assert!(config.validate().is_ok(), "threshold {threshold} should be accepted");
        }
        for threshold in [-0.01, 1.01, f32::NAN, f32::INFINITY] {
            config.audio.vad_threshold = threshold;
            assert!(config.validate().is_err(), "threshold {threshold:?} should be rejected");
        }
    }

    #[test]
    fn vad_fields_round_trip_with_camel_case_storage_names() {
        let mut config = AppConfig::default();
        config.audio.vad_interval_ms = 64;
        config.audio.vad_threshold = 0.25;

        let value = serde_json::to_value(&config).expect("desktop config should serialize");
        assert_eq!(value["audio"]["vadIntervalMs"], 64);
        assert_eq!(value["audio"]["vadThreshold"], 0.25);
        assert!(!value["audio"].as_object().unwrap().contains_key("vad_interval_ms"));

        let roundtrip: AppConfig =
            serde_json::from_value(value).expect("desktop config should deserialize");
        assert_eq!(roundtrip.audio.vad_interval_ms, 64);
        assert!((roundtrip.audio.vad_threshold - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn silence_gate_bounds_match_frontend_and_reject_stale_persisted_values() {
        let mut config = AppConfig::default();
        for value in [SILENCE_GATE_MIN_DB, SILENCE_GATE_MAX_DB] {
            config.audio.silence_gate_db = value;
            assert!(config.validate().is_ok(), "{value} dB should be accepted");
        }

        // A config persisted by an older build could contain -100 dB, which
        // used to pass the Rust-only -120 dB validation while the frontend
        // clamps to -90 dB. Keep loading and validation separate, but reject
        // the stale value before it reaches the capture pipeline.
        let mut persisted = serde_json::to_value(AppConfig::default())
            .expect("default desktop config should serialize");
        persisted["audio"]["silenceGateDb"] = serde_json::json!(-100.0);
        let persisted_config: AppConfig =
            serde_json::from_value(persisted).expect("persisted config should deserialize");
        assert_eq!(
            persisted_config.validate(),
            Err("audio silence gate is outside the supported range".to_string())
        );
    }

    #[test]
    fn noise_suppression_defaults_true_when_missing_from_json() {
        let config: AppConfig = serde_json::from_str(
            r##"{
            "schemaVersion": 1,
            "language": { "source": "ja", "target": "en" },
            "endpoint": {
                "mode": "local",
                "baseUrl": "http://127.0.0.1:8765",
                "transcriptionPath": "/v1/audio/transcriptions",
                "chatPath": "/v1/chat/completions",
                "timeoutMs": 18000
            },
            "models": {
                "asr": "parapper-ja",
                "normalizer": "azookey-rust",
                "translator": "hy-mt2-1.8b-gguf",
                "paths": {}
            },
            "audio": {
                "inputDeviceId": "default",
                "sampleRate": 16000,
                "chunkMs": 900,
                "silenceGateDb": -50.0
            },
            "overlay": {
                "width": 1280,
                "height": 720,
                "x": 0,
                "y": 0,
                "order": "source-first",
                "gapPx": 8.0,
                "safeAreaPx": 42.0,
                "captionXPercent": 50.0,
                "captionYPercent": 86.0,
                "source": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 36.0,
                    "fontWeight": 700,
                    "color": "#ffffff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#061018",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                },
                "translation": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 29.0,
                    "fontWeight": 650,
                    "color": "#bfe8ff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#07121d",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                }
            }
        }"##,
        )
        .expect("legacy audio without noiseSuppression should deserialize");
        assert!(config.audio.noise_suppression);
        assert!(
            config.audio.adaptive_noise_floor,
            "legacy audio without adaptiveNoiseFloor should default to the adaptive gate"
        );
    }

    #[test]
    fn adaptive_noise_floor_respects_explicit_false() {
        let config: AppConfig = serde_json::from_str(
            r##"{
            "schemaVersion": 1,
            "language": { "source": "ja", "target": "en" },
            "endpoint": {
                "mode": "local",
                "baseUrl": "http://127.0.0.1:8765",
                "transcriptionPath": "/v1/audio/transcriptions",
                "chatPath": "/v1/chat/completions",
                "timeoutMs": 18000
            },
            "models": {
                "asr": "parapper-ja",
                "normalizer": "azookey-rust",
                "translator": "hy-mt2-1.8b-gguf",
                "paths": {}
            },
            "audio": {
                "inputDeviceId": "default",
                "sampleRate": 16000,
                "chunkMs": 900,
                "silenceGateDb": -48.0,
                "noiseSuppression": true,
                "adaptiveNoiseFloor": false
            },
            "overlay": {
                "width": 1280,
                "height": 720,
                "x": 0,
                "y": 0,
                "order": "source-first",
                "gapPx": 8.0,
                "safeAreaPx": 42.0,
                "captionXPercent": 50.0,
                "captionYPercent": 86.0,
                "source": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 36.0,
                    "fontWeight": 700,
                    "color": "#ffffff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#061018",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                },
                "translation": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 29.0,
                    "fontWeight": 650,
                    "color": "#bfe8ff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#07121d",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                }
            }
        }"##,
        )
        .expect("explicit adaptiveNoiseFloor false should deserialize");
        assert!(!config.audio.adaptive_noise_floor);
        assert!(
            config.validate().is_ok(),
            "fixed gate mode with a custom silence gate must still validate"
        );
    }

    #[test]
    fn debug_config_defaults_when_missing_from_json() {
        // Use r## so JSON color values like "#ffffff" do not terminate the raw string.
        let raw = r##"{
            "schemaVersion": 1,
            "language": { "source": "ja", "target": "en" },
            "endpoint": {
                "mode": "local",
                "baseUrl": "http://127.0.0.1:8765",
                "transcriptionPath": "/v1/audio/transcriptions",
                "chatPath": "/v1/chat/completions",
                "timeoutMs": 18000
            },
            "models": {
                "asr": "parapper-ja",
                "normalizer": "azookey-rust",
                "translator": "hy-mt2-1.8b-gguf",
                "paths": {}
            },
            "audio": {
                "inputDeviceId": "default",
                "sampleRate": 16000,
                "chunkMs": 900,
                "silenceGateDb": -55.0
            },
            "overlay": {
                "width": 1280,
                "height": 720,
                "x": 0,
                "y": 0,
                "order": "source-first",
                "gapPx": 8.0,
                "safeAreaPx": 42.0,
                "captionXPercent": 50.0,
                "captionYPercent": 86.0,
                "source": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 36.0,
                    "fontWeight": 700,
                    "color": "#ffffff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#061018",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                },
                "translation": {
                    "fontFamily": "Noto Sans JP",
                    "fontSizePx": 29.0,
                    "fontWeight": 650,
                    "color": "#bfe8ff",
                    "opacity": 1.0,
                    "letterSpacingPx": 0.2,
                    "lineHeight": 1.3,
                    "textAlign": "center",
                    "maxWidthPercent": 86.0,
                    "cullingEnabled": true,
                    "cullingColor": "#07121d",
                    "cullingWidthPx": 3.0,
                    "cullingOpacity": 0.92,
                    "shadowEnabled": true,
                    "shadowColor": "#000000",
                    "shadowBlurPx": 8.0,
                    "shadowOffsetX": 0.0,
                    "shadowOffsetY": 3.0,
                    "backgroundEnabled": false,
                    "backgroundColor": "#061018",
                    "backgroundOpacity": 0.72,
                    "paddingX": 14.0,
                    "paddingY": 7.0,
                    "borderRadius": 9.0
                }
            }
        }"##;
        let config: AppConfig = serde_json::from_str(raw).expect("parse config without debug");
        assert!(!config.debug.verbose_logging);
        assert_eq!(config.debug.log_level, "info");
        let with_debug = r#"{ "verboseLogging": true, "logLevel": "trace" }"#;
        let debug: super::DebugConfig = serde_json::from_str(with_debug).expect("parse debug");
        assert!(debug.verbose_logging);
        assert_eq!(debug.log_level, "trace");
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
