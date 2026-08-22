//! Framework-agnostic process supervisor for the Kotoba Beacon sidecars
//! (Parapper, inference-gateway, llama-server, zenz-server).
//!
//! The Tauri desktop app spawns these via `tauri_plugin_shell::sidecar`. A
//! GPUI implementation has no such helper, so this crate extracts the *argument
//! builders, ports, ready-wait, and kill-on-port* logic into something any GUI
//! framework can reuse.
//!
//! The Tauri implementation under `apps/desktop/src-tauri/src/{gateway,
//! model_runtime}.rs` is the source of truth for the locked flag strings and
//! fixed quality constants. This crate does not require the real sidecar
//! binaries to exist; argument construction and command planning are tested
//! purely, and process spawning only happens when an explicit readiness/polling
//! caller drives it.
#![forbid(unsafe_code)]

use std::fmt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// Every loopback port the sidecar set uses. The Tauri app owns one identity;
/// the native (GPUI) app owns a second that is uniformly shifted by `+100` so
/// the two can coexist on one machine without binding collisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PortMap {
    pub gateway: u16,
    pub parapper: u16,
    pub zenz_xsmall: u16,
    pub zenz_small: u16,
    pub llama_1_8b: u16,
    pub llama_7b: u16,
    pub browser_source: u16,
}

/// The Tauri desktop app's fixed port identity. Matches `config.rs` endpoint
/// defaults, `gateway.rs` `GATEWAY_PORT`/`PARAPPER_PORT`, and `model_runtime.rs`
/// `MODEL_RUNTIME_SPECS` ports (8081..=8087). `6007` is unused today; it is kept
/// so `grep` for a drifted port is unambiguous.
pub const TAURI_PORTS: PortMap = PortMap {
    gateway: 8765,
    parapper: 18_082,
    zenz_xsmall: 8081,
    zenz_small: 8082,
    llama_1_8b: 8083,
    llama_7b: 8086,
    browser_source: 1421,
};

impl PortMap {
    /// The identity owned by the Tauri desktop app.
    pub const fn tauri() -> PortMap {
        TAURI_PORTS
    }

    /// The identity owned by the native (GPUI) app: every `tauri()` field plus
    /// 100. Kept as a named constant so a caller cannot accidentally mix the
    /// two identities when wiring a supervisor.
    pub const fn native() -> PortMap {
        PortMap {
            gateway: TAURI_PORTS.gateway + 100,
            parapper: TAURI_PORTS.parapper + 100,
            zenz_xsmall: TAURI_PORTS.zenz_xsmall + 100,
            zenz_small: TAURI_PORTS.zenz_small + 100,
            llama_1_8b: TAURI_PORTS.llama_1_8b + 100,
            llama_7b: TAURI_PORTS.llama_7b + 100,
            browser_source: TAURI_PORTS.browser_source + 100,
        }
    }
}

/// Fixed Parapper headless quality settings from `gateway.rs`. These are part
/// of the desktop-to-sidecar command contract (see `PARAPPER_INTERIM_RESULT_
/// SILENCE_MS`, `PARAPPER_TURN_CHECK_SILENCE_MS`, `PARAPPER_TURN_DETECTOR`) and
/// must stay byte-for-byte synchronized with the Tauri side.
pub const PARAPPER_INTERIM_RESULT_SILENCE_MS: u32 = 96;
pub const PARAPPER_TURN_CHECK_SILENCE_MS: u32 = 480;
/// Parapper interim-streaming ASR model identifiers from `config.rs`.
pub const STREAMING_INTERIM_ASR_MODEL_ID: &str = "nemotron_3_5_asr_streaming_0_6b_160ms_int8";
pub const STREAMING_INTERIM_ASR_MODEL_OFF: &str = "none";

/// llama-server/zenz-server fixed flags from `model_runtime::sidecar_arguments`.
pub const MODEL_SERVER_CTX_SIZE: &str = "4096";
pub const MODEL_SERVER_HOST: &str = "127.0.0.1";

