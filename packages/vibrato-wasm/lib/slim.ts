import { initSync, VibratoTokenizer } from "../pkg-web/vibrato_wasm.js";
import type { VibratoToken, VibratoTokenizerLike } from "./types.ts";

/**
 * Initialize from a caller-provided WebAssembly.Module. This is the entry
 * point for Workers and bundlers that import the `.wasm` asset themselves.
 */
export function initTokenizerFromModule(
  wasmModule: WebAssembly.Module,
  dictZstd: Uint8Array,
): VibratoTokenizerLike {
  initSync(wasmModule);

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
