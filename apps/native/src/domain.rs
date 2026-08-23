//! Domain types and persistence for the Native GPUI app.
//!
//! These types do not require a display. GPUI views consume them.

#[cfg(any(feature = "gpui", test))]
use std::path::{Path, PathBuf};

use caption_bridge_captions::layout::CaptionOrder as LayoutOrder;
use caption_bridge_captions::layout::{
    CaptionLayoutConfig, SOURCE_CAPTION_MAX_CHARS, TRANSLATION_CAPTION_MAX_CHARS,
};
#[cfg(any(feature = "gpui", test))]
use caption_bridge_dictionary::{
    load_from_directory, save_to_directory, search, CustomDictionaryEntry,
};
use caption_bridge_identity::AppIdentity;
use caption_bridge_render::{
    rasterize, CaptionFrame, CaptionOrder as RenderOrder, CaptionStyle, OverlayGeometry, RgbaImage,
};
use serde::{Deserialize, Serialize};

pub const PRODUCT_NAME: &str = AppIdentity::native().product_name;
pub const BUNDLE_ID: &str = AppIdentity::native().bundle_id;
pub const BINARY_NAME: &str = "kotoba-beacon-native";
#[cfg(feature = "gpui")]
pub const WINDOW_TITLE: &str = PRODUCT_NAME;
#[cfg(feature = "gpui")]
pub const WINDOW_WIDTH_PX: f32 = 1180.0;
#[cfg(feature = "gpui")]
pub const WINDOW_HEIGHT_PX: f32 = 820.0;
#[cfg(feature = "gpui")]
pub const MIN_WINDOW_WIDTH_PX: f32 = 960.0;
#[cfg(feature = "gpui")]
pub const MIN_WINDOW_HEIGHT_PX: f32 = 680.0;

pub const TAB_LIVE: &str = "Live";
pub const TAB_STYLE: &str = "Style";
pub const TAB_DICTIONARY: &str = "Dictionary";
pub const TAB_OUTPUT: &str = "Output";
pub const TAB_SETTINGS: &str = "Settings";
pub const TABS: &[&str] = &[TAB_LIVE, TAB_STYLE, TAB_DICTIONARY, TAB_OUTPUT, TAB_SETTINGS];

pub const NATIVE_BROWSER_SOURCE_HINT: &str = "http://127.0.0.1:1521/";
#[cfg(feature = "gpui")]
pub const NATIVE_VERTICAL_BROWSER_SOURCE_HINT: &str = "http://127.0.0.1:1521/?layout=vertical";
#[cfg(feature = "gpui")]
pub const RECOGNITION_MODE_LABEL: &str = "Silero VAD + sherpa-onnx + Namo";
#[cfg(any(feature = "gpui", test))]
pub const BUILD_ID: &str = env!("KOTOBA_BUILD_ID");
#[cfg(any(feature = "gpui", test))]
pub const STYLE_FILE_NAME: &str = "caption-style.json";
#[cfg(any(feature = "gpui", test))]
pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const DEFAULT_PREVIEW_SOURCE: &str = "こんにちは。";
pub const DEFAULT_PREVIEW_TRANSLATION: &str = "Hello.";
pub const PREVIEW_PLATE_WIDTH: u32 = 640;
pub const PREVIEW_PLATE_HEIGHT: u32 = 180;
#[cfg(any(feature = "gpui", test))]
pub const DICTIONARY_SEARCH_LIMIT: usize = 50;
pub const STYLE_VERSION: u32 = 1;
#[cfg(any(feature = "gpui", test))]
pub const SETTINGS_VERSION: u32 = 2;

const FIXTURE_JSON: &str = r#"{"version":1,"type":"turn.final","session_id":"fixture-session","turn_session_id":7,"turn_id":3,"revision":2,"output_sequence":2,"segment_id":8,"previous_segment_id":7,"text":"こんにちは。","source_asr_model":"reazonspeech_k2_v2","source_language":"ja","detected_language":null,"audio_duration_ms":1280,"elapsed_ms":96}"#;
const FLAG_SYPHON: &str = "--syphon";
const FLAG_SPOUT: &str = "--spout";
pub const FLAG_HELP: &str = "--help";

/// Which main-window tab is selected.
#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AppTab {
    #[default]
    Live,
    Style,
    Dictionary,
    Output,
    Settings,
}

#[cfg(any(feature = "gpui", test))]
impl AppTab {
    pub fn label(self) -> &'static str {
        match self {
            Self::Live => TAB_LIVE,
            Self::Style => TAB_STYLE,
            Self::Dictionary => TAB_DICTIONARY,
            Self::Output => TAB_OUTPUT,
            Self::Settings => TAB_SETTINGS,
        }
    }
}

