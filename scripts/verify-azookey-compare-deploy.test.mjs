import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  activeVersionId,
  COMPARE_ORIGIN,
  DIAGRAM_MARKERS,
  evaluateCompareDeployProof,
  extractNextStaticRefs,
  hasDecimalUsdFormatter,
  isHashedStaticImmutableCacheControl,
  isHtmlEdgeHitWithoutNoStore,
  isHtmlNoStoreCacheControl,
  missingDiagramMarkers,
} from "./verify-azookey-compare-deploy.mjs";

describe("verify-azookey-compare-deploy", () => {
  it("extracts unique Next hashed asset refs", () => {
    assert.equal(COMPARE_ORIGIN, "https://azookey-compare.kaoru.workers.dev");
    assert.deepEqual(
      extractNextStaticRefs(
        `<script src="/_next/static/chunks/app/page-abc.js"></script><link href="/_next/static/css/dd.css"/>`,
      ),
      ["/_next/static/chunks/app/page-abc.js", "/_next/static/css/dd.css"],
    );
  });

  it("detects diagram markers and decimal USD formatter", () => {
    const source = [
      ...DIAGRAM_MARKERS,
      'new Intl.NumberFormat("en-US",{minimumFractionDigits:8,maximumFractionDigits:8})',
    ].join("\n");
    assert.deepEqual(missingDiagramMarkers(source), []);
    assert.equal(hasDecimalUsdFormatter(source), true);
    assert.equal(hasDecimalUsdFormatter("return n.toExponential(2)"), false);
  });

  it("requires HTML no-store and rejects edge HIT without it", () => {
    assert.equal(isHtmlNoStoreCacheControl("no-store"), true);
    assert.equal(isHtmlNoStoreCacheControl("public, max-age=0, must-revalidate"), false);
    assert.equal(isHashedStaticImmutableCacheControl("public, max-age=31536000, immutable"), true);
    assert.equal(
      isHtmlEdgeHitWithoutNoStore({
        cacheControl: "public, max-age=0, must-revalidate",
        cfCacheStatus: "HIT",
      }),
      true,
    );
    assert.equal(
      isHtmlEdgeHitWithoutNoStore({ cacheControl: "no-store", cfCacheStatus: "BYPASS" }),
      false,
    );
  });

  it("reads the 100% wrangler Version ID", () => {
    assert.equal(
      activeVersionId({
        versions: [
          { version_id: "old", percentage: 0 },
          { version_id: "b7729005-d512-4f0b-b4ff-a97a0dd40eaf", percentage: 100 },
        ],
      }),
      "b7729005-d512-4f0b-b4ff-a97a0dd40eaf",
    );
  });

  it("fails when live HTML is still cacheable or markers are missing", () => {
    const failed = evaluateCompareDeployProof({
      activeVersion: "old-id",
      expectVersion: "new-id",
      unauthenticatedHomeStatus: 401,
      htmlCacheControl: "public, max-age=0, must-revalidate",
      htmlCfCacheStatus: "HIT",
      hashedCacheControl: "public, max-age=0, must-revalidate",
      liveSource: "<html>Silero VAD v6</html>",
      localSource: "",
      liveChunkRefs: ["/_next/static/chunks/old.js"],
      localChunkRefs: ["/_next/static/chunks/new.js"],
      requireLive: true,
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.failures.some((item) => item.includes("Version ID")));
    assert.ok(failed.failures.some((item) => item.includes("diagram markers")));
    assert.ok(failed.failures.some((item) => item.includes("no-store")));

    const ok = evaluateCompareDeployProof({
      activeVersion: "new-id",
      expectVersion: "new-id",
      unauthenticatedHomeStatus: 401,
      htmlCacheControl: "no-store",
      htmlCfCacheStatus: "BYPASS",
      hashedCacheControl: "public, max-age=31536000, immutable",
      liveSource: [
        ...DIAGRAM_MARKERS,
        'new Intl.NumberFormat("en-US",{minimumFractionDigits:8})',
      ].join("\n"),
      localSource: [
        ...DIAGRAM_MARKERS,
        'new Intl.NumberFormat("en-US",{minimumFractionDigits:8})',
      ].join("\n"),
      liveChunkRefs: ["/_next/static/chunks/app/page-abc.js"],
      localChunkRefs: ["/_next/static/chunks/app/page-abc.js"],
      requireLive: true,
    });
    assert.deepEqual(ok, { ok: true, failures: [] });
  });
});
