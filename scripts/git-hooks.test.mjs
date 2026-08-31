import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, it } from "node:test";

const hookPath = resolve(".githooks/pre-push");

describe("tracked Git hooks", () => {
  it("keeps the pre-push hook executable and wired to every 95 percent coverage gate", () => {
    const source = readFileSync(hookPath, "utf8");

    assert.equal(statSync(hookPath).mode & 0o111, 0o111);
    assert.match(source, /make rust-native-coverage/u);
    assert.match(source, /make rust-parapper-engine-coverage/u);
    assert.match(source, /bun run native:diagnostics:test:coverage/u);
    assert.match(source, /RUST_COVERAGE_BASE/u);
  });

  it("passes the pushed remote SHA to all coverage commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kotoba-pre-push-hook-"));
    const binaryDirectory = join(directory, "bin");
    const logPath = join(directory, "commands.log");
    await mkdir(binaryDirectory);
    const recorder = `#!/bin/sh\nprintf '%s|%s\\n' "$RUST_COVERAGE_BASE" "$*" >> "$HOOK_LOG"\n`;
    const makePath = join(binaryDirectory, "make");
    const bunPath = join(binaryDirectory, "bun");
    await writeFile(makePath, recorder, "utf8");
    await writeFile(bunPath, recorder, "utf8");
    await chmod(makePath, 0o755);
    await chmod(bunPath, 0o755);

    try {
      const remoteOid = "1234567890abcdef1234567890abcdef12345678";
      const result = spawnSync(hookPath, ["origin", "ssh://example.invalid/repository"], {
        cwd: resolve("."),
        env: {
          ...process.env,
          HOOK_LOG: logPath,
          PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
        },
        input: `refs/heads/main ${"a".repeat(40)} refs/heads/main ${remoteOid}\n`,
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
        `${remoteOid}|rust-native-coverage`,
        `${remoteOid}|rust-parapper-engine-coverage`,
        `${remoteOid}|run native:diagnostics:test:coverage`,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
