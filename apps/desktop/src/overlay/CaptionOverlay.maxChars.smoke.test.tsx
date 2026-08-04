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

  it("re-splits both rows when the configured budget shrinks", () => {
    renderWith(configWithBudget(6, 8));

    const source = lineTextOf("source");
    const translation = lineTextOf("translation");

    expect(source.split("\n")).toEqual(Array.from({ length: 4 }, () => "あ".repeat(6)));
    expect(translation.split("\n")).toEqual(Array.from({ length: 3 }, () => "b".repeat(8)));
    // Segmentation must only insert breaks, never drop characters.
    expect(source.replaceAll("\n", "")).toBe(SOURCE_TEXT);
    expect(translation.replaceAll("\n", "")).toBe(TRANSLATION_TEXT);
  });

  it("clamps an out-of-range persisted budget rather than rendering unusable lines", () => {
    // Below CAPTION_MAX_CHARS_MIN; must clamp up to 4 instead of degenerating.
    renderWith(configWithBudget(0, 0));

    expect(lineTextOf("source").split("\n")).toEqual(
      Array.from({ length: 6 }, () => "あ".repeat(4)),
    );
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
    expect(source.split("\n")).toEqual(Array.from({ length: 4 }, () => "あ".repeat(6)));
    expect(translation.split("\n")).toEqual(Array.from({ length: 3 }, () => "b".repeat(8)));
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
});
