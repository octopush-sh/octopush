/**
 * ReadinessCard — checks run once on open and on "Check again"; each row
 * shows its status, and a failing row its fix and a copyable command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReadinessCheck } from "../../lib/ipc";

const readinessCheck = vi.fn();
const listPipelines = vi.fn();
const listRoutines = vi.fn();
const modelRetirements = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    readinessCheck: (...args: unknown[]) => readinessCheck(...args),
    listPipelines: (...args: unknown[]) => listPipelines(...args),
    listRoutines: (...args: unknown[]) => listRoutines(...args),
    modelRetirements: (...args: unknown[]) => modelRetirements(...args),
  },
}));
const copyToClipboard = vi.fn();
vi.mock("../../lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

const { ReadinessCard } = await import("./ReadinessCard");
const { useReadinessStore } = await import("../../stores/readinessStore");
const { usePipelineStore } = await import("../../stores/pipelineStore");
const { useRoutinesStore } = await import("../../stores/routinesStore");
const { resetModelRetirementCache } = await import("../../lib/modelRetirement");
const { useTerminalsStore } = await import("../../stores/terminalsStore");
type Terminal = import("../../stores/terminalsStore").TerminalState;

function runSession(over: Partial<Terminal>): Terminal {
  return {
    id: "t1", label: "claude", position: 0, running: true, busy: true, restored: false,
    role: "agent", agentCli: "claude", command: "claude", ...over,
  } as Terminal;
}

function row(over: Partial<ReadinessCheck> & Pick<ReadinessCheck, "id">): ReadinessCheck {
  return { label: over.id, status: "ok", value: "", fix: null, command: null, timedOut: false, ...over };
}

const realCheck = useReadinessStore.getState().check;

beforeEach(() => {
  useReadinessStore.setState({ checks: null, checkedAt: null, loading: false, error: null, check: realCheck });
  readinessCheck.mockReset();
  copyToClipboard.mockReset().mockResolvedValue(true);
  usePipelineStore.setState({ pipelines: [], loaded: false, error: null });
  useRoutinesStore.setState({ routines: [], loaded: false });
  resetModelRetirementCache();
  useTerminalsStore.setState({ terminalsByWs: {} });
  listPipelines.mockReset().mockResolvedValue([]);
  listRoutines.mockReset().mockResolvedValue([]);
  modelRetirements.mockReset().mockImplementation(async (models: string[]) =>
    models.filter((m) => m.startsWith("claude-sonnet-4-5")).map((model) => ({
      model, label: "Sonnet 4.5", retires: "2026-11-30", replacement: "claude-sonnet-5-5", replacementLabel: "Sonnet 5.5",
    })),
  );
});

function relay(agentModel: string) {
  return {
    pipeline: { id: "p", name: "Relay", description: "", isBuiltin: false, createdAt: "t" },
    stages: [{
      id: "s0", pipelineId: "p", position: 0, role: "implement", agentModel, escalateModel: null, substrate: "api",
      checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
      posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
    }],
  };
}

describe("ReadinessCard · crew models", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a warning row for a saved crew on a model that retires within 30 days", async () => {
    listPipelines.mockResolvedValue([relay("claude-sonnet-4-5-20250929")]);
    readinessCheck.mockResolvedValue([row({ id: "git", value: "2.39.3" })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-models");
    expect(r).toHaveAttribute("data-status", "warn");
    expect(r).toHaveAttribute("data-tour", "settings-readiness-models");
    expect(within(r).getByText("Sonnet 4.5 · retires Nov 30")).toBeInTheDocument();
    expect(within(r).getByText(/so 1 crew on it will fail from then on\. Relay\./)).toBeInTheDocument();
  });

  it("shows no row when no crew uses a retiring model", async () => {
    listPipelines.mockResolvedValue([relay("claude-sonnet-5-5")]);
    readinessCheck.mockResolvedValue([row({ id: "git", value: "2.39.3" })]);
    render(<ReadinessCard />);
    await screen.findByTestId("readiness-row-git");
    await waitFor(() => expect(listPipelines).toHaveBeenCalled());
    expect(screen.queryByTestId("readiness-row-models")).toBeNull();
  });
});

describe("ReadinessCard · recommended Claude Code note", () => {
  const worktree = { version: "2.1.330", reason: "fixes ExitWorktree removing a worktree another session is using", audience: "run" as const };
  const mcp = { version: "2.1.331", reason: "fixes MCP tool calls hanging up to 30 minutes on some malformed replies from a local or WebSocket server", audience: "any" as const };
  const recommended = [worktree, mcp];
  const claudeCrew = () => {
    const crew = relay("sonnet");
    return { ...crew, stages: crew.stages.map((s) => ({ ...s, substrate: "cli" as const })) };
  };

  it("lists every missing fix under a ready Claude Code row while a Run session runs Claude Code", async () => {
    useTerminalsStore.setState({ terminalsByWs: { w1: [runSession({ agentCli: "codex" })], w2: [runSession({ id: "t2" })] } });
    readinessCheck.mockResolvedValue([row({ id: "claude", label: "Claude Code", value: "2.1.325", recommended })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    expect(r).toHaveAttribute("data-status", "ok");
    expect(within(r).getByText("Ready")).toBeInTheDocument();
    const line = within(r).getByTestId("readiness-note");
    expect(line).toHaveTextContent(
      "Recommended: Claude Code 2.1.331. 2.1.330 fixes ExitWorktree removing a worktree another session is using. 2.1.331 fixes MCP tool calls hanging up to 30 minutes on some malformed replies from a local or WebSocket server.",
    );
    expect(line).toHaveAttribute("data-tour", "settings-readiness-claude-note");
    expect(line).toHaveClass("text-octo-sage");
  });

  it("shows the fixes for everyone on Claude Code with no Run session, whatever the crews", async () => {
    // Every install has builtin crews with Claude Code CLI stages, so the
    // crews don't gate the note: a library with none on Claude Code still shows it.
    useTerminalsStore.setState({
      terminalsByWs: { w1: [runSession({ agentCli: "codex" }), runSession({ id: "t2", running: false })] },
    });
    listPipelines.mockResolvedValue([relay("sonnet")]);
    readinessCheck.mockResolvedValue([row({ id: "claude", label: "Claude Code", value: "2.1.325", recommended })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    const line = await within(r).findByTestId("readiness-note");
    expect(line).toHaveTextContent(
      "Recommended: Claude Code 2.1.331 fixes MCP tool calls hanging up to 30 minutes on some malformed replies from a local or WebSocket server.",
    );
    expect(line).not.toHaveTextContent("ExitWorktree");
  });

  it("hides the note when the only missing fix is for Run sessions and none runs Claude Code", async () => {
    useTerminalsStore.setState({ terminalsByWs: { w1: [runSession({ agentCli: "codex" })] } });
    listPipelines.mockResolvedValue([claudeCrew()]);
    readinessCheck.mockResolvedValue([row({ id: "claude", label: "Claude Code", value: "2.1.329", recommended: [worktree] })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    await waitFor(() => expect(listPipelines).toHaveBeenCalled());
    expect(within(r).queryByTestId("readiness-note")).toBeNull();
  });

  it("shows nothing when the backend sends no note", async () => {
    useTerminalsStore.setState({ terminalsByWs: { w1: [runSession({})] } });
    readinessCheck.mockResolvedValue([row({ id: "claude", label: "Claude Code", value: "2.1.330" })]);
    render(<ReadinessCard />);
    await screen.findByTestId("readiness-row-claude");
    expect(screen.queryByTestId("readiness-note")).toBeNull();
  });
});

describe("ReadinessCard", () => {
  it("shows a loading line until the checks answer", async () => {
    let resolve!: (v: ReadinessCheck[]) => void;
    readinessCheck.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ReadinessCard />);
    expect(screen.getByTestId("readiness-loading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    resolve([row({ id: "git", value: "2.39.3" })]);
    await waitFor(() => expect(screen.queryByTestId("readiness-loading")).toBeNull());
    expect(readinessCheck).toHaveBeenCalledTimes(1);
  });

  it("renders an ok row with its value and no fix", async () => {
    readinessCheck.mockResolvedValue([row({ id: "claude", label: "Claude Code", value: "2.1.316" })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    expect(r).toHaveAttribute("data-status", "ok");
    expect(within(r).getByText("2.1.316")).toHaveClass("octo-tabular");
    expect(within(r).getByText("Ready")).toBeInTheDocument();
    expect(within(r).getByTitle("Claude Code: Ready")).toBeInTheDocument();
    expect(within(r).queryByRole("button")).toBeNull();
  });

  it("renders a failing row with its fix and a copyable command", async () => {
    const command = "npm i -g @anthropic-ai/claude-code";
    const fix = "Install Claude Code, then check again.";
    readinessCheck.mockResolvedValue([row({ id: "claude", status: "fail", value: "Not found", fix, command })]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    expect(within(r).getByText("Failed")).toHaveClass("text-octo-rouge");
    expect(within(r).getByText(fix)).toBeInTheDocument();
    fireEvent.click(within(r).getByRole("button", { name: `Copy ${command}` }));
    expect(copyToClipboard).toHaveBeenCalledWith(command);
  });

  it("marks a timed-out check in amber, never brass", async () => {
    const command = "gh auth token --hostname github.com";
    readinessCheck.mockResolvedValue([
      row({ id: "gh", label: "GitHub CLI", status: "warn", value: "No answer in 3 s", fix: "It didn't answer in time.", command, timedOut: true }),
    ]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-gh");
    const word = within(r).getByText("Timed out");
    expect(word).toHaveClass("text-octo-warning");
    expect(word.className).not.toMatch(/brass/);
    expect(within(r).getByTitle("GitHub CLI: Timed out")).toBeInTheDocument();
    expect(within(r).getByText(command)).toBeInTheDocument();
  });

  it("shows a rouge error line when the checks can't run, and Check again re-runs them and clears it", async () => {
    readinessCheck.mockRejectedValueOnce("readiness task failed: boom");
    readinessCheck.mockResolvedValueOnce([row({ id: "git", value: "2.39.3" })]);
    render(<ReadinessCard />);
    const line = await screen.findByText("Couldn't run the checks: readiness task failed: boom");
    expect(line).toHaveClass("text-octo-rouge");
    expect(screen.queryByTestId("readiness-loading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByTestId("readiness-row-git");
    expect(readinessCheck).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't run the checks/)).toBeNull();
  });

  it("asks claude auth status only on Check again, never on the automatic pass", async () => {
    readinessCheck.mockResolvedValue([row({ id: "auth", label: "Claude auth", value: "Subscription" })]);
    render(<ReadinessCard />);
    await screen.findByTestId("readiness-row-auth");
    expect(readinessCheck).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(readinessCheck).toHaveBeenCalledTimes(2));
    expect(readinessCheck).toHaveBeenLastCalledWith(true);
  });

  it("says 'Not checked yet' and offers 'Run the check' before the first run", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    useReadinessStore.setState({ check });
    render(<ReadinessCard />);
    expect(screen.getByTestId("readiness-unchecked")).toHaveTextContent("Not checked yet.");
    expect(screen.getByTestId("readiness-unchecked")).toHaveClass("text-octo-mute");
    expect(screen.queryByTestId("readiness-checked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run the check" }));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never leaves the card blank when the backend answers with no list", async () => {
    readinessCheck.mockResolvedValue(undefined);
    render(<ReadinessCard />);
    expect(await screen.findByTestId("readiness-empty")).toHaveTextContent(/No checks came back/);
    expect(screen.getByTestId("readiness-checked")).toHaveTextContent("Checked just now");
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("shows when it last checked and keeps the rows while re-checking", async () => {
    readinessCheck.mockResolvedValueOnce([row({ id: "git", value: "2.39.3" })]);
    render(<ReadinessCard />);
    await screen.findByTestId("readiness-row-git");
    const meta = screen.getByTestId("readiness-checked");
    expect(meta).toHaveTextContent("Checked just now");
    expect(meta).toHaveClass("font-mono", "text-octo-mute");

    readinessCheck.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByTestId("readiness-row-git")).toBeInTheDocument();
    expect(screen.queryByTestId("readiness-loading")).toBeNull();
  });

  it("links a low disk row to the footer's workspace caches", async () => {
    const fix = "Crews create worktrees and run setup scripts; free some space or archive old workspaces.";
    readinessCheck.mockResolvedValue([
      row({ id: "disk", label: "Disk space", status: "warn", value: "6.2 GB free", fix }),
      row({ id: "gh", label: "GitHub CLI", status: "warn", value: "Not signed in", fix: "Sign gh in." }),
    ]);
    const onShowCaches = vi.fn();
    render(<ReadinessCard onShowCaches={onShowCaches} />);
    const r = await screen.findByTestId("readiness-row-disk");
    expect(r).toHaveAttribute("data-tour", "settings-readiness-disk");
    expect(within(r).getByText(fix)).toBeInTheDocument();
    fireEvent.click(within(r).getByRole("button", { name: "See what this workspace caches" }));
    expect(onShowCaches).toHaveBeenCalledTimes(1);
    // Only the disk row carries the link.
    expect(within(screen.getByTestId("readiness-row-gh")).queryByRole("button")).toBeNull();
  });

  it("anchors the Codex CLI row for the tour and offers its sign-in command", async () => {
    readinessCheck.mockResolvedValue([
      row({ id: "codex", label: "Codex CLI", status: "warn", value: "Not signed in", fix: "Sign Codex in.", command: "codex login" }),
      row({ id: "git", label: "git", value: "2.39.3" }),
    ]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-codex");
    expect(r).toHaveAttribute("data-tour", "settings-readiness-codex");
    expect(within(r).getByText("codex login")).toBeInTheDocument();
    expect(screen.getByTestId("readiness-row-git")).not.toHaveAttribute("data-tour");
  });

  it("shows an ok disk row with no link", async () => {
    readinessCheck.mockResolvedValue([row({ id: "disk", label: "Disk space", value: "84 GB free" })]);
    render(<ReadinessCard onShowCaches={vi.fn()} />);
    const r = await screen.findByTestId("readiness-row-disk");
    expect(within(r).getByText("84 GB free")).toBeInTheDocument();
    expect(within(r).queryByRole("button")).toBeNull();
  });

  it("shows a status it doesn't know as a mute 'Unknown', not a verdict", async () => {
    readinessCheck.mockResolvedValue([
      row({ id: "git", label: "git", status: "later" as unknown as ReadinessCheck["status"] }),
    ]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-git");
    expect(within(r).getByText("Unknown")).toHaveClass("text-octo-mute");
    expect(within(r).getByTitle("git: Unknown")).toBeInTheDocument();
  });
});
