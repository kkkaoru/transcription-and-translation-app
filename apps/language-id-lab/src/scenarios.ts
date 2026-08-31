// Runs with Bun during build and test.
export type LanguageCode = "ja" | "en" | "unknown" | "unsupported";

export interface PosteriorDistribution {
  ja: number;
  en: number;
  unknown: number;
  unsupported: number;
}

export interface ScenarioFrame {
  atMs: number;
  stableLanguage: LanguageCode;
  candidateLanguage: LanguageCode | null;
  candidateEvidence: number;
  transcript: string;
  acoustic: PosteriorDistribution;
  fused: PosteriorDistribution;
  hmm: PosteriorDistribution;
  quality: number;
  speechCoverage: number;
  latencyMs: number;
}

export interface HarnessScenario {
  id: string;
  label: string;
  description: string;
  expected: string;
  frames: readonly ScenarioFrame[];
}

export interface PosteriorDatum {
  language: LanguageCode;
  probability: number;
}

const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  ja: "Japanese",
  en: "English",
  unknown: "Unknown",
  unsupported: "Unsupported",
};

const DEFAULT_SCENARIO: HarnessScenario = {
  id: "ja-ambiguous",
  label: "JA + ambiguous",
  description: "Long Japanese context followed by short, ambiguous borrowed terms.",
  expected: "Stable language remains Japanese.",
  frames: [
    {
      atMs: 0,
      stableLanguage: "unknown",
      candidateLanguage: "ja",
      candidateEvidence: 0.8,
      transcript: "音声から安定した言語状態を追跡します。",
      acoustic: { ja: 0.74, en: 0.09, unknown: 0.15, unsupported: 0.02 },
      fused: { ja: 0.79, en: 0.08, unknown: 0.11, unsupported: 0.02 },
      hmm: { ja: 0.68, en: 0.07, unknown: 0.23, unsupported: 0.02 },
      quality: 0.86,
      speechCoverage: 0.91,
      latencyMs: 41,
    },
    {
      atMs: 1_500,
      stableLanguage: "ja",
      candidateLanguage: null,
      candidateEvidence: 0,
      transcript: "リアルタイムで現在の言語を判定しています。",
      acoustic: { ja: 0.89, en: 0.04, unknown: 0.05, unsupported: 0.02 },
      fused: { ja: 0.92, en: 0.03, unknown: 0.04, unsupported: 0.01 },
      hmm: { ja: 0.95, en: 0.02, unknown: 0.02, unsupported: 0.01 },
      quality: 0.94,
      speechCoverage: 0.96,
      latencyMs: 37,
    },
    {
      atMs: 3_000,
      stableLanguage: "ja",
      candidateLanguage: "en",
      candidateEvidence: 0.7,
      transcript: "OK、次は AI の結果を確認します。",
      acoustic: { ja: 0.38, en: 0.43, unknown: 0.17, unsupported: 0.02 },
      fused: { ja: 0.49, en: 0.35, unknown: 0.14, unsupported: 0.02 },
      hmm: { ja: 0.84, en: 0.1, unknown: 0.05, unsupported: 0.01 },
      quality: 0.62,
      speechCoverage: 0.58,
      latencyMs: 39,
    },
    {
      atMs: 4_500,
      stableLanguage: "ja",
      candidateLanguage: null,
      candidateEvidence: 0,
      transcript: "短い曖昧発話では言語状態を切り替えません。",
      acoustic: { ja: 0.81, en: 0.08, unknown: 0.09, unsupported: 0.02 },
      fused: { ja: 0.86, en: 0.06, unknown: 0.07, unsupported: 0.01 },
      hmm: { ja: 0.93, en: 0.04, unknown: 0.02, unsupported: 0.01 },
      quality: 0.9,
      speechCoverage: 0.93,
      latencyMs: 36,
    },
  ],
};

