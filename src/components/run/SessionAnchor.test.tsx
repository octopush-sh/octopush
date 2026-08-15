/**
 * Tests for the mode band's session anchor — the Run tail turned into the
 * affordance that makes ⌘⌥K findable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SessionRole } from "../../lib/sessionRole";

vi.mock("../../lib/ipc", () => ({ ipc: {} }));

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useAttentionStore } = await import("../../stores/attentionStore");
const { SessionAnchor } = await import("./SessionAnchor");

const WS = "ws-anchor";

function seed(
  sessions: Array<{ id: string; label: string; role?: SessionRole; busy?: boolean; command?: string }>,
  activeId?: string,
) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: sessions.map((s, i) => ({
        id: s.id,
        label: s.label,
        position: i,
        running: true,
        busy: s.busy ?? false,
        restored: false,
        role: s.role ?? ("shell" as SessionRole),
        command: s.command ?? null,
      })),
    },
    activeByWs: { [WS]: activeId ?? sessions[0]?.id ?? null },
  });
}

beforeEach(() => {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {} });
  useAttentionStore.setState({ flagsByWs: {} });
  vi.clearAllMocks();
});

describe("SessionAnchor", () => {
  it("names the active session and the shortcut that switches it", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "b");
    render(<SessionAnchor workspaceId={WS} onOpen={() => {}} />);

    const anchor = screen.getByTestId("session-anchor");
    expect(anchor.textContent).toContain("dev");
    expect(anchor.textContent).toContain("⌘⌥K");
  });

  it("carries the running command so the band says what the session is doing", () => {
    seed([{ id: "a", label: "dev", role: "dev", busy: true, command: "npm run dev" }]);
    render(<SessionAnchor workspaceId={WS} onOpen={() => {}} />);

    expect(screen.getByTestId("session-anchor").textContent).toContain("npm run dev");
  });

  it("reports another session waiting, but never itself", () => {
    seed([{ id: "a", label: "main" }, { id: "b", label: "dev" }], "a");
    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "b");
    });
    const { rerender } = render(<SessionAnchor workspaceId={WS} onOpen={() => {}} />);
    expect(screen.getByTestId("session-anchor").textContent).toContain("1 waiting");

    act(() => {
      useAttentionStore.getState().ping(WS, "terminal", "a");
    });
    rerender(<SessionAnchor workspaceId={WS} onOpen={() => {}} />);
    expect(screen.getByTestId("session-anchor").textContent).not.toContain("waiting");
  });

  it("opens the switcher on click", () => {
    const onOpen = vi.fn();
    seed([{ id: "a", label: "main" }]);
    render(<SessionAnchor workspaceId={WS} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId("session-anchor"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("renders nothing without a session to anchor", () => {
    seed([]);
    const { container } = render(<SessionAnchor workspaceId={WS} onOpen={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
