export const PARAPPER_SAMPLE_RATE = 16_000;
export const PARAPPER_MAX_FRAME_BYTES = 3_200;

const text = (bytes: Uint8Array, offset: number, length: number): string =>
  new TextDecoder().decode(bytes.subarray(offset, offset + length));

const uint32 = (view: DataView, offset: number): number => view.getUint32(offset, true);

const requireRange = (bytes: Uint8Array, start: number, length: number, message: string): void => {
  if (start < 0 || length < 0 || start + length > bytes.length) {
    throw new Error(message);
  }
};

export const pcm16FromWav = (wav: Uint8Array): Uint8Array => {
  if (wav.length < 12 || text(wav, 0, 4) !== "RIFF" || text(wav, 8, 4) !== "WAVE") {
    throw new Error("audio must be a RIFF/WAVE file");
  }
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let format: {
    bitsPerSample: number;
    channels: number;
    encoding: number;
    sampleRate: number;
  } | null = null;
  let pcm: Uint8Array | null = null;
  while (offset + 8 <= wav.length) {
    const kind = text(wav, offset, 4);
    const length = uint32(view, offset + 4);
    const bodyStart = offset + 8;
    requireRange(wav, bodyStart, length, "WAV chunk exceeds the input length");
    if (kind === "fmt ") {
      if (length < 16) {
        throw new Error("WAV fmt chunk is too small");
      }
      format = {
        encoding: view.getUint16(bodyStart, true),
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: uint32(view, bodyStart + 4),
        bitsPerSample: view.getUint16(bodyStart + 14, true),
      };
    } else if (kind === "data") {
      pcm = wav.slice(bodyStart, bodyStart + length);
    }
    offset = bodyStart + length + (length % 2);
  }
  if (!format || !pcm) {
    throw new Error("WAV requires fmt and data chunks");
  }
  if (
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== PARAPPER_SAMPLE_RATE ||
    format.bitsPerSample !== 16
  ) {
    throw new Error("WAV must be PCM s16le, mono, 16000 Hz");
  }
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("WAV PCM data must be non-empty signed 16-bit samples");
  }
  return pcm;
};

export const splitParapperFrames = (pcm: Uint8Array): Uint8Array[] => {
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("PCM must be non-empty signed 16-bit samples");
  }
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += PARAPPER_MAX_FRAME_BYTES) {
    frames.push(pcm.slice(offset, Math.min(offset + PARAPPER_MAX_FRAME_BYTES, pcm.length)));
  }
  return frames;
};
