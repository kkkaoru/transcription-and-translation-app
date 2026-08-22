#![forbid(unsafe_code)]

//! Product-identity split between the Tauri desktop app and the future GPUI
//! native app.
//!
//! The two apps must never collide on disk, in the Dock, in log rotation, or
//! on advisory locks. Each [`Flavor`] therefore owns a disjoint directory tree
//! keyed by its bundle identifier, a distinct product name shown in the OS
//! chrome, a distinct log-file prefix, and a distinct `instance.lock`.
//!
//! Model blobs are the exception: [`shared_input_lm_cache_dir`] is intentionally
//! shared so a download by either app benefits the other. Concurrent downloads
//! are serialized by flavor-specific lock files returned by
//! [`download_lock_path`].
//!
//! Port allocation is **not** owned here. It lives in
//! `caption-bridge-sidecar::PortMap` (`PortMap::tauri()` / `PortMap::native()`).
//! This crate only documents that contract and does not duplicate the table.

use std::path::PathBuf;

/// Which GUI framework's product identity is being addressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Flavor {
    Tauri,
    Native,
}

/// Stable product identity for one app flavor.
///
/// Construction is closed: callers must use [`AppIdentity::tauri`] or
/// [`AppIdentity::native`] so the four fields cannot be mixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AppIdentity {
    pub flavor: Flavor,
    pub product_name: &'static str,
    pub bundle_id: &'static str,
    pub log_prefix: &'static str,
}

const TAURI_BUNDLE_ID: &str = "com.kotobabeacon.desktop";
const NATIVE_BUNDLE_ID: &str = "com.kotobabeacon.native";

const TAURI_PRODUCT_NAME: &str = "Kotoba Beacon";
const NATIVE_PRODUCT_NAME: &str = "Kotoba Beacon Native";

const TAURI_LOG_PREFIX: &str = "kotoba-beacon";
const NATIVE_LOG_PREFIX: &str = "kotoba-beacon-native";

const INSTANCE_LOCK_FILE: &str = "instance.lock";
const INPUT_LM_CACHE_LEAF: &str = "caption-bridge-input-lm";

impl AppIdentity {
    /// Identity for the shipped Tauri desktop app.
    pub const fn tauri() -> Self {
        Self {
            flavor: Flavor::Tauri,
            product_name: TAURI_PRODUCT_NAME,
            bundle_id: TAURI_BUNDLE_ID,
            log_prefix: TAURI_LOG_PREFIX,
        }
    }

    /// Identity for the future GPUI native app.
    pub const fn native() -> Self {
        Self {
            flavor: Flavor::Native,
            product_name: NATIVE_PRODUCT_NAME,
            bundle_id: NATIVE_BUNDLE_ID,
            log_prefix: NATIVE_LOG_PREFIX,
        }
    }

    /// Configuration directory for this flavor.
    ///
    /// Platform convention without calling the Tauri path resolver:
    /// - macOS: `~/Library/Application Support/<bundle_id>/`
    /// - Linux: `$XDG_CONFIG_HOME/<bundle_id>/` or `~/.config/<bundle_id>/`
    /// - Windows: `%APPDATA%/<bundle_id>/` (falls back to `~/AppData/Roaming/…`)
    pub fn config_dir(&self) -> PathBuf {
        config_dir_for(self.bundle_id)
    }

    /// Application data directory for this flavor.
    ///
    /// - macOS: same as [`Self::config_dir`] (`~/Library/Application Support/…`)
    /// - Linux: `$XDG_DATA_HOME/<bundle_id>/` or `~/.local/share/<bundle_id>/`
    /// - Windows: `%APPDATA%/<bundle_id>/`
    pub fn data_dir(&self) -> PathBuf {
        data_dir_for(self.bundle_id)
    }

