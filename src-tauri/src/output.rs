#[derive(Debug, Clone)]
pub struct OutputStatus {
    pub platform: String,
}

pub fn runtime_output() -> OutputStatus {
    #[cfg(windows)]
    let platform = "windows";
    #[cfg(target_os = "macos")]
    let platform = "macos";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let platform = "unknown";

    OutputStatus { platform: platform.to_string() }
}
