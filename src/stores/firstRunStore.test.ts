/**
 * firstRunStore — the one-shot "put a crew on it" invite.
 *
 * 1. never-ran → eligible; any prior run → not
 * 2. a failed count read never nags (treated as "ran")
 * 3. dismissed short-circuits the backend check entirely
 * 4. dismiss persists across a store rehydrate; markUsed is session-only
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const countRunsAllTimeMock = vi.fn();
const listProvidersMock = vi.fn();
const getSettingsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    countRunsAllTime: countRunsAllTimeMock,
    listProviders: listProvidersMock,
    getSettings: getSettingsMock,
  },
}));

const { useFirstRunStore, anyProviderReady } = await import("./firstRunStore");

beforeEach(() => {
  localStorage.clear();
  useFirstRunStore.setState({ dismissed: false, usedThisSession: false, everRan: null });
  countRunsAllTimeMock.mockReset();
  listProvidersMock.mockReset();
  getSettingsMock.mockReset();
});

describe("firstRunStore", () => {
  it("marks eligible only when the user has NEVER started a run", async () => {
    countRunsAllTimeMock.mockResolvedValue(0);
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(false);

    useFirstRunStore.setState({ everRan: null });
    countRunsAllTimeMock.mockResolvedValue(3);
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(true);
  });

  it("a failed count read never nags", async () => {
    countRunsAllTimeMock.mockRejectedValue(new Error("offline"));
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(true);
  });

  it("dismissed short-circuits the backend check", async () => {
    useFirstRunStore.setState({ dismissed: true });
    await useFirstRunStore.getState().checkEligibility();
    expect(countRunsAllTimeMock).not.toHaveBeenCalled();
  });

  it("checkEligibility runs the count only once per session", async () => {
    countRunsAllTimeMock.mockResolvedValue(0);
    await useFirstRunStore.getState().checkEligibility();
    await useFirstRunStore.getState().checkEligibility();
    expect(countRunsAllTimeMock).toHaveBeenCalledTimes(1);
  });
});

describe("anyProviderReady", () => {
  it("true for an enabled local provider with no key", async () => {
    listProvidersMock.mockResolvedValue([{ name: "ollama", local: true, enabled: true }]);
    getSettingsMock.mockResolvedValue({ providerKeys: {} });
    expect(await anyProviderReady()).toBe(true);
  });

  it("true for a configured key; false when nothing is ready", async () => {
    listProvidersMock.mockResolvedValue([{ name: "anthropic", local: false, enabled: true }]);
    getSettingsMock.mockResolvedValue({ providerKeys: { anthropic: "sk-x" } });
    expect(await anyProviderReady()).toBe(true);

    getSettingsMock.mockResolvedValue({ providerKeys: { anthropic: "   " } });
    expect(await anyProviderReady()).toBe(false);
  });

  it("false when the read fails (route to Settings, never crash)", async () => {
    listProvidersMock.mockRejectedValue(new Error("boom"));
    expect(await anyProviderReady()).toBe(false);
  });
});
