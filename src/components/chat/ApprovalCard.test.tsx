import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";

const base = { callId: "c", threadId: "t", command: "git add -A && git commit -m x", reason: "possible secret · GitHub token in a.ts:3" };

describe("ApprovalCard", () => {
  it("a destructive command offers approve, deny and don't ask again", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={{ ...base, command: "rm -rf build", reason: "rm -rf" }} onRespond={onRespond} />);
    expect(screen.getByText("Approval needed")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/don't ask again/));
    expect(onRespond).toHaveBeenCalledWith("always");
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

  it("a plain commit's secret card doesn't mention uncommitted changes", () => {
    render(<ApprovalCard approval={{ ...base, command: "git commit -m x", secret: true }} onRespond={() => {}} />);
    expect(screen.queryByText(/uncommitted/)).toBeNull();
    expect(screen.getByText(/runs it once, for exactly these findings/)).toBeInTheDocument();
  });
});

describe("ApprovalCard at the keyboard", () => {
  const plain = { ...base, command: "git push --force", reason: "force-push" };

  it("Enter on the focused card approves, Esc denies, and the card says so", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    const card = screen.getByRole("group", { name: "Approval needed: git push --force" });
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveAttribute("title", "Enter approves · Esc denies");
    expect(card).toHaveAttribute("data-tour", "talk-approval");
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("title", "Approve (Enter)");
    expect(screen.getByRole("button", { name: "Deny" })).toHaveAttribute("title", "Deny (Esc)");

    fireEvent.keyDown(card, { key: "Enter" });
    expect(onRespond).toHaveBeenLastCalledWith("approve");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    expect(onRespond).toHaveBeenCalledTimes(2);
  });

  it("a focused button answers Enter itself; Esc from it still denies", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    const deny = screen.getByRole("button", { name: "Deny" });
    // Enter on a button is the button's own click (native), never the card's approve.
    fireEvent.keyDown(deny, { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(deny, { key: "Escape" });
    expect(onRespond).toHaveBeenCalledWith("deny");
  });

  it("ignores Enter with a modifier and keys typed in an IME", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={plain} onRespond={onRespond} />);
    const card = screen.getByRole("group");
    fireEvent.keyDown(card, { key: "Enter", metaKey: true });
    fireEvent.keyDown(card, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(card, { key: "Enter", isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("on the secret card, Enter takes the safe lead answer: leave it out", () => {
    const onRespond = vi.fn();
    render(<ApprovalCard approval={{ ...base, secret: true }} onRespond={onRespond} />);
    const card = screen.getByRole("group", { name: /^Possible secret: / });
    expect(card).toHaveAttribute("title", "Enter or Esc leaves it out");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    expect(onRespond).not.toHaveBeenCalledWith("approve");
    expect(screen.getByRole("button", { name: "Leave it out" })).toHaveAttribute("title", "Leave it out (Enter or Esc)");
  });
});
