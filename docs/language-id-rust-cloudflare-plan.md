# Realtime Multilingual Language Harness Web App 実装計画書
## Rust inference / Cloudflare-first 版

- 対象リポジトリ: `kkkaoru/transcription-and-translation-app`
- 対象ブランチ: `main`
- 作成日: 2026-08-31
- 実装担当: 別Agent
- この文書を旧版より優先すること

---

# 0. 確定した方針

今回の新規Web Appでは、**VAD以外の新規推論・言語状態推定をRustで実装する**。

初期実装では新規推論をCloudflare側で実行し、将来は同じRust crateをWebAssemblyへビルドしてブラウザ内でも実行できるようにする。

## 初期実装

```text
Browser
  ├─ microphone / AudioWorklet
  └─ Silero VAD                     ← 既存実装を流用
          │
          │ PCM16 + VAD metadata
          ▼
Cloudflare LanguageSessionDO
  ├─ Workers AI Nova-3 WebSocket
  │    @cf/deepgram/nova-3
  │    language=multi
  │
  └─ Private Cloudflare Container WebSocket
          ▼
      native Rust
        ├─ Acoustic LID
        ├─ calibration
        ├─ Evidence Fusion
        ├─ Online HMM
        ├─ Sequential switch test
        ├─ Hysteresis
        └─ Fixed-lag Viterbi
```

## 将来のブラウザ実行

```text
Browser Web Worker
      ↓
same Rust crates -> wasm32-unknown-unknown
      ├─ Acoustic LID
      ├─ calibration
      ├─ Evidence Fusion
      ├─ Online HMM
      ├─ Sequential switch test
      ├─ Hysteresis
      └─ Fixed-lag Viterbi
```

Cloudflare版とブラウザ版でアルゴリズムを二重実装しない。

---

# 1. 最優先ルール

1. VADだけは既存 `apps/vad-lab` のSilero VADを流用する。
2. Acoustic LID、calibration、Evidence Fusion、HMM、switch detector、Hysteresis、Fixed-lag ViterbiはRustをsource of truthとする。
3. TypeScript/JavaScriptはtransport、Cloudflare orchestration、UI、可視化だけを担当する。
4. STTはCloudflare Workers AI `@cf/deepgram/nova-3` のReal-time WebSocketを使用する。
5. Nova-3は `language=multi` を維持し、`stableLanguage` をNovaの固定language hintへ戻さない。
6. Hosted Deepgram APIへ直接接続しない。Deepgram API key / temporary tokenを使用しない。
7. 初期Acoustic LID実行先はprivate Cloudflare Containerとする。
8. Rust inference crateはLinux nativeと `wasm32-unknown-unknown` の両方でbuild可能にする。
9. Pythonはモデルexport・変換・reference verificationだけに使用し、production runtimeには使用しない。
10. `onnxruntime-web` やTypeScript製NN推論を今回のproduction Acoustic LID runtimeにしない。
11. Rust NN runtimeの第一候補は `tract` とする。ただしECAPA互換性をPoCで確認するまで確定扱いしない。
12. 言語切替を「10秒続いたら切替」のような固定秒数ルールで決めない。
13. `UNKNOWN` と `UNSUPPORTED` を持つ。
14. 実装完了はfixture評価・native/WASM parity・latency計測までを条件にする。

---

# 2. 既存資産の流用

## `apps/vad-lab`

流用対象:

- microphone selection / constraints
- AudioWorklet
- 16 kHz mono PCM化の実装パターン
- `@ricky0123/vad-web` / Silero VAD
- VAD diagnostics
- environment / memory / event-loop diagnostics
- IndexedDB / PWA / D3の実装パターン

## `apps/cloudflare-worker-server`

既存の以下を壊さない。

- `@cf/deepgram/nova-3` batch ASR adapter
- `@cf/openai/whisper-large-v3-turbo`
- size/timeout/error handling
- CORS / access方針
- structured metrics
- tests

