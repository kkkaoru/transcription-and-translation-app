#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export const RUNTIME_DIR_NAMES = ["llama-runtime", "zenz-runtime", "macos-runtime"];

const isRuntimeLibrary = (name) =>
  name.endsWith(".dylib") ||
  name.endsWith(".dll") ||
  name.endsWith(".so") ||
  /\.so\.\d/u.test(name);

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/**
 * Re-apply CMake-style dylib symlink chains from the sidecar resource tree.
 * Tauri's bundler copies symlink targets as regular files, which roughly
 * doubles llama-runtime on macOS.
 */
export const applyTemplateSymlinks = (templateDir, destDir) => {
  let restored = 0;
  if (!existsSync(templateDir) || !existsSync(destDir)) return restored;
  for (const name of readdirSync(templateDir)) {
    const source = join(templateDir, name);
    if (!lstatSync(source).isSymbolicLink()) continue;
    const destination = join(destDir, name);
    const destinationStat = lstatOrNull(destination);
    if (!destinationStat) continue;
    const target = readlinkSync(source);
    if (destinationStat.isSymbolicLink() && readlinkSync(destination) === target) continue;
    unlinkSync(destination);
    symlinkSync(target, destination);
    restored += 1;
  }
  return restored;
};

/**
 * Collapse remaining identical regular libraries (e.g. duplicate ONNX copies)
 * into relative symlinks. The longest name is kept as the real file so
 * versioned dylibs remain the load target.
 */
export const collapseIdenticalLibraries = (dir) => {
  if (!existsSync(dir)) return 0;
  const regular = readdirSync(dir)
    .filter((name) => isRuntimeLibrary(name))
    .map((name) => {
      const full = join(dir, name);
      const stat = lstatSync(full);
      return stat.isFile() && !stat.isSymbolicLink() ? { name, full, size: stat.size } : null;
    })
    .filter(Boolean);

  const bySize = new Map();
  for (const item of regular) {
    const group = bySize.get(item.size) ?? [];
    group.push(item);
    bySize.set(item.size, group);
  }

  let collapsed = 0;
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const hashed = group.map((item) => ({
      ...item,
      hash: createHash("sha256").update(readFileSync(item.full)).digest("hex"),
    }));
    const byHash = new Map();
    for (const item of hashed) {
      const identical = byHash.get(item.hash) ?? [];
      identical.push(item);
      byHash.set(item.hash, identical);
    }
    for (const identical of byHash.values()) {
      if (identical.length < 2) continue;
      identical.sort((left, right) => right.name.length - left.name.length);
      const canonical = identical[0];
      for (const extra of identical.slice(1)) {
        unlinkSync(extra.full);
        symlinkSync(canonical.name, extra.full);
        collapsed += 1;
      }
    }
  }
  return collapsed;
};

export const restoreAppBundleRuntimeSymlinks = (appBundle, templateResourcesDir) => {
  const resources = join(appBundle, "Contents", "Resources");
  if (!existsSync(resources)) return { restored: 0, collapsed: 0 };
  let restored = 0;
  let collapsed = 0;
  for (const name of RUNTIME_DIR_NAMES) {
    const dest = join(resources, name);
    if (templateResourcesDir) {
      restored += applyTemplateSymlinks(join(templateResourcesDir, name), dest);
    }
    collapsed += collapseIdenticalLibraries(dest);
  }
  return { restored, collapsed };
};

export const findMacosAppBundles = (tauriTargetDir) => {
  if (!existsSync(tauriTargetDir)) return [];
  const macosDirs = [join(tauriTargetDir, "release", "bundle", "macos")];
  for (const entry of readdirSync(tauriTargetDir)) {
    macosDirs.push(join(tauriTargetDir, entry, "release", "bundle", "macos"));
  }
  const bundles = [];
  for (const dir of [...new Set(macosDirs)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".app")) bundles.push(join(dir, name));
    }
  }
  return bundles;
};
