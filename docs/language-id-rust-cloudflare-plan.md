# Realtime Multilingual Language Harness Web App 実装計画書
## Rust inference / Cloudflare-first 版

- 対象リポジトリ: `kkkaoru/transcription-and-translation-app`
- 対象ブランチ: `main`
- 作成日: 2026-08-31
- 実装担当: 別Agent
- この文書を旧版より優先すること

---

# 0. 確定した技術方針

今回の新規Web Appでは、**VAD以外の新規推論・言語状態推定をRustで実装する**。

初期実装では新規推論をCloudflare側で実行する。

将来は同一Rust実装をWebAssemblyへビルドし、ブラウザ内でも実行可能にする。

## 0.1 実行場所

### 初期実装

```text
Browser
  ├─ microphone capture
  ├─ AudioWorklet
  ├─ Silero VAD                 ← 既存実装を流用。Rust化しない
  │
  └─ PCM + VAD metadata
          ↓
Cloudflare Worker
  ├─ Workers AI Nova-3 WebSocket
  │    @cf/deepgram/nova-3
  │    language=multi
  │
  └─ Private Cloudflare Container
       ↓
     Rust Language Harness Engine
       ├─ Acoustic LID
       ├─ posterior calibration
       ├─ Nova evidence normalization
       ├─ Evidence Fusion
       ├─ Online HMM Forward Filter
       ├─ SPRT
       ├─ Hysteresis
       └─ Fixed-lag Viterbi
```

### 将来のブラウザ実行

```text
Browser
  ├─ Silero VAD
  ├─ Workers AI Nova-3 WebSocket
  │
  └─ Web Worker
       ↓
     Rust → wasm32-unknown-unknown
       ↓
     同一 Language Harness Engine
       ├─ Acoustic LID
       ├─ calibration
       ├─ Evidence Fusion
       ├─ HMM
       ├─ SPRT
       ├─ Hysteresis
       └─ Viterbi
```

**Cloudflare版とブラウザ版でアルゴリズムを二重実装しない。**

---

# 1. 最優先ルール

Agentは以下を必ず守ること。

1. VADだけは既存 `apps/vad-lab` のSilero VADを流用する。
2. VAD以外の今回新規追加する推論・状態推定をTypeScript/JavaScriptで実装しない。
3. Acoustic LID、calibration、Evidence Fusion、HMM、SPRT、Hysteresis、Fixed-lag ViterbiはRustをsource of truthとする。
4. STTはCloudflare Workers AI `@cf/deepgram/nova-3` を使う。
5. Hosted Deepgram APIへ直接接続しない。
6. Deepgram API key / temporary tokenを使用しない。
7. Nova-3は `language=multi` を維持し、stable languageをSTTへの固定言語指定としてフィードバックしない。
8. 初期Acoustic LID実行先はprivate Cloudflare Containerとする。
9. Rust inference crateはLinux nativeと`wasm32-unknown-unknown`の両方をbuild可能にする。
10. 将来ブラウザへ移行するときにアルゴリズムを書き直さない。
11. Pythonはモデルexport・変換・検証などのbuild toolingにのみ使用してよい。production runtimeには使用しない。
12. `onnxruntime-web` を今回のAcoustic LID production runtimeとして使用しない。
13. Rustで利用するNN runtimeの第一候補はpure-Rustの`tract`とする。
14. tractで対象ECAPA graphが動くことを実測確認してからモデルを固定する。
15. tract非対応operatorがある場合、JavaScript runtimeへ逃げず、export graph修正・NNEF変換・Rust operator実装・別の互換LIDモデルの順に解決する。
16. 既存 `apps/desktop`、`apps/vad-lab`、既存Workers AI batch ASRを壊さない。
17. 固定秒数で言語切替を決めない。
18. 言語切替は累積evidenceで決定する。
19. `UNKNOWN` と `UNSUPPORTED` を持つ。
20. 実装完了は自動テストと評価fixtureの合格を条件にする。

---

# 2. 今回の「Rustで実装」の範囲

## Rustで実装する

```text
Acoustic LID preprocessing
Acoustic LID neural inference
logits normalization
temperature calibration
posterior generation
supported-language projection
UNKNOWN / UNSUPPORTED判定
Nova evidence normalization
Evidence Fusion
Online HMM Forward Filtering
SPRT
Hysteresis
language switch state machine
Fixed-lag Viterbi
finalized language timeline
rolling PCM buffer
inference cadence
backpressure判断
state serialization
metrics calculation
```

