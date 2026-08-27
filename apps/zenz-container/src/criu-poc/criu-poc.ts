// This file runs with bun.
import { Container } from "@cloudflare/containers";

interface Env {
  CRIU_CHECKPOINTS: R2Bucket;
  CRIU_DIAGNOSTIC: DurableObjectNamespace<CriuDiagnosticContainer>;
  CRIU_DIAGNOSTIC_TOKEN?: string;
}

interface DiagnosticCommand {
  name: string;
  argv: string[];
}

export interface DiagnosticCommandResult {
  name: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CriuDiagnosticReport {
  recordedAt: string;
  criuSupported: boolean;
  clone3SetTidSupported: boolean;
  r2CheckpointStaged: boolean;
  externalRestoreSucceeded: boolean;
  llamaRestoreSucceeded: boolean;
  sameInstanceRestoreSucceeded: boolean;
  elapsedMs: number;
  results: DiagnosticCommandResult[];
}

const CHECKPOINT_KEY = "checkpoints/llama-xsmall-amd64-criu-4.2.1.tar.gz";
const CHECKPOINT_SHA256 = "03b99a129b5e64ecf61b78c99bfab081092c120db411141ecdb7d797d9aa9537";
const DIAGNOSTIC_INSTANCE_ID = "criu-capability-probe-v1";
const RUN_PATH = "/run";
const LAST_REPORT_PATH = "/last";
const LAST_REPORT_STORAGE_KEY = "last-criu-diagnostic-report";
const MAX_OUTPUT_CHARACTERS = 32_768;
const DIAGNOSTIC_COMMANDS: readonly DiagnosticCommand[] = [
  { name: "criu-version", argv: ["criu", "--version"] },
  { name: "criu-sha256", argv: ["sha256sum", "/usr/local/sbin/criu"] },
  { name: "criu-check-all", argv: ["criu", "check", "--all"] },
  {
    name: "criu-check-clone3-set-tid",
    argv: ["criu", "check", "--feature", "clone3_set_tid"],
  },
  { name: "identity", argv: ["id"] },
  { name: "capabilities", argv: ["capsh", "--print"] },
  { name: "kernel", argv: ["uname", "-a"] },
  { name: "process-status", argv: ["cat", "/proc/self/status"] },
  { name: "process-tree", argv: ["ps", "-ef"] },
  { name: "cgroup", argv: ["cat", "/proc/self/cgroup"] },
  { name: "ptrace-scope", argv: ["cat", "/proc/sys/kernel/yama/ptrace_scope"] },
  { name: "pid-namespace", argv: ["readlink", "/proc/self/ns/pid"] },
  { name: "user-namespace", argv: ["readlink", "/proc/self/ns/user"] },
  { name: "mount-namespace", argv: ["readlink", "/proc/self/ns/mnt"] },
  { name: "network-namespace", argv: ["readlink", "/proc/self/ns/net"] },
];
const R2_RESTORE_TEST_COMMAND: DiagnosticCommand = {
  name: "r2-external-llama-restore",
  argv: [
    "/bin/sh",
    "-c",
    `set -eu
root=/tmp/criu-r2
archive=/tmp/criu-r2.tar.gz
image_dir=/tmp/criu-r2/criu-llama
work_dir=/tmp/criu-external-restore
rm -rf "$root" "$archive" "$work_dir"
mkdir -p "$root" "$work_dir"
restored_pid=
cleanup() {
  if [ -n "$restored_pid" ]; then kill "$restored_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
cat >"$archive"
echo '${CHECKPOINT_SHA256}  /tmp/criu-r2.tar.gz' | sha256sum -c -
tar -xzf "$archive" -C "$root"
rm "$archive"
if ! setarch x86_64 -R criu restore --images-dir "$image_dir" --work-dir "$work_dir" --shell-job --restore-detached --pidfile "$work_dir/restored.pid" --log-file restore.log --cpu-cap=none -v4; then
  cat "$work_dir/restore.log"
  exit 30
fi
restored_pid=$(cat "$work_dir/restored.pid")
kill -0 "$restored_pid"
restored_command=$(tr '\\000' ' ' <"/proc/$restored_pid/cmdline")
printf 'restored_pid=%s\\nrestored_command=%s\\n' "$restored_pid" "$restored_command"
python3 - <<'PY'
import json
import time
import urllib.request

for _ in range(40):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=2) as response:
            print("restored_health=", response.status, response.read().decode()[:120])
            break
    except Exception:
        time.sleep(0.25)
else:
    raise RuntimeError("restored llama-server did not become healthy")
body = json.dumps({"prompt": "test", "n_predict": 1, "temperature": 0}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8080/completion",
    data=body,
    headers={"content-type": "application/json", "connection": "close"},
)
with urllib.request.urlopen(request, timeout=30) as response:
    payload = json.load(response)
print("restored_completion_content=", repr(payload.get("content")))
PY
kill "$restored_pid"
restored_pid=
trap - EXIT
`,
  ],
};
const SMOKE_TEST_COMMAND: DiagnosticCommand = {
  name: "same-instance-sleep-dump-restore",
  argv: [
    "/bin/sh",
    "-c",
    `set -eu
image_dir=/tmp/criu-smoke
rm -rf "$image_dir"
mkdir -p "$image_dir"
target_pid=
restored_pid=
cleanup() {
  if [ -n "$target_pid" ]; then kill "$target_pid" 2>/dev/null || true; fi
  if [ -n "$restored_pid" ]; then kill "$restored_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
sleep 600 </dev/null >/dev/null 2>&1 &
target_pid=$!
printf 'target_pid=%s\\n' "$target_pid"
if ! criu dump --tree "$target_pid" --images-dir "$image_dir" --work-dir "$image_dir" --shell-job --log-file dump.log -v4; then
  cat "$image_dir/dump.log"
  exit 20
fi
wait "$target_pid" 2>/dev/null || true
target_pid=
if ! criu restore --images-dir "$image_dir" --work-dir "$image_dir" --shell-job --restore-detached --pidfile "$image_dir/restored.pid" --log-file restore.log -v4; then
  cat "$image_dir/restore.log"
  exit 21
fi
restored_pid=$(cat "$image_dir/restored.pid")
kill -0 "$restored_pid"
restored_command=$(tr '\\000' ' ' <"/proc/$restored_pid/cmdline")
printf 'restored_pid=%s\\nrestored_command=%s\\n' "$restored_pid" "$restored_command"
kill "$restored_pid"
restored_pid=
trap - EXIT
`,
  ],
};
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const commandSucceeded = (
  results: readonly DiagnosticCommandResult[],
  name: string,
): boolean => results.find((result) => result.name === name)?.exitCode === 0;

export const criuCheckSucceeded = (results: readonly DiagnosticCommandResult[]): boolean =>
  commandSucceeded(results, "criu-check-all");

const boundedText = (bytes: ArrayBuffer): string =>
  TEXT_DECODER.decode(bytes).slice(0, MAX_OUTPUT_CHARACTERS);

const digestsEqual = (actual: ArrayBuffer, expected: ArrayBuffer): boolean => {
  const expectedBytes = new Uint8Array(expected);
  return (
    new Uint8Array(actual).reduce(
      (difference, byte, index) => difference | (byte ^ expectedBytes[index]),
      0,
    ) === 0
  );
};

const authorized = async (request: Request, expectedToken: string): Promise<boolean> => {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(authorization.slice(prefix.length))),
    crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(expectedToken)),
  ]);
  return digestsEqual(actualDigest, expectedDigest);
};

