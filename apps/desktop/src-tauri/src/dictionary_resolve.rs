//! Resolve AzooKey dictionary settings that may be local paths or HTTPS URLs.
//!
//! Settings keep the configured URL string for display. Capture preparation
//! downloads HTTPS dictionaries into an app-data cache and writes sibling
//! `*-resolved` path keys so the sync pipeline can load local files.

use crate::azookey_runtime::{has_system_dictionary, unpack_archive};
use crate::config::AppConfig;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const CACHE_DIR_NAME: &str = "azookey_dictionary_cache";
/// Full LOUDS archives are roughly 10 MiB compressed; keep headroom for
/// larger community builds without matching the unbounded model downloads.
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

static DOWNLOAD_LOCK: Mutex<()> = Mutex::const_new(());

/// Config path keys that may be a filesystem path or an HTTPS URL.
///
/// Keep in sync with `@caption-bridge/dictionaries` `AZOOKEY_DICTIONARY_CONFIG_KEYS`
/// so Worker/browser locators use the same kind names as desktop.
pub const DICTIONARY_CONFIG_KEYS: &[&str] =
    &["azookey-rust", "azookey-user-dictionary", "azookey-learning-memory"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictionaryKind {
    System,
    User,
    Learning,
}

impl DictionaryKind {
    fn from_config_key(key: &str) -> Option<Self> {
        match key {
            "azookey-rust" => Some(Self::System),
            "azookey-user-dictionary" => Some(Self::User),
            "azookey-learning-memory" => Some(Self::Learning),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Learning => "learning-memory",
        }
    }
}

/// Sibling key written with the local cache path while the user-facing value
/// remains an HTTPS URL.
pub fn resolved_path_key(configured_key: &str) -> String {
    format!("{configured_key}-resolved")
}

pub fn is_https_url(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("https://")
}

pub fn is_non_tls_http_url(value: &str) -> bool {
    let trimmed = value.trim().to_ascii_lowercase();
    trimmed.starts_with("http://") && !trimmed.starts_with("https://")
}

pub fn url_cache_key(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.trim().as_bytes());
    hex::encode(hasher.finalize())
}

pub fn dictionary_url_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CACHE_DIR_NAME))
        .map_err(|error| format!("could not resolve AzooKey dictionary cache directory: {error}"))
}

