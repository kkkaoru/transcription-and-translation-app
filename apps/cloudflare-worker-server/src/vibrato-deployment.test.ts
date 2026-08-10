import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type AzookeyFetcher,
  convertAzookeyMessage,
  createVibratoHttpConverter,
  createVibratoWasmConverter,
  INFERENCE_PUBLIC_HOST,
  openAzookeySocket,
  parseAzookeyMessage,
  VIBRATO_MAX_DICTIONARY_BYTES,
} from "./azookey.js";
import { createWorker } from "./index.js";

const valid = {
  type: "azookey.convert",
  requestId: "req-vibrato",
  source: "web-speech",
  language: "ja",
  sourceText: "きょうははいしんです",
  vibratoInput: "きょうははいしんです",
  mode: "worker-vibrato",
} as const;

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  accepted = false;
  closed = false;

  accept(): void {
    this.accepted = true;
  }

  close(): void {
    this.closed = true;
  }

  send(value: string): void {
    this.sent.push(value);
  }

  emit(value: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

const waitForMessage = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const workerMessage = (vibratoExecution: "worker" | "browser-wasm" = "worker") =>
  parseAzookeyMessage(JSON.stringify({ ...valid, vibratoExecution }));

describe("Worker-side Vibrato and deployment paths", () => {
  it("runs the real WASM adapter with the standard IPADIC dictionary and caches it", async () => {
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/vibrato_wasm_bg.wasm", import.meta.url)),
    );
    const dictionary = readFileSync(
      new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst", import.meta.url),
    );
    const fetcher = vi.fn(() => new Response(dictionary));
    const converter = createVibratoWasmConverter(
      wasmModule,
      "https://dictionary.example/system.dic.zst",
      fetcher,
    );
    if (!converter) {
      throw new Error("WASM converter was not created");
    }
    await expect(converter("外の天気が暑いから", "ja")).resolves.toBe("そとのてんきがあついから");
    await expect(converter("スープが熱い", "ja")).resolves.toBe("すーぷがあつい");
    expect(fetcher).toHaveBeenCalledTimes(1);

    const assetConverter = createVibratoWasmConverter(
      wasmModule,
      "/vibrato/system.dic.zst",
      () => new Response(dictionary),
    );
    await expect(assetConverter?.("東京都に住む", "ja")).resolves.toBe("とうきょうとにすむ");

    expect(
      createVibratoWasmConverter(undefined, "https://dictionary.example/dict"),
    ).toBeUndefined();
    expect(createVibratoWasmConverter(wasmModule, undefined)).toBeUndefined();
    expect(() => createVibratoWasmConverter(wasmModule, "file:///tmp/dict")).toThrow(
      "http:// or https://",
    );

    const invalidResponses: Array<[Response | (() => never), string]> = [
      [new Response("busy", { status: 503 }), "returned 503"],
      [new Response(new Uint8Array(0)), "dictionary is empty"],
      [new Response(new Uint8Array(VIBRATO_MAX_DICTIONARY_BYTES + 1)), "exceeds the byte limit"],
      [
        () => {
          throw "offline";
        },
        "Vibrato dictionary initialization failed",
      ],
      [new Response(new Uint8Array([1, 2, 3])), "zstd decode error"],
    ];
    for (const [response, message] of invalidResponses) {
      const failing = createVibratoWasmConverter(
        wasmModule,
        "https://dictionary.example/dict",
        () => (typeof response === "function" ? response() : response),
      );
      await expect(failing?.("入力", "ja")).rejects.toThrow(message);
    }
  });

  it("selects an explicit Worker dictionary even when the portable AzooKey archive is configured", async () => {
    const wasmModule = new WebAssembly.Module(
      readFileSync(new URL("../wasm/vibrato_wasm_bg.wasm", import.meta.url)),
    );
    const dictionary = readFileSync(
      new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst", import.meta.url),
    );
    const server = new FakeSocket();
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {
        AZOOKEY_DICTIONARY_URL: "/azookey/system.azkdict.gz",
        VIBRATO_DICTIONARY_URL: "/vibrato/system.dic.zst",
      },
      {
        converter: (text) => text,
        vibratoWasmModule: wasmModule,
        vibratoDictionaryFetcher: () => new Response(dictionary),
        socketPair: () => ({ client: {} as WebSocket, server: server as unknown as WebSocket }),
      },
    );

    expect(response.status).toBe(101);
    expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
      vibrato: { workerStage: "configured", workerPassthrough: false },
    });
    server.emit(
      JSON.stringify({
        ...valid,
        requestId: "req-explicit-worker-dictionary",
        sourceText: "東京都に住む",
        vibratoInput: "東京都に住む",
        vibratoExecution: "worker",
      }),
    );
    await waitForMessage();
    expect(JSON.parse(server.sent.at(-1) ?? "{}")).toMatchObject({
      requestId: "req-explicit-worker-dictionary",
      vibratoInput: "とうきょうとにすむ",
      vibratoStage: "configured",
      vibratoPassthrough: false,
    });
  });

  it("fails closed when an explicit Worker dictionary has no WASM adapter", async () => {
    const server = new FakeSocket();
    const client = new FakeSocket();
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {
        AZOOKEY_DICTIONARY_URL: "/azookey/system.azkdict.gz",
        VIBRATO_DICTIONARY_URL: "/vibrato/system.dic.zst",
      },
      {
        converter: (text) => text,
        socketPair: () => ({
          client: client as unknown as WebSocket,
          server: server as unknown as WebSocket,
        }),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "vibrato_unavailable" },
    });
    expect(server.closed).toBe(true);
    expect(client.closed).toBe(true);
  });

  it("validates the optional HTTP adapter and preserves its small contract", async () => {
    expect(createVibratoHttpConverter({})).toBeUndefined();
    expect(() =>
      createVibratoHttpConverter({ VIBRATO_UPSTREAM_URL: "ftp://not-http.invalid" }),
    ).toThrow("http:// or https://");

    const fetcher: AzookeyFetcher = vi.fn(
      () =>
        new Response(JSON.stringify({ text: "ひらがな" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const converter = createVibratoHttpConverter(
      {
        VIBRATO_UPSTREAM_URL: " https://vibrato.example.test/convert ",
        VIBRATO_API_TOKEN: " token ",
      },
      fetcher,
    );
    if (!converter) {
      throw new Error("converter was not created");
    }
    await expect(converter("入力", "ja-JP")).resolves.toBe("ひらがな");
    expect(fetcher).toHaveBeenCalledWith(
      "https://vibrato.example.test/convert",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer token",
        },
        body: JSON.stringify({ text: "入力", language: "ja-JP" }),
      }),
    );

    const aliases = ["hiragana", "reading"] as const;
    for (const field of aliases) {
      const aliasConverter = createVibratoHttpConverter(
        { VIBRATO_UPSTREAM_URL: "https://vibrato.example.test/convert" },
        () => new Response(JSON.stringify({ [field]: "よみ" })),
      );
      await expect(aliasConverter?.("入力", "ja")).resolves.toBe("よみ");
    }

    const failures: Array<[Response | Promise<Response> | never, string]> = [
      [new Response("busy", { status: 503 }), "returned 503"],
      [new Response("not-json"), "invalid JSON"],
      [new Response("null"), "must be an object"],
      [new Response(JSON.stringify({ text: " " })), "no non-empty text"],
      [new Response(JSON.stringify({ text: "あ".repeat(4_096) })), "exceeds the text byte limit"],
    ];
    for (const [response, message] of failures) {
      const failing = createVibratoHttpConverter(
        { VIBRATO_UPSTREAM_URL: "https://vibrato.example.test/convert" },
        () => response,
      );
      await expect(failing?.("入力", "ja")).rejects.toThrow(message);
    }

    const connection = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example.test/convert" },
      () => {
        throw new Error("offline");
      },
    );
    await expect(connection?.("入力", "ja")).rejects.toThrow("connection failed: offline");
    const unknownConnection = createVibratoHttpConverter(
      { VIBRATO_UPSTREAM_URL: "https://vibrato.example.test/convert" },
      () => {
        throw "offline";
      },
    );
    await expect(unknownConnection?.("入力", "ja")).rejects.toThrow(
      "connection failed: connection failed",
    );
  });

  it("runs the configured worker pre-pass before AzooKey conversion", async () => {
    const message = workerMessage();
    const seen: string[] = [];
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        vibrato: (text, language) => {
          seen.push(`${language}:${text}`);
          return "ひらがな";
        },
        converter: (text) => `converted:${text}`,
      }),
    ).resolves.toMatchObject({
      convertedText: "converted:ひらがな",
      vibratoInput: "ひらがな",
      vibratoExecution: "worker",
      vibratoStage: "configured",
      vibratoPassthrough: false,
    });
    expect(seen).toEqual(["ja:きょうははいしんです"]);

    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        vibratoStage: "passthrough",
        vibrato: (text) => text,
        converter: (text) => `converted:${text}`,
      }),
    ).resolves.toMatchObject({
      sourceText: "きょうははいしんです",
      vibratoInput: "きょうははいしんです",
      vibratoExecution: "worker",
      vibratoStage: "passthrough",
      vibratoPassthrough: true,
    });

    await expect(
      convertAzookeyMessage(message, { timeoutMs: 250, converter: (text) => text }),
    ).rejects.toMatchObject({ code: "vibrato_unavailable", requestId: message.requestId });
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        vibrato: () => " ",
        converter: (text) => text,
      }),
    ).rejects.toMatchObject({ code: "vibrato_failed" });
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        vibrato: () => "あ".repeat(4_096),
        converter: (text) => text,
      }),
    ).rejects.toMatchObject({ code: "vibrato_failed" });
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 25,
        vibrato: () => new Promise<string>(() => undefined),
        converter: (text) => text,
      }),
    ).rejects.toMatchObject({ code: "vibrato_timeout" });
    await expect(
      convertAzookeyMessage(message, {
        timeoutMs: 250,
        vibrato: () => {
          throw "worker failed";
        },
        converter: (text) => text,
      }),
    ).rejects.toMatchObject({
      code: "vibrato_failed",
      message: "Worker Vibrato conversion failed",
    });

    const browserMessage = workerMessage("browser-wasm");
    await expect(
      convertAzookeyMessage(browserMessage, { timeoutMs: 250, converter: (text) => `ok:${text}` }),
    ).resolves.toMatchObject({
      convertedText: "ok:きょうははいしんです",
      vibratoInput: "きょうははいしんです",
      vibratoExecution: "browser-wasm",
      vibratoStage: "browser-wasm",
      vibratoPassthrough: false,
    });
  });

  it("supports first-frame bearer auth and reports invalid adapter configuration safely", async () => {
    const server = new FakeSocket();
    const client = {} as WebSocket;
    const response = await openAzookeySocket(
      new Request(`https://${INFERENCE_PUBLIC_HOST}/ws/azookey`, {
        headers: { upgrade: "websocket" },
      }),
      { AZOOKEY_API_TOKEN: "secret" },
      {
        converter: (text) => `converted:${text}`,
        socketPair: () =>
          ({ client, server }) as unknown as { client: WebSocket; server: WebSocket },
      },
    );
    expect(response.status).toBe(101);
    expect(server.accepted).toBe(true);
    server.emit(JSON.stringify({ ...valid, auth: { scheme: "bearer", token: "secret" } }));
    await waitForMessage();
    expect(JSON.parse(server.sent.at(-1) ?? "{}")).toMatchObject({
      type: "azookey.result",
      convertedText: "converted:きょうははいしんです",
    });

    const invalidAdapter = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", {
        headers: { upgrade: "websocket" },
      }),
      { VIBRATO_UPSTREAM_URL: "ftp://not-http.invalid" },
      {
        converter: (text) => text,
        socketPair: () =>
          ({ client, server }) as unknown as { client: WebSocket; server: WebSocket },
      },
    );
    expect(invalidAdapter.status).toBe(503);
    await expect(invalidAdapter.json()).resolves.toMatchObject({
      error: { code: "vibrato_unavailable" },
    });
  });

  it("prewarms the direct adapter before accepting a socket and fails closed", async () => {
    const server = new FakeSocket();
    const client = {} as WebSocket;
    const warmup = vi.fn(async () => undefined);
    const converter = Object.assign((text: string) => text, { warmup });
    const response = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      {
        converter,
        vibratoConverter: converter,
        socketPair: () =>
          ({ client, server }) as unknown as { client: WebSocket; server: WebSocket },
      },
    );
    expect(response.status).toBe(101);
    expect(warmup).toHaveBeenCalledTimes(1);
    expect(server.accepted).toBe(true);

    const failedClient = new FakeSocket();
    const failedServer = new FakeSocket();
    const failed = await openAzookeySocket(
      new Request("https://worker.example/ws/azookey", { headers: { upgrade: "websocket" } }),
      {},
      {
        converter,
        vibratoConverter: Object.assign((text: string) => text, {
          warmup: () => Promise.reject(new Error("dictionary offline")),
        }),
        socketPair: () => ({
          client: failedClient as unknown as WebSocket,
          server: failedServer as unknown as WebSocket,
        }),
      },
    );
    expect(failed.status).toBe(503);
    expect(failedServer.accepted).toBe(false);
    expect(failedServer.closed).toBe(true);
    expect(failedClient.closed).toBe(true);
  });

  it("advertises the configured worker pre-pass without revealing credentials", async () => {
    const response = await createWorker().fetch(new Request("https://worker.example/v1/azookey"), {
      MODEL_ROUTES: "{}",
      VIBRATO_UPSTREAM_URL: "https://vibrato.example.test/convert",
      VIBRATO_API_TOKEN: "secret",
    });
    const body = await response.json();
    expect(body).toMatchObject({
      auth: { configured: false },
      vibrato: { workerStage: "configured", transport: "http" },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
