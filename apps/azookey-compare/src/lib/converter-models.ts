/**
 * Converter models the comparison UI can ask the Worker to use.
 *
 * - `azookey-rust-wasm` — portable LOUDS dictionary (browser-complete or Cloudflare Worker)
 * - `zenz-v3.2-xsmall-gguf` / `zenz-v3.2-small-gguf` — Zenzai on inference
 *   Cloudflare Worker: LOUDS dictionary (system.azkdict.gz) when MODEL_ROUTES is
 *   empty; GGUF upstream when MODEL_ROUTES exposes the model id
 */

export const CONVERTER_MODELS = [
  "azookey-rust-wasm",
  "zenz-v3.2-xsmall-gguf",
  "zenz-v3.2-small-gguf",
] as const;

export type ConverterModel = (typeof CONVERTER_MODELS)[number];

export const DEFAULT_CONVERTER_MODEL: ConverterModel = "azookey-rust-wasm";

export interface ConverterModelOption {
  value: ConverterModel;
  label: string;
  description: string;
}

export const converterModelOptions: readonly ConverterModelOption[] = [
  {
    value: "azookey-rust-wasm",
    label: "AzooKey WASM",
    description:
      "公式 LOUDS 辞書の AzooKey Rust WASM。ブラウザ完結ではブラウザ内、Cloudflare Worker 依存では推論 Cloudflare Worker で変換します。追加のモデルサーバーは不要です。",
  },
  {
    value: "zenz-v3.2-xsmall-gguf",
    label: "AzooKey Zenzai v3.2 xsmall",
    description:
      "低レイテンシー向け Zenzai。ブラウザ完結では LOUDS 辞書（system.azkdict.gz）のみ。Cloudflare Worker 依存でも同じ辞書で変換し、MODEL_ROUTES に zenz-v3.2-xsmall-gguf を設定したときだけ GGUF 推論を試します。",
  },
  {
    value: "zenz-v3.2-small-gguf",
    label: "AzooKey Zenzai v3.2 small",
    description:
      "精度寄り Zenzai。ブラウザ完結では LOUDS 辞書のみ。Cloudflare Worker 依存でも同じ辞書で変換し、MODEL_ROUTES に zenz-v3.2-small-gguf を設定したときだけ GGUF 推論を試します。",
  },
] as const;

export const isConverterModel = (value: unknown): value is ConverterModel =>
  typeof value === "string" && (CONVERTER_MODELS as readonly string[]).includes(value);

export const isZenzConverterModel = (model: ConverterModel): boolean =>
  model === "zenz-v3.2-xsmall-gguf" || model === "zenz-v3.2-small-gguf";
