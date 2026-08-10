// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_AZOOKEY_DICTIONARY_URL } from "../core/azookey-dictionary";
import { createDefaultConfig, DEFAULT_MODEL_CATALOG } from "../core/defaults";
import type { AppConfig } from "../core/types";
import { I18nProvider } from "../i18n/I18nProvider";
import { ModelCard } from "./ModelCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ModelCard AzooKey dictionary source select", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  const renderCard = async (initial: AppConfig = createDefaultConfig()) => {
    const Harness = () => {
      const [config, setConfig] = useState(initial);
      return (
        <ModelCard
          family="normalizer"
          title="normalizer"
          config={config}
          models={DEFAULT_MODEL_CATALOG}
          onChange={(value) =>
            setConfig((prev) => ({
              ...prev,
              models: { ...prev.models, normalizer: value },
            }))
          }
          onPathChange={(key, value) =>
            setConfig((prev) => ({
              ...prev,
              models: {
                ...prev.models,
                paths: { ...prev.models.paths, [key]: value },
              },
            }))
          }
        />
      );
    };
    await act(async () => {
      root.render(
        <I18nProvider>
          <Harness />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
  };

  const sourceSelect = () =>
    container.querySelector<HTMLSelectElement>("[data-testid='azookey-system-dictionary-source']");

  it("shows builtin/official/custom presets when azookey-rust is selected", async () => {
    await renderCard();
    const select = sourceSelect();
    expect(select).not.toBeNull();
    expect(select?.value).toBe("builtin");
    expect(select?.querySelectorAll("option")).toHaveLength(3);
    expect(container.querySelector("[data-testid='azookey-system-dictionary-path']")).toBeNull();
  });

  it("writes the official HTTPS archive when official is chosen", async () => {
    await renderCard();
    const select = sourceSelect();
    if (!select) {
      throw new Error("missing dictionary source select");
    }
    await act(async () => {
      select.value = "official";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sourceSelect()?.value).toBe("official");
    expect(
      container.querySelector("[data-testid='azookey-system-dictionary-official-url']")
        ?.textContent,
    ).toContain(OFFICIAL_AZOOKEY_DICTIONARY_URL);
    expect(container.querySelector("[data-testid='azookey-system-dictionary-path']")).toBeNull();
  });

  it("reveals a custom path field and keeps typed values", async () => {
    await renderCard();
    const select = sourceSelect();
    if (!select) {
      throw new Error("missing dictionary source select");
    }
    await act(async () => {
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const pathInput = container.querySelector<HTMLInputElement>(
      "[data-testid='azookey-system-dictionary-path']",
    );
    expect(pathInput).not.toBeNull();
    await act(async () => {
      if (!pathInput) {
        throw new Error("missing path input");
      }
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(pathInput, "https://example.com/dict.tar.gz");
      pathInput.dispatchEvent(new Event("input", { bubbles: true }));
      pathInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLInputElement>("[data-testid='azookey-system-dictionary-path']")
        ?.value,
    ).toBe("https://example.com/dict.tar.gz");
  });

  it("hides dictionary controls when another normalizer is selected", async () => {
    const config = createDefaultConfig();
    config.models.normalizer = "zenz-v3.2-xsmall-gguf";
    await renderCard(config);
    expect(sourceSelect()).toBeNull();
  });

  it("lets the user choose AzooKey Zenzai xsmall and small", async () => {
    await renderCard();
    const modelSelect = container.querySelector<HTMLSelectElement>(
      "[data-testid='normalizer-model-select']",
    );
    expect(modelSelect).not.toBeNull();
    const optionLabels = [...(modelSelect?.querySelectorAll("option") ?? [])].map(
      (option) => option.textContent ?? "",
    );
    expect(optionLabels.some((label) => /xsmall/i.test(label))).toBe(true);
    expect(optionLabels.some((label) => /small/i.test(label) && !/xsmall/i.test(label))).toBe(true);

    await act(async () => {
      if (!modelSelect) {
        throw new Error("missing normalizer model select");
      }
      modelSelect.value = "zenz-v3.2-xsmall-gguf";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLSelectElement>("[data-testid='normalizer-model-select']")?.value,
    ).toBe("zenz-v3.2-xsmall-gguf");
    expect(sourceSelect()).toBeNull();

    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        "[data-testid='normalizer-model-select']",
      );
      if (!select) {
        throw new Error("missing normalizer model select");
      }
      select.value = "zenz-v3.2-small-gguf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLSelectElement>("[data-testid='normalizer-model-select']")?.value,
    ).toBe("zenz-v3.2-small-gguf");
    expect(container.textContent).toMatch(/Zenzai|ニューラル|neural|quality|精度/i);
  });
});
