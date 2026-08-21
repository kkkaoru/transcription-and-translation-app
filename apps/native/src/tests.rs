//! Display-free tests for Native domain, capture helpers, and identity.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use caption_bridge_dictionary::CustomDictionaryEntry;
use caption_bridge_spout::NATIVE_SPOUT_SHARE_NAME;
use caption_bridge_syphon::{NATIVE_SYPHON_SERVER_NAME, WINDOWS_SYPHON_UNSUPPORTED};

use crate::capture::caption_from_server_json;
use crate::debug_surfaces::{
    caption_publication, prepare_caption_publication_with, start_debug_surfaces, CaptionPublication,
};
use crate::domain::{
    add_dictionary_entry, adjust_font_size, adjust_max_chars, adjust_opacity, adjust_position,
    cycle_source_color, cycle_translation_color, delete_dictionary_entry, geometry_from_style,
    ingest_fixture_caption, layout_from_style, load_style_settings, missing_sidecar_message,
    native_style_path, parse_debug_launch, rasterize_style_preview, run_stub_lines,
    save_style_settings, search_dictionary_entries, AppTab, CaptureStatus, DebugLaunch,
    NativeStyleSettings, BINARY_NAME, BUNDLE_ID, DEFAULT_PREVIEW_SOURCE,
    DEFAULT_PREVIEW_TRANSLATION, FONT_SIZE_STEP, PRODUCT_NAME, TABS,
};

