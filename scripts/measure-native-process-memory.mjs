#!/usr/bin/env node

/** Privacy-safe macOS memory breakdown for a running Native PID. */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const parseByteSize = (value, unit) => {
  const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`unsupported memory unit: ${unit}`);
  }
  return Math.round(Number.parseFloat(value) * multiplier);
};

export const parseFootprint = (output) => {
  const total = output.match(/Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/u);
  if (!total) {
    throw new Error("could not parse process physical footprint");
  }
  const categories = {};
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*([\d.]+)\s*(B|KB|MB|GB)\s+([\d.]+)\s*(B|KB|MB|GB)\s+([\d.]+)\s*(B|KB|MB|GB)\s+\d+\s+(.+?)\s*$/u,
    );
    if (!match) {
      continue;
    }
    const [, dirty, dirtyUnit, clean, cleanUnit, reclaimable, reclaimableUnit, category] = match;
    categories[category] = {
      dirtyBytes: parseByteSize(dirty, dirtyUnit),
      cleanBytes: parseByteSize(clean, cleanUnit),
      reclaimableBytes: parseByteSize(reclaimable, reclaimableUnit),
    };
  }
  return { physicalFootprintBytes: parseByteSize(total[1], total[2]), categories };
};

export const parseMappedRuntime = (output) => {
  const paths = output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  return {
    onnxRuntimeImageCount: new Set(
      paths.filter((path) => /libonnxruntime(?:\.[\d.]+)?\.dylib$/u.test(path)),
    ).size,
    uniDicMapped: paths.some((path) => path.endsWith("/unidic-cwj-3_1_1/system.dic")),
    sherpaRuntimeMapped: paths.some((path) => path.endsWith("/libsherpa-onnx-c-api.dylib")),
  };
};

export const parseVmmapFootprint = (output) => {
  const current = output.match(/^Physical footprint:\s*([\d.]+)(B|K|M|G)$/mu);
  const peak = output.match(/^Physical footprint \(peak\):\s*([\d.]+)(B|K|M|G)$/mu);
  const normalizeUnit = (unit) => (unit === "B" ? "B" : `${unit}B`);
  return {
    physicalFootprintBytes: current ? parseByteSize(current[1], normalizeUnit(current[2])) : null,
    peakPhysicalFootprintBytes: peak ? parseByteSize(peak[1], normalizeUnit(peak[2])) : null,
  };
};

const run = (command, args) => execFileSync(command, args, { encoding: "utf8" });

const main = () => {
  if (process.platform !== "darwin") {
    throw new Error("whole-process memory breakdown currently requires macOS");
  }
  const pid = process.argv[2];
  if (!/^\d+$/u.test(pid ?? "")) {
    throw new Error("usage: node scripts/measure-native-process-memory.mjs <pid>");
  }
  const processSample = run("/bin/ps", ["-p", pid, "-o", "rss=", "-o", "%cpu="])
    .trim()
    .split(/\s+/u);
  if (processSample.length !== 2) {
    throw new Error(`process ${pid} is not running`);
  }
  const footprint = parseFootprint(run("/usr/bin/footprint", ["-p", pid]));
  const vmmap = parseVmmapFootprint(run("/usr/bin/vmmap", ["-summary", pid]));
  const mappedRuntime = parseMappedRuntime(
    run("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "txt", "-Fn"]),
  );
  const selectedCategories = Object.fromEntries(
    [
      "MALLOC_LARGE",
      "MALLOC_SMALL",
      "MALLOC_SMALL (empty)",
      "IOSurface",
      "IOAccelerator (graphics)",
    ]
      .filter((name) => footprint.categories[name] !== undefined)
      .map((name) => [name, footprint.categories[name]]),
  );
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      metric: "native-whole-process-memory",
      pid: Number.parseInt(pid, 10),
      rssBytes: Number.parseInt(processSample[0], 10) * 1024,
      cpuPercent: Number.parseFloat(processSample[1]),
      physicalFootprintBytes: footprint.physicalFootprintBytes,
      vmmapPhysicalFootprintBytes: vmmap.physicalFootprintBytes,
      peakPhysicalFootprintBytes: vmmap.peakPhysicalFootprintBytes,
      categories: selectedCategories,
      mappedRuntime,
      recognizedTextIncluded: false,
      translationTextIncluded: false,
    }),
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
