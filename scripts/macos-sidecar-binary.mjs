#!/usr/bin/env node

import { spawnSync } from "node:child_process";

export const parseOtoolRpaths = (otoolOutput) => {
  const rpaths = [];
  let inRpath = false;
  for (const line of otoolOutput.split(/\r?\n/u)) {
    if (/\bcmd LC_RPATH\b/u.test(line)) {
      inRpath = true;
      continue;
    }
    if (inRpath && /^\s*cmd\b/u.test(line)) {
      inRpath = false;
    }
    if (!inRpath) continue;
    const match = /^\s*path\s+(\S+)\s+\(offset\s+\d+\)\s*$/u.exec(line);
    if (match) rpaths.push(match[1]);
  }
  return rpaths;
};

export const isMachineLocalRpath = (rpath) =>
  rpath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(rpath);

export const bundledRuntimeRpaths = (runtimeDirectory) => [
  `@executable_path/${runtimeDirectory}`,
  `@executable_path/../Resources/${runtimeDirectory}`,
];

const run = (label, cmd) => {
  const result = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${label} failed: ${detail || `exit ${result.status ?? "unknown"}`}`);
  }
  return result.stdout || "";
};

export const listMachORpaths = (binary) =>
  parseOtoolRpaths(run(`otool -l ${binary}`, ["otool", "-l", binary]));

export const deleteRpath = (binary, rpath) => {
  run(`delete rpath ${rpath}`, ["install_name_tool", "-delete_rpath", rpath, binary]);
};

export const addRpath = (binary, rpath) => {
  run(`add rpath ${rpath}`, ["install_name_tool", "-add_rpath", rpath, binary]);
};

export const stripMachOBinary = (binary) => {
  run(`strip ${binary}`, ["strip", "-Sx", binary]);
};

/**
 * Drop CMake's absolute build-dir rpaths, keep only bundle-relative ones, and
 * strip local symbols. Sidecars otherwise load dylibs from `.tools/` on the
 * developer machine and ship tens of thousands of unused symbols.
 */
export const finalizeMacSidecarBinary = (binary, runtimeDirectory = "") => {
  const current = listMachORpaths(binary);
  for (const rpath of current.filter(isMachineLocalRpath)) {
    deleteRpath(binary, rpath);
  }
  const remaining = new Set(listMachORpaths(binary));
  if (runtimeDirectory) {
    for (const rpath of bundledRuntimeRpaths(runtimeDirectory)) {
      if (!remaining.has(rpath)) addRpath(binary, rpath);
    }
  }
  stripMachOBinary(binary);
};
