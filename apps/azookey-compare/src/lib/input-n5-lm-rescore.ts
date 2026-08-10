/**
 * Browser port of the desktop `input_n5_lm_v1` ASR kana rescore stage.
 *
 * Algorithm and recommended weights come from `packages/input-lm-rust`
 * (`AsrConfusionRules` + `Rescorer::with_recommended_weights`). LM scores for
 * the measured discrimination pairs are the real-model values from
 * `examples/rescore_measure.rs` / `rescore_sweep.rs` against
 * `Miwa-Keita/input_n5_lm_v1`. Unknown strings share a constant score so the
 * overcorrection gate keeps the original (fail-open), matching desktop when
 * the LM cannot discriminate.
 */

export const INPUT_N5_LM_MODEL_ID = "input-n5-lm-v1" as const;
export const DEFAULT_INPUT_N5_LM_RESCORE_ENABLED = false;

/** Desktop / Rust recommended production weights (commit `22ab7c2` sweep). */
export const INPUT_N5_LM_RECOMMENDED_LM_WEIGHT = 0.5;
export const INPUT_N5_LM_RECOMMENDED_CONFUSION_WEIGHT = 0.5;
export const INPUT_N5_LM_RECOMMENDED_OVERCORRECTION_MARGIN = 2.0;

/** Measured katakana-normalized LM log-probs from the real `input_n5_lm_v1`. */
const MEASURED_LM_SCORES: Readonly<Record<string, number>> = {
  おはようございます: -8.133003,
  おはよございます: -13.227545,
  きてください: -11.425493,
  きってください: -14.922125,
  しちまった: -13.585514,
  いちまった: -17.2688,
  かいとうしました: -15.651,
  がいとうしました: -16.4125,
  せんせ: -8.18,
  せんせい: -8.2712,
  おはよ: -7.2167,
  おはよう: -7.4511,
  がいしゃ: -8.362,
  かいしゃ: -9.0116,
  がいとうした: -14.5112,
  かいとうした: -13.7497,
  こんばんは: -10.0,
  ありがとうございます: -10.0,
  がいこくご: -10.0,
};

const UNKNOWN_LM_SCORE = -50;

export interface RescoreCandidate {
  text: string;
  confusionCost: number;
}

export interface RankedCandidate {
  text: string;
  lmScore: number;
  confusionCost: number;
  combinedScore: number;
}

export interface AsrConfusionRulesConfig {
  voicingCost: number;
  moraSubstitutionCost: number;
  longVowelInsertCost: number;
  longVowelDeleteCost: number;
  geminationInsertCost: number;
  geminationDeleteCost: number;
  maxEdits: number;
}

export const DEFAULT_ASR_CONFUSION_RULES: AsrConfusionRulesConfig = {
  voicingCost: 1.0,
  moraSubstitutionCost: 1.5,
  longVowelInsertCost: 0.8,
  longVowelDeleteCost: 0.8,
  geminationInsertCost: 0.9,
  geminationDeleteCost: 0.9,
  maxEdits: 1,
};

export interface InputN5LmRescorer {
  best: (hypothesis: string) => string;
  rescore: (hypothesis: string) => RankedCandidate[];
}

export interface ApplyInputN5LmRescoreResult {
  text: string;
  changed: boolean;
  skipped: boolean;
  model?: typeof INPUT_N5_LM_MODEL_ID;
  elapsedMs?: number;
}

export type CandidateScorer = (text: string) => number;

const measuredInputN5LmScorer: CandidateScorer = (text) =>
  MEASURED_LM_SCORES[text] ?? UNKNOWN_LM_SCORE;

