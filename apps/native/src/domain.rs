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
pub const TAB_SETTINGS: &str = "Settings";
pub const TABS: &[&str] = &[TAB_LIVE, TAB_STYLE, TAB_DICTIONARY, TAB_SETTINGS];

pub const NATIVE_BROWSER_SOURCE_HINT: &str = "http://127.0.0.1:1521/";
#[cfg(feature = "gpui")]
pub const RECOGNITION_MODE_LABEL: &str = "Silero VAD + sherpa-onnx + Namo";
#[cfg(any(feature = "gpui", test))]
pub const BUILD_ID: &str = env!("KOTOBA_BUILD_ID");
#[cfg(any(feature = "gpui", test))]
pub const STYLE_FILE_NAME: &str = "caption-style.json";
#[cfg(any(feature = "gpui", test))]
pub const STYLE_CATALOG_FILE_NAME: &str = "caption-styles.json";
#[cfg(any(feature = "gpui", test))]
pub const DICTIONARY_CATALOG_FILE_NAME: &str = "dictionary-catalog.json";
#[cfg(any(feature = "gpui", test))]
pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const DEFAULT_PREVIEW_SOURCE: &str = "こんにちは。";
pub const DEFAULT_PREVIEW_TRANSLATION: &str = "Hello.";
pub const PREVIEW_PLATE_WIDTH: u32 = 640;
pub const PREVIEW_PLATE_HEIGHT: u32 = 180;
#[cfg(any(feature = "gpui", test))]
pub const DICTIONARY_SEARCH_LIMIT: usize = 50;
pub const STYLE_VERSION: u32 = 2;
#[cfg(any(feature = "gpui", test))]
pub const SETTINGS_VERSION: u32 = 3;

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
    Settings,
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
    Stopping,
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
    pub source_font_family: String,
    pub source_font_weight: u16,
    pub source_letter_spacing_px: f32,
    pub source_line_height: f32,
    pub source_font_size_px: f32,
    pub source_color: String,
    pub source_opacity: f32,
    pub source_max_chars: usize,
    pub translation_font_family: String,
    pub translation_font_weight: u16,
    pub translation_letter_spacing_px: f32,
    pub translation_line_height: f32,
    pub translation_font_size_px: f32,
    pub translation_color: String,
    pub translation_opacity: f32,
    pub translation_max_chars: usize,
    pub caption_x_percent: f32,
    pub caption_y_percent: f32,
    pub background_enabled: bool,
    pub background_color: String,
    pub background_opacity: f32,
    pub capture_background_color: String,
    pub preview_background_color: String,
    pub preview_background_image_path: Option<String>,
    pub preview_background_image_x_percent: f32,
    pub preview_background_image_y_percent: f32,
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

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStyleProfile {
    pub id: String,
    pub name: String,
    pub style: NativeStyleSettings,
}

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStyleCatalog {
    pub version: u32,
    pub selected_id: String,
    pub profiles: Vec<NativeStyleProfile>,
}

#[cfg(any(feature = "gpui", test))]
impl NativeStyleCatalog {
    pub fn selected(&self) -> &NativeStyleProfile {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.selected_id)
            .unwrap_or(&self.profiles[0])
    }
}

#[cfg(any(feature = "gpui", test))]
impl Default for NativeStyleCatalog {
    fn default() -> Self {
        let horizontal = NativeStyleProfile {
            id: "style-1".to_string(),
            name: "Horizontal".to_string(),
            style: NativeStyleSettings::default(),
        };
        let vertical_style = NativeStyleSettings {
            caption_y_percent: 92.0,
            source_max_chars: 24,
            translation_max_chars: 28,
            ..NativeStyleSettings::default()
        };
        let vertical = NativeStyleProfile {
            id: "style-2".to_string(),
            name: "Vertical".to_string(),
            style: vertical_style,
        };
        Self {
            version: 1,
            selected_id: horizontal.id.clone(),
            profiles: vec![horizontal, vertical],
        }
    }
}

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDictionaryProfile {
    pub id: String,
    pub name: String,
    pub entries: Vec<CustomDictionaryEntry>,
}

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDictionaryCatalog {
    pub version: u32,
    pub selected_id: String,
    pub dictionaries: Vec<NativeDictionaryProfile>,
}

