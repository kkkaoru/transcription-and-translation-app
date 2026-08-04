// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetStructuredLogForTests,
  appendStructuredLog,
  buildLogExportFilename,
  clearStructuredLogs,
  downloadStructuredLogs,
  estimateInputBytes,
  estimateOutputBytes,
  formatLogsAsJson,
  formatLogsAsJsonl,
  getLogLevel,
  getStructuredLogs,
  isLevelEnabled,
  isLogLevel,
  logPipelineStageEvent,
  normalizeLogLevel,
  redactSensitiveText,
  sanitizeStructuredFields,
  setLogLevel,
  subscribeStructuredLogs,
} from "./structuredLog";

afterEach(() => {
  __resetStructuredLogForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("structuredLog", () => {
  it("normalizes log levels and compares ranks", () => {
    expect(isLogLevel("debug")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(normalizeLogLevel(" TRACE ")).toBe("trace");
    expect(normalizeLogLevel("nope", "warn")).toBe("warn");
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    expect(isLevelEnabled("error")).toBe(true);
    expect(isLevelEnabled("info")).toBe(false);
    expect(localStorage.getItem("kotoba-beacon.debug.logLevel")).toBe("warn");
  });

  it("stores structured fields and filters by level for readers", () => {
    setLogLevel("trace");
    appendStructuredLog({
      level: "info",
      source: "frontend",
      message: "capture started",
      chunkId: "c1",
      fields: { deviceId: "default" },
    });
    appendStructuredLog({
      level: "error",
      source: "backend",
      stage: "asr",
      message: "asr failed",
      error: "HTTP 422",
      durationMs: 12.4,
      inputBytes: 3200,
    });
    appendStructuredLog({
      level: "trace",
      message: "frame tick",
    });

    const all = getStructuredLogs();
    expect(all).toHaveLength(3);
    expect(all[0]?.level).toBe("trace");
    expect(all[1]?.error).toBe("HTTP 422");
    expect(all[1]?.durationMs).toBe(12);

    const errorsOnly = getStructuredLogs({ maxLevel: "error" });
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]?.message).toContain("asr failed");
  });

  it("notifies subscribers and clears the ring buffer", () => {
    const spy = vi.fn();
    const unsubscribe = subscribeStructuredLogs(spy);
    appendStructuredLog({ level: "info", message: "a" });
    expect(spy).toHaveBeenCalled();
    clearStructuredLogs();
    expect(getStructuredLogs()).toEqual([]);
    unsubscribe();
  });

  it("estimates I/O sizes from stage snippets and text", () => {
    expect(estimateInputBytes("wavBytes=4096")).toBe(4096);
    expect(estimateInputBytes("こんにちは")).toBeGreaterThan(0);
    expect(estimateInputBytes("")).toBeNull();
    expect(estimateOutputBytes("hello")).toBe(5);
    expect(estimateOutputBytes("")).toBeNull();
  });

  it("maps pipeline stage events into structured backend logs", () => {
    setLogLevel("trace");
    // Verbose success → info (console.info); quiet success → debug (console.debug).
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const ok = logPipelineStageEvent(
      {
        stage: "normalize",
        utteranceId: "u-9",
        modelId: "azookey-rust",
        inputSnippet: "らーめん",
        outputText: "ラーメン",
        startedAt: 1000,
        at: 1005,
        durationMs: 5,
        ok: true,
        error: null,
      },
      { verbose: true },
    );
    expect(ok.source).toBe("backend");
    expect(ok.stage).toBe("normalize");
    expect(ok.level).toBe("info");
    expect(ok.chunkId).toBe("u-9");
    expect(ok.fields["modelId"]).toBe("azookey-rust");
    expect(ok.fields["outputText"]).toBe("ラーメン");
    expect(infoSpy).toHaveBeenCalled();

    const quietOk = logPipelineStageEvent(
      {
        stage: "normalize",
        utteranceId: "u-10",
        modelId: "azookey-rust",
        inputSnippet: "すし",
        outputText: "寿司",
        startedAt: 1100,
        at: 1104,
        durationMs: 4,
        ok: true,
        error: null,
      },
      { verbose: false },
    );
    // Successes are always logged at info level so they're visible at the default level.
    expect(quietOk.level).toBe("info");
    expect(quietOk.durationMs).toBe(4);
    expect(quietOk.fields["modelId"]).toBe("azookey-rust");
    // But verbose: false means I/O samples are NOT included in fields.
    expect(quietOk.fields["inputSnippet"]).toBeUndefined();
    expect(quietOk.fields["outputText"]).toBeUndefined();
    expect(infoSpy).toHaveBeenCalled();

    const failed = logPipelineStageEvent({
      stage: "translate",
      utteranceId: "u-9",
      modelId: "hy-mt2-1.8b-gguf",
      inputSnippet: "ラーメン",
      outputText: "",
      startedAt: 1010,
      at: 1050,
      durationMs: 40,
      ok: false,
      error: "gateway timeout",
    });
    expect(failed.level).toBe("error");
    expect(failed.error).toBe("gateway timeout");
  });

  it("formats JSON / JSONL and builds export filenames", () => {
    appendStructuredLog({ level: "info", message: "one", epochMs: 1_700_000_000_000 });
    appendStructuredLog({ level: "warn", message: "two", epochMs: 1_700_000_000_100 });
    const json = formatLogsAsJson();
    expect(json).toContain("one");
    expect(json).toContain("two");
    const jsonl = formatLogsAsJsonl();
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(2);
    // chronological: older first
    expect(JSON.parse(lines[0] ?? "{}").message).toBe("one");
    expect(buildLogExportFilename("jsonl", new Date("2026-08-01T00:00:00.000Z"))).toBe(
      "kotoba-beacon-logs-2026-08-01T00-00-00-000Z.jsonl",
    );
  });

  it("downloads a JSONL blob via an anchor click", () => {
    appendStructuredLog({ level: "info", message: "export-me" });
    const click = vi.fn();
    const remove = vi.fn();
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    });
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === "a") {
        Object.defineProperty(el, "click", { value: click });
        Object.defineProperty(el, "remove", { value: remove });
      }
      return el;
    });
    const name = downloadStructuredLogs("jsonl");
    expect(name).toMatch(/^kotoba-beacon-logs-.*\.jsonl$/);
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });

  it("redacts credentials from messages, errors, and sensitive fields", () => {
    const message = appendStructuredLog({
      level: "error",
      message:
        "request failed Authorization: Bearer abc.def.ghi https://example.test/?access_token=top-secret",
      error: "apiKey=also-secret",
      fields: {
        apiKey: "secret-value",
        endpoint: "https://example.test/v1?token=another-secret",
        status: 503,
      },
    });

    expect(message.message).not.toContain("abc.def.ghi");
    expect(message.message).not.toContain("top-secret");
    expect(message.error).toContain("[REDACTED]");
    expect(message.fields["apiKey"]).toBe("[REDACTED]");
    expect(message.fields["endpoint"]).not.toContain("another-secret");
    expect(message.fields["status"]).toBe(503);
    expect(redactSensitiveText("password: hunter2")).toBe("password: [REDACTED]");
    expect(sanitizeStructuredFields({ accessToken: "token", modelId: "hy-mt2", ok: true })).toEqual(
      { accessToken: "[REDACTED]", modelId: "hy-mt2", ok: true },
    );
  });

  it("bounds malformed timestamps and unbounded diagnostic text", () => {
    const huge = "x".repeat(10_000);
    const record = appendStructuredLog({
      level: "info",
      message: huge,
      error: huge,
      fields: { detail: huge },
      epochMs: Number.MAX_VALUE,
    });

    expect(() => new Date(record.epochMs).toISOString()).not.toThrow();
    expect(record.message.length).toBeLessThanOrEqual(4_097);
    expect(record.error?.length).toBeLessThanOrEqual(4_097);
    expect(String(record.fields["detail"]).length).toBeLessThanOrEqual(4_097);
  });

  it("falls back to epoch zero when the wall clock is non-finite", () => {
    vi.spyOn(Date, "now").mockReturnValue(Number.POSITIVE_INFINITY);

    const record = appendStructuredLog({ level: "info", message: "clock edge" });

    expect(record.epochMs).toBe(0);
    expect(record.at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("keeps malformed runtime values safe and JSON-compatible", () => {
    const throwingValue = {
      toString: () => {
        throw new Error("cannot stringify");
      },
    };
    const record = appendStructuredLog({
      level: "info",
      message: throwingValue as never,
      fields: { nested: { token: "secret" } as never },
    });

    expect(record.message).toBe("(empty)");
    expect(record.fields["nested"]).toBe("[REDACTED]");
    expect(redactSensitiveText(throwingValue as never)).toBeNull();
  });

  it("isolates subscriber and console transport failures", () => {
    const first = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const second = vi.fn();
    subscribeStructuredLogs(first);
    subscribeStructuredLogs(second);
    setLogLevel("info");
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();

    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const record = appendStructuredLog({ level: "info", message: "still stored" });
    expect(getStructuredLogs()[0]).toEqual(record);
  });

  it("keeps the selected level when localStorage rejects a preference write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });

    expect(setLogLevel("debug")).toBe("debug");
    expect(getLogLevel()).toBe("debug");
  });
});
