# Kotoba Beacon: 作業引き継ぎ

最終更新: 2026-07-29。作業ブランチは `agent/kotoba-beacon`、下書きPRは
[#1](https://github.com/kkkaoru/transcription-and-translation-app/pull/1) です。

## 次の環境で始める手順

```bash
git clone ssh://git@github.com/kkkaoru/transcription-and-translation-app.git
cd transcription-and-translation-app
git switch --track origin/agent/kotoba-beacon
bun install --frozen-lockfile
```

通常の TypeScript / Worker / ゲートウェイ検証は以下です。

```bash
bun run lint
bun run format:check
bun run gateway:build
bun run gateway:test:coverage
bun run worker:typecheck
bun run worker:test
```

ダウンロード済みの GGUF / ONNX / BIN モデル、`gateway.config.json`、APIキー、
`node_modules`、`.tools`、`target` は Git 管理しません。必要なモデルは安全な方法で
別途コピーするか、対象環境で再ダウンロードしてください。

## 現在の構成

- `apps/desktop` — Kotoba Beacon の Tauri デスクトップアプリ。起動時に Bun で
  コンパイルした `kotoba-inference-gateway` sidecar を起動します。
- `apps/inference-gateway` — ローカル OpenAI 互換 HTTP ゲートウェイ。
- `apps/cloudflare-worker-server` — Cloudflare Workers 上の同じ HTTP 契約のアダプタ。
- `packages/inference-server-core` — Gateway / Worker で共有するルーティング、HTTP、
  音声変換処理。
- `packages/azookey-rust` — 内蔵の AzooKey Viterbi 変換処理。
- `packages/parapper-asr` — Parakeet-Inc/Parapper-ASR の管理対象フォーク。上流 commit、
  MIT ライセンス、帰属、および Caption Bridge 固有の差分は
  [`CAPTION_BRIDGE_FORK.md`](../packages/parapper-asr/CAPTION_BRIDGE_FORK.md) を参照。

詳細は [architecture.md](architecture.md)、[inference-gateway.md](inference-gateway.md)、
[native-development.md](native-development.md) を参照してください。

## この時点で完了・確認済みのこと

- Bun workspace と `bun.lock` を使用している。root および Parapper の起動コマンドは
  Bun に統一済み。
- Tauri が Gateway sidecar を起動し、ローカル health check を確認済み。
- Zenzai 系は `zenz-v3.2-xsmall-gguf`、`zenz-v3.2-small-gguf`、
  `zenz-v2-q5-k-m-gguf` を選択できる。
- AzooKey と Zenzai のリクエスト経路を実機の llama.cpp server で確認済み。
- macOS Syphon framework をバンドルし、Windows は Spout2 依存を target-specific に
  している。macOS の Tauri bundle build は成功済み。
- Tauri ログは 10 MiB/ファイル、7ファイル保持で設定済み。
- `bun run lint`、`bun run format:check` は成功。
- `bun run gateway:build`、`bun run gateway:test:coverage` は成功（20 tests）。
- `bun run worker:typecheck`、`bun run worker:test` は成功（3 tests）。

## 今回コミットする途中作業

1. root Biome から `packages/parapper-asr` を除外する。フォークは upstream の
   ESLint / Prettier / Rust 設定を維持するため、root formatter で書き換えない。
2. Gateway / Worker の既存の Biome 指摘を修正する。
3. `parapper:*` の `bun --cwd=…` 指定を修正し、Bun 1.3 で実行可能にする。
4. `array-includes@3.1.9` が存在しない `es-abstract/2025/*` を要求する upstream
   不整合を回避するため、root `package.json` の `overrides` で `3.1.8` を固定する。
5. Parapper の import 漏れと小さな Clippy 指摘を修正する。

## 未解決事項（次の担当者が優先して確認すること）

### 単体アプリ配布の完全性

Kotoba Beacon は Gateway sidecar 自体は起動しますが、デフォルト Gateway 設定は
Parapper WebSocket (`127.0.0.1:18082`) と llama.cpp の各モデル server
(`127.0.0.1:8081` など) を参照します。これらは現時点で app bundle から自動起動
されません。従って、非エンジニア向けの「アプリ単体で全機能」要件は**未完了**です。

次の実装候補は、Parapper の headless recognition server と llama.cpp runner を
target ごとの sidecar としてバンドルし、Tauri からライフサイクル管理することです。
モデル本体はサイズのため初回ダウンロードまたは任意のモデル保存先選択にする必要が
あります。実装前に macOS / Windows のコード署名、モデルの再配布条件、GPU/CPU の
target ごとの挙動を確認してください。

### Parapper フォークの検証

Parapper は Rust 1.90.0 を要求します。現在のシェルが `RUSTUP_TOOLCHAIN=1.70.0` を
設定している場合は、次を使ってください。

```bash
rustup component add --toolchain 1.90.0-aarch64-apple-darwin rustfmt clippy
env -u RUSTUP_TOOLCHAIN bun --cwd=packages/parapper-asr run test
```

この Mac での結果は **403 passed / 5 failed / 12 ignored** でした。

- 4件は macOS 上で Tauri/tao の `EventLoop` を main thread 以外で作ったテストが
  panic する問題。テスト fixture を main-thread 対応にするか、macOS 固有のテスト
  実行方法を用意してください。
- 1件は `unsupported_neo_http_platform_disables_text_input_translation_and_vrc_flags` の
  期待値と `normalized_for_platform` の実装が不一致です。macOS で translation を無効化
  すべきかを仕様として確定し、テストと実装を揃えてください。
- `cargo clippy --all-targets --all-features -D warnings` は Rust 1.90 の新規・厳格な
  指摘が上流コードに75件あり失敗します。大量の上流形式変更を避けるため未解決のまま
  です。root CI はこのフォークを root Biome 対象にはしていません。

### CI と PR

PR #1 の旧 head では root Biome がフォークを整形対象にして `quality` が失敗しました。
その後の `e299808` では `packages/inference-server-core/src/index.ts` の export 順序で
失敗しましたが、原因は OS 差ではありません。作業 Mac の `.git/info/exclude` にある
`packages/` を Biome が読んで、ローカルだけ packages 全体を検査から外していました。

この状態を解消するため、`biome.json` は Git のローカル ignore ファイルを読まず、
`node_modules`、ビルド生成物、Tauri の `src-tauri/gen`、ローカルの `.tools` / `models`、
および独立管理の Parapper fork だけを明示的に除外します。`inference-server-core` は
root Biome で再整形済みです。次の環境では fresh clone 後に下記を実行し、PR の新しい
`quality` 実行も確認してください。

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
```

```bash
gh pr checks 1 --repo kkkaoru/transcription-and-translation-app --watch
```

macOS / Windows bundle job が失敗した場合は、各 job のログを保存し、OS 固有の
sidecar名、Syphon framework、Spout2 / MSVC を分けて調査してください。

### Cloudflare Worker

Worker のローカル typecheck/test は通っていますが、production deploy は未実施です。
対象 Cloudflare account にログインした上で、secret と `MODEL_ROUTES` を設定してから
`bun run worker:deploy` を実行してください。Cloudflare agent setup は
`https://developers.cloudflare.com/agent-setup/prompt.md` を基準にしています。

## push 前の最終確認

```bash
git status -sb
git log --oneline origin/main..HEAD
git diff --check
```

この文書は「完全動作を主張するもの」ではなく、途中状態と既知の制約を失わず次の
環境へ渡すための記録です。