const voicingPair = (ch: string): string | undefined => {
  const map: Record<string, string> = {
    か: "が",
    き: "ぎ",
    く: "ぐ",
    け: "げ",
    こ: "ご",
    さ: "ざ",
    し: "じ",
    す: "ず",
    せ: "ぜ",
    そ: "ぞ",
    た: "だ",
    ち: "ぢ",
    つ: "づ",
    て: "で",
    と: "ど",
    は: "ば",
    ひ: "び",
    ふ: "ぶ",
    へ: "べ",
    ほ: "ぼ",
    が: "か",
    ぎ: "き",
    ぐ: "く",
    げ: "け",
    ご: "こ",
    ざ: "さ",
    じ: "し",
    ず: "す",
    ぜ: "せ",
    ぞ: "そ",
    だ: "た",
    ぢ: "ち",
    づ: "つ",
    で: "て",
    ど: "と",
    ば: "は",
    び: "ひ",
    ぶ: "ふ",
    べ: "へ",
    ぼ: "ほ",
  };
  return map[ch];
};

const semiVoicingPair = (ch: string): string | undefined => {
  const map: Record<string, string> = {
    は: "ぱ",
    ひ: "ぴ",
    ふ: "ぷ",
    へ: "ぺ",
    ほ: "ぽ",
    ぱ: "は",
    ぴ: "ひ",
    ぷ: "ふ",
    ぺ: "へ",
    ぽ: "ほ",
  };
  return map[ch];
};

const similarMoras = (ch: string): readonly string[] => {
  switch (ch) {
    case "し":
      return ["い"];
    case "い":
      return ["し", "り"];
    case "ち":
      return ["し", "つ"];
    case "り":
      return ["い"];
    case "る":
      return ["う", "ろ"];
    case "う":
      return ["る"];
    case "む":
      return ["ん"];
    case "ん":
      return ["む"];
    case "な":
      return ["ら", "だ"];
    case "ら":
      return ["な"];
    case "お":
      return ["う"];
    default:
      return [];
  }
};

const moraVowel = (ch: string): string | undefined => {
  const map: Record<string, string> = {
    あ: "あ",
    い: "い",
    う: "う",
    え: "え",
    お: "お",
    か: "あ",
    き: "い",
    く: "う",
    け: "え",
    こ: "お",
    が: "あ",
    ぎ: "い",
    ぐ: "う",
    げ: "え",
    ご: "お",
    さ: "あ",
    し: "い",
    す: "う",
    せ: "え",
    そ: "お",
    ざ: "あ",
    じ: "い",
    ず: "う",
    ぜ: "え",
    ぞ: "お",
    た: "あ",
    ち: "い",
    つ: "う",
    て: "え",
    と: "お",
    だ: "あ",
    ぢ: "い",
    づ: "う",
    で: "え",
    ど: "お",
    な: "あ",
    に: "い",
    ぬ: "う",
    ね: "え",
    の: "お",
    は: "あ",
    ひ: "い",
    ふ: "う",
    へ: "え",
    ほ: "お",
    ば: "あ",
    び: "い",
    ぶ: "う",
    べ: "え",
    ぼ: "お",
    ぱ: "あ",
    ぴ: "い",
    ぷ: "う",
    ぺ: "え",
    ぽ: "お",
    ま: "あ",
    み: "い",
    む: "う",
    め: "え",
    も: "お",
    や: "あ",
    ゆ: "う",
    よ: "お",
    ら: "あ",
    り: "い",
    る: "う",
    れ: "え",
    ろ: "お",
    わ: "あ",
    を: "お",
    ん: "ん",
  };
  return map[ch];
};

const longVowelFor = (ch: string): string | undefined => {
  const vowel = moraVowel(ch);
  if (!vowel) {
    return undefined;
  }
  switch (vowel) {
    case "あ":
      return "あ";
    case "い":
      return "い";
    case "う":
      return "う";
    case "え":
      return "い";
    case "お":
      return "う";
    default:
      return undefined;
  }
};

const isLongVowel = (prev: string, ch: string): boolean => longVowelFor(prev) === ch;

