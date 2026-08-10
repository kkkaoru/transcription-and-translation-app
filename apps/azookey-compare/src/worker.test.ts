import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");

describe("compare worker ASSETS cache headers", () => {
  it("proxies ASSETS through withCompareStaticAssetHeaders after fetch", () => {
    expect(source).toContain("const asset = await env.ASSETS.fetch(request);");
    expect(source).toContain("return withCompareStaticAssetHeaders(pathname, asset);");
  });
});
