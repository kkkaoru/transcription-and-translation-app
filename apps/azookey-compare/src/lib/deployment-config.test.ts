import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPARE_WORKER_ORIGIN, COMPARE_WORKER_WEBSOCKET_URL } from "./inference-proxy";

const jsonc = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const withoutLineComments = jsonc.replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(withoutLineComments) as {
  name?: string;
  main?: string;
  account_id?: string;
  assets?: {
    directory?: string;
    binding?: string;
    run_worker_first?: boolean;
    not_found_handling?: string;
  };
  services?: { binding?: string; service?: string }[];
  vars?: Record<string, string>;
  secrets?: { required?: unknown };
};

describe("azookey-compare Worker deployment configuration", () => {
  it("keeps account selection out of public config and proxies inference in-process", () => {
    expect(jsonc).not.toMatch(/^\s*"account_id"\s*:/m);
    expect(config.name).toBe("azookey-compare");
    expect(config.main).toBe("src/worker.ts");
    expect(config.assets).toMatchObject({
      directory: "./out",
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    });
    expect(config.services).toEqual([{ binding: "INFERENCE", service: "kotoba-beacon-inference" }]);
    expect(config.vars).toBeUndefined();
    expect(config.vars ?? {}).not.toHaveProperty("AZOOKEY_API_TOKEN");
    expect(config.secrets?.required).toEqual(["AZOOKEY_API_TOKEN"]);
    expect(COMPARE_WORKER_ORIGIN).toBe("https://azookey-compare.kaoru.workers.dev");
    expect(COMPARE_WORKER_WEBSOCKET_URL).toContain("/ws/azookey");
  });
});
