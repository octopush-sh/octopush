/**
 * Tests for Run's session line (the mode band's right track).
 *
 * The line reads terminalsStore, terminalLayoutStore and attentionStore
 * directly, so each test seeds the stores and asserts on what a cell actually
 * shows: presence by ink, focus by the underline's colour, work by its
 * motion, and the "this one rang" dot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { SessionRole } from "../../lib/sessionRole";

const mockIpc = {
  listTerminals: vi.fn(),
  createTerminal: vi.fn(),
  renameTerminal: vi.fn<(id: string, label: string) => Promise<void>>(),
  deleteTerminal: vi.fn<(id: string) => Promise<void>>(),
  listPtySessions: vi.fn(),
};
vi.mock("../../lib/ipc", () => ({ ipc: mockIpc }));

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useAttentionStore } = await import("../../stores/attentionStore");
const { useTerminalLayoutStore, evenRatios } = await import("../../stores/terminalLayoutStore");
const { SessionLine, MAX_CELLS, lineWidth, planLine, visibleSessions } = await import("./SessionLine");

const WS = "ws-line";
const noop = () => {};
const run = () => useTerminalLayoutStore.getState().getRun(WS);

type Seed = {
  id: string;
  label: string;
  role?: SessionRole;
  busy?: boolean;
  command?: string | null;
};

/** Sessions in order, and the panes that show them (default: the first, alone). */
function seed(sessions: Seed[], slots?: (string | null)[], focused = 0) {
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
  });
  const shown = slots ?? [sessions[0]?.id ?? null];
  act(() =>
    useTerminalsStore
      .getState()
      .updateLayout(WS, (l) => ({ ...l, slots: shown, focused, ratios: evenRatios(shown.length) })),
  );
}

const many = (n: number): Seed[] => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, label: `Session ${i + 1}` }));
const cell = (id: string) => screen.getByTestId(`session-cell-${id}`);
const underline = (id: string) => screen.getByTestId(`session-underline-${id}`);
/** Every element reports this client width: the band's track, measured. */
const track = (px: number) => vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(px);

