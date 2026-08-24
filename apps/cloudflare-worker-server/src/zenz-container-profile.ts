/** This file runs with bun. */

export type ZenzComputeTier = "basic" | "standard";
export type ZenzModelSize = "xsmall" | "small";
export type ZenzN5Mode = "off" | "on";
export type ZenzConversionModel = "none" | "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf";

export interface ZenzContainerProfile {
  computeTier: ZenzComputeTier;
  modelSize: ZenzModelSize;
  n5Mode: ZenzN5Mode;
}

const XSMALL_MODEL: ZenzConversionModel = "zenz-v3.2-xsmall-gguf";
const SMALL_MODEL: ZenzConversionModel = "zenz-v3.2-small-gguf";
const BASIC_MIN_COMPLETION_TOKENS = 8;
const BASIC_MAX_COMPLETION_TOKENS = 16;
const BASIC_TOKENS_PER_CHARACTER = 0.75;
const STANDARD_MIN_COMPLETION_TOKENS = 8;
const STANDARD_MAX_COMPLETION_TOKENS = 16;
const STANDARD_TOKENS_PER_CHARACTER = 0.75;

export const parseConversionModel = (
  value: FormDataEntryValue | null,
): ZenzConversionModel | null =>
  value === "none" || value === XSMALL_MODEL || value === SMALL_MODEL ? value : null;

export const zenzModelSize = (
  conversionModel: ZenzConversionModel,
  containerModelValue: FormDataEntryValue | null,
): ZenzModelSize =>
  conversionModel === SMALL_MODEL || (conversionModel === "none" && containerModelValue === "small")
    ? "small"
    : "xsmall";

export const parseZenzContainerProfile = (
  form: FormData,
  conversionModel: ZenzConversionModel,
): ZenzContainerProfile | null => {
  const computeTierValue = form.get("computeTier");
  const n5ModeValue = form.get("n5Lm");
  if (
    (computeTierValue !== "basic" && computeTierValue !== "standard") ||
    (n5ModeValue !== "off" && n5ModeValue !== "on")
  ) {
    return null;
  }
  return {
    computeTier: computeTierValue,
    modelSize: zenzModelSize(conversionModel, form.get("containerModel")),
    n5Mode: n5ModeValue,
  };
};

export const zenzContainerBaseUrl = (
  serviceOrigin: string,
  profile: ZenzContainerProfile,
): string =>
  `${serviceOrigin.replace(/\/$/, "")}/${profile.computeTier}/${profile.modelSize}/n5-${profile.n5Mode}`;

/**
 * Bound generation to the expected Japanese output length. The former fixed
 * 64-token Standard request kept decoding after short live-caption turns and
 * dominated end-to-end latency. The lattice remains the full-length authority;
 * GGUF supplies only a bounded prefix used to select its constrained candidate.
 */
export const zenzCompletionTokenBudget = (text: string, tier: ZenzComputeTier): number => {
  const characterCount = Array.from(text).length;
  return tier === "basic"
    ? Math.min(
        BASIC_MAX_COMPLETION_TOKENS,
        Math.max(
          BASIC_MIN_COMPLETION_TOKENS,
          Math.ceil(characterCount * BASIC_TOKENS_PER_CHARACTER),
        ),
      )
    : Math.min(
        STANDARD_MAX_COMPLETION_TOKENS,
        Math.max(
          STANDARD_MIN_COMPLETION_TOKENS,
          Math.ceil(characterCount * STANDARD_TOKENS_PER_CHARACTER),
        ),
      );
};
