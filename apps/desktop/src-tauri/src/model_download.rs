use crate::model_runtime::{
    archive_download_url, archive_extract_dir, archive_model_extracted, archive_model_path,
    download_url, input_lm_cache_root, input_lm_tokenizer_cache_dir, model_path, spec,
    ArchiveModelSpec, ModelRuntimeSpec, ModelServer, INPUT_LM_ARCHIVE_SPEC,
};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use zip::ZipArchive;

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
    /// Download origin (Hugging Face / GitHub release, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Absolute path under the Parapper or GGUF model runtime directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// Optional role such as `completion`, `interim`, or GGUF family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Human-readable label for Debug / Settings panels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Classify install state for a single model path layout under `models_dir`.
pub fn classify_model_status(models_dir: &Path, runtime: &ModelRuntimeSpec) -> ModelStatusEntry {
    let destination = model_path(models_dir, runtime);
    let partial = PathBuf::from(format!("{}.partial", destination.display()));
    let local_path = Some(destination.display().to_string());
    let source_url = Some(download_url(runtime));
    let role = Some(
        match runtime.server {
            ModelServer::Zenz => "normalizer",
            ModelServer::Llama => "translator",
        }
        .to_string(),
    );
    let label = Some(runtime.id.to_string());

    if let Ok(metadata) = std::fs::metadata(&destination) {
        let len = metadata.len();
        if len == runtime.expected_bytes {
            return ModelStatusEntry {
                model_id: runtime.id.to_string(),
                status: "ready".to_string(),
                installed_bytes: Some(len),
                expected_bytes: runtime.expected_bytes,
                last_error: None,
                source_url,
                local_path,
                role,
                label,
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
            source_url,
            local_path,
            role,
            label,
        };
    }

    if let Ok(metadata) = std::fs::metadata(&partial) {
        return ModelStatusEntry {
            model_id: runtime.id.to_string(),
            status: "partial".to_string(),
            installed_bytes: Some(metadata.len()),
            expected_bytes: runtime.expected_bytes,
            last_error: None,
            source_url,
            local_path,
            role,
            label,
        };
    }

    ModelStatusEntry {
        model_id: runtime.id.to_string(),
        status: "missing".to_string(),
        installed_bytes: None,
        expected_bytes: runtime.expected_bytes,
        last_error: None,
        source_url,
        local_path,
        role,
        label,
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
    let write_result =
        write_download_chunks(&mut response, &mut file, runtime, cancel, on_progress, start).await;

    drop(file);

    let downloaded = match write_result {
        Ok(downloaded) => downloaded,
        Err(error) => {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error);
        }
    };

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

async fn write_download_chunks(
    response: &mut reqwest::Response,
    file: &mut tokio::fs::File,
    runtime: &ModelRuntimeSpec,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&DownloadProgress),
    start: std::time::Instant,
) -> Result<u64, String> {
    let mut downloaded = 0_u64;
    let mut last_emit = start;

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
        if now.duration_since(last_emit).as_millis() < 250 {
            continue;
        }
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

    file.flush().await.map_err(|e| format!("could not finish download for {}: {e}", runtime.id))?;
    Ok(downloaded)
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
    let mut entries: Vec<ModelStatusEntry> = crate::model_runtime::all_specs()
        .iter()
        .map(|runtime| classify_model_status(&models_dir, runtime))
        .collect();
    // Also report the input-LM archive model so the UI can show whether the
    // rescorer model is installed.
    let cache_root = input_lm_cache_root();
    entries.push(classify_archive_model_status(&cache_root, &INPUT_LM_ARCHIVE_SPEC));

    // Parapper ASR models (ReazonSpeech + optional Nemotron interim) live under
    // the isolated sidecar runtime directory, not the GGUF model cache.
    let streaming_interim = app
        .try_state::<AppState>()
        .and_then(|state| {
            state.config.lock().ok().map(|config| config.audio.streaming_interim_asr_enabled)
        })
        .unwrap_or(true);
    let parapper_runtime = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?
        .join("parapper");
    entries.extend(crate::parapper_asr_models::list_parapper_asr_model_status(
        &parapper_runtime,
        streaming_interim,
    ));
    Ok(entries)
}

/// Classify install state for an archive model under `cache_root`.
///
/// Unlike [`classify_model_status`] (which checks a single GGUF file), this
/// checks whether every expected file in `spec.expected_files` exists under
/// the extraction directory. The `installed_bytes` field reports the archive
/// size when ready, matching the GGUF convention.
pub fn classify_archive_model_status(
    cache_root: &Path,
    spec: &ArchiveModelSpec,
) -> ModelStatusEntry {
    let extract_dir = archive_extract_dir(cache_root, spec);
    if archive_model_extracted(&extract_dir, spec) {
        ModelStatusEntry {
            model_id: spec.id.to_string(),
            status: "ready".to_string(),
            installed_bytes: Some(spec.expected_bytes),
            expected_bytes: spec.expected_bytes,
            last_error: None,
            source_url: Some(archive_download_url(spec)),
            local_path: Some(extract_dir.display().to_string()),
            role: Some("rescore".to_string()),
            label: Some(spec.id.to_string()),
        }
    } else {
        ModelStatusEntry {
            model_id: spec.id.to_string(),
            status: "missing".to_string(),
            installed_bytes: None,
            expected_bytes: spec.expected_bytes,
            last_error: None,
            source_url: Some(archive_download_url(spec)),
            local_path: Some(extract_dir.display().to_string()),
            role: Some("rescore".to_string()),
            label: Some(spec.id.to_string()),
        }
    }
}

/// Download and extract the input-LM N-gram model.
///
/// This is a user-triggered, explicit download — the 120 MB archive is never
/// fetched automatically. The command emits `model:download:progress` events
/// (same channel as the GGUF downloads) so the existing UI progress bars work
/// without modification. Cancellation is handled through `cancel_model_download`
/// with the model id `input-n5-lm-v1`.
///
/// **Fail-open**: if the download fails or is cancelled, the pipeline rescorer
/// simply stays inactive — no caption is ever dropped.
#[tauri::command]
#[allow(clippy::excessive_nesting)]
pub async fn download_input_lm_model(app: AppHandle) -> Result<String, String> {
    let cache_root = input_lm_cache_root();
    let spec = &INPUT_LM_ARCHIVE_SPEC;
    let cancel = register_download(spec.id)?;
    let result = download_and_extract_archive_model(spec, &cache_root, &cancel, |progress| {
        let _ = app.emit("model:download:progress", progress);
    })
    .await;
    unregister_download(spec.id);
    let extract_dir = result?;
    // Packaged builds cannot resolve the AzooKey submodule tokenizer path.
    // Copy the bundled vocab/merges next to the model so rescoring can load.
    if let Err(error) = ensure_input_lm_tokenizer_installed(&app) {
        log::warn!("input-LM tokenizer install skipped: {error}");
    }
    let model_stem = archive_model_path(&cache_root, spec);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut config) = state.config.lock() {
            config.rescore.model_path = Some(model_stem.display().to_string());
            let config_path = app.path().app_config_dir().map(|dir| dir.join("config.json")).ok();
            if let Some(path) = config_path {
                if let Ok(payload) = serde_json::to_vec_pretty(&*config) {
                    let _ = std::fs::write(path, payload);
                }
            }
            let _ = app.emit("config:update", &*config);
        }
        state.pipeline.invalidate_rescorer();
    }
    Ok(extract_dir.display().to_string())
}