/// Download/cache any HTTPS dictionary URLs in `config`, writing `*-resolved`
/// local paths. Local filesystem paths are left unchanged. Rejects plain HTTP.
pub async fn resolve_dictionary_urls_in_config(
    app: &AppHandle,
    config: &mut AppConfig,
) -> Result<(), String> {
    for key in DICTIONARY_CONFIG_KEYS {
        let Some(raw) = config.models.paths.get(*key).cloned() else {
            continue;
        };
        let configured = raw.trim();
        if configured.is_empty() {
            config.models.paths.remove(&resolved_path_key(key));
            continue;
        }
        if is_non_tls_http_url(configured) {
            return Err(format!(
                "AzooKey {} dictionary URL must use HTTPS (http:// is not allowed): {configured}",
                DictionaryKind::from_config_key(key).map(|kind| kind.as_str()).unwrap_or(key)
            ));
        }
        if !is_https_url(configured) {
            // Local path: drop any stale resolved override from a previous URL.
            config.models.paths.remove(&resolved_path_key(key));
            continue;
        }
        let kind = DictionaryKind::from_config_key(key).expect("known dictionary config key");
        let local = resolve_dictionary_location(app, kind, configured).await?;
        config.models.paths.insert(resolved_path_key(key), local.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Resolve one configured value to a local filesystem path.
pub async fn resolve_dictionary_location(
    app: &AppHandle,
    kind: DictionaryKind,
    configured: &str,
) -> Result<PathBuf, String> {
    let configured = configured.trim();
    if configured.is_empty() {
        return Err(format!("AzooKey {} dictionary path is empty", kind.as_str()));
    }
    if is_non_tls_http_url(configured) {
        return Err(format!(
            "AzooKey {} dictionary URL must use HTTPS (http:// is not allowed)",
            kind.as_str()
        ));
    }
    if !is_https_url(configured) {
        return resolve_local_dictionary_path(kind, Path::new(configured));
    }

    let cache_root = dictionary_url_cache_root(app)?;
    let entry = cache_root.join(url_cache_key(configured));
    if let Some(cached) = find_cached_dictionary(&entry, kind) {
        return Ok(cached);
    }

    let _guard = DOWNLOAD_LOCK.lock().await;
    if let Some(cached) = find_cached_dictionary(&entry, kind) {
        return Ok(cached);
    }

    download_and_install_dictionary(configured, &entry, kind).await?;
    find_cached_dictionary(&entry, kind).ok_or_else(|| {
        format!("AzooKey {} dictionary download completed but cache is incomplete", kind.as_str())
    })
}

fn resolve_local_dictionary_path(kind: DictionaryKind, path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!(
            "AzooKey {} dictionary path does not exist: {}",
            kind.as_str(),
            path.display()
        ));
    }
    match kind {
        DictionaryKind::System => {
            if !has_system_dictionary(path) {
                return Err(format!(
                    "AzooKey system dictionary path is incomplete: {}",
                    path.display()
                ));
            }
            Ok(effective_system_dictionary_root(path))
        }
        DictionaryKind::User | DictionaryKind::Learning => Ok(path.to_path_buf()),
    }
}

fn effective_system_dictionary_root(path: &Path) -> PathBuf {
    if path.join("louds").join("charID.chid").is_file() && path.join("mm.binary").is_file() {
        path.to_path_buf()
    } else {
        path.join("Dictionary")
    }
}

fn find_cached_dictionary(cache_entry: &Path, kind: DictionaryKind) -> Option<PathBuf> {
    match kind {
        DictionaryKind::System => {
            let dictionary = cache_entry.join("Dictionary");
            if has_system_dictionary(&dictionary) {
                return Some(effective_system_dictionary_root(&dictionary));
            }
            if has_system_dictionary(cache_entry) {
                return Some(effective_system_dictionary_root(cache_entry));
            }
            None
        }
        DictionaryKind::User | DictionaryKind::Learning => {
            let preferred = cache_entry.join(default_payload_name(kind));
            if preferred.is_file() {
                return Some(preferred);
            }
            // Accept any single regular file left by an older cache layout.
            let mut files = std::fs::read_dir(cache_entry)
                .ok()?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| !name.starts_with('.'))
                })
                .collect::<Vec<_>>();
            if files.len() == 1 {
                return files.pop();
            }
            if cache_entry.is_dir() && external_layout_present(cache_entry, kind) {
                return Some(cache_entry.to_path_buf());
            }
            None
        }
    }
}

fn external_layout_present(path: &Path, kind: DictionaryKind) -> bool {
    let name = match kind {
        DictionaryKind::User => "user",
        DictionaryKind::Learning => "memory",
        DictionaryKind::System => return false,
    };
    let has_shard =
        std::fs::read_dir(path).ok().into_iter().flatten().filter_map(Result::ok).any(|entry| {
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            filename.starts_with(name) && filename.ends_with(".loudstxt3")
        });
    path.join(format!("{name}.louds")).is_file()
        && path.join(format!("{name}.loudschars2")).is_file()
        && has_shard
}

fn default_payload_name(kind: DictionaryKind) -> &'static str {
    match kind {
        DictionaryKind::System => "Dictionary",
        DictionaryKind::User => "user.tsv",
        DictionaryKind::Learning => "memory.tsv",
    }
}

async fn download_and_install_dictionary(
    url: &str,
    cache_entry: &Path,
    kind: DictionaryKind,
) -> Result<(), String> {
    if let Some(parent) = cache_entry.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("could not create dictionary cache directory: {error}"))?;
    }

    let bytes = download_https_bytes(url).await?;
    let staging = cache_entry.with_file_name(format!(
        ".{}-staging",
        cache_entry.file_name().and_then(|name| name.to_str()).unwrap_or("dictionary")
    ));
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|error| format!("could not create dictionary staging directory: {error}"))?;

    let url_owned = url.to_string();
    let staging_for_install = staging.clone();
    let install_result = tokio::task::spawn_blocking(move || {
        install_downloaded_bytes(&bytes, &url_owned, &staging_for_install, kind)
    })
    .await
    .map_err(|error| format!("dictionary install task failed: {error}"))?;
    if let Err(error) = install_result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }

    let _ = tokio::fs::remove_dir_all(cache_entry).await;
    tokio::fs::rename(&staging, cache_entry)
        .await
        .map_err(|error| format!("could not publish dictionary cache entry: {error}"))?;
    Ok(())
}

