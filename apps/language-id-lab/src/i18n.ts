// Runs with Bun during build and test.
import type { LanguageCode } from "./scenarios";

export type UiLocale = "ja" | "en";

export interface ScenarioCopy {
  label: string;
  description: string;
  expected: string;
}

export interface UiMessages {
  localeSwitcherLabel: string;
  brandSubtitle: string;
  edgeStatus: string;
  syntheticEvidence: string;
  heroEyebrow: string;
  heroTitleFirst: string;
  heroTitleSecond: string;
  heroDescription: string;
  stableHeading: string;
  syntheticRunning: string;
  syntheticPaused: string;
  switchCandidate: string;
  noActiveCandidate: string;
  llrLabel: string;
  microphoneInput: string;
  defaultMicrophone: string;
  microphoneName: (number: number) => string;
  enableMicrophone: string;
  stopMicrophone: string;
  requestingMicrophone: string;
  microphoneUnavailable: string;
  microphoneFailed: string;
  privateByDefault: string;
  audioNotUploaded: string;
  scenariosEyebrow: string;
  scenariosHeading: string;
  runScenario: string;
  pauseRun: string;
  resumeRun: string;
  runAgain: string;
  scenarioTabsLabel: string;
  sampledSeconds: (seconds: string) => string;
  syntheticTranscript: string;
  revision: (number: number) => string;
  timelineLabel: string;
  rawAcoustic: string;
  modelPosterior: string;
  fusedEvidence: string;
  fusedEvidenceEyebrow: string;
  onlineHmm: string;
  realtimeTracker: string;
  fixtureStatus: string;
  diagnosticsEyebrow: string;
  diagnosticsHeading: string;
  rustSourceOfTruth: string;
  observationQuality: string;
  calibratedInput: string;
  speechCoverage: string;
  voicedContext: string;
  trackerUpdate: string;
  simulatedEndToEnd: string;
  pendingQueue: string;
  boundedTicks: string;
  backpressure: string;
  explicitEvents: string;
  transport: string;
  ready: string;
  cloudflareWorker: string;
  footerProduct: string;
  footerMilestone: string;
  languageNames: Record<LanguageCode, string>;
  scenarios: Record<string, ScenarioCopy>;
}

const ENGLISH_MESSAGES: UiMessages = {
  localeSwitcherLabel: "Interface language",
  brandSubtitle: "Language Harness",
  edgeStatus: "Cloudflare edge",
  syntheticEvidence: "Synthetic evidence",
  heroEyebrow: "Realtime multilingual state",
  heroTitleFirst: "Track the language.",
  heroTitleSecond: "Keep the context.",
  heroDescription:
    "A live observability surface for the Rust language harness. Inspect stable state, switching evidence, posterior layers, and transport health without turning a borrowed word into a false language switch.",
  stableHeading: "Current stable language",
  syntheticRunning: "synthetic running",
  syntheticPaused: "synthetic paused",
  switchCandidate: "Switch candidate",
  noActiveCandidate: "No active candidate",
  llrLabel: "LLR",
  microphoneInput: "Microphone input",
  defaultMicrophone: "Default microphone",
  microphoneName: (number) => `Microphone ${number}`,
  enableMicrophone: "Enable microphone",
  stopMicrophone: "Stop microphone",
  requestingMicrophone: "Requesting…",
  microphoneUnavailable: "This browser does not expose microphone capture.",
  microphoneFailed: "Microphone access failed.",
  privateByDefault: "Private by default",
  audioNotUploaded: "Audio is not uploaded in this UI milestone.",
  scenariosEyebrow: "Verification scenarios",
  scenariosHeading: "Exercise the state surface",
  runScenario: "Run scenario",
  pauseRun: "Pause run",
  resumeRun: "Resume run",
  runAgain: "Run again",
  scenarioTabsLabel: "Harness scenarios",
  sampledSeconds: (seconds) => `${seconds}s sampled`,
  syntheticTranscript: "Synthetic transcript",
  revision: (number) => `revision ${number}`,
  timelineLabel: "Language switch timeline",
  rawAcoustic: "Raw acoustic",
  modelPosterior: "Model posterior",
  fusedEvidence: "Fused evidence",
  fusedEvidenceEyebrow: "Acoustic + optional Nova",
  onlineHmm: "Online HMM",
  realtimeTracker: "Realtime tracker",
  fixtureStatus: "fixture",
  diagnosticsEyebrow: "Runtime diagnostics",
  diagnosticsHeading: "Bounded, observable, privacy-safe",
  rustSourceOfTruth: "Rust source of truth",
  observationQuality: "Observation quality",
  calibratedInput: "calibrated input",
  speechCoverage: "Speech coverage",
  voicedContext: "voiced context",
  trackerUpdate: "Tracker update",
  simulatedEndToEnd: "simulated end-to-end",
  pendingQueue: "Pending queue",
  boundedTicks: "bounded ticks",
  backpressure: "Backpressure",
  explicitEvents: "explicit events",
  transport: "Transport",
  ready: "Ready",
  cloudflareWorker: "Cloudflare Worker",
  footerProduct: "Kotoba Beacon · Language ID Lab",
  footerMilestone: "UI milestone · inference bridge pending",
  languageNames: {
    ja: "Japanese",
    en: "English",
    unknown: "Unknown",
    unsupported: "Unsupported",
  },
  scenarios: {
    "ja-ambiguous": {
      label: "JA + ambiguous",
      description: "Long Japanese context followed by short, ambiguous borrowed terms.",
      expected: "Stable language remains Japanese.",
    },
    "ja-en-ja": {
      label: "JA → EN → JA",
      description: "Sustained evidence switches in both directions without fixed timers.",
      expected: "Two deliberate switches, no flapping.",
    },
    unsupported: {
      label: "Unsupported",
      description: "High-confidence Korean evidence remains distinct from supported languages.",
      expected: "Never forced to JA or EN.",
    },
  },
};

