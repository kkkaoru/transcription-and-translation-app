# Cloudflare と Hugging Face の連携調査

2026-08-02 時点では、2023 年にプレビューされた「Hugging Face Hub のモデルを
Workers AI へ直接デプロイする」連携は提供終了しています。Hugging Face の公式案内も
Inference API、Inference Endpoints、または別のデプロイ方法への移行を案内しているため、
このアプリに旧 Hub 連携用のトークンや壊れたデプロイ経路は追加していません。

代わりに、利用可能な現行 Cloudflare 機能として Workers AI の `@cf/deepgram/nova-3`
を音声認識の比較・フォールバック経路に追加しました。`ASR_PROVIDER=workers-ai` を明示的に
設定した場合だけ `AI` binding を使い、日本語 (`ja`) の文字起こし結果を既存の
`POST /v1/audio/transcriptions` 形式へ変換します。標準経路は従来どおり Parapper で、
AzooKey のかな漢字変換とは分離されています。AI binding が存在するだけでは呼び出さず、
課金・音声データの取り扱いを確認してから有効化してください。

AzooKey の品質と再現性を優先し、かな漢字変換そのものを LLM や Workers AI に置き換えて
いません。公式 AzooKey の LOUDS/MM/CID 辞書を固定フレーズ表ではなく portable asset として
Worker の WASM に読み込みます。Vibrato のサーバー側実行は HTTP adapter を設定した場合、
ブラウザ側実行は比較アプリの Vibrato WASM を選択できます。Workers の 128 MiB isolate
制約により、大きな Vibrato WASM 辞書と公式 AzooKey 辞書を同じ isolate で初期化しない設計です。

## 参照

- [Cloudflare の 2023 年プレビュー記事](https://blog.cloudflare.com/ja-jp/partnering-with-hugging-face-deploying-ai-easier-affordable/)
- [Hugging Face の Cloudflare 連携更新（提供終了の注記）](https://huggingface.co/blog/cloudflare-workers-ai)
- [Cloudflare Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cloudflare Nova-3 model](https://developers.cloudflare.com/workers-ai/models/nova-3/)
