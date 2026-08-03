#![cfg_attr(test, allow(dead_code, unused_imports))]

#[cfg(not(test))]
use log::LevelFilter;
#[cfg(not(test))]
use tauri::{Manager, generate_handler};
#[cfg(not(test))]
use tauri_plugin_log::{Target, TargetKind};

use crate::config::{
    DEFAULT_VAD_INTERVAL_MS, DEFAULT_VAD_THRESHOLD, MAX_VAD_INTERVAL_MS, MIN_VAD_INTERVAL_MS,
    ParapperConfig, TurnDetector, VAD_INTERVAL_STEP_MS,
};

const HEADLESS_RUNTIME_DIR_ENV: &str = "PARAPPER_RUNTIME_DIR";
const DEFAULT_HEADLESS_PORT: u16 = 18_082;
/// Keep short pauses inside one headless turn so a Japanese phrase such as
/// 「熱い料理はおいしい」 is not split after the first word.  These values
/// are intentionally scoped to the sidecar entry point; the interactive
/// Parapper configuration remains user-controlled.
const DEFAULT_HEADLESS_INTERIM_RESULT_SILENCE_MS: u32 = 192;
// 960ms keeps a normal Japanese clause together across an ordinary breath
// while still finalizing promptly after a deliberate pause.  A larger value
// would reduce false turn splits further, but would make short utterances feel
// slower before the final event is emitted.
const DEFAULT_HEADLESS_TURN_CHECK_SILENCE_MS: u32 = 960;
/// Match the built-in rich Japanese preset. The headless runtime has its own
/// config directory, so it must opt into the quality-oriented defaults instead
/// of inheriting a stale interactive profile from a previous run.
const DEFAULT_HEADLESS_NOISE_CANCELLATION_ENABLED: bool = true;

#[derive(Debug, Clone, Copy, PartialEq)]
struct HeadlessOptions {
    port: u16,
    vad_interval_ms: u32,
    vad_threshold: f32,
    interim_result_silence_ms: u32,
    turn_check_silence_ms: u32,
    noise_cancellation_enabled: bool,
}

impl Default for HeadlessOptions {
    fn default() -> Self {
        Self {
            port: DEFAULT_HEADLESS_PORT,
            vad_interval_ms: DEFAULT_VAD_INTERVAL_MS,
            vad_threshold: DEFAULT_VAD_THRESHOLD,
            interim_result_silence_ms: DEFAULT_HEADLESS_INTERIM_RESULT_SILENCE_MS,
            turn_check_silence_ms: DEFAULT_HEADLESS_TURN_CHECK_SILENCE_MS,
            noise_cancellation_enabled: DEFAULT_HEADLESS_NOISE_CANCELLATION_ENABLED,
        }
    }
}

fn parse_headless_bool_option(
    arguments: &[String],
    index: &mut usize,
    option: &str,
) -> Result<bool, String> {
    *index += 1;
    let value = arguments.get(*index).ok_or_else(|| format!("{option} requires a value"))?;
    match value.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{option} must be true or false, got {value:?}")),
    }
}

fn parse_headless_millis_option(
    arguments: &[String],
    index: &mut usize,
    option: &str,
) -> Result<u32, String> {
    *index += 1;
    let value = arguments.get(*index).ok_or_else(|| format!("{option} requires a value"))?;
    let millis = value
        .parse::<u32>()
        .map_err(|_| format!("{option} must be a positive integer, got {value:?}"))?;
    if millis == 0 {
        return Err(format!("{option} must be a positive integer"));
    }
    Ok(millis)
}