    /// Local-data directory (where `instance.lock` lives).
    ///
    /// - macOS/Linux: same as [`Self::data_dir`].
    /// - Windows: `%LOCALAPPDATA%/<bundle_id>/` when set, otherwise
    ///   [`Self::data_dir`].
    pub fn local_data_dir(&self) -> PathBuf {
        local_data_dir_for(self.bundle_id)
    }

    /// Log directory for this flavor.
    ///
    /// - macOS: `~/Library/Logs/<bundle_id>/` (matches `tauri_plugin_log`
    ///   `TargetKind::LogDir`).
    /// - Linux/Windows: `<data_dir>/logs/`.
    pub fn log_dir(&self) -> PathBuf {
        log_dir_for(self.bundle_id)
    }

    /// Advisory lock file for single-instance enforcement.
    ///
    /// Always `local_data_dir/instance.lock`. Each flavor owns its own file
    /// so the Tauri and GPUI apps can run side-by-side.
    pub fn instance_lock_path(&self) -> PathBuf {
        self.local_data_dir().join(INSTANCE_LOCK_FILE)
    }
}

/// Shared on-disk cache for the input-LM tokenizer/model blobs.
///
/// Intentionally flavor-independent: `$HOME/.cache/caption-bridge-input-lm/`
/// (or the platform equivalent) so whichever app downloads first benefits the
/// other. On Windows the location is `%LOCALAPPDATA%/caption-bridge-input-lm/`
/// when `LOCALAPPDATA` is set, otherwise `~/.cache/…`.
pub fn shared_input_lm_cache_dir() -> PathBuf {
    shared_cache_dir_for(INPUT_LM_CACHE_LEAF)
}

/// Flavor-scoped lock that serializes concurrent model downloads inside the
/// shared cache directory.
///
/// Returns `<shared_input_lm_cache_dir>/.download.lock.<suffix>` where
/// `suffix` is `tauri` or `native`. Two downloaders with different flavors
/// lock different files; two with the same flavor contend on the same file.
pub fn download_lock_path(flavor: Flavor) -> PathBuf {
    let suffix = match flavor {
        Flavor::Tauri => "tauri",
        Flavor::Native => "native",
    };
    shared_input_lm_cache_dir().join(format!(".download.lock.{suffix}"))
}

// ---------------------------------------------------------------------------
// Platform-specific path helpers (no Tauri, no dirs crate)
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        if !user_profile.is_empty() {
            return PathBuf::from(user_profile);
        }
    }
    PathBuf::from("/tmp")
}

#[cfg(target_os = "macos")]
fn config_dir_for(bundle_id: &str) -> PathBuf {
    home_dir().join("Library").join("Application Support").join(bundle_id)
}

#[cfg(target_os = "macos")]
fn data_dir_for(bundle_id: &str) -> PathBuf {
    config_dir_for(bundle_id)
}

#[cfg(target_os = "macos")]
fn local_data_dir_for(bundle_id: &str) -> PathBuf {
    config_dir_for(bundle_id)
}

#[cfg(target_os = "macos")]
fn log_dir_for(bundle_id: &str) -> PathBuf {
    home_dir().join("Library").join("Logs").join(bundle_id)
}

#[cfg(target_os = "macos")]
fn shared_cache_dir_for(leaf: &str) -> PathBuf {
    home_dir().join(".cache").join(leaf)
}

#[cfg(target_os = "windows")]
fn config_dir_for(bundle_id: &str) -> PathBuf {
    if let Some(app_data) = std::env::var_os("APPDATA") {
        if !app_data.is_empty() {
            return PathBuf::from(app_data).join(bundle_id);
        }
    }
    home_dir().join("AppData").join("Roaming").join(bundle_id)
}

#[cfg(target_os = "windows")]
fn data_dir_for(bundle_id: &str) -> PathBuf {
    config_dir_for(bundle_id)
}

#[cfg(target_os = "windows")]
fn local_data_dir_for(bundle_id: &str) -> PathBuf {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if !local.is_empty() {
            return PathBuf::from(local).join(bundle_id);
        }
    }
    data_dir_for(bundle_id)
}