beforeEach(() => {
  vi.restoreAllMocks();
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {}, setupByTerminal: {} });
  useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, splitByWs: {}, resizing: false });
  useAttentionStore.setState({ flagsByWs: {}, waitsByTerminal: {}, waitingByTerminal: {}, soundEnabled: false });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionLine — cells", () => {
  it("shows one cell per session, in session order, with its role icon", () => {
    seed([
      { id: "a", label: "zsh" },
      { id: "b", label: "claude", role: "agent" },
      { id: "c", label: "dev", role: "dev" },
    ]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const cells = within(screen.getByRole("tablist", { name: "Terminal sessions" })).getAllByRole("tab");
    expect(cells.map((c) => c.dataset.testid)).toEqual(["session-cell-a", "session-cell-b", "session-cell-c"]);
    // 24px cells, each holding one glyph.
    for (const c of cells) {
      expect(c.className).toContain("h-6 w-6");
      expect(c.querySelectorAll("svg")).toHaveLength(1);
    }
  });

  it("inks a session by presence: ivory in a pane, mute off screen", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }], ["a", "b"], 0);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(cell("a").className).toContain("text-octo-ivory");
    expect(cell("b").className).toContain("text-octo-ivory");
    expect(cell("c").className).toContain("text-octo-mute");
    // Shown is aria-current; selected is the focused pane's session alone.
    expect(cell("a")).toHaveAttribute("aria-current", "true");
    expect(cell("b")).toHaveAttribute("aria-current", "true");
    expect(cell("c")).not.toHaveAttribute("aria-current");
    expect(cell("a")).toHaveAttribute("aria-selected", "true");
    expect(cell("b")).toHaveAttribute("aria-selected", "false");
  });

  it("colours the underline by focus and moves it by work, independently", () => {
    seed(
      [
        { id: "idle-focused", label: "one" },
        { id: "busy-hidden", label: "two", busy: true, command: "npm test", role: "test" },
        { id: "idle-hidden", label: "three" },
      ],
      ["idle-focused"],
    );
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);

    // Focused and idle: solid brass, no motion.
    expect(underline("idle-focused").className).toContain("bg-octo-brass");
    expect(underline("idle-focused").className).not.toContain("rail-bar-running-x");
    // Busy and not focused: marching, in sage.
    expect(underline("busy-hidden").className).toContain("rail-bar-running-x");
    expect(underline("busy-hidden").className).toContain("[--rail-bar:var(--color-octo-sage)]");
    expect(underline("busy-hidden").className).not.toContain("brass");
    // Neither: nothing drawn, the slot stays reserved.
    expect(underline("idle-hidden").className).toContain("bg-transparent");
    expect(underline("idle-hidden").className).not.toContain("rail-bar-running-x");

    // The focused session starts a command: it marches in brass.
    act(() => useTerminalsStore.getState().setBusy(WS, "idle-focused", true, "cargo build"));
    expect(underline("idle-focused").className).toContain("rail-bar-running-x");
    expect(underline("idle-focused").className).toContain("[--rail-bar:var(--color-octo-brass)]");
    expect(underline("idle-focused").className).not.toContain("bg-octo-brass");
  });

  it("never turns a busy session's icon brass", () => {
    seed([{ id: "a", label: "a", busy: true, command: "npm run dev", role: "dev" }, { id: "b", label: "b", busy: true }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(cell("a").className).not.toMatch(/text-octo-brass/);
    expect(cell("b").className).not.toMatch(/text-octo-brass/);
  });

  it("marks the session that rang with one static brass dot, never the focused one", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }]);
    act(() => useAttentionStore.getState().ping(WS, "terminal", "b"));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const dot = screen.getByTestId("session-bell-b");
    expect(dot.className).toContain("bg-octo-brass");
    expect(dot.className).toContain("h-[5px] w-[5px]");
    expect(dot.className).not.toMatch(/pulse/);
    expect(screen.queryByTestId("session-bell-a")).toBeNull();
    expect(screen.queryByTestId("session-bell-c")).toBeNull();
    // Its name says so: the dot alone is only a colour.
    expect(cell("b")).toHaveAttribute("aria-label", "b — shell at the prompt · rang · ⌘⌥2");

    // Rings in the session in focus are already being looked at.
    act(() => useAttentionStore.getState().ping(WS, "terminal", "a"));
    expect(screen.queryByTestId("session-bell-a")).toBeNull();
  });

  it("marks every session Claude Code's hooks say is waiting, not only the latest", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b", role: "agent" }, { id: "c", label: "c", role: "agent" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    act(() => useAttentionStore.getState().ping(WS, "terminal", "b", "permission"));
    act(() => useAttentionStore.getState().ping(WS, "terminal", "c", "input"));
    expect(screen.getByTestId("session-bell-b")).toHaveAttribute("title", "Claude Code is waiting on you in this session");
    expect(screen.getByTestId("session-bell-c")).toBeInTheDocument();
    expect(cell("b")).toHaveAttribute("aria-label", "b — waiting on permission · ⌘⌥2");
    expect(cell("c")).toHaveAttribute("aria-label", "c — waiting on your input · ⌘⌥3");

    act(() => useAttentionStore.getState().clearWait("c"));
    expect(screen.queryByTestId("session-bell-c")).toBeNull();
    expect(screen.getByTestId("session-bell-b")).toBeInTheDocument();
  });

  it("says the setup is running, then marks a failure with its exit code", () => {
    seed([{ id: "s", label: "setup" }, { id: "m", label: "main" }]);
    useTerminalsStore.setState({ setupByTerminal: { s: { workspaceId: WS, status: "running", exitCode: null } } });
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(cell("s")).toHaveAttribute("aria-label", "setup — setup · running · ⌘⌥1");
    expect(screen.queryByTestId("session-setup-failed-s")).toBeNull();

    act(() => useTerminalsStore.getState().reportSetupExit(WS, "s", 1));
    expect(cell("s")).toHaveAttribute("aria-label", "setup — setup failed · exit 1 · ⌘⌥1");
    const failed = screen.getByTestId("session-setup-failed-s");
    expect(failed.className).toContain("bg-octo-rouge");
    expect(failed).toHaveAttribute("title", "setup failed · exit 1");
  });

  it("says a busy session is running even when the command is unknown", () => {
    seed([{ id: "a", label: "a", busy: true, command: null }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(cell("a")).toHaveAttribute("aria-label", "a — running · ⌘⌥1");
  });
});

