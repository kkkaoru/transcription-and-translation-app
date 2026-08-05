use crate::config::AppConfig;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelServer {
    Zenz,
    Llama,
}

impl ModelServer {
    pub fn sidecar_name(self) -> &'static str {
        match self {
            Self::Zenz => "kotoba-zenz-server",
            Self::Llama => "kotoba-llama-server",
        }
    }
}

/// Immutable distribution metadata for a model fetched by Kotoba Beacon.
/// The exact Hugging Face revision and expected byte count prevent an upstream
/// branch update from silently changing a distributed runtime dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelRuntimeSpec {
    pub id: &'static str,
    pub server: ModelServer,
    pub hf_repo: &'static str,
    pub hf_revision: &'static str,
    pub hf_file: &'static str,
    pub expected_bytes: u64,
    pub port: u16,
}

pub const MODEL_RUNTIME_SPECS: &[ModelRuntimeSpec] = &[
    ModelRuntimeSpec {
        id: "zenz-v3.2-xsmall-gguf",
        server: ModelServer::Zenz,
        hf_repo: "Miwa-Keita/zenz-v3.2-xsmall-gguf",
        hf_revision: "4f5423f0fad41a73b1242eb96fe5c12ae4fdca83",
        hf_file: "ggml-model-Q5_K_M.gguf",
        expected_bytes: 20_970_304,
        port: 8081,
    },
    ModelRuntimeSpec {
        id: "zenz-v3.2-small-gguf",
        server: ModelServer::Zenz,
        hf_repo: "Miwa-Keita/zenz-v3.2-small-gguf",
        hf_revision: "c67e03e07d215c869f591b274c1631170d3e11fe",
        hf_file: "ggml-model-Q5_K_M.gguf",
        expected_bytes: 73_871_936,
        port: 8082,
    },
    ModelRuntimeSpec {
        id: "hy-mt2-1.8b-gguf",
        server: ModelServer::Llama,
        hf_repo: "tencent/Hy-MT2-1.8B-GGUF",
        hf_revision: "1cd5208700acedef4ef93019b6cfc148b8522d45",
        hf_file: "Hy-MT2-1.8B-Q4_K_M.gguf",
        expected_bytes: 1_133_080_448,
        port: 8083,
    },
    ModelRuntimeSpec {
        id: "hy-mt2-1.8b-2bit-gguf",
        server: ModelServer::Llama,
        hf_repo: "tencent/Hy-MT2-1.8B-2Bit-GGUF",
        hf_revision: "b630487d19ab7f336664a15b07c638d0d1071471",
        hf_file: "Hy-MT2-1.8B-2Bit.gguf",
        expected_bytes: 600_534_880,
        port: 8084,
    },
    ModelRuntimeSpec {
        id: "hy-mt2-1.8b-1.25bit-gguf",
        server: ModelServer::Llama,
        hf_repo: "tencent/Hy-MT2-1.8B-1.25Bit-GGUF",
        hf_revision: "9df5c824a00a744fb0512a29c640466f4d97dfb0",
        hf_file: "Hy-MT2-1.8B-1.25Bit.gguf",
        expected_bytes: 461_860_800,
        port: 8085,
    },
    ModelRuntimeSpec {
        id: "hy-mt2-7b-gguf",
        server: ModelServer::Llama,
        hf_repo: "tencent/Hy-MT2-7B-GGUF",
        hf_revision: "ab8472660ac61fac25f1af43fac2599d52a8a775",
        hf_file: "Hy-MT2-7B-Q4_K_M.gguf",
        expected_bytes: 4_624_648_896,
        port: 8086,
    },
    ModelRuntimeSpec {
        id: "zenz-v2-q5-k-m-gguf",
        server: ModelServer::Zenz,
        hf_repo: "Miwa-Keita/zenz-v2-gguf",
        hf_revision: "a4b653da54904aa8a5dfbf9e7428b1f0c6b2e50e",
        hf_file: "zenz-v2-Q5_K_M.gguf",
        expected_bytes: 72_298_816,
        port: 8087,
    },
];