## Rustで実装しない

```text
Silero VAD
React UI
Web Audio / AudioWorklet transport
Cloudflare Worker routing
Workers AI Nova-3自体
Cloudflare Container lifecycle orchestration
D3 visualization
IndexedDB UI persistence
```

TypeScriptは**transport / UI / orchestration**のみ。

---

# 3. STT

採用:

```text
Cloudflare Workers AI
@cf/deepgram/nova-3
Real-time WebSocket
language=multi
```

概念:

```ts
await env.AI.run(
  "@cf/deepgram/nova-3",
  {
    encoding: "linear16",
    sample_rate: 16000,
    language: "multi",
    interim_results: true,
  },
  { websocket: true },
);
```

実際のCloudflare API型に合わせること。

## 禁止

```text
Browser -> api.deepgram.com
DEEPGRAM_API_KEY
Deepgram temporary token
self-hosted Nova-3
```

---

# 4. Nova-3のlanguage evidence

Workers AI Nova-3の公開仕様だけを根拠に、未確認fieldを固定仕様にしない。

初期実装時に `language=multi` の実WebSocketレスポンスをfixtureとして保存し、以下を確認する。

```text
detected language field
channel-level language
word-level language
language confidence
words[]
interim時のfield
final時のfield
```

## 重要

`word.confidence` が存在しても、それはtranscription confidenceであり、

```text
P(language=en)
```

とは扱わない。

Rust engine側のNova入力はoptionalにする。

```rust
pub struct NovaEvidence {
    pub timestamp_ms: f64,
    pub is_final: bool,
    pub language_scores: Vec<LanguageScore>,
    pub quality: f32,
}
```

Workers AIから十分なlanguage evidenceが取得できない場合:

```text
Acoustic LID
  ↓
HMM + SPRT + Hysteresis
```

だけでも動作すること。

---

# 5. Acoustic LIDモデル

第一baseline:

```text
speechbrain/lang-id-voxlingua107-ecapa
```

ただし、モデル名をarchitectureへ焼き込まない。

Rust trait:

```rust
pub trait AcousticLanguageModel {
    fn model_id(&self) -> &str;
    fn sample_rate(&self) -> u32;
    fn infer(&mut self, pcm: &[f32]) -> Result<LanguageLogits, LidError>;
}
```

将来:

```text
SpeechBrain ECAPA
PearlNet
app-specific fine-tuned model
```

を交換可能にする。

---

# 6. Rust NN runtime

第一候補:

```text
tract
```

理由:

- pure Rust
- ONNX / NNEF対応
- native CPU実行可能
- wasm targetで利用可能
- Cloudflare Containerとbrowser WASMで同じRust inference codeを共有しやすい

## 使用しない

初期production runtimeでは以下を使わない。

```text
onnxruntime-web
JavaScript NN implementation
Python SpeechBrain runtime
Python PyTorch server
native ONNX Runtimeだけに依存する設計
```

native ORTだけを使うとbrowser WASMとsource of truthが分かれるため採用しない。

---

# 7. モデルbuild pipeline

production runtimeでONNX parserを必ず持つ必要はない。

推奨:

```text
SpeechBrain checkpoint
      ↓
Python export tooling
      ↓
ONNX
      ↓
tract CLI validation
      ↓
tract optimized model
      ↓
NNEF / tract OPL
      ↓
versioned inference asset
```

目標はruntimeを、

```text
tract-core
tract-nnef
必要なtract OPL crates
```

へ絞ること。

これによりブラウザWASMサイズを抑える。

---

# 8. Export tooling

追加候補:

```text
scripts/lid/
  export-speechbrain-ecapa.py
  convert-ecapa-to-nnef.sh
  verify-ecapa-reference.py
  generate-lid-manifest.py
```

Pythonはこの工程のみ使用可能。

## parity verification

少なくともfixtureに対して、

```text
SpeechBrain reference logits
vs
Rust tract logits
```

を比較する。

検証:

```text
top-1一致率
top-k一致
logit最大誤差
posterior KL divergence
```

許容値をdocument化する。

---

# 9. Rust crate構成

新規候補:

```text
crates/
  language-harness-core/
    Cargo.toml
    src/
      lib.rs
      language.rs
      observation.rs
      calibration.rs
      evidence.rs
      hmm.rs
      sprt.rs
      hysteresis.rs
      viterbi.rs
      tracker.rs
      timeline.rs
      metrics.rs

  acoustic-lid/
    Cargo.toml
    src/
      lib.rs
      model.rs
      ecapa.rs
      preprocess.rs
      posterior.rs
      ring_buffer.rs
      engine.rs

  language-harness-wasm/
    Cargo.toml
    src/lib.rs
```

可能なら:

```text
language-harness-core
```

はmodel runtimeへ依存させない。

依存関係:

```text
acoustic-lid
  -> language-harness-core

language-harness-wasm
  -> acoustic-lid
  -> language-harness-core

Cloudflare native inference binary
  -> acoustic-lid
  -> language-harness-core
```

---

# 10. Rust engineのtop-level API

```rust
pub struct LanguageHarnessEngine {
    acoustic: AcousticLidEngine,
    tracker: LanguageTracker,
}

impl LanguageHarnessEngine {
    pub fn push_audio(
        &mut self,
        frame: AudioFrame<'_>,
        vad: VadObservation,
    ) -> Result<Option<LanguageHarnessUpdate>, EngineError>;

    pub fn push_nova(
        &mut self,
        observation: NovaEvidence,
    ) -> Result<LanguageHarnessUpdate, EngineError>;

    pub fn current_state(&self) -> &LanguageHarnessState;

    pub fn finalized_segments(&self) -> &[FinalizedLanguageSegment];

    pub fn reset(&mut self);
}
```

Cloudflare版とbrowser版でこのAPI semanticsを揃える。

---

# 11. VADとの境界

VADは既存browser Silero。

Rust engineへ渡す:

```rust
pub struct VadObservation {
    pub is_speech: bool,
    pub speech_probability: f32,
}
```

Rust側はVADモデルを実行しない。

ただしRust側で、

```text
minimum speech coverage
window内のvoiced比率
silence時のevidence decay
```

は計算する。

---

# 12. Acoustic rolling inference

初期候補:

```text
minimum voiced context: 1.0〜1.5 sec
preferred model window: 約3 sec
hop: 約500 ms
```

これらはモデル入力cadence。

言語switchの固定秒数条件ではない。

Rust `AcousticLidEngine` がring bufferを所有する。

```text
push PCM
  ↓
Rust ring buffer
  ↓
VAD speech coverage
  ↓
inference due?
  ↓ yes
tract model
  ↓
logits
  ↓
calibration
  ↓
posterior
```

TypeScript側で3秒windowを作らない。

Cloudflare版とbrowser版のwindow semanticsを一致させるため、buffer/cadenceをRustに置く。

---

# 13. Cloudflare初期実装

## 13.1 Acoustic LID実行先

**Cloudflare Worker内WASMを初期実行先にしない。**

初期版:

```text
Private Cloudflare Container
  ↓
native Rust binary
  ↓
tract
  ↓
Acoustic LID + Language Harness Engine
```

理由:

- Cloudflare Workerは128MB memory
- Worker bundle size制約がある
- Workerはthreading不可
- FP32 ECAPA + runtime + intermediate tensorsをWorkerへ無理に入れる必要がない
- native Rustの方が初期性能検証を行いやすい

Worker WASMでの実行は別途benchmark後のoptional optimizationとする。

---

# 14. Cloudflare Container

新規候補:

```text
apps/language-id-container/
  Cargo.toml
  Dockerfile
  src/
    main.rs
    protocol.rs
    session.rs
    metrics.rs
```

または既存repoのContainer配置規約に合わせる。

## private

Containerにpublic routeを作らない。

```text
Browser
  X-> Container

Browser
  -> Cloudflare Worker
     -> private Container binding
```

---

# 15. 既存Container資産の流用

`apps/zenz-container` の以下の考え方を流用する。

```text
private Container
service binding
warm-up
explicit release
idle destroy
scale to zero
bounded timeout
privacy-safe metrics
model hash verification
minimal image
```

language-id用に過剰な仕組みをコピーしない。

CRIU等は今回の初期スコープ外。

---

# 16. Container lifecycle

録音開始:

```text
Browser Start
  ↓
Worker /warm
  ↓
language-id-container start
  ↓
model load
  ↓
warm inference
```

録音停止:

```text
Browser Stop
  ↓
Worker release
  ↓
Container destroy
```

ネットワーク断対策:

```text
idle expiration
```

も設定する。

cold startを最初の発話に載せない。

---

# 17. Container compute tier

