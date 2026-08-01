import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVibratoAdapter,
  createVibratoBrowserAdapter,
  createVibratoTokenizerFactory,
  createVibratoWorkerHandler,
  createWebSpeechVibratoSynchronizer,
  fetchVibratoDictionary,
  VibratoAdapterError,
  type VibratoBrowserAdapter,
  type VibratoInput,
  type VibratoOutput,
  type VibratoToken,
  type VibratoWorkerLike,
  type VibratoWorkerResponse,
} from "./vibrato-browser";

const input = (patch: Partial<VibratoInput> = {}): VibratoInput => ({
  sessionId: "session-1",
  turnId: "speech",
  revision: 1,
  text: "きょうのてんき",
  isFinal: false,
  ...patch,
});

const tokens: VibratoToken[] = [
  { surface: "きょう", feature: "名詞" },
  { surface: "の", feature: "助詞" },
  { surface: "てんき", feature: "名詞" },
];

class FakeWorker implements VibratoWorkerLike {
  static instances: FakeWorker[] = [];
  readonly messages: Array<{ message: unknown; transfer?: readonly Transferable[] }> = [];
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postFailure: Error | string | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: readonly Transferable[]): void {
    if (this.postFailure) {
      throw this.postFailure;
    }
    this.messages.push({ message, transfer });
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(data: unknown): void {
    this.onerror?.(data);
  }

  terminate(): void {
    this.terminated = true;
  }
}

class FakeScope {
  readonly messages: VibratoWorkerResponse[] = [];
  listener: ((event: { readonly data: unknown }) => void) | null = null;
  removed = false;

  postMessage(message: VibratoWorkerResponse): void {
    this.messages.push(message);
  }

  addEventListener(_type: "message", listener: (event: { readonly data: unknown }) => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.removed = true;
    this.listener = null;
  }

  emit(data: unknown): void {
    this.listener?.({ data });
  }
}

const workerMessage = (worker: FakeWorker): Record<string, unknown> => {
  const message = worker.messages.at(-1)?.message;
  if (!message || typeof message !== "object") {
    throw new Error("worker did not receive a message");
  }
  return message as Record<string, unknown>;
};

const validWorkerOutput = (requestId: string, revision = 1) => ({
  type: "tokenized",
  requestId,
  vibratoOutput: {
    ...input({ revision }),
    mode: "worker-vibrato",
    tokens,
  },
});