#[cfg(any(feature = "gpui", test))]
impl NativeDictionaryCatalog {
    pub fn selected(&self) -> &NativeDictionaryProfile {
        self.dictionaries
            .iter()
            .find(|dictionary| dictionary.id == self.selected_id)
            .unwrap_or(&self.dictionaries[0])
    }
}

#[cfg(any(feature = "gpui", test))]
impl Default for NativeDictionaryCatalog {
    fn default() -> Self {
        let dictionary = NativeDictionaryProfile {
            id: "dictionary-1".to_string(),
            name: "Dictionary 1".to_string(),
            entries: Vec::new(),
        };
        Self { version: 1, selected_id: dictionary.id.clone(), dictionaries: vec![dictionary] }
    }
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
            source_font_family: source.font_family.clone(),
            source_font_weight: source.font_weight,
            source_letter_spacing_px: source.letter_spacing_px,
            source_line_height: source.line_height,
            source_font_size_px: source.font_size_px,
            source_color: source.color,
            source_opacity: source.opacity,
            source_max_chars: SOURCE_CAPTION_MAX_CHARS,
            translation_font_family: translation.font_family.clone(),
            translation_font_weight: translation.font_weight,
            translation_letter_spacing_px: translation.letter_spacing_px,
            translation_line_height: translation.line_height,
            translation_font_size_px: translation.font_size_px,
            translation_color: translation.color,
            translation_opacity: translation.opacity,
            translation_max_chars: TRANSLATION_CAPTION_MAX_CHARS,
            caption_x_percent: 50.0,
            caption_y_percent: 88.0,
            background_enabled: false,
            background_color: source.background_color,
            background_opacity: source.background_opacity,
            capture_background_color: "#00ff00".to_string(),
            preview_background_color: "#061018".to_string(),
            preview_background_image_path: None,
            preview_background_image_x_percent: 0.0,
            preview_background_image_y_percent: 0.0,
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
#[serde(rename_all = "camelCase")]
pub struct CompanionDeviceSettings {
    pub device_id: String,
    pub device_name: String,
    pub asr_on_mobile: bool,
    pub azookey_on_mobile: bool,
    pub translation_on_mobile: bool,
}

#[cfg(any(feature = "gpui", test))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeAppSettings {
    pub version: u32,
    pub ui_language: UiLanguage,
    pub translation_enabled: bool,
    pub show_recognition_result: bool,
    pub show_translation_result: bool,
    pub caption_timeout_ms: u64,
    pub caption_output_open_on_start: bool,
    pub browser_source_enabled: bool,
    pub syphon_enabled: bool,
    pub companion_enabled: bool,
    #[serde(skip_serializing)]
    pub companion_asr_on_mobile: bool,
    #[serde(skip_serializing)]
    pub companion_azookey_on_mobile: bool,
    #[serde(skip_serializing)]
    pub companion_translation_on_mobile: bool,
    #[serde(skip_serializing)]
    pub companion_devices: Vec<CompanionDeviceSettings>,
}

#[cfg(any(feature = "gpui", test))]
impl Default for NativeAppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ui_language: UiLanguage::Japanese,
            translation_enabled: true,
            show_recognition_result: true,
            show_translation_result: true,
            caption_timeout_ms: 5_000,
            caption_output_open_on_start: true,
            browser_source_enabled: true,
            syphon_enabled: false,
            companion_enabled: true,
            companion_asr_on_mobile: true,
            companion_azookey_on_mobile: true,
            companion_translation_on_mobile: true,
            companion_devices: Vec::new(),
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
pub fn native_style_catalog_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STYLE_CATALOG_FILE_NAME)
}