/// The headless Parapper command line, matching `gateway.rs`
/// `parapper_headless_args_with_noise_cancellation`. Noise cancellation is
/// locked on (the desktop default) and interim streaming is selected by the
/// boolean exactly as `streaming_interim_asr_cli_value` does.
pub fn parapper_args(
    port: u16,
    vad_interval_ms: u32,
    vad_threshold: f32,
    streaming_interim: bool,
) -> Vec<String> {
    let interim_model = if streaming_interim {
        STREAMING_INTERIM_ASR_MODEL_ID
    } else {
        STREAMING_INTERIM_ASR_MODEL_OFF
    };
    vec![
        "--headless".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--vad-interval-ms".to_string(),
        vad_interval_ms.to_string(),
        "--vad-threshold".to_string(),
        vad_threshold.to_string(),
        "--interim-result-silence-ms".to_string(),
        PARAPPER_INTERIM_RESULT_SILENCE_MS.to_string(),
        "--turn-check-silence-ms".to_string(),
        PARAPPER_TURN_CHECK_SILENCE_MS.to_string(),
        "--noise-cancellation-enabled".to_string(),
        "true".to_string(),
        "--interim-asr-model".to_string(),
        interim_model.to_string(),
    ]
}

/// The inference-gateway command line. The Tauri desktop CLI is exactly
/// `--config <path>` (see `gateway.rs` `start`), where `<path>` points at an
/// embedded gateway config JSON written to the app-config directory.
pub fn gateway_args(config_path: &Path) -> Vec<String> {
    vec!["--config".to_string(), config_path.to_string_lossy().into_owned()]
}

/// Shared zenz/llama server command line, matching `model_runtime.rs`
/// `sidecar_arguments`. `alias` is the model id (e.g. `hy-mt2-1.8b-gguf`); the
/// `--ctx-size` cap keeps llama-server from allocating multi-hundred-k KV and
/// delaying `/health` readiness.
fn model_server_args(model_path: &Path, port: u16, alias: &str) -> Vec<String> {
    vec![
        "--model".to_string(),
        model_path.to_string_lossy().into_owned(),
        "--host".to_string(),
        MODEL_SERVER_HOST.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--alias".to_string(),
        alias.to_string(),
        "--jinja".to_string(),
        "--ctx-size".to_string(),
        MODEL_SERVER_CTX_SIZE.to_string(),
        "--parallel".to_string(),
        "1".to_string(),
    ]
}

/// zenz-server argument builder. Both bundled servers share one CLI shape.
pub fn zenz_server_args(model_path: &Path, port: u16, alias: &str) -> Vec<String> {
    model_server_args(model_path, port, alias)
}

/// llama-server argument builder. Both bundled servers share one CLI shape.
pub fn llama_server_args(model_path: &Path, port: u16, alias: &str) -> Vec<String> {
    model_server_args(model_path, port, alias)
}

/// A ready-check: either a URL to poll over HTTP or a TCP connect probe.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ReadyCheck {
    /// Poll `GET <url>` until it returns a 2xx status.
    Http { url: String },
    /// Probe a TCP connect on `host:port`.
    Tcp { host: String, port: u16 },
}

/// Describes one sidecar process without tying it to a runtime/framework.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SidecarSpec {
    /// Logical id used in diagnostics (e.g. `kotoba-parapper`).
    pub name: String,
    /// Executable name or path passed to `Command::new`.
    pub program: String,
    /// Command-line vector as built by the argument helpers.
    pub argv: Vec<String>,
    /// Loopback port this process owns (used by kill-on-port and diagnostics).
    pub port: u16,
    /// Optional readiness probe. `None` means spawn-only, no ready-wait.
    pub ready: Option<ReadyCheck>,
    /// Environment variables to set for the child process.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
}