describe("SessionLine — the ⌥ peek", () => {
  it("shows icons at rest and the jump numbers while ⌥ is held", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(cell("a").querySelector("svg")).not.toBeNull();
    act(() => void fireEvent.keyDown(window, { key: "Alt", altKey: true }));
    expect(cell("a")).toHaveTextContent("1");
    expect(cell("b")).toHaveTextContent("2");
    expect(cell("a").querySelector("svg")).toBeNull();
    act(() => void fireEvent.keyUp(window, { key: "Alt", altKey: false }));
    expect(cell("a").querySelector("svg")).not.toBeNull();
  });

  it("does not flash the numbers on a bare ⌘, and drops them when the window loses focus", () => {
    seed([{ id: "a", label: "a" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    act(() => void fireEvent.keyDown(window, { key: "Meta", metaKey: true }));
    expect(cell("a").querySelector("svg")).not.toBeNull();
    act(() => void fireEvent.keyDown(window, { key: "Alt", altKey: true }));
    expect(cell("a")).toHaveTextContent("1");
    act(() => void fireEvent.blur(window));
    expect(cell("a").querySelector("svg")).not.toBeNull();
  });
});

describe("SessionLine — click and ⌥-click", () => {
  it("click shows an off-screen session in the focused pane", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }], ["a", "b"], 1);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.click(cell("c"));
    expect(run().slots).toEqual(["a", "c"]);
    expect(run().focused).toBe(1);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("c");
  });

  it("click on a session already on screen only focuses its pane", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }], ["a", "b"], 1);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.click(cell("a"));
    expect(run().slots).toEqual(["a", "b"]);
    expect(run().focused).toBe(0);
  });

  it("⌥-click opens the session beside, up to four panes, then replaces the focused one", () => {
    seed(many(6), ["s1"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.click(cell("s2"), { altKey: true });
    expect(run().slots).toEqual(["s1", "s2"]);
    expect(run().focused).toBe(1);
    fireEvent.click(cell("s3"), { altKey: true });
    fireEvent.click(cell("s4"), { altKey: true });
    expect(run().slots).toEqual(["s1", "s2", "s3", "s4"]);
    // No room left: it takes the focused pane, and no session is closed.
    fireEvent.click(cell("s5"), { altKey: true });
    expect(run().slots).toEqual(["s1", "s2", "s3", "s5"]);
    expect(useTerminalsStore.getState().getTerminals(WS)).toHaveLength(6);
  });

  it("opens a new session from the line's own control", async () => {
    seed([{ id: "a", label: "Main" }]);
    mockIpc.createTerminal.mockResolvedValue({ id: "n", label: "Terminal 2", position: 1 });
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const add = screen.getByRole("button", { name: "Open a new session" });
    expect(add).toHaveAttribute("title", "Open a new session");
    await act(async () => {
      fireEvent.click(add);
    });
    expect(mockIpc.createTerminal).toHaveBeenCalledWith(WS, "Terminal 2");
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("n");
  });
});

