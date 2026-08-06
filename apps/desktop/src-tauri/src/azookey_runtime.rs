//! Runtime provisioning for the public AzooKey system dictionary.
//!
//! The Rust converter ships a small fallback lexicon so the desktop binary can
//! start offline.  That lexicon is intentionally not a replacement for the
//! public LOUDS dictionary: without the latter, ordinary kana readings remain
//! hiragana and spoken numbers cannot be segmented.  The desktop app therefore
//! provisions the pinned public dictionary on the first capture, then passes
//! the resolved root through the normal AzooKey pipeline.  This keeps AzooKey
//! as the selected normalizer and avoids fixed, application-specific phrase
//! mappings.

use crate::config::AppConfig;
use flate2::read::GzDecoder;
use std::{
    env,
    io::Cursor,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// A pinned upstream revision makes a build reproducible and prevents a branch
/// update from silently changing captions between app launches.
const DICTIONARY_REVISION: &str = "4d418525b090cf49c219819d05a7e3cc2a4346eb";
const DICTIONARY_ARCHIVE_URL: &str = "https://codeload.github.com/AzooKey/azooKey_dictionary_storage/tar.gz/4d418525b090cf49c219819d05a7e3cc2a4346eb";
const DICTIONARY_STORAGE_DIR: &str = "azookey_dictionary_storage";
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
// Keep a missing network from blocking the microphone for minutes.  A normal
// 10 MiB codeload response completes well below this on first launch; failure
// simply keeps the built-in fallback available for offline capture.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Serialize first-run downloads when two capture requests race each other.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::const_new(());

/// Resolve the app-data root used for the auto-managed system dictionary.
pub fn managed_dictionary_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(DICTIONARY_STORAGE_DIR).join("Dictionary"))
        .map_err(|error| format!("could not resolve AzooKey dictionary directory: {error}"))
}

/// Return true when a path has the files required by the AzooKey LOUDS reader.
/// Accept both the repository root and its `Dictionary` child for callers that
/// point `AZOOKEY_DICTIONARY_ROOT` at the downloaded archive's top directory.
pub fn has_system_dictionary(path: &Path) -> bool {
    let root =
        if path.join("louds").join("charID.chid").is_file() && path.join("mm.binary").is_file() {
            path.to_path_buf()
        } else {
            path.join("Dictionary")
        };
    root.join("louds").join("charID.chid").is_file() && root.join("mm.binary").is_file()
}

/// Provision the public dictionary if AzooKey has no usable system root yet.
/// Download failures are deliberately non-fatal: capture still starts with the
/// compact fallback lexicon, while the warning is visible in the native log.
pub async fn ensure_system_dictionary(app: &AppHandle, config: &AppConfig) -> Option<PathBuf> {
    if config.models.normalizer != "azookey-rust" {
        return None;
    }
    // A user-provided path is authoritative.  Do not overwrite it with an
    // automatically downloaded dictionary (or hide a malformed path from the
    // Debug panel's explicit validation).
    if config.models.paths.get("azookey-rust").is_some_and(|path| !path.trim().is_empty()) {
        return None;
    }
    if env::var("AZOOKEY_DICTIONARY_ROOT")
        .ok()
        .filter(|path| has_system_dictionary(Path::new(path)))
        .is_some()
    {
        return None;
    }

    let root = match managed_dictionary_root(app) {
        Ok(root) => root,
        Err(error) => {
            log::warn!(target: "kotoba_azookey", "{error}");
            return None;
        }
    };
    if has_system_dictionary(&root) {
        return Some(root);
    }

    let _guard = DOWNLOAD_LOCK.lock().await;
    if has_system_dictionary(&root) {
        return Some(root);
    }
    match download_and_extract(&root).await {
        Ok(()) => Some(root),
        Err(error) => {
            log::warn!(
                target: "kotoba_azookey",
                "public AzooKey dictionary unavailable; using built-in fallback: {error}"
            );
            None
        }
    }
}

