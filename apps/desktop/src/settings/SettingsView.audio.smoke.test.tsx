// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig, DEFAULT_MODEL_CATALOG } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { SettingsView } from "./SettingsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("SettingsView audio tuning", () => {
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

  it("exposes VAD window and silence threshold as labeled sliders with reset", async () => {
    const onSave = vi.fn();

    const Harness = () => {
      const [config, setConfig] = useState(createDefaultConfig());
      return (
        <SettingsView
          config={config}
          models={DEFAULT_MODEL_CATALOG}
          devices={[]}
          saving={false}
          onConfigChange={setConfig}
          onModelChange={() => undefined}
          onDeviceChange={() => undefined}
          onRefreshDevices={() => undefined}
          onSave={onSave}
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

    const chunk = container.querySelector<HTMLInputElement>("#audio-chunk-ms");
    const gate = container.querySelector<HTMLInputElement>("#audio-silence-gate-db");
    expect(chunk?.type).toBe("range");
    expect(chunk?.value).toBe("640");
    expect(chunk?.min).toBe("320");
    expect(chunk?.max).toBe("2000");
    expect(container.querySelector("output[for='audio-chunk-ms']")?.textContent).toContain(
      "640 ms",
    );
    expect(gate?.type).toBe("range");
    expect(gate?.value).toBe("-50");
    expect(container.querySelector("output[for='audio-silence-gate-db']")?.textContent).toContain(
      "-50 dBFS",
    );
    const vadInterval = container.querySelector<HTMLInputElement>("#audio-vad-interval-ms");
    const vadThreshold = container.querySelector<HTMLInputElement>("#audio-vad-threshold");
    expect(vadInterval?.value).toBe("32");
    expect(vadInterval?.min).toBe("16");
    expect(vadInterval?.max).toBe("128");
    expect(vadThreshold?.value).toBe("0.5");
    expect(container.querySelector("output[for='audio-vad-threshold']")?.textContent).toContain(
      "0.50",
    );

    await act(async () => {
      if (!chunk) throw new Error("chunk slider missing");
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(chunk, "800");
      chunk.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      await Promise.resolve();
    });
    expect(container.querySelector("output[for='audio-chunk-ms']")?.textContent).toContain(
      "800 ms",
    );

    const reset = Array.from(container.querySelectorAll<HTMLButtonElement>(".range-reset"))[0];
    expect(reset?.textContent).toMatch(/既定値|Reset/);
    await act(async () => {
      reset?.click();
      await Promise.resolve();
    });
    expect(container.querySelector("output[for='audio-chunk-ms']")?.textContent).toContain(
      "640 ms",
    );

    const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => /設定を保存|Save settings/.test(button.textContent ?? ""),
    );
    save?.click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
