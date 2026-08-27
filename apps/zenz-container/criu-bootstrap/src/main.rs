use std::env;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

const CHECKPOINT_DIR: &str = "/opt/criu-checkpoint/criu-llama";
const ERROR_SERVER_ENV: &str = "CRIU_BOOTSTRAP_ERROR_SERVER";
const HTTP_BIND_ADDRESS: &str = "0.0.0.0:8080";
const CRIU_PATH: &str = "/usr/local/sbin/criu";
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const RESTORE_LOG: &str = "/run/criu-restore/restore.log";
const RESTORED_PID_FILE: &str = "/run/criu-restore/restored.pid";
const SETARCH_PATH: &str = "/usr/bin/setarch";
const WORK_DIR: &str = "/run/criu-restore";

type BootstrapResult<T> = Result<T, Box<dyn Error>>;

fn parse_pid(value: &str) -> BootstrapResult<u32> {
    Ok(value.trim().parse()?)
}

fn parse_process_state(stat: &str) -> BootstrapResult<char> {
    let (_, fields) =
        stat.rsplit_once(") ").ok_or("process stat does not contain a command terminator")?;
    fields.chars().next().ok_or_else(|| "process stat does not contain a state".into())
}

fn prepare_work_dir() -> BootstrapResult<()> {
    let work_dir = Path::new(WORK_DIR);
    if work_dir.exists() {
        fs::remove_dir_all(work_dir)?;
    }
    fs::create_dir_all(work_dir)?;
    Ok(())
}

fn restore() -> BootstrapResult<(u32, Duration)> {
    prepare_work_dir()?;
    let started_at = Instant::now();
    let status = Command::new(SETARCH_PATH)
        .args([
            "x86_64",
            "-R",
            CRIU_PATH,
            "restore",
            "--images-dir",
            CHECKPOINT_DIR,
            "--work-dir",
            WORK_DIR,
            "--shell-job",
            "--restore-detached",
            "--pidfile",
            RESTORED_PID_FILE,
            "--log-file",
            RESTORE_LOG,
            "--cpu-cap=none",
            "-v2",
        ])
        .status()?;
    if !status.success() {
        let log = fs::read_to_string(RESTORE_LOG).unwrap_or_else(|error| error.to_string());
        return Err(format!("CRIU restore failed with {status}: {log}").into());
    }
    let restored_pid = parse_pid(&fs::read_to_string(RESTORED_PID_FILE)?)?;
    Ok((restored_pid, started_at.elapsed()))
}

fn wait_for_process(pid: u32) -> BootstrapResult<()> {
    let stat_path = PathBuf::from(format!("/proc/{pid}/stat"));
    while stat_path.exists() {
        let state = parse_process_state(&fs::read_to_string(&stat_path)?)?;
        if state == 'Z' {
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

fn run() -> BootstrapResult<()> {
    let (restored_pid, elapsed) = restore()?;
    println!("criu_restore_ms={}", elapsed.as_millis());
    println!("restored_pid={restored_pid}");
    wait_for_process(restored_pid)
}

fn error_response(message: &str) -> Vec<u8> {
    let body = format!("CRIU bootstrap failed: {message}\n");
    format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn serve_error(message: &str) -> BootstrapResult<()> {
    let listener = TcpListener::bind(HTTP_BIND_ADDRESS)?;
    let response = error_response(message);
    for stream in listener.incoming() {
        let mut stream = stream?;
        let mut request = [0_u8; 1024];
        let _bytes_read = stream.read(&mut request)?;
        stream.write_all(&response)?;
        stream.flush()?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("CRIU bootstrap failed: {error}");
            if env::var(ERROR_SERVER_ENV).as_deref() == Ok("1")
                && let Err(server_error) = serve_error(&error.to_string())
            {
                eprintln!("CRIU bootstrap error server failed: {server_error}");
                return ExitCode::FAILURE;
            }
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{error_response, parse_pid, parse_process_state};

    #[test]
    fn parses_restored_pid() {
        assert_eq!(parse_pid("2000\n").expect("PID should parse"), 2000);
    }

    #[test]
    fn parses_running_process_state_with_spaces_in_command() {
        assert_eq!(
            parse_process_state("2000 (llama server) S 1 2 3").expect("state should parse"),
            'S'
        );
    }

    #[test]
    fn rejects_process_stat_without_command_terminator() {
        assert_eq!(
            parse_process_state("2000 llama-server S 1 2 3")
                .expect_err("invalid stat should fail")
                .to_string(),
            "process stat does not contain a command terminator"
        );
    }

    #[test]
    fn builds_bounded_http_error_response() {
        assert_eq!(
            String::from_utf8(error_response("restore error")).expect("response should be UTF-8"),
            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 37\r\nConnection: close\r\n\r\nCRIU bootstrap failed: restore error\n"
        );
    }
}
