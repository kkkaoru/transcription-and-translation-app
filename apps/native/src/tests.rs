//! Display-free Native domain and output tests.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use caption_bridge_dictionary::CustomDictionaryEntry;

use crate::app::{
    delete_editable_text, erase_editable_text, insert_editable_text, next_caret, previous_caret,
};
use crate::debug_surfaces::{
    caption_publication, prepare_caption_publication_with, CaptionPublication,
};
use crate::domain::{
    add_dictionary_entry, delete_dictionary_entry, geometry_from_style, ingest_fixture_caption,
    layout_from_style, load_app_settings, load_style_settings, native_settings_path,
    native_style_path, parse_debug_launch, rasterize_live_caption_at_scale,
    rasterize_style_preview, save_app_settings, save_style_settings, search_dictionary_entries,
    AppTab, NativeAppSettings, NativeStyleSettings, UiLanguage, BINARY_NAME, BUILD_ID, BUNDLE_ID,
    DEFAULT_PREVIEW_SOURCE, DEFAULT_PREVIEW_TRANSLATION, PRODUCT_NAME, TABS,
};

fn unique_temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let dir = std::env::temp_dir().join(format!("kotoba-native-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn editable_text_cursor_inserts_moves_and_deletes_utf8() {
    let mut text = "新字幕".to_string();
    let mut caret = "新".len();
    insert_editable_text(&mut text, &mut caret, "しい");
    assert_eq!(text, "新しい字幕");
    assert_eq!(caret, "新しい".len());
    caret = previous_caret(&text, caret);
    assert_eq!(caret, "新し".len());
    caret = next_caret(&text, caret);
    assert_eq!(caret, "新しい".len());
    erase_editable_text(&mut text, &mut caret);
    assert_eq!(text, "新し字幕");
    delete_editable_text(&mut text, &mut caret);
    assert_eq!(text, "新し幕");
}

#[test]
fn release_build_and_idle_loop_use_bounded_resource_settings() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("[profile.release]"));
    assert!(manifest.contains("lto = \"thin\""));
    assert!(manifest.contains("strip = \"symbols\""));
    assert!(manifest.contains("panic = \"abort\""));

    let app = include_str!("app.rs");
    assert!(app.contains("IDLE_POLL_INTERVAL: Duration = Duration::from_millis(250)"));
    assert!(app.contains("ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(32)"));
    assert!(app.contains("should_check_output_window"));

    let hot_path = include_str!("hot_path.rs");
    assert!(
        hot_path.contains("OUTPUT_WINDOW_HEALTH_INTERVAL: Duration = Duration::from_millis(250)")
    );
    assert!(hot_path.contains("NATIVE_PCM_FRAME_SAMPLES: usize = 512"));

    let capture = include_str!("capture.rs");
    assert!(capture.contains("RMS_PUBLISH_INTERVAL: Duration = Duration::from_millis(100)"));
    assert!(capture.contains("DEVICE_REFRESH_INTERVAL: Duration = Duration::from_secs(30)"));
    assert!(capture.contains("TRANSLATOR_IDLE_TIMEOUT: Duration = Duration::from_secs(600)"));
    assert!(capture.contains("receiver.recv_timeout(TRANSLATOR_IDLE_TIMEOUT)"));
    assert!(capture.contains("Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES)"));
}

#[test]
fn identity_and_build_contracts() {
    assert_eq!(PRODUCT_NAME, "Kotoba Beacon Native");
    assert_eq!(BUNDLE_ID, "com.kotobabeacon.native");
    assert_eq!(BINARY_NAME, "kotoba-beacon-native");
    assert!(!BUILD_ID.is_empty());
    assert_eq!(TABS, &["Live", "Style", "Dictionary", "Output", "Settings"]);
}

