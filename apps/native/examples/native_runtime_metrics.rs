//! Deterministic Native hot-path workload for CPU, memory, and allocation evaluation.

use std::hint::black_box;
use std::time::{Duration, Instant};

use kotoba_beacon_native::hot_path::{
    caption_changed, normalize_pcm16_into, should_check_output_window, NATIVE_PCM_FRAME_SAMPLES,
};
use serde::Serialize;

const DEFAULT_ITERATIONS: u64 = 5_000_000;
const FRAME_DURATION: Duration = Duration::from_millis(32);
const CAPTION_CHANGE_INTERVAL: u64 = 31;
const STYLE_BYTES: usize = 192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkloadMode {
    Baseline,
    Optimized,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMetrics {
    schema_version: u32,
    mode: &'static str,
    iterations: u64,
    simulated_audio_seconds: f64,
    elapsed_ms: f64,
    pcm_allocations: u64,
    pcm_reallocations: u64,
    pcm_buffer_capacity: usize,
    caption_polls: u64,
    caption_updates: u64,
    caption_clone_operations: u64,
    output_window_checks: u64,
    checksum: u64,
}

fn parse_mode(value: Option<&str>) -> Result<WorkloadMode, String> {
    match value {
        Some("baseline") => Ok(WorkloadMode::Baseline),
        Some("optimized") => Ok(WorkloadMode::Optimized),
        Some(other) => Err(format!("unsupported mode: {other}")),
        None => Err("mode must be baseline or optimized".to_string()),
    }
}

fn parse_iterations(value: Option<&str>) -> Result<u64, String> {
    match value {
        Some(raw) => raw
            .parse::<u64>()
            .map_err(|error| format!("invalid iteration count: {error}"))
            .and_then(|iterations| {
                if iterations == 0 {
                    Err("iteration count must be positive".to_string())
                } else {
                    Ok(iterations)
                }
            }),
        None => Ok(DEFAULT_ITERATIONS),
    }
}

fn caption_for_iteration(iteration: u64) -> (&'static str, &'static str) {
    if (iteration / CAPTION_CHANGE_INTERVAL).is_multiple_of(2) {
        ("source-caption-a", "translation-caption-a")
    } else {
        ("source-caption-b", "translation-caption-b")
    }
}

fn baseline_metrics(iterations: u64) -> RuntimeMetrics {
    let input = [1_024_i16; NATIVE_PCM_FRAME_SAMPLES];
    let style = "s".repeat(STYLE_BYTES);
    let started_at = Instant::now();
    let mut caption_updates = 0_u64;
    let mut checksum = 0_u64;
    for iteration in 0..iterations {
        let normalized: Vec<f32> =
            input.iter().map(|sample| f32::from(*sample) / 32_768.0).collect();
        let (source, translation) = caption_for_iteration(iteration);
        let published_caption = (source.to_string(), translation.to_string());
        let output = (source.to_string(), translation.to_string(), style.clone());
        let browser_caption =
            iteration.is_multiple_of(CAPTION_CHANGE_INTERVAL).then(|| published_caption.clone());
        if browser_caption.is_some() {
            caption_updates += 1;
        }
        checksum = checksum.wrapping_add(
            u64::from(normalized[iteration as usize % normalized.len()].to_bits())
                + output.0.len() as u64
                + output.1.len() as u64,
        );
        black_box((normalized, published_caption, browser_caption, output));
    }
    RuntimeMetrics {
        schema_version: 1,
        mode: "baseline",
        iterations,
        simulated_audio_seconds: iterations as f64 * FRAME_DURATION.as_secs_f64(),
        elapsed_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
        pcm_allocations: iterations,
        pcm_reallocations: iterations,
        pcm_buffer_capacity: NATIVE_PCM_FRAME_SAMPLES,
        caption_polls: iterations,
        caption_updates,
        caption_clone_operations: iterations
            .saturating_mul(5)
            .saturating_add(caption_updates.saturating_mul(2)),
        output_window_checks: iterations,
        checksum,
    }
}

fn optimized_metrics(iterations: u64) -> RuntimeMetrics {
    let input = [1_024_i16; NATIVE_PCM_FRAME_SAMPLES];
    let style = "s".repeat(STYLE_BYTES);
    let started_at = Instant::now();
    let mut normalized = Vec::with_capacity(NATIVE_PCM_FRAME_SAMPLES);
    let initial_capacity = normalized.capacity();
    let mut previous_caption: Option<(String, String)> = None;
    let mut since_output_check = Duration::ZERO;
    let mut caption_updates = 0_u64;
    let mut caption_clone_operations = 0_u64;
    let mut output_window_checks = 0_u64;
    let mut pcm_reallocations = 0_u64;
    let mut checksum = 0_u64;

    for iteration in 0..iterations {
        normalize_pcm16_into(&input, &mut normalized);
        if normalized.capacity() != initial_capacity {
            pcm_reallocations += 1;
        }
        let (source, translation) = caption_for_iteration(iteration);
        let output_changed = caption_changed(previous_caption.as_ref(), source, translation);
        if output_changed {
            previous_caption = Some((source.to_string(), translation.to_string()));
            let surface_caption = (source.to_string(), translation.to_string());
            let output = (source.to_string(), translation.to_string(), style.clone());
            caption_updates += 1;
            caption_clone_operations += 7;
            black_box((surface_caption, output));
        }
        since_output_check += FRAME_DURATION;
        if should_check_output_window(output_changed, since_output_check) {
            output_window_checks += 1;
            since_output_check = Duration::ZERO;
        }
        checksum = checksum.wrapping_add(
            u64::from(normalized[iteration as usize % normalized.len()].to_bits())
                + previous_caption
                    .as_ref()
                    .map_or(0, |caption| caption.0.len() as u64 + caption.1.len() as u64),
        );
        black_box(&normalized);
    }

    RuntimeMetrics {
        schema_version: 1,
        mode: "optimized",
        iterations,
        simulated_audio_seconds: iterations as f64 * FRAME_DURATION.as_secs_f64(),
        elapsed_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
        pcm_allocations: 1,
        pcm_reallocations,
        pcm_buffer_capacity: normalized.capacity(),
        caption_polls: iterations,
        caption_updates,
        caption_clone_operations,
        output_window_checks,
        checksum,
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mode = parse_mode(arguments.first().map(String::as_str))?;
    let iterations = parse_iterations(arguments.get(1).map(String::as_str))?;
    let metrics = match mode {
        WorkloadMode::Baseline => baseline_metrics(iterations),
        WorkloadMode::Optimized => optimized_metrics(iterations),
    };
    println!(
        "{}",
        serde_json::to_string(&metrics)
            .map_err(|error| format!("could not serialize runtime metrics: {error}"))?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Native runtime metrics failed: {error}");
        std::process::exit(1);
    }
}
