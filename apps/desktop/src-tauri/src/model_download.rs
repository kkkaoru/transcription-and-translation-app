use crate::model_runtime::{download_url, model_path, spec, ModelRuntimeSpec};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatusEntry {
    pub model_id: String,
    pub status: String,
    pub installed_bytes: Option<u64>,
    pub expected_bytes: u64,
    pub last_error: Option<String>,
}

pub async fn download_model_with_progress(
    app: &AppHandle,
    spec: &ModelRuntimeSpec,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    let destination = model_path(models_dir, spec);
    if matches!(tokio::fs::metadata(&destination).await, Ok(m) if m.len() == spec.expected_bytes) {
        return Ok(destination);
    }
    if tokio::fs::try_exists(&destination).await.unwrap_or(false) {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|e| format!("could not replace incomplete model {}: {e}", spec.id))?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("could not determine storage directory for {}", spec.id))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("could not create storage directory for {}: {e}", spec.id))?;

    let partial = PathBuf::from(format!("{}.partial", destination.display()));
    if tokio::fs::try_exists(&partial).await.unwrap_or(false) {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(|e| format!("could not clear incomplete download for {}: {e}", spec.id))?;
    }

    let response = reqwest::Client::new()
        .get(download_url(spec))
        .send()
        .await
        .map_err(|e| format!("could not download model {}: {e}", spec.id))?
        .error_for_status()
        .map_err(|e| format!("model download failed for {}: {e}", spec.id))?;

    if let Some(content_length) = response.content_length() {
        if content_length != spec.expected_bytes {
            return Err(format!(
                "download size for {} is {content_length}, expected {}",
                spec.id, spec.expected_bytes,
            ));
        }
    }

    log::info!(
        target: "kotoba_model_download",
        "downloading {} ({:.1} MiB)",
        spec.id,
        spec.expected_bytes as f64 / (1024.0 * 1024.0)
    );

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("could not create download for {}: {e}", spec.id))?;

    let start = std::time::Instant::now();
    let mut response = response;
    let mut downloaded: u64 = 0;
    let mut last_emit = start;

    while let Some(chunk) =
        response.chunk().await.map_err(|e| format!("download interrupted for {}: {e}", spec.id))?
    {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > spec.expected_bytes {
            return Err(format!("download exceeded expected size for {}", spec.id));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write download for {}: {e}", spec.id))?;

        let now = std::time::Instant::now();
        if now.duration_since(last_emit).as_millis() >= 250 {
            let elapsed = now.duration_since(start);
            let speed = if elapsed.as_secs() > 0 { downloaded / elapsed.as_secs() } else { 0 };
            let progress = DownloadProgress {
                model_id: spec.id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: spec.expected_bytes,
                percent: ((downloaded as f64 / spec.expected_bytes as f64) * 100.0).min(99.0) as u8,
                speed_bps: speed,
                elapsed_ms: elapsed.as_millis() as u64,
            };
            let _ = app.emit("model:download:progress", &progress);
            last_emit = now;
        }
    }

    file.flush().await.map_err(|e| format!("could not finish download for {}: {e}", spec.id))?;
    drop(file);

    if downloaded != spec.expected_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "downloaded {downloaded} bytes, expected {} for {}",
            spec.expected_bytes, spec.id,
        ));
    }

    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|e| format!("could not install model {}: {e}", spec.id))?;

    let elapsed = start.elapsed();
    app.emit(
        "model:download:progress",
        &DownloadProgress {
            model_id: spec.id.to_string(),
            downloaded_bytes: spec.expected_bytes,
            total_bytes: spec.expected_bytes,
            percent: 100,
            speed_bps: if elapsed.as_secs() > 0 {
                spec.expected_bytes / elapsed.as_secs()
            } else {
                0
            },
            elapsed_ms: elapsed.as_millis() as u64,
        },
    )
    .ok();

    log::info!(target: "kotoba_model_download", "downloaded model {}", spec.id);
    Ok(destination)
}

#[tauri::command]
pub async fn download_model(app: AppHandle, model_id: String) -> Result<String, String> {
    let spec = spec(&model_id).ok_or_else(|| format!("unknown model: {model_id}"))?;
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    download_model_with_progress(&app, spec, &models_dir).await?;
    Ok(model_id)
}

#[tauri::command]
pub async fn download_quick_start(app: AppHandle) -> Result<Vec<String>, String> {
    let ids = ["zenz-v3.2-xsmall-gguf", "hy-mt2-1.8b-gguf"];
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    let mut result = Vec::new();
    for id in ids {
        let spec = spec(id).ok_or_else(|| format!("unknown model: {id}"))?;
        download_model_with_progress(&app, spec, &models_dir).await?;
        result.push(id.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn list_model_status(app: AppHandle) -> Result<Vec<ModelStatusEntry>, String> {
    let models_dir = crate::model_runtime::model_runtime_dir(&app)?;
    let mut entries = Vec::new();
    for spec in crate::model_runtime::all_specs() {
        let path = model_path(&models_dir, spec);
        let (status, installed_bytes) = match tokio::fs::metadata(&path).await {
            Ok(m) if m.len() == spec.expected_bytes => ("ready".to_string(), Some(m.len())),
            Ok(m) => ("corrupt".to_string(), Some(m.len())),
            Err(_) => ("missing".to_string(), None),
        };
        entries.push(ModelStatusEntry {
            model_id: spec.id.to_string(),
            status,
            installed_bytes,
            expected_bytes: spec.expected_bytes,
            last_error: None,
        });
    }
    Ok(entries)
}