pub fn spec(id: &str) -> Option<&'static ModelRuntimeSpec> {
    MODEL_RUNTIME_SPECS.iter().find(|spec| spec.id == id)
}

pub fn all_specs() -> &'static [ModelRuntimeSpec] {
    MODEL_RUNTIME_SPECS
}

pub fn model_runtime_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data directory: {e}"))
        .map(|p| p.join("models"))
}

pub fn selected_specs(config: &AppConfig) -> Result<Vec<&'static ModelRuntimeSpec>, String> {
    if config.endpoint.mode == "remote" {
        return Ok(Vec::new());
    }

    let mut selected = Vec::with_capacity(2);
    if config.models.normalizer != "azookey-rust" {
        selected.push(spec(&config.models.normalizer).ok_or_else(|| {
            format!("no bundled model runtime is available for {}", config.models.normalizer)
        })?);
    }
    let translator = spec(&config.models.translator).ok_or_else(|| {
        format!("no bundled model runtime is available for {}", config.models.translator)
    })?;
    if !selected.iter().any(|selected_spec| selected_spec.id == translator.id) {
        selected.push(translator);
    }
    Ok(selected)
}

pub fn model_path(models_dir: &Path, spec: &ModelRuntimeSpec) -> PathBuf {
    models_dir.join(spec.id).join(spec.hf_file)
}

pub fn download_url(spec: &ModelRuntimeSpec) -> String {
    format!(
        "https://huggingface.co/{}/resolve/{}/{}?download=true",
        spec.hf_repo, spec.hf_revision, spec.hf_file
    )
}

pub fn sidecar_arguments(spec: &ModelRuntimeSpec, model_path: &Path) -> Vec<String> {
    // Live captions only need short prompts. Cap context so llama-server does not
    // allocate multi-hundred-k KV from the model's train context (which delayed
    // /health readiness on this machine with n_ctx_slot ≈ 262144).
    vec![
        "--model".to_string(),
        model_path.to_string_lossy().into_owned(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        spec.port.to_string(),
        "--alias".to_string(),
        spec.id.to_string(),
        "--jinja".to_string(),
        "--ctx-size".to_string(),
        "4096".to_string(),
        "--parallel".to_string(),
        "1".to_string(),
    ]
}

pub async fn ensure_downloaded(
    spec: &ModelRuntimeSpec,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    let destination = model_path(models_dir, spec);
    if matches!(tokio::fs::metadata(&destination).await, Ok(metadata) if metadata.len() == spec.expected_bytes)
    {
        return Ok(destination);
    }
    if tokio::fs::try_exists(&destination).await.unwrap_or(false) {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|error| format!("could not replace incomplete model {}: {error}", spec.id))?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("could not determine model storage directory for {}", spec.id))?;
    tokio::fs::create_dir_all(parent).await.map_err(|error| {
        format!("could not create model storage directory for {}: {error}", spec.id)
    })?;

    let partial = PathBuf::from(format!("{}.partial", destination.display()));
    if tokio::fs::try_exists(&partial).await.unwrap_or(false) {
        tokio::fs::remove_file(&partial).await.map_err(|error| {
            format!("could not clear incomplete download for {}: {error}", spec.id)
        })?;
    }

    let response = reqwest::Client::new()
        .get(download_url(spec))
        .send()
        .await
        .map_err(|error| format!("could not download model {}: {error}", spec.id))?
        .error_for_status()
        .map_err(|error| format!("model download failed for {}: {error}", spec.id))?;
    if let Some(content_length) = response.content_length() {
        if content_length != spec.expected_bytes {
            return Err(format!(
                "model download size for {} is {content_length} bytes, expected {} bytes",
                spec.id, spec.expected_bytes
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
        .map_err(|error| format!("could not create model download for {}: {error}", spec.id))?;
    let mut response = response;
    let mut downloaded = 0_u64;
    let mut next_log = 64 * 1024 * 1024;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("model download interrupted for {}: {error}", spec.id))?
    {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > spec.expected_bytes {
            return Err(format!("model download exceeded the expected size for {}", spec.id));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("could not write model download for {}: {error}", spec.id))?;
        if downloaded >= next_log {
            log::info!(
                target: "kotoba_model_download",
                "downloaded {} / {} MiB for {}",
                downloaded / (1024 * 1024),
                spec.expected_bytes / (1024 * 1024),
                spec.id
            );
            next_log = next_log.saturating_add(64 * 1024 * 1024);
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("could not finish model download for {}: {error}", spec.id))?;
    drop(file);
    if downloaded != spec.expected_bytes {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "model download size for {} is {downloaded} bytes, expected {} bytes",
            spec.id, spec.expected_bytes
        ));
    }
    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|error| format!("could not install downloaded model {}: {error}", spec.id))?;
    log::info!(target: "kotoba_model_download", "downloaded model {}", spec.id);
    Ok(destination)
}

pub fn gateway_routes() -> Value {
    let models = MODEL_RUNTIME_SPECS
        .iter()
        .map(|spec| {
            (
                spec.id.to_string(),
                serde_json::json!({
                    "baseUrl": format!("http://127.0.0.1:{}", spec.port),
                    "servedModel": spec.id,
                }),
            )
        })
        .collect::<Map<String, Value>>();
    Value::Object(models)
}

/// Distribution metadata for a multi-file archive model.
///
/// Unlike [`ModelRuntimeSpec`] (a single GGUF file fetched for a sidecar
/// server), an `ArchiveModelSpec` describes a ZIP that is downloaded, SHA-256
/// verified, and Zip-Slip-safe extracted to a cache directory. The existing
/// single-file GGUF download path is untouched — this struct is an additive
/// parallel path for archive models such as the input-LM N-gram tries.
//
// Not yet wired into a Tauri command (that requires editing lib.rs).
// Tested and ready; remove `allow(dead_code)` once registered.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveModelSpec {
    /// Short stable identifier (used in logs and status keys).
    pub id: &'static str,
    pub hf_repo: &'static str,
    /// Pinned Hugging Face revision (commit SHA).
    pub hf_revision: &'static str,
    /// File name within the HF repo (must be a `.zip`).
    pub hf_file: &'static str,
    /// Expected byte count of the archive.
    pub expected_bytes: u64,
    /// Expected SHA-256 of the archive, lowercase hex.
    pub expected_sha256: &'static str,
    /// Subdirectory under the cache root where the archive is extracted.
    pub extract_subdir: &'static str,
    /// Files that must exist after extraction (relative to `extract_subdir`).
    pub expected_files: &'static [&'static str],
}

