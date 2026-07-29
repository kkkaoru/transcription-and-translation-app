#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod config;
mod kana_kanji;
mod models;
mod native_output;
mod output;
mod pipeline;
mod state;

use config::AppConfig;
use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config = load_config(app.handle()).unwrap_or_default();
            app.manage(AppState::new(config, output::runtime_output()));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Caption Bridge");
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
