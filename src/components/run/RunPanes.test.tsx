import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const mockIpc = {
  createTerminal: vi.fn(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
};
vi.mock("../../lib/ipc", () => ({ ipc: mockIpc }));
const noop = () => {};

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useTerminalLayoutStore, evenRatios, leaveView, setOrientation } = await import("../../stores/terminalLayoutStore");
const { useTerminalSlotsStore } = await import("../../stores/terminalSlotsStore");
const { RunPanes } = await import("./RunPanes");
const { useAttentionStore } = await import("../../stores/attentionStore");

const WS = "ws-panes";
const run = () => useTerminalLayoutStore.getState().getRun(WS);

function seed(ids: string[], slots: (string | null)[], focused = 0) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: ids.map((id, position) => ({
        id, label: `Label ${id}`, position, running: true, busy: false, restored: false,
        role: "shell" as const, command: null,
      })),
    },
  });
  act(() =>
    useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots, focused, ratios: evenRatios(slots.length) })),
  );
}

/** The sessions the slot registry has on screen, in slot order. */
const published = () =>
  Object.values(useTerminalSlotsStore.getState().slots).map((s) => s.terminalId).sort();
/** Every element measures `width` wide: 72 columns of the 7.8px estimate are ≈ 562px. */
const sized = (width: number) =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width, height: 800 } as DOMRect);

beforeEach(() => {
  // A failed test must not leave its measured rect behind for the next one.
  vi.restoreAllMocks();
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {}, setupByTerminal: {} });
  useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, splitByWs: {}, resizing: false });
  useTerminalSlotsStore.setState({ slots: {}, origin: { left: 0, top: 0 } });
  useAttentionStore.setState({ waitingByTerminal: {} });
  vi.clearAllMocks();
  mockIpc.renameTerminal.mockResolvedValue(undefined);
  mockIpc.deleteTerminal.mockResolvedValue(undefined);
});

/** Patch one seeded session's live state. */
const patch = (id: string, fields: Record<string, unknown>) =>
  act(() =>
    useTerminalsStore.setState((s) => ({
      terminalsByWs: { ...s.terminalsByWs, [WS]: s.terminalsByWs[WS].map((t) => (t.id === id ? { ...t, ...fields } : t)) },
    })),
  );

