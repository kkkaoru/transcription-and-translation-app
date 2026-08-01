// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css");

/** Strip block comments so rule scans ignore documentation samples. */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "\n");

/**
 * Extract property declarations that appear inside any :hover rule body.
 * Handles nested-ish blocks by tracking brace depth from each `:hover` match.
 */
const hoverRuleBodies = (css: string): string[] => {
  const source = stripCssComments(css);
  const bodies: string[] = [];
  const re = /:hover\b[^{]*\{/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
      }
      i += 1;
    }
    bodies.push(source.slice(start, i - 1));
    match = re.exec(source);
  }
  return bodies;
};

describe("styles.css visibility + no-hover-motion guards", () => {
  const css = readFileSync(stylesPath, "utf8");

  it("never uses text-overflow: ellipsis (prefer wrap + clip)", () => {
    expect(css).not.toMatch(/text-overflow\s*:\s*ellipsis/i);
    // Known intentional clip usages for path/stage text.
    expect(css).toMatch(/text-overflow\s*:\s*clip/i);
  });

  it("forbids layout/motion transforms on :hover (color affordance only)", () => {
    const bodies = hoverRuleBodies(css);
    expect(bodies.length).toBeGreaterThan(0);

    for (const body of bodies) {
      // transform: none is the explicit no-motion guard and is allowed.
      const transformDecls = [...body.matchAll(/transform\s*:\s*([^;]+);/gi)].map((m) =>
        (m[1] ?? "").trim().toLowerCase(),
      );
      for (const value of transformDecls) {
        expect(value).toBe("none");
      }

      // Layout-affecting hover shifts are also banned.
      expect(body).not.toMatch(
        /\b(top|left|right|bottom|margin|margin-top|margin-bottom|margin-left|margin-right|padding|padding-top|padding-bottom|padding-left|padding-right)\s*:\s*[^;]+;/i,
      );

      // Hover must not alter stacking or add a shadow that visually lifts a card
      // over its neighbours. Keep hover affordances to color/border changes.
      expect(body).not.toMatch(/\bz-index\s*:\s*[^;]+;/i);
      expect(body).not.toMatch(/\bbox-shadow\s*:\s*[^;]+;/i);
    }
  });

  it("keeps a global app-shell :hover transform:none guard for interactive controls", () => {
    expect(css).toMatch(/\.app-shell[\s\S]*?:hover\s*\{[\s\S]*?transform\s*:\s*none/i);
  });

  it("wraps debug stage text instead of clipping mid-word", () => {
    expect(css).toMatch(/\.debug-stage-text\s*\{[\s\S]*?overflow-wrap\s*:\s*anywhere/i);
    expect(css).toMatch(/\.debug-stage-text\s*\{[\s\S]*?white-space\s*:\s*pre-wrap/i);
  });

  it("stacks the shell at the compact desktop breakpoint", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*980px\)[\s\S]*?\.workspace\s*\{[\s\S]*?grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/i,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*980px\)[\s\S]*?\.content\s*\{[\s\S]*?overflow\s*:\s*visible/i,
    );
  });
});