impl HeadlessOptions {
    fn parse(arguments: &[String]) -> Result<Self, String> {
        let mut options = Self::default();
        let mut index = 0;
        while index < arguments.len() {
            match arguments[index].as_str() {
                "--headless" => {}
                "--port" => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--port requires a value".to_string())?;
                    options.port = value.parse::<u16>().map_err(|_| {
                        format!("--port must be an integer between 1 and 65535, got {value:?}")
                    })?;
                    if options.port == 0 {
                        return Err("--port must be an integer between 1 and 65535".to_string());
                    }
                }
                "--vad-interval-ms" => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--vad-interval-ms requires a value".to_string())?;
                    let interval = value.parse::<u32>().map_err(|_| {
                        format!(
                            "--vad-interval-ms must be an integer between {MIN_VAD_INTERVAL_MS} and {MAX_VAD_INTERVAL_MS}, got {value:?}"
                        )
                    })?;
                    if !(MIN_VAD_INTERVAL_MS..=MAX_VAD_INTERVAL_MS).contains(&interval)
                        || !(interval - MIN_VAD_INTERVAL_MS).is_multiple_of(VAD_INTERVAL_STEP_MS)
                    {
                        return Err(format!(
                            "--vad-interval-ms must be a {VAD_INTERVAL_STEP_MS}ms-aligned value between {MIN_VAD_INTERVAL_MS} and {MAX_VAD_INTERVAL_MS}"
                        ));
                    }
                    options.vad_interval_ms = interval;
                }
                "--vad-threshold" => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--vad-threshold requires a value".to_string())?;
                    let threshold = value.parse::<f32>().map_err(|_| {
                        format!(
                            "--vad-threshold must be a finite number between 0 and 1, got {value:?}"
                        )
                    })?;
                    if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
                        return Err(
                            "--vad-threshold must be a finite number between 0 and 1".to_string()
                        );
                    }
                    options.vad_threshold = threshold;
                }
                "--interim-result-silence-ms" => {
                    options.interim_result_silence_ms = parse_headless_millis_option(
                        arguments,
                        &mut index,
                        "--interim-result-silence-ms",
                    )?;
                }
                "--turn-check-silence-ms" => {
                    options.turn_check_silence_ms = parse_headless_millis_option(
                        arguments,
                        &mut index,
                        "--turn-check-silence-ms",
                    )?;
                }
                "--noise-cancellation-enabled" => {
                    options.noise_cancellation_enabled = parse_headless_bool_option(
                        arguments,
                        &mut index,
                        "--noise-cancellation-enabled",
                    )?;
                }
                "--noise-cancellation" => {
                    // A valueless alias is convenient for manually launched
                    // sidecars while the explicit option above remains the
                    // parent application's stable command-line contract.
                    options.noise_cancellation_enabled = true;
                }
                "--no-noise-cancellation" => {
                    options.noise_cancellation_enabled = false;
                }
                option => return Err(format!("unsupported headless option: {option}")),
            }
            index += 1;
        }
        Ok(options)
    }
}

/// Apply the quality-oriented settings from the built-in rich Japanese preset
/// to a headless runtime config. VAD cadence and silence timings stay under
/// the explicit headless command-line contract, while these settings ensure a
/// persisted interactive profile cannot silently disable contextual turn
/// detection or full-turn recognition.
fn apply_headless_quality_defaults(config: &mut ParapperConfig, noise_cancellation_enabled: bool) {
    config.turn.detector = TurnDetector::Namo;
    config.turn.interim_result_enabled = true;
    config.turn.rerecognize_full_on_complete = true;
    config.asr.normalize_input_audio = true;
    config.noise_cancellation.enabled = noise_cancellation_enabled;
}

#[cfg(test)]
macro_rules! parapper_config {
    ($($field:ident : $value:expr,)* ..$base:expr $(,)?) => {{
        let mut config = $base;
        $(parapper_config_field!(config, $field, $value);)*
        config
    }};
    ($($field:ident : $value:expr),* $(,)?) => {{
        let mut config = $crate::config::ParapperConfig::default();
        $(parapper_config_field!(config, $field, $value);)*
        config
    }};
}

