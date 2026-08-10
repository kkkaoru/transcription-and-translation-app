import { describe, expect, it } from "vitest";
import {
  COMPARE_HASHED_STATIC_CACHE_CONTROL,
  COMPARE_HTML_CACHE_CONTROL,
  COMPARE_WORKER_MAX_ASSET_BYTES,
  compareAssetCacheControl,
  compareStaticAssetContentType,
  isCompareHtmlPath,
  isHashedNextStaticPath,
  isOversizedCompareOrtAsset,
  withCompareStaticAssetHeaders,
} from "./compare-static-assets";

describe("compare static asset MIME helpers", () => {
  it("flags jsep/jspi/asyncify and oversize wasm for Workers asset cap", () => {
    expect(isOversizedCompareOrtAsset("ort-wasm-simd-threaded.jsep.wasm", 1_024)).toBe(true);
    expect(isOversizedCompareOrtAsset("ort-wasm-simd-threaded.jspi.mjs", 1_024)).toBe(true);
    expect(isOversizedCompareOrtAsset("ort-wasm-simd-threaded.asyncify.wasm", 1_024)).toBe(true);
    expect(
      isOversizedCompareOrtAsset("ort-wasm-simd-threaded.wasm", COMPARE_WORKER_MAX_ASSET_BYTES),
    ).toBe(true);
    expect(isOversizedCompareOrtAsset("ort-wasm-simd-threaded.wasm", 13 * 1024 * 1024)).toBe(false);
    expect(isOversizedCompareOrtAsset("ort-wasm-simd-threaded.mjs", 24_000)).toBe(false);
  });

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
});

describe("compare ASSETS Cache-Control", () => {
  it("classifies HTML routes and hashed Next static paths", () => {
    expect(isCompareHtmlPath("/")).toBe(true);
    expect(isCompareHtmlPath("/index.html")).toBe(true);
    expect(isCompareHtmlPath("/overview")).toBe(true);
    expect(isCompareHtmlPath("/_next/static/chunks/app/page-abc.js")).toBe(false);
    expect(isHashedNextStaticPath("/_next/static/chunks/app/page-abc.js")).toBe(true);
    expect(isHashedNextStaticPath("/ort/ort-wasm-simd-threaded.wasm")).toBe(false);
  });

  it("chooses no-store for HTML and immutable for hashed chunks", () => {
    expect(compareAssetCacheControl("/", "text/html")).toBe(COMPARE_HTML_CACHE_CONTROL);
    expect(compareAssetCacheControl("/index.html", "text/html; charset=utf-8")).toBe(
      COMPARE_HTML_CACHE_CONTROL,
    );
    expect(
      compareAssetCacheControl("/_next/static/chunks/app/page-abc.js", "application/javascript"),
    ).toBe(COMPARE_HASHED_STATIC_CACHE_CONTROL);
    expect(compareAssetCacheControl("/ort/model.wasm", "application/wasm")).toBeUndefined();
  });

  it("sets no-store on HTML even when ASSETS returned a revalidate cache header", () => {
    const html = new Response("<!doctype html>", {
      headers: {
        "content-type": "text/html",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
    const next = withCompareStaticAssetHeaders("/", html);
    expect(next).not.toBe(html);
    expect(next.headers.get("cache-control")).toBe(COMPARE_HTML_CACHE_CONTROL);
    expect(next.headers.get("content-type")).toBe("text/html");
  });

  it("sets immutable cache on hashed Next static chunks", () => {
    const js = new Response("console.log(1)", {
      headers: {
        "content-type": "application/javascript",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
    const next = withCompareStaticAssetHeaders("/_next/static/chunks/app/page-abc.js", js);
    expect(next.headers.get("cache-control")).toBe(COMPARE_HASHED_STATIC_CACHE_CONTROL);
  });

  it("does not treat hashed Next HTML fallback as immutable", () => {
    const html = new Response("<!doctype html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const next = withCompareStaticAssetHeaders("/_next/static/chunks/missing.js", html);
    expect(next.headers.get("cache-control")).toBe(COMPARE_HTML_CACHE_CONTROL);
  });

  it("leaves already-correct HTML no-store responses unchanged", () => {
    const html = new Response("<!doctype html>", {
      headers: {
        "content-type": "text/html",
        "cache-control": COMPARE_HTML_CACHE_CONTROL,
      },
    });
    expect(withCompareStaticAssetHeaders("/index.html", html)).toBe(html);
  });
});