特に `apps/cloudflare-worker-server/src/workers-ai-asr.ts` をrealtime実装前に読むこと。

## `apps/zenz-container`

以下の設計思想を流用する。

- private Container
- model hash verification
- warm-up
- explicit release
- idle destroy
- bounded timeout
- privacy-safe metrics
- scale-to-zero
- minimal image

CRIU / snapshotは今回の初期スコープ外。

---

# 3. Workers AI Nova-3 realtime

採用:

```text
@cf/deepgram/nova-3
Real-time WebSocket
encoding=linear16
sample_rate=16000
language=multi
interim_results=true
```

Cloudflare Workers AIではWebSocket modeの概念形として次を使う。

```ts
const response = await env.AI.run(
  "@cf/deepgram/nova-3",
  {
    encoding: "linear16",
    sample_rate: "16000",
    language: "multi",
    interim_results: true,
  },
  { websocket: true },
);
```

ただし、**上記を完成実装としてそのままコピーしない**。

実装担当は次を先に行う。

1. 現在のCloudflare Workers AI公式schemaとgenerated Worker typesを確認する。
2. 既存 `workers-ai-asr.ts` のAI binding型、error handling、test seamを流用する。
3. `language=multi` の実WebSocket responseをfixtureとして保存する。
4. `sample_rate` 等の型をtypecheckで固定する。
5. Novaの実responseに存在するlanguage-related fieldだけを利用する。

## 単純pass-throughは禁止

```ts
return await env.AI.run(..., { websocket: true });
```

だけでは、Browser PCMをAcoustic LIDへteeしたり、Nova responseをRust engineへ渡したりできない。

今回の要件ではclient socket / Nova socket / Container socketを明示的にbridgeする必要がある。

---

# 4. Session Coordinator

第一候補として **session IDごとのDurable Object `LanguageSessionDO`** を追加する。

DOは推論を持たず、transport/stateful orchestrationだけを担当する。

```text
Browser WebSocket
       ↓
LanguageSessionDO
  ├─ Workers AI Nova-3 WebSocket
  └─ Language ID Container WebSocket
```

責務:

- Browser socket lifecycle
- Workers AI socket lifecycle
- Container socket lifecycle
- PCM tee
- Nova result forwarding
- message ordering
- reconnect / explicit reset
- bounded queue
- final transcript / switch event delivery

Language algorithmをDO/TypeScriptへ実装しない。

---

# 5. Nova language evidence

Workers AI Nova-3の未確認fieldを固定仕様にしない。

最初に実レスポンスfixtureで次を確認する。

```text
channel-level language
detected language
word-level language
language confidence
words[]
interim / finalでのfield差
```

`word.confidence` が存在してもtranscription confidenceであり、

```text
P(language=en)
```

として扱わない。

Rust側のNova入力はoptionalにする。

```rust
pub struct NovaObservation {
    pub started_at_ms: f64,
    pub ended_at_ms: f64,
    pub is_final: bool,
    pub language_scores: Vec<LanguageScore>,
    pub quality: f32,
}
```

Novaからusableなlanguage evidenceが得られない場合でも、Acoustic LIDだけでtrackerが成立すること。

---

# 6. Acoustic LID

初期baseline:

```text
speechbrain/lang-id-voxlingua107-ecapa
```

architectureへモデル名を焼き込まない。

```rust
pub trait AcousticLanguageModel {
    fn model_id(&self) -> &str;
    fn sample_rate(&self) -> u32;
    fn infer(&mut self, pcm: &[f32]) -> Result<LanguageLogits, LidError>;
}
```

将来候補:

- SpeechBrain ECAPA
- PearlNet
- app-specific fine-tuned LID

## Runtime

第一候補:

```text
tract
```

理由:

- Rust実装
- ONNX / NNEFを扱える
- native CPUとWASMの両方を狙える
- Cloudflare nativeとbrowser WASMで同じinference sourceを維持しやすい

