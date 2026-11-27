import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ApprovalCard, COMMAND_GRANT_TITLE, EVERY_TIME_COPY, FOCUS_CARD_CHORD, RUN_CHECK_LIMITS, focusOldestCard } from "./ApprovalCard";
import { matchShortcut, type ShortcutContext } from "../../hooks/useGlobalShortcuts";

const base = { callId: "c", threadId: "t", command: "git add -A && git commit -m x", reason: "possible secret · GitHub token in a.ts:3" };

describe("ApprovalCard", () => {
  it("a destructive command offers approve, deny and don't ask again", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={{ ...base, command: "rm -rf build", reason: "rm -rf" }} onRespond={onRespond} />);
    expect(screen.getByText("Approval needed")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/don't ask again/));
    expect(onRespond).toHaveBeenCalledWith("always");
    // The grant's reach is said where it is offered.
    expect(screen.getByText(/don't ask again/)).toHaveAttribute(
      "title",
      "Approve this, and stop asking about flagged commands and MCP tool calls for the rest of this conversation (a possible secret, a command that changes something outside this Mac, or a file or command reaching outside the workspace, still asks)",
    );
  });

  it("a flagged command may be allowed for the conversation, exactly as written (#1229)", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={{ ...base, command: "rm -rf build", reason: "rm -rf", rememberCommand: true }} onRespond={onRespond} />);
    const grant = screen.getByRole("button", { name: "Allow this command for this conversation" });
    expect(grant).toHaveAttribute("title", COMMAND_GRANT_TITLE);
    expect(COMMAND_GRANT_TITLE).toMatch(/exactly this command/);
    fireEvent.click(grant);
    expect(onRespond).toHaveBeenLastCalledWith("grant");
    expect(screen.getByText(/don't ask again/)).toBeInTheDocument();
  });

  it("a remote side effect, or Plan only, offers no grant and says why (#1229)", () => {
    render(
      <ApprovalCard
        approval={{ ...base, command: "git push origin main", reason: "changes something outside this Mac (git push)", everyTime: "remote" }}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText(EVERY_TIME_COPY.remote)).toBeInTheDocument();
    expect(screen.queryByText(/don't ask again/)).toBeNull();
    expect(screen.queryByText(/for this conversation/)).toBeNull();
    cleanup();
    render(<ApprovalCard approval={{ ...base, command: "rm -rf build", reason: "rm -rf", everyTime: "plan" }} onRespond={() => {}} />);
    expect(screen.getByText(EVERY_TIME_COPY.plan)).toBeInTheDocument();
    expect(screen.queryByText(/don't ask again/)).toBeNull();
  });

  it("a write outside may be allowed in its folder for the conversation, a credentials location never (#1229)", () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, kind: "write", command: "~/notes/out.md", reason: "writes a file outside the workspace", rememberDir: "~/notes" }}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText(/A credentials location always asks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow writing ~/notes for this conversation" }));
    expect(onRespond).toHaveBeenLastCalledWith("grant");
    cleanup();
    render(
      <ApprovalCard
        approval={{ ...base, kind: "write", sensitive: true, command: "~/.ssh/config", reason: "writes a file", rememberDir: "~/.ssh", rememberCommand: true }}
        onRespond={() => {}}
      />,
    );
    expect(screen.queryByText(/for this conversation/)).toBeNull();
  });

  it("the secret guard's card has no don't ask again, and says when it read uncommitted changes (#819)", () => {
    const onRespond = vi.fn();
    const { container } = render(<ApprovalCard approval={{ ...base, secret: true, coversUncommitted: true }} onRespond={onRespond} />);
    expect(container.querySelector('[data-tour="talk-secret-approval"]')).not.toBeNull();
    expect(screen.getByText("Possible secret")).toBeInTheDocument();
    expect(screen.queryByText(/don't ask again/)).toBeNull();
    expect(screen.getByText(/covered every uncommitted change/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Leave it out"));
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    fireEvent.click(screen.getByText("Run regardless"));
    expect(onRespond).toHaveBeenLastCalledWith("approve");
  });

  it("an MCP tool call reads as a tool call, not a shell command, and may be granted (#1147)", () => {
    const onRespond = vi.fn();
    const { container } = render(
      <ApprovalCard
        approval={{ ...base, kind: "mcp", command: 'mcp__github__merge_pr {"number":7}', reason: "MCP tool may change external state" }}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText("Approval needed")).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe('mcp__github__merge_pr {"number":7}');
    fireEvent.click(screen.getByText(/don't ask again/));
    expect(onRespond).toHaveBeenCalledWith("always");
  });

  it("a file outside the workspace names the path, allows once, and never offers don't ask again (#1147)", () => {
    const onRespond = vi.fn();
    const { container } = render(
      <ApprovalCard
        approval={{ ...base, kind: "read", command: "~/notes/plan.md", reason: "reads a file outside the workspace" }}
        onRespond={onRespond}
      />,
    );
    const card = screen.getByRole("group", { name: "Outside the workspace: ~/notes/plan.md" });
    expect(card).toHaveAttribute("title", "⌘↵ allows once · Esc denies · ⌘⌥A focuses the oldest waiting card");
    expect(container.querySelector("pre")?.textContent).toBe("~/notes/plan.md");
    expect(screen.queryByText(/don't ask again/)).toBeNull();
    expect(screen.getByText(/what it reads goes to your AI provider/)).toBeInTheDocument();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    expect(onRespond).toHaveBeenLastCalledWith("approve");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    cleanup();
    render(<ApprovalCard approval={{ ...base, kind: "write", command: "/etc/hosts", reason: "writes a file" }} onRespond={() => {}} />);
    expect(screen.getByText(/lets the agent write it once/)).toBeInTheDocument();
    expect(screen.queryByText(/AI provider/)).toBeNull();
  });

  it("a credentials location leads with the safe answer, and Enter takes it", () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, kind: "read", sensitive: true, command: "~/.ssh/id_ed25519", reason: "reads a file outside the workspace · ~/.ssh holds SSH keys" }}
        onRespond={onRespond}
      />,
    );
    const card = screen.getByRole("group", { name: "Possible credentials: ~/.ssh/id_ed25519" });
    expect(card).toHaveAttribute("title", "⌘↵, Enter or Esc denies · ⌘⌥A focuses the oldest waiting card");
    expect(screen.getByText(/This may hold credentials/)).toBeInTheDocument();
    const [first] = screen.getAllByRole("button");
    expect(first).toHaveTextContent("Deny");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    expect(onRespond.mock.calls).toEqual([["deny"], ["deny"]]);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenLastCalledWith("approve");
    expect(screen.queryByText(/don't ask again/)).toBeNull();
  });

  it("a command reaching outside the workspace reads as a command, asks every time, and says it is a net (#1201)", () => {
    const onRespond = vi.fn();
    const { container } = render(
      <ApprovalCard
        approval={{ ...base, kind: "run", sensitive: true, command: "cat ~/.ssh/id_ed25519", reason: "reaches ~/.ssh/id_ed25519 outside the workspace · ~/.ssh holds SSH keys" }}
        onRespond={onRespond}
      />,
    );
    const card = screen.getByRole("group", { name: "Possible credentials: cat ~/.ssh/id_ed25519" });
    expect(card).toHaveAttribute("title", `⌘↵, Enter or Esc denies · ⌘⌥A focuses the oldest waiting card. ${RUN_CHECK_LIMITS}`);
    expect(RUN_CHECK_LIMITS).toMatch(/a net, not a sandbox/);
    expect(container.querySelector("pre")?.textContent).toBe("$ cat ~/.ssh/id_ed25519");
    expect(screen.getByText(/its output goes to your AI provider/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Deny");
    expect(screen.queryByText(/don't ask again/)).toBeNull();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    cleanup();
    expect(screen.queryByText(/for this conversation/)).toBeNull();
    cleanup();
    const onRemember = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, kind: "run", command: "cat /tmp/out.log", reason: "reaches /tmp/out.log outside the workspace", rememberDir: "/tmp" }}
        onRespond={onRemember}
      />,
    );
    expect(screen.getByRole("group", { name: "Outside the workspace: cat /tmp/out.log" })).toHaveAttribute("title", `⌘↵ allows once · Esc denies · ⌘⌥A focuses the oldest waiting card. ${RUN_CHECK_LIMITS}`);
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Allow once");
    expect(screen.getByText(/A credentials location always asks/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Allow reading /tmp for this conversation"));
    expect(onRemember).toHaveBeenLastCalledWith("grant");
    cleanup();
    // A write outside, with no folder to offer: the command itself (#1229).
    const onGrant = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, kind: "run", command: "echo x > /tmp/out.log", reason: "reaches /tmp/out.log outside the workspace", rememberCommand: true }}
        onRespond={onGrant}
      />,
    );
    fireEvent.click(screen.getByText("Allow this command for this conversation"));
    expect(onGrant).toHaveBeenLastCalledWith("grant");
    expect(screen.queryByText(/don't ask again/)).toBeNull();
  });

  it("a plain commit's secret card doesn't mention uncommitted changes", () => {
    render(<ApprovalCard approval={{ ...base, command: "git commit -m x", secret: true }} onRespond={() => {}} />);
    expect(screen.queryByText(/uncommitted/)).toBeNull();
    expect(screen.getByText(/runs it once, for exactly these findings/)).toBeInTheDocument();
  });
});

describe("ApprovalCard at the keyboard", () => {
  const plain = { ...base, command: "git push --force", reason: "force-push" };

  it("⌘↵ on the focused card approves, Esc denies, and the card says so", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    const card = screen.getByRole("group", { name: "Approval needed: git push --force" });
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveAttribute("title", "⌘↵ approves · Esc denies · ⌘⌥A focuses the oldest waiting card");
    expect(card).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Escape");
    expect(card).toHaveAttribute("data-tour", "talk-approval");
    // The keys answer the card's own focus, and the buttons say so.
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("title", "Approve (⌘↵ with the card focused)");
    expect(screen.getByRole("button", { name: "Deny" })).toHaveAttribute("title", "Deny (Esc with the card focused)");

    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    expect(onRespond).toHaveBeenLastCalledWith("approve");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    expect(onRespond).toHaveBeenCalledTimes(2);
  });

  it("plain Enter never approves a destructive command", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("answers only its own focus: keys on a button inside it, or from elsewhere, are not the card's", () => {
    const onRespond = vi.fn();
    render(
      <div>
        <textarea aria-label="composer" />
        <ApprovalCard approval={plain} onRespond={onRespond} />
      </div>,
    );
    const deny = screen.getByRole("button", { name: "Deny" });
    fireEvent.keyDown(deny, { key: "Enter", metaKey: true });
    fireEvent.keyDown(deny, { key: "Escape" });
    // The composer's own ⌘↵ never reaches the card.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "composer" }), { key: "Enter", metaKey: true });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("ignores held keys, other chords and IME composition", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    const card = screen.getByRole("group");
    fireEvent.keyDown(card, { key: "Enter", metaKey: true, repeat: true });
    fireEvent.keyDown(card, { key: "Escape", repeat: true });
    fireEvent.keyDown(card, { key: "Enter", metaKey: true, shiftKey: true });
    fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(card, { key: "Enter", metaKey: true, isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("stops a handled key there, so nothing behind the card acts on it too", () => {
    const behind = vi.fn();
    render(
      <div onKeyDown={behind}>
        <ApprovalCard approval={plain} onRespond={() => {}} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("group"), { key: "Enter", metaKey: true });
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(behind).not.toHaveBeenCalled();
  });

  it("never takes the focus when it appears: not from nothing, an empty composer or a draft", () => {
    // A habitual ⌘↵ or Enter meant for the composer must never land on a
    // command the user hasn't read.
    const onRespond = vi.fn();
    const { rerender, unmount } = render(<div />);
    expect(document.activeElement).toBe(document.body);
    rerender(<ApprovalCard approval={plain} onRespond={onRespond} />);
    expect(screen.getByRole("group")).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.activeElement!, { key: "Enter", metaKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    unmount();

    for (const draft of ["", "half a thought"]) {
      const Talk = ({ card }: { card: boolean }) => (
        <div>
          <textarea data-tour="talk-composer-input" aria-label="composer" defaultValue={draft} autoFocus />
          {card && <ApprovalCard approval={plain} onRespond={onRespond} />}
        </div>
      );
      const view = render(<Talk card={false} />);
      const composer = screen.getByRole("textbox", { name: "composer" });
      expect(composer).toHaveFocus();
      // The card arrives while the user sits in the composer.
      view.rerender(<Talk card />);
      expect(composer).toHaveFocus();
      fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
      expect(onRespond).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("takes the focus from a click or Tab, and says how to reach it from the keyboard", () => {
    render(<ApprovalCard approval={plain} onRespond={() => {}} />);
    const card = screen.getByRole("group");
    expect(card).toHaveAttribute("data-approval-card");
    expect(card.getAttribute("title")).toContain("⌘⌥A focuses the oldest waiting card");
    card.focus();
    expect(card).toHaveFocus();
  });

  it("⌘⌥A focuses the oldest waiting card, whose Esc then denies only it", () => {
    const answers: string[] = [];
    render(
      <div>
        <textarea aria-label="composer" defaultValue="" autoFocus />
        <ApprovalCard approval={{ ...plain, callId: "old", command: "rm -rf build" }} onRespond={(d) => answers.push(`old:${d}`)} />
        <ApprovalCard approval={{ ...plain, callId: "new", command: "git push --force" }} onRespond={(d) => answers.push(`new:${d}`)} />
      </div>,
    );
    const composer = screen.getByRole("textbox", { name: "composer" });
    expect(composer).toHaveFocus();

    // The global table's chord, the physical key (Option prints å).
    const e = new KeyboardEvent("keydown", { key: "å", code: "KeyA", metaKey: true, altKey: true });
    const shortcut = matchShortcut(e);
    expect(shortcut?.id).toBe("focus-approval");
    expect(shortcut?.chords).toEqual([FOCUS_CARD_CHORD]);
    expect(shortcut?.run(e, { focusApproval: () => focusOldestCard() } as unknown as ShortcutContext)).toBe(true);
    const oldest = screen.getByRole("group", { name: "Approval needed: rm -rf build" });
    expect(oldest).toHaveFocus();

    fireEvent.keyDown(oldest, { key: "Escape" });
    expect(answers).toEqual(["old:deny"]);
  });

  it("focusOldestCard: false with no card waiting", () => {
    render(<textarea aria-label="composer" autoFocus />);
    expect(focusOldestCard()).toBe(false);
    expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus();
  });

  it("on the secret card, Enter and ⌘↵ take the safe lead answer: leave it out", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={{ ...base, secret: true }} onRespond={onRespond} />);
    const card = screen.getByRole("group", { name: /^Possible secret: / });
    expect(card).toHaveAttribute("title", "⌘↵, Enter or Esc leaves it out · ⌘⌥A focuses the oldest waiting card");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onRespond.mock.calls).toEqual([["deny"], ["deny"], ["deny"]]);
    expect(screen.getByRole("button", { name: "Leave it out" })).toHaveAttribute(
      "title",
      "Leave it out (⌘↵, Enter or Esc with the card focused)",
    );
  });
});