impl SidecarSpec {
    pub fn new(
        name: impl Into<String>,
        program: impl Into<String>,
        argv: Vec<String>,
        port: u16,
        ready: Option<ReadyCheck>,
    ) -> Self {
        Self { name: name.into(), program: program.into(), argv, port, ready, env: Vec::new() }
    }

    /// Set environment variables for the sidecar. Later calls append.
    pub fn with_env(
        mut self,
        env: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        self.env = env.into_iter().map(|(key, value)| (key.into(), value.into())).collect();
        self
    }
}

/// Errors surfaced by the supervisor.
#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("failed to run auxiliary command `{0}`: {1}")]
    AuxCommand(String, #[source] std::io::Error),
    #[error("{label} did not become ready at {target} within {attempts}s")]
    NotReady { label: String, target: String, attempts: u32 },
    #[error("spawn failed for {program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot kill process: {0}")]
    Kill(#[source] std::io::Error),
}

/// Per-port kill plan. Unix uses `lsof` + `kill -9`. Windows uses
/// `netstat` + `taskkill` command construction only — the supervisor never
/// calls `lsof` on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillPlan {
    /// Port this plan would clear.
    pub port: u16,
    /// Discovery command that lists listener pids on the port.
    pub discover: Vec<String>,
    /// Kill command template; fill in each pid from discover output.
    pub kill: Vec<String>,
    /// Unix-only alias of [`Self::discover`] so existing tests keep reading `lsof`.
    pub lsof: Vec<String>,
}

impl KillPlan {
    /// Construct the platform kill argv for clearing `port`.
    pub fn for_port(port: u16) -> KillPlan {
        #[cfg(unix)]
        {
            unix_kill_plan(port)
        }
        #[cfg(windows)]
        {
            windows_kill_plan(port)
        }
        #[cfg(not(any(unix, windows)))]
        {
            KillPlan { port, discover: Vec::new(), kill: Vec::new(), lsof: Vec::new() }
        }
    }
}

/// Unix `lsof -ti :PORT` then `kill -9 <pid>`.
pub fn unix_kill_plan(port: u16) -> KillPlan {
    let discover = vec!["lsof".to_string(), "-ti".to_string(), format!(":{port}")];
    KillPlan {
        port,
        lsof: discover.clone(),
        discover,
        kill: vec!["kill".to_string(), "-9".to_string(), "<pid>".to_string()],
    }
}

/// Windows `netstat` + `taskkill` construction. Never executed from unit tests.
///
/// `netstat -ano -p TCP` lists listeners; a Windows host then filters the
/// `:PORT` local address before `taskkill /F /PID`. This Mac only locks argv.
pub fn windows_kill_plan(port: u16) -> KillPlan {
    let discover = vec![
        "netstat".to_string(),
        "-ano".to_string(),
        "-p".to_string(),
        "TCP".to_string(),
        format!(":{port}"),
    ];
    KillPlan {
        port,
        lsof: Vec::new(),
        discover,
        kill: vec![
            "taskkill".to_string(),
            "/F".to_string(),
            "/PID".to_string(),
            "<pid>".to_string(),
        ],
    }
}

/// Spawns/supervises a single sidecar child process. Holds the `std::process::
/// Child` handle directly; dropping it does not kill the child, so callers that
/// want best-effort cleanup should call [`ChildSupervisor::stop`] on `Drop` or
/// keep the kill-on-port plan around for crash recovery.
pub struct ChildSupervisor {
    spec: SidecarSpec,
    child: Option<Child>,
    /// Best-effort clear of a stale listener before spawning (Unix only).
    #[cfg(unix)]
    clear_port_first: bool,
}

#[cfg(unix)]
impl fmt::Debug for ChildSupervisor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildSupervisor")
            .field("spec", &self.spec)
            .field("child_pid", &self.child.as_ref().map(Child::id))
            .field("clear_port_first", &self.clear_port_first)
            .finish()
    }
}