/// Ensure `vocab.json` / `merges.txt` exist under the input-LM tokenizer cache.
///
/// Prefers the bundled app resource (`input-lm-tokenizer/`). Falls back to the
/// source-tree submodule path used by developer builds.
pub fn ensure_input_lm_tokenizer_installed(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = input_lm_tokenizer_cache_dir();
    let vocab = dest.join("vocab.json");
    let merges = dest.join("merges.txt");
    if vocab.is_file() && merges.is_file() {
        return Ok(dest);
    }
    std::fs::create_dir_all(&dest)
        .map_err(|error| format!("could not create input-LM tokenizer cache: {error}"))?;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("input-lm-tokenizer"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/input-lm-tokenizer"));
    candidates
        .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../../submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer",
        ));

    let Some(source) = candidates
        .into_iter()
        .find(|dir| dir.join("vocab.json").is_file() && dir.join("merges.txt").is_file())
    else {
        return Err("input-LM tokenizer resources were not found".to_string());
    };
    std::fs::copy(source.join("vocab.json"), &vocab)
        .map_err(|error| format!("could not copy vocab.json: {error}"))?;
    std::fs::copy(source.join("merges.txt"), &merges)
        .map_err(|error| format!("could not copy merges.txt: {error}"))?;
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Multi-file archive model download + Zip-Slip-safe extraction
//
// This is an additive parallel path for the input-LM N-gram model (a 120 MB
// ZIP of MARISA tries). The existing single-file GGUF download path above is
// untouched and remains byte-identical.
// ---------------------------------------------------------------------------

