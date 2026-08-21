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
use caption_bridge_session::CaptionSession;
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
pub const TAB_SETTINGS: &str = "Settings";
pub const TABS: &[&str] = &[TAB_LIVE, TAB_STYLE, TAB_DICTIONARY, TAB_SETTINGS];

pub const NATIVE_BROWSER_SOURCE_HINT: &str = "http://127.0.0.1:1521";
#[cfg(any(feature = "gpui", test))]
pub const NATIVE_PARAPPER_PORT: u16 = 18_182;
#[cfg(any(feature = "gpui", test))]
pub const PARAPPER_BINARY_NAME: &str = "kotoba-parapper";
#[cfg(feature = "gpui")]
pub const RECOGNITION_MODE_LABEL: &str = "parapper-azookey";
#[cfg(any(feature = "gpui", test))]
pub const STYLE_FILE_NAME: &str = "caption-style.json";
#[cfg(feature = "gpui")]
pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const DEFAULT_PREVIEW_SOURCE: &str = "こんにちは。";
pub const DEFAULT_PREVIEW_TRANSLATION: &str = "Hello.";
pub const PREVIEW_PLATE_WIDTH: u32 = 640;
pub const PREVIEW_PLATE_HEIGHT: u32 = 180;
#[cfg(any(feature = "gpui", test))]
pub const FONT_SIZE_MIN: f32 = 12.0;
#[cfg(any(feature = "gpui", test))]
pub const FONT_SIZE_MAX: f32 = 72.0;
#[cfg(any(feature = "gpui", test))]
pub const FONT_SIZE_STEP: f32 = 2.0;
#[cfg(any(feature = "gpui", test))]
pub const OPACITY_MIN: f32 = 0.2;
#[cfg(any(feature = "gpui", test))]
pub const OPACITY_MAX: f32 = 1.0;
#[cfg(feature = "gpui")]
pub const OPACITY_STEP: f32 = 0.1;
#[cfg(any(feature = "gpui", test))]
pub const POSITION_MIN: f32 = 5.0;
#[cfg(any(feature = "gpui", test))]
pub const POSITION_MAX: f32 = 95.0;
#[cfg(feature = "gpui")]
pub const POSITION_STEP: f32 = 5.0;
#[cfg(any(feature = "gpui", test))]
pub const MAX_CHARS_MIN: usize = 8;
#[cfg(any(feature = "gpui", test))]
pub const MAX_CHARS_MAX: usize = 80;
#[cfg(feature = "gpui")]
pub const MAX_CHARS_STEP: usize = 4;
#[cfg(any(feature = "gpui", test))]
pub const DICTIONARY_SEARCH_LIMIT: usize = 50;
pub const STYLE_VERSION: u32 = 1;
#[cfg(feature = "gpui")]
pub const SETTINGS_VERSION: u32 = 1;

const FIXTURE_NOW_MS: u64 = 1_700_000_000_000;
const FIXTURE_JSON: &str = r#"{"version":1,"type":"turn.final","session_id":"fixture-session","turn_session_id":7,"turn_id":3,"revision":2,"output_sequence":2,"segment_id":8,"previous_segment_id":7,"text":"こんにちは。","source_asr_model":"reazonspeech_k2_v2","source_language":"ja","detected_language":null,"audio_duration_ms":1280,"elapsed_ms":96}"#;
const FLAG_OVERLAY: &str = "--overlay";
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
    Settings,
}

#[cfg(any(feature = "gpui", test))]
impl AppTab {
    pub fn label(self) -> &'static str {
        match self {
            Self::Live => TAB_LIVE,
            Self::Style => TAB_STYLE,
            Self::Dictionary => TAB_DICTIONARY,
            Self::Settings => TAB_SETTINGS,
        }
    }

    pub fn japanese_label(self) -> &'static str {
        match self {
            Self::Live => "ライブ",
            Self::Style => "スタイル",
            Self::Dictionary => "辞書",
            Self::Settings => "設定",
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

#[cfg(any(feature = "gpui", test))]
impl CaptureStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "待機",
            Self::Capturing => "収録中",
            Self::Error => "エラー",
        }
    }
}

/// Debug surfaces a user can enable from the Native CLI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugLaunch {
    pub overlay: bool,
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
#[serde(rename_all = "camelCase")]
pub struct NativeStyleSettings {
    pub version: u32,
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
}

impl Default for NativeStyleSettings {
    fn default() -> Self {
        let source = CaptionStyle::default_source();
        let translation = CaptionStyle::default_translation();
        Self {
            version: STYLE_VERSION,
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
        }
    }
}

/// Persistable Settings-tab toggles (overlay / Syphon last-known state).
#[cfg(feature = "gpui")]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppSettings {
    pub version: u32,
    pub recognition_mode: String,
    pub overlay_open: bool,
    pub syphon_enabled: bool,
}

#[cfg(feature = "gpui")]
impl Default for NativeAppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            recognition_mode: RECOGNITION_MODE_LABEL.to_string(),
            overlay_open: false,
            syphon_enabled: false,
        }
    }
}

