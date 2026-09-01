//! Display-free Native domain and output tests.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::app::{capture_display_active, main_window_options, output_window_options};
use crate::debug_surfaces::{
    caption_publication, prepare_caption_publication_with, CaptionPublication,
};
use crate::domain::{
    add_dictionary_entry, add_dictionary_profile, add_style_profile, clear_selected_dictionary,
    delete_dictionary_entry, delete_selected_dictionary_profile, delete_selected_style_profile,
    export_dictionary_csv, geometry_from_style, ingest_fixture_caption, layout_from_style,
    load_app_settings, load_dictionary_catalog, load_style_catalog, load_style_settings,
    native_settings_path, native_style_path, parse_debug_launch, parse_dictionary_delimited,
    rasterize_live_caption_at_scale, rasterize_style_preview, replace_selected_dictionary_entries,
    save_app_settings, save_dictionary_catalog, save_style_catalog, save_style_settings,
    search_dictionary_entries, select_dictionary_profile, select_style_profile, AppTab,
    NativeAppSettings, NativeDictionaryCatalog, NativeStyleCatalog, NativeStyleSettings,
    UiLanguage, BINARY_NAME, BUILD_ID, BUNDLE_ID, DEFAULT_PREVIEW_SOURCE,
    DEFAULT_PREVIEW_TRANSLATION, PRODUCT_NAME, TABS,
};
use caption_bridge_dictionary::CustomDictionaryEntry;

