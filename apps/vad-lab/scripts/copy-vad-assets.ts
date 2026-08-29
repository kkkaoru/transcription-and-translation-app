// Runs with Bun.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface AssetCopy {
  source: string;
  target: string;
}

const APP_ROOT: string = resolve(import.meta.dir, "..");
const PUBLIC_VAD_PARENT: string = join(APP_ROOT, "public", "vad");
const PUBLIC_VAD_ROOT: string = join(PUBLIC_VAD_PARENT, "vad-web-0.0.30-ort-1.27.0");
const VAD_ENTRY: string = Bun.resolveSync("@ricky0123/vad-web", APP_ROOT);
const ORT_ENTRY: string = Bun.resolveSync("onnxruntime-web/wasm", APP_ROOT);
const VAD_DIST: string = dirname(VAD_ENTRY);
const ORT_DIST: string = dirname(ORT_ENTRY);
const ASSET_NAMES: readonly string[] = [
  "silero_vad_legacy.onnx",
  "vad.worklet.bundle.min.js",
] satisfies readonly string[];
const ORT_ASSET_NAMES: readonly string[] = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
] satisfies readonly string[];

const vadCopies: readonly AssetCopy[] = ASSET_NAMES.map((name) => ({
  source: join(VAD_DIST, name),
  target: join(PUBLIC_VAD_ROOT, name),
}));
const ortCopies: readonly AssetCopy[] = ORT_ASSET_NAMES.map((name) => ({
  source: join(ORT_DIST, name),
  target: join(PUBLIC_VAD_ROOT, name),
}));

const copyAsset = async ({ source, target }: AssetCopy): Promise<void> => copyFile(source, target);

await rm(PUBLIC_VAD_PARENT, { force: true, recursive: true });
await mkdir(PUBLIC_VAD_ROOT, { recursive: true });
await Promise.all([...vadCopies, ...ortCopies].map(copyAsset));
