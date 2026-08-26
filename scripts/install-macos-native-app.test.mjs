import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertNotRetiredDestination,
  BUNDLE_ID,
  DEFAULT_INSTALL_APP,
  installBuiltNativeApp,
  NATIVE_RUNTIME_LIBRARY_NAMES,
  nativeInfoPlist,
  ORT_DYNAMIC_LIBRARY_NAME,
  ORT_DYNAMIC_LIBRARY_TARGET,
  PRODUCT_NAME,
  RETIRED_APP_PATH,
  resolveNativeInstallApp,
  terminateRunningNativeApp,
} from "./install-macos-native-app.mjs";

describe("macOS Native app install", () => {
  it("defaults to the user Applications Native bundle", () => {
    assert.equal(DEFAULT_INSTALL_APP, join(homedir(), "Applications", "Kotoba Beacon Native.app"));
    assert.equal(resolveNativeInstallApp({}), DEFAULT_INSTALL_APP);
  });

  it("honors KOTOBA_BEACON_NATIVE_INSTALL_APP", () => {
    assert.equal(
      resolveNativeInstallApp({ KOTOBA_BEACON_NATIVE_INSTALL_APP: "/tmp/Native.app" }),
      "/tmp/Native.app",
    );
  });

  it("never overwrites the retired application path", () => {
    assert.equal(RETIRED_APP_PATH, "/Applications/Kotoba Beacon.app");
    assert.throws(
      () => assertNotRetiredDestination(RETIRED_APP_PATH),
      /refusing to overwrite the retired app/u,
    );
  });

  it("does not signal the Native app when it is not running", () => {
    const calls = [];
    const stopped = terminateRunningNativeApp("/tmp/Kotoba Beacon Native.app", {
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 1, stdout: "", stderr: "" };
      },
      wait: () => {},
    });

    assert.equal(stopped, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/usr/bin/pgrep");
  });

  it("terminates a running Native app before replacement", () => {
    const calls = [];
    let inspections = 0;
    const stopped = terminateRunningNativeApp("/tmp/Kotoba Beacon Native.app", {
      run: (command, args) => {
        calls.push([command, args]);
        if (command === "/usr/bin/pgrep") {
          inspections += 1;
          return inspections === 1
            ? { status: 0, stdout: "42\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      wait: () => {},
    });

    assert.equal(stopped, true);
    assert.deepEqual(calls[1].slice(0, 2), [
      "/usr/bin/pkill",
      [
        "-TERM",
        "-f",
        "^/tmp/Kotoba Beacon Native\\.app/Contents/MacOS/kotoba-beacon-native([[:space:]]|$)",
      ],
    ]);
  });

  it("writes Native identity and permissions into Info.plist", () => {
    const plist = nativeInfoPlist();
    assert.match(plist, new RegExp(`<string>${BUNDLE_ID}</string>`, "u"));
    assert.match(plist, new RegExp(`<string>${PRODUCT_NAME}</string>`, "u"));
    assert.match(plist, /NSMicrophoneUsageDescription/u);
    assert.match(plist, /<key>MallocLargeCache<\/key>\s*<string>0<\/string>/u);
  });

  it("packages only in-process recognition runtime libraries", () => {
    assert.deepEqual(NATIVE_RUNTIME_LIBRARY_NAMES, [
      "libsherpa-onnx-c-api.dylib",
      "libonnxruntime.1.24.4.dylib",
    ]);
    assert.equal(
      NATIVE_RUNTIME_LIBRARY_NAMES.some((name) => name.includes("parapper")),
      false,
    );
    assert.equal(ORT_DYNAMIC_LIBRARY_NAME, "libonnxruntime.dylib");
    assert.equal(
      ORT_DYNAMIC_LIBRARY_TARGET,
      join("..", "Frameworks", "libonnxruntime.1.24.4.dylib"),
    );
  });

  it("does not assemble a stale binary when release build fails", () => {
    let findCalled = false;
    let assembleCalled = false;
    assert.throws(
      () =>
        installBuiltNativeApp({
          installApp: "/tmp/Kotoba Beacon Native.app",
          build: () => {
            throw new Error("native GPUI build failed");
          },
          findBinary: () => {
            findCalled = true;
            return { binary: "/tmp/stale/kotoba-beacon-native", profile: "release" };
          },
          assemble: () => {
            assembleCalled = true;
            return {};
          },
        }),
      /native GPUI build failed/u,
    );
    assert.equal(findCalled, false);
    assert.equal(assembleCalled, false);
  });
});
