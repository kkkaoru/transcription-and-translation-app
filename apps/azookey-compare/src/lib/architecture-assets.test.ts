import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_ASSET_ROWS,
  ARCHITECTURE_DEPENDENCIES,
  architectureAssetText,
} from "./architecture-assets";
import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_ZENZAI,
} from "./architecture-diagram";

describe("architecture asset inventory", () => {
  it("lists IPADIC, AzooKey dict, and GGUF with load source and size", () => {
    const text = architectureAssetText();
    expect(ARCHITECTURE_ASSET_ROWS.map((row) => row.id)).toEqual(["ipadic", "azkdict", "gguf"]);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.ipadic.file);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.ipadic.browserUrl);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.ipadic.upstream);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.ipadic.fn);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.azookey.file);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.azookey.workerUrl);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.azookey.workerEnv);
    expect(text).toContain(ARCHITECTURE_DICTIONARIES.azookey.format);
    expect(text).toContain("Cloudflare Worker ASSETS");
    expect(text).toContain("connect / listen");
    expect(text).toContain("websocket-upgrade");
    expect(text).toContain(ARCHITECTURE_ZENZAI.file);
    expect(text).toContain(ARCHITECTURE_ZENZAI.loader);
    expect(text).toContain(`${ARCHITECTURE_ZENZAI.env}[model].baseUrl`);
    expect(text).toContain(ARCHITECTURE_ZENZAI.endpoint);
    expect(text).toContain(ARCHITECTURE_ZENZAI.xsmall.hf);
    expect(text).toContain(ARCHITECTURE_ZENZAI.small.hf);
    expect(text).toContain(ARCHITECTURE_ZENZAI.xsmall.local);
    expect(text).toContain(ARCHITECTURE_ZENZAI.small.local);
    expect(text).toContain("owned HTTPS");
    expect(text).toContain("timeout");
    expect(text).toContain(ARCHITECTURE_ASSET_SIZES.ipadicZst);
    expect(text).toContain(ARCHITECTURE_ASSET_SIZES.azkdictGz);
    expect(text).toContain(ARCHITECTURE_ZENZAI.xsmall.size);
    expect(text).toContain(ARCHITECTURE_ZENZAI.small.size);
    expect(text).toContain("Cloudflare Worker は GGUF を持たない");
    expect(text).not.toContain("Tauri");
    expect(text).not.toContain("capture-start");
  });

  it("keeps one-hop runtime dependencies scannable", () => {
    expect(ARCHITECTURE_DEPENDENCIES.find((row) => row.from === "Zenzai 変換")?.note).toContain(
      `${ARCHITECTURE_ZENZAI.env}[model].baseUrl`,
    );
    expect(ARCHITECTURE_DEPENDENCIES.map((row) => `${row.from}->${row.to}`)).toEqual([
      "Vibrato->IPADIC system.dic.zst",
      "AzooKey WASM->system.azkdict.gz",
      "Cloudflare Worker /ws/azookey->AzooKey WASM または Zenzai",
      "Zenzai 変換->llama-server sidecar",
      "llama-server->ggml-model-Q5_K_M.gguf",
    ]);
  });
});
