use std::{
    env, fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use parapper_engine::{EngineConfig, EngineEvent, ParapperEngine};

const WAV_HEADER_BYTES: usize = 44;
const FRAME_DURATION: Duration = Duration::from_millis(32);
const PARTIAL_WAIT: Duration = Duration::from_secs(10);

fn main() -> anyhow::Result<()> {
    let mut arguments = env::args_os().skip(1);
    let models_root = arguments.next().ok_or_else(|| anyhow::anyhow!("models root is required"))?;
    let fixture = arguments.next().ok_or_else(|| anyhow::anyhow!("WAV fixture is required"))?;
    let samples = read_pcm16_mono_16khz(Path::new(&fixture))?;
    let mut config = EngineConfig::new(models_root);
    config.partial_window_asr_enabled = true;
    let mut engine = ParapperEngine::load(&config)?;
    let started_at = Instant::now();
    let mut first_partial_millis = None;
    let mut partial_count = 0_usize;

    for frame in samples.chunks(parapper_engine::VAD_FRAME_SAMPLES) {
        collect(
            engine.push_audio(frame)?,
            started_at,
            &mut first_partial_millis,
            &mut partial_count,
        );
        collect(engine.tick(), started_at, &mut first_partial_millis, &mut partial_count);
        thread::sleep(FRAME_DURATION);
    }
    let deadline = Instant::now() + PARTIAL_WAIT;
    while first_partial_millis.is_none() && Instant::now() < deadline {
        collect(engine.tick(), started_at, &mut first_partial_millis, &mut partial_count);
        thread::sleep(Duration::from_millis(10));
    }
    let _ = engine.shutdown();
    let Some(first_partial_millis) = first_partial_millis else {
        anyhow::bail!("partial-window ASR produced no visible preview");
    };
    if first_partial_millis >= 8_000 {
        anyhow::bail!("first partial-window preview arrived after the eight-second segment limit");
    }
    println!(
        "{{\"result\":\"PASS\",\"partialCount\":{partial_count},\"firstPartialMillis\":{first_partial_millis}}}"
    );
    Ok(())
}

fn collect(
    events: Vec<EngineEvent>,
    started_at: Instant,
    first_partial_millis: &mut Option<u128>,
    partial_count: &mut usize,
) {
    for event in events {
        if matches!(event, EngineEvent::PartialWindow { starts_turn: true, .. }) {
            *partial_count += 1;
            first_partial_millis.get_or_insert_with(|| started_at.elapsed().as_millis());
        }
    }
}

fn read_pcm16_mono_16khz(path: &Path) -> anyhow::Result<Vec<f32>> {
    let bytes = fs::read(path)?;
    if bytes.len() < WAV_HEADER_BYTES
        || &bytes[0..4] != b"RIFF"
        || u16::from_le_bytes([bytes[20], bytes[21]]) != 1
        || u16::from_le_bytes([bytes[22], bytes[23]]) != 1
        || u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) != 16_000
        || u16::from_le_bytes([bytes[34], bytes[35]]) != 16
    {
        anyhow::bail!("fixture must be PCM16 mono 16 kHz WAV");
    }
    Ok(bytes[WAV_HEADER_BYTES..]
        .chunks_exact(2)
        .map(|bytes| f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0)
        .collect())
}
