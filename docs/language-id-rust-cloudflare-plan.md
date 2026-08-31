# Realtime Multilingual Language Harness Web App 実装計画書
## Rust inference / Cloudflare-first 版

> 2026-08-31 implementation update: Phase 1の `language-harness-core` を同PRで実装開始済み。Rust coreにはfixed tracker tick、Online HMM、sequential observation LLR、hysteresis、Fixed-lag Viterbi、stale observation再利用防止、same-tick coalescing、out-of-order rejection、single-tick LLR clampを実装した。GitHub Actions `Language Harness` gateでは23 tests、Regions 99.60%、Functions 100.00%、Lines 99.79%、`wasm32-unknown-unknown` release buildを確認済み。10,000 logical tracker ticksの性能回帰テストも1秒未満のgateで通過している。Acoustic LID/Cloudflare Container/Nova realtime bridgeは後続Phaseであり、現時点の性能保証はRust tracker coreに限定する。

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
       ├─ sequential switch test
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
     Rust -> wasm32-unknown-unknown
       ↓
     同一 Language Harness Engine
       ├─ Acoustic LID
       ├─ calibration
       ├─ Evidence Fusion
       ├─ HMM
       ├─ sequential switch test
       ├─ Hysteresis
       └─ Viterbi
```

Cloudflare版とブラウザ版でアルゴリズムを二重実装しない。

---

# 1. 最優先ルール

1. VADだけは既存 `apps/vad-lab` のSilero VADを流用する。
2. VAD以外の今回新規追加する推論・状態推定をTypeScript/JavaScriptで実装しない。
3. Acoustic LID、calibration、Evidence Fusion、HMM、sequential switch test、Hysteresis、Fixed-lag ViterbiはRustをsource of truthとする。
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
21. tracker state transitionはprovider event受信回数ではなく固定logical tickで進める。
22. 同じ観測を複数tickへ再利用しない。
23. 1回の極端な外れ値だけでstable languageを切り替えない。
24. 同一tickの高頻度eventはlatest observationへcoalesceする。
25. queue/backpressureはCloudflare Session Coordinator統合時にbounded flow-controlとして実装し、coreで黙って古い異なるtickをdropしない。

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
- Nova socket lifecycle
- Container socket lifecycle
- PCM tee
- sequence/revision fence
- bounded queue / backpressure
- reconnect/reset notification
- privacy-safe metrics

DO内部へHMM/SPRT等の推論ロジックを書かない。

---

# 5. Nova evidence

Workers AI Nova-3の未確認fieldを仕様へ焼き込まない。

実response fixtureで次を確認する。

```text
detected language field
channel-level language
word-level language
language confidence
words[]
interim/final差
```

`word.confidence` が存在してもlanguage probabilityとして扱わない。

Nova evidenceが十分取れなくてもAcoustic LID主体で動く設計にする。

---

# 6. Acoustic LID

第一baseline:

```text
speechbrain/lang-id-voxlingua107-ecapa
```

architectureへモデル名を焼き込まない。

Rust trait:

```rust
pub trait AcousticLanguageModel {
    fn model_id(&self) -> &str;
    fn sample_rate(&self) -> u32;
    fn infer(&mut self, pcm: &[f32]) -> Result<LanguageLogits, LidError>;
}
```

将来PearlNetや専用fine-tuned modelへ交換可能にする。

---

# 7. Rust NN runtime / model portability

第一候補:

```text
tract
```

production runtimeでPython/PyTorch serverや`onnxruntime-web`を使わない。

model pipeline:

```text
SpeechBrain checkpoint
      ↓
Python export tooling
      ↓
ONNX
      ↓
tract native validation
      ↓
NNEF / tract-compatible artifact
      ↓
native Rust / browser WASM
```

compatibility gate:

1. SpeechBrain -> ONNX export
2. tract native inference
3. reference logits parity
4. NNEF load
5. `wasm32-unknown-unknown` build
6. browser fixture inference

失敗時はexport graph simplification -> missing op対応 -> tract互換の別LIDモデルの順で解決する。

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

実装初期は `language-harness-core/src/lib.rs` の単一crateから開始してよい。分割はAPIと挙動が固まってから行う。

---

# 9. Rust engine API

raw event受信とtracker更新を分離する。

Novaは非同期、Acoustic LIDはrolling hopなので、event到着のたびにHMM transitionを進めてはならない。

```rust
pub struct LanguageHarnessEngine { /* ... */ }

