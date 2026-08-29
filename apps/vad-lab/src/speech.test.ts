// Runs with Bun.
import { afterEach, expect, it, vi } from "vitest";
import { AudioSpeechRecognizer } from "./speech";

class MockAlternative implements SpeechRecognitionAlternativeLike {
  public readonly confidence: number = 0.91;
  public readonly transcript: string = "保存音声の認識結果";
}

class MockResult implements SpeechRecognitionResultLike {
  public readonly isFinal: boolean = true;
  public readonly length: number = 1;

  public item(): SpeechRecognitionAlternativeLike {
    return new MockAlternative();
  }
}

class MockResultList implements SpeechRecognitionResultListLike {
  public readonly length: number = 1;

  public item(): SpeechRecognitionResultLike {
    return new MockResult();
  }
}

class MockRecognitionErrorEvent extends Event implements SpeechRecognitionErrorEventLike {
  public readonly error: string = "network";
  public readonly message: string = "Recognition service unavailable";

  public constructor() {
    super("error");
  }
}

class MockResultEvent extends Event implements SpeechRecognitionResultEventLike {
  public readonly resultIndex: number = 0;
  public readonly results: SpeechRecognitionResultListLike = new MockResultList();

  public constructor() {
    super("result");
  }
}

class MockTrack {
  public readonly kind: string;
  public readonly readyState: string;
  public stopped = false;

  public constructor(kind = "audio", readyState = "live") {
    this.kind = kind;
    this.readyState = readyState;
  }

  public stop(): void {
    this.stopped = true;
  }
}

const track = new MockTrack();
const stream = {
  getAudioTracks: () => [track],
  getTracks: () => [track],
};

class MockAudio {
  public readyState = 3;
  public duration = 1;
  public muted = false;
  public preload = "";
  public oncanplay: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onended: (() => void) | null = null;

  public captureStream(): typeof stream {
    return stream;
  }

  public load(): void {}

  public play(): Promise<void> {
    return Promise.resolve();
  }

  public pause(): void {}
}

class MockAudioWrongKind extends MockAudio {
  public override captureStream(): typeof stream {
    const wrongTrack = new MockTrack("video", "live");
    return {
      getAudioTracks: () => [wrongTrack],
      getTracks: () => [wrongTrack],
    };
  }
}

class MockAudioEndedTrack extends MockAudio {
  public override captureStream(): typeof stream {
    const endedTrack = new MockTrack("audio", "ended");
    return {
      getAudioTracks: () => [endedTrack],
      getTracks: () => [endedTrack],
    };
  }
}

class MockAudioInvalidTrack extends MockAudio {
  public override captureStream(): typeof stream {
    return {
      getAudioTracks: () => [],
      getTracks: () => [track],
    };
  }
}

class MockAudioLoadFailure extends MockAudio {
  public override readyState = 0;

  public override load(): void {
    this.onerror?.();
  }
}

class MockAudioDelayedLoad extends MockAudio {
  public override readyState = 0;

  public override load(): void {
    this.readyState = 3;
    this.oncanplay?.();
  }
}

class MockAudioPlayFailure extends MockAudio {
  public override play(): Promise<void> {
    return Promise.reject(new Error("Playback blocked"));
  }
}

class MockAudioWithoutCapture {
  public readyState = 3;
  public duration = 1;
  public muted = false;
  public preload = "";
  public oncanplay: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onended: (() => void) | null = null;

  public load(): void {}

  public play(): Promise<void> {
    return Promise.resolve();
  }

  public pause(): void {}
}

class MockRecognition implements SpeechRecognitionLike {
  public static readonly instances: MockRecognition[] = [];
  public continuous = true;
  public interimResults = true;
  public lang = "";
  public maxAlternatives = 0;
  public onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  public onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  public onend: (() => void) | null = null;
  public receivedTrack: MediaStreamTrack | null = null;

  public constructor() {
    MockRecognition.instances.push(this);
  }

  public start(audioTrack?: MediaStreamTrack): void {
    this.receivedTrack = audioTrack ?? null;
    queueMicrotask(() => {
      this.onresult?.(new MockResultEvent());
      this.onend?.();
      this.onend?.();
    });
  }

  public stop(): void {
    this.onend?.();
  }

  public abort(): void {}
}

class MockRecognitionTimeout extends MockRecognition {
  public aborted = false;

  public override start(audioTrack?: MediaStreamTrack): void {
    this.receivedTrack = audioTrack ?? null;
  }

  public override abort(): void {
    this.aborted = true;
  }
}

class MockRecognitionFailure extends MockRecognition {
  public override start(audioTrack?: MediaStreamTrack): void {
    this.receivedTrack = audioTrack ?? null;
    queueMicrotask(() => this.onerror?.(new MockRecognitionErrorEvent()));
  }
}

