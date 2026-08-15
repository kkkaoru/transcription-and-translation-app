import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  buildPortableDictionaryArchive,
  packPortableDictionary,
  verifyPortableDictionaryArchive,
} from "./build-azookey-dictionary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "packages/azookey-wasm/Cargo.toml");
const source = resolve(
  root,
  "packages/azookey-wasm/target/wasm32-unknown-unknown/release/caption_bridge_azookey_wasm.wasm",
);
const destination = resolve(root, "apps/cloudflare-worker-server/wasm/azookey.wasm");
export const AZOOKEY_WASM_SOURCE_DIGEST_PATH =
  "apps/cloudflare-worker-server/wasm/azookey.source.sha256";
const sourceDigestDestination = resolve(root, AZOOKEY_WASM_SOURCE_DIGEST_PATH);
const SOURCE_INPUT_PATHS = [
  "packages/azookey-rust",
  "packages/azookey-wasm",
  "Cargo.lock",
  "rust-toolchain.toml",
  "scripts/build-azookey-wasm.mjs",
];

// Non-production inputs under the tracked prefixes. Keep auto-discovery, but
// never force a WASM rebuild when only tests/examples/fixtures change.
export const azookeyWasmSourceDigestExclusions = new Map([
  ["packages/azookey-rust/examples/", "example binaries are not inputs to the published wasm"],
  ["packages/azookey-rust/testdata/", "test fixtures are not inputs to the published wasm"],
  [
    "packages/azookey-rust/src/kana_kanji/accuracy_corpus.rs",
    "cfg(test)-only module; not linked into wasm release",
  ],
  [
    "packages/azookey-rust/src/kana_kanji/adversarial_corpus.rs",
    "cfg(test)-only module; not linked into wasm release",
  ],
  [
    "packages/azookey-rust/src/kana_kanji/dict_row_inventory.rs",
    "cfg(test)-only module; not linked into wasm release",
  ],
]);

const isExcludedAzookeyWasmSourcePath = (path) => {
  if (path === AZOOKEY_WASM_SOURCE_DIGEST_PATH) return true;
  for (const [excluded, reason] of azookeyWasmSourceDigestExclusions) {
    if (!reason.trim()) throw new Error(`AzooKey WASM digest exclusion has no reason: ${excluded}`);
    if (path === excluded || path.startsWith(excluded)) return true;
  }
  return false;
};

const gitPaths = (repositoryRoot, args) =>
  execFileSync("git", ["-C", repositoryRoot, "ls-files", "-z", ...args], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

export const calculateAzookeyWasmSourceDigest = (repositoryRoot = root) => {
  const untracked = gitPaths(repositoryRoot, [
    "--others",
    "--exclude-standard",
    "--",
    ...SOURCE_INPUT_PATHS,
  ]);
  if (untracked.length > 0) {
    throw new Error(
      `untracked AzooKey WASM source inputs cannot be recorded; git add them first: ${untracked.join(", ")}`,
    );
  }
  const paths = gitPaths(repositoryRoot, ["--", ...SOURCE_INPUT_PATHS]).filter(
    (path) => !isExcludedAzookeyWasmSourcePath(path),
  );
  const aggregate = createHash("sha256");
  for (const path of paths) {
    const bytes = readFileSync(resolve(repositoryRoot, path));
    const blob = createHash("sha256")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    aggregate.update(`${Buffer.byteLength(path)}:${path}\0${blob}\n`);
  }
  return { sha256: aggregate.digest("hex"), paths };
};

export const reproducibleRustFlags = ({ repositoryRoot, rustSysroot }) => [
  `--remap-path-prefix=${realpathSync(repositoryRoot)}=.`,
  `--remap-path-prefix=${realpathSync(rustSysroot)}=rust-toolchain`,
];

const rustBuildEnvironment = (repositoryRoot) => {
  const rustSysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  const flags = reproducibleRustFlags({ repositoryRoot, rustSysroot });
  return {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: [process.env.CARGO_ENCODED_RUSTFLAGS, ...flags]
      .filter(Boolean)
      .join("\x1f"),
  };
};

export const buildAzookeyWasm = () => {
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      manifest,
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
    { cwd: root, env: rustBuildEnvironment(root), stdio: "inherit" },
  );
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceDigest = calculateAzookeyWasmSourceDigest(root);
  writeFileSync(sourceDigestDestination, `${sourceDigest.sha256}\n`);
  console.log(`Built ${destination} (source sha256=${sourceDigest.sha256})`);
  const dictionaryRoot = resolve(root, "submodules/azooKey_dictionary_storage/Dictionary");
  const dictionaryAvailable = existsSync(resolve(dictionaryRoot, "louds/charID.chid"));
  let dictionary;
  if (!dictionaryAvailable) {
    dictionary = verifyPortableDictionaryArchive();
  } else {
    // Keep the checked-in gzip as the canonical distribution artifact. Deflate
    // output can differ between Node/zlib versions even when the packed source
    // bytes are identical, so do not rewrite the tracked archive on every CI
    // typecheck. A raw-byte mismatch still regenerates the archive and makes the
    // asset hash check fail until the intentional dictionary update is recorded.
    const packedSource = packPortableDictionary(dictionaryRoot);
    let packedArchive;
    try {
      packedArchive = gunzipSync(
        readFileSync(
          resolve(root, "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz"),
        ),
      );
    } catch {
      packedArchive = null;
    }
    dictionary =
      packedArchive && Buffer.compare(packedSource, packedArchive) === 0
        ? verifyPortableDictionaryArchive()
        : buildPortableDictionaryArchive();
  }
  if (!dictionaryAvailable) {
    console.warn(
      "AzooKey dictionary submodule is not initialized; using the verified checked-in archive. " +
        "Run `git submodule update --init submodules/azooKey_dictionary_storage` to rebuild it.",
    );
  }
  console.log(
    `Built ${dictionary.destination} (${dictionary.compressedBytes} bytes, sha256=${dictionary.sha256})`,
  );
  const comparePublicAzookey = resolve(root, "apps/azookey-compare/public/azookey");
  const workerLicense = resolve(root, "apps/cloudflare-worker-server/public/azookey/LICENSE");
  mkdirSync(comparePublicAzookey, { recursive: true });
  copyFileSync(destination, resolve(comparePublicAzookey, "azookey.wasm"));
  copyFileSync(
    resolve(root, "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz"),
    resolve(comparePublicAzookey, "system.azkdict.gz"),
  );
  if (existsSync(workerLicense)) {
    copyFileSync(workerLicense, resolve(comparePublicAzookey, "LICENSE"));
  }
  console.log(`Copied AzooKey browser assets to ${comparePublicAzookey}`);
};

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) buildAzookeyWasm();
