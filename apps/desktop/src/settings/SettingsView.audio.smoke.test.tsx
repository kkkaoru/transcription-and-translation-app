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

  it("exposes the three recognition modes with a localized explanation", async () => {
    const Harness = () => {
      const initialConfig = createDefaultConfig();
      const [config, setConfig] = useState({
        ...initialConfig,
        audio: { ...initialConfig.audio, adaptiveNoiseFloor: false },
      });
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
          onSave={() => undefined}
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

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="recognition-mode-select"]',
    );
    const deviceControls = container.querySelector<HTMLFieldSetElement>(
      '[data-testid="audio-device-controls"]',
    );
    const deviceSelect = deviceControls?.querySelector<HTMLSelectElement>("select");
    const deviceRefresh = container.querySelector<HTMLButtonElement>(
      '[data-testid="audio-device-refresh"]',
    );
    expect(select).not.toBeNull();
    expect(select?.value).toBe("parapper-azookey");
    expect(deviceControls?.disabled).toBe(false);
    expect(deviceSelect?.matches(":disabled")).toBe(false);
    expect(deviceRefresh?.disabled).toBe(false);
    for (const selector of [
      "#audio-chunk-ms",
      "#audio-silence-gate-db",
      "#audio-vad-interval-ms",
      "#audio-vad-threshold",
      "#audio-adaptive-noise-floor",
      "#audio-noise-suppression",
    ]) {
      expect(container.querySelector<HTMLInputElement>(selector)?.disabled).toBe(false);
    }
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      "parapper-raw",
      "web-speech",
      "parapper-azookey",
    ]);
    expect(select?.closest(".field")?.textContent).toMatch(/現在の既定動作|current default/);
    if (!select) throw new Error("recognition mode selector missing");

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(select, "web-speech");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(select.value).toBe("web-speech");
    expect(select.closest(".field")?.textContent).toMatch(/デスクトップの検証用|desktop debugging/);
    expect(deviceControls?.disabled).toBe(true);
    expect(deviceSelect?.matches(":disabled")).toBe(true);
    expect(deviceRefresh?.disabled).toBe(true);
    expect(deviceControls?.textContent).toMatch(
      /入力デバイス選択と更新は無効|device selection and refresh are disabled/,
    );
    expect(container.querySelector<HTMLInputElement>("#audio-chunk-ms")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#audio-silence-gate-db")?.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLInputElement>("#audio-vad-interval-ms")?.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLInputElement>("#audio-vad-threshold")?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#audio-adaptive-noise-floor")?.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLInputElement>("#audio-noise-suppression")?.disabled).toBe(
      true,
    );
    expect(
      container.querySelector<HTMLInputElement>("#audio-chunk-ms")?.closest(".field")?.textContent,
    ).toMatch(/フロントVAD|frontend VAD/i);
    expect(
      container.querySelector<HTMLInputElement>("#audio-vad-interval-ms")?.closest(".field")
        ?.textContent,
    ).toMatch(/sidecar/);
    expect(container.textContent).toMatch(/このモードでは未使用|not used in this mode/i);
  });

  it("disables capture-affecting controls while capture is starting", async () => {
    const config = createDefaultConfig();

    const renderSettings = async (captureStarting: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <SettingsView
              config={config}
              models={DEFAULT_MODEL_CATALOG}
              devices={[]}
              saving={false}
              captureStarting={captureStarting}
              onConfigChange={() => undefined}
              onModelChange={() => undefined}
              onDeviceChange={() => undefined}
              onRefreshDevices={() => undefined}
              onSave={() => undefined}
              webSpeechSupported
            />
          </I18nProvider>,
        );
        await Promise.resolve();
      });
    };

    await renderSettings(true);

    const recognitionMode = container.querySelector<HTMLSelectElement>(
      '[data-testid="recognition-mode-select"]',
    );
    const deviceControls = container.querySelector<HTMLFieldSetElement>(
      '[data-testid="audio-device-controls"]',
    );
    const deviceSelect = deviceControls?.querySelector<HTMLSelectElement>("select");
    const deviceRefresh = container.querySelector<HTMLButtonElement>(
      '[data-testid="audio-device-refresh"]',
    );
    const chunk = container.querySelector<HTMLInputElement>("#audio-chunk-ms");
    const gate = container.querySelector<HTMLInputElement>("#audio-silence-gate-db");
    const adaptiveToggle = container.querySelector<HTMLInputElement>("#audio-adaptive-noise-floor");
    const noiseSuppression = container.querySelector<HTMLInputElement>("#audio-noise-suppression");
    const autoGainControl = container.querySelector<HTMLInputElement>("#audio-auto-gain-control");
    const audioReset = container.querySelector<HTMLButtonElement>(
      '[data-testid="audio-tuning-reset"]',
    );
    const rangeResets = container.querySelectorAll<HTMLButtonElement>(".range-reset");

    expect(recognitionMode?.disabled).toBe(true);
    expect(deviceControls?.disabled).toBe(true);
    expect(deviceSelect?.disabled).toBe(true);
    expect(deviceRefresh?.disabled).toBe(true);
    expect(chunk?.disabled).toBe(true);
    expect(gate?.disabled).toBe(true);
    expect(adaptiveToggle?.disabled).toBe(true);
    expect(noiseSuppression?.disabled).toBe(true);
    expect(autoGainControl?.disabled).toBe(true);
    expect(audioReset?.disabled).toBe(true);
    expect(rangeResets[0]?.disabled).toBe(true);
    expect(rangeResets[1]?.disabled).toBe(true);

    await renderSettings(false);

    expect(recognitionMode?.disabled).toBe(false);
    expect(deviceControls?.disabled).toBe(false);
    expect(deviceSelect?.disabled).toBe(false);
    expect(deviceRefresh?.disabled).toBe(false);
    expect(chunk?.disabled).toBe(false);
    expect(adaptiveToggle?.disabled).toBe(false);
    expect(noiseSuppression?.disabled).toBe(false);
    expect(autoGainControl?.disabled).toBe(false);
    expect(audioReset?.disabled).toBe(false);
    expect(rangeResets[0]?.disabled).toBe(false);
    expect(rangeResets[1]?.disabled).toBe(false);
  });

  it("disables browser pipeline tuning while native Parapper owns the stream", async () => {
    const config = { ...createDefaultConfig(), recognitionMode: "parapper-raw" as const };

    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsView
            config={config}
            models={DEFAULT_MODEL_CATALOG}
            devices={[]}
            saving={false}
            desktopStreaming
            onConfigChange={() => undefined}
            onModelChange={() => undefined}
            onDeviceChange={() => undefined}
            onRefreshDevices={() => undefined}
            onSave={() => undefined}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    for (const selector of [
      "#audio-chunk-ms",
      "#audio-silence-gate-db",
      "#audio-vad-interval-ms",
      "#audio-vad-threshold",
      "#audio-adaptive-noise-floor",
      "#audio-noise-suppression",
    ]) {
      expect(container.querySelector<HTMLInputElement>(selector)?.disabled).toBe(true);
    }
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="audio-tuning-reset"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).toMatch(/このモードでは未使用|not used in this mode/i);
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
    expect(gate?.disabled).toBe(true);
    expect(container.querySelector("output[for='audio-silence-gate-db']")?.textContent).toContain(
      "-50 dBFS",
    );
    expect(container.querySelector("output[for='audio-silence-gate-db']")?.textContent).toMatch(
      /適応ゲート有効|adaptive gate active/,
    );

    // The fixed dBFS slider becomes effective only after adaptive gating is
    // explicitly disabled; the UI must make that state reversible.
    const adaptiveToggle = container.querySelector<HTMLInputElement>("#audio-adaptive-noise-floor");
    expect(adaptiveToggle?.checked).toBe(true);
    await act(async () => {
      adaptiveToggle?.click();
      await Promise.resolve();
    });
    expect(gate?.disabled).toBe(false);
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
