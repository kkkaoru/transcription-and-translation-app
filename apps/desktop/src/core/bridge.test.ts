import { describe, expect, it } from "vitest";
import { formatBridgeError } from "./bridge";

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
