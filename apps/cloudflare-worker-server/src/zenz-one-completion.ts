export const ZENZ_CONTEXT_MAX_GRAPHEMES = 40;
export const ZENZ_ONE_COMPLETION_MAX_ITERATIONS = 10;
export const ZENZ_INPUT_TAG = "\u{EE00}";
export const ZENZ_OUTPUT_TAG = "\u{EE01}";
export const ZENZ_LEFT_CONTEXT_TAG = "\u{EE02}";

export type ZenzPrefixDecision = "verified" | "fallback";

export interface ZenzOneCompletionSearch {
  searchOutputPrefix: (prefix: Uint8Array) => string | undefined;
}

export interface ZenzOneCompletionRequest {
  input: string;
  leftContext: string;
  baseline: string;
  completion: string;
  search: ZenzOneCompletionSearch;
  maxIterations?: number;
  remainingMs?: () => number;
}

export interface ZenzOneCompletionResult {
  text: string;
  iterations: number;
  /** True when this call inspected `completion`, even if the text stayed the baseline. */
  usedCompletion: boolean;
}

const encoder = new TextEncoder();

const toKatakana = (input: string): string =>
  input.replace(/[\u3041-\u3096]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x60),
  );

const graphemesOf = (input: string): string[] => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(input)].map(
      (segment) => segment.segment,
    );
  }
  return [...input];
};

export const trimZenzLeftContext = (
  leftContext: string,
  maxGraphemes = ZENZ_CONTEXT_MAX_GRAPHEMES,
): string => {
  const graphemes = graphemesOf(leftContext.trim());
  if (graphemes.length <= maxGraphemes) {
    return graphemes.join("");
  }
  return graphemes.slice(graphemes.length - maxGraphemes).join("");
};

export const zenzCandidatePrompt = (input: string, leftContext = ""): string => {
  const trimmedLeft = trimZenzLeftContext(leftContext);
  if (trimmedLeft.length === 0) {
    return `${ZENZ_INPUT_TAG}${toKatakana(input)}${ZENZ_OUTPUT_TAG}`;
  }
  return `${ZENZ_LEFT_CONTEXT_TAG}${trimmedLeft}${ZENZ_INPUT_TAG}${toKatakana(input)}${ZENZ_OUTPUT_TAG}`;
};

export const nextOutputPrefix = (
  candidate: string,
  completion: string,
): Uint8Array | ZenzPrefixDecision => {
  const candidateScalars = [...candidate];
  const completionScalars = [...completion];
  const shared = Math.min(candidateScalars.length, completionScalars.length);
  let common = 0;
  while (common < shared && candidateScalars[common] === completionScalars[common]) {
    common += 1;
  }
  if (common === candidateScalars.length && common === completionScalars.length) {
    return "verified";
  }
  const nextScalar = completionScalars[common];
  if (nextScalar === undefined) {
    return "fallback";
  }
  return encoder.encode(completionScalars.slice(0, common + 1).join(""));
};

export const orchestrateOneCompletion = (
  request: ZenzOneCompletionRequest,
): ZenzOneCompletionResult => {
  const maxIterations = request.maxIterations ?? ZENZ_ONE_COMPLETION_MAX_ITERATIONS;
  const remainingMs = request.remainingMs ?? ((): number => 1);
  if (trimZenzLeftContext(request.leftContext).length === 0 || maxIterations <= 0) {
    return { text: request.baseline, iterations: 0, usedCompletion: false };
  }
  let candidate = request.baseline;
  let iterations = 0;
  for (let attempt = 0; attempt < maxIterations; attempt += 1) {
    if (remainingMs() <= 0) {
      return { text: request.baseline, iterations, usedCompletion: iterations > 0 };
    }
    iterations += 1;
    const decision = nextOutputPrefix(candidate, request.completion);
    if (decision === "verified") {
      return { text: candidate, iterations, usedCompletion: true };
    }
    if (decision === "fallback") {
      return { text: request.baseline, iterations, usedCompletion: true };
    }
    let next: string | undefined;
    try {
      next = request.search.searchOutputPrefix(decision);
    } catch {
      return { text: request.baseline, iterations, usedCompletion: true };
    }
    if (next === undefined || next.length === 0) {
      return { text: request.baseline, iterations, usedCompletion: true };
    }
    candidate = next;
  }
  // The loop only assigns a non-empty search hit, so a completed cap still
  // holds either the last constrained candidate or the original baseline.
  return {
    text: candidate,
    iterations,
    usedCompletion: true,
  };
};
