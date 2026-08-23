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
  PRODUCT_NAME,
  RETIRED_APP_PATH,
  resolveNativeInstallApp,
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

  it("writes Native identity and permissions into Info.plist", () => {
    const plist = nativeInfoPlist();
    assert.match(plist, new RegExp(`<string>${BUNDLE_ID}</string>`, "u"));
    assert.match(plist, new RegExp(`<string>${PRODUCT_NAME}</string>`, "u"));
    assert.match(plist, /NSMicrophoneUsageDescription/u);
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
