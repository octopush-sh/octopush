import { describe, it, expect, beforeEach } from "vitest";
import { placements, useTerminalSlotsStore, type SlotEntry } from "./terminalSlotsStore";

const rect = (left: number, top: number, width = 100, height = 50) => ({ left, top, width, height });

describe("placements", () => {
  it("uses only the active mode's slots, relative to the host", () => {
    const slots: Record<string, SlotEntry> = {
      a: { mode: "run", terminalId: "A", rect: rect(110, 220) },
      b: { mode: "talk", terminalId: "B", rect: rect(300, 220) },
    };
    expect(placements(slots, "run", { left: 10, top: 20 })).toEqual({ A: rect(100, 200) });
    expect(placements(slots, "talk", { left: 0, top: 0 })).toEqual({ B: rect(300, 220) });
  });

  it("places nothing outside a terminal mode", () => {
    const slots: Record<string, SlotEntry> = { a: { mode: "run", terminalId: "A", rect: rect(0, 0) } };
    expect(placements(slots, null, { left: 0, top: 0 })).toEqual({});
  });

  it("gives a session one place per mode, even in two modes at once", () => {
    const slots: Record<string, SlotEntry> = {
      a: { mode: "run", terminalId: "A", rect: rect(0, 0) },
      b: { mode: "run", terminalId: "A", rect: rect(500, 0) },
      c: { mode: "talk", terminalId: "A", rect: rect(900, 0) },
    };
    expect(placements(slots, "run", { left: 0, top: 0 })).toEqual({ A: rect(0, 0) });
    expect(placements(slots, "talk", { left: 0, top: 0 })).toEqual({ A: rect(900, 0) });
  });
});

describe("useTerminalSlotsStore", () => {
  beforeEach(() => useTerminalSlotsStore.setState({ slots: {} }));

  it("keeps the same state for an unchanged rect", () => {
    const { publish } = useTerminalSlotsStore.getState();
    publish("k", { mode: "run", terminalId: "A", rect: rect(0, 0) });
    const before = useTerminalSlotsStore.getState().slots;
    publish("k", { mode: "run", terminalId: "A", rect: rect(0, 0) });
    expect(useTerminalSlotsStore.getState().slots).toBe(before);
    publish("k", { mode: "run", terminalId: "A", rect: rect(0, 0, 120) });
    expect(useTerminalSlotsStore.getState().slots.k.rect.width).toBe(120);
  });

  it("withdraws a slot", () => {
    const { publish, withdraw } = useTerminalSlotsStore.getState();
    publish("k", { mode: "run", terminalId: "A", rect: rect(0, 0) });
    withdraw("k");
    expect(useTerminalSlotsStore.getState().slots).toEqual({});
  });
});
