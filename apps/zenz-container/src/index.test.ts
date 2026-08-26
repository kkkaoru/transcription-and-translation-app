// This file runs with bun.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
  switchPort: vi.fn((request: Request) => request),
}));

import { fetchContainerBeforeDeadline, parseContainerRoute, warmupTargets } from "./index";

describe("Zenz Container routing", () => {
  it("parses every profile dimension and preserves the upstream path", () => {
    expect(parseContainerRoute("/basic/xsmall/n5-off/completion")).toStrictEqual({
      tier: "basic",
      model: "xsmall",
      n5Mode: "n5-off",
      upstreamPath: "/completion",
    });
    expect(parseContainerRoute("/standard/small/n5-on/n5/rescore")).toStrictEqual({
      tier: "standard",
      model: "small",
      n5Mode: "n5-on",
      upstreamPath: "/n5/rescore",
    });
  });

  it("uses health for a profile root and rejects incomplete profiles", () => {
    expect(parseContainerRoute("/basic/small/n5-on")).toStrictEqual({
      tier: "basic",
      model: "small",
      n5Mode: "n5-on",
      upstreamPath: "/health",
    });
    expect(parseContainerRoute("/basic/small")).toBeUndefined();
    expect(parseContainerRoute("/premium/small/n5-on")).toBeUndefined();
  });

  it("preloads GGUF alone when N5 is disabled", () => {
    expect(warmupTargets({ n5Enabled: false, ggufEnabled: true })).toStrictEqual([
      {
        path: "/completion",
        port: 8080,
        body: '{"prompt":"テスト","n_predict":1,"temperature":0,"cache_prompt":true}',
      },
    ]);
  });

  it("preloads GGUF and N5 concurrently when N5 is enabled", () => {
    expect(warmupTargets({ n5Enabled: true, ggufEnabled: true })).toStrictEqual([
      {
        path: "/completion",
        port: 8080,
        body: '{"prompt":"テスト","n_predict":1,"temperature":0,"cache_prompt":true}',
      },
      { path: "/rescore", port: 8081, body: '{"text":"テスト"}' },
    ]);
  });

  it("preloads only N5 when GGUF conversion is disabled", () => {
    expect(warmupTargets({ n5Enabled: true, ggufEnabled: false })).toStrictEqual([
      { path: "/rescore", port: 8081, body: '{"text":"テスト"}' },
    ]);
  });

  it("returns a response before the deadline without killing the container", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const response = await fetchContainerBeforeDeadline({
      container: {
        fetch: vi.fn(() => Promise.resolve(new Response("healthy"))),
        destroy,
      },
      request: new Request("https://zenz.internal/health"),
      port: 8080,
      deadline: new Promise(() => undefined),
    });

    expect(await response.text()).toBe("healthy");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("kills a container whose request exceeds the startup deadline", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const request = fetchContainerBeforeDeadline({
      container: {
        fetch: vi.fn(() => new Promise<Response>(() => undefined)),
        destroy,
      },
      request: new Request("https://zenz.internal/health"),
      port: 8080,
      deadline: Promise.resolve(),
    });

    await expect(request).rejects.toThrow("Container request exceeded 90000ms and was killed");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("kills a container that returns a server failure", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const request = fetchContainerBeforeDeadline({
      container: {
        fetch: vi.fn(() => Promise.resolve(new Response("unavailable", { status: 503 }))),
        destroy,
      },
      request: new Request("https://zenz.internal/health"),
      port: 8080,
      deadline: new Promise(() => undefined),
    });

    await expect(request).rejects.toThrow("Container returned 503 and was killed");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("kills a container when its startup fetch fails", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const request = fetchContainerBeforeDeadline({
      container: {
        fetch: vi.fn(() => Promise.reject(new Error("failed to start"))),
        destroy,
      },
      request: new Request("https://zenz.internal/health"),
      port: 8080,
      deadline: new Promise(() => undefined),
    });

    await expect(request).rejects.toThrow("failed to start");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
