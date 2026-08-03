import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayConfig } from "./config.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayServer } from "./server.js";
import {
  type CorrelationContext,
  correlationFromHeaders,
  emitStructuredLog,
} from "./structuredLog.js";

export const GATEWAY_SHUTDOWN_TIMEOUT_MS = 5_000;

export type GatewayProcess = Pick<NodeJS.Process, "once" | "exitCode">;

export type GatewayOutput = Pick<NodeJS.WriteStream, "write">;

export interface GatewayMainOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  process?: GatewayProcess;
  stderr?: GatewayOutput;
  createServer?: (config: GatewayConfig) => Server;
  shutdownTimeoutMs?: number;
}

export interface GatewayShutdownOptions {
  process?: GatewayProcess;
  timeoutMs?: number;
  correlation?: CorrelationContext;
}

const bootstrapCorrelation = (): CorrelationContext => correlationFromHeaders(new Headers());

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const emitGatewayLog = (
  event: string,
  correlation: CorrelationContext,
  fields: Record<string, unknown> = {},
): void => {
  try {
    emitStructuredLog(event, correlation, {
      component: "inference-gateway",
      ...fields,
    });
  } catch {
    // Diagnostics must never mask the bootstrap or shutdown result.
  }
};

const reportBootstrapFailure = (
  correlation: CorrelationContext,
  phase: string,
  error: unknown,
  output: GatewayOutput,
  fields: Record<string, unknown> = {},
): void => {
  const code = errorCode(error);
  emitGatewayLog("gateway_bootstrap_failure", correlation, {
    phase,
    outcome: "failed",
    ...(code ? { error_code: code } : { error_code: "bootstrap_failed" }),
    error_name: errorName(error),
    error_message: errorMessage(error),
    ...fields,
  });
  try {
    output.write(
      `Gateway bootstrap failed during ${phase}: ${errorMessage(error)}${code ? ` (${code})` : ""}\n`,
    );
  } catch {
    // A broken stderr stream must not hide the non-zero exit status.
  }
};

export const resolveConfigPath = (
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string => {
  const configArgument = argv.indexOf("--config");
  if (configArgument >= 0 && !argv[configArgument + 1]) {
    throw new Error("--config requires an absolute or relative JSON file path");
  }
  const explicitConfig = configArgument >= 0 ? argv[configArgument + 1] : undefined;
  return (
    explicitConfig ?? env["CAPTION_BRIDGE_GATEWAY_CONFIG"] ?? resolve(cwd, "gateway.config.json")
  );
};

const listenGateway = (server: Server, config: GatewayConfig): Promise<void> =>
  new Promise((resolveListening, rejectListening) => {
    let settled = false;

    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveListening();
    };
    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectListening(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen(config.listen.port, config.listen.host);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

const closeConnections = (server: Server): void => {
  try {
    server.closeIdleConnections?.();
  } catch {
    // Best effort; closeAllConnections below is the hard stop.
  }
  try {
    server.closeAllConnections?.();
  } catch {
    // Best effort; the close callback or timeout remains authoritative.
  }
};

export const createGracefulShutdown = (
  server: Server,
  options: GatewayShutdownOptions = {},
): ((signal: string) => Promise<void>) => {
  const runtimeProcess = options.process ?? process;
  const timeoutMs = Math.max(0, options.timeoutMs ?? GATEWAY_SHUTDOWN_TIMEOUT_MS);
  const correlation = options.correlation ?? bootstrapCorrelation();
  let shutdownPromise: Promise<void> | undefined;

  return (signal: string): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = new Promise<void>((resolveShutdown) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, forced = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (error) {
          runtimeProcess.exitCode = 1;
          emitGatewayLog("gateway_shutdown_failure", correlation, {
            signal,
            outcome: "failed",
            forced,
            error_code: errorCode(error) ?? "shutdown_failed",
            error_name: errorName(error),
            error_message: errorMessage(error),
          });
        } else {
          emitGatewayLog("gateway_shutdown_complete", correlation, {
            signal,
            outcome: "completed",
            forced,
          });
        }
        resolveShutdown();
      };

      emitGatewayLog("gateway_shutdown_start", correlation, {
        signal,
        outcome: "started",
        timeout_ms: timeoutMs,
      });
      timeout = setTimeout(() => {
        runtimeProcess.exitCode = 1;
        emitGatewayLog("gateway_shutdown_timeout", correlation, {
          signal,
          outcome: "failed",
          timeout_ms: timeoutMs,
        });
        closeConnections(server);
        finish(new Error("gateway shutdown timed out"), true);
      }, timeoutMs);

      try {
        server.close((error?: Error) => {
          if (error && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
            finish(error);
            return;
          }
          finish();
        });
      } catch (error) {
        finish(error);
      }
    });

    return shutdownPromise;
  };
};

