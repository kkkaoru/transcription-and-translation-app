import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  desktopRustTestArgs,
  desktopRustTestEnv,
  TAURI_DESKTOP_TEST_CONFIG,
} from "./run-desktop-rust-test.mjs";

describe("desktop Rust test wrapper", () => {
  it("runs only the desktop library tests with the locked manifest", () => {
    assert.deepEqual(desktopRustTestArgs(), [
      "test",
      "--manifest-path",
      "apps/desktop/src-tauri/Cargo.toml",
      "--lib",
      "--locked",
    ]);
  });

  it("overrides bundled resources without discarding the caller environment", () => {
    const env = desktopRustTestEnv({
      PATH: "/test/bin",
      TAURI_CONFIG: '{"bundle":{"externalBin":["stale"]}}',
    });
    assert.equal(env.PATH, "/test/bin");
    assert.equal(env.TAURI_CONFIG, TAURI_DESKTOP_TEST_CONFIG);
    assert.deepEqual(JSON.parse(env.TAURI_CONFIG), {
      bundle: {
        externalBin: null,
        resources: null,
      },
    });
  });
});
