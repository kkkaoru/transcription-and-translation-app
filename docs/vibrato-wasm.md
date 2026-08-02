# Vibrato WASM feasibility

## 結論

`vibrato-rkyv` 0.7.8 をそのまま `wasm32-unknown-unknown` にコンパイルする
ことはできない。最小 crate で `default-features = false` にしても、次の依存が
常に有効になる。

```text
vibrato-rkyv -> fs4 -> rustix -> errno
             -> memmap2 / dirs / tempfile / zstd
```

`cargo build --target wasm32-unknown-unknown --release` は `errno` の
`target OS is "unknown" or "none", so it's unsupported` で停止する。これは
WASI の有無ではなく、`vibrato-rkyv` の filesystem/mmap 前提と
`wasm32-unknown-unknown` の OS 未指定が衝突しているためである。`Dictionary::read`
は heap buffer を受け取れるが、crate 自体が `File`/`Mmap`/cache 用 API を無条件に
コンパイルするため、feature flag だけでは回避できない。`fs4` を no-op stub に
置き換える追加プローブでも、次に `zstd-sys` の C backend が
`wasm32-unknown-unknown` 用 clang target を要求して停止した。依存を一つ差し替える
だけの workaround は採用しない。

そこで [`packages/vibrato-wasm`](../packages/vibrato-wasm/) は、同じ Vibrato
tokenizer の wasm 対応版（`vibrato` 0.5.2）を使う。zstd 圧縮された
`system.dic` を `ruzstd` でメモリへ展開し、`vibrato::Dictionary::read` と
`Tokenizer` へ渡す。固定フレーズ表は使わず、任意の入力を形態素分割できる。

## 最小 API

生成された wasm-bindgen glue を介して、次の形で利用する。

```ts
const tokenizer = await initTokenizer(dictionaryZstdBytes);
const tokens = tokenizer.tokenize("東京都に住む");
// [{ surface: "東京都", feature: "..." }, ...]
const reading = tokenizer.toHiragana("東京都に住む", 20); // UniDic CWJ F[20]
tokenizer.free();
```

返す `feature` は辞書依存の CSV をそのまま保持する。UniDic CWJ の surface
reading は `feature` の F[20] (`kana`)、IPADIC は F[7] (`reading`) なので、
読みをひらがなへ変換する呼び出し側が辞書形式を設定して抽出する。これにより
「よくあるフレーズ」だけを列挙した固定辞書を wasm に埋め込まずに済む。

## UniDic サイズと現実性

Vibrato [v0.5.0 の配布物](https://github.com/daac-tools/vibrato/releases/tag/v0.5.0)
（GitHub Release）の公称値は次の通り。

| 辞書 | 圧縮 tar.xz | 展開後の `system.dic` | 評価 |
| --- | ---: | ---: | --- |
| `unidic-cwj-3_1_1` | 約 402 MB | 約 717 MB | Browser/Worker には非現実的 |
| `unidic-cwj-3_1_1+compact` | 約 23.5 MB | 約 252 MB | 起動時に 252 MB 超の Wasm heap が必要。デスクトップ限定なら検討可 |
| `unidic-cwj-3_1_1+compact-dual` | 約 69.6 MB | 約 300 MB | compact より大きく、同様に高メモリ |

ブラウザで `fetch` するのは圧縮バイト（compact なら 23.5 MB 級）で済むが、
tokenizer 初期化時には圧縮バッファと展開済み辞書を同時に保持する。したがって
compact 版でも概算 275 MB 以上を見積もり、低メモリ端末や Cloudflare Worker
のリクエストごとの初期化には採用しない。Worker ではモジュールと tokenizer
をグローバルに一度だけ初期化し、辞書は R2 等からキャッシュする設計が必要。

表のサイズは GitHub Release の外側の `tar.xz` 包装サイズである。API に渡すのは
その中の Vibrato `system.dic.zst`（または同じ内容を直接配信するオブジェクト）で、
`tar.xz` をそのまま `initTokenizer` に渡すことはできない。

実辞書スモークとして、同じ release の IPADIC `system.dic.zst` を一時展開して
wasm-bindgen 出力へ渡したところ、`東京都に住む` は `東京`/`都`/`に`/`住む` に
分割され、`toHiragana(text, 7)` は `とうきょうとにすむ` を返した。入力フレーズを
事前登録したデータは使っていない。

## 再現コマンド

```sh
# rkyv の直接 wasm ビルド（調査用最小 crate で失敗を確認）
# vibrato-rkyv = { version = "=0.7.8", default-features = false }
# のみを依存にした crate でも errno/fs4 の target OS エラーになる。

# 動作する heap-backed wrapper
cargo build --manifest-path packages/vibrato-wasm/Cargo.toml \
  --target wasm32-unknown-unknown --release
cargo test --manifest-path packages/vibrato-wasm/Cargo.toml

# raw module を packages/vibrato-wasm/pkg/ にコピー
node scripts/build-vibrato-wasm.mjs
```

`wasm-bindgen-cli` をインストールしている環境では、`node
scripts/build-vibrato-wasm.mjs --bindgen` で JavaScript glue も生成できる。
raw `.wasm` はビルド検証用であり、公開 `initTokenizer` API を使うには
生成された glue が必要である。
