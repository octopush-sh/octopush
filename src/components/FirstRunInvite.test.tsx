/**
 * FirstRunInvite — renders only while eligible; CTA hands off; dismiss is
 * a persisted one-shot.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  ipc: { countRunsAllTime: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn() },
}));

const { FirstRunInvite } = await import("./FirstRunInvite");
const { useFirstRunStore } = await import("../stores/firstRunStore");

beforeEach(() => {
  localStorage.clear();
  useFirstRunStore.setState({ dismissed: false, usedThisSession: false, everRan: false });
});

describe("FirstRunInvite", () => {
  it("renders for a never-ran user and fires the CTA", () => {
    const onSendCrew = vi.fn();
    render(<FirstRunInvite onSendCrew={onSendCrew} />);
    expect(screen.getByText("Put a crew on it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send out the crew/i }));
    expect(onSendCrew).toHaveBeenCalled();
  });

  it("hides for users who ever ran, dismissed, or already used it", () => {
    const onSendCrew = vi.fn();
    useFirstRunStore.setState({ everRan: true });
    const a = render(<FirstRunInvite onSendCrew={onSendCrew} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
    a.unmount();

    useFirstRunStore.setState({ everRan: false, usedThisSession: true });
    const b = render(<FirstRunInvite onSendCrew={onSendCrew} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
    b.unmount();

    useFirstRunStore.setState({ usedThisSession: false, everRan: null });
    render(<FirstRunInvite onSendCrew={onSendCrew} />);
    expect(screen.queryByText("Put a crew on it.")).toBeNull(); // unknown ≠ eligible
  });

  it("Not now dismisses persistently", () => {
    render(<FirstRunInvite onSendCrew={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Not now$/i }));
    expect(useFirstRunStore.getState().dismissed).toBe(true);
    expect(screen.queryByText("Put a crew on it.")).toBeNull();
  });
});
