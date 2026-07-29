use crate::config::AppConfig;
use crate::native_output::NativeOutputHandle;
use crate::output::OutputStatus;
use crate::pipeline::Pipeline;
use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub status: String,
    pub platform: String,
    pub backend_reachable: bool,
    pub native_output: String,
    pub last_error: Option<String>,
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub status: Mutex<RuntimeStatus>,
    pub pipeline: Pipeline,
    pub native_output: Mutex<NativeOutputHandle>,
}

impl AppState {
    pub fn new(config: AppConfig, output: OutputStatus) -> Self {
        let native_output = NativeOutputHandle::new(config.overlay.width, config.overlay.height);
        let native_output_kind = native_output.kind().to_string();
        Self {
            config: Mutex::new(config),
            status: Mutex::new(RuntimeStatus {
                status: "idle".to_string(),
                platform: output.platform,
                backend_reachable: false,
                native_output: native_output_kind,
                last_error: None,
            }),
            pipeline: Pipeline::default(),
            native_output: Mutex::new(native_output),
        }
    }
}
