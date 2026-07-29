use base64::Engine;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pub pcm_base64: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub duration_ms: u32,
}

pub fn pcm_base64_to_wav(chunk: &AudioChunk) -> Result<Vec<u8>, String> {
    if chunk.channels != 1 {
        return Err("only mono audio is supported by the MVP pipeline".to_string());
    }
    if !(8_000..=96_000).contains(&chunk.sample_rate) {
        return Err("audio sample rate is outside the supported range".to_string());
    }
    if !(1..=10_000).contains(&chunk.duration_ms) {
        return Err("audio chunk duration is outside the supported range".to_string());
    }
    if chunk.pcm_base64.is_empty() {
        return Err("audio chunk is empty".to_string());
    }
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(&chunk.pcm_base64)
        .map_err(|error| format!("invalid PCM base64: {error}"))?;
    if pcm.len() % 2 != 0 {
        return Err("PCM16 payload has an odd byte length".to_string());
    }
    let byte_rate = chunk.sample_rate * 2;
    let data_length =
        u32::try_from(pcm.len()).map_err(|_| "audio chunk is too large".to_string())?;
    let riff_length =
        36_u32.checked_add(data_length).ok_or_else(|| "audio chunk is too large".to_string())?;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_length.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&chunk.sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_length.to_le_bytes());
    wav.extend_from_slice(&pcm);
    Ok(wav)
}
