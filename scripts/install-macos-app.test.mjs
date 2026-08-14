import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_INSTALL_APP,
  resolveInstallApp,
  shouldInstallMacosApp,
  terminateJxaSource,
} from "./install-macos-app.mjs";

describe("macOS app install after Tauri build", () => {
  it("installs on local macOS builds", () => {
    assert.equal(shouldInstallMacosApp({ platform: "darwin", env: {} }), true);
  });

  it("skips CI and explicit opt-out", () => {
    assert.equal(shouldInstallMacosApp({ platform: "darwin", env: { CI: "true" } }), false);
    assert.equal(
      shouldInstallMacosApp({ platform: "darwin", env: { KOTOBA_BEACON_SKIP_INSTALL: "1" } }),
      false,
    );
  });

  it("never installs on non-macOS hosts", () => {
    assert.equal(shouldInstallMacosApp({ platform: "linux", env: {} }), false);
    assert.equal(shouldInstallMacosApp({ platform: "win32", env: {} }), false);
  });

  it("defaults to /Applications and honors KOTOBA_BEACON_INSTALL_APP", () => {
    assert.equal(resolveInstallApp({}), DEFAULT_INSTALL_APP);
    assert.equal(
      resolveInstallApp({ KOTOBA_BEACON_INSTALL_APP: "/tmp/Kotoba Beacon.app" }),
      "/tmp/Kotoba Beacon.app",
    );
  });

  it("terminates only known running PIDs without resolving or launching a bundle", () => {
    const source = terminateJxaSource([123, 456]);
    assert.match(source, /runningApplicationWithProcessIdentifier\(pid\)/u);
    assert.match(source, /\[123,456\]/u);
    assert.doesNotMatch(source, /tell application|bundleIdentifier|open/u);
  });
});
