/**
 * Lead × tail matrix for overlay/queue A/B. Both halves are parameters so
 * tests do not treat こんにちは or きこえますか as the cause.
 */

export const CAPTION_AB_LEADS = [
  "こんにちは",
  "おはよう",
  "会議を始めます",
  "これはテストです",
  "本日はよろしくお願いします",
] as const;

export const CAPTION_AB_TAILS = [
  "きこえますか",
  "聞こえますか",
  "続きがあります",
  "よろしくお願いします",
  "終わりますか",
  "",
] as const;

export type CaptionAbStructure = "glue" | "elong" | "elong-q" | "lead-only";

export type CaptionAbRow = {
  id: string;
  lead: string;
  tail: string;
  full: string;
  structure: CaptionAbStructure;
};

export const joinCaptionAbSurface = (
  lead: string,
  tail: string,
  structure: CaptionAbStructure,
): string => {
  if (!tail || structure === "lead-only") {
    return lead;
  }
  if (structure === "glue") {
    return `${lead}${tail}`;
  }
  if (structure === "elong") {
    return `${lead}ーーー${tail}`;
  }
  return `${lead}ーーー${tail}ーーー？`;
};

export const buildCaptionAbMatrix = (): CaptionAbRow[] => {
  const rows: CaptionAbRow[] = [];
  for (const lead of CAPTION_AB_LEADS) {
    for (const tail of CAPTION_AB_TAILS) {
      if (!tail) {
        rows.push({
          id: `${lead}|∅`,
          lead,
          tail: "",
          full: lead,
          structure: "lead-only",
        });
        continue;
      }
      for (const structure of ["glue", "elong", "elong-q"] as const) {
        rows.push({
          id: `${lead}|${tail}|${structure}`,
          lead,
          tail,
          full: joinCaptionAbSurface(lead, tail, structure),
          structure,
        });
      }
    }
  }
  return rows;
};
