use crate::model_runtime::{download_url, model_path, spec, ModelRuntimeSpec, ModelServer};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Minimal GGUF set for smoke / operation verification.
/// Zenzai XSmall (~21 MiB) exercises the normalizer server; Hy-MT2 1.25bit (~461 MiB)
/// is the smallest bundled translator.
pub const QUICK_START_MODEL_IDS: &[&str] = &["zenz-v3.2-xsmall-gguf", "hy-mt2-1.8b-1.25bit-gguf"];

fn active_downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_download(model_id: &str) -> Result<Arc<AtomicBool>, String> {
    let mut guard =
        active_downloads().lock().map_err(|_| "download registry lock poisoned".to_string())?;
    if guard.contains_key(model_id) {
        return Err(format!("download already in progress for {model_id}"));
    }
    let flag = Arc::new(AtomicBool::new(false));
    guard.insert(model_id.to_string(), Arc::clone(&flag));
    Ok(flag)
}

fn unregister_download(model_id: &str) {
    if let Ok(mut guard) = active_downloads().lock() {
        guard.remove(model_id);
    }
}

/// Request cancellation of an in-flight download for `model_id`.
#[tauri::command]
pub async fn cancel_model_download(model_id: String) -> Result<(), String> {
    let guard =
        active_downloads().lock().map_err(|_| "download registry lock poisoned".to_string())?;
    match guard.get(&model_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            log::info!(target: "kotoba_model_download", "cancel requested for {model_id}");
            Ok(())
        }
        None => Err(format!("no active download for {model_id}")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
    pub speed_bps: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatusEntry {
    pub model_id: String,
    pub status: String,
    pub installed_bytes: Option<u64>,
    pub expected_bytes: u64,
    pub last_error: Option<String>,
}

/// Classify install state for a single model path layout under `models_dir`.
pub fn classify_model_status(models_dir: &Path, runtime: &ModelRuntimeSpec) -> ModelStatusEntry {
    let destination = model_path(models_dir, runtime);
    let partial = PathBuf::from(format!("{}.partial", destination.display()));

    if let Ok(metadata) = std::fs::metadata(&destination) {
        let len = metadata.len();
        if len == runtime.expected_bytes {
            return ModelStatusEntry {
                model_id: runtime.id.to_string(),
                status: "ready".to_string(),
                installed_bytes: Some(len),
                expected_bytes: runtime.expected_bytes,
                last_error: None,
            };
        }
        return ModelStatusEntry {
            model_id: runtime.id.to_string(),
            status: "corrupt".to_string(),
            installed_bytes: Some(len),
            expected_bytes: runtime.expected_bytes,
            last_error: Some(format!(
                "installed size {len} does not match expected {}",
                runtime.expected_bytes
            )),
        };
    }

    if let Ok(metadata) = std::fs::metadata(&partial) {
        return ModelStatusEntry {
            model_id: runtime.id.to_string(),
            status: "partial".to_string(),
            installed_bytes: Some(metadata.len()),
            expected_bytes: runtime.expected_bytes,
            last_error: None,
        };
    }

    ModelStatusEntry {
        model_id: runtime.id.to_string(),
        status: "missing".to_string(),
        installed_bytes: None,
        expected_bytes: runtime.expected_bytes,
        last_error: None,
    }
}

pub fn progress_snapshot(
    model_id: &str,
    downloaded_bytes: u64,
    total_bytes: u64,
    elapsed: std::time::Duration,
    complete: bool,
) -> DownloadProgress {
    let percent = if complete || total_bytes == 0 {
        if complete {
            100
        } else {
            0
        }
    } else {
        (((downloaded_bytes as f64 / total_bytes as f64) * 100.0).min(99.0)) as u8
    };
    let elapsed_secs = elapsed.as_secs().max(1);
    DownloadProgress {
        model_id: model_id.to_string(),
        downloaded_bytes,
        total_bytes,
        percent,
        speed_bps: downloaded_bytes / elapsed_secs,
        elapsed_ms: elapsed.as_millis() as u64,
    }
}

/// Download a model into `models_dir`, invoking `on_progress` about every 250ms and at completion.
pub async fn download_model_with_progress_cb(
    runtime: &ModelRuntimeSpec,
    models_dir: &Path,
    mut on_progress: impl FnMut(&DownloadProgress),
) -> Result<PathBuf, String> {
    let destination = model_path(models_dir, runtime);
    if matches!(std::fs::metadata(&destination), Ok(m) if m.len() == runtime.expected_bytes) {
        on_progress(&progress_snapshot(
            runtime.id,
            runtime.expected_bytes,
            runtime.expected_bytes,
            std::time::Duration::from_millis(0),
            true,
        ));
        return Ok(destination);
    }

    let cancel = register_download(runtime.id)?;
    let result =
        download_model_with_progress_cb_inner(runtime, models_dir, &cancel, &mut on_progress).await;
    unregister_download(runtime.id);
    result
}

async fn download_model_with_progress_cb_inner(
    runtime: &ModelRuntimeSpec,
    models_dir: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&DownloadProgress),
) -> Result<PathBuf, String> {
    let destination = model_path(models_dir, runtime);
    if matches!(std::fs::metadata(&destination), Ok(m) if m.len() == runtime.expected_bytes) {
        on_progress(&progress_snapshot(
            runtime.id,
            runtime.expected_bytes,
            runtime.expected_bytes,
            std::time::Duration::from_millis(0),
            true,
        ));
        return Ok(destination);
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(format!("download cancelled for {}", runtime.id));
    }
    if tokio::fs::try_exists(&destination).await.unwrap_or(false) {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|e| format!("could not replace incomplete model {}: {e}", runtime.id))?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("could not determine storage directory for {}", runtime.id))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("could not create storage directory for {}: {e}", runtime.id))?;

    let partial = PathBuf::from(format!("{}.partial", destination.display()));
    if tokio::fs::try_exists(&partial).await.unwrap_or(false) {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(|e| format!("could not clear incomplete download for {}: {e}", runtime.id))?;
    }

    let response = reqwest::Client::new()
        .get(download_url(runtime))
        .send()
        .await
        .map_err(|e| format!("could not download model {}: {e}", runtime.id))?
        .error_for_status()
        .map_err(|e| format!("model download failed for {}: {e}", runtime.id))?;

    if let Some(content_length) = response.content_length() {
        if content_length != runtime.expected_bytes {
            return Err(format!(
                "download size for {} is {content_length}, expected {}",
                runtime.id, runtime.expected_bytes,
            ));
        }
    }

    log::info!(
        target: "kotoba_model_download",
        "downloading {} ({:.1} MiB)",
        runtime.id,
        runtime.expected_bytes as f64 / (1024.0 * 1024.0)
    );

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("could not create download for {}: {e}", runtime.id))?;

    let start = std::time::Instant::now();
    let mut response = response;
    let mut downloaded: u64 = 0;
    let mut last_emit = start;

    let write_result: Result<(), String> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("download interrupted for {}: {e}", runtime.id))?
        {
            if cancel.load(Ordering::SeqCst) {
                return Err(format!("download cancelled for {}", runtime.id));
            }
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > runtime.expected_bytes {
                return Err(format!("download exceeded expected size for {}", runtime.id));
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("could not write download for {}: {e}", runtime.id))?;

            let now = std::time::Instant::now();
            if now.duration_since(last_emit).as_millis() >= 250 {
                let progress = progress_snapshot(
                    runtime.id,
                    downloaded,
                    runtime.expected_bytes,
                    now.duration_since(start),
                    false,
                );
                on_progress(&progress);
                last_emit = now;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("could not finish download for {}: {e}", runtime.id))?;
        Ok(())
    }
    .await;

    drop(file);

    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }

    if downloaded != runtime.expected_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "downloaded {downloaded} bytes, expected {} for {}",
            runtime.expected_bytes, runtime.id,
        ));
    }

    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|e| format!("could not install model {}: {e}", runtime.id))?;

    let progress = progress_snapshot(
        runtime.id,
        runtime.expected_bytes,
        runtime.expected_bytes,
        start.elapsed(),
        true,
    );
    on_progress(&progress);

    log::info!(target: "kotoba_model_download", "downloaded model {}", runtime.id);
    Ok(destination)
}

