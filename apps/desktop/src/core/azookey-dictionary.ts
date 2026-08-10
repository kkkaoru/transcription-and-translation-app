/**
 * Preset sources for the AzooKey system dictionary.
 *
 * The desktop pipeline accepts either an empty path (auto-provision the pinned
 * public dictionary on capture), a local Dictionary root, or an HTTPS archive
 * URL that is downloaded into the app cache.
 */

/** Pinned official archive — keep in sync with `azookey_runtime::DICTIONARY_ARCHIVE_URL`. */
export const OFFICIAL_AZOOKEY_DICTIONARY_URL =
  "https://codeload.github.com/AzooKey/azooKey_dictionary_storage/tar.gz/4d418525b090cf49c219819d05a7e3cc2a4346eb";

export type AzooKeySystemDictionarySource = "builtin" | "official" | "custom";

export const resolveAzooKeySystemDictionarySource = (
  configuredPath: string | undefined | null,
): AzooKeySystemDictionarySource => {
  const value = configuredPath?.trim() ?? "";
  if (!value) {
    return "builtin";
  }
  if (value === OFFICIAL_AZOOKEY_DICTIONARY_URL) {
    return "official";
  }
  return "custom";
};

export const pathForAzooKeySystemDictionarySource = (
  source: AzooKeySystemDictionarySource,
  currentCustomPath = "",
): string => {
  switch (source) {
    case "builtin":
      return "";
    case "official":
      return OFFICIAL_AZOOKEY_DICTIONARY_URL;
    case "custom":
      return currentCustomPath.trim() === OFFICIAL_AZOOKEY_DICTIONARY_URL ? "" : currentCustomPath;
  }
};
