/**
 * Build metadata embedded by Vite at compile time.
 *
 * `dev` is intentionally used for the browser/dev server so the main screen
 * never has an empty version field before a native runtime is available.
 */
declare const __KOTOBA_APP_VERSION__: unknown;
declare const __KOTOBA_BUILD_ID__: unknown;

const readString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

export interface BuildInfo {
  appVersion: string;
  buildId: string;
}

export const BUILD_INFO: BuildInfo = Object.freeze({
  appVersion: readString(
    typeof __KOTOBA_APP_VERSION__ === "undefined" ? undefined : __KOTOBA_APP_VERSION__,
    "0.1.0",
  ),
  buildId: readString(
    typeof __KOTOBA_BUILD_ID__ === "undefined" ? undefined : __KOTOBA_BUILD_ID__,
    "dev",
  ),
});

export const BUILD_ID_PATTERN = /^b\d{17}-(?:[0-9a-f]{7,40}|nogit)-[0-9a-f]{8}$/;

export const isReleaseBuildId = (buildId: string): boolean => BUILD_ID_PATTERN.test(buildId);
