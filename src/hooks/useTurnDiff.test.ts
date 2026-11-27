/**
 * useTurnDiff (#1152): the This turn scope's diff is `null` while it loads,
 * and a failed read is an error, never an empty diff.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTurnDiff } from "./useTurnDiff";
import { ipc } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({ ipc: { talkTurnDiff: vi.fn() } }));

const TURN = { threadId: "t1", messageId: 7, label: "x" };

beforeEach(() => {
  vi.mocked(ipc.talkTurnDiff).mockReset();
});

describe("useTurnDiff", () => {
  it("is null until the diff lands, then the diff", async () => {
    let land: (d: string) => void = () => {};
    vi.mocked(ipc.talkTurnDiff).mockReturnValue(new Promise<string>((r) => (land = r)));
    const { result } = renderHook(() => useTurnDiff(TURN, false));
    expect(result.current).toBeNull();
    land("diff --git a/x b/x\n");
    await waitFor(() => expect(result.current).toEqual({ diff: "diff --git a/x b/x\n" }));
    expect(ipc.talkTurnDiff).toHaveBeenCalledWith("t1", 7, false);
  });

  it("reports a failed read as an error, not an empty diff", async () => {
    vi.mocked(ipc.talkTurnDiff).mockRejectedValue("other: That conversation no longer exists.");
    const { result } = renderHook(() => useTurnDiff(TURN, false));
    await waitFor(() => expect(result.current).toEqual({ error: "other: That conversation no longer exists." }));
  });

  it("reads nothing without a turn", () => {
    const { result } = renderHook(() => useTurnDiff(null, false));
    expect(result.current).toBeNull();
    expect(ipc.talkTurnDiff).not.toHaveBeenCalled();
  });
});