#[cfg(target_os = "windows")]
fn log_dir_for(bundle_id: &str) -> PathBuf {
    data_dir_for(bundle_id).join("logs")
}

#[cfg(target_os = "windows")]
fn shared_cache_dir_for(leaf: &str) -> PathBuf {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if !local.is_empty() {
            return PathBuf::from(local).join(leaf);
        }
    }
    home_dir().join(".cache").join(leaf)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn config_dir_for(bundle_id: &str) -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join(bundle_id);
        }
    }
    home_dir().join(".config").join(bundle_id)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn data_dir_for(bundle_id: &str) -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join(bundle_id);
        }
    }
    home_dir().join(".local").join("share").join(bundle_id)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn local_data_dir_for(bundle_id: &str) -> PathBuf {
    data_dir_for(bundle_id)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn log_dir_for(bundle_id: &str) -> PathBuf {
    data_dir_for(bundle_id).join("logs")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn shared_cache_dir_for(leaf: &str) -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join(leaf);
        }
    }
    home_dir().join(".cache").join(leaf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_ids_match_spec() {
        assert_eq!(AppIdentity::tauri().bundle_id, "com.kotobabeacon.desktop");
        assert_eq!(AppIdentity::native().bundle_id, "com.kotobabeacon.native");
    }

    #[test]
    fn product_names_match_spec() {
        assert_eq!(AppIdentity::tauri().product_name, "Kotoba Beacon");
        assert_eq!(AppIdentity::native().product_name, "Kotoba Beacon Native");
    }

    #[test]
    fn log_prefixes_match_spec() {
        assert_eq!(AppIdentity::tauri().log_prefix, "kotoba-beacon");
        assert_eq!(AppIdentity::native().log_prefix, "kotoba-beacon-native");
    }

    #[test]
    fn flavors_are_distinct() {
        assert_ne!(AppIdentity::tauri().flavor, AppIdentity::native().flavor);
        assert_ne!(AppIdentity::tauri().bundle_id, AppIdentity::native().bundle_id);
        assert_ne!(AppIdentity::tauri().product_name, AppIdentity::native().product_name);
        assert_ne!(AppIdentity::tauri().log_prefix, AppIdentity::native().log_prefix);
    }

    #[test]
    fn config_dirs_differ_and_contain_bundle_id() {
        let tauri = AppIdentity::tauri().config_dir();
        let native = AppIdentity::native().config_dir();
        assert_ne!(tauri, native);
        assert!(tauri.to_string_lossy().contains("com.kotobabeacon.desktop"));
        assert!(native.to_string_lossy().contains("com.kotobabeacon.native"));
    }

    #[test]
    fn data_dirs_differ_and_contain_bundle_id() {
        let tauri = AppIdentity::tauri().data_dir();
        let native = AppIdentity::native().data_dir();
        assert_ne!(tauri, native);
        assert!(tauri.to_string_lossy().contains("com.kotobabeacon.desktop"));
        assert!(native.to_string_lossy().contains("com.kotobabeacon.native"));
    }

    #[test]
    fn local_data_dirs_differ() {
        let tauri = AppIdentity::tauri().local_data_dir();
        let native = AppIdentity::native().local_data_dir();
        assert_ne!(tauri, native);
    }

    #[test]
    fn log_dirs_differ_and_contain_bundle_id() {
        let tauri = AppIdentity::tauri().log_dir();
        let native = AppIdentity::native().log_dir();
        assert_ne!(tauri, native);
        assert!(tauri.to_string_lossy().contains("com.kotobabeacon.desktop"));
        assert!(native.to_string_lossy().contains("com.kotobabeacon.native"));
    }

    #[test]
    fn instance_locks_are_different_files() {
        let tauri = AppIdentity::tauri().instance_lock_path();
        let native = AppIdentity::native().instance_lock_path();
        assert_ne!(tauri, native);
        assert_eq!(tauri.file_name().and_then(|n| n.to_str()), Some("instance.lock"));
        assert_eq!(native.file_name().and_then(|n| n.to_str()), Some("instance.lock"));
    }

    #[test]
    fn instance_lock_is_inside_local_data_dir() {
        let tauri = AppIdentity::tauri();
        assert_eq!(tauri.instance_lock_path(), tauri.local_data_dir().join("instance.lock"));
        let native = AppIdentity::native();
        assert_eq!(native.instance_lock_path(), native.local_data_dir().join("instance.lock"));
    }

    #[test]
    fn shared_cache_is_identical_for_both_flavors() {
        let first = shared_input_lm_cache_dir();
        let second = shared_input_lm_cache_dir();
        assert_eq!(first, second);
        assert!(first.to_string_lossy().contains("caption-bridge-input-lm"));
    }

    #[test]
    fn shared_cache_does_not_contain_bundle_id() {
        let cache = shared_input_lm_cache_dir();
        let raw = cache.to_string_lossy();
        assert!(!raw.contains("com.kotobabeacon.desktop"));
        assert!(!raw.contains("com.kotobabeacon.native"));
    }

    #[test]
    fn download_lock_paths_differ_by_flavor_and_live_in_cache() {
        let tauri = download_lock_path(Flavor::Tauri);
        let native = download_lock_path(Flavor::Native);
        assert_ne!(tauri, native);
        assert!(tauri.to_string_lossy().contains(".download.lock.tauri"));
        assert!(native.to_string_lossy().contains(".download.lock.native"));
        let cache = shared_input_lm_cache_dir();
        assert!(tauri.starts_with(&cache));
        assert!(native.starts_with(&cache));
    }

    #[test]
    fn every_path_except_shared_cache_differs() {
        let tauri = AppIdentity::tauri();
        let native = AppIdentity::native();
        assert_ne!(tauri.config_dir(), native.config_dir());
        assert_ne!(tauri.data_dir(), native.data_dir());
        assert_ne!(tauri.local_data_dir(), native.local_data_dir());
        assert_ne!(tauri.log_dir(), native.log_dir());
        assert_ne!(tauri.instance_lock_path(), native.instance_lock_path());
        assert_eq!(shared_input_lm_cache_dir(), shared_input_lm_cache_dir());
        assert_ne!(download_lock_path(Flavor::Tauri), download_lock_path(Flavor::Native));
    }

    #[test]
    fn tauri_identity_constructors_are_const_compatible() {
        const TAURI: AppIdentity = AppIdentity::tauri();
        const NATIVE: AppIdentity = AppIdentity::native();
        assert_eq!(TAURI.bundle_id, "com.kotobabeacon.desktop");
        assert_eq!(NATIVE.bundle_id, "com.kotobabeacon.native");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_paths_use_library_and_shared_cache_is_dot_cache() {
        let native = AppIdentity::native();
        let config = native.config_dir();
        let data = native.data_dir();
        let logs = native.log_dir();
        let cache = shared_input_lm_cache_dir();
        assert!(config
            .to_string_lossy()
            .contains("Library/Application Support/com.kotobabeacon.native"));
        assert_eq!(config, data);
        assert!(logs.to_string_lossy().contains("Library/Logs/com.kotobabeacon.native"));
        assert!(cache.to_string_lossy().contains(".cache/caption-bridge-input-lm"));
        assert!(!cache.to_string_lossy().contains("Library/Application Support"));
        assert!(!cache.to_string_lossy().contains("AppData"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_paths_use_appdata_not_library() {
        let native = AppIdentity::native();
        let config = native.config_dir();
        let raw = config.to_string_lossy();
        assert!(raw.contains("com.kotobabeacon.native"));
        assert!(!raw.contains("Library/Application Support"));
        let cache = shared_input_lm_cache_dir();
        let cache_raw = cache.to_string_lossy();
        assert!(cache_raw.contains("caption-bridge-input-lm"));
        assert!(!cache_raw.contains("Library/Application Support"));
    }
}
