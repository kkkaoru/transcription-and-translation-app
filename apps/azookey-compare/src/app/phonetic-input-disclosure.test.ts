// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import * as ReactDOMTestUtils from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ComparePage from "./page";

// Prefer React.act (19+). Fall back when a React 18 copy is resolved (named
// `import { act } from "react"` is then undefined → "act is not a function").
const act = typeof React.act === "function" ? React.act : ReactDOMTestUtils.act;
const { createElement } = React;
if (typeof act !== "function") {
  throw new Error("React act helper is unavailable for phonetic disclosure tests");
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DESKTOP_MEDIA_QUERY = "(min-width: 641px)";
const PHONETIC_DISCLOSURE = '[data-testid="phonetic-input-disclosure"]';
const PHONETIC_TOGGLE = '[data-testid="phonetic-input-toggle"]';

type MediaListener = (event: MediaQueryListEvent) => void;

const installMatchMedia = (desktopMatches: boolean) => {
  const listeners = new Set<MediaListener>();
  const media = {
    matches: desktopMatches,
    media: DESKTOP_MEDIA_QUERY,
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "change" && typeof listener === "function") {
        listeners.add(listener as MediaListener);
      }
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") {
        listeners.delete(listener as MediaListener);
      }
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };

  window.matchMedia = (query: string) => {
    media.media = query;
    return media as MediaQueryList;
  };

  return {
    setMatches(next: boolean) {
      media.matches = next;
      const event = { matches: next, media: DESKTOP_MEDIA_QUERY } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
};

const phoneticStyleRules = (sheet: CSSStyleSheet): CSSStyleRule[] => {
  const rules: CSSStyleRule[] = [];
  for (const rule of sheet.cssRules) {
    if (rule instanceof CSSStyleRule) {
      rules.push(rule);
      continue;
    }
    if (!(rule instanceof CSSMediaRule)) {
      continue;
    }
    for (const inner of rule.cssRules) {
      if (inner instanceof CSSStyleRule) {
        rules.push(inner);
      }
    }
  }
  return rules;
};

const mediaStyleRules = (sheet: CSSStyleSheet, mediaPattern: RegExp): CSSStyleRule[] => {
  const rules: CSSStyleRule[] = [];
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSMediaRule) || !mediaPattern.test(rule.conditionText)) {
      continue;
    }
    for (const inner of rule.cssRules) {
      if (inner instanceof CSSStyleRule) {
        rules.push(inner);
      }
    }
  }
  return rules;
};

const normalizedSelector = (rule: CSSStyleRule): string =>
  rule.selectorText.replace(/\s+/g, " ").trim();

const styleForSelector = (
  rules: readonly CSSStyleRule[],
  selector: string,
): CSSStyleDeclaration | undefined =>
  rules.find((rule) => normalizedSelector(rule) === selector)?.style;

const unhidesClosedPhoneticBody = (rule: CSSStyleRule): boolean => {
  const selector = normalizedSelector(rule);
  if (!selector.includes("phonetic-input") || !selector.includes(":not([open])")) {
    return false;
  }
  if (
    !selector.includes("phonetic-input-body") &&
    !selector.includes("phonetic-input-disclosure")
  ) {
    return false;
  }
  return rule.style.display === "block";
};

const loadPhoneticStylesheet = (): CSSStyleSheet => {
  // Named join: default `path` interop breaks under some Vitest/jsdom setups.
  // Avoid import.meta.url: jsdom replaces global URL.
  const css = readFileSync(join("src/app/globals.css"), "utf8");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const sheet = style.sheet;
  if (!sheet) {
    throw new Error("globals.css did not produce a CSSStyleSheet");
  }
  return sheet;
};

describe("phonetic input disclosure", () => {
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(async () => {
    if (root) {
      await act(() => {
        root?.unmount();
      });
      root = undefined;
    }
    host?.remove();
    host = undefined;
  });

  const renderPage = async (desktopMatches: boolean) => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { search: "", origin: "http://127.0.0.1:3000" },
    });
    installMatchMedia(desktopMatches);
    if (!host) {
      throw new Error("missing render host");
    }
    root = createRoot(host);
    await act(() => {
      root?.render(createElement(ComparePage));
    });
    return host;
  };

  const phoneticDisclosure = (container: HTMLElement): HTMLDetailsElement => {
    const details = container.querySelector<HTMLDetailsElement>(PHONETIC_DISCLOSURE);
    if (!details) {
      throw new Error("missing phonetic-input-disclosure");
    }
    return details;
  };

  const flushDetailsToggle = async () => {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  };

  it("does not unhide a closed phonetic details with display:block alone", () => {
    const sheet = loadPhoneticStylesheet();
    const desktop = mediaStyleRules(sheet, /min-width:\s*641px/);
    expect(styleForSelector(desktop, ".phonetic-input-disclosure")?.display).toBe("contents");
    expect(styleForSelector(desktop, ".phonetic-input-disclosure > summary")?.display).toBe("none");
    expect(styleForSelector(desktop, ".phonetic-input-heading-desktop")?.display).toBe("block");
    expect(phoneticStyleRules(sheet).some(unhidesClosedPhoneticBody)).toBe(false);
  });

  it("stays collapsed on max-width 640px until the summary is toggled", async () => {
    const container = await renderPage(false);
    const details = phoneticDisclosure(container);
    expect(details.open).toBe(false);
    expect(container.querySelector(PHONETIC_TOGGLE)).not.toBeNull();
    expect(details.querySelector(".phonetic-input-body")).not.toBeNull();

    const summary = container.querySelector<HTMLElement>(PHONETIC_TOGGLE);
    if (!summary) {
      throw new Error("missing phonetic-input-toggle");
    }
    await act(() => {
      summary.click();
    });
    await flushDetailsToggle();
    expect(phoneticDisclosure(container).open).toBe(true);
  });

  it("keeps phonetic input open on min-width 641px after a close attempt", async () => {
    const container = await renderPage(true);
    const details = phoneticDisclosure(container);
    expect(details.open).toBe(true);
    expect(details.querySelector("#manual-reading")).not.toBeNull();

    const summary = container.querySelector<HTMLElement>(PHONETIC_TOGGLE);
    if (!summary) {
      throw new Error("missing phonetic-input-toggle");
    }
    await act(() => {
      summary.click();
    });
    await flushDetailsToggle();
    expect(phoneticDisclosure(container).open).toBe(true);
  });
});
