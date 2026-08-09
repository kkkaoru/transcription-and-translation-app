import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildCursorMcpConfig,
  hasCloudflareCodeMode,
  parseDotEnv,
  resolveCloudflareApiToken,
  writeCursorMcpConfig,
} from "./setup-cursor-cloudflare-mcp.mjs";

const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("setup-cursor-cloudflare-mcp", () => {
  it("parses dotenv assignments without requiring quotes", () => {
    const parsed = parseDotEnv(
      ["# comment", "CLOUDFLARE_DEBUG_TOKEN=abc", 'R2_BUCKET="ignored"'].join("\n"),
    );
    assert.equal(parsed.CLOUDFLARE_DEBUG_TOKEN, "abc");
    assert.equal(parsed.R2_BUCKET, "ignored");
  });

  it("prefers CLOUDFLARE_API_TOKEN over the debug alias", () => {
    const resolved = resolveCloudflareApiToken({
      env: { CLOUDFLARE_API_TOKEN: "api-token", CLOUDFLARE_DEBUG_TOKEN: "debug-token" },
      envFileContents: "CLOUDFLARE_DEBUG_TOKEN=dotenv-token\n",
    });
    assert.deepEqual(resolved, { token: "api-token", source: "env:CLOUDFLARE_API_TOKEN" });
  });

  it("falls back to dotenv CLOUDFLARE_DEBUG_TOKEN", () => {
    const resolved = resolveCloudflareApiToken({
      env: {},
      envFileContents: 'CLOUDFLARE_DEBUG_TOKEN="dotenv-token"\n',
    });
    assert.deepEqual(resolved, { token: "dotenv-token", source: "dotenv:CLOUDFLARE_DEBUG_TOKEN" });
  });

  it("clears Code Mode instead of registering mcp.cloudflare.com", async () => {
    const home = await mkdtemp(join(tmpdir(), "cursor-mcp-home-"));
    temporaryRoots.push(home);
    const path = writeCursorMcpConfig({ home });
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(config, buildCursorMcpConfig());
    assert.equal(config.mcpServers.cloudflare, undefined);
    assert.equal(hasCloudflareCodeMode(config), false);
    assert.equal(
      hasCloudflareCodeMode({
        mcpServers: { cloudflare: { url: "https://mcp.cloudflare.com/mcp" } },
      }),
      true,
    );
  });
});