最初からtierを固定しない。

少なくとも、

```text
basic
standard class
```

をbenchmarkする。

比較:

```text
container readiness
model load
first inference
warm inference p50/p95
memory RSS
billed duration
```

最も低コストでhop intervalを安定して満たすtierをdefaultにする。

---

# 18. Cloudflare realtime data flow

```text
Browser
  │
  │ binary PCM + VAD metadata
  ▼
Cloudflare Worker
  │
  ├─────────────────────────────┐
  │                             │
  ▼                             ▼
Workers AI Nova-3       Language ID Container
language=multi          native Rust
  │                             │
  │ transcript /               │ acoustic posterior
  │ available LID evidence      │
  │                             │
  └──────────────┬──────────────┘
                 ▼
           Rust Harness Engine
                 │
                 ▼
          LanguageHarnessState
                 │
                 ▼
              Browser
```

実装方法として、Harness Engine全体をContainerへ置く。

WorkerはNova resultもContainerへ渡す。

これにより初期版では、

**VAD以外の新規推論・状態推定がすべてRust/native Cloudflare側**

になる。

---

# 19. Container session

Container内部でsession stateをRustで持つ。

```rust
HashMap<SessionId, LanguageHarnessEngine>
```

ただし無制限に持たない。

設定:

```text
max sessions
max session idle
max PCM buffer
max request/frame size
```

session end時に必ずdrop。

---

# 20. Worker → Container protocol

TypeScriptにアルゴリズムを持たせない。

Workerは以下のeventを渡すだけ。

## Audio

```text
POST /v1/session/:id/audio
Content-Type: application/octet-stream

headers:
x-sequence
x-started-at-ms
x-sample-rate
x-vad-is-speech
x-vad-probability
```

Body:

```text
signed PCM16 little endian
```

## Nova

```text
POST /v1/session/:id/nova
Content-Type: application/json
```

## State

```text
GET /v1/session/:id/state
```

## Close

```text
DELETE /v1/session/:id
```

実装時にWebSocket一本化の方が計測上優れるなら変更してよい。

ただしprotocol layerとengineを分離する。

---

# 21. Workers AI Nova-3 realtime

既存batch `workers-ai-asr.ts` は壊さない。

新しいrealtime routeを追加。

候補:

```text
apps/cloudflare-worker-server/src/workers-ai-nova3-realtime.ts
```

Browserは自前Workerへ接続。

WorkerがWorkers AI Nova-3 realtimeへ接続する。

Nova WebSocketはutteranceごとに切断しない。

---

# 22. Evidence Fusion

Rust実装。

基本概念:

```text
Acoustic posterior
+
Nova optional evidence
+
observation quality
↓
fused log evidence
```

式:

```text
E(L)
 = Wa * log(P_acoustic(L) + eps)
 + Wn * log(P_nova(L) + eps)
```

weightはRust config。

TypeScriptで計算しない。

---

# 23. Dynamic weight

Rustで計算。

Acoustic weight低下条件:

```text
speech coverage低
low RMS
clipping
short context
high entropy
model confidence低
```

Nova weight低下条件:

```text
interim
language fieldなし
quality低
短いtokenのみ
language evidenceが割れている
```

---

# 24. Online HMM

Rust実装。

現在言語推定の中心。

```text
P(L_t | x_1:t)
```

をForward update。

過去の全音声を保存して多数決しない。

---

# 25. SPRT

Rust実装。

stable `s` とcandidate `c`:

```text
LLR += log(
  (P(c) + eps)
  /
  (P(s) + eps)
)
```

leaky accumulatorにする。

強い新言語なら早くswitch。

曖昧ならswitchしない。

---

# 26. Hysteresis

Rust実装。

```text
enter threshold
!=
retain threshold
```

にする。

一瞬の揺れで、

```text
ja -> en -> ja -> en
```

とならないこと。

---

# 27. Fixed-lag Viterbi

Rust実装。

用途:

```text
current language
  -> HMM/SPRT/Hysteresis

少し過去のfinal timeline
  -> Fixed-lag Viterbi
```

Viterbiのためにrealtime stateを待たせない。

初期lag候補:

```text
1.5〜2 sec
```

評価で決定。

---

# 28. UNKNOWN / UNSUPPORTED

Rust engineで実装。

## UNKNOWN

```text
posterior flat
entropy high
insufficient voiced samples
Nova/Acoustic severe conflict
bad audio quality
```

## UNSUPPORTED

