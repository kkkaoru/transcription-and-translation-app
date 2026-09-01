// Runs with Bun during build and test.

export type UiLocale = "ja" | "en";

export interface UiMessages {
  localeSwitcherLabel: string;
  brandSubtitle: string;
  edgeStatus: string;
  liveInference: string;
  heroEyebrow: string;
  heroTitle: string;
  heroDescription: string;
  stableHeading: string;
  resetInference: string;
  waitingForSpeech: string;
  listening: string;
  processing: string;
  microphoneInput: string;
  defaultMicrophone: string;
  microphoneName: (number: number) => string;
  enableMicrophone: string;
  stopMicrophone: string;
  requestingMicrophone: string;
  microphoneUnavailable: string;
  microphoneFailed: string;
  inputLevel: string;
  speechProbability: string;
  computeTier: string;
  inferenceMethod: string;
  speechbrainBasic: string;
  speechbrainStandard: string;
  ambernetBasic: string;
  ambernetStandard: string;
  workersAiNova: string;
  basic: string;
  standard: string;
  ecapaPattern: string;
  utterancePattern: string;
  rollingPattern: string;
  utteranceDetail: string;
  rollingDetail: string;
  privacyNotice: string;
  actualAudioNotice: string;
  rawPosterior: string;
  hsmmPosterior: string;
  providerPosterior: string;
  confidence: string;
  currentInference: string;
  speechLength: string;
  observationQuality: string;
  inferenceLatency: string;
  diagnostics: string;
  hsmm: string;
  hsmmDuration: string;
  hsmmHazard: string;
  sprt: string;
  sprtCandidate: string;
  sprtLlr: string;
  sprtBounds: string;
  hysteresis: string;
  enterThreshold: string;
  retainThreshold: string;
  stablePosterior: string;
  noCandidate: string;
  containerCost: string;
  workersAiCost: string;
  workersAiSessionEstimate: string;
  workersAiRate: string;
  rustTrackerCost: string;
  combinedSessionEstimate: string;
  actualUsage: string;
  grossResourceCost: string;
  estimatedOverage: string;
  currentSessionRange: string;
  hourlyPrice: string;
  provisioned: string;
  maximumCpu: string;
  usageUnavailable: string;
  refreshUsage: string;
  idleShutdown: string;
  modelCoverage: string;
  unknownLanguage: string;
  voiceTestTitle: string;
  voiceTestDetail: string;
  sourceText: string;
  detectedSourceLanguage: string;
  targetLanguage: string;
  generateVoice: string;
  generatingVoice: string;
  translatedText: string;
  runVoiceInference: string;
  runningVoiceInference: string;
  expectedLanguage: string;
  detectedLanguage: string;
  realtimeDiagram: string;
  realtimeDiagramDetail: string;
  providerDiagnostics: string;
  seconds: (value: string) => string;
  milliseconds: (value: string) => string;
  dollars: (value: string) => string;
  perHour: (value: string) => string;
}