const browserTokenizer = (received: Uint8Array[] = []) => ({
  tokenize: vi.fn((text: string) => {
    received.push(new Uint8Array([text.length]));
    return tokens;
  }),
  free: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe("Vibrato browser adapter", () => {
  it("creates a WASM tokenizer factory and supports browser mode", async () => {
    const received: Uint8Array[] = [];
    const tokenizer = browserTokenizer(received);
    const wasm = { initTokenizer: vi.fn(async () => tokenizer) };
    const factory = createVibratoTokenizerFactory(wasm);
    expect(await factory(new Uint8Array([1, 2]))).toBe(tokenizer);

    const states: string[] = [];
    const adapter = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryBytes: new Uint8Array([1, 2]),
      tokenizerFactory: factory,
      onStateChange: (snapshot) => states.push(snapshot.state),
    });
    await expect(adapter.initialize()).resolves.toMatchObject({
      state: "ready",
      activeMode: "browser-vibrato",
    });
    await expect(adapter.initialize()).resolves.toMatchObject({ state: "ready" });
    await expect(adapter.tokenize(input())).resolves.toMatchObject({
      text: input().text,
      mode: "browser-vibrato",
      tokens,
    });
    expect(received).toHaveLength(1);
    expect(states).toEqual(["loading", "ready"]);
    adapter.dispose();
    adapter.dispose();
    expect(tokenizer.free).toHaveBeenCalledTimes(1);
    await expect(adapter.initialize()).rejects.toMatchObject({ code: "disposed" });
    await expect(adapter.tokenize(input())).rejects.toMatchObject({ code: "disposed" });
  });

  it("handles unsupported browser mode, invalid input, and tokenizer failures", async () => {
    const unsupported = createVibratoBrowserAdapter({ mode: "browser-vibrato" });
    await expect(unsupported.initialize()).resolves.toMatchObject({
      state: "unsupported",
      error: { code: "unsupported" },
    });
    await expect(unsupported.tokenize(input())).rejects.toMatchObject({ code: "unsupported" });
    await expect(unsupported.tokenize(input({ revision: -1 }))).rejects.toMatchObject({
      code: "invalid-request",
    });

    const invalidTokens = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: async () => ({
        tokenize: () => [{ surface: "壊れた", feature: 42 as unknown as string }],
      }),
    });
    await invalidTokens.initialize();
    await expect(invalidTokens.tokenize(input())).rejects.toMatchObject({ code: "tokenize" });
    expect(invalidTokens.snapshot).toMatchObject({ state: "error", error: { code: "tokenize" } });

    const throwing = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: async () => ({
        tokenize: () => {
          throw "tokenizer failed";
        },
      }),
    });
    await throwing.initialize();
    await expect(throwing.tokenize(input())).rejects.toMatchObject({
      code: "tokenize",
      message: "tokenizer failed",
    });
  });

  it("fetches dictionaries and reports missing, HTTP, and network errors", async () => {
    const direct = await fetchVibratoDictionary({
      dictionaryBytes: new Uint8Array([3, 4]).buffer as ArrayBuffer,
    });
    expect([...direct]).toEqual([3, 4]);
    await expect(fetchVibratoDictionary({})).rejects.toMatchObject({ code: "missing-dictionary" });
    await expect(
      fetchVibratoDictionary({ dictionaryUrl: "https://dict.example/dict" }, (url) => {
        expect(url).toBe("https://dict.example/dict");
        return Promise.resolve(new Response(new Uint8Array([5, 6])));
      }),
    ).resolves.toEqual(new Uint8Array([5, 6]));
    await expect(
      fetchVibratoDictionary(
        { dictionaryUrl: "https://dict.example/missing" },
        async () => new Response("missing", { status: 404 }),
      ),
    ).rejects.toMatchObject({ code: "dictionary-fetch" });
    await expect(
      fetchVibratoDictionary({ dictionaryUrl: "https://dict.example/offline" }, () =>
        Promise.reject(new Error("offline")),
      ),
    ).rejects.toMatchObject({ code: "dictionary-fetch", message: "offline" });
    await expect(
      fetchVibratoDictionary({ dictionaryUrl: "https://dict.example/offline" }, () =>
        Promise.reject("offline"),
      ),
    ).rejects.toMatchObject({ code: "dictionary-fetch" });
  });

  it("loads browser dictionaries from URL and guards repeated initialization", async () => {
    const factoryCalls: Uint8Array[] = [];
    const tokenizer = browserTokenizer(factoryCalls);
    const fetcher = vi.fn(async () => new Response(new Uint8Array([8, 9])));
    vi.stubGlobal("fetch", fetcher);
    const adapter = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryUrl: "https://dict.example/dict",
      tokenizerFactory: (bytes) => {
        factoryCalls.push(bytes);
        return tokenizer;
      },
    });
    const first = adapter.initialize();
    const second = adapter.initialize();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(factoryCalls.map((bytes) => [...bytes])).toEqual([[8, 9]]);
  });

  it("initializes a worker, transfers dictionary bytes, and tokenizes", async () => {
    const worker = new FakeWorker();
    const adapter = createVibratoAdapter({
      mode: "worker-vibrato",
      worker,
      dictionaryBytes: new Uint8Array([1, 2, 3]),
      requestTimeoutMs: 100,
    });
    const initializing = adapter.initialize();
    const init = workerMessage(worker);
    expect(init.type).toBe("init");
    expect(worker.messages.at(-1)?.transfer).toHaveLength(1);
    worker.emit({ type: "ready", requestId: init.requestId });
    await expect(initializing).resolves.toMatchObject({
      state: "ready",
      activeMode: "worker-vibrato",
    });

    const pending = adapter.tokenize(input());
    await Promise.resolve();
    const request = workerMessage(worker);
    worker.emit(validWorkerOutput(String(request.requestId)));
    await expect(pending).resolves.toMatchObject({ mode: "worker-vibrato", tokens });
    adapter.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("handles worker response errors, malformed outputs, timeouts, and post failures", async () => {
    const worker = new FakeWorker();
    const adapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker,
      requestTimeoutMs: 10,
      allowFallback: false,
    });
    const initialize = adapter.initialize();
    const init = workerMessage(worker);
    worker.emit({
      type: "error",
      requestId: init.requestId,
      code: "worker-init",
      message: "bad init",
    });
    await expect(initialize).resolves.toMatchObject({
      state: "error",
      error: { code: "worker-init" },
    });

    const responseWorker = new FakeWorker();
    const responseAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: responseWorker,
      requestTimeoutMs: 10,
    });
    const ready = responseAdapter.initialize();
    const readyRequest = workerMessage(responseWorker);
    responseWorker.emit({ type: "ready", requestId: readyRequest.requestId });
    await ready;
    const errored = responseAdapter.tokenize(input());
    await Promise.resolve();
    const errorRequest = workerMessage(responseWorker);
    responseWorker.emit({
      type: "error",
      requestId: errorRequest.requestId,
      code: "tokenize",
      message: "bad token",
    });
    await expect(errored).rejects.toMatchObject({ code: "tokenize" });

    const malformedWorker = new FakeWorker();
    const malformedAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: malformedWorker,
      requestTimeoutMs: 10,
      allowFallback: false,
    });
    const malformedReady = malformedAdapter.initialize();
    const malformedInit = workerMessage(malformedWorker);
    malformedWorker.emit({ type: "ready", requestId: malformedInit.requestId });
    await malformedReady;
    const malformed = malformedAdapter.tokenize(input({ revision: 2 }));
    await Promise.resolve();
    const malformedRequest = workerMessage(malformedWorker);
    malformedWorker.emit({
      type: "tokenized",
      requestId: malformedRequest.requestId,
      vibratoOutput: { bad: true },
    });
    await expect(malformed).rejects.toMatchObject({ code: "worker-error" });

    const unknownWorker = new FakeWorker();
    const unknownAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: unknownWorker,
      requestTimeoutMs: 10,
      allowFallback: false,
    });
    const unknownReady = unknownAdapter.initialize();
    const unknownInit = workerMessage(unknownWorker);
    unknownWorker.emit({ type: "ready", requestId: unknownInit.requestId });
    await unknownReady;
    const unknown = unknownAdapter.tokenize(input({ revision: 3 }));
    await Promise.resolve();
    const unknownRequest = workerMessage(unknownWorker);
    unknownWorker.emit({ type: "disposed", requestId: unknownRequest.requestId });
    await expect(unknown).rejects.toMatchObject({ code: "worker-error" });

    const timeoutWorker = new FakeWorker();
    const timeoutAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: timeoutWorker,
      requestTimeoutMs: 10,
      allowFallback: false,
    });
    vi.useFakeTimers();
    const timedInitialize = timeoutAdapter.initialize();
    await vi.advanceTimersByTimeAsync(11);
    await expect(timedInitialize).resolves.toMatchObject({
      state: "error",
      error: { code: "worker-timeout" },
    });
    vi.useRealTimers();

    const failingWorker = new FakeWorker();
    failingWorker.postFailure = "post failed";
    const failingAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: failingWorker,
      allowFallback: false,
    });
    await expect(failingAdapter.initialize()).resolves.toMatchObject({
      state: "error",
      error: { code: "worker-error", message: "post failed" },
    });
  });

  it("covers worker lifecycle edge responses and pending disposal", async () => {
    const invalidList = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: async () => ({ tokenize: () => null as unknown as VibratoToken[] }),
    });
    await invalidList.initialize();
    await expect(invalidList.tokenize(input())).rejects.toMatchObject({ code: "tokenize" });

    const unexpectedWorker = new FakeWorker();
    const unexpectedAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: unexpectedWorker,
      allowFallback: false,
    });
    const initializing = unexpectedAdapter.initialize();
    const init = workerMessage(unexpectedWorker);
    unexpectedWorker.emit({ type: "disposed", requestId: init.requestId });
    await expect(initializing).resolves.toMatchObject({
      state: "error",
      error: { code: "worker-init" },
    });

    const unknownWorker = new FakeWorker();
    const unknownAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: unknownWorker,
      allowFallback: false,
    });
    const ready = unknownAdapter.initialize();
    const readyRequest = workerMessage(unknownWorker);
    unknownWorker.emit({ type: "ready", requestId: readyRequest.requestId });
    await ready;
    const unknown = unknownAdapter.tokenize(input());
    await Promise.resolve();
    const unknownRequest = workerMessage(unknownWorker);
    unknownWorker.emit({ type: "mystery", requestId: unknownRequest.requestId });
    await expect(unknown).rejects.toMatchObject({ code: "worker-error" });

    const workerError = new FakeWorker();
    const errorAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: workerError,
      allowFallback: false,
    });
    const errorReady = errorAdapter.initialize();
    const errorInit = workerMessage(workerError);
    workerError.emit({ type: "ready", requestId: errorInit.requestId });
    await errorReady;
    const pending = errorAdapter.tokenize(input());
    await Promise.resolve();
    workerError.fail(new Error("worker crashed"));
    await expect(pending).rejects.toMatchObject({
      code: "worker-error",
      message: "worker crashed",
    });

    const nonErrorWorker = new FakeWorker();
    const nonErrorAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: nonErrorWorker,
      allowFallback: false,
    });
    const nonErrorReady = nonErrorAdapter.initialize();
    const nonErrorInit = workerMessage(nonErrorWorker);
    nonErrorWorker.emit({ type: "ready", requestId: nonErrorInit.requestId });
    await nonErrorReady;
    const disposedPending = nonErrorAdapter.tokenize(input());
    await Promise.resolve();
    nonErrorAdapter.dispose();
    await expect(disposedPending).rejects.toMatchObject({ code: "disposed" });
  });

  it("falls back from a worker to browser tokenization and preserves failure metadata", async () => {
    const worker = new FakeWorker();
    const tokenizer = browserTokenizer();
    const adapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker,
      allowFallback: true,
      dictionaryBytes: new Uint8Array([7]),
      tokenizerFactory: async () => tokenizer,
    });
    const initializing = adapter.initialize();
    const init = workerMessage(worker);
    worker.emit({
      type: "error",
      requestId: init.requestId,
      code: "worker-init",
      message: "offline",
    });
    await expect(initializing).resolves.toMatchObject({
      state: "ready",
      activeMode: "browser-vibrato",
      fallbackFrom: "worker-vibrato",
      error: { code: "worker-init" },
    });
    await expect(adapter.tokenize(input())).resolves.toMatchObject({ mode: "browser-vibrato" });

    const missing = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: new FakeWorker(),
      allowFallback: true,
      tokenizerFactory: async () => tokenizer,
    });
    const missingInit = missing.initialize();
    const missingRequest = workerMessage(FakeWorker.instances.at(-1) as FakeWorker);
    (FakeWorker.instances.at(-1) as FakeWorker).emit({
      type: "error",
      requestId: missingRequest.requestId,
      code: "worker-init",
      message: "offline",
    });
    await expect(missingInit).resolves.toMatchObject({ state: "error" });
  });

  it("uses worker factories and reports browser initialization failures", async () => {
    const factoryWorker = new FakeWorker();
    const workerFactory = vi.fn(() => factoryWorker);
    const factoryAdapter = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      workerFactory,
      allowFallback: false,
    });
    const factoryInit = factoryAdapter.initialize();
    const request = workerMessage(factoryWorker);
    factoryWorker.emit({ type: "ready", requestId: request.requestId });
    await expect(factoryInit).resolves.toMatchObject({ state: "ready" });
    expect(workerFactory).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", () => Promise.reject(new Error("dictionary offline")));
    const fetchFailure = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryUrl: "https://dict.example/dict",
      tokenizerFactory: async () => ({ tokenize: () => tokens }),
    });
    await expect(fetchFailure.initialize()).resolves.toMatchObject({
      state: "error",
      error: { code: "dictionary-fetch", message: "dictionary offline" },
    });

    vi.stubGlobal("fetch", () => Promise.reject("dictionary offline"));
    const nonErrorFetchFailure = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryUrl: "https://dict.example/dict",
      tokenizerFactory: async () => ({ tokenize: () => tokens }),
    });
    await expect(nonErrorFetchFailure.initialize()).resolves.toMatchObject({
      state: "error",
      error: { code: "dictionary-fetch" },
    });

    vi.stubGlobal("fetch", async () => new Response("missing", { status: 503 }));
    const httpFetchFailure = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryUrl: "https://dict.example/missing",
      tokenizerFactory: async () => ({ tokenize: () => tokens }),
    });
    await expect(httpFetchFailure.initialize()).resolves.toMatchObject({
      state: "error",
      error: { code: "dictionary-fetch" },
    });

    const factoryFailure = createVibratoBrowserAdapter({
      mode: "browser-vibrato",
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: () => Promise.reject(new Error("tokenizer init failed")),
    });
    await expect(factoryFailure.initialize()).resolves.toMatchObject({
      state: "error",
      error: { code: "tokenize", message: "tokenizer init failed" },
    });

    const noTokenizerFallback = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      worker: new FakeWorker(),
      allowFallback: true,
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: async () => undefined as never,
    });
    const noTokenizerInit = noTokenizerFallback.initialize();
    const noTokenizerWorker = FakeWorker.instances.at(-1);
    if (!noTokenizerWorker) {
      throw new Error("fake worker was not constructed");
    }
    const noTokenizerRequest = workerMessage(noTokenizerWorker);
    noTokenizerWorker.emit({
      type: "error",
      requestId: noTokenizerRequest.requestId,
      code: "worker-init",
      message: "offline",
    });
    await expect(noTokenizerInit).resolves.toMatchObject({ state: "error" });

    const fallbackWorker = createVibratoBrowserAdapter({
      mode: "worker-vibrato",
      allowFallback: true,
      dictionaryBytes: new Uint8Array([1]),
      tokenizerFactory: async () => ({ tokenize: () => tokens }),
    });
    await expect(fallbackWorker.initialize()).resolves.toMatchObject({
      state: "ready",
      activeMode: "browser-vibrato",
      fallbackFrom: "worker-vibrato",
    });
  });
});

