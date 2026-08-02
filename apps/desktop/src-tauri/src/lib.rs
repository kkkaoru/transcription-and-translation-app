#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod azookey_runtime;
mod browser_source;
mod commands;
mod config;
mod gateway;
mod macos;
mod model_download;
mod model_runtime;
mod models;
mod native_output;
mod output;
mod pipeline;
mod state;
mod updater;

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
                // Stage timing rows are filtered in emit_pipeline_stage by config.debug.logLevel.
                .level_for("pipeline_stage", log::LevelFilter::Trace)
                .level_for("debug_export", log::LevelFilter::Info)
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(7))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(updater::install_plugin())
        .setup(|app| {
            // Keep one foreground process per app-data directory. A duplicate
            // launch is routed to the existing bundle through LaunchServices;
            // it never creates a second Dock registration.
            match macos::acquire_instance(app.handle()) {
                Ok(instance_guard) => {
                    app.manage(instance_guard);
                }
                #[cfg(target_os = "macos")]
                Err(macos::InstanceError::AlreadyRunning) => {
                    exit_duplicate_instance();
                }
                Err(error) => return Err(error.into()),
            }
            macos::configure_foreground_activation(app.handle())?;
            let config = load_config(app.handle()).unwrap_or_default();
            let state = AppState::new(config.clone(), output::runtime_output());
            let native_output_kind = state
                .status
                .lock()
                .map(|status| status.native_output.clone())
                .unwrap_or_else(|_| "transparent-window".to_string());
            app.manage(state);
            app.manage(gateway::RuntimeServices::default());
            app.manage(browser_source::BrowserSourceRuntime::default());
            // Syphon/Spout2 publish the overlay webview's caption canvas. Mount
            // that renderer during setup (hidden) so OBS can discover the native
            // source and receive captions without the user pressing Open Overlay.
            if let Err(error) =
                commands::ensure_native_overlay(app.handle(), &config, &native_output_kind)
            {
                log::warn!("could not start hidden native overlay renderer: {error}");
            }
            gateway::start(app.handle(), &config)?;
            browser_source::reconcile(app.handle(), &config);
            updater::start_auto_check(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::list_models,
            commands::get_runtime_status,
            commands::get_latest_caption,
            commands::get_update_status,
            commands::check_for_update,
            commands::install_update,
            commands::check_and_install_update,
            commands::relaunch_to_updated_app,
            commands::start_capture,
            commands::stop_capture,
            commands::transcribe_audio_chunk,
            commands::normalize_parapper_output,
            commands::publish_source_caption,
            commands::open_overlay,
            commands::close_overlay,
            commands::publish_overlay_frame,
            commands::get_debug_info,
            commands::export_debug_logs,
            model_download::download_model,
            model_download::download_quick_start,
            model_download::cancel_model_download,
            model_download::list_model_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kotoba Beacon");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            gateway::shutdown(app_handle);
            browser_source::shutdown(app_handle);
        }
    });
}

/// Route a duplicate launch to the existing foreground bundle and terminate
/// before any gateway or sidecar can be started in this process.
#[cfg(target_os = "macos")]
fn exit_duplicate_instance() -> ! {
    if let Err(error) = macos::activate_existing_bundle() {
        log::warn!("could not activate the existing Kotoba Beacon instance: {error}");
    }
    std::process::exit(0);
}

fn load_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?
        .join("config.json");
    let body = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut config: AppConfig = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    // Legacy default silenceGateDb=-55 let ambient ~-54 dBFS through to Parapper.
    config.audio.silence_gate_db = migrate_silence_gate_db(config.audio.silence_gate_db);
    config.validate()?;
    Ok(config)
}

/// Bump only the historical default (-55) to the current floor (-50).
fn migrate_silence_gate_db(gate_db: f32) -> f32 {
    if (gate_db - -55.0).abs() < f32::EPSILON * 8.0 {
        -50.0
    } else {
        gate_db
    }
}

#[cfg(test)]
mod load_config_tests {
    use super::migrate_silence_gate_db;

    #[test]
    fn migrates_legacy_silence_gate_default() {
        assert!((migrate_silence_gate_db(-55.0) - -50.0).abs() < f32::EPSILON);
        // Intentional lower gates must not be rewritten.
        assert!((migrate_silence_gate_db(-60.0) - -60.0).abs() < f32::EPSILON);
        assert!((migrate_silence_gate_db(-45.0) - -45.0).abs() < f32::EPSILON);
    }
}
