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
  azookey-compare/           Browser音声 → Cloudflare統合パイプライン検証UI
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

# Native（macOS: release build、package、インストール済み.appの置換）
make build
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

Nativeアプリは子プロセスを必要としません。macOSでは`make build`がlocked
release executableと配布用bundleを生成し、既定のインストール先
`~/Applications/Kotoba Beacon Native.app`を毎回置き換えます。古い実行中プロセスで
確認してしまわないよう、アプリが起動中の場合は置換せず失敗します。先にアプリを終了して
再実行してください。ビルド・置換処理がアプリを起動することはありません。置換後は
SettingsのBuild IDで対象コミットを確認できます。実行ファイルだけを作る場合は
`make native-release`を使用します。

OBS Browser Sourceは一つのURLを使用し、横・縦の表示はNativeのStyleプロファイルで
切り替えます。

- `http://127.0.0.1:1521/`

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