#[test]
fn style_defaults_disable_background_plate() {
    let style = NativeStyleSettings::default();
    assert!(!style.background_enabled);
    assert!(style.shadow_enabled);
    assert!(style.outline_enabled);
    assert_eq!(style.font_weight, 750);
    assert_eq!(style.shadow_antialias, 3);
    assert_eq!(style.font_family, "\"Noto Sans JP Variable\", \"Noto Sans JP\", sans-serif");
}

#[test]
fn full_style_maps_to_shared_renderer() {
    let style = NativeStyleSettings {
        font_family: "Hiragino Sans".to_string(),
        font_weight: 800,
        letter_spacing_px: 2.0,
        line_height: 1.5,
        background_enabled: true,
        shadow_blur_px: 12.0,
        shadow_antialias: 4,
        outline_width_px: 5.0,
        ..NativeStyleSettings::default()
    };
    let geometry = geometry_from_style(&style);
    assert_eq!(geometry.source.font_family, "Hiragino Sans");
    assert_eq!(geometry.translation.font_weight, 800);
    assert_eq!(geometry.source.letter_spacing_px, 2.0);
    assert_eq!(geometry.source.line_height, 1.5);
    assert!(geometry.source.background_enabled);
    assert_eq!(geometry.source.shadow_blur_px, 12.0);
    assert_eq!(geometry.source.shadow_antialias, 4);
    assert_eq!(geometry.source.culling_width_px, 5.0);
}

#[test]
fn live_caption_reaches_shared_rgba_boundary() {
    let publication = caption_publication(
        &NativeStyleSettings::default(),
        "音声からの字幕",
        "Caption from speech",
    );
    assert_eq!(publication.source, "音声からの字幕");
    assert_eq!(publication.translation, "Caption from speech");
    assert_eq!(publication.width, 1280);
    assert_eq!(publication.height, 720);
    assert_eq!(publication.pixels.len(), 3_686_400);
}

#[test]
fn caption_output_raster_matches_retina_pixel_density() {
    let image = rasterize_live_caption_at_scale(
        &NativeStyleSettings::default(),
        "高解像度字幕",
        "High resolution caption",
        2.0,
    );
    assert_eq!(image.width, 2560);
    assert_eq!(image.height, 1440);
    assert_eq!(image.pixels.len(), 14_745_600);
}

#[test]
fn style_editor_has_continuous_controls_and_nested_scrolling() {
    let style = include_str!("style.rs");
    assert!(style.contains("range_value(bounds, event.position"));
    assert!(style.contains("style-settings-scroll"));
    assert!(style.contains("font-options-scroll"));
    assert!(style.contains("overflow_y_scroll()"));
    assert!(style.contains("color_square_image"));
    assert!(style.contains("hue_bar_image"));
    assert!(style.contains("preview-source-input"));
    assert!(style.contains("preview-translation-input"));
    let preview_background = style.find("\"preview-background\"").expect("preview background");
    let settings_scroll = style.find("style-settings-scroll").expect("settings scroll");
    assert!(preview_background < settings_scroll);
    assert!(style.contains("cx.stop_propagation()"));
    let app = include_str!("app.rs");
    assert!(app.contains("caption_bridge_render::font_families()"));
    assert!(!app.contains("text_system().all_font_names()"));
    assert!(!style.contains("const COLORS"));
}

#[test]
fn inactive_surfaces_do_not_rasterize() {
    let mut rasterized = false;
    let result = prepare_caption_publication_with(
        false,
        None,
        &NativeStyleSettings::default(),
        "字幕",
        "Caption",
        |_, _, _| {
            rasterized = true;
            CaptionPublication {
                source: String::new(),
                translation: String::new(),
                width: 0,
                height: 0,
                pixels: Vec::new(),
            }
        },
    );
    assert!(result.is_none());
    assert!(!rasterized);
}

