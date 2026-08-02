# Kotoba Beacon

OBS配信向けのローカル字幕補助ツールです。マイク入力を日本語音声として認識し、かな漢字変換を行った後、日本語と英語の字幕を常に同時に透明オーバーレイへ表示します。

## MVPの構成

```text
Microphone
  ↓ 16 kHz / mono PCM chunks
Tauri frontend
  ↓ invoke
Rust core
  ├─ Parapper-ASR adapter       /v1/audio/transcriptions
  ├─ AzooKey Rust Viterbi port  or zenz GGUF adapter
  └─ Hy-MT2 adapter             /v1/chat/completions
  ↓ caption:update
Transparent Tauri overlay → OBS Window Capture
```

UIと推論処理はRustコマンドとHTTPプロトコルの境界で分離しています。`endpoint.baseUrl`を別PCのゲートウェイへ変更すれば、推論だけを別マシンに移せます。

リポジトリはワークスペースとして、実行可能なアプリケーションと共有 Rust
パッケージを分離しています。

```text
.github/workflows/       CI
apps/
  desktop/               Tauri + React デスクトップアプリ
    src/                 UI（components, core, i18n, live, overlay, settings）
    src-tauri/           Rust アプリケーション境界
  inference-gateway/     Tauri サイドカーになる HTTP・WebSocket ゲートウェイ
  cloudflare-worker-server/ Cloudflare Worker 用の同じ HTTP 契約と AzooKey WebSocket
  azookey-compare/       Web Speech と Worker 変換を比較する Next.js アプリ（独立起動）
packages/
  inference-server-core/  ローカル/Worker 共通の HTTP 契約・ルーティング
  azookey-rust/          かな漢字変換の共有 Rust crate
  parapper-asr/          Parapper-ASR フォーク（LICENSE と upstream 帰属を保持）
docs/                    設計・運用・引き継ぎ資料
```

## 開発環境

- Bun 1.3.14 (`package.json` の `packageManager` で固定)
- Rust 1.97.1（`rust-toolchain.toml`で固定）
- Tauri 2
- macOS / Windows（Linuxはブラウザプレビューとデバッグ対象）

```bash
bun install --frozen-lockfile
# Required only when rebuilding the official AzooKey archive from source.
git submodule update --init submodules/azooKey_dictionary_storage

# アプリ本体の起動はこれ一本（フロントエンド + Tauri + 内蔵サイドカーを一括起動）
bun run dev

bun run typecheck
bun run lint
bun run format:check
bun run test:coverage
bun run build                 # フロントエンドの本番出力（dist）
bun run check:single-app      # 起動経路と単一アプリ構成の静的検査
bun run assets:verify         # tracked WASM/dictionary copies and hashes
bun run check:macos-autoswitch # macOS .app / Dock / graceful quit 検証（macOSのみ）
bun run verify:tauri:build    # macOS: bundleを構築して実アプリ/native smoke
bun run verify:tauri:ui       # macOS: Accessibility UI smoke（TCC許可時）
bun run verify:tauri:build:ui # macOS: build→起動→UI smokeを一括実行
bun run verify:ui             # Vite画面/AzooKey/VAD/Debug/復旧のブラウザ検証
bun run rust:lint              # Tauri Rust Clippy（-D warnings、nesting=3）

# Rustも含めたCI相当の検査
bun run check:all
```

`bun run dev` がアプリケーション起動の唯一のエントリポイントです。Vite フロントエンド・Tauri ウィンドウ・内蔵の Gateway / Parapper / model server サイドカーをすべて一括で起動し、単一のアプリ（単一の Dock アイコン）として立ち上がります。従来の `bun run tauri:dev` は `bun run dev` のエイリアスとして残しています。

ブラウザだけでUIの外観を確認したいデバッグ用途には `bun run dev:web`（Vite プレビュー、`http://127.0.0.1:1420`）を使います。これはアプリ本体ではなく、Tauri コマンド・マイク取得・ネイティブオーバーレイが動作しない縮退モードです。通常の起動には `bun run dev` を使い、`dev:web` をアプリ本体の代わりに起動しないでください。

配布用の本番アプリは `bun run build:app` で生成します。これは sidecar のビルドと
Tauri の `.app` release bundle を一つの経路で実行します。DMGまで作る場合は
`bun run build:app:dmg` を使えます。既存の CI / 手動手順向けに
`bun run tauri:build` も同じコマンドの別名として利用できます。

