//! Opt-in, bounded JSONL diagnostics for caption-pipeline fault isolation.
//!
//! Caption text can be sensitive, so production logging stays disabled unless
//! `KOTOBA_PIPELINE_DIAGNOSTICS=1` is set or the opt-in marker exists.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use caption_bridge_identity::AppIdentity;
use serde::Serialize;

use crate::domain::BUILD_ID;

#[cfg(not(test))]
const DIAGNOSTICS_ENV: &str = "KOTOBA_PIPELINE_DIAGNOSTICS";
const DIAGNOSTICS_DIRECTORY_NAME: &str = "diagnostics";
#[cfg(not(test))]
const ENABLED_MARKER_NAME: &str = "pipeline.enabled";
const LOG_FILE_NAME: &str = "pipeline.jsonl";
const ROTATED_LOG_FILE_NAME: &str = "pipeline.jsonl.1";
const LOG_SCHEMA_VERSION: u8 = 1;
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

static WRITER: OnceLock<Mutex<Option<PipelineDiagnosticWriter>>> = OnceLock::new();
static SESSION_STARTED_UNIX_MS: OnceLock<u128> = OnceLock::new();
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
struct DiagnosticEnvelope<'a, T> {
    schema_version: u8,
    timestamp_unix_ms: u128,
    session_started_unix_ms: u128,
    process_id: u32,
    sequence: u64,
    build_id: &'static str,
    stage: &'a str,
    payload: &'a T,
}

struct PipelineDiagnosticWriter {
    path: PathBuf,
    rotated_path: PathBuf,
    file: File,
    bytes_written: u64,
    max_bytes: u64,
}

impl PipelineDiagnosticWriter {
    fn open(path: PathBuf, max_bytes: u64) -> io::Result<Self> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "diagnostic log has no parent")
        })?;
        fs::create_dir_all(parent)?;
        restrict_directory_permissions(parent)?;
        let rotated_path = parent.join(ROTATED_LOG_FILE_NAME);
        if path.metadata().is_ok_and(|metadata| metadata.len() >= max_bytes) {
            rotate_files(&path, &rotated_path)?;
        }
        let file = open_private_append_file(&path)?;
        let bytes_written = file.metadata()?.len();
        Ok(Self { path, rotated_path, file, bytes_written, max_bytes })
    }

    fn write<T: Serialize>(&mut self, stage: &str, payload: &T) -> io::Result<()> {
        let timestamp_unix_ms = unix_time_millis();
        let envelope = DiagnosticEnvelope {
            schema_version: LOG_SCHEMA_VERSION,
            timestamp_unix_ms,
            session_started_unix_ms: *SESSION_STARTED_UNIX_MS.get_or_init(unix_time_millis),
            process_id: std::process::id(),
            sequence: EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            build_id: BUILD_ID,
            stage,
            payload,
        };
        let mut line = serde_json::to_vec(&envelope).map_err(io::Error::other)?;
        line.push(b'\n');
        let line_bytes = u64::try_from(line.len()).unwrap_or(u64::MAX);
        if self.bytes_written.saturating_add(line_bytes) > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(&line)?;
        self.file.flush()?;
        self.bytes_written = self.bytes_written.saturating_add(line_bytes);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        rotate_files(&self.path, &self.rotated_path)?;
        self.file = open_private_append_file(&self.path)?;
        self.bytes_written = 0;
        Ok(())
    }
}

/// Record one pipeline stage when explicit transcript diagnostics are enabled.
///
/// The logger never stores PCM audio. It retains at most the current 4 MiB
/// JSONL file plus one rotated file and flushes every record for post-exit use.
pub(crate) fn record_pipeline_event<T: Serialize>(stage: &str, payload: &T) {
    let path = pipeline_diagnostics_log_path();
    record_pipeline_event_with(
        pipeline_diagnostics_enabled(),
        WRITER.get_or_init(|| Mutex::new(None)),
        &path,
        MAX_LOG_BYTES,
        stage,
        payload,
    );
}

fn record_pipeline_event_with<T: Serialize>(
    enabled: bool,
    writer: &Mutex<Option<PipelineDiagnosticWriter>>,
    path: &Path,
    max_bytes: u64,
    stage: &str,
    payload: &T,
) {
    if !enabled {
        return;
    }
    let Ok(mut writer) = writer.lock() else {
        return;
    };
    if writer.is_none() {
        *writer = PipelineDiagnosticWriter::open(path.to_path_buf(), max_bytes).ok();
    }
    if let Some(writer) = writer.as_mut() {
        let _ = writer.write(stage, payload);
    }
}

pub(crate) fn pipeline_diagnostics_directory() -> PathBuf {
    AppIdentity::native().data_dir().join(DIAGNOSTICS_DIRECTORY_NAME)
}

