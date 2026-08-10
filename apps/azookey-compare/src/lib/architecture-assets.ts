import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_ZENZAI,
} from "./architecture-diagram";

/** Bird's-eye inventory: what data exists, who reads it, from where. */
export const ARCHITECTURE_ASSET_ROWS = [
  {
    id: "ipadic",
    name: "IPADIC",
    file: ARCHITECTURE_DICTIONARIES.ipadic.file,
    size: ARCHITECTURE_ASSET_SIZES.ipadicZst,
    reader: "Vibrato",
    source: `${ARCHITECTURE_DICTIONARIES.ipadic.browserUrl}（${ARCHITECTURE_DICTIONARIES.ipadic.upstream}）`,
    when: "ブラウザ: connect / listen",
    uses: ARCHITECTURE_DICTIONARIES.ipadic.fn,
    depends: "なし（Worker 既定は未同梱。構成時は VIBRATO_DICTIONARY_URL / VIBRATO_UPSTREAM_URL）",
  },
  {
    id: "azkdict",
    name: "AzooKey 辞書",
    file: ARCHITECTURE_DICTIONARIES.azookey.file,
    size: ARCHITECTURE_ASSET_SIZES.azkdictGz,
    reader: "AzooKey WASM",
    source: `${ARCHITECTURE_DICTIONARIES.azookey.workerUrl}（${ARCHITECTURE_DICTIONARIES.azookey.workerEnv} → Worker ASSETS）`,
    when: "websocket-upgrade（初回 fetch、isolate 内再利用）",
    uses: `${ARCHITECTURE_DICTIONARIES.azookey.fn}（${ARCHITECTURE_DICTIONARIES.azookey.format}）`,
    depends: "Zenzai は使わない",
  },
  {
    id: "gguf",
    name: "Zenzai GGUF",
    file: ARCHITECTURE_ZENZAI.file,
    size: `${ARCHITECTURE_ZENZAI.xsmall.size} / ${ARCHITECTURE_ZENZAI.small.size}`,
    reader: `${ARCHITECTURE_ZENZAI.loader} sidecar`,
    source: `${ARCHITECTURE_ZENZAI.xsmall.hf} / ${ARCHITECTURE_ZENZAI.small.hf} → sidecar --model（dev ${ARCHITECTURE_ZENZAI.xsmall.local} / ${ARCHITECTURE_ZENZAI.small.local}、deploy は owned HTTPS）`,
    when: "llama-server 起動時にディスクから読む",
    uses: "かな漢字（任意）。Worker は GGUF を持たない",
    depends: `${ARCHITECTURE_ZENZAI.env}[model].baseUrl → POST ${ARCHITECTURE_ZENZAI.endpoint}（timeout は WASM に落とさない）`,
  },
] as const;

/** Runtime depends-on, one hop per row. */
export const ARCHITECTURE_DEPENDENCIES = [
  { from: "Vibrato", to: "IPADIC system.dic.zst", note: "漢字→ひらがな" },
  { from: "AzooKey WASM", to: "system.azkdict.gz", note: "かな漢字（既定）" },
  { from: "Worker /ws/azookey", to: "AzooKey WASM または Zenzai", note: "かな漢字の入口" },
  {
    from: "Zenzai 変換",
    to: "llama-server sidecar",
    note: `${ARCHITECTURE_ZENZAI.env}[model].baseUrl → POST ${ARCHITECTURE_ZENZAI.endpoint}`,
  },
  { from: "llama-server", to: "ggml-model-Q5_K_M.gguf", note: "起動時にディスクから読む" },
] as const;

export const architectureAssetText = (): string =>
  [
    ...ARCHITECTURE_ASSET_ROWS.flatMap((row) => [
      row.name,
      row.file,
      row.size,
      row.reader,
      row.source,
      row.when,
      row.uses,
      row.depends,
    ]),
    ...ARCHITECTURE_DEPENDENCIES.flatMap((row) => [row.from, row.to, row.note]),
  ].join("\n");
