// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultConfig, DEFAULT_MODEL_CATALOG } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { SettingsView } from "./SettingsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("SettingsView OBS browser source", () => {
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

  const toggleField = (): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>("#overlay-browser-source")?.closest(".field") ?? null;

  const portField = (): HTMLDivElement | null =>
    Array.from(container.querySelectorAll<HTMLDivElement>(".field")).find((field) => {
      const label = field.querySelector("span")?.textContent?.trim();
      return label === "Port" || label === "ポート";
    }) ?? null;

  const portInput = (): HTMLInputElement | null =>
    portField()?.querySelector<HTMLInputElement>('input[type="number"]') ?? null;

  const toggleCheckbox = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>("#overlay-browser-source");

  const setChecked = async (checked: boolean): Promise<void> => {
    const checkbox = toggleCheckbox();
    if (!checkbox) {
      throw new Error("browser source toggle missing");
    }
    await act(async () => {
      const checkedSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "checked",
      )?.set;
      checkedSetter?.call(checkbox, checked);
      checkbox.dispatchEvent(new Event("click", { bubbles: true }));
      await Promise.resolve();
    });
  };

  const setPort = async (port: number): Promise<void> => {
    const input = portInput();
    if (!input) {
      throw new Error("browser source port input missing");
    }
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, String(port));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("keeps the browser-only preview toggle disabled on the documented port", async () => {
    await renderSettings();

    const checkbox = toggleCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(portInput()?.value).toBe("1421");
    expect(portInput()?.min).toBe("1024");
    expect(portInput()?.max).toBe("65535");
    // The disabled state explains the loopback fallback instead of a URL.
    expect(toggleField()?.querySelector("small")?.textContent).toMatch(
      /Apple Silicon|loopback|ループバック/i,
    );
    expect(toggleField()?.textContent).not.toContain("127.0.0.1:");
  });

  it("swaps the hint for the documented URL when the toggle is enabled", async () => {
    await renderSettings();
    await setChecked(true);

    const checkbox = toggleCheckbox();
    expect(checkbox?.checked).toBe(true);
    expect(toggleField()?.querySelector("small")?.textContent).toMatch(/127\.0\.0\.1:1421\//);
    expect(toggleField()?.textContent).toMatch(/Add to OBS|追加/i);
  });

  it("propagates a custom port and keeps the source enabled", async () => {
    await renderSettings();
    await setChecked(true);
    await setPort(40_000);

    expect(portInput()?.value).toBe("40000");
    expect(toggleCheckbox()?.checked).toBe(true);
    expect(toggleField()?.querySelector("small")?.textContent).toMatch(/127\.0\.0\.1:40000\//);
  });

  it("restores the setup hint when the toggle is disabled again", async () => {
    await renderSettings();
    await setChecked(true);
    expect(toggleField()?.querySelector("small")?.textContent).toContain("127.0.0.1:");

    await setChecked(false);

    expect(toggleCheckbox()?.checked).toBe(false);
    expect(toggleField()?.querySelector("small")?.textContent).toMatch(
      /Apple Silicon|loopback|ループバック/i,
    );
    expect(toggleField()?.textContent).not.toContain("127.0.0.1:");
  });

  it("keeps a persisted custom port while the source stays disabled", async () => {
    const base = createDefaultConfig();
    const persisted = {
      ...base,
      overlay: { ...base.overlay, browserSource: { enabled: false, port: 30_000 } },
    };
    await renderSettings(persisted);

    expect(toggleCheckbox()?.checked).toBe(false);
    expect(portInput()?.value).toBe("30000");
    expect(toggleField()?.querySelector("small")?.textContent).toMatch(
      /Apple Silicon|loopback|ループバック/i,
    );
  });
});