ただし、SpeechBrain ECAPAをtractで動かせることを仮定しない。

---

# 7. Acoustic model compatibility gate

Cloudflare integrationへ進む前に次を通す。

## Gate A

```text
SpeechBrain checkpoint -> ONNX export
```

## Gate B

```text
Rust tract native load + inference
```

## Gate C

```text
SpeechBrain reference vs Rust logits/posterior parity
```

比較:

- top-1
- top-k
- max logit error
- posterior KL divergence

## Gate D

必要なら:

```text
ONNX -> NNEF / tract OPL
```

runtime footprintを削減する。

## Gate E

```text
wasm32-unknown-unknown build
browser Web Worker fixture inference
```

全Gateを通してからECAPAを本採用する。

tract非対応の場合の優先順:

1. export graph simplify
2. preprocessingをRustへ分離
3. unsupported opの等価変換
4. NNEF/OPL変換
5. 必要なoperatorをRust実装
6. tract互換の別Acoustic LIDへ変更

`browserだけonnxruntime-web / CloudflareだけPython` の二重実装へ逃げない。

---

# 8. Rust crate構成

```text
crates/
  language-harness-core/
    src/
      language.rs
      observation.rs
      evidence.rs
      hmm.rs
      switch_test.rs
      hysteresis.rs
      viterbi.rs
      tracker.rs
      timeline.rs
      metrics.rs

  acoustic-lid/
    src/
      model.rs
      ecapa.rs
      preprocess.rs
      posterior.rs
      ring_buffer.rs
      engine.rs

  language-harness-wasm/
    src/lib.rs
```

依存:

```text
language-harness-core     ← model runtimeに依存しない
        ↑
acoustic-lid
        ↑
 ┌──────┴──────────┐
Container binary   language-harness-wasm
```

---

# 9. Rust engine API

重要: raw event受信とtracker更新を分離する。

Novaは非同期、Acoustic LIDはrolling hopなので、event到着のたびにHMM transitionを進めてはならない。

```rust
pub struct LanguageHarnessEngine { /* ... */ }

impl LanguageHarnessEngine {
    pub fn push_audio(
        &mut self,
        frame: AudioFrame<'_>,
        vad: VadObservation,
    ) -> Result<(), EngineError>;

    pub fn push_nova(
        &mut self,
        observation: NovaObservation,
    ) -> Result<(), EngineError>;

    pub fn advance_to(
        &mut self,
        timestamp_ms: f64,
    ) -> Result<Vec<LanguageHarnessUpdate>, EngineError>;

    pub fn current_state(&self) -> &LanguageHarnessState;
    pub fn reset(&mut self);
}
```

`push_*` はtimestamped observation cacheを更新し、`advance_to()` が固定tracker tickでstate transitionを行う。

---

# 10. Timing semantics

初期候補:

```text
Acoustic minimum voiced context: 1.0〜1.5 sec
Acoustic preferred window:       約3 sec
Acoustic hop:                    約500 ms
Tracker step:                    500 ms
```

これらはモデル観測cadenceであり、言語切替の固定時間ルールではない。

## なぜfixed tracker tickが必要か

Nova interim/final event数は音声やprovider実装によって変動する。

eventごとにHMM transitionを1回進めると、同じ音声でもNova eventが多いだけでstate transition回数が増え、結果が変わってしまう。

そのため:

```text
Audio / Nova events
      ↓ timestamped cache
fixed tracker tick
      ↓
Evidence Fusion
      ↓
HMM + switch test
```

とする。

Nova interimは同一time spanを置換し、二重加算しない。

---

# 11. Evidence Fusion

Rust実装。

```text
Acoustic posterior
+ Nova optional evidence
+ quality
      ↓
fused observation score E_t(L)
```

概念式:

```text
E_t(L)
 = Wa * log(P_acoustic_t(L) + eps)
 + Wn * log(P_nova_t(L) + eps)
```

`E_t(L)` は**現在tickで追加された観測score**であり、HMM posteriorとは別に保持する。

