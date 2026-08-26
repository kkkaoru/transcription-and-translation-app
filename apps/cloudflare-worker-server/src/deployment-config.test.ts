// This file runs with bun.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const devJsonc = readFileSync(new URL("../wrangler.dev.jsonc", import.meta.url), "utf8");
const withoutLineComments = jsonc.replace(/^\s*\/\/.*$/gm, "");
const deploymentRunbook = readFileSync(
  new URL("../../../docs/cloudflare-worker-deployment.md", import.meta.url),
  "utf8",
);
const config = JSON.parse(withoutLineComments) as {
  vars?: Record<string, unknown>;
  secrets?: { required?: unknown };
  assets?: { directory?: string; binding?: string; run_worker_first?: boolean };
  ai?: { binding?: string };
  workers_dev?: boolean;
};

describe("Cloudflare deployment configuration", () => {
  it("keeps account selection in CLOUDFLARE_ACCOUNT_ID instead of public config", () => {
    expect(jsonc).not.toMatch(/^\s*"account_id"\s*:/m);
    expect(deploymentRunbook).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(deploymentRunbook).toContain(
      "wrangler deploy --config apps/cloudflare-worker-server/wrangler.jsonc",
    );
  });

  it("pins CORS to an explicit HTTPS origin and never stores API secrets", () => {
    const origin = config.vars?.["CORS_ORIGIN"];
    expect(origin).toBe("https://azookey-compare.kaoru.workers.dev");
    const dictionaryUrl = config.vars?.["AZOOKEY_DICTIONARY_URL"];
    expect(dictionaryUrl).toBe("/azookey/system.azkdict.gz");
    expect(config.assets).toMatchObject({
      directory: "./public",
      binding: "ASSETS",
      run_worker_first: true,
    });
    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.workers_dev).toBe(false);
    const devConfig = JSON.parse(devJsonc.replace(/^\s*\/\/.*$/gm, "")) as {
      ai?: { binding?: string; remote?: boolean };
      vars?: Record<string, unknown>;
    };
    expect(devConfig.ai).toEqual({ binding: "AI", remote: true });
    expect(devConfig.vars?.["AZOOKEY_DICTIONARY_URL"]).toBe("/azookey/system.azkdict.gz");
    expect(config.vars?.["VIBRATO_DICTIONARY_URL"]).toBe("/vibrato/system.dic.zst");
    expect(existsSync(new URL("../public/azookey/system.azkdict.gz", import.meta.url))).toBe(true);
    expect(
      createHash("sha256")
        .update(readFileSync(new URL("../public/vibrato/system.dic.zst", import.meta.url)))
        .digest("hex"),
    ).toBe("82a6da70bb4a17be70f20ff44f650f9ad1d2b0b4fcb2f39c17fc797f92d0ab75");
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/system.dic.zst", import.meta.url),
          ),
        )
        .digest("hex"),
    ).toBe("82a6da70bb4a17be70f20ff44f650f9ad1d2b0b4fcb2f39c17fc797f92d0ab75");
    expect(readFileSync(new URL("../public/vibrato/COPYING", import.meta.url))).toEqual(
      readFileSync(new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/COPYING", import.meta.url)),
    );
    expect(readFileSync(new URL("../public/vibrato/NOTICE", import.meta.url))).toEqual(
      readFileSync(new URL("../../../assets/vibrato/ipadic-mecab-2_7_0/NOTICE", import.meta.url)),
    );
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