#[cfg(test)]
macro_rules! parapper_config_field {
    ($config:ident, neo_http_enabled, $value:expr) => {
        $config.neo.http_enabled = $value;
    };
    ($config:ident, neo_http_port, $value:expr) => {
        $config.neo.http_port = $value;
    };
    ($config:ident, neo_send_timing, $value:expr) => {
        $config.neo.send_timing = $value;
    };
    ($config:ident, input_device_id, $value:expr) => {
        $config.input.device_id = $value;
    };
    ($config:ident, input_device_host, $value:expr) => {
        $config.input.device_host = $value;
    };
    ($config:ident, input_device_name, $value:expr) => {
        $config.input.device_name = $value;
    };
    ($config:ident, input_volume_db, $value:expr) => {
        $config.input.volume_db = $value;
    };
    ($config:ident, input_source_kind, $value:expr) => {
        $config.input.source_kind = $value;
    };
    ($config:ident, streaming_recognition_enabled, $value:expr) => {
        $config.streaming_recognition.enabled = $value;
    };
    ($config:ident, developer_connection_mode, $value:expr) => {
        $config.streaming_recognition.mode = $value;
    };
    ($config:ident, developer_http_url, $value:expr) => {
        $config.streaming_recognition.http_url = $value;
    };
    ($config:ident, streaming_recognition_text_format, $value:expr) => {
        $config.streaming_recognition.text_format = $value;
    };
    ($config:ident, asr_language, $value:expr) => {
        $config.asr.language = $value;
    };
    ($config:ident, asr_model, $value:expr) => {
        $config.asr.model = $value;
    };
    ($config:ident, interim_asr_model, $value:expr) => {
        $config.asr.interim_model = $value;
    };
    ($config:ident, asr_precision, $value:expr) => {
        $config.asr.precision = $value;
    };
    ($config:ident, asr_num_threads, $value:expr) => {
        $config.asr.num_threads = $value;
    };
    ($config:ident, asr_normalize_input_audio, $value:expr) => {
        $config.asr.normalize_input_audio = $value;
    };
    ($config:ident, multilingual_asr_enabled, $value:expr) => {
        $config.asr.multilingual_enabled = $value;
    };
    ($config:ident, enabled_asr_models, $value:expr) => {
        $config.asr.enabled_models = $value;
    };
    ($config:ident, translation_enabled, $value:expr) => {
        $config.translation.enabled = $value;
    };
    ($config:ident, ync_plugin_port, $value:expr) => {
        $config.translation.ync_plugin_port = $value;
    };
    ($config:ident, translation_local_server_port, $value:expr) => {
        $config.translation.local_server_port = $value;
    };
    ($config:ident, translation_local_server_model, $value:expr) => {
        $config.translation.local_server_model = $value;
    };
    ($config:ident, translation_send_timing, $value:expr) => {
        $config.translation.send_timing = $value;
    };
    ($config:ident, translation_mappings, $value:expr) => {
        $config.translation.mappings = $value;
    };
    ($config:ident, speech_mappings, $value:expr) => {
        $config.speech.mappings = $value;
    };
    ($config:ident, model_dir, $value:expr) => {
        $config.models.dir = $value;
    };
    ($config:ident, vad_threshold, $value:expr) => {
        $config.segmentation.vad_threshold = $value;
    };
    ($config:ident, vad_interval_ms, $value:expr) => {
        $config.segmentation.vad_interval_ms = $value;
    };
    ($config:ident, segment_start_speech_ms, $value:expr) => {
        $config.segmentation.segment_start_speech_ms = $value;
    };
    ($config:ident, turn_detector, $value:expr) => {
        $config.turn.detector = $value;
    };
    ($config:ident, interim_result_enabled, $value:expr) => {
        $config.turn.interim_result_enabled = $value;
    };
    ($config:ident, interim_result_silence_ms, $value:expr) => {
        $config.turn.interim_result_silence_ms = $value;
    };
    ($config:ident, turn_check_silence_ms, $value:expr) => {
        $config.turn.check_silence_ms = $value;
    };
    ($config:ident, namo_turn_confidence_threshold, $value:expr) => {
        $config.turn.namo_confidence_threshold = $value;
    };
    ($config:ident, namo_context_max_tokens, $value:expr) => {
        $config.turn.namo_context_max_tokens = $value;
    };
    ($config:ident, turn_rerecognize_full_on_complete, $value:expr) => {
        $config.turn.rerecognize_full_on_complete = $value;
    };
    ($config:ident, noise_cancellation_enabled, $value:expr) => {
        $config.noise_cancellation.enabled = $value;
    };
    ($config:ident, noise_cancellation_model, $value:expr) => {
        $config.noise_cancellation.model = $value;
    };
    ($config:ident, vrc_osc_micmute, $value:expr) => {
        $config.vrc.osc_micmute = $value;
    };
    ($config:ident, debug_asr_audio_playback, $value:expr) => {
        $config.debug.asr_audio_playback = $value;
    };
    ($config:ident, recognition_log_limit, $value:expr) => {
        $config.debug.recognition_log_limit = $value;
    };
    ($config:ident, debug_audio_log_limit, $value:expr) => {
        $config.debug.debug_audio_log_limit = $value;
    };
}

