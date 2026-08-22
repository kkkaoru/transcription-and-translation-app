# Kotoba Beacon

Kotoba Beaconは、配信向けの日本語ライブ文字起こし・英訳字幕アプリです。

## 実行形態

- **Nativeアプリ**: GPUI + Rustの単一プロセス。CPAL、Silero VAD、sherpa-onnx ASR、ローカル翻訳をスレッドとbounded channelで接続します。
- **ブラウザ版**: Web Audioで取得した音声をCloudflareの推論経路へ送り、字幕をブラウザで表示します。
- **Cloudflare Worker**: Workers AI ASRとAzooKey変換のHTTP・WebSocket契約を提供します。

旧Tauriアプリ、Tauri sidecar、アプリ内WebSocket IPCは使用しません。

## 構成

```text
apps/
  native/                    GPUI Nativeアプリ
  desktop/                   ReactブラウザUI
  cloudflare-worker-server/  Cloudflare Worker推論API
  azookey-compare/           Web Speech / Worker比較UI
  inference-gateway/         推論ゲートウェイ
crates/
  parapper-engine/           インプロセスVAD・ASR・ターン・翻訳
  caption-bridge-render/      共有RGBA字幕レンダラー
  caption-bridge-browser-source/
  caption-bridge-syphon/
packages/
  inference-server-core/     ローカル/Worker共通HTTP契約
  azookey-reading/
  sentence-boundary/
  azookey-rust/
  vibrato/
docs/
```

## 開発

必要なツール:

- Bun 1.3.14
- Rust 1.97.1
- `parapper-engine`の実モデル検証ではsherpa-onnx・ONNX Runtimeの共有ライブラリ

```bash
bun install --frozen-lockfile

# ブラウザUI
bun run dev
bun run typecheck
bun run lint
bun run test
bun run build

# Cloudflare Worker
bun run worker:dev
bun run worker:typecheck
bun run worker:test

# Native
bun run rust:native:build
node scripts/install-macos-native-app.mjs
```

## Native字幕経路

```text
Microphone
  → CPAL 16 kHz mono
  → Silero VAD
  → segmentation / turn detection
  → sherpa-onnx ASR
  → correction
  → local translation
  → GPUI / Browser Source / Syphon / Spout
```

Nativeアプリは子プロセスを必要としません。macOSのインストール先は既定で
`~/Applications/Kotoba Beacon Native.app`です。

OBS Browser Source:

- 横: `http://127.0.0.1:1521/`
- 縦: `http://127.0.0.1:1521/?layout=vertical`

localhostを受け付けない配信ソフトではCaption OutputのWindow Captureを使用してください。

## ブラウザ／Cloudflare

```bash
bun run worker:dev
bun run dev:web
```

Cloudflareへのデプロイ:

```bash
bun run worker:deploy
bun run azookey-compare:deploy
bun run access:setup
```

秘密情報はWrangler secretまたはCloudflare bindingで設定し、リポジトリや`.env`へコミットしません。

## 出力

- GPUI Caption Output
- OBS Browser Source
- macOS Syphon
- Windows Spout
- 通常のブラウザ字幕UI

NativeのRGBA出力は`caption-bridge-render`を共有します。ブラウザ出力は同じ保存済みフォント、色、背景、影、縁取り値をCSSへ変換します。

## ドキュメント

- [Native開発](docs/native-development.md)
- [アーキテクチャ](docs/architecture.md)
- [Cloudflare Workerデプロイ](docs/cloudflare-worker-deployment.md)
- [推論ゲートウェイ](docs/inference-gateway.md)
