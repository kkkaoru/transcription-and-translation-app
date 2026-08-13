// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import type { AppConfig, CaptionPayload } from "../core/types";
import { CaptionLines } from "./CaptionOverlay";
import { createPreviewCaption } from "./captions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SOURCE_TEXT = "あ".repeat(24);
const TRANSLATION_TEXT = "b".repeat(24);

const configWithBudget = (source: number, translation: number): AppConfig => {
  const config = createDefaultConfig();
  config.overlay.captionMaxChars = { source, translation };
  return config;
};

const caption: CaptionPayload = {
  ...createPreviewCaption(),
  sourceText: SOURCE_TEXT,
  translationText: TRANSLATION_TEXT,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderWith = (config: AppConfig): void => {
  act(() => {
    root.render(<CaptionLines config={config} caption={caption} />);
  });
};

const lineTextOf = (key: "source" | "translation"): string => {
  const line = host.querySelector(`.caption-line-${key}`);
  if (!line) {
    throw new Error(`missing rendered ${key} caption line`);
  }
  return line.textContent ?? "";
};

describe("DOM overlay honours the configured caption line budget", () => {
  it("keeps one line when the budget covers the whole caption", () => {
    renderWith(configWithBudget(24, 24));

    expect(lineTextOf("source")).toBe(SOURCE_TEXT);
    expect(lineTextOf("translation")).toBe(TRANSLATION_TEXT);
    expect(lineTextOf("source")).not.toContain("\n");
  });

  it("adds an OPEN-segment result as a dim inline source suffix without replacing body text", () => {
    const config = configWithBudget(24, 24);
    act(() => {
      root.render(<CaptionLines config={config} caption={caption} partialWindowText="部分候補" />);
    });

    const source = host.querySelector(".caption-line-source");
    const suffix = host.querySelector(".caption-partial-window");
    expect(source?.textContent).toBe(`${SOURCE_TEXT} 部分候補`);
    expect(suffix?.textContent).toBe(" 部分候補");
    expect(suffix?.className).toBe("caption-partial-window");
    // The committed body stays the supplied source only; suffix layout never
    // enters captionTextLines and therefore cannot create a third logical row.
    expect(source?.firstChild?.textContent).toBe(SOURCE_TEXT);
    expect(host.querySelectorAll(".caption-line")).toHaveLength(2);
  });

  it("re-splits both rows when the configured budget shrinks", () => {
    renderWith(configWithBudget(6, 8));

    const source = lineTextOf("source");
    const translation = lineTextOf("translation");

    // Keep only the newest logical lines on screen (CAPTION_MAX_VISIBLE_LINES=2).
    expect(source.split("\n")).toEqual(["あ".repeat(6), "あ".repeat(6)]);
    expect(translation.split("\n")).toEqual(["b".repeat(8), "b".repeat(8)]);
    expect(source.replaceAll("\n", "")).toBe("あ".repeat(12));
    expect(translation.replaceAll("\n", "")).toBe("b".repeat(16));
  });

  it("clamps an out-of-range persisted budget rather than rendering unusable lines", () => {
    // Below CAPTION_MAX_CHARS_MIN; must clamp up to 4 instead of degenerating.
    // The visible window is maxChars × CAPTION_MAX_VISIBLE_LINES (4×2=8), so
    // only the newest 8 of the 24-grapheme source remain on screen.
    renderWith(configWithBudget(0, 0));

    expect(lineTextOf("source").split("\n")).toEqual(["あ".repeat(4), "あ".repeat(4)]);
  });

  it("falls back to the built-in budgets for a legacy config without the field", () => {
    const legacy = createDefaultConfig();
    legacy.overlay.captionMaxChars = undefined;
    renderWith(legacy);

    // 24 graphemes fit inside the default 28-character source budget.
    expect(lineTextOf("source")).toBe(SOURCE_TEXT);
  });

  it("re-wraps an already-visible caption when the budget changes mid-session", () => {
    // The live overlay keeps one caption visible across settings saves. A
    // budget-only change must re-wrap the SAME text already on screen, not
    // wait for the next utterance. This pins the mid-session repaint path.
    renderWith(configWithBudget(24, 24));
    expect(lineTextOf("source").split("\n")).toHaveLength(1);

    renderWith(configWithBudget(6, 8));

    const source = lineTextOf("source");
    const translation = lineTextOf("translation");
    // CAPTION_MAX_VISIBLE_LINES=2 → newest two wrapped lines remain.
    expect(source.split("\n")).toEqual(["あ".repeat(6), "あ".repeat(6)]);
    expect(translation.split("\n")).toEqual(["b".repeat(8), "b".repeat(8)]);
  });

  it("keeps a re-wrapped caption identical to a fresh render at the same budget", () => {
    renderWith(configWithBudget(6, 8));
    const firstPass = {
      source: lineTextOf("source"),
      translation: lineTextOf("translation"),
    };

    renderWith(configWithBudget(24, 24));
    renderWith(configWithBudget(6, 8));

    expect(lineTextOf("source")).toBe(firstPass.source);
    expect(lineTextOf("translation")).toBe(firstPass.translation);
  });
  it("counts the budget in grapheme clusters, not code points, in the DOM rows", () => {
    // The budget is a user-visible character count. A ZWJ family emoji is one
    // grapheme (several code points) and a dakuten combining mark shares a
    // single grapheme with its base kana. Breaking mid-cluster would either
    // split the budget across isolated ZWJ/marks or paint broken glyphs. The
    // shared segmenter already guarantees this; this pins it through the DOM
    // overlay render at a configured budget.
    const family = "👨‍👩‍👧"; // one grapheme, multiple code points
    const combining = "か\u3099"; // kana + combining dakuten, one grapheme
    const text = family + combining + family + combining;
    const graphemesOf = (input: string): string[] =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input)].map(
        (part) => part.segment,
      );
    const budget = { source: 2, translation: 2 };
    const config = configWithBudget(2, 2);
    config.overlay.captionMaxChars = budget;
    const graphemeCaption: CaptionPayload = {
      ...createPreviewCaption(),
      sourceText: text,
      translationText: text,
    };

    act(() => {
      root.render(<CaptionLines config={config} caption={graphemeCaption} />);
    });

    const source = lineTextOf("source");
    const renderedGraphemes = graphemesOf(source);

    // No line starts with a dangling ZWJ or combining mark, and every line
    // stays within the 2-grapheme budget. CAPTION_MAX_VISIBLE_LINES=2 keeps
    // up to 4 graphemes on screen (budget 2×2).
    expect(source.startsWith("\u200D")).toBe(false);
    expect(renderedGraphemes.some((cluster) => cluster.startsWith("\u3099"))).toBe(false);
    expect(renderedGraphemes.map((cluster) => graphemesOf(cluster).length)).toEqual(
      renderedGraphemes.map(() => 1),
    );
    // maxChars 2 clamps up to CAPTION_MAX_CHARS_MIN (4), and with a 1-line
    // window the full 4-grapheme sample still fits.
    expect(renderedGraphemes.length).toBe(4);
    expect(renderedGraphemes.join("")).toBe(text);
  });
});