#[cfg(not(test))]
pub(crate) fn pipeline_diagnostics_enabled_marker_path() -> PathBuf {
    pipeline_diagnostics_directory().join(ENABLED_MARKER_NAME)
}

pub(crate) fn pipeline_diagnostics_log_path() -> PathBuf {
    pipeline_diagnostics_directory().join(LOG_FILE_NAME)
}

#[cfg(not(test))]
fn pipeline_diagnostics_enabled() -> bool {
    environment_enables_diagnostics() || pipeline_diagnostics_enabled_marker_path().is_file()
}

#[cfg(test)]
fn pipeline_diagnostics_enabled() -> bool {
    false
}

#[cfg(not(test))]
fn environment_enables_diagnostics() -> bool {
    std::env::var(DIAGNOSTICS_ENV).is_ok_and(|value| {
        matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
    })
}

fn unix_time_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis())
}

fn rotate_files(path: &Path, rotated_path: &Path) -> io::Result<()> {
    match fs::remove_file(rotated_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match fs::rename(path, rotated_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn open_private_append_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(0o600);
    }
    let file = options.open(path)?;
    restrict_file_permissions(path)?;
    Ok(file)
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        pipeline_diagnostics_directory, pipeline_diagnostics_log_path, record_pipeline_event,
        record_pipeline_event_with, rotate_files, PipelineDiagnosticWriter, LOG_SCHEMA_VERSION,
    };
    use serde_json::json;
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn diagnostic_writer_emits_correlated_json_and_rotates_at_the_bound() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock should follow unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir()
            .join(format!("kotoba-pipeline-diagnostics-{}-{nonce}", std::process::id()));
        let path = directory.join("pipeline.jsonl");
        let mut writer =
            PipelineDiagnosticWriter::open(path.clone(), 700).expect("open diagnostic writer");

        writer
            .write(
                "asr_engine_caption",
                &json!({"revision": 7, "surface": "六十体", "canonical_reading": "ろくじゅうたい"}),
            )
            .expect("write first diagnostic");
        let first = fs::read_to_string(&path).expect("read first diagnostic");
        let first: serde_json::Value =
            serde_json::from_str(first.trim()).expect("parse first diagnostic");
        assert_eq!(first["schema_version"], LOG_SCHEMA_VERSION);
        assert!(first["sequence"].as_u64().is_some_and(|sequence| sequence > 0));
        assert_eq!(first["stage"], "asr_engine_caption");
        assert_eq!(first["payload"]["revision"], 7);
        assert_eq!(first["payload"]["surface"], "六十体");

        let large_text = "あ".repeat(600);
        writer
            .write("ui_caption_applied", &json!({"source": large_text}))
            .expect("write rotating diagnostic");
        assert!(directory.join("pipeline.jsonl.1").is_file());
        assert!(path.is_file());

        fs::remove_dir_all(directory).expect("remove diagnostic fixture");
    }

    #[test]
    fn diagnostic_entrypoint_honors_enablement_and_builds_bounded_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock should follow unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir()
            .join(format!("kotoba-pipeline-entrypoint-{}-{nonce}", std::process::id()));
        let path = directory.join("pipeline.jsonl");
        let writer = Mutex::new(None);

        record_pipeline_event_with(false, &writer, &path, 1_024, "disabled", &json!({"id": 1}));
        assert!(!path.exists());
        record_pipeline_event_with(true, &writer, &path, 1_024, "enabled", &json!({"id": 2}));
        assert!(fs::read_to_string(&path).expect("read enabled event").contains("\"enabled\""));

        record_pipeline_event("test-disabled", &json!({"id": 3}));
        assert!(pipeline_diagnostics_directory().ends_with("diagnostics"));
        assert!(pipeline_diagnostics_log_path().ends_with("diagnostics/pipeline.jsonl"));

        drop(writer);
        fs::remove_dir_all(directory).expect("remove diagnostic entrypoint fixture");
    }

    #[test]
    fn diagnostic_open_rotates_an_existing_full_log_and_rejects_parentless_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock should follow unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir()
            .join(format!("kotoba-pipeline-open-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).expect("create diagnostic open fixture");
        let path = directory.join("pipeline.jsonl");
        fs::write(&path, "already full").expect("seed full diagnostic log");

        let writer = PipelineDiagnosticWriter::open(path.clone(), 1).expect("rotate full log");
        assert_eq!(writer.bytes_written, 0);
        assert_eq!(
            fs::read_to_string(directory.join("pipeline.jsonl.1")).expect("read rotated log"),
            "already full"
        );
        assert!(PipelineDiagnosticWriter::open(std::path::PathBuf::new(), 1).is_err());
        rotate_files(&directory.join("missing.jsonl"), &directory.join("missing.jsonl.1"))
            .expect("missing source does not require rotation");

        drop(writer);
        fs::remove_dir_all(directory).expect("remove diagnostic open fixture");
    }
}
