import { useEffect, useMemo, useState } from "react";
import { bridge } from "../core/bridge";

/** Curated families that render Japanese captions reliably on macOS / Windows. */
export const CURATED_CAPTION_FONT_FAMILIES = [
  "Noto Sans JP Variable",
  "Noto Sans JP",
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Yu Gothic UI",
  "Yu Gothic",
  "Meiryo",
  "MS Gothic",
  "Helvetica Neue",
  "Arial",
  "system-ui",
  "sans-serif",
] as const;

type LocalFontLike = { family: string };

/** Browser Local Font Access — optional supplement / non-Tauri fallback. */
export const queryLocalFontFamilies = async (): Promise<string[]> => {
  const query = (
    globalThis as unknown as {
      queryLocalFonts?: () => Promise<LocalFontLike[]>;
    }
  ).queryLocalFonts;
  if (typeof query !== "function") {
    return [];
  }
  try {
    const fonts = await query();
    return [...new Set(fonts.map((font) => font.family).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
  } catch {
    // Permission denial or API failure — caller keeps curated + native lists.
    return [];
  }
};

/** Merge curated, native, Local Font Access, and the current value without capping. */
export const mergeFontFamilyOptions = (
  systemFonts: readonly string[],
  currentValue: string,
): string[] =>
  [...new Set([...CURATED_CAPTION_FONT_FAMILIES, ...systemFonts, currentValue])].filter(Boolean);

/** Collect OS fonts (Tauri) plus optional Local Font Access; never throws. */
export const collectAvailableFontFamilies = async (): Promise<string[]> => {
  // Desktop already enumerates via Tauri — skip browser Local Font Access to avoid
  // a redundant permission prompt in the embedded webview.
  if (bridge.isDesktop()) {
    const nativeFonts = await bridge.listSystemFonts().catch(() => [] as string[]);
    return [...new Set(nativeFonts)].sort((a, b) => a.localeCompare(b));
  }
  const localFonts = await queryLocalFontFamilies();
  return [...new Set(localFonts)].sort((a, b) => a.localeCompare(b));
};

export const FontFamilyCombobox = ({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) => {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    void collectAvailableFontFamilies().then((fonts) => {
      if (mounted) {
        setSystemFonts(fonts);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const options = useMemo(() => mergeFontFamilyOptions(systemFonts, value), [systemFonts, value]);

  return (
    <label className="field wide font-family-combobox">
      <span>{label}</span>
      <select
        data-testid="font-family-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{ fontFamily: value }}
      >
        {options.map((family) => (
          <option key={family} value={family} style={{ fontFamily: family }}>
            {family}
          </option>
        ))}
      </select>
    </label>
  );
};
