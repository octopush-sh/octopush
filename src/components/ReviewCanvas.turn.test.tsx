/**
 * ReviewCanvas · This turn scope (#1152): a Talk turn's diff, opened from
 * its ledger row. The segment shows only with a turn; the view has no
 * Accept, and `x` reverts a hunk in the working tree only while it applies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewCanvas } from "./ReviewCanvas";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import { keyboardHelpLine } from "./review/DiffView";
import { emptyDiffCopy } from "./review/EmptyDiffState";
import { useReviewPrefs } from "../stores/reviewPrefsStore";

vi.mock("./Toasts", () => ({ pushToast: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  ipc: {
    stageHunk: vi.fn(),
    revertHunk: vi.fn(),
    applyHunk: vi.fn(),
    stageAllChanges: vi.fn(),
    listFileEdits: vi.fn(() => Promise.resolve([])),
    detectDefaultTestCommand: vi.fn(() => Promise.resolve(null)),
    readFileChecked: vi.fn(() => Promise.resolve({ kind: "binary", size: 0, mtime: 0 })),
  },
}));

const TURN_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 export { x, y };
`;

const STATUS = {
  branch: "feat/test",
  changedFiles: [{ path: "src/foo.ts", status: "modified" as const, staged: false, unstaged: true, conflicted: false }],
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  conflicted: 0,
  aheadBehindKnown: true,
  operation: null,
};

const TURN = { threadId: "t1", messageId: 7, label: "Make y three" };

// `revert_hunk`'s error when the reverse no longer applies (friendly_git_error).
const STALE =
  "other: This change no longer matches the file — it may have changed since. Refresh the diff and try again.";

function renderCanvas(overrides?: Partial<Parameters<typeof ReviewCanvas>[0]>) {
  return render(
    <ReviewCanvas workspaceId="ws-1" workspacePath="/tmp/ws" gitStatus={STATUS} gitDiff={TURN_DIFF} {...overrides} />,
  );
}

beforeEach(() => {
  vi.mocked(ipc.revertHunk).mockReset().mockResolvedValue(undefined);
  vi.mocked(ipc.stageHunk).mockReset().mockResolvedValue(undefined);
  vi.mocked(pushToast).mockReset();
  useReviewPrefs.setState({ ignoreWhitespace: false });
});

describe("ReviewCanvas · This turn scope", () => {
  it("shows the This turn segment only while a turn is set, and reports the switch", () => {
    const onSourceChange = vi.fn();
    const { rerender } = renderCanvas({ onSourceChange });
    expect(screen.queryByRole("button", { name: "This turn" })).toBeNull();

    rerender(
      <ReviewCanvas
        workspaceId="ws-1"
        workspacePath="/tmp/ws"
        gitStatus={STATUS}
        gitDiff={TURN_DIFF}
        turn={TURN}
        onSourceChange={onSourceChange}
      />,
    );
    const turn = screen.getByRole("button", { name: "This turn" });
    expect(turn).toHaveAttribute("aria-pressed", "false");
    expect(turn.getAttribute("title")).toContain("Make y three");
    // No commits ahead: no Since base segment beside it.
    expect(screen.queryByRole("button", { name: /Since base/ })).toBeNull();
    fireEvent.click(turn);
    expect(onSourceChange).toHaveBeenCalledWith("turn");
  });

  it("switches back to the working tree from the turn view", () => {
    const onSourceChange = vi.fn();
    renderCanvas({ source: "turn", turn: TURN, commitsAhead: 2, base: "main", onSourceChange });
    expect(screen.getByRole("button", { name: "This turn" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Working tree" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Since base · 2 commits" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Working tree" }));
    expect(onSourceChange).toHaveBeenCalledWith("working");
  });

  it("offers Revert and no Accept in the turn view; a ignores, x reverts", async () => {
    renderCanvas({ source: "turn", turn: TURN });
    expect(screen.queryByRole("button", { name: "Accept hunk" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept all changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revert hunk" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a" });
    expect(ipc.stageHunk).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "x" });
    await waitFor(() => expect(ipc.revertHunk).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.revertHunk).mock.calls[0]).toEqual(["/tmp/ws", expect.stringContaining("+const y = 3;")]);
    expect(await screen.findByText("Hunk reverted in the working tree.")).toBeInTheDocument();
  });

  it("a reverse hunk that no longer applies says so and offers no undo", async () => {
    vi.mocked(ipc.revertHunk).mockRejectedValue(STALE);
    renderCanvas({ source: "turn", turn: TURN });
    fireEvent.click(screen.getByRole("button", { name: "Revert hunk" }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "This hunk changed since the turn." })),
    );
    expect(screen.queryByText("Hunk reverted in the working tree.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("any other revert failure shows its own error, not 'changed since the turn'", async () => {
    vi.mocked(ipc.revertHunk).mockRejectedValue("other: error: src/foo.ts: Permission denied");
    renderCanvas({ source: "turn", turn: TURN });
    fireEvent.click(screen.getByRole("button", { name: "Revert hunk" }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        level: "error",
        title: "Couldn't reject hunk",
        body: "other: error: src/foo.ts: Permission denied",
      }),
    );
    expect(pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "This hunk changed since the turn." }));
  });

  it("with whitespace ignored, a hunk that won't reverse is not blamed on a change", async () => {
    useReviewPrefs.setState({ ignoreWhitespace: true });
    vi.mocked(ipc.revertHunk).mockRejectedValue(STALE);
    renderCanvas({ source: "turn", turn: TURN });
    fireEvent.click(screen.getByRole("button", { name: "Revert hunk" }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "This hunk can't be reverted with whitespace ignored." }),
      ),
    );
    expect(pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "This hunk changed since the turn." }));
  });

  it("while the turn's diff loads, says so and never claims the turn changed nothing", () => {
    renderCanvas({ source: "turn", turn: TURN, gitDiff: "", turnRead: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Reading this turn's changes…");
    expect(screen.queryByText("This turn left the files as they were.")).toBeNull();
    expect(screen.queryByText("Nothing to review.")).toBeNull();
  });

  it("when the turn's diff can't be read, says that with the error", () => {
    renderCanvas({
      source: "turn",
      turn: TURN,
      gitDiff: "",
      turnRead: { error: "other: That conversation no longer exists." },
    });
    expect(screen.getByText("This turn's changes couldn't be read.")).toBeInTheDocument();
    expect(screen.getByText("other: That conversation no longer exists.")).toBeInTheDocument();
    expect(screen.queryByText("This turn left the files as they were.")).toBeNull();
  });

  it("a read turn with no changes still says it left the files as they were", () => {
    renderCanvas({ source: "turn", turn: TURN, gitDiff: "", turnRead: null });
    expect(screen.getByText("This turn left the files as they were.")).toBeInTheDocument();
  });

  it("words the keys and the empty state for the turn view", () => {
    expect(keyboardHelpLine(false, true)).toContain("x revert in the working tree");
    expect(keyboardHelpLine(false, true)).not.toContain("a accept");
    expect(keyboardHelpLine(false, true)).not.toContain("ask for a change");
    expect(
      emptyDiffCopy(0, { source: "turn", commitsAhead: 0, base: null, workingCount: 0 }).body,
    ).toBe("This turn left the files as they were.");
  });
});