#[cfg(test)]
impl AppTab {
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            TAB_LIVE => Some(Self::Live),
            TAB_STYLE => Some(Self::Style),
            TAB_DICTIONARY => Some(Self::Dictionary),
            TAB_OUTPUT => Some(Self::Output),
            TAB_SETTINGS => Some(Self::Settings),
            _ => None,
        }
    }
}

/// Live capture pill shown in the Live tab.
#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CaptureStatus {
    #[default]
    Idle,
    Capturing,
    Error,
}

/// Native publishers a user can enable from the command line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugLaunch {
    pub syphon: bool,
    pub spout: bool,
}

/// Result of ingesting the bundled Parapper fixture through [`CaptionSession`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixtureCaption {
    pub source_text: String,
    pub frame_width: u32,
    pub frame_height: u32,
}

/// Persistable caption style for the Native config directory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeStyleSettings {
    pub version: u32,
    pub font_family: String,
    pub font_weight: u16,
    pub letter_spacing_px: f32,
    pub line_height: f32,
    pub source_font_size_px: f32,
    pub source_color: String,
    pub source_opacity: f32,
    pub source_max_chars: usize,
    pub translation_font_size_px: f32,
    pub translation_color: String,
    pub translation_opacity: f32,
    pub translation_max_chars: usize,
    pub caption_x_percent: f32,
    pub caption_y_percent: f32,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub preview_background_color: String,
    pub shadow_enabled: bool,
    pub shadow_color: String,
    pub shadow_blur_px: f32,
    pub shadow_antialias: u8,
    pub shadow_offset_x: f32,
    pub shadow_offset_y: f32,
    pub outline_enabled: bool,
    pub outline_color: String,
    pub outline_width_px: f32,
}

impl Default for NativeStyleSettings {
    fn default() -> Self {
        let source = CaptionStyle::default_source();
        let translation = CaptionStyle::default_translation();
        Self {
            version: STYLE_VERSION,
            font_family: source.font_family.clone(),
            font_weight: source.font_weight,
            letter_spacing_px: source.letter_spacing_px,
            line_height: source.line_height,
            source_font_size_px: source.font_size_px,
            source_color: source.color,
            source_opacity: source.opacity,
            source_max_chars: SOURCE_CAPTION_MAX_CHARS,
            translation_font_size_px: translation.font_size_px,
            translation_color: translation.color,
            translation_opacity: translation.opacity,
            translation_max_chars: TRANSLATION_CAPTION_MAX_CHARS,
            caption_x_percent: 50.0,
            caption_y_percent: 88.0,
            background_enabled: false,
            background_color: source.background_color,
            background_opacity: source.background_opacity,
            preview_background_color: "#061018".to_string(),
            shadow_enabled: source.shadow_enabled,
            shadow_color: source.shadow_color,
            shadow_blur_px: source.shadow_blur_px,
            shadow_antialias: source.shadow_antialias,
            shadow_offset_x: source.shadow_offset_x,
            shadow_offset_y: source.shadow_offset_y,
            outline_enabled: source.culling_enabled,
            outline_color: source.culling_color,
            outline_width_px: source.culling_width_px,
        }
    }
}

/// Persisted Native runtime and output settings.
#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UiLanguage {
    #[default]
    Japanese,
    English,
}

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeAppSettings {
    pub version: u32,
    pub ui_language: UiLanguage,
    pub translation_enabled: bool,
    pub caption_timeout_ms: u64,
    pub caption_output_open_on_start: bool,
    pub browser_source_enabled: bool,
    pub syphon_enabled: bool,
}

#[cfg(any(feature = "gpui", test))]
impl Default for NativeAppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ui_language: UiLanguage::Japanese,
            translation_enabled: true,
            caption_timeout_ms: 5_000,
            caption_output_open_on_start: true,
            browser_source_enabled: true,
            syphon_enabled: false,
        }
    }
}

/// Parse and rasterize the bundled final turn without a protocol or sidecar.
pub fn ingest_fixture_caption() -> Result<FixtureCaption, serde_json::Error> {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE_JSON)?;
    let source_text = fixture.get("text").and_then(serde_json::Value::as_str).unwrap_or_default();
    let frame = rasterize(
        &OverlayGeometry::default_1280x720(),
        &CaptionFrame {
            source: source_text.to_string(),
            translation: String::new(),
            partial: String::new(),
        },
    );
    Ok(FixtureCaption {
        source_text: source_text.to_string(),
        frame_width: frame.width,
        frame_height: frame.height,
    })
}

