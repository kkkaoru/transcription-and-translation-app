// Runs in the browser; built and tested with Bun.
const IMPLEMENTATION_URL: string =
  "https://github.com/kkkaoru/transcription-and-translation-app/blob/main/apps/vad-lab/src/vad-recorder.ts#L190-L470";

export function SourceLinks() {
  return (
    <section className="source-links" aria-labelledby="source-heading">
      <p className="eyebrow">PUBLIC REPRODUCIBLE SOURCE</p>
      <h2 id="source-heading">WASM・音声処理の実装</h2>
      <div className="technical-grid">
        <p>
          <strong>Rust処理:</strong>
          このWebアプリのVAD経路にはRustコードやRust製WASMを使用していません。SileroモデルはONNX
          Runtime WebのWebAssembly backendで実行します。
        </p>
        <p>
          <strong>WASM連携:</strong> <code>@ricky0123/vad-web</code>がONNX Runtime
          WASMを初期化し、AudioWorkletから渡された16 kHz・32 ms単位のframeをSileroへ入力します。
        </p>
        <p>
          <strong>音声処理:</strong>
          VADが確定した区切りを16 kHz mono PCM
          WAVへ変換し、音声Blob・品質指標・VAD設定・負荷指標を同じIndexedDBレコードへ保存します。
        </p>
        <p>
          <strong>メモリ計測:</strong> page memory
          breakdownからWorker、WASM、WorkerかつWASMへ帰属した値を集計します。ブラウザが帰属情報を公開しない場合は取得不可と記録します。
        </p>
      </div>
      <p>
        <a href={IMPLEMENTATION_URL} target="_blank" rel="noreferrer">
          VAD・WASM連携・音声区切り保存の実装を見る
        </a>
      </p>
    </section>
  );
}
