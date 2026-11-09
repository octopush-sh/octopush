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
const getSyncStatus = vi.fn();
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
    getSyncStatus: (...a: unknown[]) => getSyncStatus(...a),
    authStatus: () => Promise.resolve({ signedIn: true, email: "a@b.c", name: "A" }),
    authRefresh: () => Promise.resolve({ signedIn: true, email: "a@b.c", name: "A" }),
    getEntitlement: () => Promise.resolve(entitlement),
    directRunUsage: () => Promise.resolve({ used: 0, limit: null }),
  },
}));

import { AccountPane, SYNC_COPY, syncRowState } from "./AccountPane";
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
    status: { history: null, library: null },
  });
  // A user who never chose: the backend answers off/off.
  getSyncPrefs.mockReset().mockResolvedValue({ historySync: false, librarySync: false });
  setSyncPref.mockReset();
  getSyncStatus.mockReset().mockResolvedValue({ history: null, library: null });
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

describe("syncRowState — dim only when truly unavailable (#561)", () => {
  const base = { signedIn: true, entitled: true, on: false, saving: false };

  it("an off row a signed-in Pro user can turn on is full ink, no reason", () => {
    expect(syncRowState(base)).toEqual({ disabled: false, busy: false, title: undefined });
    expect(syncRowState({ ...base, on: true })).toEqual({ disabled: false, busy: false, title: undefined });
  });

  it("a write in flight blocks clicks but never dims", () => {
    expect(syncRowState({ ...base, saving: true })).toMatchObject({ disabled: false, busy: true });
  });

  it("dims an off row without the entitlement, with the existing Pro reason", () => {
    expect(syncRowState({ ...base, entitled: false })).toEqual({
      disabled: true, busy: false, title: SYNC_COPY.requiresPro,
    });
  });

  it("dims an off row when signed out, with the existing sign-in reason", () => {
    expect(syncRowState({ ...base, signedIn: false })).toEqual({
      disabled: true, busy: false, title: SYNC_COPY.requiresSignIn,
    });
  });

  it("never dims an ON row it can't re-arm: turning off stays possible", () => {
    expect(syncRowState({ ...base, entitled: false, on: true })).toEqual({
      disabled: false, busy: false, title: SYNC_COPY.offOnly,
    });
  });
});

describe("AccountPane — Sync rows render at full ink for Pro", () => {
  it("off rows aren't dimmed or aria-disabled for a signed-in Pro user", async () => {
    setup("pro");
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    for (const id of ["sync-history-toggle", "sync-library-toggle"]) {
      const toggle = screen.getByTestId(id);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(toggle).not.toBeDisabled();
      const row = toggle.closest("label")!;
      expect(row).not.toHaveClass("opacity-55");
      expect(row).not.toHaveAttribute("aria-disabled");
      expect(row).not.toHaveAttribute("title");
    }
  });

  it("a second click while the first write is pending sends nothing more", async () => {
    setup("pro");
    let resolve!: (v: { historySync: boolean; librarySync: boolean }) => void;
    setSyncPref.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    const toggle = screen.getByTestId("sync-history-toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle.closest("label")).toHaveAttribute("aria-busy", "true");
    expect(toggle.closest("label")).not.toHaveClass("opacity-55");
    fireEvent.click(toggle);
    expect(setSyncPref).toHaveBeenCalledTimes(1);
    resolve({ historySync: true, librarySync: false });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(setSyncPref).toHaveBeenCalledTimes(1);
  });

  it("Free users' off rows stay dimmed", async () => {
    setup("free");
    render(<AccountPane />);
    await waitFor(() => expect(getSyncPrefs).toHaveBeenCalled());
    expect(screen.getByTestId("sync-history-toggle").closest("label")).toHaveClass("opacity-55");
    expect(screen.getByTestId("sync-library-toggle").closest("label")).toHaveClass("opacity-55");
  });
});

describe("AccountPane — last sync attempt under each toggle (#518)", () => {
  const today = () => {
    const d = new Date();
    d.setHours(14, 2, 0, 0);
    return d.toISOString();
  };

  it("shows the last send under an enabled toggle, in muted mono", async () => {
    setup("pro");
    getSyncPrefs.mockResolvedValue({ historySync: true, librarySync: true });
    getSyncStatus.mockResolvedValue({
      history: { at: today(), outcome: "sent", count: 3 },
      library: { at: today(), outcome: "sent", count: 1 },
    });
    render(<AccountPane />);
    const history = await screen.findByTestId("sync-history-status");
    expect(history).toHaveTextContent("Last sent 14:02 · 3 runs");
    expect(history).toHaveClass("font-mono", "text-octo-mute");
    expect(history).toHaveAttribute("data-tour", "settings-account-sync-history-status");
    expect(await screen.findByTestId("sync-library-status")).toHaveTextContent(
      "Last sent 14:02 · 1 item",
    );
  });

  it("a failed attempt reads amber, with or without an HTTP status", async () => {
    setup("pro");
    getSyncPrefs.mockResolvedValue({ historySync: true, librarySync: true });
    getSyncStatus.mockResolvedValue({
      history: { at: today(), outcome: "failed", count: 3, httpStatus: 503 },
      library: { at: today(), outcome: "failed", count: 2 },
    });
    render(<AccountPane />);
    const history = await screen.findByTestId("sync-history-status");
    expect(history).toHaveTextContent(
      "Last attempt failed 14:02 · HTTP 503 · Octopush retries with the next run",
    );
    expect(history).toHaveClass("text-octo-warning");
    const library = await screen.findByTestId("sync-library-status");
    expect(library).toHaveTextContent(
      "Last attempt failed 14:02 · Octopush retries with the next run",
    );
    expect(library).toHaveClass("text-octo-warning");
  });

  it("shows nothing under a toggle that is off, even with a record", async () => {
    setup("pro");
    getSyncPrefs.mockResolvedValue({ historySync: false, librarySync: true });
    getSyncStatus.mockResolvedValue({
      history: { at: today(), outcome: "sent", count: 3 },
      library: null,
    });
    render(<AccountPane />);
    await waitFor(() => expect(getSyncStatus).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("sync-library-toggle")).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByTestId("sync-history-status")).toBeNull();
    // On, but nothing recorded yet: still nothing.
    expect(screen.queryByTestId("sync-library-status")).toBeNull();
  });

  it("an unreadable status shows nothing", async () => {
    setup("pro");
    getSyncPrefs.mockResolvedValue({ historySync: true, librarySync: false });
    getSyncStatus.mockRejectedValue(new Error("boom"));
    render(<AccountPane />);
    await waitFor(() =>
      expect(screen.getByTestId("sync-history-toggle")).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByTestId("sync-history-status")).toBeNull();
  });
});
