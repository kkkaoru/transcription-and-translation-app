import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const PORTABLE_DICTIONARY_MAGIC = Buffer.from("AZKDIC01", "ascii");
export const PORTABLE_DICTIONARY_FILE_LIMIT = 4_096;
export const PORTABLE_DICTIONARY_PATH_LIMIT = 1_024;
export const PORTABLE_DICTIONARY_GZIP_LEVEL = 9;
export const AZOOKEY_DICTIONARY_REVISION = "4d418525b090cf49c219819d05a7e3cc2a4346eb";
export const AZOOKEY_CID_FILE_COUNT = 1_319;
export const AZOOKEY_LOUDS_FILE_COUNT = 160;
export const AZOOKEY_LOUDS_TEXT_FILE_COUNT = 422;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const defaultDictionaryRoot = resolve(
  projectRoot,
  "submodules/azooKey_dictionary_storage/Dictionary",
);
const defaultDestination = resolve(
  projectRoot,
  "apps/cloudflare-worker-server/public/azookey/system.azkdict.gz",
);
const includedRoots = ["cb", "louds"];
const includedFiles = ["mm.binary"];

const walkFiles = (root, current = root) =>
  readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(root, absolute);
    }
    return entry.isFile() ? [relative(root, absolute).split(sep).join("/")] : [];
  });

const sourceFiles = (dictionaryRoot) => {
  const files = includedRoots
    .flatMap((name) => walkFiles(dictionaryRoot, resolve(dictionaryRoot, name)))
    .filter((path) => !path.endsWith("/.gitkeep"));
  files.push(...includedFiles);
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

const validateSource = (dictionaryRoot) => {
  const required = [
    resolve(dictionaryRoot, "louds/charID.chid"),
    resolve(dictionaryRoot, "mm.binary"),
    resolve(dictionaryRoot, "cb/0.binary"),
  ];
  if (!required.every((path) => existsSync(path) && statSync(path).isFile())) {
    throw new Error(
      `AzooKey dictionary is unavailable at ${dictionaryRoot}; initialize the pinned submodule first`,
    );
  }
  const files = sourceFiles(dictionaryRoot);
  const contiguousCids = Array.from(
    { length: AZOOKEY_CID_FILE_COUNT },
    (_, index) => `cb/${index}.binary`,
  );
  const hasPinnedLayout =
    files.filter((path) => /^cb\/\d+\.binary$/.test(path)).length === AZOOKEY_CID_FILE_COUNT &&
    contiguousCids.every((path) => files.includes(path)) &&
    files.filter((path) => path.endsWith(".louds")).length === AZOOKEY_LOUDS_FILE_COUNT &&
    files.filter((path) => path.endsWith(".loudschars2")).length === AZOOKEY_LOUDS_FILE_COUNT &&
    files.filter((path) => path.endsWith(".loudstxt3")).length === AZOOKEY_LOUDS_TEXT_FILE_COUNT;
  if (!hasPinnedLayout) {
    throw new Error("AzooKey dictionary does not match the pinned caption-conversion layout");
  }
};

const encodeFile = (dictionaryRoot, path) => {
  const pathBytes = Buffer.from(path, "utf8");
  const data = readFileSync(resolve(dictionaryRoot, path));
  if (pathBytes.byteLength === 0 || pathBytes.byteLength > PORTABLE_DICTIONARY_PATH_LIMIT) {
    throw new Error(`portable dictionary path is invalid: ${path}`);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(pathBytes.byteLength, 0);
  header.writeUInt32LE(data.byteLength, 2);
  return [header, pathBytes, data];
};

export const packPortableDictionary = (dictionaryRoot) => {
  validateSource(dictionaryRoot);
  const files = sourceFiles(dictionaryRoot);
  if (files.length === 0 || files.length > PORTABLE_DICTIONARY_FILE_LIMIT) {
    throw new Error(`portable dictionary file count is invalid: ${files.length}`);
  }
  const header = Buffer.alloc(12);
  PORTABLE_DICTIONARY_MAGIC.copy(header);
  header.writeUInt32LE(files.length, PORTABLE_DICTIONARY_MAGIC.byteLength);
  return Buffer.concat([header, ...files.flatMap((path) => encodeFile(dictionaryRoot, path))]);
};

export const buildPortableDictionaryArchive = ({
  dictionaryRoot = defaultDictionaryRoot,
  destination = defaultDestination,
} = {}) => {
  const packed = packPortableDictionary(dictionaryRoot);
  const compressed = gzipSync(packed, {
    level: PORTABLE_DICTIONARY_GZIP_LEVEL,
    mtime: 0,
  });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, compressed);
  copyFileSync(resolve(dictionaryRoot, "../LICENSE"), resolve(dirname(destination), "LICENSE"));
  return {
    destination,
    fileCount: packed.readUInt32LE(PORTABLE_DICTIONARY_MAGIC.byteLength),
    packedBytes: packed.byteLength,
    compressedBytes: compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
};

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  const result = buildPortableDictionaryArchive();
  console.log(
    `Built ${result.destination} (${result.fileCount} files, ${result.compressedBytes} bytes, sha256=${result.sha256})`,
  );
}
