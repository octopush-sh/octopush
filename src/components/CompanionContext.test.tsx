/**
 * Tests for CompanionContext spending block.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompanionContext } from "./CompanionContext";
import type { Budget, SpendSnapshot } from "../lib/types";

const baseProps = {
  tokensUsed: 10000,
  tokensLimit: 200000,
  unstaged: 1,
  toolCalls: 2,
};

describe("CompanionContext spending block", () => {
  it("shows empty state when no budgets configured", () => {
    render(<CompanionContext {...baseProps} budgets={[]} spend={{}} />);
    expect(screen.getByText(/No budget configured/i)).toBeTruthy();
  });

  it("renders spending rows when global daily budget is set", () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
    ];
    const spend: Record<string, SpendSnapshot> = {
      "global::daily": { costUsd: 1.5, tokens: 10000 },
    };
    render(<CompanionContext {...baseProps} budgets={budgets} spend={spend} />);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText(/\$1\.50 \/ \$5\.00/)).toBeTruthy();
  });

  it("renders two rows when both daily and monthly budgets exist", () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
      { scopeType: "global", scopeId: "", period: "monthly", limitUsd: 80.0, updatedAt: "" },
    ];
    const spend: Record<string, SpendSnapshot> = {
      "global::daily": { costUsd: 2.0, tokens: 5000 },
      "global::monthly": { costUsd: 12.0, tokens: 50000 },
    };
    render(<CompanionContext {...baseProps} budgets={budgets} spend={spend} />);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Month")).toBeTruthy();
  });

  it("prefers workspace budget over global when workspaceId provided", () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 50.0, updatedAt: "" },
      { scopeType: "workspace", scopeId: "ws-1", period: "daily", limitUsd: 2.0, updatedAt: "" },
    ];
    const spend: Record<string, SpendSnapshot> = {
      "global::daily": { costUsd: 1.0, tokens: 1000 },
      "workspace:ws-1:daily": { costUsd: 0.50, tokens: 500 },
    };
    render(
      <CompanionContext {...baseProps} workspaceId="ws-1" budgets={budgets} spend={spend} />,
    );
    // Should show workspace budget ($2.00 limit), not global ($50.00)
    expect(screen.getByText(/\$0\.50 \/ \$2\.00/)).toBeTruthy();
    expect(screen.queryByText(/\$50\.00/)).toBeNull();
  });
});
