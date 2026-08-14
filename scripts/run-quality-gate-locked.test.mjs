import { strict as assert } from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  acquireLock,
  createOwner,
  isCurrentOwner,
  lockPathForCommonDirectory,
  main,
  releaseLock,
} from "./run-quality-gate-locked.mjs";

const temporaryRoots = [];

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

afterEach(async () => {
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
});