#[test]
fn empty_caption_rasterizes_once_to_clear_native_publishers() {
    let previous = ("字幕".to_string(), "Caption".to_string());
    let result = prepare_caption_publication_with(
        true,
        Some(&previous),
        &NativeStyleSettings::default(),
        "",
        "",
        caption_publication,
    )
    .expect("empty transition must publish a transparent frame");
    assert!(result.pixels.iter().all(|channel| *channel == 0));
}

#[test]
fn unchanged_caption_does_not_rasterize() {
    let previous = ("字幕".to_string(), "Caption".to_string());
    let result = prepare_caption_publication_with(
        true,
        Some(&previous),
        &NativeStyleSettings::default(),
        "字幕",
        "Caption",
        |_, _, _| CaptionPublication {
            source: String::new(),
            translation: String::new(),
            width: 0,
            height: 0,
            pixels: Vec::new(),
        },
    );
    assert!(result.is_none());
}

#[test]
fn recognition_has_no_process_or_socket_ipc_dependency() {
    let manifest = include_str!("../Cargo.toml");
    let capture = include_str!("capture.rs");
    assert!(manifest.contains("parapper-engine ="));
    assert!(!manifest.contains("caption-bridge-overlay"));
    assert!(!manifest.contains("caption-bridge-sidecar"));
    assert!(!manifest.contains("tungstenite"));
    assert!(!capture.contains("std::process::Command"));
    assert!(!capture.contains("WebSocket"));
}

#[test]
fn replaced_gpui_rasters_are_removed_from_the_gpu_atlas() {
    let source = include_str!("app.rs");
    assert!(source.contains("window.drop_image(previous_image)"));
    assert!(source.contains("self.stale_render_images.drain(..)"));
    assert!(!source.contains("cx.notify();\n                (caption, style)"));
}

#[test]
fn app_content_has_no_identity_header_or_footer() {
    let source = include_str!("app.rs");
    assert!(!source.contains("child(heading(PRODUCT_NAME))"));
    assert!(!source.contains("bundle id:"));
    assert!(!source.contains("active tab:"));
    assert!(!source.contains("toggle_overlay"));
}

#[test]
fn fixture_and_preview_render() {
    let caption = ingest_fixture_caption().expect("fixture must ingest");
    assert_eq!(caption.source_text, "こんにちは。");
    let image = rasterize_style_preview(
        &NativeStyleSettings::default(),
        DEFAULT_PREVIEW_SOURCE,
        DEFAULT_PREVIEW_TRANSLATION,
    );
    assert_eq!(image.width, 1280);
    assert_eq!(image.height, 360);
    assert_eq!(image.pixels.len(), 1_843_200);
}

#[test]
fn command_line_has_no_overlay_flag() {
    let launch = parse_debug_launch(["--overlay", "--syphon"]);
    assert!(launch.syphon);
    assert!(!launch.spout);
    let spout = parse_debug_launch(["--spout"]);
    assert!(!spout.syphon);
    assert!(spout.spout);
}

#[test]
fn tabs_include_capture_output() {
    assert_eq!(AppTab::from_label("Live"), Some(AppTab::Live));
    assert_eq!(AppTab::from_label("Output"), Some(AppTab::Output));
    assert_eq!(AppTab::from_label("Settings"), Some(AppTab::Settings));
    assert_eq!(AppTab::from_label("Nope"), None);
}

#[test]
fn settings_support_one_ui_language_at_a_time() {
    assert_ne!(UiLanguage::Japanese, UiLanguage::English);
    let source = include_str!("ui.rs");
    assert!(!source.contains("Live ライブ"));
    assert!(!source.contains("ライブ Live"));
}

