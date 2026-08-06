import { useEffect, useMemo, useState } from "react";

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

const queryLocalFontFamilies = async (): Promise<string[]> => {
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
    return [];
  }
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
  const [query, setQuery] = useState(value);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    let mounted = true;
    void queryLocalFontFamilies().then((fonts) => {
      if (mounted) {
        setSystemFonts(fonts);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const options = useMemo(() => {
    const merged = [...new Set([...CURATED_CAPTION_FONT_FAMILIES, ...systemFonts, value])].filter(
      Boolean,
    );
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return merged;
    }
    return merged.filter((family) => family.toLowerCase().includes(needle));
  }, [query, systemFonts, value]);

  return (
    <label className="field wide font-family-combobox">
      <span>{label}</span>
      <input
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        data-testid="font-family-combobox"
        value={query}
        placeholder={label}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer close so option mousedown can commit first.
          window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setQuery(next);
          setOpen(true);
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && options[0]) {
            event.preventDefault();
            onChange(options[0]);
            setQuery(options[0]);
            setOpen(false);
          }
        }}
      />
      {open && options.length > 0 ? (
        <ul className="font-family-options" role="listbox" data-testid="font-family-options">
          {options.slice(0, 80).map((family) => (
            <li key={family}>
              <button
                type="button"
                role="option"
                aria-selected={family === value}
                style={{ fontFamily: family }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(family);
                  setQuery(family);
                  setOpen(false);
                }}
              >
                {family}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </label>
  );
};
