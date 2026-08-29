# VAD Lab

ブラウザ内でSilero VADの区切り品質、音声品質、処理負荷を調査するReact + TanStack Query製のSPAです。

## データとプライバシー

- VAD、WAV生成、メトリクス計算、IndexedDB保存、再生はブラウザ内で完結します。
- 音声・STT・計測値をこのアプリのCloudflare配信元へ送るAPIはありません。
- VAD確定後、保存した音声Blobから一時的なaudio trackを作り、音声単位でWeb Speech APIへ渡します。マイクを連続認識するリアルタイムSTTではありません。
- Web Speech APIはブラウザ実装によってブラウザ提供元のオンライン音声認識へ音声を送る場合があります。
- Web Speech APIが利用できない環境でも、VAD・保存・再生は利用できます。
- RAMは`performance.measureUserAgentSpecificMemory()`のページ全体memory estimateを定期サンプリングし、breakdownも保存します。未対応時はChromiumの`performance.memory.usedJSHeapSize`へフォールバックします。ブラウザAPIはSilero/ONNX WASMだけの正確な専有RSSを公開しないため、初期化前後のpage delta、取得API、scope、取得可否を必ず記録し、値を捏造しません。

## オフラインと更新

Silero ONNX、ONNX Runtime WASM、AudioWorklet、アプリbundleを同一originから配信し、PWA service workerでprecacheします。初回読み込み後はオフラインで動作します。新しいdeployを検出するとUIに更新ボタンを表示し、ユーザー操作で新しいservice workerへ切り替えます。

Cloudflare Workers Static Assetsだけを使用し、Worker scriptやサーバーAPIはありません。`not_found_handling: single-page-application`によりSPA navigationへ対応します。

## 記録内容

各VAD区間を16 kHz mono WAVとして保存し、次を記録します。

- UUID、sequence、前後の音声ID
- 発話開始・終了日時、言語コード
- 音声単位Web Speech API文字列、状態、処理時間、信頼度
- VAD区間時間、callback合計/平均/最大、frame interval平均/p50/p95/最大/jitter、throughput、real-time factor
- Long Task数/時間、event-loop lag、48 ms超frame数
- memory API、breakdown、sample数、開始・終了・ピーク・差分、Silero初期化前後page delta
- VAD発話確率の平均・最大・最小
- duration、sample数、bytes、peak、RMS、clip率、無音率、zero-crossing率
- user agent、platform、CPU並列度、device memory、AudioContext sample rateなどの実行環境
- 要求した全microphone constraints、ブラウザのsupported constraints、実track settings/capabilities
- VAD threshold、padding、redemption、processor preferenceと実際のAudioWorklet/ScriptProcessor

D3.jsで発話確率、32 ms frame cadence、event-loop lag、page memoryをリアルタイム表示します。画面には公開GitHub repositoryの該当実装ファイルと行anchorも表示します。

## コマンド

```bash
bun install
bun --filter=@caption-bridge/vad-lab run dev
bun --filter=@caption-bridge/vad-lab run typecheck
bun --filter=@caption-bridge/vad-lab run lint
bun --filter=@caption-bridge/vad-lab run test:coverage
bun --filter=@caption-bridge/vad-lab run deploy
```

VAD runtime assetはbuild前にインストール済みnpm packageから`public/vad/`へコピーされ、外部CDNへ依存しません。
