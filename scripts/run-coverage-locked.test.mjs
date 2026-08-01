import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  getPackageDir,
  isProcessAlive,
  lockPathForPackage,
  releaseLock,
} from "./run-coverage-locked.mjs";

const temporaryRoots = [];
const temporaryLockPaths = [];

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
  while (temporaryLockPaths.length > 0) {
    const lockFilePath = temporaryLockPaths.pop();
    if (lockFilePath) await rm(lockFilePath, { force: true });
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

  it("holds the lock until the interrupted child exits, then releases it", async () => {
    // The wrapper must not release on the signal itself: vitest keeps writing
    // coverage/.tmp until it actually exits, so an early release would let a
    // second run start against the same directory. The stub child below
    // mirrors that shutdown window by delaying its own exit after SIGTERM,
    // and publishes its PID so the lock-lifetime assertion is held against
    // the child's real lifetime rather than the wrapper's exit, which races
    // the release.
    const root = await mkdtemp(join(tmpdir(), "kotoba-coverage-lock-signal-"));
    temporaryRoots.push(root);
    const stubPidFile = join(root, "stub.pid");
    const scriptPath = fileURLToPath(new URL("./run-coverage-locked.mjs", import.meta.url));
    // A filter of its own keeps this test off every real package's lock and
    // coverage directory, so it stays hermetic even while a full gate runs.
    const packageFilter = `@caption-bridge/lock-signal-fixture-${process.pid}`;
    const lockFilePath = lockPathForPackage(packageFilter);
    temporaryLockPaths.push(lockFilePath);

    const wrapper = spawn(process.execPath, [scriptPath, packageFilter], {
      stdio: "ignore",
      env: {
        ...process.env,
        COVERAGE_LOCK_CHILD_COMMAND: [
          `require("node:fs").writeFileSync(${JSON.stringify(stubPidFile)}, String(process.pid));`,
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));",
          "setInterval(() => {}, 60_000);",
        ].join(" "),
      },
    });
    await once(wrapper, "spawn");

    // Give the wrapper time to acquire the lock and spawn its child, which
    // publishes its PID.
    const spawnDeadline = Date.now() + 5_000;
    while (!existsSync(lockFilePath) || !existsSync(stubPidFile)) {
      assert.ok(Date.now() < spawnDeadline, "wrapper never acquired the lock or spawned its child");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const childPid = Number.parseInt(await readFile(stubPidFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "stub child did not publish a PID");

    const exitPromise = once(wrapper, "exit");
    wrapper.kill("SIGTERM");

    // The wrapper forwards the signal to its child, which delays its own exit
    // to reproduce vitest's shutdown window. The lock must stay held for the
    // whole lifetime of that child. The release may legitimately land in the
    // instant the child dies, so a missing lock only fails this test when the
    // child is confirmed still alive.
    const childDeadline = Date.now() + 5_000;
    while (isProcessAlive(childPid)) {
      assert.ok(Date.now() < childDeadline, "stub child never exited after the signal");
      if (!existsSync(lockFilePath)) {
        assert.equal(
          isProcessAlive(childPid),
          false,
          "lock was released while the interrupted child was still running",
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }

    await exitPromise;
    assert.equal(existsSync(lockFilePath), false, "expected the lock to be released on exit");
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

  it("shares one lock across every spelling of a package filter", () => {
    assert.equal(
      lockPathForPackage("@caption-bridge/inference-server-core"),
      lockPathForPackage("packages/inference-server-core"),
    );
    assert.equal(lockPathForPackage("@caption-bridge/desktop"), lockPathForPackage("apps/desktop"));
  });
});
