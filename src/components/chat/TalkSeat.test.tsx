import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const mockIpc = { createTerminal: vi.fn() };
vi.mock("../../lib/ipc", () => ({ ipc: mockIpc }));

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useTerminalLayoutStore, EMPTY_TALK_SEAT } = await import("../../stores/terminalLayoutStore");
const { useTerminalSlotsStore } = await import("../../stores/terminalSlotsStore");
const { TalkSeat } = await import("./TalkSeat");

const WS = "ws-talk";
const seat = () => useTerminalLayoutStore.getState().getTalk(WS);

function seed(ids: string[], talk: Partial<typeof EMPTY_TALK_SEAT>) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: ids.map((id, position) => ({
        id, label: `Label ${id}`, position, running: true, busy: false, restored: false,
        role: "shell" as const, command: null,
      })),
    },
    activeByWs: { [WS]: ids[0] ?? null },
  });
  useTerminalLayoutStore.setState({ talkByWs: { [WS]: { ...EMPTY_TALK_SEAT, ...talk } } });
}

const published = () => Object.values(useTerminalSlotsStore.getState().slots);

function renderSeat(on: { onToggle?: () => void; onPick?: () => void } = {}) {
  return render(
    <TalkSeat workspaceId={WS} onToggle={on.onToggle ?? (() => {})} onPick={on.onPick ?? (() => {})}>
      <textarea data-testid="composer" />
    </TalkSeat>,
  );
}

beforeEach(() => {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {}, setupByTerminal: {} });
  useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, talkByWs: {}, talkFocusedByWs: {}, resizing: false });
  useTerminalSlotsStore.setState({ slots: {}, origin: { left: 0, top: 0 } });
  vi.unstubAllGlobals();
});

const closeSeat = () =>
  act(() => useTerminalLayoutStore.getState().updateTalk(WS, (s) => ({ ...s, open: false })));

describe("TalkSeat", () => {
  it("closed: only the SquareTerminal toggle, with its tooltip, and no slot", () => {
    const onToggle = vi.fn();
    seed(["a"], { terminalId: "a", open: false });
    renderSeat({ onToggle });
    const toggle = screen.getByTestId("talk-seat-toggle");
    expect(toggle.getAttribute("title")).toBe("Open a terminal beside the conversation · ⌘D");
    expect(screen.queryByTestId("talk-seat-divider")).toBeNull();
    expect(published()).toEqual([]);
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("open: the session's slot in Talk, its caption, and Leave the view", () => {
    const onToggle = vi.fn();
    seed(["a", "b"], { terminalId: "b", open: true });
    renderSeat({ onToggle });
    expect(published().map((s) => [s.mode, s.terminalId])).toEqual([["talk", "b"]]);
    expect(screen.getByText("Label b")).toBeTruthy();
    fireEvent.click(screen.getByTestId("talk-seat-leave"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("open with no session: the empty seat, which opens the pairing switcher", () => {
    const onPick = vi.fn();
    seed(["a"], { terminalId: null, open: true });
    renderSeat({ onPick });
    expect(published()).toEqual([]);
    const empty = screen.getByTestId("talk-empty-seat");
    // In Talk, ⌘D closes the seat: the tooltip doesn't offer it.
    expect(empty.getAttribute("title")).toBe("Choose a session for this seat");
    fireEvent.click(empty);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("closing keeps the contents and the slot through the width glide", () => {
    seed(["a"], { terminalId: "a", open: true });
    renderSeat();
    closeSeat();
    expect(screen.getByTestId("talk-seat").style.width).toBe("0px");
    expect(screen.getByTestId("talk-seat-divider")).toBeTruthy();
    expect(screen.getByText("Label a")).toBeTruthy();
    expect(published().map((s) => [s.mode, s.terminalId])).toEqual([["talk", "a"]]);
    // A child's transition ending is not the glide.
    fireEvent.transitionEnd(screen.getByTestId("talk-seat-leave"));
    expect(published()).toHaveLength(1);
    fireEvent.transitionEnd(screen.getByTestId("talk-seat"));
    expect(screen.queryByTestId("talk-seat-divider")).toBeNull();
    expect(published()).toEqual([]);
  });

  it("closing with reduced motion unmounts at once", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }));
    seed(["a"], { terminalId: "a", open: true });
    renderSeat();
    closeSeat();
    expect(screen.queryByTestId("talk-seat-divider")).toBeNull();
    expect(published()).toEqual([]);
  });

  it("switching to a workspace whose seat is closed shows no closing seat", () => {
    seed(["a"], { terminalId: "a", open: true });
    const { rerender } = renderSeat();
    rerender(
      <TalkSeat workspaceId="ws-other" onToggle={() => {}} onPick={() => {}}>
        <textarea data-testid="composer" />
      </TalkSeat>,
    );
    expect(screen.queryByTestId("talk-seat-divider")).toBeNull();
    expect(published()).toEqual([]);
  });

  it("at launch, a restored session never flashes as an empty seat", () => {
    seed([], { terminalId: "a", open: true });
    useTerminalsStore.setState({ terminalsByWs: {} });
    renderSeat();
    expect(screen.queryByTestId("talk-empty-seat")).toBeNull();
    expect(published()).toEqual([]);
    act(() => seed(["a"], { terminalId: "a", open: true }));
    expect(published().map((s) => [s.mode, s.terminalId])).toEqual([["talk", "a"]]);
  });

  it("the divider steps the seat's width, clamped, and evens on double-click", () => {
    seed(["a"], { terminalId: "a", open: true, width: 0.5 });
    renderSeat();
    const divider = screen.getByTestId("talk-seat-divider");
    expect(divider.getAttribute("aria-label")).toBe("Resize the panes");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(seat().width).toBeCloseTo(0.55);
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(seat().width).toBeCloseTo(0.54);
    fireEvent.doubleClick(divider);
    expect(seat().width).toBe(0.5);
  });

  it("the conversation taking focus takes it from the seat, never touching Run", () => {
    seed(["a"], { terminalId: "a", open: true });
    useTerminalLayoutStore.setState({ talkFocusedByWs: { [WS]: true, other: true } });
    renderSeat();
    act(() => screen.getByTestId("composer").focus());
    expect(useTerminalLayoutStore.getState().talkFocusedByWs).toEqual({ [WS]: false, other: true });
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");
  });
});
