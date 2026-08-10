/** Minimal mono 16 kHz PCM16 WAV for automated ASR smoke tests (short tone burst). */
export const buildWorkersAiAsrSmokeWav = (): Uint8Array => {
  const sampleRate = 16_000;
  const durationSeconds = 0.25;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const pcm = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / sampleRate;
    pcm[index] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12_000);
  }
  const pcmBytes = new Uint8Array(pcm.buffer);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + pcmBytes.length, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, pcmBytes.length, true);
  const wav = new Uint8Array(header.length + pcmBytes.length);
  wav.set(header, 0);
  wav.set(pcmBytes, header.length);
  return wav;
};

export const workersAiAsrSmokeWavFile = (): File =>
  new File([buildWorkersAiAsrSmokeWav()], "asr-smoke.wav", { type: "audio/wav" });