署名付き自動更新成果物（`.app.tar.gz` / `.sig` と `latest.json` 用のアーティファクト）は、秘密鍵を環境変数へ注入したリリース環境でだけ `bun run build:app:release` を実行します。`TAURI_SIGNING_PRIVATE_KEY` がない場合は安全に停止し、秘密鍵をリポジトリや `.env` に保存しません。通常の `build:app` は開発・実機確認用の署名なしbundleです。現在のアプリ版は **0.1.1** で、feedの次版（例: 0.1.2）は一致する`.sig`とともに公開します。更新時はTauri bundle全体が置換されるため、Gateway / Parapper / model server / frontend は常に同じrevisionへ切り替わり、macOSではsidecarを停止して同じ`.app`を再起動します。更新feedの署名検証・進捗・失敗理由は設定→デバッグ情報で確認できます。

macOS配布では`Entitlements.plist`でマイク入力を宣言し、`Info.plist`でシステムの利用説明を表示します。Developer ID証明書とnotarization認証情報はCI secretへ注入する必要があるため、通常のPR CIでは署名/notarizationを行わず、`bun run check:macos-signing`が明示的に`SKIP`を記録します。信頼済みreleaseジョブだけで`KOTOBA_REQUIRE_APPLE_SIGNING=1`を設定すると、Apple証明書・notarytool認証がない場合に失敗します。秘密情報をリポジトリへ保存しないでください。
配布時は同じDeveloper IDで同梱の`Syphon.framework`とアプリ本体を署名してからnotarizeします。frameworkはソースツリーでは未署名のため、PR CIのunsigned bundle成功だけでは配布可否を示しません。

`bun run test:coverage`と`bun run gateway:test:coverage`は、それぞれの対象にstatements / branches / functions / lines 95%以上を強制します。純粋なAzooKey Rustポートも、GTK/WebKit不要の`bun run rust:azookey:test`とClippyで検査します。

字幕フォントは`@fontsource-variable/noto-sans-jp`を同梱し、Noto Sans JP Variableを既定にしています。
デスクトップ用アイコンと配布バンドル設定も含みます。macOSのマイク利用説明はOS言語に合わせて日本語・英語を表示します。

## UI言語

画面右上で日本語と英語を切り替えられます。選択はローカルに保存され、未選択時はOS・ブラウザーの言語を参照し、対応外の言語では日本語を使用します。字幕の認識元・翻訳先を表す言語コードとは独立しているため、UI言語を変えても日本語→英語の処理設定は変わりません。

## パイプライン・デバッグモード

各段階（ASR / 正規化 / 翻訳）の出力と所要時間を個別に確認できます。

1. アプリのライブ画面または **設定** タブで **デバッグ情報** を開く（ライブ画面では初期表示、開閉状態はローカルに保存されます）。
3. キャプチャを開始すると、`ASR (parapper)` / `Normalizer (azookey/zenz)` / `Translator (HY-MT2)` のカードと発話ごとの段階行がライブ更新されます。各行に開始・終了・所要時間と相対オフセット（`t+N ms`）が出ます。
4. **詳細ログ** をオンにすると、入出力サンプルがパネルの構造化ログへ流れます。ネイティブの継続ログには秘密を避けるため入出力サイズのみを残します（`config.debug.verboseLogging` として保存）。
5. **ログレベル**（error / warn / info / debug / trace）を切り替えると、構造化ログの表示とコンソール出力がフィルタされます（`config.debug.logLevel`）。
6. 構造化ログは JSONL / JSON でダウンロードでき、デスクトップでは **ログディレクトリへ保存** もできます。バックエンドの継続ログは `logDir` 配下の `kotoba-beacon*.log` です。
7. 更新確認・インストールの状態と、Gateway / Parapper / model server sidecar の version・health・切替結果も同じパネルで確認できます。更新イベントと失敗は秘密情報をマスクした構造化ログへ記録します。詳細は [docs/update-runtime-debug.md](docs/update-runtime-debug.md) を参照してください。

ブラウザプレビュー（`bun run dev:web`）でもパネル自体は開けます。ネイティブの段階イベントはアプリ本体（`bun run dev`）でのキャプチャ時に更新されます。

### 字幕を一度に表示する量

音声区間の既定値は `640 ms`（設定で `320〜2000 ms`、`32 ms`刻み）です。短くすると初回字幕が速く、長くすると一発話をまとめやすくなります。字幕本文は表示時に日本語を最大28文字、英語を最大48文字ごとの読みやすい行へ分割し、長文でも文字を省略せず、DOM・透明オーバーレイ・native出力で同じ折返しを使います。幅が足りない場合も全文を複数行へ折返すため、極端な縮小や重なりは起きません。

## 起動とOBSへの追加

