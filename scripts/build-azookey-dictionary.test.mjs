import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  AZOOKEY_DICTIONARY_REVISION,
  PORTABLE_DICTIONARY_GZIP_LEVEL,
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
const EXPECTED_ARCHIVE_SHA256 = "84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("portable AzooKey dictionary build", () => {
  it("pins the upstream revision and produces the tracked deterministic asset", () => {
    const revision = execFileSync("git", ["-C", dictionaryRepository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(revision, AZOOKEY_DICTIONARY_REVISION);

    const packed = packPortableDictionary(dictionaryRoot);
    assert.deepEqual(
      packed.subarray(0, PORTABLE_DICTIONARY_MAGIC.length),
      PORTABLE_DICTIONARY_MAGIC,
    );
    assert.equal(packed.readUInt32LE(PORTABLE_DICTIONARY_MAGIC.length), EXPECTED_FILE_COUNT);
    const compressed = gzipSync(packed, { level: PORTABLE_DICTIONARY_GZIP_LEVEL, mtime: 0 });
    assert.equal(sha256(compressed), EXPECTED_ARCHIVE_SHA256);
    assert.equal(sha256(readFileSync(trackedArchive)), EXPECTED_ARCHIVE_SHA256);
    assert.deepEqual([...compressed.subarray(4, 8)], [0, 0, 0, 0]);
  });
});