mod audio;
#[cfg(not(test))]
mod commands;
mod config;
mod connect;
mod delivery;
mod error_event;
mod model;
mod playback;
mod recognition;
#[cfg(feature = "smoke-server")]
pub mod smoke_server;
mod state;
mod streaming_recognition;
mod synthesis;
mod translation;

#[cfg(test)]
mod pipeline_tests;
mod processing;

#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Runs the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri application cannot be built or run.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .level(LevelFilter::Debug)
                .level_for("mdns_sd", LevelFilter::Info)
                .format(|c, a, r| {
                    let message = a.to_string();
                    if let Some(json) = structured_json_log_message(&message) {
                        c.finish(format_args!("{json}"));
                    } else {
                        let now = chrono::Local::now();
                        c.finish(format_args!(
                            "[{date} {time}] [{level}][{module}][{file}:{line}] {message}",
                            date = now.format("%Y-%m-%d"),
                            time = now.format("%H:%M:%S"),
                            level = r.level(),
                            module = r.target(),
                            file = r.file().unwrap_or("unknown"),
                            line = r.line().unwrap_or(0),
                            message = message
                        ));
                    }
                })
                .build(),
        )
        .setup(|app| {
            let state = state::AppState::build(app.handle())?;
            app.manage(state);
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(generate_handler![
            commands::get_config,
            commands::open_external_url,
            commands::save_config,
            commands::reset_config,
            commands::get_config_presets,
            commands::save_config_preset,
            commands::delete_config_preset,
            commands::get_audio_devices,
            commands::get_output_audio_devices,
            commands::request_loopback_audio_permission,
            commands::open_system_audio_permission_settings,
            commands::find_neo_http_port,
            commands::find_ync_plugin_http_port,
            commands::check_neo_http_available,
            commands::check_vrchat_oscquery_available,
            commands::fetch_neo_voice_list,
            commands::neo_speech_stop,
            commands::neo_speech_test,
            commands::get_model_status,
            commands::has_any_model_installed,
            commands::get_translation_http_listener_status,
            commands::start_translation_http_listener,
            commands::stop_translation_http_listener,
            commands::download_models,
            commands::get_local_translation_model_installed,
            commands::download_local_translation_model,
            commands::save_recognition_csv,
            commands::save_asr_input_wav,
            commands::get_recognition_status,
            commands::start_recognition,
            commands::stop_recognition,
        ])
        .run(app_context())
        .expect("error while building tauri application");
}

#[cfg(not(test))]
fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Return structured JSON messages without adding a human-readable log prefix.
///
/// The regular logger format remains unchanged for ordinary diagnostics, while
/// lifecycle records emitted by the recognition and translation paths stay
/// directly parseable as one JSON object per line on stdout and in log files.
fn structured_json_log_message(message: &str) -> Option<&str> {
    let trimmed = message.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Object(_)) => Some(trimmed),
        Ok(_) | Err(_) => None,
    }
}

