# Kotoba Beacon: 作業引き継ぎ

最終更新: 2026-07-29。作業は `main` に線形で統合します。以前の
`agent/kotoba-beacon` ブランチと下書き PR は削除済みです。次の環境では、まず
`git status -sb` と `git log --oneline origin/main..HEAD` で push 状態を確認してください。

## 次の環境で始める手順

```bash
git clone ssh://git@github.com/kkkaoru/transcription-and-translation-app.git
cd transcription-and-translation-app
git switch main
git pull --ff-only origin main
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
  コンパイルした `kotoba-parapper` と `kotoba-inference-gateway`、選択済みの
  `kotoba-zenz-server` / `kotoba-llama-server` sidecar を loopback で起動し、
  終了時にはすべてを停止します。
- `apps/inference-gateway` — ローカル OpenAI 互換 HTTP ゲートウェイ。
- `apps/cloudflare-worker-server` — Cloudflare Workers 上の同じ HTTP 契約のアダプタ。
- `packages/inference-server-core` — Gateway / Worker で共有するルーティング、HTTP、
  音声変換処理。
- `packages/azookey-rust` — 内蔵の AzooKey Viterbi 変換処理。
- `packages/parapper-asr` — Parakeet-Inc/Parapper-ASR の管理対象フォーク。上流 commit、
  MIT ライセンス、帰属、および Caption Bridge 固有の差分は
  [`CAPTION_BRIDGE_FORK.md`](../packages/parapper-asr/CAPTION_BRIDGE_FORK.md) を参照。

詳細は [architecture.md](architecture.md)、[inference-gateway.md](inference-gateway.md)、
[native-development.md](native-development.md)、[llama-runtime.md](llama-runtime.md) を参照してください。

## この時点で完了・確認済みのこと

- Bun workspace と `bun.lock` を使用している。root および Parapper の起動コマンドは
  Bun に統一済み。
- Tauri が Parapper と Gateway の sidecar を順に起動し、ローカル health check と
  `127.0.0.1:18082` の Parapper listener を確認済み。アプリ終了後に両 listener が
  残らないことも確認済み。
- Parapper headless は Kotoba Beacon の app-data 下の専用領域を使用する。初回に VAD、
  UniDic、日本語 ASR モデルを取得し、実際に WebSocket listener が起動することを確認済み。
- `scripts/build-sidecar.ts` は Gateway と Parapper release binary をビルドし、macOS の
  Sherpa-ONNX dylib / Windows の DLL、Parapper のライセンス JSON を Tauri resource として
  配置する。また、固定 commit の upstream llama.cpp と AzooKey fork から zenz / Hy-MT2
  用の `llama-server` をビルドし、各 runtime library を Tauri resource として配置する。
- ローカル GGUF は固定 Hugging Face revision から `<app-data>/models/<model-id>/` に
  ダウンロードする。終端の byte size を確認し、完了前ファイルを次回起動時に破棄する。
  `gateway.config.json` は内部生成物で、アプリ起動ごとに固定の全7 route で更新する。
- macOS arm64 で配布予定の `kotoba-zenz-server` を実際の zenz v3.2 small GGUF と起動し、
  `/health`、`/v1/models`、`/v1/chat/completions` が応答することを確認済み。
- 2026-07-29 に `bun --filter=@caption-bridge/desktop run tauri:build` を macOS arm64 で
  完走し、`Kotoba Beacon.app` と `Kotoba Beacon_0.1.0_aarch64.dmg` の生成を確認した。
  これらと sidecar binary、dylib、`target/`、`.tools/` は再生成可能なGit管理外の出力であり、
  リポジトリにも引き継ぎ対象にも含めない。
- Zenzai 系は `zenz-v3.2-xsmall-gguf`、`zenz-v3.2-small-gguf`、
  `zenz-v2-q5-k-m-gguf` を選択できる。
- AzooKey と Zenzai のリクエスト経路を実機の llama.cpp server で確認済み。
- macOS Syphon framework をバンドルし、Windows は Spout2 依存を target-specific に
  している。macOS の Tauri bundle build は成功済み。
- Tauri ログは 10 MiB/ファイル、7ファイル保持で設定済み。
- `bun run lint`、`bun run format:check` は成功。
- `bun run gateway:build`、`bun run gateway:test:coverage` は成功（20 tests）。
- `bun run worker:typecheck`、`bun run worker:test` は成功（3 tests）。

## `main` に含まれる途中作業

1. root Biome から `packages/parapper-asr` を除外する。フォークは upstream の
   ESLint / Prettier / Rust 設定を維持するため、root formatter で書き換えない。
2. Gateway / Worker の既存の Biome 指摘を修正する。
3. `parapper:*` の `bun --cwd=…` 指定を修正し、Bun 1.3 で実行可能にする。
4. `array-includes@3.1.9` が存在しない `es-abstract/2025/*` を要求する upstream
   不整合を回避するため、root `package.json` の `overrides` で `3.1.8` を固定する。
5. Parapper の import 漏れと小さな Clippy 指摘を修正する。
6. Parapper に `--headless [--port PORT]` の起動経路を追加する。このモードは
   `PARAPPER_RUNTIME_DIR` が必須で、Kotoba Beacon 専用の設定・モデル領域を使う。
   必要な VAD / 日本語辞書 / ASR モデルを既存の Parapper ダウンローダーで準備してから
   loopback WebSocket listener を開始する。
7. Tauri は上記 headless binary を Gateway より先に起動する。macOS は両方の rpath
   （debug sidecar と app bundle resource）を、Windows は runtime DLL 用の `PATH` を使う。
8. Parapper の Vite typecheck で React 18 / 19 の型が混ざる Bun cache の問題を、fork 側の
   `tsconfig.app.json` に React 18 型の明示的な解決を加えて回避した。

## 未解決事項（次の担当者が優先して確認すること）

### 単体アプリ配布の完全性

GGUF server の sidecar 化と初回ダウンロードは実装済みですが、署名済み release bundle と
Windows runtime はまだ検証が必要です。次の担当者は下記を優先してください。

1. `bun run sidecar:build` は `cargo-about` を必要とします。`cargo-about 0.9` は CLI feature を
   明示する必要があるため、未導入環境では
   `cargo install cargo-about --locked --features cli` を先に実行してください。CI desktop job は
   同じ feature 指定に更新済みです。
2. macOS arm64 の非署名 build は上記のとおり成功済みです。コード署名後の最終 `.app` と
   Windows build では、Gateway、Parapper、zenz、Hy-MT2 の4 binary、各 dylib/DLL、
   `third-party/parapper-rust-licenses.json`、llama.cpp の MIT notice が最終 bundle にあることを
   確認してください。
3. クリーンな app-data で、xsmall zenz と標準 Hy-MT2 をそれぞれ選び、初回ダウンロード、
   `POST /v1/chat/completions`、アプリ終了時の sidecar 停止を確認してください。Hy-MT2標準は
   約1.13 GB必要です。ネットワークを使う個別確認には
   `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml downloads_the_pinned_xsmall_model_into_app_data_layout -- --ignored`
   を実行します（`rust-toolchain.toml` の 1.97.1 が使われます）。このテストは一時ディレクトリへ約21 MBを取得して削除するため、通常の CI では
   意図的に ignore されています。
4. Windows の llama.cpp build は MSVC と CPU fallback、DLL探索パスを検証してください。
   macOS arm64 は Metal を有効にします。モデル本体は installer には含めません。

### Parapper フォークの検証

Parapper は Rust 1.90.0 を要求します。現在のシェルが `RUSTUP_TOOLCHAIN=1.70.0` を
設定している場合は、次を使ってください。

```bash
rustup component add --toolchain 1.90.0-aarch64-apple-darwin rustfmt clippy
env -u RUSTUP_TOOLCHAIN cargo install cargo-about --locked --features cli
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

### CI

以前の CI では root Biome がフォークを整形対象にして `quality` が失敗しました。
その後 `packages/inference-server-core/src/index.ts` の export 順序でも失敗しましたが、
原因は OS 差ではありません。作業 Mac の `.git/info/exclude` にある
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

macOS / Windows bundle job が失敗した場合は、各 job のログを保存し、OS 固有の
sidecar名、Syphon framework、Spout2 / MSVC、今回追加した Parapper runtime を分けて
調査してください。

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
