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

beforeEach(() => {
  useReadinessStore.setState({ checks: null, loading: false, error: null });
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

    resolve([row({ id: "git", label: "git", value: "2.39.3" })]);
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
    readinessCheck.mockResolvedValue([
      row({
        id: "claude",
        label: "Claude Code",
        status: "fail",
        value: "Not found",
        fix: "Install Claude Code, then check again.",
        command: "npm i -g @anthropic-ai/claude-code",
      }),
    ]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-claude");
    expect(within(r).getByText("Failed")).toHaveClass("text-octo-rouge");
    expect(within(r).getByText("Install Claude Code, then check again.")).toBeInTheDocument();
    fireEvent.click(within(r).getByRole("button", { name: "Copy npm i -g @anthropic-ai/claude-code" }));
    expect(copyToClipboard).toHaveBeenCalledWith("npm i -g @anthropic-ai/claude-code");
  });

  it("marks a timed-out check in amber, never brass", async () => {
    readinessCheck.mockResolvedValue([
      row({
        id: "gh",
        label: "GitHub CLI",
        status: "warn",
        value: "No answer in 3 s",
        fix: "It didn't answer in time.",
        command: "gh auth status",
        timedOut: true,
      }),
    ]);
    render(<ReadinessCard />);
    const r = await screen.findByTestId("readiness-row-gh");
    const word = within(r).getByText("Timed out");
    expect(word).toHaveClass("text-octo-warning");
    expect(word.className).not.toMatch(/brass/);
    expect(within(r).getByTitle("GitHub CLI: Timed out")).toBeInTheDocument();
    expect(within(r).getByText("gh auth status")).toBeInTheDocument();
  });

  it("Check again re-runs the checks", async () => {
    readinessCheck.mockResolvedValue([row({ id: "git", value: "2.39.3" })]);
    render(<ReadinessCard />);
    await screen.findByTestId("readiness-row-git");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(readinessCheck).toHaveBeenCalledTimes(2));
  });
});