describe("Vibrato worker protocol handler", () => {
  it("validates requests, initializes, tokenizes, disposes, and cleans up", async () => {
    const scope = new FakeScope();
    const free = vi.fn();
    const tokenizer = { tokenize: vi.fn(() => tokens), free };
    const remove = createVibratoWorkerHandler({
      scope,
      loadTokenizer: (request) => {
        expect(request.dictionaryUrl).toBe("https://dict.example/dict");
        return tokenizer;
      },
    });
    scope.emit({ nope: true });
    expect(scope.messages.at(-1)).toMatchObject({ type: "error", code: "invalid-request" });

    scope.emit({ type: "tokenize", requestId: "before-init", vibratoInput: input() });
    await Promise.resolve();
    expect(scope.messages.at(-1)).toMatchObject({ type: "error", code: "worker-init" });

    scope.emit({ type: "init", requestId: "init-1", dictionaryUrl: "https://dict.example/dict" });
    await Promise.resolve();
    expect(scope.messages.at(-1)).toEqual({ type: "ready", requestId: "init-1" });
    scope.emit({ type: "tokenize", requestId: "token-1", vibratoInput: input({ isFinal: true }) });
    await Promise.resolve();
    expect(scope.messages.at(-1)).toMatchObject({
      type: "tokenized",
      requestId: "token-1",
      vibratoOutput: { mode: "worker-vibrato", tokens },
    });

    scope.emit({ type: "dispose", requestId: "dispose-1" });
    await Promise.resolve();
    expect(scope.messages.at(-1)).toEqual({ type: "disposed", requestId: "dispose-1" });
    expect(free).toHaveBeenCalledTimes(1);
    scope.emit({ type: "tokenize", requestId: "after-dispose", vibratoInput: input() });
    expect(scope.messages.at(-1)).toMatchObject({ type: "error", code: "disposed" });
    remove();
    remove();
    expect(scope.removed).toBe(true);
  });

  it("reports invalid token output, loader failures, and superseded initialization", async () => {
    const invalidScope = new FakeScope();
    const invalidRemove = createVibratoWorkerHandler({
      scope: invalidScope,
      loadTokenizer: async () => ({
        tokenize: () => [{ surface: "invalid", feature: 42 as unknown as string }],
      }),
    });
    invalidScope.emit({ type: "init", requestId: "init-invalid" });
    await Promise.resolve();
    invalidScope.emit({ type: "tokenize", requestId: "token-invalid", vibratoInput: input() });
    await Promise.resolve();
    expect(invalidScope.messages.at(-1)).toMatchObject({ type: "error", code: "tokenize" });
    invalidRemove();

    const loaderScope = new FakeScope();
    const loader = vi.fn(() => Promise.reject(new Error("dictionary failed")));
    const loaderRemove = createVibratoWorkerHandler({ scope: loaderScope, loadTokenizer: loader });
    loaderScope.emit({ type: "init", requestId: "init-error" });
    await Promise.resolve();
    expect(loaderScope.messages.at(-1)).toMatchObject({
      type: "error",
      requestId: "init-error",
      code: "tokenize",
      message: "dictionary failed",
    });
    loaderRemove();

    const supersededScope = new FakeScope();
    let resolveTokenizer: (value: { free: () => void; tokenize: () => VibratoToken[] }) => void =
      () => undefined;
    const supersededTokenizer = { free: vi.fn(), tokenize: () => tokens };
    const supersededRemove = createVibratoWorkerHandler({
      scope: supersededScope,
      loadTokenizer: () =>
        new Promise<{ free: () => void; tokenize: () => VibratoToken[] }>((resolve) => {
          resolveTokenizer = resolve;
        }),
    });
    supersededScope.emit({ type: "init", requestId: "init-pending" });
    supersededRemove();
    resolveTokenizer(supersededTokenizer);
    await Promise.resolve();
    expect(supersededTokenizer.free).toHaveBeenCalled();
    expect(supersededScope.messages.at(-1)).toMatchObject({ type: "error", code: "disposed" });
  });
});

