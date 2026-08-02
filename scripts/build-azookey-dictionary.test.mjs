import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  AZOOKEY_DICTIONARY_ARCHIVE_SHA256,
  AZOOKEY_DICTIONARY_REVISION,
  PORTABLE_DICTIONARY_MAGIC,
  packPortableDictionary,
} from "./build-azookey-dictionary.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const dictionaryRepository = join(repositoryRoot, "submodules/azooKey_dictionary_storage");
const dictionaryRoot = join(dictionaryRepository, "Dictionary");
const trackedArchive = join(
  repositoryRoot,
  "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz",
);
const EXPECTED_FILE_COUNT = 2_063;
const EXPECTED_ARCHIVE_SHA256 = AZOOKEY_DICTIONARY_ARCHIVE_SHA256;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("portable AzooKey dictionary build", () => {
  it("pins the upstream revision and produces the tracked deterministic asset", () => {
    const sourceAvailable = existsSync(join(dictionaryRoot, "louds/charID.chid"));
    const trackedCompressed = readFileSync(trackedArchive);
    let packed;
    if (sourceAvailable) {
      const revision = execFileSync("git", ["-C", dictionaryRepository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      assert.equal(revision, AZOOKEY_DICTIONARY_REVISION);

      packed = packPortableDictionary(dictionaryRoot);
      assert.deepEqual(
        packed.subarray(0, PORTABLE_DICTIONARY_MAGIC.length),
        PORTABLE_DICTIONARY_MAGIC,
      );
      assert.equal(packed.readUInt32LE(PORTABLE_DICTIONARY_MAGIC.length), EXPECTED_FILE_COUNT);
    } else {
      // A clean clone has only the pinned gitlink. Verify that git still points
      // at the revision used to produce the checked-in archive, then validate
      // the archive itself without requiring a network fetch in the test.
      const gitlink = execFileSync(
        "git",
        ["-C", repositoryRoot, "ls-tree", "HEAD", "submodules/azooKey_dictionary_storage"],
        { encoding: "utf8" },
      ).trim();
      assert.match(gitlink, new RegExp(`\\b${AZOOKEY_DICTIONARY_REVISION}\\b`));
      packed = gunzipSync(trackedCompressed);
    }
    // Gzip's deflate implementation can change between Node/zlib releases and
    // across CI operating systems. Compare the canonical decompressed archive
    // bytes for source checkouts, while separately pinning the checked-in gzip
    // bytes by hash. This keeps the generated asset reproducible without
    // making a clean CI run depend on one runner's compression library.
    assert.deepEqual(gunzipSync(trackedCompressed), packed);
    assert.equal(sha256(trackedCompressed), EXPECTED_ARCHIVE_SHA256);
    assert.deepEqual([...trackedCompressed.subarray(4, 8)], [0, 0, 0, 0]);
  });
});
