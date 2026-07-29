import type { AudioChunk, AudioInputDevice } from "./types";

const TARGET_SAMPLE_RATE = 16_000;

export const enumerateAudioInputDevices = async (): Promise<AudioInputDevice[]> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      deviceId: device.deviceId || (index === 0 ? "default" : `audio-input-${index}`),
      label: device.label,
      groupId: device.groupId,
    }));
};

export const resampleLinear = (
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array => {
  if (samples.length === 0 || fromRate === toRate) {
    return samples.slice();
  }
  const outputLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourcePosition - left;
    /* c8 ignore next -- valid typed-array positions are always numeric. */
    output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return output;
};

export const float32ToPcm16 = (samples: Float32Array): Int16Array => {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    /* c8 ignore next -- the loop bounds guarantee a valid typed-array position. */
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  throw new Error("base64 encoding is unavailable in this runtime");
};

export const pcm16ToBase64 = (samples: Int16Array): string =>
  bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));

export const makeAudioChunk = (
  samples: Float32Array,
  inputSampleRate: number,
  durationMs = Math.round((samples.length / inputSampleRate) * 1000),
): AudioChunk => ({
  pcmBase64: pcm16ToBase64(
    float32ToPcm16(resampleLinear(samples, inputSampleRate, TARGET_SAMPLE_RATE)),
  ),
  sampleRate: TARGET_SAMPLE_RATE,
  channels: 1,
  durationMs,
});

export const calculateRmsDb = (samples: Float32Array): number => {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms <= Number.EPSILON ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
};

export const createMicrophoneConstraints = (deviceId: string): MediaStreamConstraints => ({
  audio: {
    deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  video: false,
});

type ChunkHandler = (chunk: AudioChunk) => void | Promise<void>;

export type AudioCaptureErrorCode = "audio-context-failed" | "microphone-unavailable";

export class AudioCaptureError extends Error {
  public readonly code: AudioCaptureErrorCode;

  public constructor(code: AudioCaptureErrorCode) {
    super(code);
    this.name = "AudioCaptureError";
    this.code = code;
  }
}

/* c8 ignore start -- browser/Tauri media graph; pure PCM functions are covered below. */
export class MicrophoneCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private pending = new Float32Array(0);
  private handler: ChunkHandler | null = null;
  private chunkMs = 1_200;
  private silenceGateDb = -55;

  public async start(
    deviceId: string,
    chunkMs: number,
    silenceGateDb: number,
    handler: ChunkHandler,
  ): Promise<void> {
    await this.stop();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new AudioCaptureError("microphone-unavailable");
    }
    this.handler = handler;
    this.chunkMs = chunkMs;
    this.silenceGateDb = silenceGateDb;
    this.stream = await navigator.mediaDevices.getUserMedia(createMicrophoneConstraints(deviceId));
    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(this.stream);
    if (this.context.audioWorklet) {
      await this.startWorklet();
    } else {
      this.startScriptProcessor();
    }
    await this.context.resume();
  }

  public async stop(): Promise<void> {
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    if (this.context) {
      await this.context.close();
    }
    this.context = null;
    this.stream = null;
    this.source = null;
    this.sink = null;
    this.processor = null;
    this.worklet = null;
    this.handler = null;
    this.pending = new Float32Array(0);
  }

  private async startWorklet(): Promise<void> {
    if (!this.context || !this.source) {
      throw new AudioCaptureError("audio-context-failed");
    }
    const processorSource = `
      class CaptionBridgeCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const channel = inputs[0] && inputs[0][0];
          if (channel) this.port.postMessage(channel.slice());
          return true;
        }
      }
      registerProcessor('caption-bridge-capture', CaptionBridgeCaptureProcessor);
    `;
    const blob = new Blob([processorSource], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worklet = new AudioWorkletNode(this.context, "caption-bridge-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.acceptSamples(event.data);
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  private startScriptProcessor(): void {
    if (!this.context || !this.source) {
      throw new AudioCaptureError("audio-context-failed");
    }
    this.processor = this.context.createScriptProcessor(4_096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      this.acceptSamples(event.inputBuffer.getChannelData(0));
    };
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  private acceptSamples(samples: Float32Array): void {
    const next = new Float32Array(this.pending.length + samples.length);
    next.set(this.pending);
    next.set(samples, this.pending.length);
    this.pending = next;
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const chunkSize = Math.max(1, Math.round((sampleRate * this.chunkMs) / 1000));
    while (this.pending.length >= chunkSize) {
      const chunk = this.pending.slice(0, chunkSize);
      this.pending = this.pending.slice(chunkSize);
      if (calculateRmsDb(chunk) >= this.silenceGateDb) {
        void this.handler?.(makeAudioChunk(chunk, sampleRate, this.chunkMs));
      }
    }
  }
}
/* c8 ignore stop */