#[cfg(any(feature = "gpui", test))]
pub fn native_dictionary_catalog_path(config_dir: &Path) -> PathBuf {
    config_dir.join(DICTIONARY_CATALOG_FILE_NAME)
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
    parapper_engine::quickmt_ja_en_model_installed(&root.join("models"))
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
    let style = serde_json::from_str(&body)
        .map_err(|error| format!("Native style JSON is invalid: {error}"))?;
    Ok(migrate_native_style(style))
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
pub fn load_style_catalog(config_dir: &Path) -> Result<NativeStyleCatalog, String> {
    let path = native_style_catalog_path(config_dir);
    if !path.exists() {
        let style = load_style_settings(config_dir)?;
        let mut catalog = NativeStyleCatalog::default();
        catalog.profiles[0].style = style;
        return Ok(catalog);
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|error| format!("could not read Native style catalog: {error}"))?;
    let mut catalog: NativeStyleCatalog = serde_json::from_str(&body)
        .map_err(|error| format!("Native style catalog JSON is invalid: {error}"))?;
    for profile in &mut catalog.profiles {
        profile.style = migrate_native_style(profile.style.clone());
    }
    validate_style_catalog(catalog)
}

#[cfg(any(feature = "gpui", test))]
pub fn save_style_catalog(config_dir: &Path, catalog: &NativeStyleCatalog) -> Result<(), String> {
    let catalog = validate_style_catalog(catalog.clone())?;
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("could not create Native config dir: {error}"))?;
    let json = serde_json::to_vec_pretty(&catalog)
        .map_err(|error| format!("could not serialize Native style catalog: {error}"))?;
    std::fs::write(native_style_catalog_path(config_dir), json)
        .map_err(|error| format!("could not write Native style catalog: {error}"))?;
    save_style_settings(config_dir, &catalog.selected().style)
}

