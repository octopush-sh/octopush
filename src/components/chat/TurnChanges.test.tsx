/**
 * TurnChanges (#1152): the ledger row under a finished Talk turn that
 * changed files, and its two actions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TurnChanges } from "./TurnChanges";
import { ipc } from "../../lib/ipc";
import { NAVIGATE_EVENT, type NavigateDetail } from "../../lib/tour/surfaces";
import { useReviewSource } from "../../stores/reviewSourceStore";

vi.mock("../../lib/ipc", () => ({
  ipc: { talkTurnChanges: vi.fn() },
}));

const FOUR = [
  { path: "src/a.ts", status: "modified" as const, added: 30, removed: 4 },
  { path: "src/b.ts", status: "modified" as const, added: 5, removed: 2 },
  { path: "docs/new.md", status: "added" as const, added: 3, removed: 0 },
  { path: "scripts/made-by-shell.sh", status: "added" as const, added: 0, removed: 0 },
];

beforeEach(() => {
  vi.mocked(ipc.talkTurnChanges).mockReset();
  useReviewSource.setState({ turnByWs: {}, pickByWs: {} });
});

describe("TurnChanges", () => {
  it("shows the counts and the file names for a turn that changed files", async () => {
    vi.mocked(ipc.talkTurnChanges).mockResolvedValue(FOUR);
    render(<TurnChanges workspaceId="ws" threadId="t1" messageId={7} ask="Do it" />);
    expect(await screen.findByText("4 files changed · +38 −6")).toBeInTheDocument();
    expect(ipc.talkTurnChanges).toHaveBeenCalledWith("t1", 7);
    const row = screen.getByTestId("talk-turn-changes");
    expect(row.className).toContain("octo-rise-in");
    // The names are mid-truncated; their tooltip holds every full path.
    expect(row.querySelector("[title]")?.getAttribute("title")).toBe(
      "src/a.ts\nsrc/b.ts\ndocs/new.md\nscripts/made-by-shell.sh",
    );
    expect(row.textContent).toContain("made-by-shell.sh");
  });

  it("shows no row for a read-only turn or one missing a checkpoint (the backend answers none)", async () => {
    vi.mocked(ipc.talkTurnChanges).mockResolvedValue([]);
    render(<TurnChanges workspaceId="ws" threadId="t1" messageId={7} ask="Read only" />);
    await waitFor(() => expect(ipc.talkTurnChanges).toHaveBeenCalled());
    expect(screen.queryByTestId("talk-turn-changes")).toBeNull();
  });

  it("shows no row when the read fails", async () => {
    vi.mocked(ipc.talkTurnChanges).mockRejectedValue("other: That conversation no longer exists.");
    render(<TurnChanges workspaceId="ws" threadId="t1" messageId={7} ask="x" />);
    await waitFor(() => expect(ipc.talkTurnChanges).toHaveBeenCalled());
    expect(screen.queryByTestId("talk-turn-changes")).toBeNull();
  });

  it("Review these changes opens the turn in Review's This turn scope", async () => {
    vi.mocked(ipc.talkTurnChanges).mockResolvedValue(FOUR);
    const seen: NavigateDetail[] = [];
    const onNav = (e: Event) => seen.push((e as CustomEvent<NavigateDetail>).detail);
    window.addEventListener(NAVIGATE_EVENT, onNav);
    render(<TurnChanges workspaceId="ws" threadId="t1" messageId={7} ask={"Fix the parser\nplease"} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review these changes" }));
    window.removeEventListener(NAVIGATE_EVENT, onNav);
    const s = useReviewSource.getState();
    expect(s.turnByWs.ws).toEqual({ threadId: "t1", messageId: 7, label: "Fix the parser" });
    expect(s.pickByWs.ws).toBe("turn");
    expect(seen).toEqual([{ kind: "mode", mode: "review" }]);
  });

  it("Rewind files to here asks for the turn's rewind", async () => {
    vi.mocked(ipc.talkTurnChanges).mockResolvedValue(FOUR);
    const onRewind = vi.fn();
    render(<TurnChanges workspaceId="ws" threadId="t1" messageId={7} ask="x" onRewind={onRewind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rewind files to here" }));
    expect(onRewind).toHaveBeenCalledWith(7);
  });
});