const ENGLISH_MESSAGES: UiMessages = {
  localeSwitcherLabel: "Interface language",
  brandSubtitle: "Language ID Lab",
  edgeStatus: "Cloudflare edge",
  liveInference: "Live Rust inference",
  heroEyebrow: "Realtime multilingual language identification",
  heroTitle: "Speak. See the evidence change.",
  heroDescription:
    "Your voiced segments are sent to a private Cloudflare Container. SpeechBrain ECAPA identifies across 107 languages, while Rust HSMM, SPRT, and hysteresis stabilize the result.",
  stableHeading: "Current stable language",
  resetInference: "Reset language state",
  waitingForSpeech: "Waiting for speech",
  listening: "Listening",
  processing: "Running inference",
  microphoneInput: "Microphone input",
  defaultMicrophone: "Default microphone",
  microphoneName: (number) => `Microphone ${number}`,
  enableMicrophone: "Start microphone",
  stopMicrophone: "Stop and release",
  requestingMicrophone: "Starting…",
  microphoneUnavailable: "This browser does not expose microphone capture.",
  microphoneFailed: "Microphone access failed.",
  inputLevel: "Input level",
  speechProbability: "Speech probability",
  computeTier: "Container tier",
  inferenceMethod: "Identification method",
  speechbrainBasic: "SpeechBrain ECAPA · Basic container",
  speechbrainStandard: "SpeechBrain ECAPA · Standard container",
  ambernetBasic: "NVIDIA LangID AmberNet · Basic container",
  ambernetStandard: "NVIDIA LangID AmberNet · Standard container",
  workersAiNova: "Cloudflare Workers AI · Deepgram Nova-3",
  basic: "Basic",
  standard: "Standard",
  ecapaPattern: "ECAPA input pattern",
  utterancePattern: "Per utterance",
  rollingPattern: "Rolling 6 s context",
  utteranceDetail: "Classify each VAD segment independently.",
  rollingDetail: "Retain up to six seconds of voiced context across short segments.",
  privacyNotice: "Voiced PCM only; no transcript is produced or stored.",
  actualAudioNotice: "Results below come from your microphone, not a fixture.",
  rawPosterior: "Raw model posterior",
  hsmmPosterior: "Rust HSMM posterior",
  providerPosterior: "Workers AI language detection",
  confidence: "confidence",
  currentInference: "Latest voiced segment",
  speechLength: "Speech length",
  observationQuality: "Observation quality",
  inferenceLatency: "Inference latency",
  diagnostics: "State diagnostics",
  hsmm: "HSMM",
  hsmmDuration: "Current duration",
  hsmmHazard: "Transition hazard",
  sprt: "SPRT",
  sprtCandidate: "Candidate",
  sprtLlr: "Current LLR",
  sprtBounds: "Reject / accept",
  hysteresis: "Hysteresis",
  enterThreshold: "Enter threshold",
  retainThreshold: "Retain threshold",
  stablePosterior: "Stable posterior",
  noCandidate: "None",
  containerCost: "Cloudflare Container cost",
  workersAiCost: "Cloudflare Workers AI cost",
  workersAiSessionEstimate: "Current Workers AI audio estimate",
  workersAiRate: "Nova-3 regular HTTP rate",
  rustTrackerCost: "Rust tracker Container estimate",
  combinedSessionEstimate: "Combined current session estimate",
  actualUsage: "Account month-to-date usage estimate",
  grossResourceCost: "Gross resource cost",
  estimatedOverage: "Estimated overage after included usage",
  currentSessionRange: "Current session price range",
  hourlyPrice: "Published hourly price",
  provisioned: "memory + disk",
  maximumCpu: "at 100% allocated CPU",
  usageUnavailable: "Live usage is unavailable",
  refreshUsage: "Refresh usage",
  idleShutdown: "Explicit release on stop; automatic destroy after 30 s idle.",
  modelCoverage: "Selected model",
  unknownLanguage: "Unknown",
  voiceTestTitle: "Translation and synthetic voice check",
  voiceTestDetail:
    "Translate with Workers AI, synthesize with Fish Audio, play the result, then identify it with the selected method.",
  sourceText: "Text to speak",
  detectedSourceLanguage: "Detected text language",
  targetLanguage: "Voice language",
  generateVoice: "Translate and synthesize",
  generatingVoice: "Generating…",
  translatedText: "Translated text",
  runVoiceInference: "Identify this audio",
  runningVoiceInference: "Identifying…",
  expectedLanguage: "Expected",
  detectedLanguage: "Detected",
  realtimeDiagram: "How the live decision evolves",
  realtimeDiagramDetail:
    "D3 renders raw evidence, the HSMM state posterior, and thresholds after every voiced segment.",
  providerDiagnostics:
    "Workers AI evidence is stabilized by the Rust HSMM, two-sided SPRT, and hysteresis tracker.",
  seconds: (value) => `${value} s`,
  milliseconds: (value) => `${value} ms`,
  dollars: (value) => `$${value}`,
  perHour: (value) => `$${value}/h`,
};

