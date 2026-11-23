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
