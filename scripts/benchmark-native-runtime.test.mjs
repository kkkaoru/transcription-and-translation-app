// This file runs with node.

import assert from "node:assert/strict";
import test from "node:test";

import { parseDarwinTime, parseGnuTime } from "./benchmark-native-runtime.mjs";

test("parses macOS process CPU and RSS metrics", () => {
  assert.deepEqual(
    parseDarwinTime(`
        1.25 real         0.80 user         0.20 sys
          12582912  maximum resident set size
`),
    { wallSeconds: 1.25, cpuSeconds: 1, maxRssBytes: 12_582_912 },
  );
});

test("parses GNU process CPU and RSS metrics", () => {
  assert.deepEqual(
    parseGnuTime(`
User time (seconds): 0.70
System time (seconds): 0.10
Elapsed (wall clock) time (h:mm:ss or m:ss): 0:01.20
Maximum resident set size (kbytes): 16384
`),
    { wallSeconds: 1.2, cpuSeconds: 0.8, maxRssBytes: 16_777_216 },
  );
});