export class CriuDiagnosticContainer extends Container<Env> {
  sleepAfter = "30s";
  enableInternet = false;
  entrypoint = ["/bin/sleep", "infinity"];

  async runChecks(): Promise<CriuDiagnosticReport> {
    const startedAt = performance.now();
    try {
      await this.start();
      const container = this.ctx.container;
      if (!container) throw new Error("Cloudflare Container runtime is unavailable");
      const runCommand = async (command: DiagnosticCommand): Promise<DiagnosticCommandResult> => {
        const process = await container.exec(command.argv, {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await process.output();
        return {
          name: command.name,
          argv: command.argv,
          exitCode: output.exitCode,
          stdout: boundedText(output.stdout),
          stderr: boundedText(output.stderr),
        };
      };
      const runR2Restore = async (): Promise<DiagnosticCommandResult> => {
        try {
          const checkpoint = await this.env.CRIU_CHECKPOINTS.get(CHECKPOINT_KEY);
          if (!checkpoint) throw new Error(`Missing R2 checkpoint: ${CHECKPOINT_KEY}`);
          const process = await container.exec(R2_RESTORE_TEST_COMMAND.argv, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          if (!process.stdin) throw new Error("Container stdin pipe is unavailable");
          await checkpoint.body.pipeTo(process.stdin);
          const output = await process.output();
          return {
            name: R2_RESTORE_TEST_COMMAND.name,
            argv: R2_RESTORE_TEST_COMMAND.argv,
            exitCode: output.exitCode,
            stdout: boundedText(output.stdout),
            stderr: boundedText(output.stderr),
          };
        } catch (error) {
          return {
            name: R2_RESTORE_TEST_COMMAND.name,
            argv: R2_RESTORE_TEST_COMMAND.argv,
            exitCode: 1,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      };
      const results = [await runR2Restore()];
      results.push(...(await Promise.all(DIAGNOSTIC_COMMANDS.map(runCommand))));
      results.push(await runCommand(SMOKE_TEST_COMMAND));
      const report = {
        recordedAt: new Date().toISOString(),
        criuSupported: criuCheckSucceeded(results),
        clone3SetTidSupported: commandSucceeded(results, "criu-check-clone3-set-tid"),
        r2CheckpointStaged:
          results
            .find((result) => result.name === "r2-external-llama-restore")
            ?.stdout.includes("/tmp/criu-r2.tar.gz: OK") ?? false,
        externalRestoreSucceeded: commandSucceeded(results, "r2-external-llama-restore"),
        llamaRestoreSucceeded: commandSucceeded(results, "r2-external-llama-restore"),
        sameInstanceRestoreSucceeded: commandSucceeded(results, "same-instance-sleep-dump-restore"),
        elapsedMs: Math.max(0, performance.now() - startedAt),
        results,
      };
      await this.ctx.storage.put(LAST_REPORT_STORAGE_KEY, report);
      return report;
    } finally {
      await this.destroy();
    }
  }

  async getLastReport(): Promise<CriuDiagnosticReport | null> {
    return (await this.ctx.storage.get<CriuDiagnosticReport>(LAST_REPORT_STORAGE_KEY)) ?? null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    const isRunRequest = url.pathname === RUN_PATH && request.method === "POST";
    const isLastReportRequest = url.pathname === LAST_REPORT_PATH && request.method === "GET";
    if (!isRunRequest && !isLastReportRequest) {
      return Response.json({ error: "POST /run or GET /last is required" }, { status: 404 });
    }
    const token = env.CRIU_DIAGNOSTIC_TOKEN;
    if (!token) {
      return Response.json({ error: "CRIU diagnostic token is not configured" }, { status: 503 });
    }
    if (!(await authorized(request, token))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const diagnostic = env.CRIU_DIAGNOSTIC.getByName(DIAGNOSTIC_INSTANCE_ID);
    return Response.json(
      isRunRequest ? await diagnostic.runChecks() : await diagnostic.getLastReport(),
    );
  },
} satisfies ExportedHandler<Env>;
