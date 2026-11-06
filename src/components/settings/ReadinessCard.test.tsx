/**
 * ReadinessCard — checks run once on open and on "Check again"; each row
 * shows its status, and a failing row its fix and a copyable command.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReadinessCheck } from "../../lib/ipc";

const readinessCheck = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: { readinessCheck: (...args: unknown[]) => readinessCheck(...args) },
}));
const copyToClipboard = vi.fn();
vi.mock("../../lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

const { ReadinessCard } = await import("./ReadinessCard");
const { useReadinessStore } = await import("../../stores/readinessStore");

function row(over: Partial<ReadinessCheck> & Pick<ReadinessCheck, "id">): ReadinessCheck {
  return { label: over.id, status: "ok", value: "", fix: null, command: null, timedOut: false, ...over };
}

const realCheck = useReadinessStore.getState().check;

beforeEach(() => {
  useReadinessStore.setState({ checks: null, checkedAt: null, loading: false, error: null, check: realCheck });
  readinessCheck.mockReset();
  copyToClipboard.mockReset().mockResolvedValue(true);
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