/// Buffer size for synchronous SHA-256 streaming and ZIP extraction.
const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// Verify that the SHA-256 of the file at `path` matches `expected_sha256`
/// (lowercase hex). Returns `Ok(())` on match, `Err` on any I/O or mismatch.
fn verify_sha256(path: &Path, expected_sha256: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("could not open file for SHA-256 verification: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; HASH_BUFFER_BYTES];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("could not read file for SHA-256 verification: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let computed = hex::encode(hasher.finalize());
    if computed != expected_sha256 {
        return Err(format!("SHA-256 mismatch: expected {expected_sha256}, computed {computed}"));
    }
    Ok(())
}

/// Resolve a ZIP entry name to a safe extraction path under `dest_dir`.
///
/// Rejects any entry whose normalized path escapes `dest_dir`:
/// - absolute paths (`/etc/passwd`)
/// - parent-directory components (`../../foo`)
/// - Windows drive prefixes (`C:\foo`)
/// - root-directory components (`/foo`)
///
/// Backslashes in the entry name are normalized to forward slashes before
/// checking, so a malicious archive cannot bypass the `..` filter on Unix by
/// using `\..\` (the ZIP spec mandates `/`, but some archives are non-conforming).
fn safe_extract_path(entry_name: &str, dest_dir: &Path) -> Result<PathBuf, String> {
    let normalized = entry_name.replace('\\', "/");
    let entry_path = Path::new(&normalized);

    if entry_path.is_absolute() {
        return Err(format!("archive entry has absolute path: {entry_name}"));
    }

    for component in entry_path.components() {
        match component {
            Component::ParentDir => {
                return Err(format!(
                    "archive entry contains parent directory component: {entry_name}"
                ));
            }
            Component::Prefix(_) => {
                return Err(format!("archive entry has Windows prefix: {entry_name}"));
            }
            Component::RootDir => {
                return Err(format!("archive entry has root directory component: {entry_name}"));
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }

    Ok(dest_dir.join(entry_path))
}

/// Extract every entry from the ZIP at `zip_path` into `dest_dir`, rejecting
/// any entry whose path escapes the destination (Zip Slip protection).
///
/// This is a synchronous function — it is called from a `spawn_blocking` task
/// by the async orchestrator so the extraction does not hold the tokio runtime.
fn extract_zip_safe(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("could not open archive for extraction: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("could not read ZIP archive: {e}"))?;

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("could not create extraction directory: {e}"))?;

    for i in 0..archive.len() {
        extract_zip_entry(&mut archive, i, dest_dir)?;
    }

    Ok(())
}

/// Extract a single entry from the archive, applying Zip Slip protection.
fn extract_zip_entry<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    i: usize,
    dest_dir: &Path,
) -> Result<(), String> {
    let mut entry =
        archive.by_index(i).map_err(|e| format!("could not read archive entry {i}: {e}"))?;

    let name = entry.name().to_string();
    if name.is_empty() {
        return Err(format!("archive entry {i} has empty name"));
    }

    let outpath = safe_extract_path(&name, dest_dir)?;

    if entry.is_dir() {
        std::fs::create_dir_all(&outpath)
            .map_err(|e| format!("could not create directory for entry {i}: {e}"))?;
        return Ok(());
    }

    if let Some(parent) = outpath.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create parent directory for entry {i}: {e}"))?;
    }
    let mut output = std::fs::File::create(&outpath)
        .map_err(|e| format!("could not create file for entry {i}: {e}"))?;
    std::io::copy(&mut entry, &mut output)
        .map_err(|e| format!("could not extract entry {i}: {e}"))?;
    Ok(())
}

/// Download the archive for `spec` into `cache_root`, verifying the byte count
/// and SHA-256. Returns the path to the downloaded ZIP file.
///
/// The download streams to a `.partial` file and is atomically renamed on
/// success. A failed or interrupted download leaves no residue behind.
/// Progress events are emitted through `on_progress` roughly every 250 ms,
/// and `cancel` is checked between chunks so a user can abort the download.
async fn download_archive_file(
    spec: &ArchiveModelSpec,
    cache_root: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&DownloadProgress),
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(cache_root)
        .await
        .map_err(|e| format!("could not create cache directory for {}: {e}", spec.id))?;

    let destination = cache_root.join(spec.hf_file);
    let partial = PathBuf::from(format!("{}.partial", destination.display()));

    // If a fully verified archive already exists, skip the download.
    if matches!(std::fs::metadata(&destination), Ok(m) if m.len() == spec.expected_bytes)
        && verify_sha256(&destination, spec.expected_sha256).is_ok()
    {
        return Ok(destination);
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(format!("archive download cancelled for {}", spec.id));
    }

    if tokio::fs::try_exists(&partial).await.unwrap_or(false) {
        tokio::fs::remove_file(&partial).await.map_err(|e| {
            format!("could not clear incomplete archive download for {}: {e}", spec.id)
        })?;
    }

    let response = reqwest::Client::new()
        .get(archive_download_url(spec))
        .send()
        .await
        .map_err(|e| format!("could not download archive {}: {e}", spec.id))?
        .error_for_status()
        .map_err(|e| format!("archive download failed for {}: {e}", spec.id))?;

    if let Some(content_length) = response.content_length() {
        if content_length != spec.expected_bytes {
            return Err(format!(
                "archive download size for {} is {content_length}, expected {}",
                spec.id, spec.expected_bytes
            ));
        }
    }

    log::info!(
        target: "kotoba_archive_download",
        "downloading {} ({:.1} MiB)",
        spec.id,
        spec.expected_bytes as f64 / (1024.0 * 1024.0)
    );

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("could not create archive download for {}: {e}", spec.id))?;

    let start = std::time::Instant::now();
    let mut last_emit = start;
    let mut response = response;
    let mut downloaded = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("archive download interrupted for {}: {e}", spec.id))?
    {
        if cancel.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!("archive download cancelled for {}", spec.id));
        }
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > spec.expected_bytes {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!("archive download exceeded expected size for {}", spec.id));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write archive download for {}: {e}", spec.id))?;

        let now = std::time::Instant::now();
        if now.duration_since(last_emit).as_millis() >= 250 {
            let progress = progress_snapshot(
                spec.id,
                downloaded,
                spec.expected_bytes,
                now.duration_since(start),
                false,
            );
            on_progress(&progress);
            last_emit = now;
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("could not finish archive download for {}: {e}", spec.id))?;
    drop(file);

    if downloaded != spec.expected_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "archive download size for {} is {downloaded} bytes, expected {} bytes",
            spec.id, spec.expected_bytes
        ));
    }

    // SHA-256 verification of the downloaded file.
    let partial_path = partial.clone();
    let expected_hash = spec.expected_sha256.to_string();
    let hash_result =
        tokio::task::spawn_blocking(move || verify_sha256(&partial_path, &expected_hash))
            .await
            .map_err(|e| format!("SHA-256 verification task panicked for {}: {e}", spec.id))?;

    if let Err(e) = hash_result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(e);
    }

    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|e| format!("could not install archive {}: {e}", spec.id))?;

    log::info!(target: "kotoba_archive_download", "downloaded archive {}", spec.id);
    Ok(destination)
}

