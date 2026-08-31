import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseLcovLineCoverage, verifyMobileCoverage } from "./verify-mobile-coverage.mjs";

describe("mobile coverage gate", () => {
  it("parses LCOV line totals by source file", () => {
    assert.deepEqual(
      parseLcovLineCoverage("SF:lib/src/companion_controller.dart\nLF:10\nLH:9\nend_of_record\n"),
      new Map([["lib/src/companion_controller.dart", { found: 10, hit: 9 }]]),
    );
  });

  it("accepts every mobile boundary at or above its threshold", () => {
    assert.deepEqual(
      verifyMobileCoverage({
        content:
          "SF:lib/main.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/companion_connection.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/companion_controller.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/companion_l10n.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/companion_pairing.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/companion_style.dart\nLF:20\nLH:19\nend_of_record\n" +
          "SF:lib/src/native_processing.dart\nLF:20\nLH:20\nend_of_record\n",
      }).map(({ path, found, hit }) => ({ path, found, hit })),
      [
        { path: "lib/main.dart", found: 20, hit: 19 },
        { path: "lib/src/companion_connection.dart", found: 20, hit: 19 },
        { path: "lib/src/companion_controller.dart", found: 20, hit: 19 },
        { path: "lib/src/companion_l10n.dart", found: 20, hit: 19 },
        { path: "lib/src/companion_pairing.dart", found: 20, hit: 19 },
        { path: "lib/src/companion_style.dart", found: 20, hit: 19 },
        { path: "lib/src/native_processing.dart", found: 20, hit: 20 },
      ],
    );
  });

  it("rejects coverage below the configured threshold", () => {
    assert.throws(
      () =>
        verifyMobileCoverage({
          content:
            "SF:lib/main.dart\nLF:20\nLH:20\nend_of_record\n" +
            "SF:lib/src/companion_connection.dart\nLF:20\nLH:18\nend_of_record\n" +
            "SF:lib/src/companion_controller.dart\nLF:20\nLH:20\nend_of_record\n" +
            "SF:lib/src/native_processing.dart\nLF:20\nLH:20\nend_of_record\n",
        }),
      /companion_connection\.dart line coverage 90\.0% is below 95\.0%/u,
    );
  });

  it("rejects a missing mobile boundary", () => {
    assert.throws(
      () =>
        verifyMobileCoverage({
          content: "SF:lib/main.dart\nLF:10\nLH:10\nend_of_record\n",
        }),
      /mobile coverage is missing lib\/src\/companion_connection\.dart/u,
    );
  });
});
