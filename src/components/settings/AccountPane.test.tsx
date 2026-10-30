/**
 * Settings → Account › Sync — cloud sync is OPT-IN. Both toggles render off by
 * default, are actionable only for Pro, call the setter, and say plainly that
 * turning sync off doesn't delete what's already on Octopush's servers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Entitlement } from "../../lib/ipc";

const getSyncPrefs = vi.fn();
const setSyncPref = vi.fn();
const PRO: Entitlement = {
  plan: "pro",
  features: ["history.sync", "library.sync"],
  directRunsPerMonth: null,
};
const FREE: Entitlement = { plan: "free", features: [], directRunsPerMonth: 25 };
let entitlement: Entitlement = PRO;

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSyncPrefs: (...a: unknown[]) => getSyncPrefs(...a),
    setSyncPref: (...a: unknown[]) => setSyncPref(...a),
    authStatus: () => Promise.resolve({ signedIn: true, email: "a@b.c", name: "A" }),
    authRefresh: () => Promise.resolve({ signedIn: true, email: "a@b.c", name: "A" }),
    getEntitlement: () => Promise.resolve(entitlement),
    directRunUsage: () => Promise.resolve({ used: 0, limit: null }),
  },
}));

import { AccountPane, SYNC_COPY } from "./AccountPane";
import { useAuthStore } from "../../stores/authStore";
import { useEntitlementStore } from "../../stores/entitlementStore";
import { useSyncPrefsStore } from "../../stores/syncPrefsStore";

function setup(plan: "pro" | "free") {
  entitlement = plan === "pro" ? PRO : FREE;
  useAuthStore.setState({
    status: { signedIn: true, email: "a@b.c", name: "A" },
    loaded: true,
  });
  useEntitlementStore.setState({ entitlement, loaded: true, usage: null });
}

beforeEach(() => {
  useSyncPrefsStore.setState({
    historySync: false,
    librarySync: false,
    loaded: false,
    saving: null,
    error: null,
  });
  // A user who never chose: the backend answers off/off.
  getSyncPrefs.mockReset().mockResolvedValue({ historySync: false, librarySync: false });
  setSyncPref.mockReset();
});

describe("AccountPane — Sync (opt-in)", () => {
  it("renders both toggles, off by default, with the exact copy", async () => {
    setup("pro");
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    expect(screen.getByText(SYNC_COPY.historyLabel)).toBeInTheDocument();
    expect(screen.getByText(SYNC_COPY.libraryLabel)).toBeInTheDocument();
    expect(screen.getByTestId("sync-history-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("sync-library-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("sync-note")).toHaveTextContent(
      "Turning this off stops future uploads. Data already synced stays on Octopush's servers.",
    );
    // The history description names the heavy detail honestly.
    for (const field of [
      "task",
      "status",
      "cost",
      "tokens",
      "timestamps",
      "workspace and machine name",
      "role and model",
      "journal",
      "artifacts",
      "diff snapshots",
      "500 past runs",
    ]) {
      expect(SYNC_COPY.historyDescription).toContain(field);
    }
  });

  it("turning history sync on calls the setter and reflects the result", async () => {
    setup("pro");
    setSyncPref.mockResolvedValue({ historySync: true, librarySync: false });
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("sync-history-toggle"));
    expect(setSyncPref).toHaveBeenCalledWith("history", true);
    await waitFor(() =>
      expect(screen.getByTestId("sync-history-toggle")).toHaveAttribute("aria-checked", "true"),
    );
    expect(useSyncPrefsStore.getState().historySync).toBe(true);
  });

  it("turning library sync off calls the setter with false", async () => {
    setup("pro");
    getSyncPrefs.mockResolvedValue({ historySync: false, librarySync: true });
    setSyncPref.mockResolvedValue({ historySync: false, librarySync: false });
    render(<AccountPane />);
    await waitFor(() =>
      expect(screen.getByTestId("sync-library-toggle")).toHaveAttribute("aria-checked", "true"),
    );
    fireEvent.click(screen.getByTestId("sync-library-toggle"));
    expect(setSyncPref).toHaveBeenCalledWith("library", false);
  });

  it("Free users see the toggles disabled with a Pro hint, and clicks do nothing", async () => {
    setup("free");
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    const toggle = screen.getByTestId("sync-history-toggle");
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("sync-library-toggle")).toBeDisabled();
    expect(toggle.closest("label")).toHaveAttribute("title", SYNC_COPY.requiresPro);
    fireEvent.click(toggle);
    expect(setSyncPref).not.toHaveBeenCalled();
    expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
  });

  it("a user who lost Pro can still turn an ON toggle OFF (never re-arms silently)", async () => {
    setup("free");
    getSyncPrefs.mockResolvedValue({ historySync: true, librarySync: false });
    setSyncPref.mockResolvedValue({ historySync: false, librarySync: false });
    render(<AccountPane />);
    const toggle = screen.getByTestId("sync-history-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).not.toBeDisabled();
    expect(toggle.closest("label")).toHaveAttribute("title", SYNC_COPY.offOnly);
    // The OFF library toggle stays locked for a Free user.
    expect(screen.getByTestId("sync-library-toggle")).toBeDisabled();
    fireEvent.click(toggle);
    expect(setSyncPref).toHaveBeenCalledWith("history", false);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toBeDisabled(); // off again ⇒ locked again
  });

  it("a failed write keeps the toggle off and says why", async () => {
    setup("pro");
    setSyncPref.mockRejectedValue("offline");
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("sync-history-toggle"));
    await waitFor(() => expect(screen.getByText(/Couldn't change sync/)).toBeInTheDocument());
    expect(screen.getByTestId("sync-history-toggle")).toHaveAttribute("aria-checked", "false");
  });
});