async fn download_and_extract(destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "AzooKey dictionary destination has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("could not create AzooKey dictionary directory: {error}"))?;

    let response = reqwest::Client::new()
        .get(DICTIONARY_ARCHIVE_URL)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("could not download AzooKey dictionary: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AzooKey dictionary download failed: {error}"))?;
    if let Some(length) = response.content_length() {
        if length > MAX_ARCHIVE_BYTES as u64 {
            return Err(format!("AzooKey dictionary archive is too large ({length} bytes)"));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read AzooKey dictionary archive: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("AzooKey dictionary archive size is invalid ({} bytes)", bytes.len()));
    }

    let staging = parent.join(format!(".dictionary-staging-{DICTIONARY_REVISION}"));
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|error| format!("could not create AzooKey staging directory: {error}"))?;
    let staging_for_unpack = staging.clone();
    let unpack_result =
        tokio::task::spawn_blocking(move || unpack_archive(&bytes, &staging_for_unpack))
            .await
            .map_err(|error| format!("AzooKey dictionary extraction task failed: {error}"))?;
    if let Err(error) = unpack_result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }

    let extracted = staging.join(format!("azooKey_dictionary_storage-{DICTIONARY_REVISION}"));
    let extracted_dictionary = extracted.join("Dictionary");
    if !has_system_dictionary(&extracted_dictionary) {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err("AzooKey archive did not contain a complete Dictionary root".to_string());
    }
    if tokio::fs::try_exists(destination).await.unwrap_or(false) {
        let _ = tokio::fs::remove_dir_all(destination).await;
    }
    tokio::fs::rename(&extracted_dictionary, destination)
        .await
        .map_err(|error| format!("could not install AzooKey Dictionary root: {error}"))?;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    Ok(())
}

pub(crate) fn unpack_archive(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|error| format!("could not extract AzooKey dictionary archive: {error}"))
}

/// Test-only archive helper keeps the extraction contract independent from the
/// network path and guards against silently accepting a partial archive.
#[cfg(test)]
fn write_test_dictionary_root(root: &Path) -> std::io::Result<()> {
    use std::{fs, fs::File};

    fs::create_dir_all(root.join("louds"))?;
    File::create(root.join("louds").join("charID.chid"))?;
    File::create(root.join("mm.binary"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        has_system_dictionary, unpack_archive, write_test_dictionary_root, DICTIONARY_REVISION,
    };
    use flate2::{write::GzEncoder, Compression};
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("kotoba-azookey-runtime-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn recognizes_complete_dictionary_and_repository_root() {
        let root = temp_root("complete");
        write_test_dictionary_root(&root).expect("fixture");
        assert!(has_system_dictionary(&root));
        let repository = temp_root("repository");
        let dictionary = repository.join("Dictionary");
        std::fs::create_dir_all(&repository).expect("repository fixture");
        std::fs::rename(&root, &dictionary).expect("move dictionary");
        assert!(has_system_dictionary(&repository));
        let _ = std::fs::remove_dir_all(repository);
    }

    #[test]
    fn rejects_partial_dictionary_roots() {
        let root = temp_root("partial");
        std::fs::create_dir_all(root.join("louds")).expect("fixture");
        std::fs::write(root.join("louds").join("charID.chid"), b"partial").expect("fixture");
        assert!(!has_system_dictionary(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_the_pinned_archive_layout() {
        let source = temp_root("archive-source");
        let top = source.join(format!("azooKey_dictionary_storage-{DICTIONARY_REVISION}"));
        write_test_dictionary_root(&top.join("Dictionary")).expect("fixture");
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        archive
            .append_dir_all(format!("azooKey_dictionary_storage-{DICTIONARY_REVISION}"), &top)
            .expect("archive fixture");
        let encoder = archive.into_inner().expect("archive encoder");
        let bytes = encoder.finish().expect("gzip fixture");

        let destination = temp_root("archive-destination");
        std::fs::create_dir_all(&destination).expect("destination");
        unpack_archive(&bytes, &destination).expect("archive should extract");
        assert!(has_system_dictionary(
            &destination.join(format!("azooKey_dictionary_storage-{DICTIONARY_REVISION}"))
        ));
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(destination);
    }
}
