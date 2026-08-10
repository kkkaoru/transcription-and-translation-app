// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../core/defaults";
import { I18nProvider } from "../i18n/I18nProvider";
import { FontFamilyCombobox } from "./FontFamilyCombobox";
import { NumberSliderField } from "./NumberSliderField";
import { TextStyleEditor } from "./TextStyleEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("filters font families through the searchable combobox", async () => {
    const onChange = vi.fn();
    await act(() => {
      root.render(<FontFamilyCombobox label="Font" value="Noto Sans JP" onChange={onChange} />);
    });
    const input = host.querySelector<HTMLInputElement>('[data-testid="font-family-combobox"]');
    if (!input) throw new Error("missing combobox");
    await act(() => {
      input.focus();
      setInputValue(input, "helve");
    });
    const options = host.querySelector('[data-testid="font-family-options"]');
    expect(options?.textContent).toContain("Helvetica Neue");
    const helvetica = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
    ).find((button) => button.textContent === "Helvetica Neue");
    await act(() => {
      helvetica?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Helvetica Neue");
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
    expect(host.querySelector('[data-testid="font-family-combobox"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="style-source-opacity-slider"]')).not.toBeNull();
  });
});
