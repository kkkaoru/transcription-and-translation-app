import { describe, expect, it } from "vitest";
import { ARCHITECTURE_DIALOG_QUERY, isArchitectureDialogForced } from "./architecture-dialog";

describe("architecture dialog query", () => {
  it("uses the diagram query key", () => {
    expect(ARCHITECTURE_DIALOG_QUERY).toBe("diagram");
  });

  it("opens for truthy diagram values", () => {
    expect(isArchitectureDialogForced("?diagram=1")).toBe(true);
    expect(isArchitectureDialogForced("diagram=open")).toBe(true);
    expect(isArchitectureDialogForced("?foo=1&diagram=true")).toBe(true);
    expect(isArchitectureDialogForced("?diagram=YES")).toBe(true);
  });

  it("stays closed without a truthy diagram query", () => {
    expect(isArchitectureDialogForced("")).toBe(false);
    expect(isArchitectureDialogForced("?mode=worker-vibrato")).toBe(false);
    expect(isArchitectureDialogForced("?diagram=0")).toBe(false);
    expect(isArchitectureDialogForced("?diagram=false")).toBe(false);
    expect(isArchitectureDialogForced("?diagram=")).toBe(false);
  });
});
