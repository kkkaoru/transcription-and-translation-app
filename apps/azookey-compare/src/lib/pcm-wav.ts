/** Encode mono PCM16 samples as a WAV byte payload (16 kHz default). */
export const pcm16ToWavBytes = (pcm: Int16Array, sampleRate = 16_000): Uint8Array => {
  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
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

export const TARGET_SAMPLE_RATE = 16_000;

/** OfflineAudioContext length is sample-frames, not seconds. */
export const pcmTargetLengthForDuration = (
  durationSeconds: number,
  sampleRate = TARGET_SAMPLE_RATE,
): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 1;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(durationSeconds * sampleRate));
};

/** Decode a recorded blob to mono PCM16 at 16 kHz for Nova-3 upload. */
export const blobToPcm16Mono = async (blob: Blob): Promise<Int16Array> => {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const offline = new OfflineAudioContext(
      1,
      pcmTargetLengthForDuration(decoded.duration, TARGET_SAMPLE_RATE),
      TARGET_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const channel = rendered.getChannelData(0);
    const pcm = new Int16Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index] ?? 0));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  } finally {
    await audioContext.close();
  }
};

export const blobToWavFile = async (blob: Blob, name = "utterance.wav"): Promise<File> => {
  const pcm = await blobToPcm16Mono(blob);
  return new File([pcm16ToWavBytes(pcm)], name, { type: "audio/wav" });
};

export const pcmDurationSeconds = (pcm: Int16Array, sampleRate = TARGET_SAMPLE_RATE): number =>
  pcm.length / sampleRate;