#[cfg(any(feature = "gpui", test))]
pub fn add_style_profile(catalog: &NativeStyleCatalog) -> NativeStyleCatalog {
    let mut next = catalog.clone();
    let number = next.profiles.len() + 1;
    let id = next_profile_id("style", next.profiles.iter().map(|profile| profile.id.as_str()));
    let profile = NativeStyleProfile {
        id: id.clone(),
        name: format!("Style {number}"),
        style: catalog.selected().style.clone(),
    };
    next.profiles.push(profile);
    next.selected_id = id;
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn select_style_profile(catalog: &NativeStyleCatalog, id: &str) -> NativeStyleCatalog {
    let mut next = catalog.clone();
    if next.profiles.iter().any(|profile| profile.id == id) {
        next.selected_id = id.to_string();
    }
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn delete_selected_style_profile(catalog: &NativeStyleCatalog) -> NativeStyleCatalog {
    if catalog.profiles.len() <= 1 {
        return catalog.clone();
    }
    let mut next = catalog.clone();
    next.profiles.retain(|profile| profile.id != catalog.selected_id);
    next.selected_id = next.profiles[0].id.clone();
    next
}

#[cfg(any(feature = "gpui", test))]
fn migrate_native_style(mut style: NativeStyleSettings) -> NativeStyleSettings {
    if style.version < 2 {
        style.source_font_family = style.font_family.clone();
        style.source_font_weight = style.font_weight;
        style.source_letter_spacing_px = style.letter_spacing_px;
        style.source_line_height = style.line_height;
        style.translation_font_family = style.font_family.clone();
        style.translation_font_weight = style.font_weight;
        style.translation_letter_spacing_px = style.letter_spacing_px;
        style.translation_line_height = style.line_height;
        style.version = STYLE_VERSION;
    }
    style
}

#[cfg(any(feature = "gpui", test))]
fn validate_style_catalog(catalog: NativeStyleCatalog) -> Result<NativeStyleCatalog, String> {
    if catalog.profiles.is_empty() {
        return Err("Native style catalog must contain at least one style".to_string());
    }
    if !catalog.profiles.iter().any(|profile| profile.id == catalog.selected_id) {
        return Err("Native style catalog selectedId does not exist".to_string());
    }
    if catalog
        .profiles
        .iter()
        .any(|profile| profile.id.trim().is_empty() || profile.name.trim().is_empty())
    {
        return Err("Native style catalog contains an empty id or name".to_string());
    }
    Ok(catalog)
}

#[cfg(any(feature = "gpui", test))]
fn next_profile_id<'a>(prefix: &str, ids: impl Iterator<Item = &'a str>) -> String {
    let ids = ids.collect::<Vec<_>>();
    let mut number = 1_usize;
    loop {
        let candidate = format!("{prefix}-{number}");
        if ids.iter().all(|id| **id != candidate) {
            return candidate;
        }
        number += 1;
    }
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
pub fn load_dictionary_catalog(config_dir: &Path) -> Result<NativeDictionaryCatalog, String> {
    let path = native_dictionary_catalog_path(config_dir);
    if !path.exists() {
        let entries = load_dictionary_entries(config_dir).map_err(|error| error.to_string())?;
        let mut catalog = NativeDictionaryCatalog::default();
        catalog.dictionaries[0].entries = entries;
        return Ok(catalog);
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|error| format!("could not read Native dictionary catalog: {error}"))?;
    let catalog: NativeDictionaryCatalog = serde_json::from_str(&body)
        .map_err(|error| format!("Native dictionary catalog JSON is invalid: {error}"))?;
    validate_dictionary_catalog(catalog)
}

#[cfg(any(feature = "gpui", test))]
pub fn save_dictionary_catalog(
    config_dir: &Path,
    catalog: &NativeDictionaryCatalog,
) -> Result<(), String> {
    let catalog = validate_dictionary_catalog(catalog.clone())?;
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("could not create Native config dir: {error}"))?;
    let json = serde_json::to_vec_pretty(&catalog)
        .map_err(|error| format!("could not serialize Native dictionary catalog: {error}"))?;
    std::fs::write(native_dictionary_catalog_path(config_dir), json)
        .map_err(|error| format!("could not write Native dictionary catalog: {error}"))?;
    save_dictionary_entries(config_dir, &catalog.selected().entries)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(any(feature = "gpui", test))]
pub fn add_dictionary_profile(catalog: &NativeDictionaryCatalog) -> NativeDictionaryCatalog {
    let mut next = catalog.clone();
    let number = next.dictionaries.len() + 1;
    let id = next_profile_id(
        "dictionary",
        next.dictionaries.iter().map(|dictionary| dictionary.id.as_str()),
    );
    next.dictionaries.push(NativeDictionaryProfile {
        id: id.clone(),
        name: format!("Dictionary {number}"),
        entries: Vec::new(),
    });
    next.selected_id = id;
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn select_dictionary_profile(
    catalog: &NativeDictionaryCatalog,
    id: &str,
) -> NativeDictionaryCatalog {
    let mut next = catalog.clone();
    if next.dictionaries.iter().any(|dictionary| dictionary.id == id) {
        next.selected_id = id.to_string();
    }
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn delete_selected_dictionary_profile(
    catalog: &NativeDictionaryCatalog,
) -> NativeDictionaryCatalog {
    if catalog.dictionaries.len() <= 1 {
        return catalog.clone();
    }
    let mut next = catalog.clone();
    next.dictionaries.retain(|dictionary| dictionary.id != catalog.selected_id);
    next.selected_id = next.dictionaries[0].id.clone();
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn clear_selected_dictionary(catalog: &NativeDictionaryCatalog) -> NativeDictionaryCatalog {
    let mut next = catalog.clone();
    if let Some(dictionary) =
        next.dictionaries.iter_mut().find(|dictionary| dictionary.id == next.selected_id)
    {
        dictionary.entries.clear();
    }
    next
}

#[cfg(any(feature = "gpui", test))]
pub fn replace_selected_dictionary_entries(
    catalog: &NativeDictionaryCatalog,
    entries: Vec<CustomDictionaryEntry>,
) -> NativeDictionaryCatalog {
    let mut next = catalog.clone();
    if let Some(dictionary) =
        next.dictionaries.iter_mut().find(|dictionary| dictionary.id == next.selected_id)
    {
        dictionary.entries = entries;
    }
    next
}

#[cfg(any(feature = "gpui", test))]
fn validate_dictionary_catalog(
    catalog: NativeDictionaryCatalog,
) -> Result<NativeDictionaryCatalog, String> {
    if catalog.dictionaries.is_empty() {
        return Err("Native dictionary catalog must contain at least one dictionary".to_string());
    }
    if !catalog.dictionaries.iter().any(|item| item.id == catalog.selected_id) {
        return Err("Native dictionary catalog selectedId does not exist".to_string());
    }
    if catalog
        .dictionaries
        .iter()
        .any(|item| item.id.trim().is_empty() || item.name.trim().is_empty())
    {
        return Err("Native dictionary catalog contains an empty id or name".to_string());
    }
    Ok(catalog)
}

#[cfg(any(feature = "gpui", test))]
pub fn import_dictionary_file(path: &Path) -> Result<Vec<CustomDictionaryEntry>, String> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
    if !extension.eq_ignore_ascii_case("csv") && !extension.eq_ignore_ascii_case("tsv") {
        return Err("Only CSV and TSV dictionary files are supported".to_string());
    }
    let body = std::fs::read_to_string(path)
        .map_err(|error| format!("could not read dictionary import: {error}"))?;
    parse_dictionary_delimited(&body, extension.eq_ignore_ascii_case("tsv"))
}

#[cfg(any(feature = "gpui", test))]
pub fn export_dictionary_csv(entries: &[CustomDictionaryEntry]) -> String {
    let mut output = "reading,word\n".to_string();
    if entries.is_empty() {
        output.push_str("とうきょう,東京\n");
        return output;
    }
    for entry in entries {
        output.push_str(&escape_dictionary_csv_column(&entry.reading));
        output.push(',');
        output.push_str(&escape_dictionary_csv_column(&entry.word));
        output.push('\n');
    }
    output
}

#[cfg(any(feature = "gpui", test))]
fn escape_dictionary_csv_column(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\r') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(any(feature = "gpui", test))]
pub fn parse_dictionary_delimited(
    body: &str,
    tab_separated: bool,
) -> Result<Vec<CustomDictionaryEntry>, String> {
    let delimiter = if tab_separated { '\t' } else { ',' };
    let mut entries = Vec::new();
    for (line_index, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let columns = parse_delimited_line(line.trim_end_matches('\r'), delimiter)?;
        if columns.len() < 2 {
            return Err(format!("dictionary row {} must contain reading and word", line_index + 1));
        }
        let reading = columns[0].trim();
        let word = columns[1].trim();
        if line_index == 0
            && matches!(reading.to_ascii_lowercase().as_str(), "reading" | "読み")
            && matches!(word.to_ascii_lowercase().as_str(), "word" | "単語")
        {
            continue;
        }
        if reading.is_empty() || word.is_empty() {
            return Err(format!("dictionary row {} contains an empty value", line_index + 1));
        }
        entries.push(CustomDictionaryEntry {
            id: format!("entry-{}", entries.len() + 1),
            reading: reading.to_string(),
            word: word.to_string(),
        });
    }
    if entries.is_empty() {
        return Err("dictionary import contains no entries".to_string());
    }
    Ok(entries)
}

#[cfg(any(feature = "gpui", test))]
fn parse_delimited_line(line: &str, delimiter: char) -> Result<Vec<String>, String> {
    let mut columns = Vec::new();
    let mut column = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                column.push('"');
            }
            '"' => quoted = !quoted,
            value if value == delimiter && !quoted => {
                columns.push(std::mem::take(&mut column));
            }
            value => column.push(value),
        }
    }
    if quoted {
        return Err("dictionary import contains an unterminated quoted value".to_string());
    }
    columns.push(column);
    Ok(columns)
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
    let id = next_profile_id("entry", next.iter().map(|entry| entry.id.as_str()));
    next.push(CustomDictionaryEntry { id, reading: reading.to_string(), word: word.to_string() });
    Ok(next)
}

#[cfg(any(feature = "gpui", test))]
pub fn delete_dictionary_entry(
    entries: &[CustomDictionaryEntry],
    id: &str,
) -> Vec<CustomDictionaryEntry> {
    entries.iter().filter(|entry| entry.id != id).cloned().collect()
}

#[cfg(any(feature = "gpui", test))]
pub fn merge_dictionary_entries(
    existing: &[CustomDictionaryEntry],
    imported: Vec<CustomDictionaryEntry>,
) -> Vec<CustomDictionaryEntry> {
    let mut merged = existing.to_vec();
    for mut entry in imported {
        entry.id = next_profile_id("entry", merged.iter().map(|item| item.id.as_str()));
        merged.push(entry);
    }
    merged
}

pub fn geometry_from_style(style: &NativeStyleSettings) -> OverlayGeometry {
    let mut geometry = OverlayGeometry::default_1280x720();
    geometry.caption_x_percent = style.caption_x_percent;
    geometry.caption_y_percent = style.caption_y_percent;
    geometry.order = RenderOrder::SourceFirst;
    geometry.source.font_family = style.source_font_family.clone();
    geometry.source.font_weight = style.source_font_weight;
    geometry.source.letter_spacing_px = style.source_letter_spacing_px;
    geometry.source.line_height = style.source_line_height;
    geometry.source.font_size_px = style.source_font_size_px;
    geometry.source.color = style.source_color.clone();
    geometry.source.opacity = style.source_opacity;
    apply_effects(&mut geometry.source, style);
    geometry.translation.font_family = style.translation_font_family.clone();
    geometry.translation.font_weight = style.translation_font_weight;
    geometry.translation.letter_spacing_px = style.translation_letter_spacing_px;
    geometry.translation.line_height = style.translation_line_height;
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