Dynamic weightはRustで計算する。

Acoustic weightを下げる例:

- low speech coverage
- low RMS
- clipping
- short context
- high entropy

Nova weightを下げる例:

- interim
- language fieldなし
- poor quality
- very short token only
- conflicting labels

---

# 12. Online HMM Forward Filter

Rust実装。

固定tracker tickごとに:

```text
P(L_t | x_1:t)
```

を更新する。

目的:

- 過去のstable languageをpriorとして反映
- 曖昧発話で簡単にflipしない
- 強い新言語evidenceが続けば追従

過去60秒を単純多数決しない。

---

# 13. Sequential switch test

ここはセルフレビューで重要な修正点。

**HMM posterior比をさらにSPRTへ累積しない。**

HMM posteriorはすでに過去観測を含んでいるため、

```text
log(P_HMM(c) / P_HMM(s))
```

を再度累積すると履歴を二重計上する。

stable `s` とcandidate `c` のswitch episodeでは、Section 11の**現在tick observation score**だけを使う。

```text
increment_t = E_t(c) - E_t(s)
LLR_t = LLR_(t-1) + increment_t
```

初期実装ではclassic SPRTに近いepisode accumulatorとし、任意の指数decayを入れない。

reset条件:

- stableが再び優勢
- candidateが変わった
- speech gapがthresholdを超えた
- observation quality不足でepisodeを破棄

継続的なforgettingが必要になった場合、`SPRT` と呼んだままleaky accumulatorへ変更しない。Page CUSUM等を別algorithmとして実装しA/Bする。

---

# 14. Hysteresis

Rust実装。

```text
switch enter threshold != retain threshold
```

にして境界付近のflappingを防ぐ。

HysteresisはSPRT/HMMと役割を分ける。

- HMM: temporal prior
- switch test: new languageへの累積観測evidence
- Hysteresis: state変更前後の閾値非対称化

---

# 15. Fixed-lag Viterbi

Rust実装。

```text
realtime current language
  -> Forward HMM + switch test + Hysteresis

finalized past timeline
  -> Fixed-lag Viterbi
```

Viterbi待ちでrealtime UIをブロックしない。

初期lag候補:

```text
1.5〜2.0 sec
```

評価で決める。

---

# 16. UNKNOWN / UNSUPPORTED

Rust engineで扱う。

## UNKNOWN

例:

- flat posterior
- high entropy
- insufficient voiced audio
- poor audio quality
- severe Nova/Acoustic conflict

## UNSUPPORTED

Acoustic LIDが高confidenceでNova multilingual対象外言語を検出した場合。

例:

```text
raw_language = ko
stable_language = unsupported
```

対応10言語のどれかへ無理に丸めない。

---

# 17. Container初期実装

Acoustic LIDをCloudflare Worker内WASMへ最初から入れない。

初期版:

```text
Private Cloudflare Container
  -> native Rust
  -> tract
  -> Acoustic LID + Language Harness Engine
```

理由:

- Worker isolate memoryは128 MB
- Worker bundle size制約
- Worker WebAssemblyではthreading不可
- FP32 ECAPA + runtime + intermediate tensorをWorkerへ押し込むリスクが高い

Worker WASM化は、quantized model等でmemory/latencyを実測してからoptional optimizationとして検討する。

---

# 18. Container routing

Container内部で複数sessionを持つ場合:

```rust
HashMap<SessionId, LanguageHarnessEngine>
```

としてよいが、**同じsessionのeventが必ず同じContainer instanceへ届くこと**が必須。

## 初期版

モデル複製とcold startを増やさないため、1つのnamed shardへ複数sessionを集約する。

```text
language-id-v1-shard-0
```

`getRandom()`をrequestごとに呼ばない。stateful sessionが別instanceへ移動して壊れるため。

## スケール時

```text
shard = stable_hash(session_id) % N
```

でsticky routingする。

