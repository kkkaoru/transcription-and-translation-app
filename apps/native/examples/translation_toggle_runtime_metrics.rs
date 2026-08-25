//! Interactive QuickMT lifecycle probe for current-RSS sampling.
//!
//! Commands on stdin: `on`, `off`, and `quit`. Output contains lifecycle and
//! latency only; recognized text, prompts, and model output are never emitted.

use std::hint::black_box;
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::time::Instant;

use kotoba_beacon_native::memory::{configure_process_memory, release_unused_translation_memory};
use parapper_engine::LocalTranslator;
use serde::Serialize;

const METRIC_SOURCE: &str = "こんにちは、聞こえますか。";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToggleEvent {
    schema_version: u32,
    state: &'static str,
    pid: u32,
    elapsed_ms: f64,
    model_loaded: bool,
}

fn publish(state: &'static str, elapsed_ms: f64, model_loaded: bool) -> anyhow::Result<()> {
    println!(
        "{}",
        serde_json::to_string(&ToggleEvent {
            schema_version: 1,
            state,
            pid: std::process::id(),
            elapsed_ms,
            model_loaded,
        })?
    );
    Ok(())
}

fn main() -> anyhow::Result<()> {
    configure_process_memory();
    let models_root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("models root is required"))?;
    let stdin = io::stdin();
    let mut translator = None;
    publish("off", 0.0, false)?;

    for command in stdin.lock().lines() {
        match command?.trim() {
            "on" => {
                let started_at = Instant::now();
                if translator.is_none() {
                    translator = Some(LocalTranslator::load(&models_root)?);
                }
                let engine = translator
                    .as_mut()
                    .ok_or_else(|| anyhow::anyhow!("QuickMT did not remain loaded"))?;
                let translation = engine.translate_ja_to_en(METRIC_SOURCE)?;
                black_box(translation);
                publish("on", started_at.elapsed().as_secs_f64() * 1_000.0, true)?;
            }
            "off" => {
                let started_at = Instant::now();
                translator = None;
                black_box(&translator);
                black_box(release_unused_translation_memory());
                publish("off", started_at.elapsed().as_secs_f64() * 1_000.0, false)?;
            }
            "quit" => break,
            command => anyhow::bail!("unsupported command: {command}"),
        }
    }
    Ok(())
}
