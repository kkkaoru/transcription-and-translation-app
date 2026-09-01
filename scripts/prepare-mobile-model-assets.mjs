import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobileAssets = resolve(repositoryRoot, "apps/mobile/assets");

const models = [
  {
    path: "azookey/models/small/ggml-model-Q5_K_M.gguf",
    sha256: "29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673",
    url: "https://huggingface.co/Miwa-Keita/zenz-v3.2-small-gguf/resolve/c67e03e07d215c869f591b274c1631170d3e11fe/ggml-model-Q5_K_M.gguf",
  },
  {
    path: "azookey/models/xsmall/ggml-model-Q5_K_M.gguf",
    sha256: "00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58",
    url: "https://huggingface.co/Miwa-Keita/zenz-v3.2-xsmall-gguf/resolve/4f5423f0fad41a73b1242eb96fe5c12ae4fdca83/ggml-model-Q5_K_M.gguf",
  },
  {
    path: "asr/reazonspeech-k2-v2/decoder-epoch-99-avg-1.onnx",
    sha256: "58b18211ae06265466bfa17172dab574df94f76c8bcb61a3640c28ba860e4124",
    url: "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/decoder-epoch-99-avg-1.onnx",
  },
  {
    path: "asr/reazonspeech-k2-v2/encoder-epoch-99-avg-1.int8.onnx",
    sha256: "2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d",
    url: "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/encoder-epoch-99-avg-1.int8.onnx",
  },
  {
    path: "asr/reazonspeech-k2-v2/joiner-epoch-99-avg-1.int8.onnx",
    sha256: "49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de",
    url: "https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/joiner-epoch-99-avg-1.int8.onnx",
  },
  {
    path: "quickmt/quickmt-ja-en/model.bin",
    sha256: "d11276f68986d951edc1e5b4b634e00f1f9c493eb14519598be975630965eb47",
    url: "https://huggingface.co/quickmt/quickmt-ja-en/resolve/e9ae594ff322d95254d730867c6166b25fd2c704/model.bin",
  },
];

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const hasExpectedDigest = async (path, expected) => {
  try {
    return (await sha256File(path)) === expected;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const downloadModel = async (model) => {
  const destination = resolve(mobileAssets, model.path);
  if (await hasExpectedDigest(destination, model.sha256)) {
    console.log(`Verified ${model.path}`);
    return;
  }

  const temporary = `${destination}.download`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporary, { force: true });
  console.log(`Downloading ${model.path}`);
  const response = await fetch(model.url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed for ${model.path}: HTTP ${response.status}`);
  }

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    const actual = await sha256File(temporary);
    if (actual !== model.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${model.path}: expected ${model.sha256}, received ${actual}`,
      );
    }
    await rename(temporary, destination);
    console.log(`Prepared ${model.path}`);
  } finally {
    await rm(temporary, { force: true });
  }
};

for (const model of models) await downloadModel(model);