/// The input-LM N-gram model distributed as a 120 MB ZIP at
/// `Miwa-Keita/input_n5_lm_v1`. The four `.marisa` tries are loaded in-process
/// by [`crate::pipeline::Pipeline`] via `caption_bridge_input_lm::marisa::open_model`.
/// When the archive is absent or extraction fails, the pipeline stays
/// fail-open: `open_model` returns an error and the rescorer falls back to the
/// original ASR reading (see `Pipeline::rescore_reading`).
#[allow(dead_code)]
pub const INPUT_LM_ARCHIVE_SPEC: ArchiveModelSpec = ArchiveModelSpec {
    id: "input-n5-lm-v1",
    hf_repo: "Miwa-Keita/input_n5_lm_v1",
    hf_revision: "6153c4693ee202049b6cb834396e658562c147b3",
    hf_file: "input_n5_lm_v1.zip",
    expected_bytes: 120_372_659,
    expected_sha256: "0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a",
    extract_subdir: "input_n5_lm_v1",
    expected_files: &["lm_c_abc.marisa", "lm_u_abx.marisa", "lm_u_xbc.marisa", "lm_r_xbx.marisa"],
};

/// Hugging Face resolve URL for an archive model, pinned to `spec.hf_revision`.
#[allow(dead_code)]
pub fn archive_download_url(spec: &ArchiveModelSpec) -> String {
    format!(
        "https://huggingface.co/{}/resolve/{}/{}?download=true",
        spec.hf_repo, spec.hf_revision, spec.hf_file
    )
}

