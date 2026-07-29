# Caption Bridge

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

フロントエンドは責務ごとに分割しています。

```text
src/
  components/  共通フォーム部品
  core/        音声・設定・Tauriブリッジ・型
  i18n/        日英辞書とUI言語Provider
  live/        メイン画面と録音制御
  overlay/     透明字幕・ネイティブRGBAフレーム
  settings/    設定画面と文字スタイル編集
```

## 開発環境

- Node.js 20+
- pnpm 10+
- Rust 1.88（`rust-toolchain.toml`で固定）
- Tauri 2
- macOS / Windows（Linuxはブラウザプレビューとデバッグ対象）

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm build
pnpm tauri:dev

# Rustも含めたCI相当の検査
pnpm check:all
```

`pnpm test:coverage`と`pnpm gateway:test:coverage`は、それぞれの対象にstatements / branches / functions / lines 95%以上を強制します。純粋なAzooKey Rustポートも、GTK/WebKit不要の`pnpm rust:azookey:test`とClippyで検査します。

字幕フォントは`@fontsource-variable/noto-sans-jp`を同梱し、Noto Sans JP Variableを既定にしています。
デスクトップ用アイコンと配布バンドル設定も含みます。macOSのマイク利用説明はOS言語に合わせて日本語・英語を表示します。

## UI言語

画面右上で日本語と英語を切り替えられます。選択はローカルに保存され、未選択時はOS・ブラウザーの言語を参照し、対応外の言語では日本語を使用します。字幕の認識元・翻訳先を表す言語コードとは独立しているため、UI言語を変えても日本語→英語の処理設定は変わりません。

## 起動とOBSへの追加

1. Parapperと、テキストモデルのOpenAI互換エンドポイントを起動します。MVPの既定ゲートウェイは`http://127.0.0.1:8765`です。
2. Caption Bridgeを起動します。
3. 「設定」で音声入力デバイス、言語コード、モデル、推論ゲートウェイURLを設定して保存します。
4. 「マイク一覧を再取得」でデバイス権限後のマイク名を更新します。
5. 「オーバーレイを開く」を押し、OBSのWindow Captureで`Caption Bridge Overlay`を追加します。
6. OBS側のキャプチャは透明度を維持し、Caption Bridge側では背景を設定しません。

標準経路は透明ウィンドウのため、OBS側のWindow Captureだけで利用できます。WindowsのSpout2、macOSのSyphonを使う場合は、対応するOBSプラグインと下記のネイティブ出力ビルドを用います。これらの設定項目はUIには表示していません。Spout2/Syphonへ送るのは`?overlay=1`の透明字幕キャンバスだけであり、設定画面・プレビュー・ウィンドウ装飾は送信されません。

## モデル

- ASR: [Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR) の日本語モデルID `parapper-ja`
- 日本語変換: Rustで再実装したAzooKey LOUDS辞書/接続コスト/Viterbi、または`zenz-v3.2-xsmall-gguf` / `zenz-v3.2-small-gguf`
- 翻訳: 日本語→英語に限定したHy-MT2 1.8B系GGUF、または7B GGUF

GGUFをCaption Bridge本体に同梱せず、推論ゲートウェイ側でモデルをロードします。これによりアプリの更新と数GBのモデル更新を分離できます。モデル選択はゲートウェイ設定の信頼済みモデルルートに対応しており、アプリから任意のサーバーファイルをロードすることはありません。AzooKeyを選んだ場合だけ、辞書本体・ユーザー辞書・学習メモリの場所を設定できます。

推論ゲートウェイの契約は[docs/inference-gateway.md](docs/inference-gateway.md)、出力分離の根拠は[docs/architecture.md](docs/architecture.md)、ネイティブ開発環境は[docs/native-development.md](docs/native-development.md)を参照してください。

## Spout2 / Syphonのビルド

デフォルトは透明Tauriウィンドウです。ネイティブ出力はUIに設定項目を持たず、OSとCargo featureに応じて自動で選択します。オーバーレイのRGBAフレームは、WindowsではSpout2、macOSではSyphonへ渡せます。

```powershell
# Windows PowerShell
pnpm tauri build -- --features native-output
```

```bash
# macOS
pnpm tauri build -- --features native-output
```

`native-output`を付けない通常ビルドは、OBSのWindow Captureで透明オーバーレイを読み込みます。Spout2/Syphonを使う場合は、対応するOBS側プラグインも別途インストールしてください。ネイティブcrateの初期化に失敗した場合も透明ウィンドウへフォールバックします。

Spout2のネイティブビルドはWindows x86_64 + MSVCが対象です。Syphonは`Syphon.framework`を`/Library/Frameworks`または`~/Library/Frameworks`へ用意してからビルドしてください。

## 設計上の注意

- ASRはParapper専用のモデル選択に固定しています。
- 翻訳モデルの選択肢は今回の日本語→英語ケースで用いるHy-MT2系だけに制限しています。
- `source`と`target`はコードとして保存するため、将来の多言語化でUIとRustコアの契約を変更しません。
- 設定はOSのアプリ設定ディレクトリの`config.json`に保存されます。
- 開いているオーバーレイのサイズと位置は、設定保存時に即時反映されます。
- 音声処理が失敗した場合は、最後の字幕を勝手に消さず、UIにエラーを表示します。

## 別PCへの引き継ぎ

成果物と設計情報はリポジトリ内のMarkdownとして残ります。別PCや他のクラウド環境へ確実に引き継ぐには、Gitのプライベートリモートにpushしてcloneする方法を推奨します。具体的な手順、モデル・秘密情報を含めない方法、Gitをまだ使えない場合の移行方法は[docs/handoff.md](docs/handoff.md)にまとめています。
