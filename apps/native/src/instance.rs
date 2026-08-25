//! Kernel-backed single-instance ownership for the Native application.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(feature = "gpui")]
use caption_bridge_identity::AppIdentity;
use fs2::FileExt;

#[cfg(feature = "gpui")]
const INSTANCE_LOCK_FILE: &str = "native-instance.lock";

static PROCESS_INSTANCE_OWNED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub struct InstanceGuard {
    file: File,
}

#[derive(Debug, thiserror::Error)]
pub enum InstanceError {
    #[error("Kotoba Beacon Native is already running")]
    AlreadyRunning,
    #[error("could not acquire Native instance lock at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
        PROCESS_INSTANCE_OWNED.store(false, Ordering::Release);
    }
}

#[cfg(feature = "gpui")]
pub fn acquire_native_instance() -> Result<InstanceGuard, InstanceError> {
    let data_dir = AppIdentity::native().data_dir();
    std::fs::create_dir_all(&data_dir)
        .map_err(|source| InstanceError::Io { path: data_dir.clone(), source })?;
    acquire_at(&data_dir.join(INSTANCE_LOCK_FILE))
}

fn acquire_at(path: &Path) -> Result<InstanceGuard, InstanceError> {
    if PROCESS_INSTANCE_OWNED.swap(true, Ordering::Acquire) {
        return Err(InstanceError::AlreadyRunning);
    }

    let result = acquire_file_lock(path);
    if result.is_err() {
        PROCESS_INSTANCE_OWNED.store(false, Ordering::Release);
    }
    result
}

fn acquire_file_lock(path: &Path) -> Result<InstanceGuard, InstanceError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|source| InstanceError::Io { path: path.to_path_buf(), source })?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(InstanceGuard { file }),
        Err(source) if source.kind() == io::ErrorKind::WouldBlock => {
            Err(InstanceError::AlreadyRunning)
        }
        Err(source) => Err(InstanceError::Io { path: path.to_path_buf(), source }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{acquire_at, InstanceError};

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn failed_file_lock_does_not_reserve_the_process_slot() {
        let _serial = TEST_LOCK.lock().expect("instance test lock");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("kotoba-native-instance-error-{suffix}"));
        let missing_parent = directory.join("missing").join("instance.lock");
        assert!(matches!(acquire_at(&missing_parent), Err(InstanceError::Io { .. })));

        std::fs::create_dir_all(&directory).expect("create instance test directory");
        let guard = acquire_at(&directory.join("instance.lock"))
            .expect("a failed file lock must release the process slot");
        drop(guard);
        std::fs::remove_dir_all(directory).expect("remove instance test directory");
    }

    #[test]
    fn lock_rejects_a_second_process_owner_and_releases_on_drop() {
        let _serial = TEST_LOCK.lock().expect("instance test lock");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("kotoba-native-instance-{suffix}"));
        std::fs::create_dir_all(&directory).expect("create instance test directory");
        let path = directory.join("instance.lock");

        let first = acquire_at(&path).expect("first instance owns lock");
        assert!(matches!(acquire_at(&path), Err(InstanceError::AlreadyRunning)));
        drop(first);
        let reacquired = acquire_at(&path).expect("lock releases with first owner");

        drop(reacquired);
        std::fs::remove_dir_all(directory).expect("remove instance test directory");
    }
}