/// Download multiple models in order (used by quick-start / batch install).
pub async fn download_models_with_progress_cb(
    model_ids: &[&str],
    models_dir: &Path,
    mut on_progress: impl FnMut(&DownloadProgress),
) -> Result<Vec<String>, String> {
    let mut result = Vec::with_capacity(model_ids.len());
    for id in model_ids {
        let runtime = spec(id).ok_or_else(|| format!("unknown model: {id}"))?;
        download_model_with_progress_cb(runtime, models_dir, &mut on_progress).await?;
        result.push((*id).to_string());
    }
    Ok(result)
}

pub async fn download_model_with_progress(
    app: &AppHandle,
    runtime: &ModelRuntimeSpec,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    download_model_with_progress_cb(runtime, models_dir, |progress| {
        let _ = app.emit("model:download:progress", progress);
    })
    .await
}

#[tauri::command]
pub async fn download_model(app: AppHandle, model_id: String) -> Result<String, String> {
    let runtime = spec(&model_id).ok_or_else(|| format!("unknown model: {model_id}"))?;
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    download_model_with_progress(&app, runtime, &models_dir).await?;
    Ok(model_id)
}

/// Translator id from the quick-start pack (Llama / Hy-MT2 GGUF).
pub fn quick_start_translator_id() -> Option<&'static str> {
    QUICK_START_MODEL_IDS
        .iter()
        .copied()
        .find(|id| matches!(spec(id).map(|runtime| runtime.server), Some(ModelServer::Llama)))
}