Acoustic LIDが高confidenceでNova multilingual対象外を検出。

例:

```text
ko=.94
```

なら、

```text
raw_language=ko
stable_language=unsupported
```

とできる。

---

# 29. Rust config

```rust
pub struct LanguageHarnessConfig {
    pub acoustic_window_samples: usize,
    pub acoustic_hop_samples: usize,
    pub min_speech_coverage: f32,

    pub acoustic_weight: f32,
    pub nova_weight: f32,

    pub calibration_temperature: f32,

    pub hmm_self_transition_bias: f32,
    pub unknown_transition_bias: f32,

    pub sprt_upper_threshold: f32,
    pub sprt_lower_threshold: f32,
    pub sprt_decay: f32,

    pub switch_posterior_threshold: f32,
    pub retain_posterior_threshold: f32,

    pub fixed_lag_observations: usize,
}
```

magic numberをTSへ置かない。

---

# 30. Rust serialization

Cloudflare nativeとbrowser WASMで共通のlogical schema。

Rust:

```rust
#[derive(Serialize, Deserialize)]
pub struct LanguageHarnessState {
    pub stable_language: HarnessLanguage,
    pub stable_confidence: f32,
    pub candidate_language: Option<HarnessLanguage>,
    pub candidate_evidence: f32,
    pub posterior: Vec<LanguageScore>,
    pub acoustic_posterior: Vec<LanguageScore>,
    pub last_switch_at_ms: Option<f64>,
}
```

JS用camelCase変換はwrapper layerだけ。

---

# 31. Browser移行用WASM

初期実装時点からCIでWASM buildを通す。

新規:

```text
crates/language-harness-wasm/
```

Target:

```text
wasm32-unknown-unknown
```

API候補:

```text
createEngine(modelBytes, config)
pushAudio(pcm, vad)
pushNova(json)
getState()
reset()
dispose()
```

初期版UIではこれをdefault実行しなくてよい。

**buildできることだけは初期Definition of Doneに含める。**

---

# 32. Browser execution architecture

将来:

```text
Main Thread
  ├─ React
  ├─ AudioWorklet
  └─ Silero VAD

Web Worker
  └─ Rust WASM
       ├─ tract
       ├─ ECAPA
       └─ language harness
```

Acoustic inferenceをmain threadで実行しない。

WASM自体をWeb Workerに置く。

---

# 33. Cloudflare Worker WASM実行

将来option。

`language-harness-core`の軽量部分だけならCloudflare Worker WASMで実行可能。

ただしAcoustic LID本体については、

```text
Worker 128MB memory
single thread
bundle constraints
```

があるため、初期実装では採用しない。

将来、

```text
quantized model
small runtime
measured memory < limit
inference < hop interval
```

を満たした場合のみContainerを省けるか検討する。

---

# 34. Model asset

Cloudflare初期版:

```text
model artifact
  -> Container image layer
```

これを推奨。

理由:

```text
R2 download cold latencyを避ける
checksum固定
deploymentとmodel version一致
```

Browser版:

```text
same model version
same checksum
  -> R2/custom domain/CDN
  -> browser cache
```

Cloudflare/nativeとbrowserでモデルrevisionを揃える。

---

# 35. FP32 / quantization

初期ContainerではまずFP32 baselineを通す。

次にINT8を評価。

INT8採用条件:

```text
accuracy regression acceptable
switch latency not worse
calibration can be re-fit
browser size materially improves
```

最初から量子化結果だけをreferenceにしない。

---

# 36. tract compatibility gate

ECAPAを本採用する前に必須。

## Gate A

```text
SpeechBrain -> ONNX export
```

成功。

## Gate B

```text
tract native load + inference
```

成功。

## Gate C

```text
tract NNEF export/load
```

成功。

## Gate D

```text
wasm32 build
```

成功。

## Gate E

browser fixture inference成功。

この5つを通過してからECAPAを固定する。

---

# 37. tract失敗時

優先順位:

1. SpeechBrain export graphをsimplify
2. unsupported opを別表現へ変換
3. preprocessingをRust手書きへ移す
4. tract NNEF/OPLへbuild-time変換
5. 必要ならmissing opをRust実装
6. tract互換の別Acoustic LIDモデルへ変更

禁止:

```text
browserだけonnxruntime-web
cloudflareだけPython
```

同一Rust implementationを崩さない。

---

# 38. 新Web App

追加:

