import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AZOOKEY_MAX_MESSAGE_BYTES,
  AZOOKEY_MAX_TEXT_BYTES,
  AZOOKEY_MODE,
  type AzookeyRuntime,
  attachAzookeySocket,
  azookeyTimeoutMs,
  bearerTokenMatches,
  convertAzookeyMessage,
  createVibratoHttpConverter,
  createWasmConverter,
  isWebSocketUpgrade,
  openAzookeySocket,
  parseAzookeyMessage,
  readyAzookeyMessage,
} from "./azookey.js";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  accepted = false;

  send(value: string): void {
    this.sent.push(value);
  }

  accept(): void {
    this.accepted = true;
  }

  emit(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

const valid = {
  type: "azookey.convert",
  requestId: "req-1",
  source: "web-speech",
  language: "ja",
  sourceText: "きょうははいしんです",
  vibratoInput: "きょうははいしんです",
  mode: "worker-vibrato",
  auth: { scheme: "bearer", token: "secret" },
} as const;

describe("AzooKey Worker text contract", () => {
  it("clamps timeout configuration and publishes the ready protocol envelope", () => {
    expect(azookeyTimeoutMs({})).toBe(250);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: " " })).toBe(250);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "not-a-number" })).toBe(250);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "1" })).toBe(25);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "250.6" })).toBe(251);
    expect(azookeyTimeoutMs({ AZOOKEY_TIMEOUT_MS: "99999" })).toBe(2_000);
    expect(JSON.parse(readyAzookeyMessage(125))).toMatchObject({
      type: "azookey.ready",
      protocol: "azookey.text.v1",
      timeoutMs: 125,
    });
  });

  it("rejects every malformed request field and authentication shape", () => {
    const cases: Array<[unknown, string]> = [
      [null, "JSON object"],
      [[], "JSON object"],
      [{ ...valid, requestId: "" }, "requestId"],
      [{ ...valid, requestId: "あ".repeat(200) }, "requestId"],
      [{ ...valid, source: "microphone" }, "source"],
      [{ ...valid, language: "" }, "language"],
      [{ ...valid, language: "あ".repeat(100) }, "language"],
      [{ ...valid, sourceText: "" }, "sourceText"],
      [{ ...valid, sourceText: "あ".repeat(AZOOKEY_MAX_TEXT_BYTES) }, "sourceText"],
      [{ ...valid, vibratoInput: "" }, "vibratoInput"],
      [{ ...valid, mode: "unsupported" }, "mode"],
      [{ ...valid, auth: 1 }, "auth"],
      [{ ...valid, auth: { scheme: "invalid" } }, "auth.scheme"],
      [{ ...valid, auth: { scheme: "bearer" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "bearer", token: "" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "none", token: "secret" } }, "auth.token"],
      [{ ...valid, auth: { scheme: "bearer", token: "a".repeat(600) } }, "auth.token"],
    ];
    for (const [value, message] of cases) {
      expect(() => parseAzookeyMessage(JSON.stringify(value))).toThrow(message);
    }
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, auth: { scheme: "none" } })).auth,
    ).toEqual({
      scheme: "none",
    });
    expect(parseAzookeyMessage(JSON.stringify({ ...valid, auth: { type: "none" } })).auth).toEqual({
      scheme: "none",
    });
  });

  it("parses the next-app request fields and rejects browser-only mode", () => {
    expect(parseAzookeyMessage(JSON.stringify(valid))).toMatchObject({
      type: "azookey.convert",
      requestId: "req-1",
      sourceText: "きょうははいしんです",
      vibratoInput: "きょうははいしんです",
      mode: AZOOKEY_MODE,
    });
    expect(() =>
      parseAzookeyMessage(JSON.stringify({ ...valid, mode: "browser-vibrato" })),
    ).toThrow("client-only");
    expect(() => parseAzookeyMessage(JSON.stringify({ ...valid, type: "convert" }))).toThrow(
      "azookey.convert",
    );
    expect(
      parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" })),
    ).toMatchObject({ vibratoExecution: "worker" });
    expect(() =>
      parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "heuristic" })),
    ).toThrow("vibratoExecution");
  });

  it("enforces UTF-8 input limits before conversion", () => {
    const tooLarge = { ...valid, vibratoInput: "あ".repeat(AZOOKEY_MAX_TEXT_BYTES) };
    expect(new TextEncoder().encode(tooLarge.vibratoInput).byteLength).toBeGreaterThan(
      AZOOKEY_MAX_TEXT_BYTES,
    );
    expect(() => parseAzookeyMessage(JSON.stringify(tooLarge))).toThrow("byte limit");
    expect(() => parseAzookeyMessage("not-json")).toThrow("valid JSON");
  });

  it("returns the stable next-app response shape and preserves source text", async () => {
    const runtime: AzookeyRuntime = {
      timeoutMs: 250,
      converter: (text) => `今日は配信です:${text}`,
    };
    const result = await convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), runtime);
    expect(result).toMatchObject({
      type: "azookey.result",
      requestId: "req-1",
      sourceText: "きょうははいしんです",
      convertedText: "今日は配信です:きょうははいしんです",
      mode: "worker-vibrato",
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("runs a configured Worker Vibrato stage before AzooKey", async () => {
    const calls: string[] = [];
    const message = parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution: "worker" }));
    const result = await convertAzookeyMessage(message, {
      timeoutMs: 250,
      vibrato: (text, language) => {
        calls.push(`vibrato:${language}:${text}`);
        return "きょうははいしんです";
      },
      converter: (text) => {
        calls.push(`azookey:${text}`);
        return "今日は配信です";
      },
    });
    expect(calls).toEqual(["vibrato:ja:きょうははいしんです", "azookey:きょうははいしんです"]);
    expect(result.convertedText).toBe("今日は配信です");
    await expect(
      convertAzookeyMessage(message, { timeoutMs: 250, converter: (text) => text }),
    ).rejects.toMatchObject({ code: "vibrato_unavailable", requestId: "req-1" });
  });

  it("uses an explicit HTTP Vibrato adapter contract without phrase fallbacks", async () => {
    const fetcher = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://vibrato.example/v1/convert");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        authorization: "Bearer vibrato-secret",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ text: "漢字混じり", language: "ja" });
      return new Response(JSON.stringify({ text: "かんじまじり" }), { status: 200 });
    });
    const convert = createVibratoHttpConverter(
      {
        VIBRATO_UPSTREAM_URL: "https://vibrato.example/v1/convert",
        VIBRATO_API_TOKEN: " vibrato-secret ",
      },
      fetcher,
    );
    await expect(convert?.("漢字混じり", "ja")).resolves.toBe("かんじまじり");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(createVibratoHttpConverter({})).toBeUndefined();
    expect(() =>
      createVibratoHttpConverter({ VIBRATO_UPSTREAM_URL: "file:///tmp/vibrato" }),
    ).toThrow("http://");
    const invalidResponse = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example" },
      async () => new Response(JSON.stringify({ nope: "not-reading" }), { status: 200 }),
    );
    await expect(invalidResponse?.("入力", "ja")).rejects.toThrow("no non-empty text");
  });

  it("maps converter failures, non-string output, and elapsed timeout to protocol errors", async () => {
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => {
          throw new Error("converter failed");
        },
      }),
    ).rejects.toMatchObject({ code: "conversion_failed", requestId: "req-1" });
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "conversion_failed", requestId: "req-1" });

    vi.stubGlobal("performance", { now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(500) });
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => "遅い",
      }),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
    vi.unstubAllGlobals();

    vi.stubGlobal("performance", undefined);
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), {
        timeoutMs: 250,
        converter: () => "performance fallback",
      }),
    ).resolves.toMatchObject({ convertedText: "performance fallback" });
    vi.unstubAllGlobals();
  });

  it("uses the raw Wasm ABI converter and rejects malformed modules", () => {
    const bytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
    const converter = createWasmConverter(new WebAssembly.Module(bytes));
    expect(converter("きょうのてんき")).toBe("今日の天気");
    expect(() =>
      createWasmConverter(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
    ).toThrow("required raw ABI");
  });

  it("guards raw Wasm allocation and output ranges", () => {
    const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const instance = vi.spyOn(WebAssembly, "Instance");
    const dealloc = vi.fn();
    const alloc = vi.fn(() => 8);
    const convert = vi.fn(
      (_pointer: number, _length: number): bigint | number => (BigInt(32) << 32n) | 2n,
    );
    new Uint8Array(memory.buffer, 32, 2).set(new TextEncoder().encode("OK"));
    instance.mockImplementation(
      () =>
        ({
          exports: {
            memory,
            azookey_alloc: alloc,
            azookey_dealloc: dealloc,
            azookey_convert: convert,
          },
        }) as unknown as WebAssembly.Instance,
    );
    const converter = createWasmConverter(emptyModule);
    expect(converter("入力")).toBe("OK");
    expect(dealloc).toHaveBeenCalledTimes(2);

    convert.mockReturnValueOnce(Number((32n << 32n) | 2n));
    expect(converter("入力")).toBe("OK");

    alloc.mockReturnValueOnce(0);
    expect(() => converter("入力")).toThrow("input allocation failed");
    convert.mockReturnValueOnce(0n);
    expect(() => converter("入力")).toThrow("conversion allocation failed");
    convert.mockReturnValueOnce((0n << 32n) | 2n);
    expect(() => converter("入力")).toThrow("null output pointer");
    convert.mockReturnValueOnce((1n << 32n) | 70_000n);
    expect(() => converter("入力")).toThrow("invalid output range");
    instance.mockRestore();
  });

  it("authenticates browser frames and keeps malformed frames on the socket", async () => {
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      expectedToken: "secret",
      converter: (text) => `converted:${text}`,
    });
    socket.emit(JSON.stringify({ ...valid, auth: { scheme: "bearer", token: "wrong" } }));
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "req-1",
      error: { code: "unauthorized" },
    });

    socket.emit(JSON.stringify({ ...valid, requestId: "req-2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-2",
      convertedText: "converted:きょうははいしんです",
    });

    socket.emit(JSON.stringify({ ...valid, requestId: "req-3", auth: undefined }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-3",
      convertedText: "converted:きょうははいしんです",
    });

    socket.emit(JSON.stringify({ type: "azookey.convert", requestId: "bad" }));
    await Promise.resolve();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.error",
      requestId: "bad",
      error: { code: "invalid_contract" },
    });
  });

  it("rejects binary and oversized frames, and returns busy while a conversion is pending", async () => {
    let resolveConversion: ((value: string) => void) | undefined;
    const socket = new FakeSocket();
    attachAzookeySocket(socket as unknown as WebSocket, {
      timeoutMs: 250,
      converter: () =>
        new Promise((resolve) => {
          resolveConversion = resolve;
        }),
    });
    socket.emit(new Uint8Array([1, 2]));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      error: { code: "binary_message_not_supported" },
    });
    socket.emit("x".repeat(AZOOKEY_MAX_MESSAGE_BYTES + 1));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      error: { code: "message_too_large" },
    });
    socket.emit(JSON.stringify(valid));
    await Promise.resolve();
    socket.emit(JSON.stringify({ ...valid, requestId: "busy" }));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "busy",
      error: { code: "busy" },
    });
    if (resolveConversion === undefined) {
      throw new Error("converter was not invoked");
    }
    resolveConversion("変換結果");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "req-1",
      convertedText: "変換結果",
    });
  });

  it("maps a slow converter to a bounded timeout error", async () => {
    const runtime: AzookeyRuntime = {
      timeoutMs: 25,
      converter: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "late";
      },
    };
    await expect(
      convertAzookeyMessage(parseAzookeyMessage(JSON.stringify(valid)), runtime),
    ).rejects.toMatchObject({ code: "conversion_timeout", requestId: "req-1" });
  });

  it("allows an unauthenticated local socket when no secret is configured", async () => {
    const server = new FakeSocket();
    const client = {} as WebSocket;
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      {},
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({ client, server }) as unknown as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(client);
    expect(server.accepted).toBe(true);
    expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
      type: "azookey.ready",
      protocol: "azookey.text.v1",
    });

    server.emit(JSON.stringify({ ...valid, auth: undefined }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(server.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      requestId: "req-1",
      convertedText: "converted:きょうははいしんです",
    });
  });

  it("validates WebSocket upgrades, native bearer headers, and converter availability", async () => {
    expect(isWebSocketUpgrade(new Request("https://worker.example"))).toBe(false);
    expect(
      isWebSocketUpgrade(
        new Request("https://worker.example", { headers: { upgrade: "WebSocket" } }),
      ),
    ).toBe(true);
    await expect(bearerTokenMatches(new Request("https://worker.example"), "secret")).resolves.toBe(
      false,
    );
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Basic secret" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer secret" } }),
        "secret",
      ),
    ).resolves.toBe(true);
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer wrong" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: vi
            .fn()
            .mockResolvedValueOnce(new Uint8Array([1]).buffer)
            .mockResolvedValueOnce(new Uint8Array([1, 2]).buffer),
        },
      },
    });
    await expect(
      bearerTokenMatches(
        new Request("https://worker.example", { headers: { authorization: "Bearer secret" } }),
        "secret",
      ),
    ).resolves.toBe(false);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });

    const notUpgrade = await openAzookeySocket(new Request("https://worker.example"), {});
    expect(notUpgrade.status).toBe(426);
    const wrongMethod = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        method: "POST",
        headers: { upgrade: "websocket" },
      }),
      {},
    );
    expect(wrongMethod.status).toBe(405);
    const unauthorized = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket", authorization: "Bearer wrong" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
    );
    expect(unauthorized.status).toBe(401);
    const unavailable = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
    );
    expect(unavailable.status).toBe(503);

    class FakeWebSocketPair {
      readonly 0 = {} as WebSocket;
      readonly 1 = new FakeSocket() as unknown as WebSocket;
    }
    Object.defineProperty(globalThis, "WebSocketPair", {
      configurable: true,
      value: FakeWebSocketPair,
    });
    const pairResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      { converter: (text) => text },
    );
    expect(pairResponse.status).toBe(101);
    const wasmBytes = readFileSync(new URL("../wasm/azookey.wasm", import.meta.url));
    const wasmPairResponse = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      {
        wasmModule: new WebAssembly.Module(wasmBytes),
        socketPair: () =>
          ({ client: {} as WebSocket, server: new FakeSocket() as unknown as WebSocket }) as {
            client: WebSocket;
            server: WebSocket;
          },
      },
    );
    expect(wasmPairResponse.status).toBe(101);
    vi.unstubAllGlobals();
  });
});
