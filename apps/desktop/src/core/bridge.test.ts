import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import { bridge, formatBridgeError, isNoSpeechBridgeError } from "./bridge";
import type { PipelineDropSignal } from "./dropDiagnostics";
import type { CaptionPayload } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("formatBridgeError", () => {
  it("extracts details from strings, Errors, and Tauri-shaped objects", () => {
    expect(formatBridgeError("gateway refused")).toBe("gateway refused");
    expect(formatBridgeError(new Error("boom"))).toBe("boom");
    expect(formatBridgeError({ message: "from message" })).toBe("from message");
    expect(formatBridgeError({ error: "from error" })).toBe("from error");
    expect(formatBridgeError({ detail: "from detail" })).toBe("from detail");
    expect(formatBridgeError(null)).toBeUndefined();
    expect(formatBridgeError(undefined)).toBeUndefined();
    expect(formatBridgeError(42)).toBeUndefined();
  });
});

describe("isNoSpeechBridgeError", () => {
  const parapper422 =
    'inference returned HTTP 422: {"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}';

  it("classifies Parapper transcript_missing 422 payloads as no-speech", () => {
    expect(isNoSpeechBridgeError(parapper422)).toBe(true);
    expect(isNoSpeechBridgeError(new Error(parapper422))).toBe(true);
    expect(isNoSpeechBridgeError({ message: parapper422 })).toBe(true);
    expect(
      isNoSpeechBridgeError({
        error:
          '{"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}',
      }),
    ).toBe(true);
  });

  it("classifies message-only no-transcript variants", () => {
    expect(isNoSpeechBridgeError("Parapper completed without a final transcript")).toBe(true);
    expect(isNoSpeechBridgeError("empty transcript")).toBe(true);
    expect(isNoSpeechBridgeError("no transcript available")).toBe(true);
  });

  it("does not soft-skip real audio/backend failures", () => {
    expect(isNoSpeechBridgeError("inference returned HTTP 500: boom")).toBe(false);
    expect(isNoSpeechBridgeError("inference returned HTTP 422: invalid_audio")).toBe(false);
    expect(isNoSpeechBridgeError("gateway refused")).toBe(false);
    expect(isNoSpeechBridgeError(null)).toBe(false);
    expect(isNoSpeechBridgeError(undefined)).toBe(false);
    expect(isNoSpeechBridgeError("")).toBe(false);
    expect(isNoSpeechBridgeError("gateway no transcript buffer")).toBe(false);
    expect(isNoSpeechBridgeError("transcript_missing_timeout")).toBe(false);
    expect(isNoSpeechBridgeError("inference returned HTTP 500: no speech timeout")).toBe(false);
  });

  it("accepts only the bounded no-speech messages emitted by recognizers", () => {
    expect(isNoSpeechBridgeError("no-speech")).toBe(true);
    expect(isNoSpeechBridgeError("Web Speech Recognition failed (no-speech)")).toBe(true);
    expect(isNoSpeechBridgeError("no usable speech")).toBe(true);
    expect(isNoSpeechBridgeError("speech service returned no transcript")).toBe(false);
  });

  it("matches nested Tauri IPC error envelopes", () => {
    expect(
      isNoSpeechBridgeError({
        data: {
          message:
            'inference returned HTTP 422: {"error":{"code":"transcript_missing","message":"Parapper completed without a final transcript"}}',
        },
      }),
    ).toBe(true);
    expect(
      formatBridgeError({
        data: { message: "nested failure" },
      }),
    ).toBe("nested failure");
  });
});

describe("browser updater bridge", () => {
  it("does not contact an updater feed outside Tauri", async () => {
    const status = await bridge.getUpdateStatus();
    expect(status.status).toBe("unsupported");
    expect(await bridge.checkForUpdate()).toBeNull();
    expect(await bridge.getRuntimeDiagnostics()).toBeNull();
    await expect(bridge.installUpdate()).rejects.toThrow(/desktop app/i);
    await expect(bridge.relaunchToUpdatedApp()).rejects.toThrow(/desktop app/i);
  });
});

describe("caption replay bridge", () => {
  it("keeps browser replay non-fatal when native history is unavailable", async () => {
    expect(await bridge.getLatestCaption()).toBeNull();
  });
});

describe("browser replay bridges", () => {
  it("returns empty native history and no latest caption outside Tauri", async () => {
    expect(await bridge.getPipelineStageHistory()).toEqual([]);
    expect(await bridge.getLatestCaption()).toBeNull();
  });
});

describe("pipeline drop bridge", () => {
  const withTauriRuntime = async (run: () => Promise<void>): Promise<void> => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    try {
      await run();
    } finally {
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
    }
  };

  it("is a no-op outside Tauri", async () => {
    vi.mocked(listen).mockClear();
    const dispose = await bridge.listenPipelineDrops(() => undefined);
    expect(dispose).toBeTypeOf("function");
    expect(listen).not.toHaveBeenCalled();
  });

  it("forwards native drop payloads and returns the unlisten function", async () => {
    const unlisten = vi.fn();
    let onEvent: ((event: { payload: PipelineDropSignal }) => void) | undefined;
    vi.mocked(listen).mockImplementation((_name, callback) => {
      onEvent = callback as unknown as (event: { payload: PipelineDropSignal }) => void;
      return Promise.resolve(unlisten);
    });
    const received = vi.fn();
    await withTauriRuntime(async () => {
      const dispose = await bridge.listenPipelineDrops(received);
      expect(listen).toHaveBeenCalledWith("pipeline:drop", expect.any(Function));
      onEvent?.({ payload: { source: "translation", reason: "retired", count: 1 } });
      expect(received).toHaveBeenCalledWith({
        source: "translation",
        reason: "retired",
        count: 1,
      });
      dispose();
    });
    expect(unlisten).toHaveBeenCalledOnce();
    vi.mocked(listen).mockReset();
  });
});

describe("publishSourceCaption generation fencing", () => {
  const caption = (captureGeneration?: number): CaptionPayload => ({
    id: "utterance-1",
    sourceText: "こんにちは",
    translationText: "",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: 1_000,
    receivedAt: 1_200,
    isFinal: true,
    captureGeneration,
  });

  const withTauriRuntime = async (run: () => Promise<void>): Promise<void> => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    try {
      await run();
    } finally {
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
    }
  };

  it("forwards the capture generation so native can reject a superseded attempt", async () => {
    vi.mocked(invoke).mockClear();
    await withTauriRuntime(async () => {
      await bridge.publishSourceCaption(caption(7));
    });
    const [command, args] = vi.mocked(invoke).mock.calls[0] ?? [];
    expect(command).toBe("publish_source_caption");
    expect(
      (args as { caption: { captureGeneration: number | null } }).caption.captureGeneration,
    ).toBe(7);
  });

  it("sends null rather than 0 when the caption carries no generation", async () => {
    vi.mocked(invoke).mockClear();
    await withTauriRuntime(async () => {
      await bridge.publishSourceCaption(caption(undefined));
    });
    const [, args] = vi.mocked(invoke).mock.calls[0] ?? [];
    // 0 is never a live generation natively, so it would drop every caption.
    expect(
      (args as { caption: { captureGeneration: number | null } }).caption.captureGeneration,
    ).toBeNull();
  });
});