```text
apps/language-id-lab/
```

既存 `apps/vad-lab` から流用:

```text
microphone controls
Silero VAD
AudioWorklet
capture settings
environment metrics
event-loop diagnostics
IndexedDB
PWA
D3 patterns
```

ただしAcoustic inferenceコードは流用しない。

---

# 39. Frontend構成

```text
apps/language-id-lab/
  src/
    audio/
      audio-pipeline.ts
      pcm-worklet-client.ts
      capture-settings.ts

    vad/
      vad-controller.ts

    cloudflare/
      realtime-client.ts
      protocol.ts

    state/
      session-store.ts

    diagnostics/
      metrics.ts

    components/
      CaptureControls.tsx
      CurrentLanguageCard.tsx
      CandidateLanguageCard.tsx
      PosteriorChart.tsx
      TranscriptPanel.tsx
      LanguageTimeline.tsx
      DiagnosticsPanel.tsx
```

以下は置かない:

```text
hmm.ts
sprt.ts
viterbi.ts
acoustic-lid.ts
calibration.ts
evidence-fusion.ts
```

これらはRust crateに置く。

---

# 40. TypeScriptの責務

許可:

```text
WebSocket transport
audio frame transport
React state
rendering
chart
settings UI
IndexedDB
Cloudflare API client
```

禁止:

```text
language posterior math
HMM
SPRT
hysteresis
Viterbi
Acoustic feature extraction
NN inference
calibration
```

---

# 41. Backpressure

Rust engineでinference cadenceを管理。

Cloudflare Worker transport queueもboundedにする。

原則:

```text
古い未処理Acoustic windowを全部処理しない
最新stateへ追いつくことを優先
```

Rust metrics:

```text
dropped_inference_windows
inference_queue_depth
inference_ms
```

---

# 42. Realtime latency targets

初期目標:

```text
Rust tracker update p95: < 10ms
Acoustic inference p95: acoustic hopより短い
strong ja->en switch p50: < 2.5s
strong ja->en switch p95: < 4.0s
```

固定切替時間ではなく評価SLO。

---

# 43. Cloudflare metrics

最低限:

```text
container cold start
container warm-up
Rust model load
Rust acoustic inference p50/p95
Rust tracker update p50/p95
Worker -> Container latency
Workers AI Nova result latency
switch detection latency
false switch count
memory RSS
```

transcript本文をstructured logへ出さない。

---

# 44. Privacy

デフォルト:

```text
raw audio永続保存なし
transcript observability logなし
Cloudflare Workers AIへSTT audio送信
private ContainerへAcoustic LID audio送信
```

Lab録音を明示enableした場合のみIndexedDBへ保存。

Containerはprivate。

---

# 45. Tests: Rust

## language-harness-core

```text
HMM
SPRT
Hysteresis
Viterbi
UNKNOWN
UNSUPPORTED
state serialization
config validation
```

## acoustic-lid

```text
ring buffer
speech coverage
inference cadence
posterior normalization
calibration
model label map
reference fixture parity
```

---

# 46. Synthetic language tracker tests

## JA sticky

```text
ja .92
ja .90
ja .89
ambiguous
ambiguous
```

期待:

```text
stable=ja
```

## true switch

```text
ja .93
ja .91
en .90
en .94
en .96
```

十分なevidence後にen。

## borrowed word

日本語state中に短いEN evidence。

期待:

switchしない。

## return

```text
ja -> en -> ja
```

適切に二度switch可能。

---

# 47. Integration audio fixtures

最低限:

1. Japanese only
2. English only
3. long Japanese + ambiguous
4. Japanese -> English
5. English -> Japanese
6. Japanese -> English -> Japanese
7. Japanese with English product names
8. English with Japanese proper noun
9. filler
10. numbers
11. silence
12. background noise
13. low volume
14. clipping
15. unsupported language
16. accented English
17. non-native Japanese

---

# 48. Cloudflare/native vs WASM parity test

同じfixtureを、

```text
native Rust
browser WASM Rust
```

の両方で実行。

比較:

```text
top language
posterior
switch sequence
switch observation index
finalized timeline
```

浮動小数点差の許容範囲を定義する。

---

# 49. CI

初期実装から必須。

```text
cargo fmt
cargo clippy
cargo test

native release build

wasm32-unknown-unknown build

language-id-lab typecheck
language-id-lab lint
language-id-lab test

cloudflare-worker-server tests

container image build
```