export const HARNESS_SCENARIOS: readonly HarnessScenario[] = [
  DEFAULT_SCENARIO,
  {
    id: "ja-en-ja",
    label: "JA → EN → JA",
    description: "Sustained evidence switches in both directions without fixed timers.",
    expected: "Two deliberate switches, no flapping.",
    frames: [
      {
        atMs: 0,
        stableLanguage: "ja",
        candidateLanguage: null,
        candidateEvidence: 0,
        transcript: "最初は日本語で説明します。",
        acoustic: { ja: 0.91, en: 0.03, unknown: 0.05, unsupported: 0.01 },
        fused: { ja: 0.94, en: 0.02, unknown: 0.03, unsupported: 0.01 },
        hmm: { ja: 0.96, en: 0.01, unknown: 0.02, unsupported: 0.01 },
        quality: 0.95,
        speechCoverage: 0.96,
        latencyMs: 35,
      },
      {
        atMs: 1_500,
        stableLanguage: "ja",
        candidateLanguage: "en",
        candidateEvidence: 2.1,
        transcript: "I'm going to explain this system in English.",
        acoustic: { ja: 0.05, en: 0.9, unknown: 0.04, unsupported: 0.01 },
        fused: { ja: 0.04, en: 0.93, unknown: 0.02, unsupported: 0.01 },
        hmm: { ja: 0.42, en: 0.54, unknown: 0.03, unsupported: 0.01 },
        quality: 0.93,
        speechCoverage: 0.97,
        latencyMs: 38,
      },
      {
        atMs: 3_000,
        stableLanguage: "en",
        candidateLanguage: null,
        candidateEvidence: 0,
        transcript: "Strong evidence makes the transition responsive.",
        acoustic: { ja: 0.03, en: 0.93, unknown: 0.03, unsupported: 0.01 },
        fused: { ja: 0.02, en: 0.96, unknown: 0.01, unsupported: 0.01 },
        hmm: { ja: 0.08, en: 0.89, unknown: 0.02, unsupported: 0.01 },
        quality: 0.96,
        speechCoverage: 0.98,
        latencyMs: 34,
      },
      {
        atMs: 4_500,
        stableLanguage: "en",
        candidateLanguage: "ja",
        candidateEvidence: 2.4,
        transcript: "ここから日本語に戻します。",
        acoustic: { ja: 0.92, en: 0.04, unknown: 0.03, unsupported: 0.01 },
        fused: { ja: 0.95, en: 0.03, unknown: 0.01, unsupported: 0.01 },
        hmm: { ja: 0.58, en: 0.38, unknown: 0.03, unsupported: 0.01 },
        quality: 0.95,
        speechCoverage: 0.96,
        latencyMs: 36,
      },
      {
        atMs: 6_000,
        stableLanguage: "ja",
        candidateLanguage: null,
        candidateEvidence: 0,
        transcript: "継続した証拠によって日本語へ復帰しました。",
        acoustic: { ja: 0.94, en: 0.02, unknown: 0.03, unsupported: 0.01 },
        fused: { ja: 0.96, en: 0.01, unknown: 0.02, unsupported: 0.01 },
        hmm: { ja: 0.91, en: 0.06, unknown: 0.02, unsupported: 0.01 },
        quality: 0.96,
        speechCoverage: 0.97,
        latencyMs: 33,
      },
    ],
  },
  {
    id: "unsupported",
    label: "Unsupported",
    description: "High-confidence Korean evidence remains distinct from supported languages.",
    expected: "Stable language becomes unsupported, never forced to JA or EN.",
    frames: [
      {
        atMs: 0,
        stableLanguage: "unknown",
        candidateLanguage: null,
        candidateEvidence: 0,
        transcript: "Awaiting enough voiced context…",
        acoustic: { ja: 0.08, en: 0.07, unknown: 0.81, unsupported: 0.04 },
        fused: { ja: 0.07, en: 0.06, unknown: 0.83, unsupported: 0.04 },
        hmm: { ja: 0.05, en: 0.05, unknown: 0.87, unsupported: 0.03 },
        quality: 0.31,
        speechCoverage: 0.27,
        latencyMs: 42,
      },
      {
        atMs: 1_500,
        stableLanguage: "unknown",
        candidateLanguage: "unsupported",
        candidateEvidence: 1.9,
        transcript: "지원되지 않는 언어 증거를 감지했습니다.",
        acoustic: { ja: 0.02, en: 0.02, unknown: 0.02, unsupported: 0.94 },
        fused: { ja: 0.02, en: 0.02, unknown: 0.03, unsupported: 0.93 },
        hmm: { ja: 0.03, en: 0.03, unknown: 0.39, unsupported: 0.55 },
        quality: 0.92,
        speechCoverage: 0.94,
        latencyMs: 39,
      },
      {
        atMs: 3_000,
        stableLanguage: "unsupported",
        candidateLanguage: null,
        candidateEvidence: 0,
        transcript: "언어를 가장 가까운 지원 언어로 강제하지 않습니다.",
        acoustic: { ja: 0.01, en: 0.01, unknown: 0.02, unsupported: 0.96 },
        fused: { ja: 0.01, en: 0.01, unknown: 0.02, unsupported: 0.96 },
        hmm: { ja: 0.01, en: 0.01, unknown: 0.05, unsupported: 0.93 },
        quality: 0.95,
        speechCoverage: 0.96,
        latencyMs: 37,
      },
    ],
  },
];

export const scenarioById = (id: string): HarnessScenario =>
  HARNESS_SCENARIOS.find((scenario) => scenario.id === id) ?? DEFAULT_SCENARIO;

export const frameForElapsed = (scenario: HarnessScenario, elapsedMs: number): ScenarioFrame => {
  const duration = scenario.frames.at(-1)?.atMs ?? 0;
  const loopedMs = duration === 0 ? 0 : elapsedMs % (duration + 1_500);
  return (
    scenario.frames.filter((frame) => frame.atMs <= loopedMs).at(-1) ??
    scenario.frames[0] ?? {
      atMs: 0,
      stableLanguage: "unknown",
      candidateLanguage: null,
      candidateEvidence: 0,
      transcript: "No scenario observations are available.",
      acoustic: { ja: 0, en: 0, unknown: 1, unsupported: 0 },
      fused: { ja: 0, en: 0, unknown: 1, unsupported: 0 },
      hmm: { ja: 0, en: 0, unknown: 1, unsupported: 0 },
      quality: 0,
      speechCoverage: 0,
      latencyMs: 0,
    }
  );
};

export const posteriorData = (distribution: PosteriorDistribution): readonly PosteriorDatum[] => [
  { language: "ja", probability: distribution.ja },
  { language: "en", probability: distribution.en },
  { language: "unknown", probability: distribution.unknown },
  { language: "unsupported", probability: distribution.unsupported },
];

export const languageLabel = (language: LanguageCode): string => LANGUAGE_LABELS[language];