describe("Web Speech Vibrato synchronizer", () => {
  it("coalesces slots, drops stale replies, and reports errors", async () => {
    let resolveFirst: (output: VibratoOutput) => void = () => undefined;
    const output = (value: VibratoInput): VibratoOutput => ({
      ...value,
      mode: "worker-vibrato",
      tokens,
    });
    const adapter: VibratoBrowserAdapter = {
      snapshot: { state: "ready", requestedMode: "worker-vibrato", activeMode: "worker-vibrato" },
      initialize: async () => ({
        state: "ready",
        requestedMode: "worker-vibrato",
        activeMode: "worker-vibrato",
      }),
      tokenize: vi.fn((value: VibratoInput): Promise<VibratoOutput> => {
        if (value.revision === 1) {
          return new Promise<VibratoOutput>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(output(value));
      }),
      dispose: vi.fn(),
    };
    const onOutput = vi.fn();
    const onError = vi.fn();
    const synchronizer = createWebSpeechVibratoSynchronizer({
      adapter,
      sessionId: " session ",
      onOutput,
      onError,
    });
    expect(synchronizer.sessionId).toBe("session");
    synchronizer.startSession("new-session");
    const first = synchronizer.accept({ resultIndex: 0, transcript: "きょう", isFinal: false });
    const duplicate = await synchronizer.accept({
      resultIndex: 0,
      transcript: "きょう",
      isFinal: false,
    });
    expect(duplicate).toBeNull();
    const second = await synchronizer.accept({
      resultIndex: 1,
      transcript: "のてんき",
      isFinal: true,
    });
    expect(second).toMatchObject({ text: "きょうのてんき", revision: 2 });
    resolveFirst(output(input({ revision: 1, text: "きょう" })));
    await expect(first).resolves.toBeNull();
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(synchronizer.revision).toBe(2);
    expect(
      await synchronizer.accept({ resultIndex: -1, transcript: "無効", isFinal: true }),
    ).toBeNull();
    expect(
      await synchronizer.accept({ resultIndex: 0.5, transcript: "無効", isFinal: true }),
    ).toBeNull();
    expect(
      await synchronizer.accept({ resultIndex: 2, transcript: " ", isFinal: true }),
    ).toBeNull();
    synchronizer.endSession();
    expect(synchronizer.sessionId).toBeNull();
    expect(synchronizer.revision).toBe(0);

    const errorAdapter: VibratoBrowserAdapter = {
      snapshot: { state: "ready", requestedMode: "browser-vibrato", activeMode: "browser-vibrato" },
      initialize: async () => ({
        state: "ready",
        requestedMode: "browser-vibrato",
        activeMode: "browser-vibrato",
      }),
      tokenize: vi.fn(() =>
        Promise.reject(new VibratoAdapterError({ code: "tokenize", message: "failed" })),
      ),
      dispose: vi.fn(),
    };
    const errorSync = createWebSpeechVibratoSynchronizer({ adapter: errorAdapter, onError });
    await expect(
      errorSync.accept({ resultIndex: 0, transcript: "失敗", isFinal: true }),
    ).rejects.toMatchObject({
      code: "tokenize",
    });
    expect(onError).toHaveBeenCalled();
  });

  it("drops replies after a session ends and forwards plain errors", async () => {
    let resolvePending: (value: VibratoOutput) => void = () => undefined;
    const outputForSynchronizer = (value: VibratoInput): VibratoOutput => ({
      ...value,
      mode: "browser-vibrato" as const,
      tokens,
    });
    const adapter: VibratoBrowserAdapter = {
      snapshot: { state: "ready", requestedMode: "browser-vibrato", activeMode: "browser-vibrato" },
      initialize: async () => ({
        state: "ready",
        requestedMode: "browser-vibrato",
        activeMode: "browser-vibrato",
      }),
      tokenize: vi.fn(
        (_value: VibratoInput): Promise<VibratoOutput> =>
          new Promise<VibratoOutput>((resolve) => {
            resolvePending = resolve;
          }),
      ),
      dispose: vi.fn(),
    };
    const synchronizer = createWebSpeechVibratoSynchronizer({ adapter });
    const pending = synchronizer.accept({ resultIndex: 0, transcript: "入力", isFinal: false });
    synchronizer.endSession();
    resolvePending(outputForSynchronizer(input()));
    await expect(pending).resolves.toBeNull();

    const plainErrorAdapter: VibratoBrowserAdapter = {
      snapshot: { state: "ready", requestedMode: "browser-vibrato", activeMode: "browser-vibrato" },
      initialize: async () => ({
        state: "ready",
        requestedMode: "browser-vibrato",
        activeMode: "browser-vibrato",
      }),
      tokenize: vi.fn(() => Promise.reject(new Error("plain failure"))),
      dispose: vi.fn(),
    };
    const plain = createWebSpeechVibratoSynchronizer({ adapter: plainErrorAdapter });
    await expect(
      plain.accept({ resultIndex: 0, transcript: "失敗", isFinal: true }),
    ).rejects.toThrow("plain failure");
  });
});