browser WASMをまだproduction利用しなくても、WASM build failureを許可しない。

---

# 50. Phase 0: baseline

- 現在mainのtestsを通す
- `vad-lab` baseline
- Worker baseline
- Container既存機能baseline

---

# 51. Phase 1: Rust core

最初に音声なしで実装。

```text
language-harness-core
  Evidence
  HMM
  SPRT
  Hysteresis
  Viterbi
```

synthetic testsを完成させる。

---

# 52. Phase 2: Acoustic LID feasibility

```text
SpeechBrain export
  ↓
tract native
  ↓
NNEF
  ↓
WASM build
```

compatibility gateを通す。

このphaseで失敗したままCloudflare integrationへ進まない。

---

# 53. Phase 3: native Rust acoustic engine

`acoustic-lid` crateを実装。

```text
PCM
VAD metadata
rolling buffer
tract inference
posterior
LanguageHarnessEngine
```

local Linux/macOS fixtureでbenchmark。

---

# 54. Phase 4: Cloudflare Container

private `language-id-container`追加。

- model image embedding
- warm-up
- session create
- audio push
- Nova evidence push
- state
- release
- metrics

既存Zenz Container lifecycleを参照。

---

# 55. Phase 5: Workers AI Nova-3 realtime

既存Workerにrealtime route追加。

```text
@cf/deepgram/nova-3
language=multi
```

実response fixtureを取得。

Nova language evidence adapterを決定。

---

# 56. Phase 6: browser -> Cloudflare integration

Browser:

```text
PCM/VAD
 -> Worker
```

Worker:

```text
PCM
 -> Nova
 -> Container

Nova result
 -> Container

Container state
 -> Browser
```

---

# 57. Phase 7: evaluation UI

表示:

```text
stable language
candidate
candidate evidence
Acoustic top-5
fused posterior
Nova evidence
HMM posterior
switch timeline
inference latency
```

---

# 58. Phase 8: calibration

実音声fixtureで調整。

```text
temperature
fusion weights
HMM transitions
SPRT thresholds
hysteresis thresholds
fixed lag
```

default値を評価レポートと共にcommit。

---

# 59. Phase 9: Browser WASM execution

Cloudflare版が完成後。

同一crateをWASMで実行。

```text
PCM/VAD
 -> Web Worker Rust WASM
Nova result
 -> Web Worker Rust WASM
```

Cloudflare ContainerとのA/B切替を実装。

設定:

```text
inferenceLocation:
  cloudflare
  browser
```

初期default:

```text
cloudflare
```

---

# 60. Browser modeで変更してはいけないもの

以下を再実装しない。

```text
HMM
SPRT
Hysteresis
Viterbi
calibration
Acoustic preprocessing
Acoustic model
```

Rust/WASMをそのまま使う。

---

# 61. PR分割

## PR1
Rust `language-harness-core`

## PR2
Rust `acoustic-lid` + tract feasibility + model conversion

## PR3
private Cloudflare language-id Container

## PR4
Workers AI Nova-3 realtime + Worker/Container bridge

## PR5
`language-id-lab` Cloudflare-first UI

## PR6
evaluation/calibration/metrics

## PR7
browser WASM execution backend

---

# 62. Definition of Done: 初期Cloudflare版

- [ ] VADは既存Sileroを流用
- [ ] 新規推論ロジックがRust
- [ ] Acoustic LIDがRust
- [ ] tractでmodel inference
- [ ] HMMがRust
- [ ] SPRTがRust
- [ ] HysteresisがRust
- [ ] ViterbiがRust
- [ ] Cloudflare Workers AI Nova-3 realtime
- [ ] `language=multi`
- [ ] Hosted Deepgramへ直接接続しない
- [ ] private Cloudflare ContainerでRust inference
- [ ] Container warm-upあり
- [ ] Container releaseあり
- [ ] existing batch ASRを壊していない
- [ ] `UNKNOWN`
- [ ] `UNSUPPORTED`
- [ ] fixed-time switch ruleなし
- [ ] false switch metric
- [ ] switch latency metric
- [ ] Acoustic inference p50/p95
- [ ] native Rust tests
- [ ] wasm32 build成功
- [ ] model checksum固定
- [ ] reference parity test
- [ ] privacy-safe logs

---

# 63. Definition of Done: Browser-ready

初期版の時点で以下まで必要。