/// Download, verify, and extract an archive model into `cache_root`.
///
/// Flow:
/// 1. If the model is already extracted (all expected files present), return early.
/// 2. Download the ZIP to `cache_root/{hf_file}`, verifying byte count + SHA-256.
/// 3. Extract to a temp directory, then atomically rename to the final location.
/// 4. Verify every expected file exists after extraction.
/// 5. Remove the downloaded ZIP (the extracted files are the source of truth).
///
/// **Fail-open contract**: on any error the extracted files will not be present,
/// so `open_model` in the pipeline will return an error and the rescorer falls
/// back to the original ASR reading. A failed download never drops a caption.
pub async fn download_and_extract_archive_model(
    spec: &ArchiveModelSpec,
    cache_root: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&DownloadProgress),
) -> Result<PathBuf, String> {
    let extract_dir = archive_extract_dir(cache_root, spec);

    // 1. Already extracted — nothing to do.
    if archive_model_extracted(&extract_dir, spec) {
        return Ok(extract_dir);
    }

    // 2. Download + verify.
    let zip_path = download_archive_file(spec, cache_root, cancel, &mut on_progress).await?;

    // 3. Extract to a temp directory, then atomically swap.
    let temp_dir = cache_root.join(format!(
        "{}.tmp.{}.{}",
        spec.extract_subdir,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    // Clean up any stale temp directory from a previous interrupted attempt.
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let zip_path_clone = zip_path.clone();
    let temp_dir_clone = temp_dir.clone();
    tokio::task::spawn_blocking(move || extract_zip_safe(&zip_path_clone, &temp_dir_clone))
        .await
        .map_err(|e| format!("extraction task panicked for {}: {e}", spec.id))??;

    // 4. Verify expected files exist in the temp directory.
    if !archive_model_extracted(&temp_dir, spec) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "archive extraction for {} did not produce all expected files",
            spec.id
        ));
    }

    // 5. Atomically swap: remove old extract dir, rename temp dir into place.
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    tokio::fs::rename(&temp_dir, &extract_dir)
        .await
        .map_err(|e| format!("could not install extracted model {}: {e}", spec.id))?;

    // 6. Clean up the ZIP — the extracted files are the source of truth.
    let _ = tokio::fs::remove_file(&zip_path).await;

    // Emit 100% so the frontend can clear the progress bar and refresh status.
    on_progress(&progress_snapshot(
        spec.id,
        spec.expected_bytes,
        spec.expected_bytes,
        std::time::Duration::from_millis(0),
        true,
    ));

    log::info!(target: "kotoba_archive_download", "extracted archive {}", spec.id);
    Ok(extract_dir)
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_model_download, classify_archive_model_status, classify_model_status,
        download_and_extract_archive_model, download_model_with_progress_cb,
        download_models_with_progress_cb, extract_zip_safe, preferred_translator_after_quick_start,
        progress_snapshot, quick_start_translator_id, register_download, safe_extract_path,
        unregister_download, verify_sha256, DownloadProgress, ModelRuntimeSpec,
        QUICK_START_MODEL_IDS,
    };
    use crate::model_runtime::{archive_extract_dir, model_path, spec, INPUT_LM_ARCHIVE_SPEC};
    use sha2::{Digest, Sha256};
    use std::io::{Seek, SeekFrom, Write};
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

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

    async fn download_ready_batch(
        root: &std::path::Path,
        seen: &mut Vec<String>,
    ) -> Result<Vec<String>, String> {
        download_models_with_progress_cb(QUICK_START_MODEL_IDS, root, |progress| {
            seen.extend((progress.percent == 100).then(|| progress.model_id.clone()));
        })
        .await
    }

    fn log_batch_download_progress(progress: &DownloadProgress, model_id: &str) {
        if progress.model_id != model_id || progress.percent >= 100 {
            return;
        }
        eprintln!(
            "batch progress {} {}% {}/{}",
            progress.model_id, progress.percent, progress.downloaded_bytes, progress.total_bytes
        );
    }

    async fn download_mixed_batch(
        root: &std::path::Path,
        runtime_xsmall_id: &str,
        completed: &mut Vec<String>,
    ) -> Result<Vec<String>, String> {
        download_models_with_progress_cb(QUICK_START_MODEL_IDS, root, |progress| {
            completed.extend((progress.percent == 100).then(|| progress.model_id.clone()));
            log_batch_download_progress(progress, runtime_xsmall_id);
        })
        .await
    }

    async fn download_with_progress_channel(
        runtime: &'static ModelRuntimeSpec,
        root: std::path::PathBuf,
        progress_tx: tokio::sync::mpsc::UnboundedSender<u8>,
    ) -> Result<std::path::PathBuf, String> {
        download_model_with_progress_cb(runtime, &root, |progress| {
            let _ = progress_tx.send(progress.percent);
        })
        .await
    }

    async fn download_single_with_progress(
        runtime: &'static ModelRuntimeSpec,
        root: &std::path::Path,
        percents: &mut Vec<u8>,
    ) -> Result<std::path::PathBuf, String> {
        download_model_with_progress_cb(runtime, root, |progress| {
            percents.push(progress.percent);
        })
        .await
    }

    /// Wrap the archive download in a helper so the closure does not push the
    /// test body past the clippy excessive-nesting threshold.
    async fn download_and_extract_pre_cancelled(
        root: &std::path::Path,
    ) -> Result<std::path::PathBuf, String> {
        let cancel = AtomicBool::new(true);
        download_and_extract_archive_model(&INPUT_LM_ARCHIVE_SPEC, root, &cancel, |_| {}).await
    }

    /// Same as above, but tracks whether any progress callback fired.
    async fn download_and_extract_checking_progress(
        root: &std::path::Path,
        progress_seen: &mut bool,
    ) -> Result<std::path::PathBuf, String> {
        let cancel = AtomicBool::new(false);
        download_and_extract_archive_model(&INPUT_LM_ARCHIVE_SPEC, root, &cancel, |_| {
            *progress_seen = true;
        })
        .await
    }

    fn seed_quick_start_models(root: &std::path::Path) {
        for id in QUICK_START_MODEL_IDS {
            let runtime = spec(id).expect("quick-start id");
            write_expected_size_file(&model_path(root, runtime), runtime.expected_bytes);
        }
    }

    fn assert_quick_start_models_ready(root: &std::path::Path) {
        for id in QUICK_START_MODEL_IDS {
            assert_eq!(classify_model_status(root, spec(id).unwrap()).status, "ready");
        }
    }

    fn record_xsmall_progress(
        progress: &DownloadProgress,
        runtime: &'static ModelRuntimeSpec,
        last_percent: &mut u8,
        events: &mut u32,
    ) {
        assert_eq!(progress.model_id, runtime.id);
        assert_eq!(progress.total_bytes, runtime.expected_bytes);
        assert!(progress.percent >= *last_percent);
        *last_percent = progress.percent;
        *events = events.saturating_add(1);
        eprintln!(
            "progress {} {}% {}/{} bytes {} bps",
            progress.model_id,
            progress.percent,
            progress.downloaded_bytes,
            progress.total_bytes,
            progress.speed_bps
        );
    }

    async fn download_xsmall_with_progress(
        runtime: &'static ModelRuntimeSpec,
        root: &std::path::Path,
        last_percent: &mut u8,
        events: &mut u32,
    ) -> Result<std::path::PathBuf, String> {
        download_model_with_progress_cb(runtime, root, |progress| {
            record_xsmall_progress(progress, runtime, last_percent, events);
        })
        .await
    }

    async fn assert_cancelled_download(
        download: tokio::task::JoinHandle<Result<std::path::PathBuf, String>>,
        model_id: &str,
    ) {
        cancel_model_download(model_id.to_string())
            .await
            .expect("cancel should find the active download");
        let err =
            download.await.expect("join download task").expect_err("cancelled download must fail");
        assert!(err.contains("cancelled"), "expected cancellation error, got: {err}");
        eprintln!("cancel path ok for {model_id}: {err}");
    }

    async fn assert_completed_download(
        download: tokio::task::JoinHandle<Result<std::path::PathBuf, String>>,
        root: &std::path::Path,
        runtime: &'static ModelRuntimeSpec,
    ) {
        let path =
            download.await.expect("join download task").expect("download completed before cancel");
        assert_eq!(path, model_path(root, runtime));
        eprintln!("download finished before cancel could run (still success path): {path:?}");
    }

    async fn assert_download_outcome(
        download: tokio::task::JoinHandle<Result<std::path::PathBuf, String>>,
        saw_progress: bool,
        model_id: &str,
        root: &std::path::Path,
        runtime: &'static ModelRuntimeSpec,
    ) {
        if saw_progress {
            assert_cancelled_download(download, model_id).await;
        } else {
            assert_completed_download(download, root, runtime).await;
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
        let path = download_single_with_progress(runtime, &root, &mut percents)
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
        seed_quick_start_models(&root);

        let mut seen = Vec::new();
        let ids = download_ready_batch(&root, &mut seen)
            .await
            .expect("batch quick-start with ready files");

        assert_eq!(ids, QUICK_START_MODEL_IDS.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert_eq!(seen, ids);
        assert_quick_start_models_ready(&root);
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
        let path = download_xsmall_with_progress(runtime, &root, &mut last_percent, &mut events)
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
        let ids = download_mixed_batch(&root, runtime_xsmall.id, &mut completed)
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

    #[test]
    fn classify_archive_model_status_reports_missing_when_not_extracted() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-archive-status-missing-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let entry = classify_archive_model_status(&root, &INPUT_LM_ARCHIVE_SPEC);
        assert_eq!(entry.model_id, "input-n5-lm-v1");
        assert_eq!(entry.status, "missing");
        assert!(entry.installed_bytes.is_none());
        assert_eq!(entry.expected_bytes, INPUT_LM_ARCHIVE_SPEC.expected_bytes);
        assert!(entry.last_error.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn classify_archive_model_status_reports_ready_when_all_files_present() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-archive-status-ready-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let extract_dir = archive_extract_dir(&root, &INPUT_LM_ARCHIVE_SPEC);
        std::fs::create_dir_all(&extract_dir).unwrap();
        INPUT_LM_ARCHIVE_SPEC
            .expected_files
            .iter()
            .for_each(|file| drop(std::fs::write(extract_dir.join(file), b"present")));

        let entry = classify_archive_model_status(&root, &INPUT_LM_ARCHIVE_SPEC);
        assert_eq!(entry.model_id, "input-n5-lm-v1");
        assert_eq!(entry.status, "ready");
        assert_eq!(entry.installed_bytes, Some(INPUT_LM_ARCHIVE_SPEC.expected_bytes));
        assert_eq!(entry.expected_bytes, INPUT_LM_ARCHIVE_SPEC.expected_bytes);
        assert!(entry.last_error.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn download_and_extract_archive_model_returns_cancelled_when_cancel_flag_set() {
        // When the cancel flag is already set before the download starts, the
        // function must return a cancellation error without attempting a
        // network request. The already-extracted check runs first, so we use
        // an empty cache root (nothing extracted).
        let root = std::env::temp_dir().join(format!(
            "kotoba-archive-cancel-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let result = download_and_extract_pre_cancelled(&root).await;
        assert!(result.is_err(), "pre-cancelled download must return an error");
        let err = result.unwrap_err();
        assert!(err.contains("cancelled"), "error should mention cancellation: {err}");

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

        let download =
            tokio::spawn(download_with_progress_channel(runtime, root.clone(), progress_tx));

        // Wait until the download has registered and emitted at least one progress tick,
        // or until the whole request finishes (very fast networks / cached CDN).
        let saw_progress =
            tokio::time::timeout(std::time::Duration::from_secs(30), progress_rx.recv())
                .await
                .ok()
                .flatten()
                .is_some();

        // Finished before we could cancel — still prove the success path ran.
        assert_download_outcome(download, saw_progress, &model_id, &root, runtime).await;

        let destination = model_path(&root, runtime);
        let partial = std::path::PathBuf::from(format!("{}.partial", destination.display()));
        assert!(!partial.exists(), "partial file should be cleaned up after cancel or completion");
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- Archive model tests -------------------------------------------------

    /// Helper: create a small ZIP at `path` containing the given (name, content) entries.
    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    /// Helper: SHA-256 of a byte slice, returned as lowercase hex.
    fn sha256_hex(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex::encode(hasher.finalize())
    }

    #[test]
    fn safe_extract_path_rejects_parent_directory_traversal() {
        let dest = Path::new("/tmp/dest");
        assert!(safe_extract_path("../../etc/passwd", dest).is_err());
        assert!(safe_extract_path("foo/../../bar", dest).is_err());
        assert!(safe_extract_path("..", dest).is_err());
        assert!(safe_extract_path("foo/../bar", dest).is_err());
    }

    #[test]
    fn safe_extract_path_rejects_absolute_paths() {
        let dest = Path::new("/tmp/dest");
        assert!(safe_extract_path("/etc/passwd", dest).is_err());
        assert!(safe_extract_path("/foo/bar", dest).is_err());
    }

    #[test]
    fn safe_extract_path_rejects_backslash_traversal_on_unix() {
        let dest = Path::new("/tmp/dest");
        // A malicious archive might use backslashes to try to bypass the `..`
        // component check on Unix. After normalizing `\` → `/` this must still
        // be rejected.
        assert!(safe_extract_path("..\\..\\etc\\passwd", dest).is_err());
        assert!(safe_extract_path("foo\\..\\bar", dest).is_err());
    }

    #[test]
    fn safe_extract_path_accepts_normal_relative_paths() {
        let dest = Path::new("/tmp/dest");
        let resolved = safe_extract_path("lm_c_abc.marisa", dest).unwrap();
        assert_eq!(resolved, Path::new("/tmp/dest/lm_c_abc.marisa"));

        let resolved = safe_extract_path("subdir/lm_c_abc.marisa", dest).unwrap();
        assert_eq!(resolved, Path::new("/tmp/dest/subdir/lm_c_abc.marisa"));

        // A single `.` component is harmless.
        let resolved = safe_extract_path("./lm_c_abc.marisa", dest).unwrap();
        assert_eq!(resolved, Path::new("/tmp/dest/lm_c_abc.marisa"));
    }

    #[test]
    fn extract_zip_safe_rejects_archive_with_traversal_entry() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-zip-slip-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let zip_path = root.join("malicious.zip");
        let dest = root.join("extract");

        std::fs::create_dir_all(&root).unwrap();
        // Craft a ZIP with a path-traversal entry name.
        write_test_zip(&zip_path, &[("../../escaped.txt", b"pwned")]);

        let result = extract_zip_safe(&zip_path, &dest);
        assert!(result.is_err(), "extraction must reject a path-traversal entry");
        let err = result.unwrap_err();
        assert!(
            err.contains("parent directory") || err.contains("absolute"),
            "error should describe the traversal rejection: {err}"
        );

        // The escaped file must NOT have been created.
        assert!(
            !root.join("escaped.txt").exists(),
            "Zip Slip must not create files outside dest_dir"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_zip_safe_extracts_valid_archive_with_expected_files() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-zip-happy-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let zip_path = root.join("model.zip");
        let dest = root.join("extract");

        std::fs::create_dir_all(&root).unwrap();
        // Build a small ZIP with the same file names the real model uses.
        let entries: &[(&str, &[u8])] = &[
            ("lm_c_abc.marisa", b"c_abc tries"),
            ("lm_c_bc.marisa", b"c_bc tries"),
            ("lm_u_abx.marisa", b"u_abx tries"),
            ("lm_u_xbc.marisa", b"u_xbc tries"),
            ("lm_r_xbx.marisa", b"r_xbx tries"),
        ];
        write_test_zip(&zip_path, entries);

        extract_zip_safe(&zip_path, &dest).expect("valid archive should extract");

        // Every file from the archive must be present with its content.
        for (name, content) in entries {
            let extracted = std::fs::read(dest.join(name)).unwrap();
            assert_eq!(extracted, *content, "extracted content must match for {name}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn verify_sha256_accepts_correct_hash() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-sha-ok-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file_path = root.join("data.bin");
        let data = b"hello input-LM world";
        std::fs::write(&file_path, data).unwrap();

        let expected = sha256_hex(data);
        verify_sha256(&file_path, &expected).expect("correct SHA-256 should pass");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn verify_sha256_rejects_checksum_mismatch() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-sha-mismatch-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file_path = root.join("data.bin");
        std::fs::write(&file_path, b"actual content").unwrap();

        // A wrong expected hash — must be rejected.
        let wrong_hash = sha256_hex(b"different content");
        let result = verify_sha256(&file_path, &wrong_hash);
        assert!(result.is_err(), "SHA-256 mismatch must be rejected");
        let err = result.unwrap_err();
        assert!(err.contains("mismatch"), "error should mention mismatch: {err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn verify_sha256_rejects_missing_file() {
        let result = verify_sha256(Path::new("/nonexistent/file.bin"), "deadbeef");
        assert!(result.is_err(), "missing file must be rejected");
    }

    #[tokio::test]
    async fn download_and_extract_archive_model_skips_when_already_extracted() {
        // When all expected files are already present, the function must
        // return immediately without attempting a network download.
        let root = std::env::temp_dir().join(format!(
            "kotoba-already-extracted-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let extract_dir = archive_extract_dir(&root, &INPUT_LM_ARCHIVE_SPEC);
        std::fs::create_dir_all(&extract_dir).unwrap();
        INPUT_LM_ARCHIVE_SPEC
            .expected_files
            .iter()
            .for_each(|file| drop(std::fs::write(extract_dir.join(file), b"present")));

        // This must NOT attempt a download (which would fail without network
        // or with a wrong URL). It should return Ok immediately.
        let mut progress_seen = false;
        let result = download_and_extract_checking_progress(&root, &mut progress_seen).await;
        assert!(result.is_ok(), "already-extracted model should return Ok without download");
        assert_eq!(result.unwrap(), extract_dir);
        assert!(!progress_seen, "already-extracted model must not emit progress events");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn input_lm_archive_spec_has_nonzero_expected_bytes_and_sha256() {
        const _: () = {
            assert!(INPUT_LM_ARCHIVE_SPEC.expected_bytes > 100_000_000);
            assert!(INPUT_LM_ARCHIVE_SPEC.expected_sha256.len() == 64);
        };
        let sha = INPUT_LM_ARCHIVE_SPEC.expected_sha256;
        let is_hex = sha.chars().all(|c| c.is_ascii_hexdigit());
        assert!(is_hex, "SHA-256 must be lowercase hex: {sha}");
    }
}