shard数変更時は既存session routingが変わらないよう、deployment versionをkeyへ入れるかdrain戦略を用意する。

Container restartでin-memory stateが消失した場合、黙って継続しない。初期版ではBrowserへ明示的な`state reset`を通知する。

---

# 19. Container transport

通常のrealtime経路は**long-lived WebSocket**を使用する。

20〜500ms cadenceのPCMを毎回HTTP POSTする設計をdefaultにしない。

Cloudflare ContainersはWebSocket forwardingを利用できるため、Session Coordinatorから固定Container shardへsession中1本のsocketを維持する。

概念protocol:

```text
coordinator -> container
  binary: AudioFrameEnvelope + PCM16
  text/json: NovaObservation / control

container -> coordinator
  text/json: LanguageHarnessUpdate / switch event / diagnostics / error
```

`AudioFrameEnvelope`:

```text
protocol version
sequence
started_at_ms
sample_rate
vad speech flag
vad probability
PCM sample count
```

Rust側で:

- duplicate sequenceをdrop
- out-of-orderをreject/drop + metric
- gapをmetric
- reconnect continuity不明ならreset

HTTPはhealth、warm-up、release、debug等に限定してよい。

---

# 20. Backpressure

**Nova STT経路とAcoustic LID経路のbackpressureを分離する。**

LIDが遅れたためにNovaへ送るPCMをdropしてはいけない。

```text
PCM -> Nova
  ordered
  原則drop禁止
  過負荷ならsession fail-fast/reconnect

PCM -> Acoustic LID
  latest-window優先
  未開始の古いinference windowはdrop可

Nova result -> Rust
  timestamp/revision fence
  final優先

Rust state -> Browser
  latest stateはcoalesce可
  switch eventはdrop禁止
```

Rust metrics:

- dropped acoustic windows
- input sequence gaps
- inference queue depth
- inference latency

---

# 21. Rust config

```rust
pub struct LanguageHarnessConfig {
    pub acoustic_window_samples: usize,
    pub acoustic_hop_samples: usize,
    pub tracker_step_ms: u32,
    pub min_speech_coverage: f32,

    pub acoustic_weight: f32,
    pub nova_weight: f32,
    pub calibration_temperature: f32,

    pub hmm_self_transition_bias: f32,
    pub unknown_transition_bias: f32,

    pub sprt_upper_threshold: f32,
    pub sprt_lower_threshold: f32,
    pub sprt_max_silence_ms: u32,

    pub switch_posterior_threshold: f32,
    pub retain_posterior_threshold: f32,

    pub fixed_lag_observations: usize,
}
```

magic numberをTypeScriptへ置かない。

---

# 22. Browser-ready Rust/WASM

初期Cloudflare版の時点からCIで:

```text
cargo build --target wasm32-unknown-unknown
```

を通す。

将来:

```text
Main Thread
  ├─ React
  ├─ AudioWorklet
  └─ Silero VAD

Web Worker
  └─ Rust WASM
       ├─ tract
       ├─ Acoustic LID
       └─ Language Harness Engine
```

Acoustic inferenceをmain threadで実行しない。

nativeとWASMで同じfixtureを実行し、以下を比較する。

- top language
- posterior
- switch sequence
- switch tick
- finalized timeline

浮動小数点差の許容範囲を定義する。

---

# 23. Model assets

## Container

モデルをContainer image layerへ含めることを第一候補にする。

- deployment/model revision一致
- checksum固定
- cold start時のR2 download回避

## Browser

同じrevision/checksumのmodel assetをR2/custom domain等から取得し、versioned browser cacheへ保存する。

まずFP32 referenceを成立させ、その後INT8を評価する。

INT8 default採用条件:

- accuracy regression許容
- switch latency悪化なし
- calibration再調整可能
- model size/runtime memoryが十分改善

---

# 24. Realtime SLO / metrics

初期目標:

