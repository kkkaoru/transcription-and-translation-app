use std::env;
use std::path::PathBuf;
use std::time::Instant;

use parapper_engine::{chrf2_score, TranslationComparisonBackend, TranslationComparisonEngine};
use serde_json::json;

const DEFAULT_ITERATIONS: usize = 3;
const FIXTURES: &[(&str, &str)] = &[
    ("こんにちは、聞こえますか。", "Hello, can you hear me?"),
    ("次の会議は午後三時から始まります。", "The next meeting starts at 3 p.m."),
    (
        "字幕と翻訳が揃うまで少しお待ちください。",
        "Please wait until the captions and translation are ready.",
    ),
    (
        "今日は雨ですが、明日は晴れる予定です。",
        "It is raining today, but it is expected to be sunny tomorrow.",
    ),
    (
        "この設定は音声認識中のメモリ使用量を減らします。",
        "This setting reduces memory usage during speech recognition.",
    ),
];

#[derive(Debug)]
struct Summary {
    average: f64,
    p50: f64,
    p95: f64,
    max: f64,
}

fn main() -> anyhow::Result<()> {
    let mut arguments = env::args().skip(1);
    let backend_name = arguments.next().ok_or_else(|| {
        anyhow::anyhow!("usage: translation_runtime_metrics BACKEND MODELS_ROOT [ITERATIONS]")
    })?;
    let models_root = PathBuf::from(arguments.next().ok_or_else(|| {
        anyhow::anyhow!("usage: translation_runtime_metrics BACKEND MODELS_ROOT [ITERATIONS]")
    })?);
    let iterations = arguments
        .next()
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(DEFAULT_ITERATIONS);
    if iterations == 0 || arguments.next().is_some() {
        anyhow::bail!("iterations must be positive and no extra arguments are accepted");
    }
    let backend = parse_backend(&backend_name)?;
    if backend == TranslationComparisonBackend::Lfm2Q4 {
        parapper_engine::initialize_onnx_runtime()?;
    }

    let load_started = Instant::now();
    let mut engine = TranslationComparisonEngine::load(&models_root, backend)?;
    let load_ms = duration_ms(load_started.elapsed());
    let mut latencies = Vec::with_capacity(iterations * FIXTURES.len());
    let mut quality_scores = Vec::with_capacity(FIXTURES.len());

    for iteration in 0..iterations {
        for (source, reference) in FIXTURES {
            let inference_started = Instant::now();
            let translation = engine.translate_ja_to_en(source)?;
            latencies.push(duration_ms(inference_started.elapsed()));
            if iteration == 0 {
                quality_scores.push(chrf2_score(&translation, reference));
            }
        }
    }

    let latency = summarize(&mut latencies);
    let quality = average(&quality_scores);
    println!(
        "{}",
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "benchmark": "native-translation",
            "backend": backend_name,
            "computeType": if backend == TranslationComparisonBackend::QuickMtInt8 { "int8" } else { "q4" },
            "modelDirectionsLoaded": 1,
            "translationWorkers": 1,
            "batchSize": 1,
            "beamSize": if backend == TranslationComparisonBackend::QuickMtInt8 { 2 } else { 1 },
            "fixtures": FIXTURES.len(),
            "iterations": iterations,
            "loadMs": load_ms,
            "latencyMs": {
                "average": latency.average,
                "p50": latency.p50,
                "p95": latency.p95,
                "max": latency.max,
            },
            "quality": {
                "metric": "chrf2",
                "score": quality,
            }
        }))?
    );
    Ok(())
}

fn parse_backend(value: &str) -> anyhow::Result<TranslationComparisonBackend> {
    match value {
        "quickmt-int8" => Ok(TranslationComparisonBackend::QuickMtInt8),
        "lfm2-q4" => Ok(TranslationComparisonBackend::Lfm2Q4),
        _ => anyhow::bail!("backend must be quickmt-int8 or lfm2-q4"),
    }
}

fn duration_ms(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn summarize(values: &mut [f64]) -> Summary {
    values.sort_by(f64::total_cmp);
    Summary {
        average: average(values),
        p50: percentile(values, 0.50),
        p95: percentile(values, 0.95),
        max: values.last().copied().unwrap_or(0.0),
    }
}

fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let rank = (values.len() - 1) as f64 * fraction;
    let lower = values[rank.floor() as usize];
    let upper = values[rank.ceil() as usize];
    lower + (upper - lower) * rank.fract()
}