const stubAudioRuntime = (AudioConstructor: unknown): void => {
  vi.stubGlobal("Audio", AudioConstructor);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:test-audio",
    revokeObjectURL: vi.fn(),
  });
};

afterEach(() => {
  MockRecognition.instances.splice(0);
  track.stopped = false;
  vi.unstubAllGlobals();
});

it("transcribes one completed VAD audio Blob through an audio track", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudio);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.transcript).toBe("保存音声の認識結果");
  expect(result.supported).toBe(true);
  expect(result.status).toBe("completed");
  expect(result.error).toBe(null);
  expect(result.confidence).toBe(0.91);
  expect(MockRecognition.instances).toHaveLength(1);
  expect(MockRecognition.instances[0]?.lang).toBe("ja-JP");
  expect(MockRecognition.instances[0]?.continuous).toBe(false);
  expect(MockRecognition.instances[0]?.interimResults).toBe(false);
  expect(MockRecognition.instances[0]?.receivedTrack).toBe(track);
  expect(track.stopped).toBe(true);
});

it("uses the prefixed Web Speech API when it is the only implementation", async () => {
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioDelayedLoad);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.status).toBe("completed");
  expect(result.transcript).toBe("保存音声の認識結果");
});

it("handles Web Speech API disappearing after feature detection", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudio);
  const recognizer = new AudioSpeechRecognizer();
  vi.stubGlobal("SpeechRecognition", undefined);

  await expect(
    recognizer.transcribe({
      audioBlob: new Blob(["audio"], { type: "audio/wav" }),
      language: "ja-JP",
    }),
  ).resolves.toMatchObject({ status: "unsupported", supported: false });
});

it("reports browsers without Web Speech API as unsupported", async () => {
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", undefined);
  stubAudioRuntime(MockAudio);
  const recognizer = new AudioSpeechRecognizer();

  await expect(
    recognizer.transcribe({
      audioBlob: new Blob(["audio"], { type: "audio/wav" }),
      language: "ja-JP",
    }),
  ).resolves.toStrictEqual({
    transcript: "",
    supported: false,
    status: "unsupported",
    error: "Web Speech API is unavailable",
    processingMs: 0,
    confidence: null,
  });
});

it("rejects a captured stream whose track kind is not audio", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioWrongKind);
  const recognizer = new AudioSpeechRecognizer();

  await expect(
    recognizer.transcribe({
      audioBlob: new Blob(["audio"], { type: "audio/wav" }),
      language: "ja-JP",
    }),
  ).resolves.toMatchObject({ status: "failed" });
});

it("rejects a captured stream whose audio track has ended", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioEndedTrack);
  const recognizer = new AudioSpeechRecognizer();

  await expect(
    recognizer.transcribe({
      audioBlob: new Blob(["audio"], { type: "audio/wav" }),
      language: "ja-JP",
    }),
  ).resolves.toMatchObject({ status: "failed" });
});

it("rejects a captured stream without a live audio track", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioInvalidTrack);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("Recorded audio did not provide a live audio track");
  expect(track.stopped).toBe(true);
});

it("reports an audio Blob loading failure", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioLoadFailure);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("The recorded audio could not be loaded for STT");
});

it("times out an audio-track recognition that never completes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("SpeechRecognition", MockRecognitionTimeout);
  stubAudioRuntime(MockAudio);
  const recognizer = new AudioSpeechRecognizer();
  const pending = recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });
  await vi.advanceTimersByTimeAsync(15_000);
  const result = await pending;

  expect(result.status).toBe("failed");
  expect(result.error).toBe("Audio track speech recognition timed out");
  expect(MockRecognition.instances[0]).toMatchObject({ aborted: true });
});

it("records Web Speech API service errors", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognitionFailure);
  stubAudioRuntime(MockAudio);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("Recognition service unavailable");
});

it("reports audio playback failure for a completed VAD Blob", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioPlayFailure);
  const recognizer = new AudioSpeechRecognizer();
  const result = await recognizer.transcribe({
    audioBlob: new Blob(["audio"], { type: "audio/wav" }),
    language: "ja-JP",
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("Playback blocked");
  expect(result.transcript).toBe("");
  expect(result.confidence).toBe(null);
});

it("fails explicitly when recorded audio cannot expose an audio track", async () => {
  vi.stubGlobal("SpeechRecognition", MockRecognition);
  stubAudioRuntime(MockAudioWithoutCapture);
  const recognizer = new AudioSpeechRecognizer();

  await expect(
    recognizer.transcribe({
      audioBlob: new Blob(["audio"], { type: "audio/wav" }),
      language: "en-US",
    }),
  ).resolves.toStrictEqual({
    transcript: "",
    supported: true,
    status: "failed",
    error: "This browser cannot transcribe recorded audio tracks",
    processingMs: 0,
    confidence: null,
  });
});