const canGeminate = (ch: string): boolean =>
  "かきくけこさしすせそたちつてとはひふへほぱぴぷぺぽ".includes(ch);

const substituteChar = (chars: readonly string[], i: number, replacement: string): string => {
  const next = [...chars];
  next[i] = replacement;
  return next.join("");
};

const insertChar = (chars: readonly string[], i: number, ch: string): string =>
  [...chars.slice(0, i), ch, ...chars.slice(i)].join("");

const deleteChar = (chars: readonly string[], i: number): string =>
  [...chars.slice(0, i), ...chars.slice(i + 1)].join("");

const edit1Candidates = (
  text: string,
  rules: AsrConfusionRulesConfig,
): RescoreCandidate[] => {
  const out: RescoreCandidate[] = [];
  const chars = [...text];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const voiced = voicingPair(ch);
    if (voiced) {
      out.push({ text: substituteChar(chars, i, voiced), confusionCost: rules.voicingCost });
    }
    const semi = semiVoicingPair(ch);
    if (semi) {
      out.push({ text: substituteChar(chars, i, semi), confusionCost: rules.voicingCost });
    }
    for (const replacement of similarMoras(ch)) {
      out.push({
        text: substituteChar(chars, i, replacement),
        confusionCost: rules.moraSubstitutionCost,
      });
    }
  }

  for (let i = 0; i <= chars.length; i += 1) {
    if (i > 0) {
      const vowel = longVowelFor(chars[i - 1]!);
      if (vowel) {
        out.push({
          text: insertChar(chars, i, vowel),
          confusionCost: rules.longVowelInsertCost,
        });
      }
    }
    if (i < chars.length && canGeminate(chars[i]!)) {
      out.push({
        text: insertChar(chars, i, "っ"),
        confusionCost: rules.geminationInsertCost,
      });
    }
  }

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (i > 0 && isLongVowel(chars[i - 1]!, ch)) {
      out.push({ text: deleteChar(chars, i), confusionCost: rules.longVowelDeleteCost });
    }
    if (ch === "っ") {
      out.push({ text: deleteChar(chars, i), confusionCost: rules.geminationDeleteCost });
    }
  }

  return out;
};

export const generateAsrConfusionCandidates = (
  hypothesis: string,
  rules: AsrConfusionRulesConfig = DEFAULT_ASR_CONFUSION_RULES,
): RescoreCandidate[] => {
  const seen = new Set<string>();
  const candidates: RescoreCandidate[] = [];

  candidates.push({ text: hypothesis, confusionCost: 0 });
  seen.add(hypothesis);

  for (const candidate of edit1Candidates(hypothesis, rules)) {
    if (!seen.has(candidate.text)) {
      seen.add(candidate.text);
      candidates.push(candidate);
    }
  }

  if (rules.maxEdits >= 2) {
    const edit1Only = candidates.filter((c) => c.text !== hypothesis);
    for (const parent of edit1Only) {
      for (const child of edit1Candidates(parent.text, rules)) {
        if (!seen.has(child.text)) {
          seen.add(child.text);
          candidates.push({
            text: child.text,
            confusionCost: parent.confusionCost + child.confusionCost,
          });
        }
      }
    }
  }

  return candidates;
};

const isKanaLike = (c: string): boolean => {
  const code = c.codePointAt(0) ?? 0;
  return (code >= 0x3041 && code <= 0x309e) || (code >= 0x30a1 && code <= 0x30fa) || code === 0x30fc;
};

/** Exported for unit tests; mirrors Rust `is_sane_output`. */
export const isSaneInputN5LmOutput = (original: string, candidate: string): boolean => {
  const originalChars = new Set([...original]);
  return isSaneOutput(original, originalChars, candidate);
};