impl LanguageHarnessEngine {
    pub fn push_audio(&mut self, frame: AudioFrame<'_>, vad: VadObservation) -> Result<(), EngineError>;
    pub fn push_nova(&mut self, observation: NovaObservation) -> Result<(), EngineError>;
    pub fn advance_to(&mut self, timestamp_ms: f64) -> Result<Vec<LanguageHarnessUpdate>, EngineError>;
    pub fn current_state(&self) -> &LanguageHarnessState;
    pub fn reset(&mut self);
}
```

`push_*` はtimestamped observation cacheを更新し、`advance_to()` が固定tracker tickでstate transitionを行う。

現在実装済みのcoreでは、`Observation` queueをtickごとに一度だけconsumeし、同一tick内はlatest observationへcoalesceする。

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

Nova interim/final event数やscheduler delayでHMM transition回数が増減しないこと。

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

`E_t(L)` は現在tickで追加された観測scoreであり、HMM posteriorとは別に保持する。

---

# 12. Online HMM Forward Filter

固定tracker tickで更新する。

```text
P(L_t | x_1:t)
```

目的:

- 過去stable languageをpriorとして反映
- 曖昧発話でflipしない
- 強い新言語evidenceが続けば追従

過去60秒の単純多数決は禁止。

---

# 13. Sequential switch test

HMM posterior比をさらに累積しない。

HMM posteriorは過去観測を含むため、`log(P_HMM(c)/P_HMM(s))` を再累積するとhistoryを二重計上する。

stable `s` とcandidate `c` ではcurrent tick observationだけを使う。

```text
increment_t = E_t(c) - E_t(s)
LLR_t = LLR_(t-1) + clamp(increment_t, -maxIncrement, +maxIncrement)
```

`maxIncrement` を設け、単一の極端な誤観測1回だけでswitch thresholdを超えないdefaultにする。

switchにはLLR thresholdとHMM candidate posterior thresholdの両方を要求する。

---

# 14. Hysteresis

Rust実装。

```text
switch enter threshold != retain threshold
```

役割:

- HMM: temporal prior
- sequential switch test: new languageの累積新規evidence
- Hysteresis: state境界でflapping防止

---

# 15. Fixed-lag Viterbi

```text
realtime current language
  -> Forward HMM + switch test + Hysteresis

finalized past timeline
  -> Fixed-lag Viterbi
```

Viterbi待ちでrealtime UIをブロックしない。

---

# 16. UNKNOWN / UNSUPPORTED

Acoustic LIDが高confidenceでNova multilingual対象外を検出した場合、対応言語へ無理に丸めない。

例:

```text
raw_language = ko
stable_language = unsupported
```

---

# 17. Container初期実装

初期版:

```text
Private Cloudflare Container
  -> native Rust
  -> tract
  -> Acoustic LID + Language Harness Engine
```

Worker isolateへFP32 ECAPAを最初から押し込まない。

---

# 18. Container routing

同じsessionは必ず同じContainer instanceへsticky routeする。

初期:

```text
language-id-v1-shard-0
```

将来:

```text
stable_hash(session_id) % N
```

requestごとのrandom routingは禁止。

---

# 19. Container transport

realtimeはlong-lived WebSocket。

20〜500ms PCMを毎回HTTP POSTしない。

protocolに最低限含める。

```text
version
sequence
started_at_ms
sample_rate
VAD speech flag/probability
PCM sample count
```

Rust側でduplicate、out-of-order、gap、reconnect resetを明示的に扱う。

---

# 20. Backpressure

NovaとAcoustic LIDを分離する。

```text
PCM -> Nova
  ordered / 原則drop禁止

PCM -> Acoustic LID
  latest-window優先 / 未開始old window drop可

Nova result -> Rust
  timestamp/revision fence

Rust state -> Browser
  latest state coalesce可
  switch event drop禁止
```

Session Coordinator/Container transportはbounded queueを持つ。

core trackerの異なるlogical tickを黙ってdropして品質を変えない。queue overflow時はflow-control/fail-fast/resetを明示する。

---

# 21. Tests / coverage / realtime gates

`language-harness-core` は最低95% coverageをCIで強制する。

現在の実測:

```text
Regions    99.60%
Functions 100.00%
Lines      99.79%
```

Rust stable toolchainではbranch coverage reportを利用しないため、重要branchはbehavior testとして明示する。

現在のテストには少なくとも以下を含む。

- ambiguous evidence retains stable language
- sustained language change switches
- one extreme observation cannot switch alone
- same-tick provider event burst is coalesced
- stale observation is not reused across ticks
- future observation waits for its tick
- out-of-order observation rejection
- low-quality observation ignored
- silence does not accumulate switch evidence
- switch episode expires
- Viterbi smooths one-frame ambiguity
- Viterbi follows sustained change
- `ja -> en -> ja` without flapping
- 10,000 tracker-tick realtime regression guard

CI:

```text
cargo fmt
cargo clippy -D warnings
cargo test
cargo llvm-cov: line/function/region >= 95%
cargo build --target wasm32-unknown-unknown --release
```

performance testの閾値は共有CIでflakyにならない十分な余裕を持たせつつ、500ms tracker cadenceに対して桁違いのheadroomを要求する。

---

# 22. Browser-ready Rust/WASM

初期Cloudflare版の時点から `wasm32-unknown-unknown` buildをCIで通す。

将来Web Worker内で同じRust core/Acoustic modelを利用する。

native/WASMでtop language、posterior、switch sequence、switch tick、finalized timelineのparityを検証する。

---

# 23. Model assets

Containerはmodelをimage layerへ含めることを第一候補にする。

Browserは同一revision/checksumをR2/custom domain等から取得しversioned cacheする。

FP32 reference成立後にINT8を評価する。

---

# 24. Realtime SLO / metrics

初期目標:

```text
Rust tracker update p95       < 10 ms
Acoustic inference p95        < acoustic hop
strong ja -> en switch p50    < 2.5 sec
strong ja -> en switch p95    < 4.0 sec
```

固定switch ruleではなくevaluation SLO。

現時点で検証済みなのはRust tracker coreのみ。Acoustic model inference / Network / Workers AI / Containerを含むend-to-end SLOは統合後に測定し、core単体結果から推測しない。

---

# 25. 実装Phase

1. `language-harness-core` Rust + tests/coverage/performance gate  ← 実装開始済み
2. SpeechBrain ECAPA -> tract compatibility/reference parity PoC
3. `acoustic-lid` Rust native
4. private Cloudflare language-id Container
5. Workers AI Nova-3 realtime adapter + response fixture
6. `LanguageSessionDO` Browser/Nova/Container bridge + bounded backpressure
7. `language-id-lab` Cloudflare-first UI
8. evaluation/calibration
9. browser Rust/WASM backend

---

# 26. Definition of Done: full Cloudflare version

- VAD既存Silero
- new inference/state logic Rust
- Acoustic LID Rust + tract
- HMM/switch test/Hysteresis/Viterbi Rust
- Workers AI Nova-3 realtime `language=multi`
- Hosted Deepgram direct接続なし
- private Cloudflare Container
- session-sticky routing
- long-lived WebSocket
- bounded backpressure
- warm-up/release
- UNKNOWN/UNSUPPORTED
- fixed-time switch ruleなし
- coverage >=95%
- realtime/quality behavioral tests
- model checksum
- native/WASM parity
- privacy-safe logs
- end-to-end latency/false-switch/missed-switch evaluation

---

# 27. Agent向け実装順序

```text
1. Rust tracker core + coverage/quality/realtime gates
2. ECAPA/tract compatibility
3. acoustic-lid Rust
4. native/WASM fixture parity
5. Cloudflare Container
6. Workers AI Nova realtime schema fixture
7. LanguageSessionDO + bounded transport
8. Web UI
9. end-to-end evaluation/calibration
10. browser WASM backend
```

アルゴリズム閾値を感覚だけで決めず、fixtureによるfalse switch、missed switch、switch latencyからdefaultを決定する。
