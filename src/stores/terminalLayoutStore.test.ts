import { describe, it, expect, beforeEach } from "vitest";
import {
  leaveView,
  EMPTY_RUN_LAYOUT,
  assign,
  besideAction,
  besideReplaces,
  besideSlot,
  focus,
  focusedId,
  leave,
  openBeside,
  prune,
  setOrientation,
  setRatios,
  swap,
  touchMru,
  useTerminalLayoutStore,
  type RunLayout,
} from "./terminalLayoutStore";

function layout(slots: (string | null)[], focused = 0): RunLayout {
  return { ...EMPTY_RUN_LAYOUT, slots, focused, ratios: slots.length <= 1 ? [] : slots.length === 2 ? [0.5] : [0.5, 0.5] };
}

describe("terminalLayout reducers", () => {
  it("assign puts a session in a slot and focuses it", () => {
    const next = assign(layout(["A", "B"]), 1, "C");
    expect(next.slots).toEqual(["A", "C"]);
    expect(focusedId(next)).toBe("C");
  });

  it("assign only focuses a session already on screen (one pane per session)", () => {
    const next = assign(layout(["A", "B"], 0), 0, "B");
    expect(next.slots).toEqual(["A", "B"]);
    expect(next.focused).toBe(1);
  });

  it("assign at the slot count appends, never past four", () => {
    expect(assign(layout(["A"]), 1, "B").slots).toEqual(["A", "B"]);
    const full = layout(["A", "B", "C", "D"]);
    expect(assign(full, 4, "E")).toBe(full);
  });

  it("openBeside fills the first empty seat, else appends", () => {
    expect(openBeside(layout(["A", null, "C"]), "B").slots).toEqual(["A", "B", "C"]);
    const appended = openBeside(layout(["A", "B"]), "C");
    expect(appended.slots).toEqual(["A", "B", "C"]);
    expect(appended.focused).toBe(2);
    expect(appended.ratios).toEqual([0.5, 0.5]);
  });

  it("openBeside replaces the focused pane at four with no empty seat", () => {
    expect(openBeside(layout(["A", "B", "C", "D"], 2), "E").slots).toEqual(["A", "B", "E", "D"]);
  });

  it("openBeside of a shown session only focuses it", () => {
    const next = openBeside(layout(["A", "B"], 0), "B");
    expect(next.slots).toEqual(["A", "B"]);
    expect(next.focused).toBe(1);
  });

  it("openBeside(null) adds at most one empty seat and keeps focus", () => {
    const seated = openBeside(layout(["A"]), null);
    expect(seated.slots).toEqual(["A", null]);
    expect(seated.focused).toBe(0);
    expect(openBeside(seated, null)).toBe(seated);
    const full = layout(["A", "B", "C", "D"]);
    expect(openBeside(full, null)).toBe(full);
  });

  it("openBeside honours a lower pane cap", () => {
    expect(openBeside(layout(["A", "B"], 1), "C", 2).slots).toEqual(["A", "C"]);
    const two = layout(["A", "B"]);
    expect(openBeside(two, null, 2)).toBe(two);
  });

  it("besideSlot picks the seat, else the end, else the focused pane", () => {
    expect(besideSlot(layout(["A", null]))).toBe(1);
    expect(besideSlot(layout(["A", "B"]))).toBe(2);
    expect(besideSlot(layout(["A", "B", "C", "D"], 3))).toBe(3);
    expect(besideReplaces(layout(["A", "B", "C", "D"]))).toBe(true);
    expect(besideReplaces(layout(["A", "B", null, "D"]))).toBe(false);
    expect(besideReplaces(layout(["A", "B"]), 2)).toBe(true);
  });

  it("besideAction pairs while a session is hidden, else leaves a seat", () => {
    expect(besideAction(layout(["A"]), true)).toBe("pair");
    expect(besideAction(layout(["A"]), false)).toBe("seat");
    // The seat is already there: the switcher can only open a session into it.
    expect(besideAction(layout(["A", null]), false)).toBe("pair");
    expect(besideAction(layout(["A", "B", "C", "D"]), false)).toBeNull();
    expect(besideAction(layout(["A", "B", "C", "D"]), true)).toBe("pair");
    expect(besideAction(layout([null]), true)).toBeNull();
  });

  it("leave shifts later slots down and hands focus to the next pane", () => {
    const next = leave(layout(["A", "B", "C", "D"], 1), 1);
    expect(next.slots).toEqual(["A", "C", "D"]);
    expect(focusedId(next)).toBe("C");
    expect(focusedId(leave(layout(["A", "B", "C"], 2), 2))).toBe("A");
    expect(focusedId(leave(layout(["A", "B", "C"], 2), 0))).toBe("C");
  });

  it("leave returns to one pane with even dividers, and the last pane empties", () => {
    const one = leave({ ...layout(["A", "B"]), ratios: [0.3] }, 0);
    expect(one.slots).toEqual(["B"]);
    expect(one.ratios).toEqual([]);
    expect(leave(layout(["A"]), 0).slots).toEqual([null]);
  });

  it("leaveView beside only empty seats keeps the session on screen and drops the seats", () => {
    const next = leaveView(layout(["A", null], 0), 0);
    expect(next.slots).toEqual(["A"]);
    expect(focusedId(next)).toBe("A");
    // Otherwise it is plain leave.
    expect(leaveView(layout(["A", "B"], 0), 0).slots).toEqual(["B"]);
    expect(leaveView(layout(["A", null], 0), 1).slots).toEqual(["A"]);
  });

  it("swap exchanges two slots and focus follows its session", () => {
    const next = swap(layout(["A", "B", "C"], 0), 0, 2);
    expect(next.slots).toEqual(["C", "B", "A"]);
    expect(focusedId(next)).toBe("A");
  });

  it("focus clamps to the slots and never moves sessions", () => {
    const l = layout(["A", "B"]);
    expect(focus(l, 1).slots).toEqual(["A", "B"]);
    expect(focus(l, 9).focused).toBe(1);
    expect(focus(l, 0)).toBe(l);
  });

  it("setOrientation sets the override", () => {
    expect(setOrientation(layout(["A", "B"]), "stacked").orientation).toBe("stacked");
  });

  it("setRatios clamps to 0.2–0.8 and ignores the wrong number of dividers", () => {
    expect(setRatios(layout(["A", "B", "C"]), [0.05, 0.95]).ratios).toEqual([0.2, 0.8]);
    const two = layout(["A", "B"]);
    expect(setRatios(two, [0.4, 0.4])).toBe(two);
    expect(setRatios(two, [Number.NaN])).toBe(two);
  });

  it("prune drops slots whose sessions are gone, as leaving does", () => {
    const next = prune(layout(["A", "B", "C"], 1), (id) => id !== "B");
    expect(next.slots).toEqual(["A", "C"]);
    expect(focusedId(next)).toBe("C");
    expect(prune(layout(["A"]), () => false).slots).toEqual([null]);
  });

  it("touchMru moves a session to the front", () => {
    expect(touchMru(["A", "B", "C"], "C")).toEqual(["C", "A", "B"]);
  });
});

describe("terminalLayoutStore", () => {
  beforeEach(() => useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, resizing: false }));

  it("records the focused session as most recently used", () => {
    const s = useTerminalLayoutStore.getState();
    s.commitRun("ws", layout(["A"]));
    s.commitRun("ws", layout(["B"]));
    s.commitRun("ws", layout(["A", "B"], 1));
    expect(useTerminalLayoutStore.getState().getMru("ws")).toEqual(["B", "A"]);
  });

  it("finds the most recent session that is not on screen", () => {
    const s = useTerminalLayoutStore.getState();
    s.commitRun("ws", layout(["C"]));
    s.commitRun("ws", layout(["B"]));
    s.commitRun("ws", layout(["A"]));
    const exists = (id: string) => id !== "B";
    expect(useTerminalLayoutStore.getState().recentNotShown("ws", exists)).toBe("C");
    s.forget("ws", "C");
    expect(useTerminalLayoutStore.getState().recentNotShown("ws", exists)).toBeNull();
  });
});
