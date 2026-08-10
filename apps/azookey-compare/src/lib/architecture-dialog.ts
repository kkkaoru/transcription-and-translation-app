/** Dev query that keeps the architecture `<dialog>` open. */
export const ARCHITECTURE_DIALOG_QUERY = "diagram";

const TRUTHY = new Set(["1", "open", "true", "yes"]);

/** `?diagram=1` / `open` / `true` / `yes` forces the architecture dialog open. */
export const isArchitectureDialogForced = (search: string): boolean => {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const value = new URLSearchParams(query).get(ARCHITECTURE_DIALOG_QUERY)?.trim().toLowerCase();
  return value !== undefined && TRUTHY.has(value);
};