```text
Rust tracker update p95       < 10 ms
Acoustic inference p95        < acoustic hop
strong ja -> en switch p50    < 2.5 sec
strong ja -> en switch p95    < 4.0 sec
```

これは固定switch ruleではなく評価SLO。

記録:

- Container cold start
- warm-up
- model load
- Acoustic inference p50/p95
- tracker p50/p95
- Worker/DO -> Container latency
- Workers AI Nova result latency
- switch detection latency
- false switch / minute
- missed switch
- memory RSS

transcript本文/raw audioを通常のstructured logへ出さない。

---

# 25. Tests

## Rust unit

`language-harness-core`:

- fixed-tick behavior
- irregular Nova event countで結果が変わらないこと
- HMM
- switch episode reset
- HMM posteriorをswitch LLRへ二重計上していないこと
- Hysteresis
- Viterbi
- UNKNOWN / UNSUPPORTED
- serialization
- config validation

`acoustic-lid`:

- ring buffer
- VAD speech coverage
- inference cadence
- calibration
- posterior normalization
- label map
- reference parity
- backpressure

## Audio integration fixtures

最低限:

1. Japanese only
2. English only
3. long Japanese + ambiguous speech
4. Japanese -> English
5. English -> Japanese
6. Japanese -> English -> Japanese
7. Japanese with English product names
8. English with Japanese proper nouns
9. filler only
10. numbers
11. silence
12. background noise
13. low volume
14. clipping
15. unsupported language
16. accented English
17. non-native Japanese

評価:

- stable language accuracy
- false switch rate
- missed switch rate
- switch latency
- switch boundary error

---

# 26. CI

初期実装から必須:

```text
cargo fmt --check
cargo clippy -- -D warnings
cargo test
native release build
wasm32-unknown-unknown build

language-id-lab typecheck/lint/test
cloudflare-worker-server tests
container image build
```

browser backendをまだproduction利用しなくてもWASM build failureを許可しない。

---

# 27. 実装フェーズ

## Phase 0: baseline

既存mainのtest/typecheckを記録する。

## Phase 1: Rust `language-harness-core`

音声なしで:

- observation model
- Evidence Fusion
- fixed tracker tick
- HMM
- sequential switch test
- Hysteresis
- Fixed-lag Viterbi

を実装しsynthetic testを完成させる。

## Phase 2: Acoustic LID feasibility

```text
SpeechBrain -> ONNX -> tract native -> reference parity -> WASM fixture
```

compatibility gateを通す。

## Phase 3: `acoustic-lid` Rust

- PCM ring buffer
- VAD coverage
- tract inference
- calibration
- posterior
- cadence/backpressure

## Phase 4: private Cloudflare Container

- model embedding/checksum
- warm-up
- shared named shard
- Rust WebSocket protocol
- session create/drop/reset
- release / idle destroy
- metrics

## Phase 5: Workers AI Nova-3 realtime

- current generated types確認
- realtime adapter
- `language=multi`
- response fixture
- Nova evidence adapter

## Phase 6: `LanguageSessionDO`

- Browser socket
- Nova upstream socket
- Container socket
- PCM tee
- ordering/backpressure/reconnect

## Phase 7: `apps/language-id-lab`

- microphone/VAD流用
- current language
- candidate/evidence
- Acoustic top-k
- HMM posterior
- timeline
- latency diagnostics

## Phase 8: calibration/evaluation

- temperature
- fusion weights
- HMM transitions
- switch thresholds
- hysteresis
- Viterbi lag

をfixtureから決める。

## Phase 9: browser WASM backend

```text
inferenceLocation:
  cloudflare   ← initial default
  browser
```

同じRust crate/model revisionを使用する。

---

# 28. PR分割

1. Rust `language-harness-core`
2. Acoustic LID tract feasibility + `acoustic-lid`
3. private language-id Container
4. Workers AI Nova-3 realtime adapter
5. `LanguageSessionDO` bridge
6. `language-id-lab` Cloudflare-first UI
7. evaluation/calibration/metrics
8. browser WASM backend