/// Starts the Parapper WebSocket recognition service without exposing its own
/// desktop window. This mode is intended for a trusted parent application such
/// as Kotoba Beacon, which supplies a separate runtime data directory through
/// `PARAPPER_RUNTIME_DIR` so it cannot overwrite an interactive Parapper
/// installation's settings or model cache.
/// The sidecar accepts `--vad-interval-ms`, `--vad-threshold`,
/// `--interim-result-silence-ms`, `--turn-check-silence-ms`, and
/// `--noise-cancellation-enabled` so the parent application can keep speech
/// segmentation and audio quality consistent across restarts.
///
/// # Errors
///
/// Returns an error when a headless option is invalid, the isolated runtime
/// directory is missing, or the Tauri service cannot be started.
#[cfg(not(test))]
pub fn run_headless(arguments: &[String]) -> Result<(), String> {
    let options = HeadlessOptions::parse(arguments)?;
    if std::env::var_os(HEADLESS_RUNTIME_DIR_ENV).is_none() {
        return Err(format!(
            "{HEADLESS_RUNTIME_DIR_ENV} is required when starting Parapper with --headless"
        ));
    }
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("kotoba-beacon-parapper".to_string()),
                    }),
                ])
                .level(LevelFilter::Info)
                .format(|c, a, r| {
                    let message = a.to_string();
                    if let Some(json) = structured_json_log_message(&message) {
                        c.finish(format_args!("{json}"));
                    } else {
                        let now = chrono::Local::now();
                        c.finish(format_args!(
                            "[{date} {time}] [{level}][{module}][{file}:{line}] {message}",
                            date = now.format("%Y-%m-%d"),
                            time = now.format("%H:%M:%S"),
                            level = r.level(),
                            module = r.target(),
                            file = r.file().unwrap_or("unknown"),
                            line = r.line().unwrap_or(0),
                            message = message
                        ));
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Hiding the window is not enough on macOS: a regular activation
            // policy still registers Parapper with Launch Services, so the
            // sidecar shows a second Dock icon and steals focus from Kotoba
            // Beacon. Accessory keeps it a background-only service.
            #[cfg(target_os = "macos")]
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            if let Some(window) = app.get_webview_window("main") {
                // A hidden Tauri window can still leave a taskbar button on
                // Windows until it is explicitly marked as auxiliary.
                #[cfg(target_os = "windows")]
                window.set_skip_taskbar(true)?;
                window.hide()?;
            }
            let state = state::AppState::build(app.handle())?;
            app.manage(state);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_headless_recognition(handle.clone(), options).await {
                    // Do not leave a hidden sidecar registered as healthy when
                    // model loading or listener startup fails. The parent shell
                    // observes this terminal exit and can clear its child slot;
                    // keeping the process alive would make every later readiness
                    // probe wait on a listener that will never appear.
                    log::error!("Kotoba Beacon headless recognition startup failed: {error}");
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .run(app_context())
        .map_err(|error| format!("error while building headless Parapper service: {error}"))
}

#[cfg(not(test))]
async fn start_headless_recognition(
    handle: tauri::AppHandle,
    options: HeadlessOptions,
) -> anyhow::Result<()> {
    use crate::{
        config::{DeveloperConnectionMode, InputSourceKind, StreamingRecognitionOutputMode},
        model::ensure_models_downloaded,
    };

    let state = handle.state::<state::AppState>();
    let mut config = state.get_config().await;
    config.input.source_kind = InputSourceKind::WebSocket;
    config.streaming_recognition.enabled = true;
    config.streaming_recognition.mode = DeveloperConnectionMode::WebSocket;
    config.streaming_recognition.bind_address = "127.0.0.1".to_string();
    config.streaming_recognition.port = options.port;
    config.streaming_recognition.api_key = None;
    config.streaming_recognition.output_mode = StreamingRecognitionOutputMode::WebSocketOnly;
    config.segmentation.vad_interval_ms = options.vad_interval_ms;
    config.segmentation.vad_threshold = options.vad_threshold;
    config.turn.interim_result_silence_ms = options.interim_result_silence_ms;
    config.turn.check_silence_ms = options.turn_check_silence_ms;
    apply_headless_quality_defaults(&mut config, options.noise_cancellation_enabled);
    let config = state.set_config(config).await?;

    log::info!("Preparing Kotoba Beacon ASR models before listening on 127.0.0.1:{}", options.port);
    ensure_models_downloaded(&handle, &config).await?;
    state.start_audio_input(handle.clone()).await?;
    log::info!(
        "Kotoba Beacon ASR service is listening on ws://127.0.0.1:{}/ws/recognition (vad_interval_ms={} vad_threshold={:.3} interim_result_silence_ms={} turn_check_silence_ms={} turn_detector={:?} interim_result_enabled={} rerecognize_full_on_complete={} noise_cancellation_enabled={})",
        options.port,
        config.segmentation.vad_interval_ms,
        config.segmentation.vad_threshold,
        config.turn.interim_result_silence_ms,
        config.turn.check_silence_ms,
        config.turn.detector,
        config.turn.interim_result_enabled,
        config.turn.rerecognize_full_on_complete,
        config.noise_cancellation.enabled,
    );
    Ok(())
}

#[cfg(test)]
mod headless_tests {
    #![allow(clippy::float_cmp)]

    use super::{
        DEFAULT_HEADLESS_INTERIM_RESULT_SILENCE_MS, DEFAULT_HEADLESS_NOISE_CANCELLATION_ENABLED,
        DEFAULT_HEADLESS_PORT, DEFAULT_HEADLESS_TURN_CHECK_SILENCE_MS, DEFAULT_VAD_INTERVAL_MS,
        DEFAULT_VAD_THRESHOLD, HeadlessOptions, apply_headless_quality_defaults,
        structured_json_log_message,
    };
    use crate::config::{ParapperConfig, TurnDetector};

    #[test]
    fn structured_lifecycle_messages_remain_parseable_without_prefixes() {
        assert_eq!(
            structured_json_log_message(
                r#" {"event":"recognition_session_start","request_id":"req-1"} "#
            ),
            Some(r#"{"event":"recognition_session_start","request_id":"req-1"}"#),
        );
        assert_eq!(structured_json_log_message("ordinary diagnostic"), None);
        assert_eq!(structured_json_log_message("{not-json}"), None);
        assert_eq!(structured_json_log_message(r#"[{"event":"not-an-object"}]"#), None);
    }

    #[test]
    fn headless_options_use_the_loopback_service_default_port() {
        let options = HeadlessOptions::parse(&["--headless".to_string()]).unwrap();
        assert_eq!(options.port, DEFAULT_HEADLESS_PORT);
        assert_eq!(options.vad_interval_ms, DEFAULT_VAD_INTERVAL_MS);
        assert_eq!(options.vad_threshold, DEFAULT_VAD_THRESHOLD);
        assert_eq!(options.interim_result_silence_ms, DEFAULT_HEADLESS_INTERIM_RESULT_SILENCE_MS);
        assert_eq!(options.turn_check_silence_ms, DEFAULT_HEADLESS_TURN_CHECK_SILENCE_MS);
        assert_eq!(options.noise_cancellation_enabled, DEFAULT_HEADLESS_NOISE_CANCELLATION_ENABLED);
    }

    #[test]
    fn headless_options_accept_an_explicit_nonzero_port() {
        let args = vec!["--headless".to_string(), "--port".to_string(), "19001".to_string()];
        assert_eq!(HeadlessOptions::parse(&args).unwrap().port, 19_001);
    }

    #[test]
    fn headless_options_accept_desktop_vad_overrides() {
        let args = vec![
            "--headless".to_string(),
            "--vad-interval-ms".to_string(),
            "64".to_string(),
            "--vad-threshold".to_string(),
            "0.25".to_string(),
        ];
        let options = HeadlessOptions::parse(&args).unwrap();

        assert_eq!(options.vad_interval_ms, 64);
        assert!((options.vad_threshold - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn headless_options_accept_short_pause_turn_overrides() {
        let args = vec![
            "--headless".to_string(),
            "--interim-result-silence-ms".to_string(),
            "256".to_string(),
            "--turn-check-silence-ms".to_string(),
            "768".to_string(),
        ];
        let options = HeadlessOptions::parse(&args).unwrap();

        assert_eq!(options.interim_result_silence_ms, 256);
        assert_eq!(options.turn_check_silence_ms, 768);
    }

    #[test]
    fn headless_options_accept_noise_cancellation_override() {
        let args = vec![
            "--headless".to_string(),
            "--noise-cancellation-enabled".to_string(),
            "false".to_string(),
        ];
        assert!(!HeadlessOptions::parse(&args).unwrap().noise_cancellation_enabled);

        let alias = vec!["--headless".to_string(), "--noise-cancellation".to_string()];
        assert!(HeadlessOptions::parse(&alias).unwrap().noise_cancellation_enabled);

        let disable_alias = vec!["--headless".to_string(), "--no-noise-cancellation".to_string()];
        assert!(!HeadlessOptions::parse(&disable_alias).unwrap().noise_cancellation_enabled);
    }

    #[test]
    fn headless_quality_defaults_enable_rich_japanese_recognition_without_changing_vad_timing() {
        let mut config = ParapperConfig::default();
        config.segmentation.vad_interval_ms = 64;
        config.segmentation.vad_threshold = 0.25;
        config.turn.interim_result_silence_ms = 192;
        config.turn.check_silence_ms = 960;
        config.turn.detector = TurnDetector::Simple;
        config.turn.interim_result_enabled = false;
        config.turn.rerecognize_full_on_complete = false;
        config.asr.normalize_input_audio = false;
        config.noise_cancellation.enabled = false;

        apply_headless_quality_defaults(&mut config, true);

        assert_eq!(config.turn.detector, TurnDetector::Namo);
        assert!(config.turn.interim_result_enabled);
        assert!(config.turn.rerecognize_full_on_complete);
        assert!(config.asr.normalize_input_audio);
        assert!(config.noise_cancellation.enabled);
        assert_eq!(config.segmentation.vad_interval_ms, 64);
        assert!((config.segmentation.vad_threshold - 0.25).abs() < f32::EPSILON);
        assert_eq!(config.turn.interim_result_silence_ms, 192);
        assert_eq!(config.turn.check_silence_ms, 960);

        apply_headless_quality_defaults(&mut config, false);
        assert!(!config.noise_cancellation.enabled);
    }

    #[test]
    fn headless_options_accept_vad_boundary_values() {
        for (interval, threshold) in [(16, 0.0), (128, 1.0)] {
            let args = vec![
                "--headless".to_string(),
                "--vad-interval-ms".to_string(),
                interval.to_string(),
                "--vad-threshold".to_string(),
                threshold.to_string(),
            ];
            let options = HeadlessOptions::parse(&args).unwrap();

            assert_eq!(options.vad_interval_ms, interval);
            assert_eq!(options.vad_threshold, threshold);
        }
    }

    #[test]
    fn headless_options_reject_missing_zero_and_unknown_values() {
        for args in [
            vec!["--headless".to_string(), "--port".to_string()],
            vec!["--headless".to_string(), "--port".to_string(), "0".to_string()],
            vec!["--headless".to_string(), "--vad-interval-ms".to_string()],
            vec!["--headless".to_string(), "--vad-interval-ms".to_string(), "15".to_string()],
            vec!["--headless".to_string(), "--vad-interval-ms".to_string(), "17".to_string()],
            vec!["--headless".to_string(), "--vad-threshold".to_string()],
            vec!["--headless".to_string(), "--vad-threshold".to_string(), "NaN".to_string()],
            vec!["--headless".to_string(), "--vad-threshold".to_string(), "1.01".to_string()],
            vec!["--headless".to_string(), "--interim-result-silence-ms".to_string()],
            vec![
                "--headless".to_string(),
                "--interim-result-silence-ms".to_string(),
                "0".to_string(),
            ],
            vec![
                "--headless".to_string(),
                "--turn-check-silence-ms".to_string(),
                "not-a-number".to_string(),
            ],
            vec!["--headless".to_string(), "--noise-cancellation-enabled".to_string()],
            vec![
                "--headless".to_string(),
                "--noise-cancellation-enabled".to_string(),
                "maybe".to_string(),
            ],
            vec!["--headless".to_string(), "--mystery".to_string()],
        ] {
            assert!(HeadlessOptions::parse(&args).is_err(), "{args:?} should be rejected");
        }
    }
}