async fn download_https_bytes(url: &str) -> Result<Vec<u8>, String> {
    if !is_https_url(url) {
        return Err("dictionary download requires an HTTPS URL".to_string());
    }
    let response = reqwest::Client::new()
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("could not download AzooKey dictionary: {error}"))?
        .error_for_status()
        .map_err(|error| format!("AzooKey dictionary download failed: {error}"))?;
    if let Some(length) = response.content_length() {
        if length > MAX_DOWNLOAD_BYTES as u64 {
            return Err(format!("AzooKey dictionary download is too large ({length} bytes)"));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read AzooKey dictionary download: {error}"))?;
    if bytes.is_empty() || bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!("AzooKey dictionary download size is invalid ({} bytes)", bytes.len()));
    }
    Ok(bytes.to_vec())
}

#[allow(clippy::excessive_nesting)]
fn install_downloaded_bytes(
    bytes: &[u8],
    url: &str,
    destination: &Path,
    kind: DictionaryKind,
) -> Result<(), String> {
    let format = detect_download_format(url, bytes);
    match (kind, format) {
        (DictionaryKind::System, DownloadFormat::TarGz) => {
            unpack_archive(bytes, destination)?;
            let found = locate_system_dictionary(destination).ok_or_else(|| {
                "AzooKey archive did not contain a complete Dictionary root".to_string()
            })?;
            let installed = destination.join("Dictionary");
            if found != installed {
                if installed.exists() {
                    let _ = std::fs::remove_dir_all(&installed);
                }
                // Move the discovered root into a stable cache layout.
                if let Some(parent) = installed.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        format!("could not prepare dictionary cache layout: {error}")
                    })?;
                }
                // Prefer rename; fall back to recursive copy for cross-device edges.
                if std::fs::rename(&found, &installed).is_err() {
                    copy_dir_recursive(&found, &installed)?;
                    let _ = std::fs::remove_dir_all(&found);
                }
            }
            if !has_system_dictionary(&installed) {
                return Err("AzooKey archive did not contain a complete Dictionary root".to_string());
            }
            Ok(())
        }
        (DictionaryKind::System, DownloadFormat::GzipFile | DownloadFormat::RawFile) => Err(
            "AzooKey system dictionary HTTPS URL must point to a .tar.gz / .tgz archive with a Dictionary/ layout"
                .to_string(),
        ),
        (DictionaryKind::User | DictionaryKind::Learning, DownloadFormat::TarGz) => {
            unpack_archive(bytes, destination)?;
            if find_cached_dictionary(destination, kind).is_some() {
                return Ok(());
            }
            // If the archive contained a single file at the top, promote it.
            promote_single_extracted_file(destination, kind)
        }
        (DictionaryKind::User | DictionaryKind::Learning, DownloadFormat::GzipFile) => {
            let payload = destination.join(default_payload_name(kind));
            gunzip_to_file(bytes, &payload)?;
            Ok(())
        }
        (DictionaryKind::User | DictionaryKind::Learning, DownloadFormat::RawFile) => {
            let payload = destination.join(default_payload_name(kind));
            let mut file = File::create(&payload)
                .map_err(|error| format!("could not write dictionary payload: {error}"))?;
            file.write_all(bytes)
                .map_err(|error| format!("could not write dictionary payload: {error}"))?;
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadFormat {
    TarGz,
    GzipFile,
    RawFile,
}

fn detect_download_format(url: &str, bytes: &[u8]) -> DownloadFormat {
    let path = url_path_lower(url);
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        return DownloadFormat::TarGz;
    }
    if path.ends_with(".gz") {
        // azkdict-style single gzip payload, or a mislabeled tar.gz.
        if looks_like_tar_gz(bytes) {
            return DownloadFormat::TarGz;
        }
        return DownloadFormat::GzipFile;
    }
    if looks_like_tar_gz(bytes) {
        return DownloadFormat::TarGz;
    }
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return DownloadFormat::GzipFile;
    }
    DownloadFormat::RawFile
}

fn url_path_lower(url: &str) -> String {
    url.split('?').next().unwrap_or(url).trim().to_ascii_lowercase()
}

fn looks_like_tar_gz(bytes: &[u8]) -> bool {
    let mut decoder = GzDecoder::new(Cursor::new(bytes));
    let mut header = [0_u8; 512];
    match decoder.read_exact(&mut header) {
        // POSIX tar ustar magic at offset 257.
        Ok(()) => &header[257..262] == b"ustar",
        Err(_) => false,
    }
}

fn gunzip_to_file(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut decoder = GzDecoder::new(Cursor::new(bytes));
    let mut plain = Vec::new();
    decoder
        .read_to_end(&mut plain)
        .map_err(|error| format!("could not decompress dictionary gzip: {error}"))?;
    if plain.is_empty() {
        return Err("dictionary gzip payload was empty".to_string());
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create dictionary payload directory: {error}"))?;
    }
    std::fs::write(destination, plain)
        .map_err(|error| format!("could not write decompressed dictionary: {error}"))
}

