// This file runs with bun.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PipelineVisualization from "./PipelineVisualization";

describe("PipelineVisualization", () => {
  it("provides an accessible description before D3 mounts", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineVisualization, { activeStage: "vibrato" }),
    );

    expect(html).toMatch(/role="img"/);
    expect(html).toMatch(/profile Containers, N5 LM, GGUF/);
    expect(html).toMatch(/Worker-owned custom dictionary flow/);
    expect(html).toMatch(/viewBox="0 0 1480 390"/);
  });
});