/// Parse Native debug flags. Unknown arguments are ignored so Cargo extra args stay usable.
pub fn parse_debug_launch<I, S>(args: I) -> DebugLaunch
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut launch = DebugLaunch::default();
    for arg in args {
        match arg.as_ref() {
            FLAG_SYPHON => launch.syphon = true,
            FLAG_SPOUT => launch.spout = true,
            _ => {}
        }
    }
    launch
}

#[cfg(feature = "gpui")]
pub fn native_config_dir() -> PathBuf {
    AppIdentity::native().config_dir()
}

#[cfg(any(feature = "gpui", test))]
pub fn native_style_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STYLE_FILE_NAME)
}

#[cfg(any(feature = "gpui", test))]
pub fn native_settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE_NAME)
}

#[cfg(any(feature = "gpui", test))]
pub fn native_dictionary_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("dictionary")
}

/// Parapper headless runtime data directory for the Native app.
///
/// Parapper requires `PARAPPER_RUNTIME_DIR` to be an absolute path where it
/// keeps its configuration and downloaded models separate from other applications.
#[cfg(any(feature = "gpui", test))]
pub fn parapper_runtime_dir() -> Result<PathBuf, String> {
    let dir = AppIdentity::native().data_dir().join("parapper");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create Parapper runtime directory: {error}"))?;
    Ok(dir)
}

#[cfg(feature = "gpui")]
pub fn local_translation_model_installed() -> bool {
    let Ok(root) = parapper_runtime_dir() else {
        return false;
    };
    let model = root.join("models/lfm2-350m-enjp-mt-onnx-q4");
    model.join("tokenizer.json").is_file()
        && model.join("onnx/model_q4.onnx").is_file()
        && model.join("onnx/model_q4.onnx_data").is_file()
}

#[cfg(any(feature = "gpui", test))]
pub fn load_style_settings(config_dir: &Path) -> Result<NativeStyleSettings, String> {
    let path = native_style_path(config_dir);
    if !path.exists() {
        return Ok(NativeStyleSettings::default());
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|error| format!("could not read Native style: {error}"))?;
    if body.trim().is_empty() {
        return Ok(NativeStyleSettings::default());
    }
    serde_json::from_str(&body).map_err(|error| format!("Native style JSON is invalid: {error}"))
}

#[cfg(any(feature = "gpui", test))]
pub fn save_style_settings(
    config_dir: &Path,
    settings: &NativeStyleSettings,
) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("could not create Native config dir: {error}"))?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("could not serialize Native style: {error}"))?;
    std::fs::write(native_style_path(config_dir), json)
        .map_err(|error| format!("could not write Native style: {error}"))
}

#[cfg(any(feature = "gpui", test))]
pub fn load_app_settings(config_dir: &Path) -> Result<NativeAppSettings, String> {
    let path = native_settings_path(config_dir);
    if !path.exists() {
        return Ok(NativeAppSettings::default());
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|error| format!("could not read Native settings: {error}"))?;
    if body.trim().is_empty() {
        return Ok(NativeAppSettings::default());
    }
    serde_json::from_str(&body).map_err(|error| format!("Native settings JSON is invalid: {error}"))
}

#[cfg(any(feature = "gpui", test))]
pub fn save_app_settings(config_dir: &Path, settings: &NativeAppSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("could not create Native config dir: {error}"))?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("could not serialize Native settings: {error}"))?;
    std::fs::write(native_settings_path(config_dir), json)
        .map_err(|error| format!("could not write Native settings: {error}"))
}

#[cfg(any(feature = "gpui", test))]
pub fn load_dictionary_entries(
    config_dir: &Path,
) -> Result<Vec<CustomDictionaryEntry>, caption_bridge_dictionary::Error> {
    load_from_directory(&native_dictionary_dir(config_dir))
}

#[cfg(any(feature = "gpui", test))]
pub fn save_dictionary_entries(
    config_dir: &Path,
    entries: &[CustomDictionaryEntry],
) -> Result<Vec<CustomDictionaryEntry>, caption_bridge_dictionary::Error> {
    save_to_directory(&native_dictionary_dir(config_dir), entries)
}

#[cfg(any(feature = "gpui", test))]
pub fn search_dictionary_entries(
    entries: &[CustomDictionaryEntry],
    query: &str,
) -> Vec<CustomDictionaryEntry> {
    search(entries, query, DICTIONARY_SEARCH_LIMIT)
}