const installSignalHandlers = (
  runtimeProcess: GatewayProcess,
  stop: (signal: string) => Promise<void>,
): void => {
  const handleSignal = (signal: string): void => {
    void stop(signal).catch((error: unknown) => {
      runtimeProcess.exitCode = 1;
      // There should be no rejection from createGracefulShutdown, but retain a
      // final structured record if a custom shutdown implementation fails.
      emitGatewayLog("gateway_shutdown_failure", bootstrapCorrelation(), {
        signal,
        outcome: "failed",
        error_code: errorCode(error) ?? "shutdown_failed",
        error_name: errorName(error),
        error_message: errorMessage(error),
      });
    });
  };
  runtimeProcess.once("SIGINT", () => handleSignal("SIGINT"));
  runtimeProcess.once("SIGTERM", () => handleSignal("SIGTERM"));
};

export const runGateway = async (options: GatewayMainOptions = {}): Promise<Server | undefined> => {
  const runtimeProcess = options.process ?? process;
  const output = options.stderr ?? process.stderr;
  const correlation = bootstrapCorrelation();
  let configPath: string | undefined;
  let config: GatewayConfig | undefined;
  let server: Server | undefined;

  try {
    configPath = resolveConfigPath(options.argv, options.env, options.cwd);
    config = loadGatewayConfig(configPath);
    server = (options.createServer ?? createGatewayServer)(config);
    let listening = false;
    let stop: ((signal: string) => Promise<void>) | undefined;
    const onServerError = (error: Error): void => {
      if (!listening) {
        return;
      }
      runtimeProcess.exitCode = 1;
      emitGatewayLog("gateway_server_error", correlation, {
        outcome: "failed",
        error_code: errorCode(error) ?? "server_error",
        error_name: errorName(error),
        error_message: errorMessage(error),
        listen_host: config?.listen.host,
        listen_port: config?.listen.port,
      });
      if (stop) {
        void stop("server_error");
      }
    };

    server.on("error", onServerError);
    stop = createGracefulShutdown(server, {
      process: runtimeProcess,
      ...(options.shutdownTimeoutMs === undefined ? {} : { timeoutMs: options.shutdownTimeoutMs }),
      correlation,
    });
    await listenGateway(server, config);
    listening = true;
    emitGatewayLog("gateway_bootstrap_success", correlation, {
      outcome: "completed",
      listen_host: config.listen.host,
      listen_port: config.listen.port,
      config_path: configPath,
    });
    installSignalHandlers(runtimeProcess, stop);
    return server;
  } catch (error) {
    reportBootstrapFailure(correlation, server ? "listen" : "bootstrap", error, output, {
      config_path: configPath,
      ...(config
        ? {
            listen_host: config.listen.host,
            listen_port: config.listen.port,
          }
        : {}),
    });
    runtimeProcess.exitCode = 1;
    if (server?.listening) {
      try {
        server.close();
      } catch {
        // The bootstrap failure and non-zero exit code are already reported.
      }
    }
    return undefined;
  }
};

const isMainModule = (): boolean => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
};

if (isMainModule()) {
  void runGateway().catch((error: unknown) => {
    const correlation = bootstrapCorrelation();
    reportBootstrapFailure(correlation, "bootstrap", error, process.stderr);
    process.exitCode = 1;
  });
}
