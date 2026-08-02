import initWasm, { VibratoTokenizer } from "../pkg-web/vibrato_wasm.js";
import type { VibratoToken, VibratoTokenizerLike } from "./types.ts";

/**
 * Load the generated wasm-bindgen module and initialize it from a
 * zstd-compressed `system.dic` byte array.
 */
export async function initTokenizer(dictZstd: Uint8Array): Promise<VibratoTokenizerLike> {
  const wasmUrl = new URL("../pkg-web/vibrato_wasm_bg.wasm", import.meta.url);
  await initWasm(wasmUrl);

  const tokenizer = new VibratoTokenizer(dictZstd);
  return {
    tokenize(text: string): VibratoToken[] {
      return tokenizer.tokenize(text) as VibratoToken[];
    },
    toHiragana(text: string, featureIndex: number): string {
      return tokenizer.toHiragana(text, featureIndex);
    },
    free() {
      tokenizer.free();
    },
  };
}