#[cfg(not(unix))]
impl fmt::Debug for ChildSupervisor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildSupervisor")
            .field("spec", &self.spec)
            .field("child_pid", &self.child.as_ref().map(Child::id))
            .finish()
    }
}

impl ChildSupervisor {
    pub fn new(spec: SidecarSpec) -> Self {
        Self {
            spec,
            child: None,
            #[cfg(unix)]
            clear_port_first: false,
        }
    }

    #[cfg(unix)]
    pub fn with_port_clear(mut self, enabled: bool) -> Self {
        self.clear_port_first = enabled;
        self
    }

    pub fn spec(&self) -> &SidecarSpec {
        &self.spec
    }

    pub fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// Spawn the child, optionally clearing a stale listener on its port first.
    /// On failure the child handle is dropped and the error returned.
    pub fn start(&mut self) -> Result<(), SupervisorError> {
        #[cfg(unix)]
        if self.clear_port_first {
            clear_port(self.spec.port);
        }
        let mut command = Command::new(&self.spec.program);
        command.args(&self.spec.argv).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (key, value) in &self.spec.env {
            command.env(key, value);
        }
        let child = command.spawn().map_err(|source| SupervisorError::Spawn {
            program: self.spec.program.clone(),
            source,
        })?;
        self.child = Some(child);
        Ok(())
    }

    /// Wait until the configured readiness probe succeeds, up to `attempts`
    /// one-second checks. Returns `Ok` immediately when the spec has no probe.
    pub fn wait_until_ready(&self, attempts: u32) -> Result<(), SupervisorError> {
        let Some(ready) = &self.spec.ready else {
            return Ok(());
        };
        for _ in 0..attempts {
            if ready_check_succeeds(ready) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        let target = match ready {
            ReadyCheck::Http { url } => url.clone(),
            ReadyCheck::Tcp { host, port } => format!("{host}:{port}"),
        };
        Err(SupervisorError::NotReady { label: self.spec.name.clone(), target, attempts })
    }

    /// Kill the spawned child, if any, and drop the handle. No-op when no child
    /// was spawned (or it already exited).
    pub fn stop(&mut self) -> Result<(), SupervisorError> {
        if let Some(mut child) = self.child.take() {
            child.kill().map_err(SupervisorError::Kill)?;
            let _ = child.wait();
        }
        Ok(())
    }
}

/// One HTTP GET `/health`-style readiness poll, dependency-free over a loopback
/// `TcpStream`. Returns true only when a 2xx response line is observed.
fn http_ready_succeeds(url: &str, read_timeout: Duration) -> bool {
    use std::io::{Read, Write};
    let host = "127.0.0.1";
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (scheme, rest),
        None => ("http", url),
    };
    if scheme != "http" {
        return false;
    }
    let (authority, path) = match rest.find('/') {
        Some(idx) => rest.split_at(idx),
        None => (rest, "/"),
    };
    let path = if path.is_empty() { "/" } else { path };
    let port =
        authority.rsplit_once(':').and_then(|(_, port)| port.parse::<u16>().ok()).unwrap_or(80);
    let mut stream = match std::net::TcpStream::connect((host, port)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(read_timeout));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0_u8; 64];
    match stream.read(&mut response) {
        Err(_) => false,
        Ok(0) => false,
        Ok(read) => status_is_2xx(&response[..read]),
    }
}

/// True when the leading HTTP status line carries a 2xx code. Looks for the
/// `420`-style fixed offset so a "204 No Content" probe still counts, but only
/// after confirming the response actually starts with `HTTP/1`.
fn status_is_2xx(response: &[u8]) -> bool {
    if response.len() < 12 || !response.starts_with(b"HTTP/1.") {
        return false;
    }
    let status = &response[9..12];
    status[0] == b'2' && status[1].is_ascii_digit() && status[2].is_ascii_digit()
}

