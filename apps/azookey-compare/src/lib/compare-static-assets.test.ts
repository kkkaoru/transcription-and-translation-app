import { describe, expect, it } from "vitest";
import {
  compareStaticAssetContentType,
  withCompareStaticAssetHeaders,
} from "./compare-static-assets";

describe("compare static asset MIME helpers", () => {
  it("maps wasm / onnx / mjs used by Silero ORT", () => {
    expect(compareStaticAssetContentType("/ort/ort-wasm-simd-threaded.wasm")).toBe(
      "application/wasm",
    );
    expect(compareStaticAssetContentType("/models/silero_vad_v6/silero_vad.onnx")).toBe(
      "application/octet-stream",
    );
    expect(compareStaticAssetContentType("/ort/ort-wasm-simd-threaded.mjs")).toBe(
      "text/javascript",
    );
    expect(compareStaticAssetContentType("/azookey/azookey.wasm")).toBe("application/wasm");
    expect(compareStaticAssetContentType("/index.html")).toBeUndefined();
    expect(compareStaticAssetContentType("/no-extension")).toBeUndefined();
  });

  it("sets Content-Type when the asset response omitted it", () => {
    const bare = new Response(new Uint8Array([0, 97, 115, 109]), { status: 200 });
    const typed = withCompareStaticAssetHeaders("/ort/ort-wasm-simd-threaded.wasm", bare);
    expect(typed.headers.get("content-type")).toBe("application/wasm");
    expect(typed).not.toBe(bare);
  });

  it("keeps an already-correct Content-Type", () => {
    const wasm = new Response(null, { headers: { "content-type": "application/wasm" } });
    expect(withCompareStaticAssetHeaders("/ort/model.wasm", wasm)).toBe(wasm);
  });

  it("leaves non-model HTML responses unchanged", () => {
    const html = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    expect(withCompareStaticAssetHeaders("/index.html", html)).toBe(html);
    expect(withCompareStaticAssetHeaders("/no-extension", html)).toBe(html);
  });
});