/// Default cache root for the input-LM model: `$HOME/.cache/caption-bridge-input-lm`.
/// Matches the path used by `Pipeline::default_model_path` so the extracted
/// files land exactly where `open_model` expects them.
#[allow(dead_code)]
pub fn input_lm_cache_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".cache").join("caption-bridge-input-lm")
}

/// Directory where `spec` is extracted under `cache_root`.
#[allow(dead_code)]
pub fn archive_extract_dir(cache_root: &Path, spec: &ArchiveModelSpec) -> PathBuf {
    cache_root.join(spec.extract_subdir)
}

/// Model path stem for `open_model` (e.g. `.../input_n5_lm_v1/lm`). The `.marisa`
/// suffix is appended by `open_model` per-trie.
#[allow(dead_code)]
pub fn archive_model_path(cache_root: &Path, spec: &ArchiveModelSpec) -> PathBuf {
    archive_extract_dir(cache_root, spec).join("lm")
}

/// Returns `true` when every file in `spec.expected_files` exists under `extract_dir`.
#[allow(dead_code)]
pub fn archive_model_extracted(extract_dir: &Path, spec: &ArchiveModelSpec) -> bool {
    spec.expected_files.iter().all(|file| extract_dir.join(file).is_file())
}

#[cfg(test)]
mod tests {
    use super::{
        archive_download_url, archive_extract_dir, archive_model_extracted, archive_model_path,
        download_url, ensure_downloaded, gateway_routes, input_lm_cache_root, model_path,
        selected_specs, sidecar_arguments, spec, ModelServer, INPUT_LM_ARCHIVE_SPEC,
    };
    use crate::config::AppConfig;
    use std::path::Path;

