import { describe, expect, it } from "vitest";

import {
  errorColor,
  getParapperErrorMessage,
  normalizeParapperErrorPayload,
} from "../src/lib/error";
import { notificationColor } from "../src/lib/theme";
import type { ParapperErrorPayload, ParapperErrorType } from "../src/lib/types";

const PARAPPER_ERROR_TYPES: readonly ParapperErrorType[] = [
  "AUDIO_INPUT",
  "RESAMPLER",
  "VAD",
  "ASR",
  "RECOGNITION_BUSY",
  "MODEL_DOWNLOAD",
  "NEO_HTTP",
  "OSC_QUERY",
  "FILE_SAVE",
  "CONFIG",
  "UNKNOWN",
];

const validPayload = (
  overrides: Partial<ParapperErrorPayload> = {},
): ParapperErrorPayload => ({
  errorType: "ASR",
  severity: "fatal",
  detail: "model not found",
  ...overrides,
});

describe("normalizeParapperErrorPayload", () => {
  it("returns a valid payload unchanged except for undefined detail becoming null", () => {
    expect(normalizeParapperErrorPayload(validPayload())).toEqual(
      validPayload(),
    );

    const withUndefinedDetail = validPayload({ detail: undefined });
    expect(normalizeParapperErrorPayload(withUndefinedDetail)).toEqual({
      errorType: "ASR",
      severity: "fatal",
      detail: null,
    });
  });

  it("preserves null detail without converting it to a string", () => {
    expect(
      normalizeParapperErrorPayload(validPayload({ detail: null })),
    ).toEqual({
      errorType: "ASR",
      severity: "fatal",
      detail: null,
    });
  });

  it("preserves a warning severity", () => {
    expect(
      normalizeParapperErrorPayload(validPayload({ severity: "warning" })),
    ).toEqual({
      errorType: "ASR",
      severity: "warning",
      detail: "model not found",
    });
  });

  it("falls back to UNKNOWN/fatal when errorType is not a known type", () => {
    const result = normalizeParapperErrorPayload({
      errorType: "NOT_A_REAL_TYPE",
      severity: "fatal",
      detail: "oops",
    });
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.severity).toBe("fatal");
  });

  it("falls back to UNKNOWN/fatal when severity is invalid", () => {
    const result = normalizeParapperErrorPayload({
      errorType: "ASR",
      severity: "info",
      detail: "oops",
    });
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.severity).toBe("fatal");
  });

  it("falls back to UNKNOWN/fatal when detail is a non-string, non-null value", () => {
    const result = normalizeParapperErrorPayload({
      errorType: "ASR",
      severity: "fatal",
      detail: 42,
    });
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.severity).toBe("fatal");
  });

  it("uses the string value directly as detail for non-object inputs", () => {
    const result = normalizeParapperErrorPayload("something went wrong");
    expect(result).toEqual({
      errorType: "UNKNOWN",
      severity: "fatal",
      detail: "something went wrong",
    });
  });

  it("stringifies non-string, non-object values for the detail field", () => {
    expect(normalizeParapperErrorPayload(42).detail).toBe("42");
    expect(normalizeParapperErrorPayload(false).detail).toBe("false");
  });

  it("falls back to UNKNOWN/fatal with null detail for null input", () => {
    const result = normalizeParapperErrorPayload(null);
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.severity).toBe("fatal");
    expect(result.detail).toBe("null");
  });

  it("falls back to UNKNOWN/fatal for undefined input", () => {
    const result = normalizeParapperErrorPayload(undefined);
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.severity).toBe("fatal");
  });

  it("does not treat an empty string as a valid object payload", () => {
    const result = normalizeParapperErrorPayload("");
    expect(result).toEqual({
      errorType: "UNKNOWN",
      severity: "fatal",
      detail: "",
    });
  });
});

describe("getParapperErrorMessage", () => {
  it("returns a non-empty Japanese message for each error type", () => {
    for (const errorType of PARAPPER_ERROR_TYPES) {
      const message = getParapperErrorMessage({
        errorType,
        severity: "fatal",
        detail: null,
      });
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("returns a distinct message for each error type", () => {
    const messages = new Set<string>();
    for (const errorType of PARAPPER_ERROR_TYPES) {
      messages.add(
        getParapperErrorMessage({
          errorType,
          severity: "fatal",
          detail: null,
        }),
      );
    }
    expect(messages.size).toBe(PARAPPER_ERROR_TYPES.length);
  });
});

describe("errorColor", () => {
  it("returns the warning color for warning severity", () => {
    expect(errorColor("warning")).toBe(notificationColor.warn);
  });

  it("returns the error color for fatal severity", () => {
    expect(errorColor("fatal")).toBe(notificationColor.error);
  });
});
