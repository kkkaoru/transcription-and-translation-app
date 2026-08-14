import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  createOwner,
  isCurrentOwner,
  lockPathForCommonDirectory,
  main,
  processGroupIsRunning,
  releaseLock,
  runUnlockedGate,
} from "./run-quality-gate-locked.mjs";

const temporaryRoots = [];
const testProcessGroups = [];

const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "caption-bridge-quality-gate-test-"));
  temporaryRoots.push(root);
  return root;
};

const fakeOwner = (overrides = {}) => ({
  pid: 99_999_999,
  processStartedAt: "Mon Jan  1 00:00:00 2001",
  startedAt: "2026-08-14T00:00:00.000Z",
  cwd: "/repo",
  command: "bun run check:all:unlocked",
  token: "fixture-token",
  ...overrides,
});

const waitUntil = async (condition, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await delay(10);
  }
};

const pidIsRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

afterEach(async () => {
  while (testProcessGroups.length > 0) {
    const processGroupId = testProcessGroups.pop();
    if (!processGroupId || !processGroupIsRunning(processGroupId)) continue;
    process.kill(-processGroupId, "SIGKILL");
  }
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("quality gate lock", () => {
  it("uses one stable lock for a Git common directory", async () => {
    const root = await temporaryRoot();
    assert.equal(lockPathForCommonDirectory(root), lockPathForCommonDirectory(root));
    assert.notEqual(lockPathForCommonDirectory(root), lockPathForCommonDirectory(`${root}-other`));
  });

  it("requires both PID and process start time to recognize a live owner", () => {
    const owner = createOwner();
    assert.equal(isCurrentOwner(owner), true);
    assert.equal(isCurrentOwner({ ...owner, processStartedAt: "a reused PID" }), false);
  });

  it("refuses a concurrent owner and clearly reports that checks did not run", async () => {
    const commonDirectory = await temporaryRoot();
    const lockPath = lockPathForCommonDirectory(commonDirectory);
    const existing = acquireLock({ lockPath, owner: createOwner() });
    assert.equal(existing.acquired, true);

    const errors = [];
    let executed = false;
    const exitCode = await main({
      commonDirectory,
      execute: () => {
        executed = true;
        return 0;
      },
      stderr: (line) => errors.push(line),
    });

    assert.equal(exitCode, 75);
    assert.equal(executed, false);
    assert.match(errors.join("\n"), /検査は実行されていません/u);
    assert.match(errors.join("\n"), new RegExp(`PID ${process.pid}`));
    assert.equal(releaseLock(existing), true);
  });

  it("reclaims a dead owner and never releases another owner's snapshot", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "gate.lock");
    const stale = acquireLock({ lockPath, owner: fakeOwner() });
    assert.equal(stale.acquired, true);

    const current = acquireLock({
      lockPath,
      owner: fakeOwner({ token: "new-owner" }),
      ownerIsCurrent: () => false,
    });
    assert.equal(current.acquired, true);
    assert.equal(releaseLock(stale), false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(releaseLock(current), true);
  });

  it("does not reclaim a newly-created lock with incomplete metadata", async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "gate.lock");
    writeFileSync(lockPath, "incomplete metadata");

    const result = acquireLock({
      lockPath,
      owner: fakeOwner({ token: "waiting-owner" }),
      now: () => Date.now(),
    });

    assert.equal(result.acquired, false);
    assert.equal(result.owner, null);
  });

  it("retains a dead owner's lock while its recorded process group survives", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await temporaryRoot();
    const lockPath = join(root, "gate.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      detached: true,
      stdio: "ignore",
    });
    assert.ok(child.pid);
    testProcessGroups.push(child.pid);
    await waitUntil(() => processGroupIsRunning(child.pid));
    const stale = acquireLock({
      lockPath,
      owner: fakeOwner({
        childProcessGroupId: child.pid,
        childPlatform: process.platform,
      }),
    });
    assert.equal(stale.acquired, true);

    const blocked = acquireLock({
      lockPath,
      owner: fakeOwner({ token: "waiting-owner" }),
      ownerIsCurrent: () => false,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.owner.childProcessGroupId, child.pid);

    process.kill(-child.pid, "SIGKILL");
    await waitUntil(() => !processGroupIsRunning(child.pid));
    testProcessGroups.pop();
    const reclaimed = acquireLock({
      lockPath,
      owner: fakeOwner({ token: "replacement-owner" }),
      ownerIsCurrent: () => false,
    });
    assert.equal(reclaimed.acquired, true);
    assert.equal(releaseLock(reclaimed), true);
  });

  it("supports the emergency bypass and preserves the child exit code", async () => {
    const commonDirectory = await temporaryRoot();
    const exitCode = await main({
      env: { QUALITY_GATE_NO_LOCK: "1" },
      commonDirectory,
      execute: () => 137,
    });

    assert.equal(exitCode, 137);
    assert.equal(existsSync(lockPathForCommonDirectory(commonDirectory)), false);
  });

  it("forwards termination to the parent, child, and grandchild before returning", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await temporaryRoot();
    const parentPidPath = join(root, "parent.pid");
    const grandchildPidPath = join(root, "grandchild.pid");
    const grandchildScript = [
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "writeFileSync(process.argv[1], String(process.pid));",
      `spawn(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(
        grandchildScript,
      )}, process.argv[2]], { stdio: "ignore" });`,
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const signalSource = new EventEmitter();
    const lockPath = lockPathForCommonDirectory(root);
    const run = main({
      commonDirectory: root,
      execute: ({ registerProcessTree }) =>
        runUnlockedGate({
          command: process.execPath,
          args: ["--input-type=commonjs", "-e", parentScript, parentPidPath, grandchildPidPath],
          cwd: root,
          signalSource,
          registerProcessTree,
          descendantGraceMs: 50,
          forceKillAfterMs: 1_000,
        }),
    });

    await waitUntil(() => existsSync(parentPidPath) && existsSync(grandchildPidPath));
    const parentPid = Number(readFileSync(parentPidPath, "utf8"));
    const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
    testProcessGroups.push(parentPid);
    assert.equal(pidIsRunning(parentPid), true);
    assert.equal(pidIsRunning(grandchildPid), true);
    assert.equal(existsSync(lockPath), true);

    signalSource.emit("SIGTERM");

    assert.equal(await run, 143);
    assert.equal(processGroupIsRunning(parentPid), false);
    assert.equal(pidIsRunning(parentPid), false);
    assert.equal(pidIsRunning(grandchildPid), false);
    assert.equal(existsSync(lockPath), false);
    testProcessGroups.pop();
  });
});