describe("SessionLine — the instant label", () => {
  it("gives the cell the label's text as its accessible name, and no native tooltip", () => {
    seed([
      { id: "a", label: "zsh" },
      { id: "b", label: "API server", busy: true, command: "npm run dev", role: "dev" },
    ]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.getByRole("tab", { name: "API server — npm run dev · ⌘⌥2" })).toBe(cell("b"));
    expect(screen.getByRole("tab", { name: "zsh — shell at the prompt · ⌘⌥1" })).toBe(cell("a"));
    expect(cell("b")).not.toHaveAttribute("title");
  });

  it("opens on hover at once: name, what it is doing, the jump key, and nothing to click", () => {
    seed([{ id: "a", label: "zsh" }, { id: "b", label: "API server", busy: true, command: "npm run dev", role: "dev" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.queryByTestId("session-label")).toBeNull();
    fireEvent.mouseEnter(cell("b").parentElement!);
    const label = screen.getByTestId("session-label");
    expect(label).toHaveTextContent("API server");
    expect(label).toHaveTextContent("npm run dev");
    expect(label).toHaveTextContent("⌘⌥2");
    // Hidden from assistive tech (the cell's name carries it), text only.
    expect(label).toHaveAttribute("aria-hidden", "true");
    expect(label.querySelector("button, a, input")).toBeNull();
    expect(label.className).toContain("octo-fade-in");
    expect(label.className).toContain("pointer-events-none");
  });

  it("moves to the next cell without closing, and fades out after the pointer leaves", () => {
    vi.useFakeTimers();
    seed([{ id: "a", label: "first" }, { id: "b", label: "second" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.mouseEnter(cell("a").parentElement!);
    fireEvent.mouseLeave(cell("a").parentElement!);
    fireEvent.mouseEnter(cell("b").parentElement!);
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByTestId("session-label")).toHaveTextContent("second");

    fireEvent.mouseLeave(cell("b").parentElement!);
    act(() => void vi.advanceTimersByTime(90));
    expect(screen.getByTestId("session-label").className).toContain("octo-fade-out");
    act(() => void vi.advanceTimersByTime(130));
    expect(screen.queryByTestId("session-label")).toBeNull();
  });

  it("goes on a click, and when the panes change under it", () => {
    vi.useFakeTimers();
    seed([{ id: "a", label: "first" }, { id: "b", label: "second" }, { id: "c", label: "third" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.mouseEnter(cell("b").parentElement!);
    expect(screen.getByTestId("session-label")).toBeInTheDocument();
    fireEvent.click(cell("b"));
    act(() => void vi.advanceTimersByTime(130));
    expect(screen.queryByTestId("session-label")).toBeNull();

    // A second pane folds the Companion and moves the line: a label measured
    // against the old place would point at nothing.
    fireEvent.mouseEnter(cell("c").parentElement!);
    expect(screen.getByTestId("session-label")).toHaveTextContent("third");
    act(() => useTerminalsStore.getState().openBeside(WS, "a"));
    act(() => void vi.advanceTimersByTime(130));
    expect(screen.queryByTestId("session-label")).toBeNull();
  });

  it("opens on keyboard focus, not on the focus a press gives", () => {
    vi.useFakeTimers();
    seed([{ id: "a", label: "first" }, { id: "b", label: "second" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    // A press focuses the cell on its way to a click: no label for that.
    fireEvent.pointerDown(cell("a"));
    fireEvent.focus(cell("a"));
    expect(screen.queryByTestId("session-label")).toBeNull();
    fireEvent.click(cell("a"));

    fireEvent.focus(cell("b"));
    expect(screen.getByTestId("session-label")).toHaveTextContent("second");
    // The label the keyboard opened outlives a wandering pointer…
    fireEvent.mouseEnter(cell("b").parentElement!);
    fireEvent.mouseLeave(cell("b").parentElement!);
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByTestId("session-label")).toBeInTheDocument();
    // …and goes when focus leaves.
    fireEvent.blur(cell("b"));
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.queryByTestId("session-label")).toBeNull();
  });
});

describe("SessionLine — keyboard", () => {
  it("is one tab stop, on the focused session's cell", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }], ["b"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const stops = Array.from(screen.getByTestId("session-line").querySelectorAll<HTMLElement>("[data-line-stop]"));
    expect(stops.filter((el) => el.tabIndex === 0)).toEqual([cell("b")]);
    // Cells, then +, then the layout button.
    expect(stops).toHaveLength(5);
  });

  it("moves focus with the arrow keys without switching session, through every control", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    cell("a").focus();
    fireEvent.keyDown(cell("a"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("b"));
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");
    fireEvent.keyDown(cell("b"), { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("session-layout"));
    fireEvent.keyDown(screen.getByTestId("session-layout"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByTestId("session-new"));
    fireEvent.keyDown(screen.getByTestId("session-new"), { key: "Home" });
    expect(document.activeElement).toBe(cell("a"));
    // The ends hold.
    fireEvent.keyDown(cell("a"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell("a"));
  });

  it("Enter shows the session, ⌥Enter opens it beside", () => {
    seed([{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    fireEvent.keyDown(cell("b"), { key: "Enter" });
    expect(run().slots).toEqual(["b"]);
    fireEvent.keyDown(cell("c"), { key: "Enter", altKey: true });
    expect(run().slots).toEqual(["b", "c"]);
  });
});

describe("SessionLine — the layout button", () => {
  const open = () => fireEvent.click(screen.getByTestId("session-layout"));
  const item = (name: RegExp | string) => screen.getByRole("menuitemradio", { name });

  it("shows the layout on screen and lists the five, the current one checked", () => {
    seed(many(5), ["s1", "s2"]);
    act(() => useTerminalLayoutStore.getState().setSplit(WS, "side"));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const button = screen.getByTestId("session-layout");
    expect(button).toHaveAttribute("title", "Layout · 2 panes");
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button.querySelector("svg")).toHaveAttribute("data-layout", "two-side");

    open();
    const menu = screen.getByRole("menu", { name: "Layout" });
    expect(menu.className).toContain("octo-menu-enter");
    expect(screen.getAllByRole("menuitemradio").map((r) => r.textContent)).toEqual([
      "One pane",
      "Two, side by side⌘D",
      "Two, stacked",
      "Three",
      "Four",
    ]);
    expect(item(/Two, side by side/)).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("menuitemradio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("a larger layout fills the new panes with the next sessions not on screen, in order", () => {
    seed(many(6), ["s3"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    fireEvent.click(item("Three"));
    expect(run().slots).toEqual(["s3", "s1", "s2"]);
    // Focus stays with the session that had it.
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("s3");
    expect(screen.queryByRole("menu")).toBeNull();

    open();
    fireEvent.click(item("Four"));
    expect(run().slots).toEqual(["s3", "s1", "s2", "s4"]);
  });

  it("a smaller layout takes the trailing panes off screen and closes no session", () => {
    seed(many(4), ["s1", "s2", "s3", "s4"], 0);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    fireEvent.click(item(/Two, side by side/));
    expect(run().slots).toEqual(["s1", "s2"]);
    open();
    fireEvent.click(item("One pane"));
    expect(run().slots).toEqual(["s1"]);
    expect(useTerminalsStore.getState().getTerminals(WS).map((t) => t.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(mockIpc.deleteTerminal).not.toHaveBeenCalled();
  });

  it("spares the focused session when it sits in a trailing pane", () => {
    seed(many(4), ["s1", "s2", "s3", "s4"], 3);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    fireEvent.click(item("One pane"));
    expect(run().slots).toEqual(["s4"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("s4");
  });

  it("the two-pane items set the orientation; Automatic gives the width rule back", () => {
    seed(many(3), ["s1"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    // One pane: no orientation to make automatic.
    open();
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    fireEvent.click(item("Two, stacked"));
    expect(run().slots).toEqual(["s1", "s2"]);
    expect(run().orientation).toBe("stacked");

    open();
    const auto = screen.getByRole("menuitemcheckbox", { name: "Automatic orientation" });
    expect(auto).toHaveAttribute("aria-checked", "false");
    expect(auto).toHaveAttribute("title", "Side by side while every pane keeps 72 columns, stacked below that");
    fireEvent.click(auto);
    expect(run().orientation).toBe("auto");

    open();
    fireEvent.click(item(/Two, side by side/));
    expect(run().orientation).toBe("side");
  });

  it("leaves the orientation automatic until the user picks one", () => {
    seed(many(4), ["s1"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    fireEvent.click(item("Three"));
    expect(run().orientation).toBe("auto");
    open();
    expect(screen.getByRole("menuitemcheckbox", { name: "Automatic orientation" })).toHaveAttribute("aria-checked", "true");
  });

  it("offers only the layouts the sessions can fill: one each, and one empty seat", () => {
    seed(many(2), ["s1"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    expect(item("Three")).toBeEnabled();
    expect(item("Four")).toBeDisabled();
    expect(item("Four")).toHaveAttribute("title", "Open another session to fill this layout");
    fireEvent.click(item("Three"));
    // Both sessions, and the seat that invites a third.
    expect(run().slots).toEqual(["s1", "s2", null]);
  });

  it("reaches every row from the keyboard", () => {
    seed(many(4), ["s1"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    open();
    expect(document.activeElement).toBe(item("One pane"));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(/Two, side by side/));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("SessionLine — more sessions than cells", () => {
  it("turns the last cell into +N past eight sessions, and it opens the switcher", () => {
    seed(many(11));
    const onOpenSwitcher = vi.fn();
    render(<SessionLine workspaceId={WS} onOpenSwitcher={onOpenSwitcher} />);
    expect(screen.getAllByRole("tab")).toHaveLength(MAX_CELLS - 1);
    const more = screen.getByTestId("session-more");
    expect(more).toHaveTextContent("+4");
    expect(more).toHaveAttribute("title", "4 more sessions · ⌘⌥K");
    expect(more).toHaveAccessibleName("4 more sessions");
    fireEvent.click(more);
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it("shows exactly eight cells for eight sessions", () => {
    seed(many(8));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.getAllByRole("tab")).toHaveLength(8);
    expect(screen.queryByTestId("session-more")).toBeNull();
  });

  it("keeps the focused session's cell when it sits past the cells", () => {
    seed(many(11), ["s10"]);
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const ids = screen.getAllByRole("tab").map((c) => c.dataset.testid);
    expect(ids).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s10"].map((id) => `session-cell-${id}`));
    expect(underline("s10").className).toContain("bg-octo-brass");
    // No jump key past nine: the name leaves it out.
    expect(cell("s10")).toHaveAttribute("aria-label", "Session 10 — shell at the prompt");
    expect(screen.getByTestId("session-more")).toHaveTextContent("+4");
  });

  it("carries a hidden session's ring on the +N cell", () => {
    seed(many(11));
    act(() => useAttentionStore.getState().ping(WS, "terminal", "s9", "permission"));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.getByTestId("session-more-bell").className).toContain("bg-octo-brass");
    expect(screen.getByTestId("session-more")).toHaveAccessibleName("4 more sessions — a session needs you");
  });
});

describe("SessionLine — a narrow band", () => {
  it("folds the cells into one button that opens the switcher; focused cell, + and layout stay", () => {
    track(200);
    seed(many(6), ["s3"]);
    const onOpenSwitcher = vi.fn();
    render(<SessionLine workspaceId={WS} onOpenSwitcher={onOpenSwitcher} />);
    expect(screen.getByTestId("session-line").dataset.folded).toBe("true");
    expect(screen.getAllByRole("tab")).toEqual([cell("s3")]);
    const all = screen.getByTestId("session-more");
    expect(all).toHaveTextContent("6 sessions");
    expect(all).toHaveAttribute("title", "All 6 sessions · ⌘⌥K");
    // The button comes first: the cells folded from the left.
    expect(screen.getByTestId("session-line").firstElementChild).toBe(all);
    expect(screen.getByTestId("session-new")).toBeInTheDocument();
    expect(screen.getByTestId("session-layout")).toBeInTheDocument();
    fireEvent.click(all);
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it("keeps every cell while they fit", () => {
    track(lineWidth(6, false) + 2);
    seed(many(6));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.getByTestId("session-line").dataset.folded).toBe("false");
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.queryByTestId("session-more")).toBeNull();
  });

  it("carries a folded session's ring on the button", () => {
    track(200);
    seed(many(6));
    act(() => useAttentionStore.getState().ping(WS, "terminal", "s4"));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    expect(screen.getByTestId("session-more-bell")).toBeInTheDocument();
  });

  it("sheds whole controls as the track narrows, the door to the sessions last", () => {
    const full = { cells: "all", counter: "none", newSession: true, layout: true };
    // Unmeasured (jsdom, a hidden canvas): nothing is decided.
    expect(planLine(0, 6, false)).toEqual(full);
    expect(planLine(lineWidth(6, false), 6, false)).toEqual(full);
    expect(planLine(lineWidth(7, true), 7, true)).toEqual({ ...full, counter: "more" });
    expect(planLine(lineWidth(6, false) - 1, 6, false)).toEqual({ cells: "focused", counter: "sessions", newSession: true, layout: true });
    expect(planLine(140, 6, false)).toEqual({ cells: "focused", counter: "list", newSession: true, layout: true });
    expect(planLine(90, 6, false)).toEqual({ cells: "focused", counter: "list", newSession: true, layout: false });
    expect(planLine(60, 6, false)).toEqual({ cells: "focused", counter: "list", newSession: false, layout: false });
    expect(planLine(30, 6, false)).toEqual({ cells: "none", counter: "list", newSession: false, layout: false });
  });

  it("names the icon-only sessions button", () => {
    track(142);
    seed(many(6));
    render(<SessionLine workspaceId={WS} onOpenSwitcher={noop} />);
    const all = screen.getByTestId("session-more");
    expect(all).toHaveAccessibleName("All 6 sessions");
    expect(all).toHaveAttribute("title", "All 6 sessions · ⌘⌥K");
    expect(all.querySelector("svg")).not.toBeNull();
  });
});

describe("visibleSessions", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

  it("gives every session a cell up to the capacity", () => {
    expect(visibleSessions(ids(8), "s1")).toEqual({ shown: ids(8), more: 0 });
  });

  it("keeps one place for +N past it", () => {
    expect(visibleSessions(ids(9), "s1")).toEqual({ shown: ids(7), more: 2 });
  });

  it("swaps the last cell for the focused session when it is beyond them", () => {
    expect(visibleSessions(ids(12), "s11")).toEqual({ shown: [...ids(6), "s11"], more: 5 });
    expect(visibleSessions(ids(12), null).shown).toEqual(ids(7));
  });
});
