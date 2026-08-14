//! macOS application lifecycle helpers.
//!
//! The updater replaces the bundle in place.  A running process can therefore
//! keep executing the old image until it is explicitly restarted.  This module
//! keeps the restart boring and predictable:
//!
//! * one advisory `flock` is held for the whole app lifetime;
//! * relaunch uses Tauri's exit/restart path, so gateway/sidecars are stopped
//!   by the normal `RunEvent::Exit` handler before the new image starts; and
//! * the foreground app always uses the regular activation policy, preserving
//!   one Dock icon.  Headless sidecars opt into `Accessory` separately.
//!   Verification / smoke launches pass `--kotoba-smoke-background` (or
//!   `KOTOBA_BEACON_SMOKE_BACKGROUND`) so the process stays Accessory and
//!   does not steal key-window focus. Default user launches still activate.
//!
//! The non-macOS stubs keep the command surface portable so Linux CI can still
//! compile and run the Rust unit tests.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const INSTANCE_LOCK_FILE: &str = "instance.lock";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SMOKE_BACKGROUND_FLAG: &str = "--kotoba-smoke-background";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SMOKE_BACKGROUND_ENV: &str = "KOTOBA_BEACON_SMOKE_BACKGROUND";

#[derive(Debug)]
pub struct InstanceGuard {
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    lock_file: std::fs::File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceError {
    #[cfg(target_os = "macos")]
    AlreadyRunning,
    Io(String),
}

impl std::fmt::Display for InstanceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(target_os = "macos")]
            Self::AlreadyRunning => {
                formatter.write_str("another Kotoba Beacon instance is running")
            }
            Self::Io(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for InstanceError {}

/// Acquire the process-wide lock used by the foreground app.
///
/// `flock` is deliberately used instead of a create-only marker file.  A
/// marker survives a crash and would strand users behind a stale lock after an
/// interrupted update; the kernel releases `flock` as soon as this process
/// exits, including abnormal termination.
pub fn acquire_instance(app: &AppHandle) -> Result<InstanceGuard, InstanceError> {
    let lock_path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| {
            InstanceError::Io(format!("could not resolve app data directory: {error}"))
        })?
        .join(INSTANCE_LOCK_FILE);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InstanceError::Io(format!("could not create app data directory: {error}"))
        })?;
    }

    #[cfg(target_os = "macos")]
    {
        acquire_macos_instance(&lock_path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        // The foreground lifecycle is macOS-specific.  Keep a zero-sized guard
        // on other targets so this module and its command compile everywhere.
        let _ = lock_path;
        Ok(InstanceGuard {})
    }
}

#[cfg(target_os = "macos")]
fn acquire_macos_instance(lock_path: &Path) -> Result<InstanceGuard, InstanceError> {
    use std::os::fd::AsRawFd;

    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| InstanceError::Io(format!("could not open instance lock: {error}")))?;
    // SAFETY: `lock_file` is an open regular file and remains owned by the
    // returned guard for the process lifetime.
    let result = unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(InstanceGuard { lock_file });
    }

    let error = std::io::Error::last_os_error();
    let raw = error.raw_os_error();
    if raw == Some(libc::EAGAIN) || raw == Some(libc::EWOULDBLOCK) {
        return Err(InstanceError::AlreadyRunning);
    }
    Err(InstanceError::Io(format!("could not lock instance file: {error}")))
}

/// Make the foreground Tauri process a regular app (and therefore keep one
/// Dock icon) after a sidecar or another helper changed the activation policy.
///
/// Smoke / verification launches opt out of activation so the harness can
/// keep working in another app. Default double-click / Dock launches still
/// come to the front.
#[allow(clippy::excessive_nesting)]
pub fn configure_foreground_activation(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if smoke_background_requested() {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory).map_err(|error| {
                format!("could not set accessory activation policy for smoke: {error}")
            })?;
            let _ = app.set_dock_visibility(false);
            log::info!("smoke background launch: accessory policy, not activating");
            return Ok(());
        }
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| format!("could not set regular activation policy: {error}"))?;
        app.set_dock_visibility(true)
            .map_err(|error| format!("could not show Kotoba Beacon in the Dock: {error}"))?;
    }
    let _ = app;
    Ok(())
}