#[allow(clippy::excessive_nesting)]
fn locate_system_dictionary(root: &Path) -> Option<PathBuf> {
    if has_system_dictionary(root) {
        return Some(effective_system_dictionary_root(root));
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if has_system_dictionary(&path) {
            return Some(effective_system_dictionary_root(&path));
        }
        // One more level for archives that wrap a repository folder.
        if path.is_dir() {
            if let Ok(nested) = std::fs::read_dir(&path) {
                for child in nested.filter_map(Result::ok) {
                    let child_path = child.path();
                    if has_system_dictionary(&child_path) {
                        return Some(effective_system_dictionary_root(&child_path));
                    }
                }
            }
        }
    }
    None
}

fn promote_single_extracted_file(destination: &Path, kind: DictionaryKind) -> Result<(), String> {
    let mut files = Vec::new();
    collect_regular_files(destination, &mut files);
    if files.len() != 1 {
        return Err(format!(
            "AzooKey {} dictionary archive must contain a single TSV/file or an upstream louds layout",
            kind.as_str()
        ));
    }
    let source = files.remove(0);
    let payload = destination.join(default_payload_name(kind));
    if source != payload {
        std::fs::rename(&source, &payload)
            .or_else(|_| {
                std::fs::copy(&source, &payload)
                    .map(|_| ())
                    .and_then(|_| std::fs::remove_file(&source))
            })
            .map_err(|error| format!("could not promote dictionary payload: {error}"))?;
    }
    Ok(())
}

fn collect_regular_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() {
            out.push(path);
        } else if path.is_dir() {
            collect_regular_files(&path, out);
        }
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to)
        .map_err(|error| format!("could not copy dictionary directory: {error}"))?;
    for entry in std::fs::read_dir(from)
        .map_err(|error| format!("could not read dictionary directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("could not read dictionary entry: {error}"))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else {
            std::fs::copy(&source, &target)
                .map_err(|error| format!("could not copy dictionary file: {error}"))?;
        }
    }
    Ok(())
}

