/**
 * FirstRunInvite — renders only while eligible; CTA hands off; dismiss is
 * a persisted one-shot; a failing readiness check links to the card.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  ipc: { countRunsAllTime: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(), readinessCheck: vi.fn() },
}));

const { FirstRunInvite } = await import("./FirstRunInvite");
const { useFirstRunStore } = await import("../stores/firstRunStore");
const { useReadinessStore } = await import("../stores/readinessStore");
const { ipc } = await import("../lib/ipc");

beforeEach(() => {
  localStorage.clear();
  useFirstRunStore.setState({ dismissed: false, usedThisSession: false, everRan: false });
  useReadinessStore.setState({ checks: null, loading: false, error: null });
  vi.mocked(ipc.readinessCheck).mockReset().mockResolvedValue([]);
});

describe("FirstRunInvite", () => {
  it("renders for a never-ran user and fires the CTA", () => {
    const onSendCrew = vi.fn();
    render(<FirstRunInvite onSendCrew={onSendCrew} onOpenReadiness={vi.fn()} />);
    expect(screen.getByText("Put a crew on it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send out the crew/i }));
    expect(onSendCrew).toHaveBeenCalled();
  });

  it("hides for users who ever ran, dismissed, or already used it", () => {
    const onSendCrew = vi.fn();
    useFirstRunStore.setState({ everRan: true });
    const a = render(<FirstRunInvite onSendCrew={onSendCrew} onOpenReadiness={vi.fn()} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
    a.unmount();

    useFirstRunStore.setState({ everRan: false, usedThisSession: true });
    const b = render(<FirstRunInvite onSendCrew={onSendCrew} onOpenReadiness={vi.fn()} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
    b.unmount();

    useFirstRunStore.setState({ usedThisSession: false, everRan: null });
    render(<FirstRunInvite onSendCrew={onSendCrew} onOpenReadiness={vi.fn()} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull(); // unknown ≠ eligible
    expect(ipc.readinessCheck).not.toHaveBeenCalled(); // no checks for an invite that isn't shown
  });

  it("Not now dismisses persistently", () => {
    render(<FirstRunInvite onSendCrew={vi.fn()} onOpenReadiness={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Not now$/i }));
    expect(useFirstRunStore.getState().dismissed).toBe(true);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
  });

  it("links to the readiness card when a check fails", async () => {
    vi.mocked(ipc.readinessCheck).mockResolvedValue([
      {
        id: "claude",
        label: "Claude Code",
        status: "fail",
        value: "Not found",
        fix: "Install Claude Code, then check again.",
        command: "npm i -g @anthropic-ai/claude-code",
        timedOut: false,
      },
    ]);
    const onOpenReadiness = vi.fn();
    render(<FirstRunInvite onSendCrew={vi.fn()} onOpenReadiness={onOpenReadiness} />);
    expect(await screen.findByText("This Mac isn't ready for a crew yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "See what's missing" }));
    expect(onOpenReadiness).toHaveBeenCalled();
    expect(ipc.readinessCheck).toHaveBeenCalledTimes(1);
  });

  it("shows no readiness link when nothing fails", async () => {
    vi.mocked(ipc.readinessCheck).mockResolvedValue([
      {
        id: "gh",
        label: "GitHub CLI",
        status: "warn",
        value: "Not signed in",
        fix: "Sign gh in so a crew can open its pull request.",
        command: "gh auth login",
        timedOut: false,
      },
    ]);
    render(<FirstRunInvite onSendCrew={vi.fn()} onOpenReadiness={vi.fn()} />);
    await waitFor(() => expect(useReadinessStore.getState().checks).not.toBeNull());
    expect(screen.queryByText("This Mac isn't ready for a crew yet.")).toBeNull();
  });
});
