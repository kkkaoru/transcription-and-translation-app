// This file runs with bun.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ComparePage from "./page";

describe("Cloudflare speech verification page", () => {
  it("exposes one fixed Worker pipeline and one result card", () => {
    const html = renderToStaticMarkup(createElement(ComparePage));

    expect(html).toMatch(/Cloudflare 音声処理パイプライン/);
    expect(html).toMatch(/経路は1つだけです/);
    expect(html).toMatch(/Nova-3/);
    expect(html).toMatch(/Vibrato/);
    expect(html).toMatch(/AzooKey/);
    expect(html).toMatch(/Worker 処理結果とログ/);
    expect(html.match(/class="result-card"/g)?.length).toBe(1);
  });

  it("keeps dynamic Cloudflare cost fields visible before capture", () => {
    const html = renderToStaticMarkup(createElement(ComparePage));

    expect(html).toMatch(/Cloudflare 推定費用/);
    expect(html).toMatch(/Nova-3 \(0.0 秒\)/);
    expect(html).toMatch(/Worker requests \(0\)/);
    expect(html).toMatch(/Worker CPU estimate \(0.0 ms\)/);
    expect(html).toMatch(/\$0.00000000/);
  });
});
