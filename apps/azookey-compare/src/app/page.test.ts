// This file runs with bun.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ComparePage from "./page";

describe("Cloudflare speech verification page", () => {
  it("exposes one fixed Worker pipeline and one result card", () => {
    const html = renderToStaticMarkup(createElement(ComparePage));

    expect(html).toMatch(/Cloudflare 音声処理パイプライン/);
    expect(html).toMatch(/認識結果/);
    expect(html).toMatch(/Nova-3 batch/);
    expect(html).toMatch(/Whisper Large V3 Turbo/);
    expect(html).toMatch(/Zenz v3.2 XSmall GGUF/);
    expect(html).toMatch(/Zenz v3.2 Small GGUF/);
    expect(html).toMatch(/AzooKey カスタム辞書/);
    expect(html).toMatch(/処理経路を展開/);
  });

  it("keeps dynamic Cloudflare cost fields visible before capture", () => {
    const html = renderToStaticMarkup(createElement(ComparePage));

    expect(html).toMatch(/料金と処理時間/);
    expect(html).toMatch(/@cf\/deepgram\/nova-3 \(0.0 秒\)/);
    expect(html).toMatch(/Worker requests \(0\)/);
    expect(html).toMatch(/Vibrato \+ AzooKey Worker CPU \(0.0 ms\)/);
    expect(html).toMatch(/\$0.00000000/);
  });
});
