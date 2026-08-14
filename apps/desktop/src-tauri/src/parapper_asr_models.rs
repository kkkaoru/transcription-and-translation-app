//! Parapper ASR model install status for the desktop Debug / model panels.
//!
//! The sidecar downloads these into `<appData>/parapper/models/`. Catalog URLs
//! must stay aligned with `packages/parapper-asr/src-tauri/src/model/catalog.rs`.

use crate::config::STREAMING_INTERIM_ASR_MODEL_ID;
use crate::model_download::ModelStatusEntry;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub struct ParapperAsrModelSpec {
    pub id: &'static str,
    pub role: &'static str,
    pub label: &'static str,
    pub dir_name: &'static str,
    pub source_url: &'static str,
    pub required_files: &'static [&'static str],
}

pub const REAZONSPEECH_K2_V2: ParapperAsrModelSpec = ParapperAsrModelSpec {
    id: "reazonspeech_k2_v2",
    role: "completion",
    label: "ReazonSpeech K2 v2 (completion)",
    dir_name: "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01",
    source_url: "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/main",
    required_files: &[
        "encoder-epoch-99-avg-1.int8.onnx",
        "decoder-epoch-99-avg-1.onnx",
        "joiner-epoch-99-avg-1.int8.onnx",
        "tokens.txt",
    ],
};

