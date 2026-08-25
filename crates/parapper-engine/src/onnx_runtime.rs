use std::sync::OnceLock;

use anyhow::{Result, anyhow};
use ort::execution_providers::CPUExecutionProvider;

static ORT_INIT: OnceLock<Result<()>> = OnceLock::new();

pub(crate) fn init_onnx_runtime() -> Result<()> {
    match ORT_INIT.get_or_init(|| {
        let committed = ort::init()
            .with_name("parapper")
            .with_telemetry(false)
            .with_execution_providers([CPUExecutionProvider::default().build()])
            .commit();
        if !committed {
            return Err(anyhow!("Failed to configure ONNX Runtime before first use"));
        }
        ort::environment::Environment::current()
            .map(|_| ())
            .map_err(|error| anyhow!("Failed to initialize ONNX Runtime: {error}"))
    }) {
        Ok(()) => Ok(()),
        Err(err) => Err(anyhow!("{err:#}")),
    }
}