    #[test]
    fn default_local_configuration_starts_only_the_translator() {
        let config = AppConfig::default();
        let selected = selected_specs(&config).expect("default config should be supported");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "hy-mt2-1.8b-gguf");
    }

    #[test]
    fn selecting_a_zenz_model_adds_its_server() {
        let mut config = AppConfig::default();
        config.models.normalizer = "zenz-v3.2-small-gguf".to_string();
        let selected = selected_specs(&config).expect("zenz should have a bundled runtime");
        assert_eq!(
            selected.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            ["zenz-v3.2-small-gguf", "hy-mt2-1.8b-gguf",]
        );
    }

    #[test]
    fn remote_endpoint_does_not_start_local_model_servers() {
        let mut config = AppConfig::default();
        config.endpoint.mode = "remote".to_string();
        assert!(selected_specs(&config).expect("remote config should be valid").is_empty());
    }

    #[test]
    fn every_catalogued_runtime_has_a_loopback_gateway_route() {
        let routes = gateway_routes();
        assert_eq!(routes.as_object().expect("route map").len(), 7);
        assert_eq!(routes["hy-mt2-7b-gguf"]["baseUrl"], "http://127.0.0.1:8086");
    }

    #[test]
    fn arguments_only_load_from_the_writable_model_directory() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("known spec");
        let path = model_path(Path::new("/tmp/kotoba-models"), runtime);
        let arguments = sidecar_arguments(runtime, &path);
        assert_eq!(
            arguments[0..2],
            ["--model", "/tmp/kotoba-models/zenz-v3.2-xsmall-gguf/ggml-model-Q5_K_M.gguf"]
        );
        assert!(!arguments.iter().any(|argument| argument == "--hf-repo"));
        assert!(arguments.windows(2).any(|pair| pair == ["--ctx-size", "4096"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--parallel", "1"]));
    }

    #[test]
    fn zenz_uses_the_azookey_server_and_hy_uses_upstream_llama() {
        assert_eq!(spec("zenz-v3.2-small-gguf").expect("zenz").server, ModelServer::Zenz);
        assert_eq!(spec("hy-mt2-1.8b-gguf").expect("hy").server, ModelServer::Llama);
    }

    #[test]
    fn download_urls_are_pinned_to_reviewed_model_revisions() {
        let runtime = spec("hy-mt2-1.8b-gguf").expect("known spec");
        assert_eq!(
            download_url(runtime),
            "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/1cd5208700acedef4ef93019b6cfc148b8522d45/Hy-MT2-1.8B-Q4_K_M.gguf?download=true"
        );
    }

    #[tokio::test]
    #[ignore = "downloads a model from Hugging Face; run explicitly before a release"]
    async fn downloads_the_pinned_xsmall_model_into_app_data_layout() {
        let runtime = spec("zenz-v3.2-xsmall-gguf").expect("known test runtime");
        let models_dir = std::env::temp_dir()
            .join(format!("kotoba-model-runtime-download-{}", uuid::Uuid::new_v4()));

        let downloaded = ensure_downloaded(runtime, &models_dir)
            .await
            .expect("pinned xsmall model should download");
        assert_eq!(downloaded, model_path(&models_dir, runtime));
        assert_eq!(
            tokio::fs::metadata(&downloaded).await.expect("downloaded model metadata").len(),
            runtime.expected_bytes
        );

        tokio::fs::remove_dir_all(&models_dir).await.expect("remove downloaded test model");
    }

    #[test]
    fn archive_download_url_is_pinned_to_the_reviewed_revision() {
        assert_eq!(
            archive_download_url(&INPUT_LM_ARCHIVE_SPEC),
            "https://huggingface.co/Miwa-Keita/input_n5_lm_v1/resolve/6153c4693ee202049b6cb834396e658562c147b3/input_n5_lm_v1.zip?download=true"
        );
    }

    #[test]
    fn archive_spec_lists_the_four_tries_open_model_loads() {
        // `open_model` reads exactly these four tries (see TRIE_SUFFIXES in
        // caption-bridge-input-lm). The spec must list all of them so the
        // post-extraction verification catches an incomplete archive.
        assert_eq!(
            INPUT_LM_ARCHIVE_SPEC.expected_files,
            &["lm_c_abc.marisa", "lm_u_abx.marisa", "lm_u_xbc.marisa", "lm_r_xbx.marisa"]
        );
    }

    #[test]
    fn archive_paths_resolve_under_the_cache_root() {
        let root = Path::new("/tmp/kotoba-test-cache");
        assert_eq!(
            archive_extract_dir(root, &INPUT_LM_ARCHIVE_SPEC),
            Path::new("/tmp/kotoba-test-cache/input_n5_lm_v1")
        );
        assert_eq!(
            archive_model_path(root, &INPUT_LM_ARCHIVE_SPEC),
            Path::new("/tmp/kotoba-test-cache/input_n5_lm_v1/lm")
        );
    }

    #[test]
    fn archive_model_extracted_is_true_only_when_every_expected_file_exists() {
        let root = std::env::temp_dir().join(format!(
            "kotoba-archive-extracted-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let extract_dir = archive_extract_dir(&root, &INPUT_LM_ARCHIVE_SPEC);
        std::fs::create_dir_all(&extract_dir).unwrap();

        assert!(
            !archive_model_extracted(&extract_dir, &INPUT_LM_ARCHIVE_SPEC),
            "empty directory must not count as extracted"
        );

        // Add files one by one — only the last one should flip to true.
        let total = INPUT_LM_ARCHIVE_SPEC.expected_files.len();
        for (i, file) in INPUT_LM_ARCHIVE_SPEC.expected_files.iter().enumerate() {
            std::fs::write(extract_dir.join(file), b"dummy").unwrap();
            assert_eq!(
                archive_model_extracted(&extract_dir, &INPUT_LM_ARCHIVE_SPEC),
                i + 1 == total,
                "extraction check must be false until every expected file is present"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn input_lm_cache_root_matches_pipeline_default_model_path() {
        // The cache root + extract_subdir + "lm" must equal the path that
        // Pipeline::default_model_path() returns, so the downloaded files
        // land exactly where open_model expects them.
        let root = input_lm_cache_root();
        let model_stem = archive_model_path(&root, &INPUT_LM_ARCHIVE_SPEC);
        assert!(
            model_stem.ends_with(std::path::Path::new(
                ".cache/caption-bridge-input-lm/input_n5_lm_v1/lm"
            )),
            "model stem must match the pipeline default: {}",
            model_stem.display()
        );
    }
}