#[test]
fn style_round_trip_preserves_new_native_fields() {
    let dir = unique_temp_dir("style");
    let style = NativeStyleSettings {
        font_family: "Hiragino Sans".to_string(),
        background_enabled: true,
        preview_background_color: "#ffffff".to_string(),
        ..NativeStyleSettings::default()
    };
    save_style_settings(&dir, &style).expect("save style");
    let loaded = load_style_settings(&dir).expect("load style");
    assert_eq!(loaded.font_family, "Hiragino Sans");
    assert!(loaded.background_enabled);
    assert_eq!(loaded.preview_background_color, "#ffffff");
    assert!(native_style_path(&dir).ends_with("caption-style.json"));
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn old_style_json_migrates_with_defaults() {
    let dir = unique_temp_dir("old-style");
    fs::write(
        native_style_path(&dir),
        r##"{"version":1,"sourceFontSizePx":42.0,"sourceColor":"#ffffff","sourceOpacity":1.0,"sourceMaxChars":32,"translationFontSizePx":29.0,"translationColor":"#bfe8ff","translationOpacity":1.0,"translationMaxChars":36,"captionXPercent":50.0,"captionYPercent":88.0}"##,
    )
    .expect("write old style");
    let loaded = load_style_settings(&dir).expect("migrate old style");
    assert_eq!(loaded.source_font_size_px, 42.0);
    assert!(!loaded.background_enabled);
    assert_eq!(loaded.font_weight, 750);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn app_settings_round_trip_language_translation_timeout_and_output() {
    let dir = unique_temp_dir("settings");
    let settings = NativeAppSettings {
        ui_language: UiLanguage::English,
        translation_enabled: false,
        caption_timeout_ms: 7_000,
        caption_output_open_on_start: false,
        browser_source_enabled: false,
        ..NativeAppSettings::default()
    };
    save_app_settings(&dir, &settings).expect("save settings");
    let loaded = load_app_settings(&dir).expect("load settings");
    assert_eq!(loaded.ui_language, UiLanguage::English);
    assert!(!loaded.translation_enabled);
    assert_eq!(loaded.caption_timeout_ms, 7_000);
    assert!(!loaded.caption_output_open_on_start);
    assert!(!loaded.browser_source_enabled);
    assert!(native_settings_path(&dir).ends_with("settings.json"));
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn dictionary_can_delete_any_selected_word() {
    let entries = vec![
        CustomDictionaryEntry {
            id: "entry-1".to_string(),
            reading: "いち".to_string(),
            word: "一".to_string(),
        },
        CustomDictionaryEntry {
            id: "entry-2".to_string(),
            reading: "に".to_string(),
            word: "二".to_string(),
        },
    ];
    let remaining = delete_dictionary_entry(&entries, "entry-2");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].word, "一");
    let added = add_dictionary_entry(&remaining, "さん", "三").expect("add");
    assert_eq!(search_dictionary_entries(&added, "さん")[0].word, "三");
}

#[test]
fn layout_uses_configured_max_characters() {
    let style = NativeStyleSettings { source_max_chars: 16, ..NativeStyleSettings::default() };
    assert_eq!(layout_from_style(&style).source_max_chars, 16);
}

#[cfg(feature = "gpui")]
#[test]
fn window_options_keep_native_identity() {
    use crate::app::main_window_options;
    use crate::domain::{WINDOW_HEIGHT_PX, WINDOW_WIDTH_PX};
    use gpui::{px, WindowBounds};

    let options = main_window_options();
    assert_eq!(options.app_id.as_deref(), Some("com.kotobabeacon.native"));
    let bounds = match options.window_bounds.expect("bounds") {
        WindowBounds::Windowed(bounds) => bounds,
        _ => panic!("expected windowed bounds"),
    };
    assert_eq!(bounds.size.width, px(WINDOW_WIDTH_PX));
    assert_eq!(bounds.size.height, px(WINDOW_HEIGHT_PX));
}

#[test]
fn caption_output_is_created_behind_the_main_window() {
    let app = include_str!("app.rs");
    let output = app.find("let mut output_window").expect("output window creation");
    let main = app.find("let window_handle").expect("main window creation");
    assert!(output < main);
    assert!(app.contains("focus: false"));
    assert!(!app.contains("cx.activate("));
}