fn ready_check_succeeds(ready: &ReadyCheck) -> bool {
    match ready {
        ReadyCheck::Http { url } => http_ready_succeeds(url, Duration::from_secs(2)),
        ReadyCheck::Tcp { host, port } => {
            std::net::TcpStream::connect((host.as_str(), *port)).is_ok()
        }
    }
}

/// Best-effort `lsof -ti :PORT | kill -9` cleanup, mirroring `gateway.rs`
/// `kill_port`. Only Unix; failures are ignored.
#[cfg(unix)]
pub fn clear_port(port: u16) {
    let plan = KillPlan::for_port(port);
    let output = match std::process::Command::new(&plan.lsof[0]).args(&plan.lsof[1..]).output() {
        Ok(output) => output,
        Err(_) => return,
    };
    if !output.status.success() {
        return;
    }
    let pids = String::from_utf8_lossy(&output.stdout);
    for pid in pids.split_whitespace() {
        let _ =
            std::process::Command::new(&plan.kill[0]).args([plan.kill[2].as_str(), pid]).output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tauri() -> PortMap {
        PortMap::tauri()
    }

    #[test]
    fn native_ports_are_tauri_ports_plus_100_on_every_field() {
        let lo = tauri();
        let hi = PortMap::native();
        assert_eq!(hi.gateway, lo.gateway + 100);
        assert_eq!(hi.parapper, lo.parapper + 100);
        assert_eq!(hi.zenz_xsmall, lo.zenz_xsmall + 100);
        assert_eq!(hi.zenz_small, lo.zenz_small + 100);
        assert_eq!(hi.llama_1_8b, lo.llama_1_8b + 100);
        assert_eq!(hi.llama_7b, lo.llama_7b + 100);
        assert_eq!(hi.browser_source, lo.browser_source + 100);
    }

    #[test]
    fn tauri_ports_lock_the_desktop_identities() {
        let lo = tauri();
        assert_eq!(lo.gateway, 8765);
        assert_eq!(lo.parapper, 18_082);
        assert_eq!(lo.zenz_xsmall, 8081);
        assert_eq!(lo.zenz_small, 8082);
        assert_eq!(lo.llama_1_8b, 8083);
        assert_eq!(lo.llama_7b, 8086);
        assert_eq!(lo.browser_source, 1421);
    }

    #[test]
    fn native_ports_lock_the_gpui_identities() {
        let hi = PortMap::native();
        assert_eq!(hi.gateway, 8865);
        assert_eq!(hi.parapper, 18_182);
        assert_eq!(hi.zenz_xsmall, 8181);
        assert_eq!(hi.zenz_small, 8182);
        assert_eq!(hi.llama_1_8b, 8183);
        assert_eq!(hi.llama_7b, 8186);
        assert_eq!(hi.browser_source, 1521);
    }

    #[test]
    fn parapper_argv_matches_the_lock_strings_from_gateway_rs() {
        let args = parapper_args(18_182, 32, 0.5, false);
        assert_eq!(
            args,
            vec![
                "--headless",
                "--port",
                "18182",
                "--vad-interval-ms",
                "32",
                "--vad-threshold",
                "0.5",
                "--interim-result-silence-ms",
                "96",
                "--turn-check-silence-ms",
                "480",
                "--noise-cancellation-enabled",
                "true",
                "--interim-asr-model",
                "none",
            ]
        );
    }

    #[test]
    fn parapper_streaming_interim_selects_the_streaming_model() {
        let args = parapper_args(18_182, 32, 0.5, true);
        assert!(args.ends_with(&[
            "--interim-asr-model".to_string(),
            "nemotron_3_5_asr_streaming_0_6b_160ms_int8".to_string(),
        ]));
    }

    #[test]
    fn gateway_argv_is_config_flag_plus_path() {
        let args = gateway_args(Path::new("/tmp/kotoba-beacon/gateway.config.json"));
        assert_eq!(args, vec!["--config", "/tmp/kotoba-beacon/gateway.config.json"]);
    }

    #[test]
    fn llama_server_argv_matches_model_runtime_rs() {
        let args = llama_server_args(
            Path::new("/tmp/models/hy-mt2-1.8b-gguf/Hy-MT2-1.8B-Q4_K_M.gguf"),
            8183,
            "hy-mt2-1.8b-gguf",
        );
        assert_eq!(
            args,
            vec![
                "--model",
                "/tmp/models/hy-mt2-1.8b-gguf/Hy-MT2-1.8B-Q4_K_M.gguf",
                "--host",
                "127.0.0.1",
                "--port",
                "8183",
                "--alias",
                "hy-mt2-1.8b-gguf",
                "--jinja",
                "--ctx-size",
                "4096",
                "--parallel",
                "1",
            ]
        );
    }

    #[test]
    fn zenz_server_argv_shares_the_model_server_shape() {
        let args = zenz_server_args(
            Path::new("/tmp/models/zenz-v3.2-small-gguf/ggml-model-Q5_K_M.gguf"),
            8182,
            "zenz-v3.2-small-gguf",
        );
        assert!(args.windows(2).any(|pair| pair == ["--port", "8182"]));
        assert!(args.windows(2).any(|pair| pair == ["--ctx-size", "4096"]));
        assert!(args.windows(2).any(|pair| pair == ["--parallel", "1"]));
    }

    #[test]
    fn supervisor_constructs_and_drops_without_spawning() {
        let spec = SidecarSpec::new(
            "kotoba-parapper",
            "kotoba-parapper",
            parapper_args(18_182, 32, 0.5, false),
            18_182,
            Some(ReadyCheck::Tcp { host: "127.0.0.1".to_string(), port: 18_182 }),
        );
        let supervisor = ChildSupervisor::new(spec);
        assert_eq!(supervisor.spec().name, "kotoba-parapper");
        assert_eq!(supervisor.child_pid(), None);
    }

    #[test]
    fn sidecar_spec_with_env_sets_environment_for_child() {
        let spec = SidecarSpec::new(
            "kotoba-parapper",
            "kotoba-parapper",
            parapper_args(18_182, 32, 0.5, false),
            18_182,
            Some(ReadyCheck::Tcp { host: "127.0.0.1".to_string(), port: 18_182 }),
        )
        .with_env([("PARAPPER_RUNTIME_DIR", "/tmp/native-parapper")]);
        assert_eq!(spec.env.len(), 1);
        assert_eq!(spec.env[0].0, "PARAPPER_RUNTIME_DIR");
        assert_eq!(spec.env[0].1, "/tmp/native-parapper");
    }

    #[test]
    fn kill_plan_is_exactly_lsof_then_kill_9() {
        let plan = KillPlan::for_port(8183);
        assert_eq!(plan.lsof, vec!["lsof", "-ti", ":8183"]);
        assert_eq!(plan.discover, vec!["lsof", "-ti", ":8183"]);
        assert_eq!(plan.kill, vec!["kill", "-9", "<pid>"]);
        assert_eq!(plan.port, 8183);
    }

    #[test]
    fn windows_kill_plan_is_netstat_then_taskkill_and_never_lsof() {
        let plan = windows_kill_plan(8183);
        assert_eq!(plan.discover, vec!["netstat", "-ano", "-p", "TCP", ":8183"]);
        assert_eq!(plan.kill, vec!["taskkill", "/F", "/PID", "<pid>"]);
        assert_eq!(plan.lsof, Vec::<String>::new());
        assert_eq!(plan.port, 8183);
        assert_ne!(plan.discover[0], "lsof");
    }

    #[test]
    fn port_map_serializes_round_trip() {
        let value = serde_json::to_value(PortMap::native()).expect("serialize native ports");
        assert_eq!(value["gateway"], 8865);
        let back: PortMap = serde_json::from_value(value).expect("deserialize native ports");
        assert_eq!(back, PortMap::native());
    }
}
