import { afterEach, describe, expect, it, vi } from "vitest";
import {
  correlationFromHeaders,
  correlationHeaders,
  emitStructuredLog,
  PROVIDER_TURN_END,
  PROVIDER_TURN_SKIP,
  PROVIDER_TURN_START,
  STRUCTURED_LOG_SCHEMA_VERSION,
} from "./structuredLog.js";

describe("gateway structured logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves supplied correlation headers and generates missing identities", () => {
    const supplied = correlationFromHeaders(
      new Headers({
        "x-request-id": " req-1 ",
        "x-session-id": "sess-1",
        "x-agent-id": "agent-1",
        "x-parent-agent-id": "parent-1",
      }),
    );
    expect(supplied).toEqual({
      requestId: "req-1",
      sessionId: "sess-1",
      agentId: "agent-1",
      parentAgentId: "parent-1",
    });
    expect(correlationHeaders(supplied)).toEqual({
      "x-request-id": "req-1",
      "x-session-id": "sess-1",
      "x-agent-id": "agent-1",
      "x-parent-agent-id": "parent-1",
    });

    const generated = correlationFromHeaders(new Headers());
    expect(generated.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.agentId).toBeNull();
    expect(generated.parentAgentId).toBeNull();
    expect(correlationHeaders(generated)).toEqual({
      "x-request-id": generated.requestId,
      "x-session-id": generated.sessionId,
    });
  });

  it("emits one-line JSON records with stable provider event names", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const context = {
      requestId: "req-42",
      sessionId: "sess-42",
      agentId: "agent-42",
      parentAgentId: null,
    };
    emitStructuredLog(PROVIDER_TURN_START, context, {
      pcmBytes: 4,
      sampleRate: 16_000,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      event: PROVIDER_TURN_START,
      request_id: "req-42",
      session_id: "sess-42",
      agent_id: "agent-42",
      parent_agent_id: null,
      pcmBytes: 4,
      sampleRate: 16_000,
    });
    expect(typeof (JSON.parse(line) as { at?: unknown }).at).toBe("string");
    expect(PROVIDER_TURN_END).toBe("provider_turn.end");
    expect(PROVIDER_TURN_SKIP).toBe("provider_turn.skip");
  });

  it("bounds correlation IDs and redacts untrusted structured fields", () => {
    const long = "x".repeat(1_000);
    const correlation = correlationFromHeaders(
      new Headers({
        "x-request-id": long,
        "x-session-id": long,
        "x-agent-id": long,
      }),
    );
    expect(correlation.requestId).toHaveLength(256);
    expect(correlation.sessionId).toHaveLength(256);
    expect(correlation.agentId).toHaveLength(256);

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    emitStructuredLog("http_request_failure", correlation, {
      error: "Authorization: Bearer abc.def.ghi",
      apiKey: "secret-value",
      nested: { token: "nested-secret", status: 502 },
      nonFinite: Number.NaN,
      longText: "y".repeat(5_000),
      event: "spoofed-event",
      request_id: "spoofed-request",
    });

    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record["schema_version"]).toBe(STRUCTURED_LOG_SCHEMA_VERSION);
    expect(record["event"]).toBe("http_request_failure");
    expect(record["request_id"]).toHaveLength(256);
    expect(record["request_id"]).not.toBe("spoofed-request");
    expect(record["error"]).toContain("[REDACTED]");
    expect(record["apiKey"]).toBe("[REDACTED]");
    expect(record["nested"]).toEqual({ token: "[REDACTED]", status: 502 });
    expect(record["nonFinite"]).toBeNull();
    expect(record["longText"]).toHaveLength(4_097);
  });

  it("handles empty correlation values and all structured value categories", () => {
    const whitespace = correlationFromHeaders(new Headers({ "x-request-id": "   " }));
    expect(whitespace.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const empty = {
      requestId: "",
      sessionId: "",
      agentId: "",
      parentAgentId: "",
    };
    expect(correlationHeaders(empty)).toMatchObject({
      "x-request-id": expect.any(String),
      "x-session-id": expect.any(String),
    });
    expect(correlationHeaders(empty)).not.toHaveProperty("x-agent-id");
    expect(correlationHeaders(empty)).not.toHaveProperty("x-parent-agent-id");

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    emitStructuredLog("value-categories", empty, {
      nullableSecret: null,
      values: [true, false, null, Number.POSITIVE_INFINITY, 1n, () => undefined],
      deep: { level1: { level2: { level3: { level4: { level5: "hidden" } } } } },
    });
    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record["nullableSecret"]).toBeNull();
    expect(record["values"]).toEqual([true, false, null, null, "[UNSUPPORTED]", "[UNSUPPORTED]"]);
    expect(record["deep"]).toEqual({
      level1: { level2: { level3: { level4: { level5: "[TRUNCATED]" } } } },
    });

    const throwingFields = {} as Record<string, unknown>;
    Object.defineProperty(throwingFields, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("diagnostic field unavailable");
      },
    });
    emitStructuredLog("throwing-fields", empty, throwingFields);
    expect(info).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(info.mock.calls[1]?.[0]))).not.toHaveProperty("boom");
  });
});
