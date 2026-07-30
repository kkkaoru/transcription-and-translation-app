#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod config;
mod gateway;
mod model_download;
mod model_runtime;
mod models;
mod native_output;
mod output;
mod pipeline;
mod state;

pub use caption_bridge_azookey_rust as kana_kanji;

use config::AppConfig;
use state::AppState;
use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("kotoba-beacon".to_string()),
                }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .level(log::LevelFilter::Info)
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(7))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config = load_config(app.handle()).unwrap_or_default();
            app.manage(AppState::new(config.clone(), output::runtime_output()));
            app.manage(gateway::RuntimeServices::default());
            gateway::start(app.handle(), &config)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::list_models,
            commands::get_runtime_status,
            commands::start_capture,
            commands::stop_capture,
            commands::transcribe_audio_chunk,
            commands::open_overlay,
            commands::close_overlay,
            commands::publish_overlay_frame,
            commands::get_debug_info,
            model_download::download_model,
            model_download::download_quick_start,
            model_download::list_model_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kotoba Beacon");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            gateway::shutdown(app_handle);
        }
    });
}

fn load_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?
        .join("config.json");
    let body = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config: AppConfig = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    config.validate()?;
    Ok(config)
}