#[cfg(any(feature = "gpui", test))]
pub fn add_dictionary_entry(
    entries: &[CustomDictionaryEntry],
    reading: &str,
    word: &str,
) -> Result<Vec<CustomDictionaryEntry>, String> {
    let reading = reading.trim();
    let word = word.trim();
    if reading.is_empty() || word.is_empty() {
        return Err("読みと単語の両方を入力してください".to_string());
    }
    let mut next = entries.to_vec();
    next.push(CustomDictionaryEntry {
        id: format!("entry-{}", next.len() + 1),
        reading: reading.to_string(),
        word: word.to_string(),
    });
    Ok(next)
}

#[cfg(any(feature = "gpui", test))]
pub fn delete_dictionary_entry(
    entries: &[CustomDictionaryEntry],
    id: &str,
) -> Vec<CustomDictionaryEntry> {
    entries.iter().filter(|entry| entry.id != id).cloned().collect()
}

pub fn geometry_from_style(style: &NativeStyleSettings) -> OverlayGeometry {
    let mut geometry = OverlayGeometry::default_1280x720();
    geometry.caption_x_percent = style.caption_x_percent;
    geometry.caption_y_percent = style.caption_y_percent;
    geometry.order = RenderOrder::SourceFirst;
    geometry.source.font_family = style.font_family.clone();
    geometry.source.font_weight = style.font_weight;
    geometry.source.letter_spacing_px = style.letter_spacing_px;
    geometry.source.line_height = style.line_height;
    geometry.source.font_size_px = style.source_font_size_px;
    geometry.source.color = style.source_color.clone();
    geometry.source.opacity = style.source_opacity;
    apply_effects(&mut geometry.source, style);
    geometry.translation.font_family = style.font_family.clone();
    geometry.translation.font_weight = style.font_weight;
    geometry.translation.letter_spacing_px = style.letter_spacing_px;
    geometry.translation.line_height = style.line_height;
    geometry.translation.font_size_px = style.translation_font_size_px;
    geometry.translation.color = style.translation_color.clone();
    geometry.translation.opacity = style.translation_opacity;
    apply_effects(&mut geometry.translation, style);
    geometry
}

fn apply_effects(caption: &mut CaptionStyle, style: &NativeStyleSettings) {
    caption.background_enabled = style.background_enabled;
    caption.background_color = style.background_color.clone();
    caption.background_opacity = style.background_opacity;
    caption.shadow_enabled = style.shadow_enabled;
    caption.shadow_color = style.shadow_color.clone();
    caption.shadow_blur_px = style.shadow_blur_px;
    caption.shadow_antialias = style.shadow_antialias;
    caption.shadow_offset_x = style.shadow_offset_x;
    caption.shadow_offset_y = style.shadow_offset_y;
    caption.culling_enabled = style.outline_enabled;
    caption.culling_color = style.outline_color.clone();
    caption.culling_width_px = style.outline_width_px;
}

pub fn layout_from_style(style: &NativeStyleSettings) -> CaptionLayoutConfig {
    CaptionLayoutConfig {
        order: LayoutOrder::SourceFirst,
        source_max_chars: style.source_max_chars,
        translation_max_chars: style.translation_max_chars,
    }
}

pub fn rasterize_live_caption(
    style: &NativeStyleSettings,
    source: &str,
    translation: &str,
) -> RgbaImage {
    rasterize_live_caption_at_scale(style, source, translation, 1.0)
}

pub fn rasterize_live_caption_at_scale(
    style: &NativeStyleSettings,
    source: &str,
    translation: &str,
    scale_factor: f32,
) -> RgbaImage {
    let scale_factor = scale_factor.clamp(1.0, 3.0);
    let mut geometry = geometry_from_style(style);
    scale_geometry_pixels(&mut geometry, scale_factor);
    rasterize(
        &geometry,
        &CaptionFrame {
            source: source.to_string(),
            translation: translation.to_string(),
            partial: String::new(),
        },
    )
}

fn scale_geometry_pixels(geometry: &mut OverlayGeometry, scale_factor: f32) {
    geometry.width = (geometry.width as f32 * scale_factor).round() as u32;
    geometry.height = (geometry.height as f32 * scale_factor).round() as u32;
    geometry.safe_area_px *= scale_factor;
    geometry.gap_px *= scale_factor;
    scale_caption_pixels(&mut geometry.source, scale_factor);
    scale_caption_pixels(&mut geometry.translation, scale_factor);
}