fn unique_temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let dir = std::env::temp_dir().join(format!("kotoba-native-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn identity_strings() {
    assert_eq!(PRODUCT_NAME, "Kotoba Beacon Native");
    assert_eq!(BUNDLE_ID, "com.kotobabeacon.native");
    assert_eq!(BINARY_NAME, "kotoba-beacon-native");
    assert_eq!(TABS, &["Live", "Style", "Dictionary", "Settings"]);
}

#[test]
fn live_caption_reaches_debug_surface_publication_boundary() {
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
    assert!(publication.pixels.iter().any(|channel| *channel != 0));
}

#[test]
fn inactive_surfaces_skip_caption_rasterization() {
    let mut rasterized = false;
    let publication = prepare_caption_publication_with(
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

    assert!(publication.is_none());
    assert!(!rasterized, "inactive surfaces must not rasterize a 1280x720 frame");
}

#[test]
fn unchanged_caption_text_skips_caption_rasterization() {
    let previous = ("字幕".to_string(), "Caption".to_string());
    let mut rasterized = false;
    let publication = prepare_caption_publication_with(
        true,
        Some(&previous),
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

    assert!(publication.is_none());
    assert!(!rasterized, "deduplication must use caption text before rasterizing");
}

#[test]
fn changed_caption_text_rasterizes_even_without_a_generation_key() {
    let previous = ("前の字幕".to_string(), "Previous".to_string());
    let publication = prepare_caption_publication_with(
        true,
        Some(&previous),
        &NativeStyleSettings::default(),
        "次の字幕",
        "Next",
        |_, source, translation| CaptionPublication {
            source: source.to_string(),
            translation: translation.to_string(),
            width: 1,
            height: 1,
            pixels: vec![255, 255, 255, 255],
        },
    )
    .expect("changed caption text must rasterize");

    assert_eq!(publication.source, "次の字幕");
    assert_eq!(publication.translation, "Next");
}

#[test]
fn gpui_poll_loop_invokes_live_caption_publication() {
    let app_source = include_str!("app.rs");
    let required_tick = "view.capture.poll();\n                    view.publish_live_caption();\n                    cx.notify();";

    assert!(
        app_source.contains(required_tick),
        "the GPUI poll loop must publish caption state after polling capture"
    );
}

#[test]
fn fixture_caption_contains_konnichiwa() {
    let caption = ingest_fixture_caption().expect("fixture must ingest");
    assert_eq!(caption.source_text, "こんにちは。");
    assert_eq!(caption.frame_width, 1280);
    assert_eq!(caption.frame_height, 720);
}

#[test]
fn parse_debug_launch_recognizes_overlay_syphon_and_spout_flags() {
    let none = parse_debug_launch(["cargo", "run"]);
    assert!(!none.overlay);
    assert!(!none.syphon);
    assert!(!none.spout);
    let overlay = parse_debug_launch(["--overlay"]);
    assert!(overlay.overlay);
    assert!(!overlay.syphon);
    assert!(!overlay.spout);
    let both = parse_debug_launch(["--syphon", "--overlay"]);
    assert!(both.overlay);
    assert!(both.syphon);
    assert!(!both.spout);
    let spout = parse_debug_launch(["--spout"]);
    assert!(!spout.overlay);
    assert!(!spout.syphon);
    assert!(spout.spout);
}

#[test]
fn macos_spout_flag_is_a_helpful_error() {
    match start_debug_surfaces(DebugLaunch { overlay: false, syphon: false, spout: true }) {
        Err(error) => assert_eq!(
            error,
            "Spout2 does not run on macOS; use --syphon to publish Kotoba Beacon Native"
        ),
        Ok(_) => panic!("Spout cannot start on this Mac"),
    }
}

#[test]
fn native_output_names_stay_distinct_from_tauri() {
    assert_eq!(NATIVE_SYPHON_SERVER_NAME, "Kotoba Beacon Native");
    assert_eq!(NATIVE_SPOUT_SHARE_NAME, "Kotoba Beacon Native");
    assert_ne!(NATIVE_SYPHON_SERVER_NAME, "Kotoba Beacon");
    assert_eq!(
        WINDOWS_SYPHON_UNSUPPORTED,
        "Syphon is macOS-only; use --spout to publish Kotoba Beacon Native via Spout2"
    );
}

#[test]
fn stub_lines_include_identity_and_fixture() {
    let lines = run_stub_lines();
    assert_eq!(lines[0], "Kotoba Beacon Native");
    assert_eq!(lines[1], "bundle id: com.kotobabeacon.native");
    assert_eq!(lines[2], "planned tabs:");
    assert_eq!(lines[3], "  - Live");
    assert_eq!(lines[4], "  - Style");
    assert_eq!(lines[5], "  - Dictionary");
    assert_eq!(lines[6], "  - Settings");
    assert_eq!(lines[7], "fixture caption: こんにちは。");
    assert_eq!(lines[8], "raster: 1280x720");
}

#[test]
fn tabs_switch_from_labels() {
    assert_eq!(AppTab::from_label("Live"), Some(AppTab::Live));
    assert_eq!(AppTab::from_label("Style"), Some(AppTab::Style));
    assert_eq!(AppTab::from_label("Dictionary"), Some(AppTab::Dictionary));
    assert_eq!(AppTab::from_label("Settings"), Some(AppTab::Settings));
    assert_eq!(AppTab::from_label("Nope"), None);
    assert_eq!(AppTab::Live.label(), "Live");
    assert_eq!(AppTab::Style.japanese_label(), "スタイル");
}

#[test]
fn capture_status_labels_are_japanese() {
    assert_eq!(CaptureStatus::Idle.label(), "待機");
    assert_eq!(CaptureStatus::Capturing.label(), "収録中");
    assert_eq!(CaptureStatus::Error.label(), "エラー");
}

#[test]
fn missing_sidecar_names_binary_and_port() {
    let message = missing_sidecar_message();
    assert!(message.contains("kotoba-parapper"));
    assert!(message.contains("18182"));
}

#[test]
fn style_adjusters_clamp_and_cycle_colors() {
    assert_eq!(adjust_font_size(12.0, -FONT_SIZE_STEP), 12.0);
    assert_eq!(adjust_font_size(70.0, FONT_SIZE_STEP), 72.0);
    assert_eq!(adjust_opacity(0.2, -0.1), 0.2);
    assert_eq!(adjust_opacity(1.0, 0.1), 1.0);
    assert_eq!(adjust_position(5.0, -5.0), 5.0);
    assert_eq!(adjust_position(95.0, 5.0), 95.0);
    assert_eq!(adjust_max_chars(8, -4), 8);
    assert_eq!(adjust_max_chars(80, 4), 80);
    assert_eq!(cycle_source_color("#ffffff"), "#ffe08a");
    assert_eq!(cycle_source_color("#ffe08a"), "#7dffb3");
    assert_eq!(cycle_source_color("#7dffb3"), "#ffffff");
    assert_eq!(cycle_translation_color("#bfe8ff"), "#ffb4d9");
    assert_eq!(cycle_translation_color("#ffb4d9"), "#d4ff9a");
    assert_eq!(cycle_translation_color("#d4ff9a"), "#bfe8ff");
}

#[test]
fn style_persists_under_native_config_dir_not_tauri() {
    let dir = unique_temp_dir("style");
    let settings = NativeStyleSettings {
        source_font_size_px: 42.0,
        caption_x_percent: 25.0,
        ..NativeStyleSettings::default()
    };
    save_style_settings(&dir, &settings).expect("save style");
    let loaded = load_style_settings(&dir).expect("load style");
    assert_eq!(loaded.source_font_size_px, 42.0);
    assert_eq!(loaded.caption_x_percent, 25.0);
    let path = native_style_path(&dir);
    assert!(path.ends_with("caption-style.json"));
    let raw = path.to_string_lossy();
    assert!(!raw.contains("com.kotobabeacon.desktop"));
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn style_preview_raster_matches_configured_plate() {
    let image = rasterize_style_preview(
        &NativeStyleSettings::default(),
        DEFAULT_PREVIEW_SOURCE,
        DEFAULT_PREVIEW_TRANSLATION,
    );
    assert_eq!(image.width, 640);
    assert_eq!(image.height, 180);
    assert_eq!(image.pixels.len(), 640 * 180 * 4);
}

#[test]
fn style_maps_into_session_geometry_and_layout() {
    let settings = NativeStyleSettings {
        source_font_size_px: 40.0,
        source_max_chars: 16,
        caption_x_percent: 20.0,
        ..NativeStyleSettings::default()
    };
    let geometry = geometry_from_style(&settings);
    let layout = layout_from_style(&settings);
    assert_eq!(geometry.source.font_size_px, 40.0);
    assert_eq!(geometry.caption_x_percent, 20.0);
    assert_eq!(layout.source_max_chars, 16);
}

#[test]
fn dictionary_add_search_and_delete() {
    let empty: Vec<CustomDictionaryEntry> = Vec::new();
    let added = add_dictionary_entry(&empty, "ぶいあーるちゃっと", "VRC").expect("add sample");
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].reading, "ぶいあーるちゃっと");
    assert_eq!(added[0].word, "VRC");
    let found = search_dictionary_entries(&added, "ぶい");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].word, "VRC");
    let remaining = delete_dictionary_entry(&added, &added[0].id);
    assert!(remaining.is_empty());
    let rejected = add_dictionary_entry(&empty, "   ", "VRC");
    assert_eq!(rejected, Err("読みと単語の両方を入力してください".to_string()));
}