/// True when this process was started by the native smoke harness.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn smoke_background_requested() -> bool {
    smoke_background_requested_from(std::env::args())
        || std::env::var_os(SMOKE_BACKGROUND_ENV).is_some()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn smoke_background_requested_from(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter().any(|arg| arg.as_ref() == SMOKE_BACKGROUND_FLAG)
}

/// Ask Tauri to leave through its normal exit path and start the executable at
/// the same bundle path.  The `RunEvent::Exit` handler shuts down gateway and
/// model sidecars before the process is replaced, avoiding two listeners or a
/// second Dock registration during an update.
pub fn request_relaunch(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.request_restart();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("automatic bundle relaunch is only available on macOS".to_string())
    }
}

/// Bring the already-running foreground bundle to the front when a duplicate
/// launch is attempted.  `open -a` addresses the bundle through LaunchServices
/// rather than starting `Contents/MacOS/kotoba-beacon` directly, so the Dock
/// keeps one application identity.
#[cfg(target_os = "macos")]
pub fn activate_existing_bundle() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = current_bundle_path()?;
        let status =
            std::process::Command::new("/usr/bin/open").arg("-a").arg(&bundle).status().map_err(
                |error| format!("could not activate Kotoba Beacon through LaunchServices: {error}"),
            )?;
        if !status.success() {
            return Err(format!("LaunchServices open exited with {status}"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("LaunchServices activation is only available on macOS".to_string())
    }
}

/// Find the `.app` ancestor for an executable inside
/// `Kotoba Beacon.app/Contents/MacOS/…`.  Keeping this parser pure makes it
/// testable without launching a GUI process.
#[cfg(target_os = "macos")]
pub fn bundle_path_from_executable(executable: &Path) -> Option<PathBuf> {
    executable.ancestors().find_map(|candidate| {
        (candidate.extension().and_then(|extension| extension.to_str()) == Some("app"))
            .then(|| candidate.to_path_buf())
    })
}

#[cfg(target_os = "macos")]
fn current_bundle_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not resolve current executable: {error}"))?;
    let bundle = bundle_path_from_executable(&executable).ok_or_else(|| {
        format!("current executable is not inside an .app bundle: {}", executable.display())
    })?;
    if !bundle.join("Contents/Info.plist").is_file() {
        return Err(format!("bundle is missing Contents/Info.plist: {}", bundle.display()));
    }
    Ok(bundle)
}

#[cfg(test)]
mod smoke_background_tests {
    use super::smoke_background_requested_from;

    #[test]
    fn detects_smoke_background_flag() {
        assert!(smoke_background_requested_from(["kotoba-beacon", "--kotoba-smoke-background"]));
        assert!(!smoke_background_requested_from(["kotoba-beacon"]));
        assert!(!smoke_background_requested_from(["kotoba-beacon", "--kotoba-verify-launch"]));
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::bundle_path_from_executable;
    use std::path::Path;

    #[test]
    fn finds_app_bundle_from_macos_executable_path() {
        assert_eq!(
            bundle_path_from_executable(Path::new(
                "/Applications/Kotoba Beacon.app/Contents/MacOS/kotoba-beacon"
            ))
            .as_deref(),
            Some(Path::new("/Applications/Kotoba Beacon.app")),
        );
    }

    #[test]
    fn does_not_treat_a_plain_binary_as_a_bundle() {
        assert_eq!(bundle_path_from_executable(Path::new("target/debug/kotoba-beacon")), None);
    }

    #[test]
    fn selects_the_nearest_app_ancestor() {
        assert_eq!(
            bundle_path_from_executable(Path::new(
                "/tmp/Outer.app/Contents/Resources/Inner.app/Contents/MacOS/bin"
            ))
            .as_deref(),
            Some(Path::new("/tmp/Outer.app/Contents/Resources/Inner.app")),
        );
    }
}