describe("RunPanes", () => {
  it("keeps the caption on a single pane: one slot, no divider, nothing to leave", () => {
    seed(["a", "b"], ["a"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(published()).toEqual(["a"]);
    const caption = screen.getByTestId("run-pane-caption-0");
    expect(caption).toHaveTextContent("Label a");
    expect(caption).toHaveTextContent("shell at the prompt");
    expect(caption.dataset.focused).toBe("true");
    expect(caption.className).toContain("h-8");
    expect(screen.queryByRole("separator")).toBeNull();
    // Leaving is for a split view only.
    expect(screen.queryByTestId("run-pane-leave-0")).toBeNull();

    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    const menu = screen.getByRole("menu", { name: "Session actions" });
    expect(menu.className).toContain("octo-menu-enter");
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Renamedouble-click",
      "Open beside…⌘D",
      "Close session",
    ]);
    expect(menu).not.toHaveTextContent("Swap with");
    expect(menu).not.toHaveTextContent("Leave the view");
  });

  it("shows nothing to name for a lone pane with no session yet", () => {
    seed(["a"], [null]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.queryByTestId("run-pane-caption-0")).toBeNull();
    expect(screen.queryByTestId("run-empty-seat")).toBeNull();
    expect(published()).toEqual([]);
  });

  it("puts two sessions side by side under captions, the focused one ivory; a click focuses", () => {
    seed(["a", "b"], ["a", "b"], 1);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(published()).toEqual(["a", "b"]);
    expect(screen.getByTestId("run-pane-caption-0")).toHaveTextContent("Label a");
    expect(screen.getByTestId("run-pane-caption-0").dataset.focused).toBe("false");
    // Focused: ivory name over a border-strong line. The other: sage, mute icon.
    expect(screen.getByTestId("run-pane-caption-1").className).toContain("var(--color-octo-border-strong)");
    expect(screen.getByTestId("run-pane-name-1").className).toContain("text-octo-ivory");
    expect(screen.getByTestId("run-pane-caption-0").className).not.toContain("border-strong");
    expect(screen.getByTestId("run-pane-name-0").className).toContain("text-octo-sage");
    expect(screen.getByTestId("run-pane-name-0")).toHaveAttribute("aria-pressed", "false");

    // A click on a caption focuses its pane without moving sessions.
    fireEvent.click(screen.getByRole("button", { name: /Label a/ }));
    expect(run().slots).toEqual(["a", "b"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");
  });

  it("marks only the caption of the on-screen pane Claude Code is waiting on", async () => {
    seed(["a", "b"], ["a", "b"], 0);
    act(() => useAttentionStore.getState().setShownWaiting("b", "permission"));
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const marked = screen.getByTestId("run-pane-caption-1");
    expect(marked).toHaveTextContent("waiting on permission");
    // Mute ink with one static brass dot — no pulse.
    const suffix = marked.querySelector("[data-testid='pane-waiting']")!;
    expect(suffix.className).toContain("text-octo-mute");
    expect(suffix.querySelectorAll(".bg-octo-brass")).toHaveLength(1);
    expect(marked.innerHTML).not.toMatch(/pulse|beacon/);
    expect(screen.getByTestId("run-pane-caption-0")).not.toHaveTextContent("waiting");

    // A new reason crossfades in; clearing fades the suffix out.
    act(() => useAttentionStore.getState().setShownWaiting("b", "input"));
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(screen.getByTestId("run-pane-caption-1")).toHaveTextContent("waiting on your input");
    act(() => useAttentionStore.getState().setShownWaiting("b", null));
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(screen.getByTestId("run-pane-caption-1")).not.toHaveTextContent("waiting");
  });

  it("leaves the view with the minus, back to one pane, and keeps the session running", async () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const leave = screen.getByTestId("run-pane-leave-0");
    expect(leave).toHaveAttribute("title", "Leave the view · the session keeps running");
    expect(leave).toHaveAccessibleName("Leave the view");
    expect(leave.querySelector("svg.lucide-minus")).not.toBeNull();
    fireEvent.click(leave);
    expect(run().slots).toEqual(["b"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
    // Nothing was closed: both sessions still exist, and the backend heard nothing.
    expect(useTerminalsStore.getState().getTerminals(WS).map((t) => t.id)).toEqual(["a", "b"]);
    expect(mockIpc.deleteTerminal).not.toHaveBeenCalled();
    // One pane again: its caption stays (the name crossfades), its minus goes.
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(screen.getByTestId("run-pane-caption-0")).toHaveTextContent("Label b");
    expect(screen.queryByTestId("run-pane-leave-0")).toBeNull();
  });

  it("puts no close × on any pane, alone or split", () => {
    const closers = () =>
      screen
        .getAllByTestId(/^run-pane-caption-/)
        .flatMap((c) => Array.from(c.querySelectorAll("button")))
        .filter((b) => /close/i.test(`${b.getAttribute("aria-label")} ${b.title} ${b.textContent}`));
    seed(["a", "b", "c", "d"], ["a"]);
    const { unmount } = render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(closers()).toEqual([]);
    expect(document.querySelector("svg.lucide-x")).toBeNull();
    unmount();

    seed(["a", "b", "c", "d"], ["a", "b", "c", "d"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.getAllByTestId(/^run-pane-caption-/)).toHaveLength(4);
    expect(closers()).toEqual([]);
    expect(document.querySelector("svg.lucide-x")).toBeNull();
  });

  it("closes a session only from its menu, by name", async () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-1"));
    const close = screen.getByRole("menuitem", { name: "Close session" });
    // Quiet until pointed at: sage at rest, rouge on hover.
    expect(close.className).toContain("text-octo-sage");
    expect(close.className).toContain("hover:text-octo-rouge");
    await act(async () => {
      fireEvent.click(close);
    });
    expect(mockIpc.deleteTerminal).toHaveBeenCalledWith("b");
    expect(useTerminalsStore.getState().getTerminals(WS).map((t) => t.id)).toEqual(["a"]);
    expect(run().slots).toEqual(["a"]);
  });

  it("renames in place: double-click, Enter commits, Escape abandons, an empty name is rejected", () => {
    seed(["a", "b"], ["a"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const name = () => screen.getByTestId("run-pane-name-0");
    expect(name()).toHaveAttribute("title", "Label a · double-click to rename");

    fireEvent.doubleClick(name());
    const input = () => screen.getByRole("textbox", { name: "Session name" });
    expect(input()).toHaveValue("Label a");
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: "  API server  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("a", "API server");
    expect(name()).toHaveTextContent("API server");
    // The keyboard gets the name back.
    expect(document.activeElement).toBe(name());

    fireEvent.doubleClick(name());
    fireEvent.change(input(), { target: { value: "thrown away" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(name()).toHaveTextContent("API server");

    fireEvent.doubleClick(name());
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(name()).toHaveTextContent("API server");
    expect(mockIpc.renameTerminal).toHaveBeenCalledTimes(1);
  });

  it("commits a rename when the input loses focus, but not to the pane taking focus as it opens", () => {
    seed(["a", "b"], ["a"]);
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.doubleClick(screen.getByTestId("run-pane-name-0"));
    const input = () => screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input(), { target: { value: "kept" } });
    // 50ms in, the pane hands the keyboard to its terminal: the rename stays.
    now.mockReturnValue(1050);
    fireEvent.blur(input());
    expect(input()).toHaveValue("kept");
    expect(mockIpc.renameTerminal).not.toHaveBeenCalled();
    // Later, the user clicks away: that commits.
    now.mockReturnValue(3000);
    fireEvent.blur(input());
    expect(mockIpc.renameTerminal).toHaveBeenCalledWith("a", "kept");
    expect(screen.getByTestId("run-pane-name-0")).toHaveTextContent("kept");
  });

  it("opens the rename from the menu and with F2", () => {
    seed(["a", "b"], ["a"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue("Label a");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByTestId("run-pane-name-0"), { key: "F2" });
    expect(screen.getByRole("textbox", { name: "Session name" })).toBeInTheDocument();
  });

  it("says what the session is doing: the command while it runs, else its role, and when it didn't start", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const doing = (slot: number) => screen.getByTestId(`run-pane-doing-${slot}`);
    expect(doing(0)).toHaveTextContent("shell at the prompt");
    expect(doing(0).className).toContain("font-mono");
    expect(doing(0).className).toContain("text-octo-mute");

    patch("a", { busy: true, command: "npm run dev", role: "dev" });
    expect(doing(0)).toHaveTextContent("npm run dev");
    expect(doing(0).className).toContain("text-octo-sage");
    // Work never borrows brass.
    const icon = screen.getByTestId("run-pane-caption-0").querySelector("svg")!;
    expect(icon.getAttribute("class")).toContain("text-octo-ivory");
    expect(`${icon.getAttribute("class")} ${doing(0).className}`).not.toContain("brass");

    patch("b", { failed: true, running: false });
    expect(doing(1)).toHaveTextContent("didn't start");
    expect(doing(1).className).toContain("text-octo-rouge");
  });

  it("carries the Restored badge and the jump key", async () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.queryByTestId("run-pane-restored-1")).toBeNull();
    patch("b", { restored: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    const badge = screen.getByTestId("run-pane-restored-1");
    expect(badge).toHaveTextContent("Restored");
    expect(badge).toHaveAttribute("title", "Reattached from the previous Octopush run");

    // The focused pane shows its key; another shows it under the pointer.
    expect(screen.getByTestId("run-pane-jump-0")).toHaveTextContent("⌘⌥1");
    expect(screen.getByTestId("run-pane-jump-0").className).toContain("opacity-100");
    expect(screen.getByTestId("run-pane-jump-1")).toHaveTextContent("⌘⌥2");
    expect(screen.getByTestId("run-pane-jump-1").className).toContain("opacity-0 group-hover/caption:opacity-100");
  });

  it("Open beside… asks for the session to pair; with no room it replaces this pane", () => {
    seed(["a", "b", "c", "d", "e"], ["a", "b"], 0);
    const onOpenBeside = vi.fn();
    render(<RunPanes workspaceId={WS} onOpenBeside={onOpenBeside} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Open beside…/ }));
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    expect(run().focused).toBe(0);

    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b", "c", "d"], ratios: [0.5, 0.5] })));
    fireEvent.click(screen.getByTestId("run-pane-menu-2"));
    expect(screen.queryByRole("menuitem", { name: /Open beside…/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Replace in this pane…/ }));
    expect(onOpenBeside).toHaveBeenCalledTimes(2);
    // The pick replaces the focused pane, so this one took the focus first.
    expect(run().focused).toBe(2);
  });

  it("offers no Open beside when it could do nothing", () => {
    seed(["a", "b", "c", "d"], ["a", "b", "c", "d"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    expect(screen.queryByRole("menuitem", { name: /Open beside|Replace in this pane/ })).toBeNull();
  });

  it("tells the layout button how two panes sit at this width", () => {
    sized(1600);
    seed(["a", "b"], ["a"]);
    const { unmount } = render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(useTerminalLayoutStore.getState().splitByWs[WS]).toBe("side");
    unmount();
    sized(900);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(useTerminalLayoutStore.getState().splitByWs[WS]).toBe("stacked");
  });

  it("swaps from the caption menu (focus stays with its session), and leaves from it", () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    expect(screen.getByRole("menu")).toHaveTextContent("Swap with…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Label b" }));
    expect(run().slots).toEqual(["b", "a"]);
    expect(run().focused).toBe(1);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");

    fireEvent.click(screen.getByTestId("run-pane-menu-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Leave the view/ }));
    expect(run().slots).toEqual(["b"]);
    expect(useTerminalsStore.getState().getTerminals(WS)).toHaveLength(2);
  });

  it("resizes from the keyboard, evens on double-click, and stays within 20–80%", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const divider = screen.getByRole("separator", { name: "Resize the panes" });
    expect(divider).toHaveAttribute("title", "Drag to resize · Double-click to even");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(run().ratios[0]).toBeCloseTo(0.55);
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    expect(run().ratios[0]).toBeCloseTo(0.54);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(run().ratios[0]).toBeCloseTo(0.8);
    fireEvent.doubleClick(divider);
    expect(run().ratios[0]).toBe(0.5);
  });

  it("drags the divider, refitting on frames and telling the PTY only on release", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const divider = screen.getByRole("separator");
    const area = divider.parentElement!;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000 } as DOMRect);
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(true);
    fireEvent.pointerMove(divider, { clientX: 400, pointerId: 1 });
    expect(run().ratios[0]).toBeCloseTo(0.3);
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
  });

  it("an empty seat invites a session: a click opens the switcher, its CTA opens one here", async () => {
    seed(["a"], ["a", null], 0);
    mockIpc.createTerminal.mockResolvedValue({ id: "n", label: "Terminal 2", position: 1 });
    const onOpenBeside = vi.fn();
    render(<RunPanes workspaceId={WS} onOpenBeside={onOpenBeside} />);
    const seat = screen.getByTestId("run-empty-seat");
    expect(seat).toHaveTextContent("Beside");
    expect(seat).toHaveTextContent("Bring a session alongside.");
    expect(published()).toEqual(["a"]);

    fireEvent.click(seat);
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    expect(run().focused).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open a new session here" }));
    });
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    expect(run().slots).toEqual(["a", "n"]);
  });

  it("lays three panes around a large slot 0, with a main and a side divider", () => {
    seed(["a", "b", "c"], ["a", "b", "c"], 2);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(published()).toEqual(["a", "b", "c"]);
    const [main, side] = screen.getAllByRole("separator");
    expect(main).toHaveAttribute("aria-orientation", "vertical");
    expect(side).toHaveAttribute("aria-orientation", "horizontal");
    // The side divider moves with ↑/↓ and leaves the main split alone.
    fireEvent.keyDown(side, { key: "ArrowDown" });
    fireEvent.keyDown(side, { key: "ArrowRight" });
    expect(run().ratios[0]).toBe(0.5);
    expect(run().ratios[1]).toBeCloseTo(0.55);
    fireEvent.doubleClick(side);
    expect(run().ratios).toEqual([0.5, 0.5]);
  });

  it("keeps an orientation override at three panes, and has no layout choices in a pane's menu", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    // Orientation and pane count live on the session line's layout button.
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.getByRole("menu")).not.toHaveTextContent(/Stack|Side by side|Automatic/);
    fireEvent.keyDown(window, { key: "Escape" });

    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => setOrientation(l, "stacked")));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(run().ratios[0]).toBeCloseTo(0.45);

    // The override holds at three panes.
    act(() => useTerminalsStore.getState().openBeside(WS, null));
    expect(screen.getAllByRole("separator")[0]).toHaveAttribute("aria-orientation", "horizontal");
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => setOrientation(l, "auto")));
    expect(screen.getAllByRole("separator")[0]).toHaveAttribute("aria-orientation", "vertical");
  });

  it("never changes orientation on a drag or an even: wide stays side by side", () => {
    sized(1600);
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const divider = () => screen.getByRole("separator");
    expect(divider()).toHaveAttribute("aria-orientation", "vertical");
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1 });
    // 480px is under 72 columns (≈ 562px): the split doesn't decide, the width does.
    fireEvent.pointerMove(divider(), { clientX: 480, pointerId: 1 });
    expect(run().ratios[0]).toBeCloseTo(0.3);
    expect(divider()).toHaveAttribute("aria-orientation", "vertical");
    fireEvent.pointerMove(divider(), { clientX: 720, pointerId: 1 });
    fireEvent.pointerUp(divider(), { pointerId: 1 });
    expect(run().ratios[0]).toBeCloseTo(0.45);
    expect(divider()).toHaveAttribute("aria-orientation", "vertical");
    fireEvent.doubleClick(divider());
    expect(run().ratios[0]).toBe(0.5);
    expect(divider()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("stacks under 72 columns at an even split, and a divider never un-stacks it", () => {
    sized(1100);
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const divider = () => screen.getByRole("separator");
    expect(divider()).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.keyDown(divider(), { key: "ArrowDown" });
    expect(run().ratios[0]).toBeCloseTo(0.55);
    expect(divider()).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.doubleClick(divider());
    expect(divider()).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("decides again when the count changes: narrow three stack, four are the grid", () => {
    sized(1000);
    seed(["a", "b", "c", "d"], ["a", "b", "c"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const orientations = () => screen.getAllByRole("separator").map((d) => d.getAttribute("aria-orientation"));
    expect(orientations()).toEqual(["horizontal", "vertical"]);
    act(() => useTerminalsStore.getState().openBeside(WS, "d"));
    expect(orientations()).toEqual(["vertical", "horizontal"]);
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => leaveView(l, 3)));
    expect(orientations()).toEqual(["horizontal", "vertical"]);
  });

  it("lays the panes out as grid tracks that glide, except during a drag", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const area = screen.getByTestId("run-pane-0").parentElement!;
    expect(area.style.gridTemplateColumns).toBe("0.5fr 0.5fr");
    expect(area.style.gridTemplateRows).toBe("1fr 0fr");
    expect(area.style.transition).toContain("grid-template-rows var(--dur-standard) var(--ease-octo)");
    expect(screen.getByTestId("run-pane-1").style.gridColumn).toBe("2 / 3");

    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, pointerId: 1 });
    expect(area.style.transition).toBe("");
    fireEvent.pointerUp(screen.getByRole("separator"), { pointerId: 1 });
  });

  it("puts four panes in a 2×2 grid with one shared cross and no orientation choice", () => {
    sized(700);
    seed(["a", "b", "c", "d"], ["a", "b", "c", "d"], 3);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    vi.restoreAllMocks();
    expect(published()).toEqual(["a", "b", "c", "d"]);
    // Narrow, yet still the grid: the 72-column rule doesn't apply at four.
    const dividers = screen.getAllByRole("separator");
    expect(dividers.map((d) => d.getAttribute("aria-orientation"))).toEqual(["vertical", "horizontal"]);
    fireEvent.keyDown(dividers[1], { key: "ArrowDown", shiftKey: true });
    expect(run().ratios).toEqual([0.5, 0.51]);
    fireEvent.click(screen.getByTestId("run-pane-menu-3"));
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.getByRole("menu")).toHaveTextContent("Leave the view");

    // Leaving a pane shifts the rest down and lays out three.
    fireEvent.click(screen.getByRole("menuitem", { name: /Leave the view/ }));
    fireEvent.click(screen.getByTestId("run-pane-leave-1"));
    expect(run().slots).toEqual(["a", "c"]);
  });

  it("ends a drag the divider never saw released, so the PTYs get their size again", () => {
    seed(["a", "b"], ["a", "b"]);
    const { unmount } = render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, pointerId: 1 });
    expect(document.body.style.cursor).toBe("col-resize");
    // The view drops to one pane mid-drag.
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a"], focused: 0, ratios: [] })));
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
    expect(document.body.style.cursor).toBe("");

    // And when Run goes away mid-drag.
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b"], ratios: [0.5] })));
    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, pointerId: 1 });
    unmount();
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });
});