fn scale_caption_pixels(style: &mut CaptionStyle, scale_factor: f32) {
    style.font_size_px *= scale_factor;
    style.letter_spacing_px *= scale_factor;
    style.culling_width_px *= scale_factor;
    style.shadow_blur_px *= scale_factor;
    style.shadow_offset_x *= scale_factor;
    style.shadow_offset_y *= scale_factor;
    style.padding_x *= scale_factor;
    style.padding_y *= scale_factor;
    style.border_radius *= scale_factor;
}

pub fn rasterize_style_preview(
    style: &NativeStyleSettings,
    source: &str,
    translation: &str,
) -> RgbaImage {
    let mut geometry = geometry_from_style(style);
    geometry.width = PREVIEW_PLATE_WIDTH;
    geometry.height = PREVIEW_PLATE_HEIGHT;
    geometry.caption_y_percent = 70.0;
    scale_geometry_pixels(&mut geometry, 2.0);
    rasterize(
        &geometry,
        &CaptionFrame {
            source: source.to_string(),
            translation: translation.to_string(),
            partial: String::new(),
        },
    )
}

pub fn print_usage() {
    println!("usage: {BINARY_NAME} [--syphon] [--spout] [--help]");
    println!("  --syphon   macOS only: publish Kotoba Beacon Native to the Syphon directory");
    println!("  --spout    Windows only: publish Kotoba Beacon Native via Spout2");
    println!("  Linux capture fallback: Native browser-source on {NATIVE_BROWSER_SOURCE_HINT}");
}

#[cfg(feature = "gpui")]
pub const METER_MIN_DB: f32 = -60.0;
#[cfg(feature = "gpui")]
pub const METER_MAX_DB: f32 = 0.0;
#[cfg(feature = "gpui")]
pub const METER_CLIP_THRESHOLD_DB: f32 = -6.0;
#[cfg(feature = "gpui")]
pub const METER_NORMAL_THRESHOLD_DB: f32 = -20.0;
#[cfg(feature = "gpui")]
pub const METER_QUIET_COLOR: u32 = 0x4f6f86;
#[cfg(feature = "gpui")]
pub const METER_NORMAL_COLOR: u32 = 0x0f7b4c;
#[cfg(feature = "gpui")]
pub const METER_CLIP_COLOR: u32 = 0xb42318;

#[cfg(feature = "gpui")]
pub fn format_rms(rms: Option<f32>) -> String {
    match rms {
        Some(value) if value.is_finite() => format!("{value:.1} dBFS"),
        _ => "—".to_string(),
    }
}

#[cfg(feature = "gpui")]
pub fn rms_to_fraction(rms: Option<f32>) -> f32 {
    match rms {
        Some(value) if value.is_finite() => {
            let t = (value - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
            t.clamp(0.0, 1.0)
        }
        _ => 0.0,
    }
}

#[cfg(feature = "gpui")]
pub fn rms_level_color(rms: Option<f32>) -> u32 {
    match rms {
        Some(value) if value.is_finite() && value >= METER_CLIP_THRESHOLD_DB => METER_CLIP_COLOR,
        Some(value) if value.is_finite() && value >= METER_NORMAL_THRESHOLD_DB => {
            METER_NORMAL_COLOR
        }
        _ => METER_QUIET_COLOR,
    }
}

/// CLI / `--no-default-features` diagnostics. Does not spawn child processes.
pub fn run_stub_lines() -> Vec<String> {
    let mut lines = vec!["tabs:".to_string()];
    lines.push(format!("  - {TAB_LIVE}"));
    lines.push(format!("  - {TAB_STYLE}"));
    lines.push(format!("  - {TAB_DICTIONARY}"));
    lines.push(format!("  - {TAB_OUTPUT}"));
    lines.push(format!("  - {TAB_SETTINGS}"));
    match ingest_fixture_caption() {
        Ok(caption) => {
            lines.push(format!("fixture caption: {}", caption.source_text));
            lines.push(format!("raster: {}x{}", caption.frame_width, caption.frame_height));
        }
        Err(error) => lines.push(format!("fixture caption failed: {error}")),
    }
    let preview = rasterize_style_preview(
        &NativeStyleSettings::default(),
        DEFAULT_PREVIEW_SOURCE,
        DEFAULT_PREVIEW_TRANSLATION,
    );
    lines.push(format!("style preview: {}x{}", preview.width, preview.height));
    let _ = geometry_from_style(&NativeStyleSettings::default());
    let _ = layout_from_style(&NativeStyleSettings::default());
    lines
}
