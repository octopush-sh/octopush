import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlameLine } from "../lib/ipc";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: { blameFile: vi.fn() },
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));

import { useBlameStore } from "./blameStore";

const LINES: BlameLine[] = [
  { line: 1, shaShort: "abc1234", authorName: "Ada", timestampMs: 1, summary: "first" },
];

beforeEach(() => {
  vi.clearAllMocks();
  useBlameStore.setState({ enabled: false, linesByPath: {}, errorByPath: {} });
});

describe("blameStore", () => {
  it("toggle flips enabled", () => {
    expect(useBlameStore.getState().enabled).toBe(false);
    useBlameStore.getState().toggle();
    expect(useBlameStore.getState().enabled).toBe(true);
    useBlameStore.getState().toggle();
    expect(useBlameStore.getState().enabled).toBe(false);
  });

  it("load fetches blame with the workspace-relative path and stores by absolute path", async () => {
    ipcMock.blameFile.mockResolvedValue(LINES);
    await useBlameStore.getState().load("/ws", "/ws/src/a.ts");
    expect(ipcMock.blameFile).toHaveBeenCalledWith("/ws", "src/a.ts");
    expect(useBlameStore.getState().linesByPath["/ws/src/a.ts"]).toEqual(LINES);
    expect(useBlameStore.getState().errorByPath["/ws/src/a.ts"]).toBeUndefined();
  });

  it("load failure records a friendly error and clears stale lines", async () => {
    ipcMock.blameFile.mockResolvedValue(LINES);
    await useBlameStore.getState().load("/ws", "/ws/src/a.ts");
    ipcMock.blameFile.mockRejectedValue(new Error("'src/a.ts' has no committed history yet"));
    await useBlameStore.getState().load("/ws", "/ws/src/a.ts");
    const s = useBlameStore.getState();
    expect(s.linesByPath["/ws/src/a.ts"]).toBeUndefined();
    expect(s.errorByPath["/ws/src/a.ts"]).toMatch(/no committed history/);
  });

  it("invalidate drops cached blame for a path", async () => {
    ipcMock.blameFile.mockResolvedValue(LINES);
    await useBlameStore.getState().load("/ws", "/ws/src/a.ts");
    useBlameStore.getState().invalidate("/ws/src/a.ts");
    expect(useBlameStore.getState().linesByPath["/ws/src/a.ts"]).toBeUndefined();
  });
});
