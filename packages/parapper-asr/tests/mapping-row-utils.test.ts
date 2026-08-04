import { describe, expect, it } from "vitest";

import { updateById, removeById, moveById } from "../src/lib/mapping-row-utils";

type TestRow = { id: string; label: string };

const rows: TestRow[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

describe("updateById", () => {
  it("applies a partial patch to the matching row", () => {
    const updated = updateById(rows, "b", { label: "Updated Beta" });
    expect(updated).toHaveLength(3);
    expect(updated[0]).toEqual({ id: "a", label: "Alpha" });
    expect(updated[1]).toEqual({ id: "b", label: "Updated Beta" });
    expect(updated[2]).toEqual({ id: "c", label: "Gamma" });
  });

  it("returns a new array with the same content when no row matches", () => {
    const updated = updateById(rows, "nonexistent", { label: "Nope" });
    expect(updated).toEqual(rows);
    expect(updated).not.toBe(rows);
  });

  it("does not mutate the original array", () => {
    const snapshot = [...rows];
    updateById(rows, "a", { label: "Changed" });
    expect(rows).toEqual(snapshot);
  });
});

describe("removeById", () => {
  it("removes the row with the matching id", () => {
    const removed = removeById(rows, "b");
    expect(removed).toHaveLength(2);
    expect(removed.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns a new array without mutating the original", () => {
    const snapshot = [...rows];
    removeById(rows, "b");
    expect(rows).toEqual(snapshot);
  });

  it("returns a new array with the same content when no row matches", () => {
    const removed = removeById(rows, "nonexistent");
    expect(removed).toEqual(rows);
    expect(removed).not.toBe(rows);
  });
});

describe("moveById", () => {
  it("moves a row upward (direction -1)", () => {
    const moved = moveById(rows, "b", -1);
    expect(moved.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a row downward (direction 1)", () => {
    const moved = moveById(rows, "b", 1);
    expect(moved.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("does nothing when the row is already at the top and moving up", () => {
    const moved = moveById(rows, "a", -1);
    expect(moved).toBe(rows);
  });

  it("does nothing when the row is already at the bottom and moving down", () => {
    const moved = moveById(rows, "c", 1);
    expect(moved).toBe(rows);
  });

  it("does nothing for a nonexistent id", () => {
    const moved = moveById(rows, "nonexistent", 1);
    expect(moved).toBe(rows);
  });

  it("does not mutate the original array when it does move", () => {
    const snapshot = [...rows];
    moveById(rows, "b", -1);
    expect(rows).toEqual(snapshot);
  });
});