1. `bun run dev` で Kotoba Beacon を起動します（起動コマンドはこれ一本です）。アプリ内蔵の Gateway、Parapper、選択済みの zenz / Hy-MT2 model server が自動で loopback に起動します。
2. 初回だけ、選択済みの ASR / GGUF モデルを取得します。Hy-MT2 1.8B標準モデルは約1.13 GBで、取得中はログに進捗が出ます。手動で複数のサーバーを起動する必要はありません。
3. 「設定」で音声入力デバイス、言語コード、モデル、推論ゲートウェイURLを設定して保存します。
4. 「マイク一覧を再取得」でデバイス権限後のマイク名を更新します。
5. 「オーバーレイを開く」を押し、OBSのWindow Captureで`Kotoba Beacon Overlay`を追加します。
6. OBS側のキャプチャは透明度を維持し、Caption Bridge側では背景を設定しません。

標準経路は透明ウィンドウのため、OBS側のWindow Captureだけで利用できます。WindowsのSpout2、macOSのSyphonを使う場合は、対応するOBSプラグインと下記のネイティブ出力ビルドを用います。これらの設定項目はUIには表示していません。Spout2/Syphonへ送るのは`?overlay=1`の透明字幕キャンバスだけであり、設定画面・プレビュー・ウィンドウ装飾は送信されません。

## モデル

- ASR: [Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR) の日本語モデルID `parapper-ja`
- 日本語変換: Rustで再実装したAzooKey LOUDS辞書/接続コスト/Viterbi、または Zenzai `v2` / `v3.2 xsmall` / `v3.2 small` GGUF
- 翻訳: 日本語→英語に限定したHy-MT2 1.8B系GGUF、または7B GGUF

GGUFをアプリ本体に同梱せず、選択された固定 revision のモデルだけを初回に app-data へ取得します。アプリから任意のサーバーファイルをロードすることはありません。Zenzai は専用の AzooKey llama.cpp フォークで実行し、U+EE00/U+EE01 の変換プロトコルをゲートウェイが OpenAI 互換レスポンスへ変換します。Hy-MT2 は STQ 対応の上流 llama.cpp で実行します。AzooKeyを選んだ場合だけ、辞書本体・ユーザー辞書・学習メモリの場所を設定できます。モデル容量、固定 revision、ライセンスは [docs/llama-runtime.md](docs/llama-runtime.md) を参照してください。

UI は [Simple Light Blue palette](https://www.schemecolor.com/simple-light-blue-color-palette.php) の `#AFDCEB`, `#CAE9F5`, `#F0F8FF`, `#ADD8E6`, `#86C5D8` を基調にしています。

推論ゲートウェイの契約は[docs/inference-gateway.md](docs/inference-gateway.md)、出力分離の根拠は[docs/architecture.md](docs/architecture.md)、ネイティブ開発環境は[docs/native-development.md](docs/native-development.md)を参照してください。

## Spout2 / Syphonのビルド

デフォルトは透明Tauriウィンドウです。ネイティブ出力はUIに設定項目を持たず、OSとCargo featureに応じて自動で選択します。オーバーレイのRGBAフレームは、WindowsではSpout2、macOSではSyphonへ渡せます。

```powershell
# Windows PowerShell
bun run build:app
```

```bash
# macOS
bun run build:app
```

対応するプラットフォームのデスクトップビルドではネイティブ出力を有効にします。Spout2/Syphonを使う場合は、対応するOBS側プラグインも別途インストールしてください。ネイティブcrateの初期化に失敗した場合も透明ウィンドウへフォールバックします。

Spout2のネイティブビルドはWindows x86_64 + MSVCが対象です。Syphon.framework 5 は Intel macOS
バンドルで利用します。現在同梱しているframeworkはx86_64専用のため、Apple Silicon版は透明
ウィンドウ出力へ明示的にフォールバックします（OBSのWindow Captureで利用できます）。

## 設計上の注意

- ASRはParapper専用のモデル選択に固定しています。
- 翻訳モデルの選択肢は今回の日本語→英語ケースで用いるHy-MT2系だけに制限しています。
- `source`と`target`はコードとして保存するため、将来の多言語化でUIとRustコアの契約を変更しません。
- 設定はOSのアプリ設定ディレクトリの`config.json`に保存されます。
- 開いているオーバーレイのサイズと位置は、設定保存時に即時反映されます。
- 音声処理が失敗した場合は、最後の字幕を勝手に消さず、UIにエラーを表示します。

## 別PCへの引き継ぎ

成果物と設計情報はリポジトリ内のMarkdownとして残ります。別PCや他のクラウド環境へ確実に引き継ぐには、Gitのプライベートリモートにpushしてcloneする方法を推奨します。具体的な手順、モデル・秘密情報を含めない方法、Gitをまだ使えない場合の移行方法は[docs/handoff.md](docs/handoff.md)にまとめています。