巨大PR1本で実装しない。

---

# 29. Definition of Done: 初期Cloudflare版

- [ ] VADは既存Silero
- [ ] VAD以外の新規推論/state logicはRust
- [ ] Acoustic LIDがRust + tract
- [ ] fixed tracker tick
- [ ] HMMがRust
- [ ] sequential switch testがcurrent observation scoreを使用
- [ ] HMM posteriorの二重計上なし
- [ ] HysteresisがRust
- [ ] Fixed-lag ViterbiがRust
- [ ] Workers AI `@cf/deepgram/nova-3` realtime
- [ ] `language=multi`
- [ ] Hosted Deepgram直接接続なし
- [ ] Session CoordinatorがNova/ContainerへPCMをtee
- [ ] Containerはsticky named shard routing
- [ ] realtime Container transportはWebSocket
- [ ] Nova経路とLID backpressureを分離
- [ ] Container warm-up/release/idle destroy
- [ ] `UNKNOWN` / `UNSUPPORTED`
- [ ] false switch / switch latency metrics
- [ ] native Rust tests
- [ ] wasm32 build
- [ ] model checksum
- [ ] SpeechBrain/Rust reference parity
- [ ] privacy-safe logs
- [ ] existing batch ASR regressionなし

---

# 30. Definition of Done: Browser-ready

初期版の時点で最低限:

- [ ] `language-harness-core` wasm32 build
- [ ] `acoustic-lid` wasm32 build
- [ ] browser Web Workerでfixture inference
- [ ] same model revision/checksum
- [ ] native/WASM parity test

production UIでbrowser inferenceを有効化するのは後続phaseでよい。

---

# 31. 禁止事項

以下を採用しない。

```text
過去N秒の単純多数決
「10秒ENならswitch」の固定時間ルール
STT transcript textだけのLID
Nova word confidence = language probabilityという扱い
HMM posterior ratioをSPRTへ再累積
Nova event受信ごとのHMM transition
stateful Containerへのrequest単位getRandom routing
PCM frameごとのHTTP POSTをrealtime defaultにする
Acoustic LID遅延によるNova PCM drop
TypeScript製HMM/SPRT/Viterbi
browserだけonnxruntime-web / CloudflareだけPython
Hosted Deepgram API direct
```

---

# 32. 最終採用スタック

```text
VAD:
  existing browser Silero

STT:
  Cloudflare Workers AI
  @cf/deepgram/nova-3
  language=multi

Realtime coordinator:
  LanguageSessionDO

Acoustic LID:
  Rust
  SpeechBrain ECAPA baseline
  tract runtime

Language tracking:
  Rust
  fixed tracker tick
  Evidence Fusion
  Online HMM
  sequential LLR / SPRT episode
  Hysteresis

History smoothing:
  Rust
  Fixed-lag Viterbi

Initial inference:
  private Cloudflare Container
  native Rust

Future inference:
  Browser Web Worker
  same Rust crates compiled to WASM

Frontend:
  React/TypeScript
  transport / orchestration / visualization only
```

---

# 33. 参考する公式仕様

実装時は必ず最新版を再確認すること。

- Workers AI Nova-3 model: `https://developers.cloudflare.com/workers-ai/models/nova-3/`
- Workers AI / AI Gateway realtime WebSocket: `https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/`
- Workers WebAssembly limits: `https://developers.cloudflare.com/workers/runtime-apis/webassembly/`
- Workers limits: `https://developers.cloudflare.com/workers/platform/limits/`
- Containers routing/scaling: `https://developers.cloudflare.com/containers/configuration/scaling-and-routing/`
- Containers WebSocket forwarding: `https://developers.cloudflare.com/containers/examples/websocket/`
- Container / Durable Object architecture: `https://developers.cloudflare.com/containers/concepts/architecture/`

Cloudflareの仕様は変化するため、この文書のサンプルコードより**実装時点の公式schema・generated types・実fixtureを優先**する。