const JAPANESE_MESSAGES: UiMessages = {
  localeSwitcherLabel: "表示言語",
  brandSubtitle: "言語IDラボ",
  edgeStatus: "Cloudflare エッジ",
  liveInference: "Rust実推論",
  heroEyebrow: "リアルタイム多言語識別",
  heroTitle: "話す。推論の変化を見る。",
  heroDescription:
    "有声区間をprivate Cloudflare Containerへ送信します。SpeechBrain ECAPAが107言語を識別し、RustのHSMM・SPRT・Hysteresisが結果を安定化します。",
  stableHeading: "現在の安定言語",
  resetInference: "言語認識の状態を初期化",
  waitingForSpeech: "発話待ち",
  listening: "入力中",
  processing: "推論中",
  microphoneInput: "マイク入力",
  defaultMicrophone: "デフォルトのマイク",
  microphoneName: (number) => `マイク ${number}`,
  enableMicrophone: "マイクを開始",
  stopMicrophone: "停止して解放",
  requestingMicrophone: "起動中…",
  microphoneUnavailable: "このブラウザではマイクを利用できません。",
  microphoneFailed: "マイクへのアクセスに失敗しました。",
  inputLevel: "入力レベル",
  speechProbability: "発話確率",
  computeTier: "Container種別",
  inferenceMethod: "言語識別の方法",
  speechbrainBasic: "SpeechBrain ECAPA · Basic container",
  speechbrainStandard: "SpeechBrain ECAPA · Standard container",
  ambernetBasic: "NVIDIA LangID AmberNet · Basic container",
  ambernetStandard: "NVIDIA LangID AmberNet · Standard container",
  workersAiNova: "Cloudflare Workers AI · Deepgram Nova-3",
  basic: "Basic",
  standard: "Standard",
  ecapaPattern: "ECAPA入力パターン",
  utterancePattern: "発話ごと",
  rollingPattern: "直近6秒の文脈",
  utteranceDetail: "VADで区切った発話を個別に識別します。",
  rollingDetail: "短い発話をまたいで最大6秒の有声文脈を維持します。",
  privacyNotice: "有声PCMのみ送信し、文字起こしや音声保存は行いません。",
  actualAudioNotice: "以下はfixtureではなく、マイク入力の実推論結果です。",
  rawPosterior: "モデルの生事後確率",
  hsmmPosterior: "Rust HSMM事後確率",
  providerPosterior: "Workers AI言語検出",
  confidence: "確信度",
  currentInference: "最新の有声区間",
  speechLength: "発話長",
  observationQuality: "観測品質",
  inferenceLatency: "推論レイテンシ",
  diagnostics: "状態診断",
  hsmm: "HSMM",
  hsmmDuration: "現在の継続長",
  hsmmHazard: "遷移ハザード",
  sprt: "SPRT",
  sprtCandidate: "切り替え候補",
  sprtLlr: "現在のLLR",
  sprtBounds: "棄却 / 採択",
  hysteresis: "Hysteresis",
  enterThreshold: "遷移閾値",
  retainThreshold: "維持閾値",
  stablePosterior: "安定言語の事後確率",
  noCandidate: "なし",
  containerCost: "Cloudflare Container費用",
  workersAiCost: "Cloudflare Workers AI費用",
  workersAiSessionEstimate: "現在のWorkers AI音声見積",
  workersAiRate: "Nova-3 通常HTTP単価",
  rustTrackerCost: "Rust tracker Container見積",
  combinedSessionEstimate: "現在セッションの合計見積",
  actualUsage: "アカウント月初来の利用見積",
  grossResourceCost: "リソース総額",
  estimatedOverage: "無料枠適用後の超過見積",
  currentSessionRange: "現在セッションの価格範囲",
  hourlyPrice: "公開時間単価",
  provisioned: "メモリ + ディスク",
  maximumCpu: "割当CPU 100%時",
  usageUnavailable: "実利用量を取得できません",
  refreshUsage: "利用量を更新",
  idleShutdown: "停止時に明示解放し、無操作30秒後にも自動destroyします。",
  modelCoverage: "選択中のモデル",
  unknownLanguage: "不明",
  voiceTestTitle: "翻訳・合成音声による動作確認",
  voiceTestDetail:
    "Workers AIで翻訳し、Fish Audioで音声を合成・再生した後、選択中の方法で言語を識別します。",
  sourceText: "読み上げるテキスト",
  detectedSourceLanguage: "自動判別したテキスト言語",
  targetLanguage: "合成音声の言語",
  generateVoice: "翻訳して音声を生成",
  generatingVoice: "生成中…",
  translatedText: "翻訳結果",
  runVoiceInference: "この音声を言語識別",
  runningVoiceInference: "識別中…",
  expectedLanguage: "期待言語",
  detectedLanguage: "識別結果",
  realtimeDiagram: "リアルタイム判定の仕組み",
  realtimeDiagramDetail: "有声区間ごとに、生の証拠・HSMM状態事後確率・判定閾値をD3で描画します。",
  providerDiagnostics: "Workers AIの証拠をRustのHSMM・両側SPRT・Hysteresis trackerで安定化します。",
  seconds: (value) => `${value}秒`,
  milliseconds: (value) => `${value} ms`,
  dollars: (value) => `$${value}`,
  perHour: (value) => `$${value}/時`,
};

export const messagesFor = (locale: UiLocale): UiMessages =>
  locale === "ja" ? JAPANESE_MESSAGES : ENGLISH_MESSAGES;

export const isUiLocale = (value: string | null): value is UiLocale =>
  value === "ja" || value === "en";

export const preferredUiLocale = (browserLanguage: string): UiLocale =>
  browserLanguage.toLowerCase().startsWith("ja") ? "ja" : "en";

export const displayLanguageName = (code: string, locale: UiLocale): string => {
  if (code === "unknown") return messagesFor(locale).unknownLanguage;
  const displayNames = new Intl.DisplayNames([locale], { type: "language" });
  return displayNames.of(code) ?? code.toUpperCase();
};
