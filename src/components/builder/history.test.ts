import { describe, it, expect } from "vitest";
import {
  createHistory,
  pushSnapshot,
  undo,
  redo,
  canUndo,
  canRedo,
  HISTORY_CAP,
  type GraphSnapshot,
} from "./history";

// Positions are enough to tell snapshots apart — data content is irrelevant here.
function snap(tag: number): GraphSnapshot {
  return { nodes: [{ id: `n${tag}`, type: "stage", position: { x: tag, y: 0 }, data: {} } as never], edges: [] };
}

describe("history", () => {
  it("starts empty: no undo, no redo", () => {
    const h = createHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, snap(0))).toBeNull();
    expect(redo(h, snap(0))).toBeNull();
  });

  it("push → undo restores the pushed snapshot and stashes current for redo", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1)); // state before a mutation that produced snap(2)
    const u = undo(h, snap(2));
    expect(u).not.toBeNull();
    expect(u!.restored).toEqual(snap(1));
    expect(canRedo(u!.stack)).toBe(true);
    const r = redo(u!.stack, u!.restored);
    expect(r!.restored).toEqual(snap(2));
    expect(canUndo(r!.stack)).toBe(true);
  });

  it("a new push clears the redo stack", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1));
    const u = undo(h, snap(2))!;
    const afterPush = pushSnapshot(u.stack, snap(3));
    expect(canRedo(afterPush)).toBe(false);
  });

  it("coalesces consecutive pushes with the same key (one undo step per burst)", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "patch:n1:instructions");
    h = pushSnapshot(h, snap(2), "patch:n1:instructions");
    h = pushSnapshot(h, snap(3), "patch:n1:instructions");
    expect(h.past).toHaveLength(1);
    expect(h.past[0]).toEqual(snap(1));
  });

  it("a different key breaks coalescing", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "patch:n1:instructions");
    h = pushSnapshot(h, snap(2), "patch:n1:customName");
    expect(h.past).toHaveLength(2);
  });

  it("null keys never coalesce", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1));
    h = pushSnapshot(h, snap(2));
    expect(h.past).toHaveLength(2);
  });

  it("undo resets coalescing — the same key pushes again afterwards", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "k");
    const u = undo(h, snap(2))!;
    const h2 = pushSnapshot(u.stack, snap(3), "k");
    expect(h2.past).toHaveLength(1); // past was emptied by undo, then k pushed fresh
    expect(h2.past[0]).toEqual(snap(3));
  });

  it(`caps the stack at ${HISTORY_CAP} snapshots, dropping the oldest`, () => {
    let h = createHistory();
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushSnapshot(h, snap(i));
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toEqual(snap(10));
  });
});
