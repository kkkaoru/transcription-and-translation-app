use std::{
    env, fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use parapper_engine::{CaptionUpdateMode, EngineConfig, EngineEvent, ParapperEngine};

const WAV_HEADER_BYTES: usize = 44;
const FINAL_WAIT: Duration = Duration::from_secs(30);

fn main() -> anyhow::Result<()> {
    let mut arguments = env::args_os().skip(1);
    let models_root = arguments.next().ok_or_else(|| anyhow::anyhow!("models root is required"))?;
    let fixture = arguments.next().ok_or_else(|| anyhow::anyhow!("WAV fixture is required"))?;
    thread::Builder::new()
        .name("native-verification".to_string())
        .spawn(move || verify_fixture(models_root, fixture))?
        .join()
        .map_err(|_| anyhow::anyhow!("in-process ASR verification thread panicked"))?
}

fn verify_fixture(models_root: impl AsRef<Path>, fixture: impl AsRef<Path>) -> anyhow::Result<()> {
    let samples = read_pcm16_mono_16khz(fixture.as_ref())?;
    let mut engine = ParapperEngine::load(&EngineConfig::new(models_root.as_ref()))?;
    let mut caption = String::new();
    let mut partials = Vec::new();
    let mut saw_final = false;

    for frame in samples.chunks(parapper_engine::VAD_FRAME_SAMPLES) {
        collect_caption(engine.push_audio(frame)?, &mut caption, &mut partials, &mut saw_final);
    }
    let silence = vec![0.0; parapper_engine::SAMPLE_RATE as usize];
    collect_caption(engine.push_audio(&silence)?, &mut caption, &mut partials, &mut saw_final);

    let deadline = Instant::now() + FINAL_WAIT;
    while !saw_final && Instant::now() < deadline {
        collect_caption(engine.tick(), &mut caption, &mut partials, &mut saw_final);
        thread::sleep(Duration::from_millis(10));
    }
    let (_, shutdown_events) = engine.shutdown();
    collect_caption(shutdown_events, &mut caption, &mut partials, &mut saw_final);
    if !saw_final || caption.is_empty() {
        anyhow::bail!("engine produced no final caption");
    }
    let stable_prefix = partials.windows(2).find_map(|pair| {
        let earlier = normalize_caption(&pair[0]);
        let later = normalize_caption(&pair[1]);
        (earlier.chars().count() >= 2 && later.starts_with(earlier)).then_some(earlier)
    });
    if stable_prefix.is_some_and(|prefix| !normalize_caption(&caption).starts_with(prefix)) {
        anyhow::bail!("final caption dropped a prefix already preserved by consecutive partials");
    }
    println!(
        "{{\"result\":\"PASS\",\"caption\":{},\"stablePrefixPreserved\":true}}",
        serde_json::to_string(&caption)?
    );
    Ok(())
}

fn collect_caption(
    events: Vec<EngineEvent>,
    caption: &mut String,
    partials: &mut Vec<String>,
    saw_final: &mut bool,
) {
    for event in events {
        if let EngineEvent::Caption { text, is_final, update_mode, .. } = event {
            match update_mode {
                CaptionUpdateMode::Append => caption.push_str(&text),
                CaptionUpdateMode::Replace => *caption = text,
            }
            if !is_final {
                partials.push(caption.clone());
            }
            *saw_final |= is_final;
        }
    }
}

fn normalize_caption(text: &str) -> &str {
    text.trim().trim_end_matches(['.', '。', '！', '？'])
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