/// After a minimal pack install, prefer the downloaded translator when the
/// currently selected translator is not ready on disk. Keeps an already-ready
/// full-size translator selection so power users are not downgraded.
pub fn preferred_translator_after_quick_start(
    current_translator: &str,
    models_dir: &Path,
) -> Option<&'static str> {
    let qs_translator = quick_start_translator_id()?;
    if current_translator == qs_translator {
        return None;
    }
    let current_ready = spec(current_translator)
        .map(|runtime| classify_model_status(models_dir, runtime).status == "ready")
        .unwrap_or(false);
    if current_ready {
        return None;
    }
    Some(qs_translator)
}

fn app_user_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve app config directory: {error}"))?
        .join("config.json"))
}

fn align_selection_after_quick_start(
    app: &AppHandle,
    state: &State<'_, AppState>,
    models_dir: &Path,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|_| "config lock poisoned".to_string())?.clone();
    let Some(translator_id) =
        preferred_translator_after_quick_start(&config.models.translator, models_dir)
    else {
        return Ok(());
    };

    log::info!(
        target: "kotoba_model_download",
        "quick-start aligned translator selection {} → {}",
        config.models.translator,
        translator_id
    );
    config.models.translator = translator_id.to_string();

    let config_path = app_user_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create config directory: {error}"))?;
    }
    let payload = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("could not serialize config: {error}"))?;
    std::fs::write(&config_path, payload)
        .map_err(|error| format!("could not write config: {error}"))?;

    *state.config.lock().map_err(|_| "config lock poisoned".to_string())? = config.clone();
    let _ = app.emit("config:update", &config);
    Ok(())
}

#[tauri::command]
pub async fn download_quick_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    let ids = download_models_with_progress_cb(QUICK_START_MODEL_IDS, &models_dir, |progress| {
        let _ = app.emit("model:download:progress", progress);
    })
    .await?;
    // Start Capture reads backend config — without this, the default full-size
    // translator stays selected and the "minimal" pack does not make capture operable.
    align_selection_after_quick_start(&app, &state, &models_dir)?;
    Ok(ids)
}