pub const NEMOTRON_35_160MS: ParapperAsrModelSpec = ParapperAsrModelSpec {
    id: STREAMING_INTERIM_ASR_MODEL_ID,
    role: "interim",
    label: "Nemotron 3.5 ASR Streaming 160ms int8 (interim)",
    dir_name: "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11",
    source_url: concat!(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/",
        "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11.tar.bz2"
    ),
    required_files: &["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
};

pub fn required_parapper_asr_models(
    streaming_interim_asr_enabled: bool,
) -> Vec<ParapperAsrModelSpec> {
    if streaming_interim_asr_enabled {
        vec![REAZONSPEECH_K2_V2, NEMOTRON_35_160MS]
    } else {
        vec![REAZONSPEECH_K2_V2]
    }
}

pub fn parapper_models_root(parapper_runtime_dir: &Path) -> PathBuf {
    parapper_runtime_dir.join("models")
}

/// Append `.<marker>` without `Path::with_extension`, which truncates multi-dot
/// Nemotron directory names after the final dotted segment.
fn path_with_marker_suffix(path: &Path, marker: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(".");
    os.push(marker);
    PathBuf::from(os)
}

pub fn classify_parapper_asr_model(
    models_root: &Path,
    spec: &ParapperAsrModelSpec,
) -> ModelStatusEntry {
    let local_path = models_root.join(spec.dir_name);
    let download_marker = path_with_marker_suffix(&local_path, "download");
    let extracting_marker = path_with_marker_suffix(&local_path, "extracting");

    if required_files_present(&local_path, spec.required_files) {
        let installed_bytes = directory_byte_size(&local_path);
        return ModelStatusEntry {
            model_id: spec.id.to_string(),
            status: "ready".to_string(),
            installed_bytes,
            expected_bytes: installed_bytes.unwrap_or(0),
            last_error: None,
            source_url: Some(spec.source_url.to_string()),
            local_path: Some(local_path.display().to_string()),
            role: Some(spec.role.to_string()),
            label: Some(spec.label.to_string()),
        };
    }

    if download_marker.is_file() || extracting_marker.is_dir() {
        let installed_bytes = std::fs::metadata(&download_marker).ok().map(|meta| meta.len());
        return ModelStatusEntry {
            model_id: spec.id.to_string(),
            status: "downloading".to_string(),
            installed_bytes,
            expected_bytes: 0,
            last_error: None,
            source_url: Some(spec.source_url.to_string()),
            local_path: Some(local_path.display().to_string()),
            role: Some(spec.role.to_string()),
            label: Some(spec.label.to_string()),
        };
    }

    if local_path.is_dir() {
        let installed_bytes = directory_byte_size(&local_path);
        return ModelStatusEntry {
            model_id: spec.id.to_string(),
            status: "partial".to_string(),
            installed_bytes,
            expected_bytes: 0,
            last_error: Some("required ASR files are incomplete".to_string()),
            source_url: Some(spec.source_url.to_string()),
            local_path: Some(local_path.display().to_string()),
            role: Some(spec.role.to_string()),
            label: Some(spec.label.to_string()),
        };
    }

    ModelStatusEntry {
        model_id: spec.id.to_string(),
        status: "missing".to_string(),
        installed_bytes: None,
        expected_bytes: 0,
        last_error: None,
        source_url: Some(spec.source_url.to_string()),
        local_path: Some(local_path.display().to_string()),
        role: Some(spec.role.to_string()),
        label: Some(spec.label.to_string()),
    }
}

pub fn list_parapper_asr_model_status(
    parapper_runtime_dir: &Path,
    streaming_interim_asr_enabled: bool,
) -> Vec<ModelStatusEntry> {
    let models_root = parapper_models_root(parapper_runtime_dir);
    required_parapper_asr_models(streaming_interim_asr_enabled)
        .iter()
        .map(|spec| classify_parapper_asr_model(&models_root, spec))
        .collect()
}

fn required_files_present(model_dir: &Path, required_files: &[&str]) -> bool {
    required_files.iter().all(|file| model_dir.join(file).is_file())
}

fn directory_byte_size(path: &Path) -> Option<u64> {
    let entries = std::fs::read_dir(path).ok()?;
    let mut total = 0_u64;
    for entry in entries.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kotoba-parapper-asr-{}-{}-{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    #[test]
    fn nemotron_source_url_points_at_sherpa_onnx_github_release() {
        assert!(NEMOTRON_35_160MS
            .source_url
            .starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"));
        assert!(NEMOTRON_35_160MS.source_url.ends_with(".tar.bz2"));
        assert_eq!(NEMOTRON_35_160MS.id, STREAMING_INTERIM_ASR_MODEL_ID);
    }

    #[test]
    fn classify_reports_missing_with_download_url_and_local_path() {
        let root = temp_root("missing");
        let models = root.join("models");
        fs::create_dir_all(&models).unwrap();

        let entry = classify_parapper_asr_model(&models, &NEMOTRON_35_160MS);
        assert_eq!(entry.status, "missing");
        assert_eq!(entry.source_url.as_deref(), Some(NEMOTRON_35_160MS.source_url));
        assert!(entry.local_path.as_ref().unwrap().ends_with(NEMOTRON_35_160MS.dir_name));
        assert_eq!(entry.role.as_deref(), Some("interim"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn classify_reports_ready_when_required_files_exist() {
        let root = temp_root("ready");
        let models = root.join("models");
        let model_dir = models.join(REAZONSPEECH_K2_V2.dir_name);
        fs::create_dir_all(&model_dir).unwrap();
        for file in REAZONSPEECH_K2_V2.required_files {
            fs::write(model_dir.join(file), b"ok").unwrap();
        }

        let entry = classify_parapper_asr_model(&models, &REAZONSPEECH_K2_V2);
        assert_eq!(entry.status, "ready");
        assert_eq!(entry.role.as_deref(), Some("completion"));
        assert!(entry.installed_bytes.unwrap() > 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn classify_reports_downloading_when_archive_marker_exists() {
        let root = temp_root("downloading");
        let models = root.join("models");
        fs::create_dir_all(&models).unwrap();
        let marker = path_with_marker_suffix(&models.join(NEMOTRON_35_160MS.dir_name), "download");
        assert!(
            marker
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("-2026-06-11.download")),
            "marker must keep the full multi-dot directory name: {}",
            marker.display()
        );
        fs::write(&marker, vec![0_u8; 32]).unwrap();

        let entry = classify_parapper_asr_model(&models, &NEMOTRON_35_160MS);
        assert_eq!(entry.status, "downloading");
        assert_eq!(entry.installed_bytes, Some(32));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_includes_nemotron_only_when_streaming_interim_enabled() {
        let root = temp_root("list");
        let enabled = list_parapper_asr_model_status(&root, true);
        assert_eq!(
            enabled.iter().map(|entry| entry.model_id.as_str()).collect::<Vec<_>>(),
            vec![REAZONSPEECH_K2_V2.id, NEMOTRON_35_160MS.id]
        );
        let disabled = list_parapper_asr_model_status(&root, false);
        assert_eq!(
            disabled.iter().map(|entry| entry.model_id.as_str()).collect::<Vec<_>>(),
            vec![REAZONSPEECH_K2_V2.id]
        );
        let _ = fs::remove_dir_all(&root);
    }
}