fn unique_temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    let dir = std::env::temp_dir().join(format!("kotoba-native-{label}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn capture_display_is_compact_only_while_audio_resources_are_active() {
    assert!(!capture_display_active(crate::domain::CaptureStatus::Idle));
    assert!(capture_display_active(crate::domain::CaptureStatus::Capturing));
    assert!(capture_display_active(crate::domain::CaptureStatus::Stopping));
    assert!(!capture_display_active(crate::domain::CaptureStatus::Error));
}

#[test]
fn native_text_fields_use_ime_capable_input_state() {
    let app = include_str!("app.rs");
    let dictionary = include_str!("dictionary.rs");
    let style = include_str!("style.rs");

    for field in [
        "query_input: Entity<InputState>",
        "reading_input: Entity<InputState>",
        "word_input: Entity<InputState>",
        "preview_source_input: Entity<InputState>",
        "preview_translation_input: Entity<InputState>",
    ] {
        assert!(app.contains(field), "missing IME-capable state: {field}");
    }
    assert!(dictionary.contains("Input::new(input)"));
    assert!(style.contains("Input::new(input)"));
    assert!(!app.contains("event.keystroke.key_char"));
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
    assert!(!capture.contains("DEVICE_REFRESH_INTERVAL"));
    assert!(capture.contains("input_devices_changed() && self.refresh_devices()"));
    assert!(capture.contains("latest_request: Option<TranslationRequest>"));
    assert!(capture.contains("state.latest_request = Some(request)"));
    assert!(capture.contains("TRANSLATOR_IDLE_TIMEOUT: Duration = Duration::from_secs(60)"));
    assert!(capture.contains("MINIMUM_PAIRED_CAPTION_HOLD: Duration = Duration::from_secs(3)"));
    assert!(capture.contains("receiver.recv_timeout(TRANSLATOR_IDLE_TIMEOUT)"));
    assert!(capture.contains("translator = None"));
    assert!(capture.contains("drop(worker.sender)"));
    assert!(capture.contains("worker.handle.join()"));
    assert!(capture.contains("Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES)"));
    assert!(capture.contains("SetTranslationEnabled(bool)"));
    assert!(capture.contains("apply_turn_caption_update"));
    assert!(capture.contains("release_unused_process_memory"));
    assert!(capture.contains("companion_route: desktop_pipeline_route()"));
    assert!(capture.contains("self.companion_route = desktop_pipeline_route()"));
    assert!(capture.contains("asr: ExecutionDevice::Desktop"));
    assert!(capture.contains("azookey: ExecutionDevice::Desktop"));
    assert!(capture.contains("translation: ExecutionDevice::Desktop"));

    let live = include_str!("live.rs");
    assert!(live.contains("live-translation-enabled"));
    assert!(live.contains("settings.show_translation_result && translation_enabled"));
    assert!(live.contains("live-copy-error"));
    assert!(live.contains("live-refresh-devices"));
    assert!(live.contains("ClipboardItem::new_string"));
    assert!(app.contains("on_toggle_translation: |view| view.toggle_translation()"));
    assert!(app.contains("style_preview_image: Option<Arc<RenderImage>>"));
    assert!(app.contains("self.style_preview_image.take()"));
    assert!(app.contains("capture_view_compact"));
    assert!(app.contains("window.resize(size(px(CAPTURE_WINDOW_WIDTH_PX)"));
    assert!(app.contains("Some(window.viewport_size())"));
    assert!(app.contains("(!self.capture_view_compact)"));
    assert!(app.contains(".then(|| tab_bar"));
    assert!(app.contains("let fonts = Vec::new()"));
    assert!(app.contains("self.fonts.shrink_to_fit()"));
    assert!(!app.contains("entries: Vec<CustomDictionaryEntry>"));
    let caption_publish = app
        .find("let output_changed = view.publish_live_caption()")
        .expect("capture loop must publish subtitles");
    let compact_display = app
        .find("view.update_capture_display(status, window)")
        .expect("capture loop must compact only the management display");
    assert!(caption_publish < compact_display);

    let memory = include_str!("memory.rs");
    assert!(memory.contains("MallocLargeCache"));
    assert!(memory.contains("malloc_zone_pressure_relief"));

    let translation =
        include_str!("../../../crates/parapper-engine/src/quickmt_translation_engine.rs");
    assert!(translation.contains("compute_type: ComputeType::INT8"));
    assert!(translation.contains("num_threads_per_replica: 1"));
    assert!(translation.contains("max_queued_batches: 1"));
    assert!(translation.contains("max_batch_size: 1"));
    let engine_load = capture
        .find("ParapperEngine::load(&config)")
        .expect("Native must initialize selected desktop recognition before loading QuickMT");
    let translation_start = capture
        .find("let mut translation_worker =")
        .expect("Native must create one translation worker");
    assert!(engine_load < translation_start);
    assert!(capture.contains("companion_route.asr == ExecutionDevice::Desktop"));
    assert!(capture.contains("companion_route.translation == ExecutionDevice::Desktop"));
    let audio_start = capture
        .find("capture.start(device_id.as_deref())")
        .expect("Native must start its selected microphone");
    assert!(translation_start < audio_start);
    assert!(capture.contains("if !sender.request_warmup()"));
    assert!(!capture.contains("request_translation_warmup("));

    let engine = include_str!("../../../crates/parapper-engine/src/lib.rs");
    assert!(engine.contains("QuickMtJaEnEngine::load(models_root)"));
    assert!(engine.contains("#[cfg(feature = \"translation-comparison\")]"));

    let engine_manifest = include_str!("../../../crates/parapper-engine/Cargo.toml");
    assert!(engine_manifest.contains("default = []"));
    assert!(engine_manifest.contains("translation-comparison = []"));
    assert!(engine_manifest.contains("target_arch = \"aarch64\""));
    assert!(engine_manifest.contains("features = [\"ruy\", \"sentencepiece\"]"));
    assert!(engine_manifest.contains("not(target_arch = \"aarch64\")"));
    assert!(engine_manifest.contains("features = [\"dnnl\", \"sentencepiece\"]"));

    let build_script = include_str!("../build.rs");
    assert!(build_script.contains("track_git_revision()"));
    assert!(build_script.contains("strip_prefix(\"ref: \")"));
    assert!(build_script.contains("git_dir.join(reference)"));

    let cargo_config = include_str!("../../../.cargo/config.toml");
    assert!(cargo_config.contains("target.x86_64-pc-windows-msvc"));
    assert!(cargo_config.contains("target-feature=+crt-static"));

    let makefile = include_str!("../../../Makefile");
    assert!(makefile.contains("build: native-install"));
    assert!(makefile.contains("native-package: native-release"));
    assert!(makefile.contains("native-install: native-package"));
    assert!(makefile.contains("native-replace: native-install"));
    assert!(makefile.contains("cargo build --locked --release --manifest-path $(NATIVE_MANIFEST)"));
    assert!(makefile.contains("assembleNativeApp"));
    assert!(makefile.contains("Stop the running app"));
    let installer = include_str!("../../../scripts/install-macos-native-app.mjs");
    assert!(installer.contains("terminateRunningNativeApp(installApp)"));
    assert!(installer.contains("[\"-TERM\", \"-f\", pattern]"));

    let ci = include_str!("../../../.github/workflows/ci.yml");
    let native_test_step = ci
        .split("- name: Test Native\n")
        .nth(1)
        .and_then(|steps| steps.split("- name: Build Native release").next())
        .expect("Native CI test step must remain present");
    assert!(native_test_step.contains("RUST_TEST_THREADS: 1"));
    assert!(ci.contains("crates/caption-bridge-audio/Cargo.toml"));
    assert!(ci.contains("crates/caption-bridge-japanese-text/Cargo.toml"));
    assert!(ci.contains("crates/caption-bridge-fonts/Cargo.toml"));
    assert!(ci.contains("crates/caption-bridge-browser-source/Cargo.toml"));
    assert!(ci.contains("crates/caption-bridge-render/Cargo.toml"));
    assert!(native_test_step.contains("cargo test --locked --manifest-path apps/native/Cargo.toml"));
}

#[test]
fn onnx_runtime_initializes_between_platform_creation_and_event_loop() {
    let app = include_str!("app.rs");
    let platform_init = app
        .find("let application = gpui_platform::application()")
        .expect("Native must initialize the OS UI platform");
    let runtime_init = app
        .find("parapper_engine::initialize_onnx_runtime()")
        .expect("Native must initialize ONNX Runtime explicitly");
    let event_loop = app.find("application.run(").expect("Native must start the GPUI event loop");

    assert!(platform_init < runtime_init, "the OS UI platform must exist before ONNX Runtime");
    assert!(runtime_init < event_loop, "ONNX Runtime must initialize before recognition can start");
}

#[test]
fn identity_and_build_contracts() {
    assert_eq!(PRODUCT_NAME, "Kotoba Beacon Native");
    assert_eq!(BUNDLE_ID, "com.kotobabeacon.native");
    assert_eq!(BINARY_NAME, "kotoba-beacon-native");
    assert!(!BUILD_ID.is_empty());
    assert_eq!(TABS, &["Live", "Style", "Dictionary", "Settings"]);
}

#[test]
fn style_defaults_disable_background_plate() {
    let style = NativeStyleSettings::default();
    assert!(!style.background_enabled);
    assert!(style.shadow_enabled);
    assert!(style.outline_enabled);
    assert_eq!(style.source_font_weight, 750);
    assert_eq!(style.translation_font_weight, 650);
    assert_eq!(style.shadow_antialias, 3);
    assert_eq!(style.source_font_family, "\"Noto Sans JP\", sans-serif");
}

#[test]
fn full_style_maps_to_shared_renderer() {
    let style = NativeStyleSettings {
        source_font_family: "Hiragino Sans".to_string(),
        translation_font_weight: 800,
        source_letter_spacing_px: 2.0,
        source_line_height: 1.5,
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
    assert!(style.contains("source-font-family"));
    assert!(style.contains("translation-font-family"));
    assert!(style.contains("copy-recognition-to-translation"));
    assert!(style.contains("copy-translation-to-recognition"));
    assert!(style.contains("style-reset-all"));
    assert!(!style.contains("event.dragging()"));
    assert!(style.matches("event.drag(app).is_owned_by").count() >= 2);
    assert!(style.contains("StylePointerDrag::new"));
    assert!(!style.contains("TextKey::Typography"));
    assert!(style.contains("overflow_y_scroll()"));
    assert!(style.contains("ColorPicker::new(color_pickers.state(id))"));
    assert!(style.contains("ColorPickerState::new(window, cx)"));
    assert!(!style.contains("color_square_image"));
    assert!(!style.contains("hue_bar_image"));
    assert!(style.contains("preview-source-input"));
    assert!(style.contains("preview-translation-input"));
    let preview_surface = style.find("style-preview-surface").expect("preview surface");
    let settings_scroll = style.find("style-settings-scroll").expect("settings scroll");
    assert!(preview_surface < settings_scroll);
    assert!(style.contains("PreviewImageHint"));
    assert!(style.contains("preview-image-position-reset"));
    assert!(style.contains("preview-image-delete"));
    assert!(!style.contains("TextKey::PreviewBackground"));
    assert!(style.contains(
        ".child(h_flex().items_start().gap_3().child(outline).child(shadow))\n                .child(background)"
    ));
    let app = include_str!("app.rs");
    assert!(app.contains("caption_bridge_render::font_families()"));
    assert!(!app.contains("text_system().all_font_names()"));
    assert!(!style.contains("const COLORS"));
}

#[test]
fn live_result_rows_reserve_one_line_before_wrapping() {
    let live = include_str!("live.rs");
    assert!(live.contains("selectable_text(source).min_h_7().text_lg()"));
    assert!(live.contains("selectable_text(translation).min_h_7().text_lg()"));
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
fn local_recognition_has_no_process_or_socket_transport_dependency() {
    let manifest = include_str!("../Cargo.toml");
    let capture = include_str!("capture.rs");
    let companion = include_str!("companion.rs");
    assert!(manifest.contains("parapper-engine ="));
    assert!(!manifest.contains("caption-bridge-overlay"));
    assert!(!manifest.contains("caption-bridge-sidecar"));
    assert!(manifest.contains("tungstenite ="));
    assert!(!capture.contains("std::process::Command"));
    assert!(!capture.contains("WebSocket"));
    assert!(companion.contains("WebSocket"));
}

#[test]
fn replaced_gpui_rasters_are_removed_from_the_gpu_atlas() {
    let source = include_str!("app.rs");
    assert!(source.contains("window.drop_image(previous_image)"));
    assert!(source.contains("self.stale_render_images.drain(..)"));
    assert!(!source.contains("cx.notify();\n                (caption, style)"));
}

#[test]
fn native_ui_uses_gpui_component_roots_controls_and_theme_tokens() {
    let manifest = include_str!("../Cargo.toml");
    let app = include_str!("app.rs");
    let ui = include_str!("ui.rs");
    let live = include_str!("live.rs");
    let output = include_str!("output.rs");
    let settings = include_str!("settings.rs");
    let dictionary = include_str!("dictionary.rs");
    let style = include_str!("style.rs");

    assert!(manifest.contains("gpui-component ="));
    assert!(app.contains("gpui_component::init(cx)"));
    assert!(app.contains("Root::new(view, window, cx)"));
    assert!(ui.contains("TabBar::new"));
    assert!(ui.contains("Button::new"));
    assert!(live.contains("Switch::new"));
    assert!(live.contains(".dropdown_menu("));
    assert!(output.contains("Switch::new"));
    assert!(settings.contains("GroupBox::new"));
    assert!(dictionary.contains("danger_button("));
    assert!(dictionary.contains("TextKey::DownloadCsv"));
    assert!(dictionary.contains("TextKey::DefaultDictionary"));
    assert!(!dictionary.contains("DownloadTsv"));
    assert!(app.contains("prompt_for_new_path"));
    assert!(style.contains("Switch::new"));
    assert!(style.contains("ColorPicker::new"));
    assert!(style.contains("cx.theme().primary"));
    assert!(!ui.contains("rgb(0x"));
    assert!(!live.contains("rgb(0x"));
    assert!(!output.contains("rgb(0x"));
    assert!(!settings.contains("rgb(0x"));
    assert!(!dictionary.contains("rgb(0x"));
}

#[test]
fn native_ui_keeps_a_small_accessible_visual_vocabulary() {
    let ui = include_str!("ui.rs");
    let live = include_str!("live.rs");
    let output = include_str!("output.rs");
    let settings = include_str!("settings.rs");
    let dictionary = include_str!("dictionary.rs");
    let style = include_str!("style.rs");
    let sources = [ui, live, output, settings, dictionary, style];

    for source in sources {
        assert!(!source.contains(".text_xs()"));
        assert!(!source.contains(".text_xl()"));
        assert!(!source.contains(".font_bold()"));
        assert!(!source.contains(".ghost()"));
        assert!(!source.contains(".gap_1()"));
        assert!(!source.contains(".gap_4()"));
    }
    assert!(ui.contains(".text_base()"));
    assert!(ui.contains(".text_sm()"));
    assert!(ui.contains("theme().muted_foreground"));
    assert!(ui.contains("TextView::markdown"));
    assert!(ui.contains(".selectable(true)"));
    assert!(live.contains("selectable_text(source)"));
    assert!(settings.contains("selectable_text(format!("));
    assert!(dictionary.contains("selectable_text(format!("));
    assert!(!ui.contains(".opacity("));
    assert!(live.contains("selectable_text(source).min_h_7().text_lg()"));
    assert!(live.contains(".primary()"));
    assert!(settings.contains("settings-mobile-companion-enabled"));
    assert!(dictionary.contains("danger_button("));
    assert!(style.contains("danger_button("));
    assert!(ui.contains("Button::new(id).outline().label(label)"));
    assert!(!ui.contains(".danger()"));
    assert!(!ui.contains("button_danger"));
    assert!(
        dictionary.contains("Input::new(input).accessibility_id(id).aria_label(label).flex_1()")
    );
    assert!(style.contains("Input::new(input).accessibility_id(id).aria_label(label).w_full()"));
    assert!(style.contains(".dropdown_caret(true)"));
    assert!(style.contains(".accessibility_id(format!(\"{}: {label}\""));
    assert!(style.contains("ColorPicker::new(color_pickers.state(id)).label(label)"));
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
fn version_four_dmd_defaults_migrate_to_all_mobile() {
    let dir = unique_temp_dir("settings-v4-dmd-defaults");
    fs::write(
        native_settings_path(&dir),
        r#"{"version":4,"companionAsrOnMobile":false,"companionAzookeyOnMobile":true,"companionTranslationOnMobile":false,"companionDevices":[{"deviceId":"ios-1","deviceName":"iPhone","asrOnMobile":false,"azookeyOnMobile":true,"translationOnMobile":false}]}"#,
    )
    .expect("write version four settings");

    let loaded = load_app_settings(&dir).expect("migrate settings");
    assert_eq!(loaded.version, crate::domain::SETTINGS_VERSION);
    assert!(loaded.companion_asr_on_mobile);
    assert!(loaded.companion_azookey_on_mobile);
    assert!(loaded.companion_translation_on_mobile);
    assert!(loaded.companion_devices[0].asr_on_mobile);
    assert!(loaded.companion_devices[0].azookey_on_mobile);
    assert!(loaded.companion_devices[0].translation_on_mobile);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn version_four_explicit_nondefault_route_is_preserved() {
    let dir = unique_temp_dir("settings-v4-explicit-route");
    fs::write(
        native_settings_path(&dir),
        r#"{"version":4,"companionAsrOnMobile":false,"companionAzookeyOnMobile":false,"companionTranslationOnMobile":false,"companionDevices":[]}"#,
    )
    .expect("write version four settings");

    let loaded = load_app_settings(&dir).expect("migrate settings");
    assert!(!loaded.companion_asr_on_mobile);
    assert!(!loaded.companion_azookey_on_mobile);
    assert!(!loaded.companion_translation_on_mobile);
    fs::remove_dir_all(&dir).expect("cleanup");
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
fn live_tab_contains_native_and_authenticated_mobile_html_output_controls() {
    let output = include_str!("output.rs");
    let live = include_str!("live.rs");
    let app = include_str!("app.rs");
    assert!(output.contains("output-window-open"));
    assert!(output.contains("output-browser-copy-url"));
    assert!(output.contains("output-mobile-browser-copy-url"));
    assert!(output.contains("mobile_browser_source_url"));
    assert!(output.contains("CHROMA_KEY_COLORS"));
    assert!(output.contains("TRANSPARENT_BACKGROUND"));
    assert!(output.contains("TextKey::Transparent"));
    assert!(output.contains("capture_background_color"));
    assert!(output.contains("transparent_black()"));
    assert!(output.contains("format!(\"✓ {visible_label}\")"));
    assert!(output.contains("this.border_2().border_color(cx.theme().foreground)"));
    assert!(output.contains(".toggled(selected)"));
    assert!(!output.contains("selectable_text(style.capture_background_color"));
    assert!(!output.contains("output-browser-enabled"));
    assert!(!output.contains("NATIVE_BROWSER_SOURCE_HINT"));
    assert!(live.contains("live-show-recognition-result"));
    assert!(live.contains("live-show-translation-result"));
    assert!(live.contains("caption_when_visible("));
    assert!(live.contains("settings.show_recognition_result"));
    assert!(live.contains("settings.show_translation_result && translation_enabled"));
    assert!(live.contains(".when_some(source"));
    assert!(live.contains(".when_some(translation"));
    assert!(app.contains(".child(render_output("));
    assert!(app.contains("WindowBackgroundAppearance::Transparent"));
    assert!(app.contains(".bg(transparent_black())"));
    assert!(app.contains("copy_browser_source_url"));
    assert!(app.contains("copy_mobile_browser_source_url"));
    assert!(app.contains("publish_mobile_browser_caption"));
}

#[test]
fn profile_and_dictionary_bulk_controls_remain_wired() {
    let style = include_str!("style.rs");
    let dictionary = include_str!("dictionary.rs");
    assert!(style.contains("style-profile-add"));
    assert!(style.contains("style-profile-delete"));
    assert!(dictionary.contains("dictionary-profile-add"));
    assert!(dictionary.contains("dictionary-profile-delete"));
    assert!(dictionary.contains("dictionary-clear"));
    assert!(dictionary.contains(".on_drop"));
}

#[test]
fn tabs_exclude_capture_output() {
    assert_eq!(AppTab::from_label("Live"), Some(AppTab::Live));
    assert_eq!(AppTab::from_label("Output"), None);
    assert_eq!(AppTab::from_label("Settings"), Some(AppTab::Settings));
    assert_eq!(AppTab::from_label("Nope"), None);
}

#[test]
fn settings_support_one_ui_language_at_a_time() {
    assert_ne!(UiLanguage::Japanese, UiLanguage::English);
    let source = include_str!("ui.rs");
    assert!(!source.contains("Live ライブ"));
    assert!(!source.contains("ライブ Live"));
    let settings = include_str!("settings.rs");
    let live = include_str!("live.rs");
    let style = include_str!("style.rs");
    assert!(settings.contains("settings-scroll"));
    assert!(settings.contains("overflow_y_scroll()"));
    assert!(settings.contains("settings-show-details"));
    assert!(settings.contains(".when(show_details"));
    assert!(settings.contains("settings-mobile-companion-enabled"));
    assert!(settings.contains(".checked(settings.companion_enabled)"));
    assert!(settings.contains(".when(settings.companion_enabled"));
    assert!(!settings.contains("stage_location_control"));
    assert!(!settings.contains("ButtonGroup::new"));
    assert!(!settings.contains("companion_asr_on_mobile"));
    assert!(!settings.contains("companion_azookey_on_mobile"));
    assert!(!settings.contains("companion_translation_on_mobile"));
    assert!(settings.contains(".toggled(language == UiLanguage::Japanese)"));
    assert!(settings.contains(".toggled(settings.caption_timeout_ms == timeout)"));
    assert!(live.contains("PopupMenuItem::new(label.clone()).checked(*selected)"));
    assert!(style.contains("ColorPicker::new(color_pickers.state(id)).label(label)"));
    let qr = settings.find("companion-pairing-qr").expect("pairing QR");
    let endpoint_button = settings.find("copy-companion-endpoint").expect("endpoint copy button");
    let token_button = settings.find("copy-companion-token").expect("token copy button");
    assert!(qr < endpoint_button);
    assert!(endpoint_button < token_button);
    assert!(settings[qr..token_button].contains("h_flex()"));
    assert!(settings.contains("companion-pairing-qr"));
    assert!(settings.contains("TextKey::ScanPairingQrHint"));
    assert!(settings.contains("TextKey::LanEndpoint"));
    assert!(settings.contains("TextKey::PairingToken"));
    assert!(settings.contains("TextKey::ConnectedAuthenticated"));
    assert!(settings.contains("TextKey::WaitingMobileCompanion"));
    assert!(settings.contains("TextKey::AutomaticDiscovery"));
    assert!(settings.contains("TextKey::SynchronizedRoute"));
    assert!(settings.contains("TextKey::MobilePlatform"));
    let i18n = include_str!("i18n.rs");
    assert!(i18n.contains("TextKey::ShowDetails => \"詳細表示\""));
    assert!(i18n.contains("TextKey::Desktop => \"デスクトップ\""));
    assert!(i18n.contains("TextKey::CopyPairingToken => \"ペアリングトークンをコピー\""));
    assert!(i18n.contains("端末のカメラアプリでこのQRコードを読み取ってください"));
    assert!(!settings.contains("Copy pairing token"));
    assert!(!settings.contains("Copy LAN endpoint"));
}

#[test]
fn style_round_trip_preserves_new_native_fields() {
    let dir = unique_temp_dir("style");
    let style = NativeStyleSettings {
        source_font_family: "Hiragino Sans".to_string(),
        translation_font_family: "Avenir Next".to_string(),
        background_enabled: true,
        capture_background_color: "#0000ff".to_string(),
        preview_background_image_path: Some("/tmp/preview.png".to_string()),
        preview_background_image_x_percent: 12.0,
        preview_background_image_y_percent: -8.0,
        preview_background_color: "#ffffff".to_string(),
        ..NativeStyleSettings::default()
    };
    save_style_settings(&dir, &style).expect("save style");
    let loaded = load_style_settings(&dir).expect("load style");
    assert_eq!(loaded.source_font_family, "Hiragino Sans");
    assert_eq!(loaded.translation_font_family, "Avenir Next");
    assert!(loaded.background_enabled);
    assert_eq!(loaded.capture_background_color, "#0000ff");
    assert_eq!(loaded.preview_background_image_path.as_deref(), Some("/tmp/preview.png"));
    assert_eq!(loaded.preview_background_image_x_percent, 12.0);
    assert_eq!(loaded.preview_background_image_y_percent, -8.0);
    assert_eq!(loaded.preview_background_color, "#ffffff");
    assert!(native_style_path(&dir).ends_with("caption-style.json"));
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn legacy_noto_variable_alias_migrates_to_the_embedded_family_name() {
    let dir = unique_temp_dir("noto-style");
    let legacy = "\"Noto Sans JP Variable\", \"Noto Sans JP\", sans-serif";
    let style = NativeStyleSettings {
        font_family: legacy.to_string(),
        source_font_family: legacy.to_string(),
        translation_font_family: legacy.to_string(),
        ..NativeStyleSettings::default()
    };
    save_style_settings(&dir, &style).expect("save legacy font style");

    let loaded = load_style_settings(&dir).expect("load migrated font style");
    assert_eq!(loaded.font_family, "\"Noto Sans JP\", sans-serif");
    assert_eq!(loaded.source_font_family, "\"Noto Sans JP\", sans-serif");
    assert_eq!(loaded.translation_font_family, "\"Noto Sans JP\", sans-serif");
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
    assert_eq!(loaded.version, crate::domain::STYLE_VERSION);
    assert_eq!(loaded.source_font_weight, 750);
    assert_eq!(loaded.translation_font_weight, 750);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn app_settings_round_trip_language_translation_timeout_and_output() {
    let dir = unique_temp_dir("settings");
    let settings = NativeAppSettings {
        ui_language: UiLanguage::English,
        translation_enabled: false,
        show_recognition_result: false,
        show_translation_result: false,
        caption_timeout_ms: 7_000,
        caption_output_open_on_start: false,
        browser_source_enabled: false,
        companion_enabled: false,
        companion_asr_on_mobile: false,
        companion_azookey_on_mobile: true,
        companion_translation_on_mobile: false,
        ..NativeAppSettings::default()
    };
    save_app_settings(&dir, &settings).expect("save settings");
    let loaded = load_app_settings(&dir).expect("load settings");
    assert_eq!(loaded.ui_language, UiLanguage::English);
    assert!(!loaded.translation_enabled);
    assert!(!loaded.show_recognition_result);
    assert!(!loaded.show_translation_result);
    assert_eq!(loaded.caption_timeout_ms, 7_000);
    assert!(!loaded.caption_output_open_on_start);
    assert!(!loaded.browser_source_enabled);
    assert!(!loaded.companion_enabled);
    assert!(loaded.companion_asr_on_mobile);
    assert!(loaded.companion_azookey_on_mobile);
    assert!(loaded.companion_translation_on_mobile);
    assert!(loaded.companion_devices.is_empty());
    let saved = fs::read_to_string(native_settings_path(&dir)).expect("read settings");
    assert!(!saved.contains("companionAsrOnMobile"));
    assert!(!saved.contains("companionAzookeyOnMobile"));
    assert!(!saved.contains("companionTranslationOnMobile"));
    assert!(!saved.contains("companionDevices"));
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
    assert_eq!(added[1].id, "entry-2");
}

#[test]
fn style_catalog_add_select_delete_and_persist_round_trip() {
    let dir = unique_temp_dir("style-catalog");
    let catalog = NativeStyleCatalog::default();
    let added = add_style_profile(&catalog);
    assert_eq!(added.profiles.len(), 3);
    assert_eq!(added.selected().name, "Style 3");
    let selected = select_style_profile(&added, "style-1");
    assert_eq!(selected.selected_id, "style-1");
    let deleted = delete_selected_style_profile(&selected);
    assert_eq!(deleted.profiles.len(), 2);
    assert_ne!(deleted.selected_id, "style-1");

    save_style_catalog(&dir, &added).expect("save style catalog");
    assert_eq!(load_style_catalog(&dir).expect("load style catalog"), added);
    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn dictionary_catalog_supports_multiple_sets_selection_and_bulk_delete() {
    let dir = unique_temp_dir("dictionary-catalog");
    let catalog = NativeDictionaryCatalog::default();
    let added = add_dictionary_profile(&catalog);
    let entries = parse_dictionary_delimited("reading,word\nきょう,今日\nあす,明日", false)
        .expect("parse CSV");
    let populated = replace_selected_dictionary_entries(&added, entries);
    assert_eq!(populated.selected().entries.len(), 2);
    let first = select_dictionary_profile(&populated, "dictionary-1");
    assert!(first.selected().entries.is_empty());
    let second = select_dictionary_profile(&first, &added.selected_id);
    let cleared = clear_selected_dictionary(&second);
    assert!(cleared.selected().entries.is_empty());
    let deleted = delete_selected_dictionary_profile(&cleared);
    assert_eq!(deleted.dictionaries.len(), 1);

    save_dictionary_catalog(&dir, &populated).expect("save dictionary catalog");
    assert_eq!(load_dictionary_catalog(&dir).expect("load dictionary catalog"), populated);
    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn dictionary_csv_export_round_trips_and_empty_csv_contains_a_sample() {
    let entries = vec![
        CustomDictionaryEntry {
            id: "one".to_string(),
            reading: "えーびー".to_string(),
            word: "A,B".to_string(),
        },
        CustomDictionaryEntry {
            id: "two".to_string(),
            reading: "引用".to_string(),
            word: "C \"quoted\"".to_string(),
        },
    ];
    let csv = export_dictionary_csv(&entries);
    assert!(csv.starts_with("reading,word\n"));
    let parsed_csv = parse_dictionary_delimited(&csv, false).expect("parse exported CSV");
    assert_eq!(
        parsed_csv.iter().map(|entry| entry.word.as_str()).collect::<Vec<_>>(),
        ["A,B", "C \"quoted\""]
    );

    let sample = export_dictionary_csv(&[]);
    assert_eq!(sample, "reading,word\nとうきょう,東京\n");
    assert_eq!(parse_dictionary_delimited(&sample, false).expect("parse sample CSV").len(), 1);
}

#[test]
fn csv_and_tsv_import_multiple_readings_and_quoted_words() {
    let csv = parse_dictionary_delimited(
        "reading,word\nえーびー,\"A,B\"\nしー,\"C \"\"quoted\"\"\"",
        false,
    )
    .expect("parse quoted CSV");
    assert_eq!(csv.len(), 2);
    assert_eq!(csv[0].word, "A,B");
    assert_eq!(csv[1].word, "C \"quoted\"");

    let tsv = parse_dictionary_delimited("読み\t単語\nとうきょう\t東京\nおおさか\t大阪", true)
        .expect("parse TSV");
    assert_eq!(tsv.iter().map(|entry| entry.word.as_str()).collect::<Vec<_>>(), ["東京", "大阪"]);
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
    use gpui::{px, WindowBackgroundAppearance, WindowBounds};

    let output = output_window_options();
    assert_eq!(output.window_background, WindowBackgroundAppearance::Transparent);

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
    assert!(!output_window_options().focus, "caption output must open behind the controls");
    assert!(main_window_options().focus, "an explicitly launched app must show its controls");
    assert!(app.contains("cx.activate(true)"));
}