#[test]
fn dictionary_save_round_trip_uses_native_dir() {
    let dir = unique_temp_dir("dict");
    let entries = vec![CustomDictionaryEntry {
        id: "entry-1".to_string(),
        reading: "てすと".to_string(),
        word: "TEST".to_string(),
    }];
    let saved = crate::domain::save_dictionary_entries(&dir, &entries).expect("save dict");
    assert_eq!(saved[0].word, "TEST");
    let loaded = crate::domain::load_dictionary_entries(&dir).expect("load dict");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].reading, "てすと");
    let json = dir.join("dictionary").join("custom_dictionary.json");
    assert!(json.exists());
    let raw = json.to_string_lossy();
    assert!(!raw.contains("com.kotobabeacon.desktop"));
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn parapper_json_becomes_live_caption_pair() {
    let json = r#"{"version":1,"type":"turn.final","session_id":"fixture-session","turn_session_id":7,"turn_id":3,"revision":2,"output_sequence":2,"segment_id":8,"previous_segment_id":7,"text":"こんにちは。","source_asr_model":"reazonspeech_k2_v2","source_language":"ja","detected_language":null,"audio_duration_ms":1280,"elapsed_ms":96}"#;
    let mut caption_session = crate::capture::CaptionSessionLike::new();
    let (source, translation) =
        caption_from_server_json(json, &mut caption_session).expect("caption");
    assert_eq!(source, "こんにちは。");
    assert_eq!(translation, "");
}

#[test]
fn start_without_sidecar_binary_is_readable() {
    let previous_path = std::env::var_os("PATH");
    std::env::set_var("PATH", "/var/empty-native-sidecar-path");
    let mut controller = crate::capture::CaptureController::new();
    let result = controller.start();
    match previous_path {
        Some(value) => std::env::set_var("PATH", value),
        None => std::env::remove_var("PATH"),
    }
    match result {
        Err(error) => {
            assert!(error.contains("kotoba-parapper"));
            assert!(error.contains("18182"));
        }
        Ok(()) => panic!("sidecar must be missing in this environment"),
    }
}

#[cfg(feature = "gpui")]
#[test]
fn window_options_match_identity() {
    use crate::app::main_window_options;
    use crate::domain::{WINDOW_HEIGHT_PX, WINDOW_TITLE, WINDOW_WIDTH_PX};
    use gpui::{px, WindowBounds};

    let options = main_window_options();

    let titlebar = options.titlebar.expect("titlebar should be set");
    assert_eq!(titlebar.title.as_deref().expect("title should be set"), WINDOW_TITLE);

    assert_eq!(options.app_id.as_deref().expect("app_id should be set"), BUNDLE_ID);
    assert!(options.is_resizable);

    let bounds = match options.window_bounds.as_ref().expect("window_bounds should be set") {
        WindowBounds::Windowed(bounds) => *bounds,
        _ => panic!("expected Windowed bounds"),
    };
    assert_eq!(bounds.size.width, px(WINDOW_WIDTH_PX));
    assert_eq!(bounds.size.height, px(WINDOW_HEIGHT_PX));
}
