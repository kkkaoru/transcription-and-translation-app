import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config.js";
import {
  createGracefulShutdown,
  type GatewayProcess,
  resolveConfigPath,
  runGateway,
} from "./main.js";

const baseConfig = (port: number): GatewayConfig => ({
  listen: { host: "127.0.0.1", port },
  parapper: { url: "ws://127.0.0.1:18082/ws/recognition", timeoutMs: 1000 },
  models: {
    "hy-mt2-1.8b-gguf": { baseUrl: "http://127.0.0.1:8082", servedModel: "hy" },
  },
});

const temporaryConfig = (config: GatewayConfig): { path: string; dispose: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "caption-bridge-gateway-main-"));
  const path = join(directory, "gateway.json");
  writeFileSync(path, JSON.stringify(config));
  return {
    path,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
};

const fakeProcess = (): GatewayProcess & { handlers: Map<string, () => void> } => {
  const handlers = new Map<string, () => void>();
  const runtime = {
    exitCode: 0,
    once: (signal: string, listener: () => void) => {
      handlers.set(signal, listener);
      return runtime;
    },
    handlers,
  };
  return runtime as unknown as GatewayProcess & { handlers: Map<string, () => void> };
};

type InfoSpy = { mock: { calls: unknown[][] } };

const structuredRecords = (info: InfoSpy): Array<Record<string, unknown>> =>
  info.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string") {
      return [];
    }
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

describe("inference gateway bootstrap lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves explicit, environment, and default config paths", () => {
    expect(resolveConfigPath(["node", "main", "--config", "/tmp/explicit.json"], {}, "/tmp")).toBe(
      "/tmp/explicit.json",
    );
    expect(
      resolveConfigPath(["node", "main"], { CAPTION_BRIDGE_GATEWAY_CONFIG: "env.json" }, "/tmp"),
    ).toBe("env.json");
    expect(resolveConfigPath(["node", "main"], {}, "/tmp")).toBe("/tmp/gateway.config.json");
    expect(() => resolveConfigPath(["node", "main", "--config"], {}, "/tmp")).toThrow(
      "--config requires",
    );
  });

  it("reports EADDRINUSE as a structured bootstrap failure and sets a non-zero exit code", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("test blocker has no TCP address");
    }

    const temporary = temporaryConfig(baseConfig(address.port));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stderr = { write: vi.fn() };
    const runtime = fakeProcess();
    try {
      await expect(
        runGateway({
          argv: ["node", "main", "--config", temporary.path],
          process: runtime,
          stderr,
        }),
      ).resolves.toBeUndefined();
      expect(runtime.exitCode).toBe(1);
      expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining("EADDRINUSE"));
      expect(structuredRecords(info)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "gateway_bootstrap_failure",
            phase: "listen",
            outcome: "failed",
            error_code: "EADDRINUSE",
          }),
        ]),
      );
    } finally {
      temporary.dispose();
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("turns a missing --config value into a structured bootstrap failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stderr = { write: vi.fn() };
    const runtime = fakeProcess();

    await expect(
      runGateway({
        argv: ["node", "main", "--config"],
        process: runtime,
        stderr,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.exitCode).toBe(1);
    expect(structuredRecords(info)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "gateway_bootstrap_failure",
          phase: "bootstrap",
          outcome: "failed",
          error_code: "bootstrap_failed",
        }),
      ]),
    );
  });

  it("bounds graceful shutdown and force-closes lingering connections", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    } as unknown as Server;
    const runtime = fakeProcess();
    const stop = createGracefulShutdown(server, {
      process: runtime,
      timeoutMs: 5,
    });

    const first = stop("SIGTERM");
    const second = stop("SIGINT");
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    expect(runtime.exitCode).toBe(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(structuredRecords(info).map((record) => record["event"])).toEqual([
      "gateway_shutdown_start",
      "gateway_shutdown_timeout",
      "gateway_shutdown_failure",
    ]);
  });

  it("installs SIGINT and SIGTERM handlers after listening", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const server = new EventEmitter() as unknown as Server & { listening: boolean };
    server.listening = false;
    server.listen = vi.fn(() => {
      server.listening = true;
      queueMicrotask(() => server.emit("listening"));
      return server;
    }) as unknown as Server["listen"];
    server.close = vi.fn((callback?: (error?: Error) => void) => {
      server.listening = false;
      callback?.();
    }) as unknown as Server["close"];

    const temporary = temporaryConfig(baseConfig(8765));
    const runtime = fakeProcess();
    try {
      await expect(
        runGateway({
          argv: ["node", "main", "--config", temporary.path],
          process: runtime,
          stderr: { write: vi.fn() },
          createServer: () => server,
        }),
      ).resolves.toBe(server);

      expect(runtime.handlers.has("SIGINT")).toBe(true);
      expect(runtime.handlers.has("SIGTERM")).toBe(true);
      expect(structuredRecords(info).map((record) => record["event"])).toEqual([
        "gateway_bootstrap_success",
      ]);

      runtime.handlers.get("SIGINT")?.();
      await vi.waitFor(() =>
        expect(structuredRecords(info).map((record) => record["event"])).toEqual([
          "gateway_bootstrap_success",
          "gateway_shutdown_start",
          "gateway_shutdown_complete",
        ]),
      );
    } finally {
      temporary.dispose();
    }
  });

  it("logs a post-listen server error and performs bounded shutdown", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const server = new EventEmitter() as unknown as Server & { listening: boolean };
    server.listening = false;
    server.listen = vi.fn(() => {
      server.listening = true;
      queueMicrotask(() => server.emit("listening"));
      return server;
    }) as unknown as Server["listen"];
    server.close = vi.fn((callback?: (error?: Error) => void) => {
      server.listening = false;
      callback?.();
    }) as unknown as Server["close"];

    const temporary = temporaryConfig(baseConfig(8765));
    const runtime = fakeProcess();
    try {
      await expect(
        runGateway({
          argv: ["node", "main", "--config", temporary.path],
          process: runtime,
          stderr: { write: vi.fn() },
          createServer: () => server,
        }),
      ).resolves.toBe(server);

      const serverError = Object.assign(new Error("socket failed"), { code: "EPIPE" });
      server.emit("error", serverError);
      await vi.waitFor(() =>
        expect(structuredRecords(info).map((record) => record["event"])).toEqual([
          "gateway_bootstrap_success",
          "gateway_server_error",
          "gateway_shutdown_start",
          "gateway_shutdown_complete",
        ]),
      );
      expect(runtime.exitCode).toBe(1);
    } finally {
      temporary.dispose();
    }
  });
});
