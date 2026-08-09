/** A token emitted by the Vibrato WASM tokenizer. */
export interface VibratoToken {
  /** Surface form. */
  surface: string;
  /** Comma-separated, dictionary-dependent feature string. */
  feature: string;
}

/** The object shape returned by the generated wasm-bindgen wrapper. */
export interface VibratoTokenizerLike {
  tokenize(text: string): VibratoToken[];
  /** Convert readings using the dictionary's feature index. */
  toHiragana?(text: string, featureIndex: number): string;
  free(): void;
}
