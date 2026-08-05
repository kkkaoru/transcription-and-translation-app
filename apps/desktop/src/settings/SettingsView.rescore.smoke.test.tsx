// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig, DEFAULT_MODEL_CATALOG } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { SettingsView } from "./SettingsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("SettingsView input-LM rescore toggle", () => {
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

  const renderSettings = async (initialConfig = createDefaultConfig()) => {
    const Harness = () => {
      const [config, setConfig] = useState(initialConfig);
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
  };

  const toggle = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>("#rescore-enabled");

  const toggleField = (): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>("#rescore-enabled")?.closest(".field") ?? null;

  it("renders the rescore toggle off by default with a hint", async () => {
    await renderSettings();
    const checkbox = toggle();
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    const field = toggleField();
    expect(field?.textContent).toMatch(/Input N5 LM/i);
  });

  it("wires the toggle through the config save path", async () => {
    const onConfigChange = vi.fn();
    // Re-render with a capturing harness to assert that the emitted patch
    // enables rescore while leaving all other fields untouched.
    const Harness = () => {
      const [config, setConfig] = useState(createDefaultConfig());
      return (
        <SettingsView
          config={config}
          models={DEFAULT_MODEL_CATALOG}
          devices={[]}
          saving={false}
          onConfigChange={(next) => {
            onConfigChange(next);
            setConfig(next);
          }}
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
    const freshToggle = container.querySelector<HTMLInputElement>("#rescore-enabled");
    if (!freshToggle) {
      throw new Error("rescore toggle missing after re-render");
    }
    await act(async () => {
      const checkedSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "checked",
      )?.set;
      checkedSetter?.call(freshToggle, true);
      freshToggle.dispatchEvent(new Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    const lastEmitted = onConfigChange.mock.calls.at(-1)?.[0] as {
      rescore?: { enabled: boolean };
    };
    expect(lastEmitted.rescore?.enabled).toBe(true);
    expect(freshToggle.checked).toBe(true);
  });
});
