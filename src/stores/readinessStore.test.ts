import { beforeEach, describe, expect, it, vi } from "vitest";

const { cliVersionMock, readinessMock } = vi.hoisted(() => ({ cliVersionMock: vi.fn(), readinessMock: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { claudeCliVersion: cliVersionMock, readinessCheck: readinessMock } }));

const { useReadinessStore } = await import("./readinessStore");
const { loadClaudeCliVersion, resetClaudeCliVersionCache } = await import("../lib/claudeCli");

beforeEach(() => {
  resetClaudeCliVersionCache();
  cliVersionMock.mockReset();
  readinessMock.mockReset();
  useReadinessStore.setState({ checks: null, checkedAt: null, loading: false, error: null });
});

describe("readinessStore", () => {
  it("a check makes the next surface ask for the Claude Code version again", async () => {
    cliVersionMock.mockResolvedValueOnce({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    cliVersionMock.mockResolvedValueOnce({ version: "2.1.319", floor: "2.1.314", belowFloor: false });
    readinessMock.mockResolvedValue([]);

    expect((await loadClaudeCliVersion())?.version).toBe("2.1.316");
    expect((await loadClaudeCliVersion())?.version).toBe("2.1.316");
    await useReadinessStore.getState().check();
    // The user updated Claude Code; Readiness saw it, so does the launcher.
    expect((await loadClaudeCliVersion())?.version).toBe("2.1.319");
    expect(cliVersionMock).toHaveBeenCalledTimes(2);
  });

  it("asks claude auth status only when the check is explicit", async () => {
    readinessMock.mockResolvedValue([]);
    await useReadinessStore.getState().check();
    expect(readinessMock).toHaveBeenLastCalledWith(false);
    await useReadinessStore.getState().check({ explicit: true });
    expect(readinessMock).toHaveBeenLastCalledWith(true);
  });

  it("forgets the version even when the check itself fails", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    readinessMock.mockRejectedValue(new Error("readiness task failed"));

    await loadClaudeCliVersion();
    await useReadinessStore.getState().check();
    expect(useReadinessStore.getState().error).toContain("readiness task failed");
    await loadClaudeCliVersion();
    expect(cliVersionMock).toHaveBeenCalledTimes(2);
  });
});
