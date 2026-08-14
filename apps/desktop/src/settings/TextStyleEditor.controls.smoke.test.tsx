// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { FontFamilyCombobox, mergeFontFamilyOptions } from "./FontFamilyCombobox";
import { NumberSliderField } from "./NumberSliderField";
import { TextStyleEditor } from "./TextStyleEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const listSystemFontsMock = vi.fn(async () => [] as string[]);

vi.mock("../core/bridge", () => ({
  bridge: {
    isDesktop: () => false,
    listSystemFonts: () => listSystemFontsMock(),
  },
}));

const setInputValue = (element: HTMLInputElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("style editor controls", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    listSystemFontsMock.mockReset();
    listSystemFontsMock.mockResolvedValue([]);
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(globalThis, "queryLocalFonts");
  });

  it("selects an available font family through the native select", async () => {
    const onChange = vi.fn();
    await act(() => {
      root.render(<FontFamilyCombobox label="Font" value="Noto Sans JP" onChange={onChange} />);
    });
    const select = host.querySelector<HTMLSelectElement>('[data-testid="font-family-select"]');
    if (!select) throw new Error("missing font select");
    expect(Array.from(select.options, (option) => option.value)).toContain("Helvetica Neue");
    await act(() => {
      select.value = "Helvetica Neue";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Helvetica Neue");
  });

  it("lists every available font family without an 80-item UI cap", async () => {
    const many = Array.from(
      { length: 120 },
      (_, index) => `Demo Font ${String(index).padStart(3, "0")}`,
    );
    Object.assign(globalThis, {
      queryLocalFonts: async () => many.map((family) => ({ family })),
    });
    listSystemFontsMock.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, index) => `Native Font ${String(index).padStart(2, "0")}`),
    );

    await act(() => {
      root.render(
        <FontFamilyCombobox label="Font" value="Noto Sans JP" onChange={() => undefined} />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const select = host.querySelector<HTMLSelectElement>('[data-testid="font-family-select"]');
    if (!select) throw new Error("missing font select");
    expect(select.options.length).toBeGreaterThanOrEqual(120);
    expect(host.textContent).toContain("Demo Font 000");
    expect(host.textContent).toContain("Demo Font 119");
  });

  it("merges curated and enumerated families without capping", () => {
    const merged = mergeFontFamilyOptions(
      Array.from({ length: 100 }, (_, index) => `Extra ${index}`),
      "Custom Face",
    );
    expect(merged.length).toBeGreaterThan(100);
    expect(merged).toContain("Extra 99");
    expect(merged).toContain("Custom Face");
    expect(merged).toContain("Noto Sans JP");
  });

  it("exposes a slider alongside each numeric style field", async () => {
    const onChange = vi.fn();
    await act(() => {
      root.render(
        <NumberSliderField
          label="Opacity"
          value={0.5}
          min={0}
          max={1}
          step={0.05}
          testId="opacity"
          onChange={onChange}
        />,
      );
    });
    const slider = host.querySelector<HTMLInputElement>('[data-testid="opacity-slider"]');
    if (!slider) throw new Error("missing slider");
    await act(() => {
      setInputValue(slider, "0.8");
    });
    expect(onChange).toHaveBeenCalledWith(0.8);
  });

  it("wires font and opacity controls through TextStyleEditor", async () => {
    const onChange = vi.fn();
    await act(() => {
      root.render(
        <I18nProvider>
          <TextStyleEditor
            config={createDefaultConfig()}
            kind="source"
            title="Source"
            onChange={onChange}
          />
        </I18nProvider>,
      );
    });
    expect(host.querySelector('[data-testid="font-family-select"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="style-source-opacity-slider"]')).not.toBeNull();
  });
});
