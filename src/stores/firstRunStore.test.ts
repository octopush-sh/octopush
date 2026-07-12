/**
 * firstRunStore — the one-shot "put a crew on it" invite.
 *
 * 1. never-ran → eligible; any prior run → not
 * 2. a failed count read never nags (treated as "ran")
 * 3. dismissed short-circuits the backend check entirely
 * 4. dismiss persists across a store rehydrate; markUsed is session-only
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hasEverStartedRunMock = vi.fn();
const listProvidersMock = vi.fn();
const getSettingsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    hasEverStartedRun: hasEverStartedRunMock,
    listProviders: listProvidersMock,
    getSettings: getSettingsMock,
  },
}));

const { useFirstRunStore, crewProviderReady } = await import("./firstRunStore");

beforeEach(() => {
  localStorage.clear();
  useFirstRunStore.setState({ dismissed: false, usedThisSession: false, everRan: null });
  hasEverStartedRunMock.mockReset();
  listProvidersMock.mockReset();
  getSettingsMock.mockReset();
});

describe("firstRunStore", () => {
  it("marks eligible only when the user has NEVER started a run", async () => {
    hasEverStartedRunMock.mockResolvedValue(false);
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(false);

    useFirstRunStore.setState({ everRan: null });
    hasEverStartedRunMock.mockResolvedValue(true);
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(true);
  });

  it("a failed read never nags", async () => {
    hasEverStartedRunMock.mockRejectedValue(new Error("offline"));
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(true);
  });

  it("dismissed short-circuits the backend check", async () => {
    useFirstRunStore.setState({ dismissed: true });
    await useFirstRunStore.getState().checkEligibility();
    expect(hasEverStartedRunMock).not.toHaveBeenCalled();
  });

  it("checkEligibility reads the signal only once per session", async () => {
    hasEverStartedRunMock.mockResolvedValue(false);
    await useFirstRunStore.getState().checkEligibility();
    await useFirstRunStore.getState().checkEligibility();
    expect(hasEverStartedRunMock).toHaveBeenCalledTimes(1);
  });

  it("a run started via ANY path retires the invite immediately", async () => {
    hasEverStartedRunMock.mockResolvedValue(false);
    await useFirstRunStore.getState().checkEligibility();
    expect(useFirstRunStore.getState().everRan).toBe(false);
    useFirstRunStore.getState().noteRunStarted();
    expect(useFirstRunStore.getState().everRan).toBe(true);
  });
});

describe("crewProviderReady", () => {
  it("requires the ANTHROPIC provider specifically — a lone local provider is not enough", async () => {
    // Feature Factory is all-api on claude-* models; waving an Ollama-only
    // user through means a guaranteed stage-1 failure on their first crew.
    listProvidersMock.mockResolvedValue([{ name: "ollama", local: true, enabled: true }]);
    getSettingsMock.mockResolvedValue({ providerKeys: {} });
    expect(await crewProviderReady()).toBe(false);
  });

  it("true only for an ENABLED anthropic provider with a real key", async () => {
    listProvidersMock.mockResolvedValue([{ name: "anthropic", local: false, enabled: true }]);
    getSettingsMock.mockResolvedValue({ providerKeys: { anthropic: "sk-x" } });
    expect(await crewProviderReady()).toBe(true);

    getSettingsMock.mockResolvedValue({ providerKeys: { anthropic: "   " } });
    expect(await crewProviderReady()).toBe(false);

    listProvidersMock.mockResolvedValue([{ name: "anthropic", local: false, enabled: false }]);
    getSettingsMock.mockResolvedValue({ providerKeys: { anthropic: "sk-x" } });
    expect(await crewProviderReady()).toBe(false);
  });

  it("false when the read fails (route to Settings, never crash)", async () => {
    listProvidersMock.mockRejectedValue(new Error("boom"));
    expect(await crewProviderReady()).toBe(false);
  });
});