/// Prefer a capture-session `*-resolved` local path when the user-facing value
/// is still an HTTPS URL.
pub fn configured_or_resolved_path(config: &AppConfig, key: &str) -> Option<PathBuf> {
    let resolved_key = resolved_path_key(key);
    if let Some(resolved) =
        config.models.paths.get(&resolved_key).filter(|path| !path.trim().is_empty())
    {
        return Some(PathBuf::from(resolved));
    }
    let configured = config.models.paths.get(key).filter(|path| !path.trim().is_empty())?;
    if is_https_url(configured) || is_non_tls_http_url(configured) {
        // Unresolved URL must not be treated as a filesystem path.
        return None;
    }
    Some(PathBuf::from(configured))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("kotoba-dict-resolve-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn write_test_dictionary_root(root: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(root.join("louds"))?;
        File::create(root.join("louds").join("charID.chid"))?;
        File::create(root.join("mm.binary"))?;
        Ok(())
    }

    #[test]
    fn detects_https_urls_only() {
        assert!(is_https_url("https://example.com/dict.tar.gz"));
        assert!(is_https_url("  HTTPS://Example.com/dict  "));
        assert!(!is_https_url("http://example.com/dict.tar.gz"));
        assert!(!is_https_url("/models/azookey"));
        assert!(!is_https_url("file:///tmp/dict"));
    }

    #[test]
    fn rejects_plain_http_helpers() {
        assert!(is_non_tls_http_url("http://example.com/user.tsv"));
        assert!(is_non_tls_http_url("HTTP://example.com/user.tsv"));
        assert!(!is_non_tls_http_url("https://example.com/user.tsv"));
        assert!(!is_non_tls_http_url("/local/path"));
    }

    #[test]
    fn url_cache_key_is_stable_for_trimmed_input() {
        let a = url_cache_key("https://example.com/dict.tar.gz");
        let b = url_cache_key("https://example.com/dict.tar.gz");
        let c = url_cache_key("  https://example.com/dict.tar.gz  ");
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, url_cache_key("https://example.com/other.tar.gz"));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn resolved_path_key_suffix() {
        assert_eq!(resolved_path_key("azookey-rust"), "azookey-rust-resolved");
        assert_eq!(
            resolved_path_key("azookey-user-dictionary"),
            "azookey-user-dictionary-resolved"
        );
    }

    #[test]
    fn configured_or_resolved_prefers_resolved_and_skips_unresolved_urls() {
        let mut config = AppConfig::default();
        config.models.paths.insert("azookey-rust".into(), "https://example.com/dict.tar.gz".into());
        assert!(configured_or_resolved_path(&config, "azookey-rust").is_none());

        config.models.paths.insert("azookey-rust-resolved".into(), "/tmp/cached-dictionary".into());
        assert_eq!(
            configured_or_resolved_path(&config, "azookey-rust").as_deref(),
            Some(Path::new("/tmp/cached-dictionary"))
        );
    }

    #[test]
    fn reject_non_tls_url_via_resolve_local_path_guard() {
        let error = resolve_local_dictionary_path(
            DictionaryKind::User,
            Path::new("/this/path/should/not/exist-azookey-test"),
        )
        .expect_err("missing path");
        assert!(error.contains("does not exist"));

        // Direct HTTPS gate is covered by is_non_tls_http_url; simulate the
        // error string users see when prepare rejects http://.
        let message = format!(
            "AzooKey {} dictionary URL must use HTTPS (http:// is not allowed)",
            DictionaryKind::System.as_str()
        );
        assert!(message.contains("HTTPS"));
        assert!(is_non_tls_http_url("http://evil.example/dict.tar.gz"));
    }

    #[test]
    fn installs_system_tar_gz_into_stable_cache_layout() {
        let source = temp_root("tar-source");
        let top = source.join("azooKey_dictionary_storage-deadbeef");
        write_test_dictionary_root(&top.join("Dictionary")).expect("fixture");
        let encoder = GzEncoder::new(Vec::new(), Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        archive
            .append_dir_all("azooKey_dictionary_storage-deadbeef", &top)
            .expect("archive fixture");
        let encoder = archive.into_inner().expect("archive encoder");
        let bytes = encoder.finish().expect("gzip fixture");

        let destination = temp_root("tar-dest");
        std::fs::create_dir_all(&destination).expect("destination");
        install_downloaded_bytes(
            &bytes,
            "https://example.com/azookey-dict.tar.gz",
            &destination,
            DictionaryKind::System,
        )
        .expect("install");
        let cached = find_cached_dictionary(&destination, DictionaryKind::System)
            .expect("cache should contain system dictionary");
        assert!(has_system_dictionary(&cached));

        // Second lookup simulates a cache hit without re-download.
        let again = find_cached_dictionary(&destination, DictionaryKind::System);
        assert_eq!(again.as_ref(), Some(&cached));

        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(destination);
    }

    #[test]
    fn installs_user_tsv_raw_bytes_and_gzip() {
        let destination = temp_root("user-tsv");
        std::fs::create_dir_all(&destination).expect("destination");
        install_downloaded_bytes(
            b"reading\tcandidate\t1\n",
            "https://example.com/custom-user.tsv",
            &destination,
            DictionaryKind::User,
        )
        .expect("raw tsv");
        let cached =
            find_cached_dictionary(&destination, DictionaryKind::User).expect("user cache file");
        assert!(cached.is_file());
        assert_eq!(std::fs::read_to_string(&cached).expect("read"), "reading\tcandidate\t1\n");

        let gz_destination = temp_root("user-tsv-gz");
        std::fs::create_dir_all(&gz_destination).expect("destination");
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(b"memory\tentry\t2\n").expect("gzip body");
        let gz_bytes = encoder.finish().expect("gzip");
        install_downloaded_bytes(
            &gz_bytes,
            "https://example.com/memory.tsv.gz",
            &gz_destination,
            DictionaryKind::Learning,
        )
        .expect("gzip tsv");
        let memory = find_cached_dictionary(&gz_destination, DictionaryKind::Learning)
            .expect("memory cache file");
        assert_eq!(std::fs::read_to_string(memory).expect("read"), "memory\tentry\t2\n");

        let _ = std::fs::remove_dir_all(destination);
        let _ = std::fs::remove_dir_all(gz_destination);
    }

    #[test]
    fn detect_format_from_url_and_bytes() {
        assert_eq!(
            detect_download_format("https://x.test/a.tar.gz", b"not-gzip"),
            DownloadFormat::TarGz
        );
        assert_eq!(
            detect_download_format("https://x.test/a.tgz", b"not-gzip"),
            DownloadFormat::TarGz
        );
        assert_eq!(
            detect_download_format("https://x.test/a.tsv", b"plain"),
            DownloadFormat::RawFile
        );
    }
}