- [ ] `language-harness-core` がwasm32 build可能
- [ ] `acoustic-lid` がwasm32 build可能
- [ ] tract modelがbrowser WASMでfixture inference可能
- [ ] same model revisionをbrowserからload可能
- [ ] native/WASM parity testあり

production UIでbrowser inferenceを有効化するのは後続phaseでよい。

---

# 64. 厳しい判断ポイント

## 64.1 Full ECAPAをCloudflare Workerへ直接入れない

初期からWorker WASMへ入れると、

```text
128MB
single-thread
bundle/startup
model memory
intermediate tensor memory
```

のリスクが大きい。

Container nativeを先に完成させる。

## 64.2 browser対応を後付け設計にしない

「Cloudflare版完成後にRustへ書き直す」は禁止。

最初からRust crateがnative/WASM portableであること。

## 64.3 ONNX Runtime依存にしない

nativeだけ高速でもbrowserで別runtimeになると結果差・実装差が増える。

`tract` / NNEFを第一候補として一貫させる。

## 64.4 モデル互換性を仮定しない

SpeechBrain ECAPAがtractで確実に動くと仮定して実装を大量に進めない。

最初にcompatibility gateを通す。

## 64.5 TSに「仮のHMM」を作らない

Cloudflare wiringのためのtemporary TypeScript HMMも禁止。

Rust engineができるまでmock observationを使う。

---

# 65. 最終アーキテクチャ

```text
                        ┌──────────────────────────────┐
                        │ Browser                     │
                        │                              │
Microphone ────────────►│ AudioWorklet                 │
                        │      │                       │
                        │      ├── Silero VAD          │
                        │      │                       │
                        │      └── PCM16               │
                        └────────────┬─────────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │ Cloudflare Worker             │
                     │ realtime session orchestration│
                     └───────┬───────────────┬───────┘
                             │               │
                     PCM     │               │ PCM/VAD
                             ▼               ▼
                ┌──────────────────┐   ┌──────────────────────┐
                │ Workers AI       │   │ Private CF Container │
                │ Nova-3           │   │ native Rust          │
                │ language=multi   │   │                      │
                └────────┬─────────┘   │ Acoustic LID/tract   │
                         │             │ Fusion               │
                         │ Nova result │ HMM                  │
                         └────────────►│ SPRT                 │
                                       │ Hysteresis           │
                                       │ Viterbi              │
                                       └──────────┬───────────┘
                                                  │
                                      LanguageHarnessState
                                                  │
                                                  ▼
                                               Browser
```

将来:

```text
Private CF Container
        ↓ replace
Browser Web Worker
        ↓
same Rust crates compiled to WASM
```

Nova-3は引き続きWorkers AI。

---

# 66. Agent向け実装順序

必ずこの順番。

```text
1. language-harness-core Rust
2. synthetic algorithm tests
3. SpeechBrain -> tract compatibility PoC
4. acoustic-lid Rust native
5. wasm32 compile + fixture parity
6. private Cloudflare Container
7. Container warm/release
8. Workers AI Nova-3 realtime
9. Nova actual response schema capture
10. Worker -> Container bridge
11. language-id-lab UI
12. Cloudflare end-to-end evaluation
13. calibration
14. browser WASM backend
```

**3と5を後回しにしないこと。**

この2点を先に確認しないと、Cloudflare版完成後にbrowser portabilityが崩れる危険がある。

---

# 67. 完成時に残すドキュメント

```text
docs/language-id-architecture.md
docs/language-id-model-export.md
docs/language-id-cloudflare-deployment.md
docs/language-id-evaluation.md
docs/language-id-browser-wasm.md
```

evaluation docには必ず、

```text
model revision
model checksum
tract version
native/WASM parity
supported languages
false switch rate
missed switch rate
switch p50/p95
inference p50/p95
container cold/warm latency
memory
```

を記録する。

---

# 68. 最終採用スタック

```text
VAD:
  existing browser Silero

STT:
  Cloudflare Workers AI
  @cf/deepgram/nova-3
  language=multi

Acoustic LID:
  Rust
  SpeechBrain ECAPA baseline
  tract runtime
  NNEF/tract-compatible artifact

Language tracking:
  Rust
  Online HMM
  SPRT
  Hysteresis

History smoothing:
  Rust
  Fixed-lag Viterbi

Initial compute:
  private Cloudflare Container
  native Rust

Future compute:
  Browser Web Worker
  Rust WASM

Frontend:
  React/TypeScript
  orchestration and visualization only
```
