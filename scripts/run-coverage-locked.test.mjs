import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireLock, getPackageDir, isProcessAlive, releaseLock } from "./run-coverage-locked.mjs";

const temporaryRoots = [];

const createLockPath = async () => {
  const root = await mkdtemp(join(tmpdir(), "kotoba-coverage-lock-"));
  temporaryRoots.push(root);
  return join(root, "coverage.lock");
};

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("coverage lock", () => {
  it("reclaims a lock whose owner PID is no longer alive", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const stalePid = child.pid;
    assert.ok(stalePid);
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(isProcessAlive(stalePid), false);

    const lockFilePath = await createLockPath();
    await writeFile(lockFilePath, `${stalePid}\nold-owner-token\n`);

    const lock = await acquireLock({
      lockFilePath,
      maxWaitMs: 100,
      retryDelayMs: 1,
    });

    assert.match(await readFile(lockFilePath, "utf8"), new RegExp(`^${process.pid}\\n`));
    assert.equal(releaseLock(lock), true);
  });

  it("does not release a lock owned by another PID", async () => {
    const lockFilePath = await createLockPath();
    const otherOwner = "987654\nother-owner-token\n";
    await writeFile(lockFilePath, otherOwner);

    assert.equal(
      releaseLock({
        lockFilePath,
        ownerContent: `${process.pid}\nthis-process-token\n`,
      }),
      false,
    );
    assert.equal(await readFile(lockFilePath, "utf8"), otherOwner);
  });

  it("fails instead of bypassing a live lock after the timeout", async () => {
    const lockFilePath = await createLockPath();
    await writeFile(lockFilePath, `${process.pid}\nlive-owner-token\n`);

    await assert.rejects(
      () =>
        acquireLock({
          lockFilePath,
          maxWaitMs: 0,
          retryDelayMs: 1,
        }),
      /Refusing to run without the lock/,
    );
    assert.equal(await readFile(lockFilePath, "utf8"), `${process.pid}\nlive-owner-token\n`);
  });
});

describe("coverage package resolution", () => {
  it("finds each coverage package under its real workspace root", () => {
    // A scoped name does not say which workspace root holds the package, so
    // every filter the coverage scripts actually pass must resolve to a real
    // directory. Guessing `apps/` sent inference-server-core to a path that
    // does not exist, silently skipping its pre-run coverage cleanup.
    for (const packageFilter of [
      "@caption-bridge/desktop",
      "@caption-bridge/inference-server-core",
      "@caption-bridge/inference-gateway",
      "@caption-bridge/azookey-compare",
      "@caption-bridge/cloudflare-worker-server",
    ]) {
      const packageDir = getPackageDir(packageFilter);
      assert.ok(packageDir, `${packageFilter} did not resolve`);
      assert.ok(existsSync(join(packageDir, "package.json")), `${packageDir} has no package.json`);
    }

    assert.equal(
      getPackageDir("@caption-bridge/inference-server-core"),
      getPackageDir("packages/inference-server-core"),
    );
  });

  it("returns null for an unknown package instead of a fabricated path", () => {
    assert.equal(getPackageDir("@caption-bridge/does-not-exist"), null);
  });
});
