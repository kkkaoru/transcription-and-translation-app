import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const withoutLineComments = jsonc.replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(withoutLineComments) as {
  vars?: Record<string, unknown>;
  secrets?: { required?: unknown };
  assets?: { directory?: string; binding?: string; run_worker_first?: boolean };
};

describe("Cloudflare deployment configuration", () => {
  it("pins CORS to an explicit HTTPS origin and never stores API secrets", () => {
    const origin = config.vars?.["CORS_ORIGIN"];
    expect(typeof origin).toBe("string");
    expect(origin).toMatch(/^https:\/\//);
    expect(origin).not.toBe("https://example.invalid");
    expect(origin).not.toBe("*");
    const dictionaryUrl = config.vars?.["VIBRATO_DICTIONARY_URL"];
    expect(dictionaryUrl).toBe("/vibrato/system.dic.zst");
    expect(config.assets).toMatchObject({
      directory: "./public",
      binding: "ASSETS",
      run_worker_first: true,
    });
    expect(existsSync(new URL("../public/vibrato/system.dic.zst", import.meta.url))).toBe(true);
    expect(config.vars).not.toHaveProperty("AZOOKEY_API_TOKEN");
    expect(config.vars).not.toHaveProperty("ASR_API_TOKEN");
    expect(config.secrets?.required).toEqual(["AZOOKEY_API_TOKEN"]);
  });

  it("keeps the checked-in local env template free of token assignments", () => {
    const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
    expect(example).toMatch(/^CORS_ORIGIN=http:\/\/127\.0\.0\.1:3000$/m);
    expect(example).not.toMatch(/^\s*(?:AZOOKEY_API_TOKEN|ASR_API_TOKEN)\s*=/m);
  });
});
