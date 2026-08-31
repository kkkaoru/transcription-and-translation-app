use std::{
    collections::BTreeSet,
    env, fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use parapper_engine::{EngineConfig, EngineEvent, ParapperEngine};

const WAV_HEADER_BYTES: usize = 44;
const INTER_UTTERANCE_SILENCE: Duration = Duration::from_secs(2);
const FINAL_WAIT: Duration = Duration::from_secs(30);
const FRAME_DURATION: Duration = Duration::from_millis(32);

fn main() -> anyhow::Result<()> {
    let mut arguments = env::args_os().skip(1);
    let models_root = arguments.next().ok_or_else(|| anyhow::anyhow!("models root is required"))?;
    let first_fixture =
        arguments.next().ok_or_else(|| anyhow::anyhow!("first WAV fixture is required"))?;
    let second_fixture =
        arguments.next().ok_or_else(|| anyhow::anyhow!("second WAV fixture is required"))?;
    thread::Builder::new()
        .name("native-turn-separation-verification".to_string())
        .spawn(move || verify(models_root, first_fixture, second_fixture))?
        .join()
        .map_err(|_| anyhow::anyhow!("turn separation verification thread panicked"))?
}

fn verify(
    models_root: impl AsRef<Path>,
    first_fixture: impl AsRef<Path>,
    second_fixture: impl AsRef<Path>,
) -> anyhow::Result<()> {
    let first = read_pcm16_mono_16khz(first_fixture.as_ref())?;
    let second = read_pcm16_mono_16khz(second_fixture.as_ref())?;
    let mut engine = ParapperEngine::load(&EngineConfig::new(models_root.as_ref()))?;
    let mut final_turns = BTreeSet::new();
    let mut captions = 0_usize;

    push_realtime(&mut engine, &first, &mut final_turns, &mut captions)?;
    let silence = vec![0.0; parapper_engine::VAD_FRAME_SAMPLES];
    for _ in 0..(INTER_UTTERANCE_SILENCE.as_millis() / FRAME_DURATION.as_millis()) {
        collect(engine.push_audio(&silence)?, &mut final_turns, &mut captions);
        collect(engine.tick(), &mut final_turns, &mut captions);
        thread::sleep(FRAME_DURATION);
    }
    push_realtime(&mut engine, &second, &mut final_turns, &mut captions)?;
    for _ in 0..32 {
        collect(engine.push_audio(&silence)?, &mut final_turns, &mut captions);
        collect(engine.tick(), &mut final_turns, &mut captions);
        thread::sleep(FRAME_DURATION);
    }

    let deadline = Instant::now() + FINAL_WAIT;
    while final_turns.len() < 2 && Instant::now() < deadline {
        collect(engine.tick(), &mut final_turns, &mut captions);
        thread::sleep(Duration::from_millis(10));
    }
    let (_, events) = engine.shutdown();
    collect(events, &mut final_turns, &mut captions);
    if final_turns.len() != 2 {
        anyhow::bail!(
            "expected two independently finalized turns after a two-second gap; got {}",
            final_turns.len()
        );
    }
    println!(
        "{{\"result\":\"PASS\",\"finalTurns\":{},\"captions\":{captions},\"gapMillis\":{}}}",
        final_turns.len(),
        INTER_UTTERANCE_SILENCE.as_millis()
    );
    Ok(())
}

fn push_realtime(
    engine: &mut ParapperEngine,
    samples: &[f32],
    final_turns: &mut BTreeSet<String>,
    captions: &mut usize,
) -> anyhow::Result<()> {
    for frame in samples.chunks(parapper_engine::VAD_FRAME_SAMPLES) {
        collect(engine.push_audio(frame)?, final_turns, captions);
        collect(engine.tick(), final_turns, captions);
        thread::sleep(FRAME_DURATION);
    }
    Ok(())
}

fn collect(events: Vec<EngineEvent>, final_turns: &mut BTreeSet<String>, captions: &mut usize) {
    for event in events {
        if let EngineEvent::Caption { turn_id, is_final, .. } = event {
            *captions += 1;
            if is_final {
                final_turns.insert(turn_id);
            }
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
