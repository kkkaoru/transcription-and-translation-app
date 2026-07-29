#![cfg_attr(test, allow(dead_code, unused_imports))]

#[cfg(not(test))]
use log::LevelFilter;
#[cfg(not(test))]
use tauri::{Manager, generate_handler};
#[cfg(not(test))]
use tauri_plugin_log::{Target, TargetKind};

const HEADLESS_RUNTIME_DIR_ENV: &str = "PARAPPER_RUNTIME_DIR";
const DEFAULT_HEADLESS_PORT: u16 = 18_082;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HeadlessOptions {
    port: u16,
}

impl HeadlessOptions {
    fn parse(arguments: &[String]) -> Result<Self, String> {
        let mut port = DEFAULT_HEADLESS_PORT;
        let mut index = 0;
        while index < arguments.len() {
            match arguments[index].as_str() {
                "--headless" => {}
                "--port" => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--port requires a value".to_string())?;
                    port = value.parse::<u16>().map_err(|_| {
                        format!("--port must be an integer between 1 and 65535, got {value:?}")
                    })?;
                    if port == 0 {
                        return Err("--port must be an integer between 1 and 65535".to_string());
                    }
                }
                option => return Err(format!("unsupported headless option: {option}")),
            }
            index += 1;
        }
        Ok(Self { port })
    }
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
                    let now = chrono::Local::now();
                    c.finish(format_args!(
                        "[{date} {time}] [{level}][{module}][{file}:{line}] {message}",
                        date = now.format("%Y-%m-%d"),
                        time = now.format("%H:%M:%S"),
                        level = r.level(),
                        module = r.target(),
                        file = r.file().unwrap_or("unknown"),
                        line = r.line().unwrap_or(0),
                        message = a
                    ));
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
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

/// Starts the Parapper WebSocket recognition service without exposing its own
/// desktop window. This mode is intended for a trusted parent application such
/// as Kotoba Beacon, which supplies a separate runtime data directory through
/// `PARAPPER_RUNTIME_DIR` so it cannot overwrite an interactive Parapper
/// installation's settings or model cache.
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
                .build(),
        )
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                window.hide()?;
            }
            let state = state::AppState::build(app.handle())?;
            app.manage(state);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_headless_recognition(handle, options).await {
                    log::error!("Kotoba Beacon headless recognition startup failed: {error}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
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
    let config = state.set_config(config).await?;

    log::info!("Preparing Kotoba Beacon ASR models before listening on 127.0.0.1:{}", options.port);
    ensure_models_downloaded(&handle, &config).await?;
    state.start_audio_input(handle.clone()).await?;
    log::info!(
        "Kotoba Beacon ASR service is listening on ws://127.0.0.1:{}/ws/recognition",
        options.port
    );
    Ok(())
}

#[cfg(test)]
mod headless_tests {
    use super::{DEFAULT_HEADLESS_PORT, HeadlessOptions};

    #[test]
    fn headless_options_use_the_loopback_service_default_port() {
        assert_eq!(
            HeadlessOptions::parse(&["--headless".to_string()]).unwrap().port,
            DEFAULT_HEADLESS_PORT
        );
    }

    #[test]
    fn headless_options_accept_an_explicit_nonzero_port() {
        let args = vec!["--headless".to_string(), "--port".to_string(), "19001".to_string()];
        assert_eq!(HeadlessOptions::parse(&args).unwrap().port, 19_001);
    }

    #[test]
    fn headless_options_reject_missing_zero_and_unknown_values() {
        for args in [
            vec!["--headless".to_string(), "--port".to_string()],
            vec!["--headless".to_string(), "--port".to_string(), "0".to_string()],
            vec!["--headless".to_string(), "--mystery".to_string()],
        ] {
            assert!(HeadlessOptions::parse(&args).is_err(), "{args:?} should be rejected");
        }
    }
}