#[tauri::command]
pub async fn list_model_status(app: AppHandle) -> Result<Vec<ModelStatusEntry>, String> {
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    Ok(crate::model_runtime::all_specs()
        .iter()
        .map(|runtime| classify_model_status(&models_dir, runtime))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_model_download, classify_model_status, download_model_with_progress_cb,
        download_models_with_progress_cb, preferred_translator_after_quick_start,
        progress_snapshot, quick_start_translator_id, register_download, unregister_download,
        QUICK_START_MODEL_IDS,
    };
    use crate::model_runtime::{model_path, spec};
    use std::io::{Seek, SeekFrom, Write};
    use std::time::Duration;

    fn write_expected_size_file(path: &std::path::Path, expected_bytes: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut file = std::fs::File::create(path).unwrap();
        if expected_bytes > 0 {
            file.seek(SeekFrom::Start(expected_bytes - 1)).unwrap();
            file.write_all(&[0]).unwrap();
        }
    }

    #[test]
    fn quick_start_ids_are_known_runtime_specs() {
        assert_eq!(QUICK_START_MODEL_IDS.len(), 2);
        for id in QUICK_START_MODEL_IDS {
            assert!(spec(id).is_some(), "missing runtime spec for {id}");
        }
    }

    #[test]
    fn progress_caps_incomplete_at_99_and_marks_complete_at_100() {
        let mid = progress_snapshot("m", 50, 100, Duration::from_secs(2), false);
        assert_eq!(mid.percent, 50);
        assert_eq!(mid.speed_bps, 25);

        let almost = progress_snapshot("m", 100, 100, Duration::from_secs(1), false);
        assert_eq!(almost.percent, 99);

        let done = progress_snapshot("m", 100, 100, Duration::from_secs(1), true);
        assert_eq!(done.percent, 100);
    }

    #[test]
    fn classify_reports_missing_ready_corrupt_and_partial() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("xsmall");
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-status-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(model_path(&root, runtime).parent().unwrap()).unwrap();

        let missing = classify_model_status(&root, runtime);
        assert_eq!(missing.status, "missing");
        assert_eq!(missing.expected_bytes, runtime.expected_bytes);

        let destination = model_path(&root, runtime);
        std::fs::write(&destination, vec![0_u8; 16]).unwrap();
        let corrupt = classify_model_status(&root, runtime);
        assert_eq!(corrupt.status, "corrupt");
        assert_eq!(corrupt.installed_bytes, Some(16));
        assert!(corrupt.last_error.is_some());

        std::fs::write(&destination, vec![0_u8; runtime.expected_bytes as usize]).unwrap();
        let ready = classify_model_status(&root, runtime);
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.installed_bytes, Some(runtime.expected_bytes));

        std::fs::remove_file(&destination).unwrap();
        let partial_path = format!("{}.partial", destination.display());
        std::fs::write(&partial_path, vec![0_u8; 1024]).unwrap();
        let partial = classify_model_status(&root, runtime);
        assert_eq!(partial.status, "partial");
        assert_eq!(partial.installed_bytes, Some(1024));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn already_ready_model_skips_network_and_emits_100() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("xsmall");
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-ready-skip-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let destination = model_path(&root, runtime);
        // Avoid allocating ~21 MiB of zeros: seek+write creates a sparse-like file.
        write_expected_size_file(&destination, runtime.expected_bytes);
        assert_eq!(std::fs::metadata(&destination).unwrap().len(), runtime.expected_bytes);

        let mut percents = Vec::new();
        let path = download_model_with_progress_cb(runtime, &root, |progress| {
            percents.push(progress.percent);
        })
        .await
        .expect("ready model should short-circuit");

        assert_eq!(path, destination);
        assert_eq!(percents, vec![100]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn batch_quick_start_skips_network_when_all_ready() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-batch-ready-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        for id in QUICK_START_MODEL_IDS {
            let runtime = spec(id).expect("quick-start id");
            write_expected_size_file(&model_path(&root, runtime), runtime.expected_bytes);
        }

        let mut seen = Vec::new();
        let ids = download_models_with_progress_cb(QUICK_START_MODEL_IDS, &root, |progress| {
            if progress.percent == 100 {
                seen.push(progress.model_id.clone());
            }
        })
        .await
        .expect("batch quick-start with ready files");

        assert_eq!(ids, QUICK_START_MODEL_IDS.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert_eq!(seen, ids);
        for id in QUICK_START_MODEL_IDS {
            assert_eq!(classify_model_status(&root, spec(id).unwrap()).status, "ready");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cancel_command_flags_active_download() {
        let id = format!("cancel-test-{}", uuid::Uuid::new_v4());
        let flag = register_download(&id).expect("register");
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
        cancel_model_download(id.clone()).await.expect("cancel");
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        unregister_download(&id);
        let err = cancel_model_download(id).await.expect_err("no active download");
        assert!(err.contains("no active download"));
    }

    #[tokio::test]
    #[ignore = "downloads ~21 MiB from Hugging Face; run explicitly before a release"]
    async fn downloads_xsmall_with_progress_callback() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("xsmall");
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-download-progress-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut last_percent = 0_u8;
        let mut events = 0_u32;
        let path = download_model_with_progress_cb(runtime, &root, |progress| {
            assert_eq!(progress.model_id, runtime.id);
            assert_eq!(progress.total_bytes, runtime.expected_bytes);
            assert!(progress.percent >= last_percent);
            last_percent = progress.percent;
            events = events.saturating_add(1);
            eprintln!(
                "progress {} {}% {}/{} bytes {} bps",
                progress.model_id,
                progress.percent,
                progress.downloaded_bytes,
                progress.total_bytes,
                progress.speed_bps
            );
        })
        .await
        .expect("xsmall should download");

        assert_eq!(path, model_path(&root, runtime));
        assert_eq!(last_percent, 100);
        assert!(events >= 1, "expected at least one progress event");
        assert_eq!(classify_model_status(&root, runtime).status, "ready".to_string());
        eprintln!(
            "individual download complete: {} -> {} ({} bytes)",
            runtime.id,
            path.display(),
            runtime.expected_bytes
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "downloads ~21 MiB from Hugging Face for the missing quick-start model; run explicitly"]
    async fn batch_quick_start_downloads_missing_xsmall_and_skips_ready_hy() {
        let runtime_xsmall = spec("zenz-v3.2-xsmall-gguf").expect("xsmall");
        let runtime_hy = spec("hy-mt2-1.8b-1.25bit-gguf").expect("hy");
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-batch-mixed-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        // Seed translator as ready so the batch path only needs the ~21 MiB normalizer.
        write_expected_size_file(&model_path(&root, runtime_hy), runtime_hy.expected_bytes);

        let mut completed = Vec::new();
        let ids = download_models_with_progress_cb(QUICK_START_MODEL_IDS, &root, |progress| {
            if progress.percent == 100 {
                completed.push(progress.model_id.clone());
            }
            if progress.model_id == runtime_xsmall.id && progress.percent < 100 {
                eprintln!(
                    "batch progress {} {}% {}/{}",
                    progress.model_id,
                    progress.percent,
                    progress.downloaded_bytes,
                    progress.total_bytes
                );
            }
        })
        .await
        .expect("batch quick-start should complete");

        assert_eq!(ids, vec![runtime_xsmall.id.to_string(), runtime_hy.id.to_string()]);
        assert_eq!(completed, ids);
        assert_eq!(classify_model_status(&root, runtime_xsmall).status, "ready");
        assert_eq!(classify_model_status(&root, runtime_hy).status, "ready");
        assert_eq!(
            std::fs::metadata(model_path(&root, runtime_xsmall)).unwrap().len(),
            runtime_xsmall.expected_bytes
        );
        eprintln!("batch download complete: {:?}", ids);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn quick_start_uses_minimal_model_ids() {
        assert_eq!(
            QUICK_START_MODEL_IDS.len(),
            2,
            "quick-start must target exactly 2 models (normalizer + translator)"
        );
        let xsmall = spec("zenz-v3.2-xsmall-gguf").expect("xsmall spec");
        let hy_125bit = spec("hy-mt2-1.8b-1.25bit-gguf").expect("hy 1.25bit spec");
        let all = crate::model_runtime::all_specs();
        let smallest_zenz = all
            .iter()
            .filter(|s| matches!(s.server, crate::model_runtime::ModelServer::Zenz))
            .min_by_key(|s| s.expected_bytes)
            .expect("at least one zenz model");
        let smallest_llama = all
            .iter()
            .filter(|s| matches!(s.server, crate::model_runtime::ModelServer::Llama))
            .min_by_key(|s| s.expected_bytes)
            .expect("at least one llama model");
        assert_eq!(
            xsmall.expected_bytes, smallest_zenz.expected_bytes,
            "quick-start must use the smallest normalizer model"
        );
        assert_eq!(
            hy_125bit.expected_bytes, smallest_llama.expected_bytes,
            "quick-start must use the smallest translator model"
        );
        assert!(
            hy_125bit.expected_bytes < 700_000_000,
            "quick-start translator must stay well below 700 MiB"
        );
        assert_eq!(quick_start_translator_id(), Some("hy-mt2-1.8b-1.25bit-gguf"));
    }

    #[test]
    fn quick_start_prefers_minimal_translator_when_selected_is_missing() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-qs-align-missing-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert_eq!(
            preferred_translator_after_quick_start("hy-mt2-1.8b-gguf", &root),
            Some("hy-mt2-1.8b-1.25bit-gguf"),
            "default full translator is missing → align to minimal pack"
        );
        assert_eq!(
            preferred_translator_after_quick_start("hy-mt2-1.8b-1.25bit-gguf", &root),
            None,
            "already on quick-start translator → no change"
        );

        // Seed the full-size translator as ready: keep the user's quality choice.
        let full = spec("hy-mt2-1.8b-gguf").expect("full hy");
        write_expected_size_file(&model_path(&root, full), full.expected_bytes);
        assert_eq!(
            preferred_translator_after_quick_start("hy-mt2-1.8b-gguf", &root),
            None,
            "ready full translator must not be downgraded"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_model_status_covers_every_catalogued_spec() {
        let specs = crate::model_runtime::all_specs();
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-status-all-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut statuses = Vec::new();
        for spec in specs {
            let entry = classify_model_status(&root, spec);
            statuses.push(entry);
        }
        assert_eq!(statuses.len(), 7);
        for entry in &statuses {
            assert_eq!(entry.status, "missing");
            assert!(entry.installed_bytes.is_none());
            assert!(entry.last_error.is_none());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "starts a real HF download then cancels; run explicitly"]
    async fn cancel_aborts_in_flight_xsmall_download() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("xsmall");
        let root = std::env::temp_dir().join(format!(
            "kotoba-model-cancel-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let model_id = runtime.id.to_string();
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<u8>();

        let download_root = root.clone();
        let download = tokio::spawn(async move {
            download_model_with_progress_cb(runtime, &download_root, |progress| {
                let _ = progress_tx.send(progress.percent);
            })
            .await
        });

        // Wait until the download has registered and emitted at least one progress tick,
        // or until the whole request finishes (very fast networks / cached CDN).
        let saw_progress =
            tokio::time::timeout(std::time::Duration::from_secs(30), progress_rx.recv())
                .await
                .ok()
                .flatten()
                .is_some();

        if saw_progress {
            cancel_model_download(model_id.clone())
                .await
                .expect("cancel should find the active download");
            let err = download
                .await
                .expect("join download task")
                .expect_err("cancelled download must fail");
            assert!(err.contains("cancelled"), "expected cancellation error, got: {err}");
            eprintln!("cancel path ok for {model_id}: {err}");
        } else {
            // Finished before we could cancel — still prove the success path ran.
            let path = download
                .await
                .expect("join download task")
                .expect("download completed before cancel");
            assert_eq!(path, model_path(&root, runtime));
            eprintln!("download finished before cancel could run (still success path): {path:?}");
        }

        let destination = model_path(&root, runtime);
        let partial = std::path::PathBuf::from(format!("{}.partial", destination.display()));
        assert!(!partial.exists(), "partial file should be cleaned up after cancel or completion");
        let _ = std::fs::remove_dir_all(&root);
    }
}