/// Parse the bundled final turn without spawning sidecars or opening a window.
pub fn ingest_fixture_caption() -> Result<FixtureCaption, caption_bridge_session::SessionError> {
    let mut session = CaptionSession::native();
    let frame = session.ingest_parapper_json(FIXTURE_JSON, FIXTURE_NOW_MS)?;
    let (frame_width, frame_height) = match frame {
        Some(image) => (image.width, image.height),
        None => (0, 0),
    };
    Ok(FixtureCaption {
        source_text: session.live_caption().source_text.clone(),
        frame_width,
        frame_height,
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
            FLAG_OVERLAY => launch.overlay = true,
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

#[cfg(feature = "gpui")]
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
/// keeps its configuration and downloaded ASR models, separate from any
/// interactive Parapper installation or the Tauri desktop app.
#[cfg(any(feature = "gpui", test))]
pub fn parapper_runtime_dir() -> Result<PathBuf, String> {
    let dir = AppIdentity::native().data_dir().join("parapper");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create Parapper runtime directory: {error}"))?;
    Ok(dir)
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

#[cfg(feature = "gpui")]
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

#[cfg(feature = "gpui")]
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
    geometry.source.font_size_px = style.source_font_size_px;
    geometry.source.color = style.source_color.clone();
    geometry.source.opacity = style.source_opacity;
    geometry.translation.font_size_px = style.translation_font_size_px;
    geometry.translation.color = style.translation_color.clone();
    geometry.translation.opacity = style.translation_opacity;
    geometry
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
    rasterize(
        &geometry_from_style(style),
        &CaptionFrame {
            source: source.to_string(),
            translation: translation.to_string(),
            partial: String::new(),
        },
    )
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
    rasterize(
        &geometry,
        &CaptionFrame {
            source: source.to_string(),
            translation: translation.to_string(),
            partial: String::new(),
        },
    )
}

#[cfg(any(feature = "gpui", test))]
pub fn adjust_font_size(value: f32, delta: f32) -> f32 {
    clamp_step(value + delta, FONT_SIZE_MIN, FONT_SIZE_MAX)
}

#[cfg(any(feature = "gpui", test))]
pub fn adjust_opacity(value: f32, delta: f32) -> f32 {
    clamp_step(value + delta, OPACITY_MIN, OPACITY_MAX)
}

#[cfg(any(feature = "gpui", test))]
pub fn adjust_position(value: f32, delta: f32) -> f32 {
    clamp_step(value + delta, POSITION_MIN, POSITION_MAX)
}

#[cfg(any(feature = "gpui", test))]
pub fn adjust_max_chars(value: usize, delta: isize) -> usize {
    let next = value as isize + delta;
    if next < MAX_CHARS_MIN as isize {
        MAX_CHARS_MIN
    } else if next > MAX_CHARS_MAX as isize {
        MAX_CHARS_MAX
    } else {
        next as usize
    }
}

#[cfg(any(feature = "gpui", test))]
fn clamp_step(value: f32, min: f32, max: f32) -> f32 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        (value * 10.0).round() / 10.0
    }
}

#[cfg(any(feature = "gpui", test))]
pub fn cycle_source_color(current: &str) -> &'static str {
    match current {
        "#ffffff" => "#ffe08a",
        "#ffe08a" => "#7dffb3",
        _ => "#ffffff",
    }
}

#[cfg(any(feature = "gpui", test))]
pub fn cycle_translation_color(current: &str) -> &'static str {
    match current {
        "#bfe8ff" => "#ffb4d9",
        "#ffb4d9" => "#d4ff9a",
        _ => "#bfe8ff",
    }
}

#[cfg(any(feature = "gpui", test))]
pub fn missing_sidecar_message() -> String {
    format!(
        "Parapper sidecar `{PARAPPER_BINARY_NAME}` が見つかりません。port {NATIVE_PARAPPER_PORT} で認識できません。タブ・スタイル・辞書・オーバーレイは使えます。"
    )
}

#[cfg(any(feature = "gpui", test))]
pub fn sidecar_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(PARAPPER_BINARY_NAME));
            candidates.push(dir.join("sidecars").join(PARAPPER_BINARY_NAME));
            if let Some(contents) = dir.parent() {
                candidates
                    .push(contents.join("Resources").join("sidecars").join(PARAPPER_BINARY_NAME));
                candidates.push(contents.join("MacOS").join(PARAPPER_BINARY_NAME));
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(PARAPPER_BINARY_NAME));
        }
    }
    candidates
}

#[cfg(any(feature = "gpui", test))]
pub fn resolve_parapper_binary() -> Result<PathBuf, String> {
    sidecar_binary_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(missing_sidecar_message)
}

pub fn print_usage() {
    println!("usage: {BINARY_NAME} [--overlay] [--syphon] [--spout] [--help]");
    println!(
        "  --overlay  open Kotoba Beacon Native Transparent Capture with a test pattern (macOS live; Windows layered chrome; Linux → {NATIVE_BROWSER_SOURCE_HINT})"
    );
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

/// CLI / `--no-default-features` identity lines. Does not spawn sidecars.
pub fn run_stub_lines() -> Vec<String> {
    let mut lines = vec![
        PRODUCT_NAME.to_string(),
        format!("bundle id: {BUNDLE_ID}"),
        "planned tabs:".to_string(),
    ];
    lines.push(format!("  - {TAB_LIVE}"));
    lines.push(format!("  - {TAB_STYLE}"));
    lines.push(format!("  - {TAB_DICTIONARY}"));
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