const JAPANESE_MESSAGES: UiMessages = {
  localeSwitcherLabel: "表示言語",
  brandSubtitle: "言語ハーネス",
  edgeStatus: "Cloudflare エッジ",
  syntheticEvidence: "合成エビデンス",
  heroEyebrow: "リアルタイム多言語状態",
  heroTitleFirst: "言語を捉える。",
  heroTitleSecond: "文脈を保つ。",
  heroDescription:
    "Rust言語ハーネスの可観測性画面です。借用語を誤った言語切り替えにせず、安定状態、切り替えエビデンス、事後確率、通信状態を確認できます。",
  stableHeading: "現在の安定言語",
  syntheticRunning: "合成シナリオ実行中",
  syntheticPaused: "合成シナリオ停止中",
  switchCandidate: "切り替え候補",
  noActiveCandidate: "候補なし",
  llrLabel: "LLR",
  microphoneInput: "マイク入力",
  defaultMicrophone: "デフォルトのマイク",
  microphoneName: (number) => `マイク ${number}`,
  enableMicrophone: "マイクを有効化",
  stopMicrophone: "マイクを停止",
  requestingMicrophone: "許可を確認中…",
  microphoneUnavailable: "このブラウザではマイクを利用できません。",
  microphoneFailed: "マイクへのアクセスに失敗しました。",
  privateByDefault: "プライバシーを優先",
  audioNotUploaded: "このUIマイルストーンでは音声をアップロードしません。",
  scenariosEyebrow: "検証シナリオ",
  scenariosHeading: "言語状態の表示を検証",
  runScenario: "シナリオを実行",
  pauseRun: "一時停止",
  resumeRun: "再開",
  runAgain: "もう一度実行",
  scenarioTabsLabel: "ハーネス検証シナリオ",
  sampledSeconds: (seconds) => `${seconds}秒を表示`,
  syntheticTranscript: "合成トランスクリプト",
  revision: (number) => `リビジョン ${number}`,
  timelineLabel: "言語切り替えタイムライン",
  rawAcoustic: "音響モデル出力",
  modelPosterior: "モデル事後確率",
  fusedEvidence: "統合エビデンス",
  fusedEvidenceEyebrow: "音響 + 任意のNova",
  onlineHmm: "オンラインHMM",
  realtimeTracker: "リアルタイムトラッカー",
  fixtureStatus: "フィクスチャ",
  diagnosticsEyebrow: "ランタイム診断",
  diagnosticsHeading: "上限付き・観測可能・プライバシー保護",
  rustSourceOfTruth: "Rustがsource of truth",
  observationQuality: "観測品質",
  calibratedInput: "較正済み入力",
  speechCoverage: "発話カバレッジ",
  voicedContext: "有声区間の文脈",
  trackerUpdate: "トラッカー更新",
  simulatedEndToEnd: "合成E2E",
  pendingQueue: "待機キュー",
  boundedTicks: "上限付きtick",
  backpressure: "バックプレッシャー",
  explicitEvents: "明示イベント",
  transport: "通信",
  ready: "準備完了",
  cloudflareWorker: "Cloudflare Worker",
  footerProduct: "Kotoba Beacon · 言語IDラボ",
  footerMilestone: "UIマイルストーン · 推論ブリッジ未接続",
  languageNames: {
    ja: "日本語",
    en: "英語",
    unknown: "不明",
    unsupported: "未対応言語",
  },
  scenarios: {
    "ja-ambiguous": {
      label: "日本語 + 曖昧語",
      description: "長い日本語の文脈に、短く曖昧な借用語が続くケースです。",
      expected: "安定言語は日本語を維持します。",
    },
    "ja-en-ja": {
      label: "日本語 → 英語 → 日本語",
      description: "固定タイマーではなく、継続したエビデンスで双方向に切り替えます。",
      expected: "フラッピングせず2回切り替わります。",
    },
    unsupported: {
      label: "未対応言語",
      description: "確信度の高い韓国語エビデンスを対応言語と区別します。",
      expected: "日本語や英語へ強制しません。",
    },
  },
};

export const messagesFor = (locale: UiLocale): UiMessages =>
  locale === "ja" ? JAPANESE_MESSAGES : ENGLISH_MESSAGES;

export const isUiLocale = (value: string | null): value is UiLocale =>
  value === "ja" || value === "en";

export const preferredUiLocale = (browserLanguage: string): UiLocale =>
  browserLanguage.toLowerCase().startsWith("ja") ? "ja" : "en";
