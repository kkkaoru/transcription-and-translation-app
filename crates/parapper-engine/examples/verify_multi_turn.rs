use std::{
    env, fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use parapper_engine::{EngineConfig, EngineEvent, ParapperEngine};

const WAV_HEADER_BYTES: usize = 44;
const TURN_WAIT: Duration = Duration::from_secs(30);
const DEFAULT_TURN_COUNT: usize = 10;

fn main() -> anyhow::Result<()> {
    let mut arguments = env::args_os().skip(1);
    let models_root = arguments.next().ok_or_else(|| anyhow::anyhow!("models root is required"))?;
    let fixture = arguments.next().ok_or_else(|| anyhow::anyhow!("WAV fixture is required"))?;
    let turn_count = arguments
        .next()
        .map(|value| value.to_string_lossy().parse::<usize>())
        .transpose()?
        .unwrap_or(DEFAULT_TURN_COUNT);
    let samples = read_pcm16_mono_16khz(Path::new(&fixture))?;
    let mut engine = ParapperEngine::load(&EngineConfig::new(models_root))?;
    let silence = vec![0.0; parapper_engine::SAMPLE_RATE as usize];
    let mut finals = 0;
    let mut captions = 0;

    for expected_final_count in 1..=turn_count {
        for frame in samples.chunks(parapper_engine::VAD_FRAME_SAMPLES) {
            collect(engine.push_audio(frame)?, &mut captions, &mut finals);
            collect(engine.tick(), &mut captions, &mut finals);
        }
        collect(engine.push_audio(&silence)?, &mut captions, &mut finals);
        let deadline = Instant::now() + TURN_WAIT;
        while finals < expected_final_count && Instant::now() < deadline {
            collect(engine.tick(), &mut captions, &mut finals);
            thread::sleep(Duration::from_millis(10));
        }
        if finals < expected_final_count {
            anyhow::bail!(
                "turn {expected_final_count} did not finalize; captions={captions} finals={finals}"
            );
        }
    }
    let _ = engine.shutdown();
    println!("{{\"result\":\"PASS\",\"captions\":{captions},\"finals\":{finals}}}");
    Ok(())
}

fn collect(events: Vec<EngineEvent>, captions: &mut usize, finals: &mut usize) {
    for event in events {
        if let EngineEvent::Caption { is_final, .. } = event {
            *captions += 1;
            *finals += usize::from(is_final);
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