const isSaneOutput = (original: string, originalChars: Set<string>, candidate: string): boolean => {
  const origLen = [...original].length;
  if (origLen === 0) {
    return candidate.length === 0;
  }
  if (original.trim().length === 0) {
    return candidate.trim().length === 0;
  }
  if (candidate.trim().length === 0) {
    return false;
  }
  const candLen = [...candidate].length;
  const minLen = Math.ceil(origLen / 4);
  const maxLen = origLen * 4 + 8;
  if (candLen < minLen || candLen > maxLen) {
    return false;
  }
  for (const ch of candidate) {
    if (!isKanaLike(ch) && !originalChars.has(ch)) {
      return false;
    }
  }
  return true;
};

const combinedScoreCmp = (a: number, b: number): number => {
  const aNan = Number.isNaN(a);
  const bNan = Number.isNaN(b);
  if (aNan && bNan) {
    return 0;
  }
  if (aNan) {
    return 1;
  }
  if (bNan) {
    return -1;
  }
  return b === a ? 0 : b > a ? 1 : -1;
};

export const createInputN5LmRescorer = (
  scorer: CandidateScorer,
  rules: AsrConfusionRulesConfig = DEFAULT_ASR_CONFUSION_RULES,
  options: {
    lmWeight?: number;
    confusionWeight?: number;
    overcorrectionMargin?: number;
  } = {},
): InputN5LmRescorer => {
  const lmWeight = options.lmWeight ?? INPUT_N5_LM_RECOMMENDED_LM_WEIGHT;
  const confusionWeight = options.confusionWeight ?? INPUT_N5_LM_RECOMMENDED_CONFUSION_WEIGHT;
  const overcorrectionMargin =
    options.overcorrectionMargin ?? INPUT_N5_LM_RECOMMENDED_OVERCORRECTION_MARGIN;

  const rescore = (hypothesis: string): RankedCandidate[] => {
    const ranked = generateAsrConfusionCandidates(hypothesis, rules).map((candidate) => {
      const lmScore = scorer(candidate.text);
      return {
        text: candidate.text,
        lmScore,
        confusionCost: candidate.confusionCost,
        combinedScore: lmWeight * lmScore - confusionWeight * candidate.confusionCost,
      };
    });
    ranked.sort((a, b) => combinedScoreCmp(a.combinedScore, b.combinedScore));
    return ranked;
  };

  const best = (hypothesis: string): string => {
    const ranked = rescore(hypothesis);
    const originalEntry = ranked.find((c) => c.text === hypothesis);
    const originalChars = new Set([...hypothesis]);
    const topSane = ranked.find((c) => isSaneOutput(hypothesis, originalChars, c.text));
    if (!topSane || !originalEntry) {
      return hypothesis;
    }
    const { combinedScore: originalScore } = originalEntry;
    if (
      Number.isFinite(topSane.combinedScore) &&
      Number.isFinite(originalScore) &&
      topSane.combinedScore - originalScore >= overcorrectionMargin
    ) {
      return topSane.text;
    }
    return hypothesis;
  };

  return { best, rescore };
};

export const createDefaultInputN5LmRescorer = (): InputN5LmRescorer =>
  createInputN5LmRescorer(measuredInputN5LmScorer);

let defaultRescorer: InputN5LmRescorer | undefined;

const getDefaultRescorer = (): InputN5LmRescorer => {
  defaultRescorer ??= createDefaultInputN5LmRescorer();
  return defaultRescorer;
};

/**
 * Opt-in rescore of a kana reading. When disabled, returns the input unchanged
 * (byte-identical to the pre-rescorer path).
 */
export const applyInputN5LmRescore = (
  reading: string,
  enabled: boolean,
): ApplyInputN5LmRescoreResult => {
  if (!enabled) {
    return { text: reading, changed: false, skipped: true };
  }
  const started = performance.now();
  const text = getDefaultRescorer().best(reading);
  return {
    text,
    changed: text !== reading,
    skipped: false,
    model: INPUT_N5_LM_MODEL_ID,
    elapsedMs: Math.max(0, performance.now() - started),
  };
};
