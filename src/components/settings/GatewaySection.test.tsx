/**
 * The gateway section's pure wording and its three readings: per-request
 * logs, whole UTC days, and the key's running total only.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GatewayReconciliation } from "../../lib/types";
import { GatewaySection, budgetLine, gapSummary } from "./GatewaySection";

const base: GatewayReconciliation = {
  gateway: { kind: "litellm", label: "LiteLLM", host: "llm.corp:4000", provider: "anthropic", keyAlias: null, keyHash: "abc", keySpendUsd: 12, keyMaxBudgetUsd: null, budgetResetAt: null },
  start: "s", end: "e",
  gatewayCostUsd: 10, gatewayRequests: 100, gatewayTokens: 1_000_000,
  ledgerCostUsd: 10, ledgerCalls: 100, ledgerTokens: 1_000_000,
  unaccountedCostUsd: 0, unaccountedRequests: 0,
  byModel: [{ model: "claude-sonnet-5", gatewayCostUsd: 10, gatewayRequests: 100, ledgerCostUsd: 10, ledgerCalls: 100 }],
  ledgerOnlyModels: ["local-llm"],
  unmatchedRequests: 0, unmatchedCostUsd: 0, unmatchedByModel: [],
  basis: "logs", note: null, fetchedAt: "now",
};

describe("gapSummary / budgetLine", () => {
  it("reads the gap, or says the two sides agree", () => {
    expect(gapSummary(base)).toBe("in step with the ledger");
    expect(gapSummary({ ...base, unaccountedCostUsd: 2.5, unaccountedRequests: 10 })).toBe("$2.50 · 25% not in the ledger");
    expect(gapSummary({ ...base, basis: "key" })).toBe("running total only");
    // A gateway reading below the ledger is a disagreement, not agreement.
    expect(gapSummary({ ...base, gatewayCostUsd: 0, gatewayRequests: 0, ledgerCostUsd: 14.08 })).toBe("$14.08 in the ledger the gateway did not bill");
  });

  it("names the key budget only when the gateway enforces one", () => {
    expect(budgetLine(base)).toBeNull();
    const g = { ...base.gateway, keyMaxBudgetUsd: 100, keySpendUsd: 40 };
    expect(budgetLine({ ...base, gateway: g })).toBe("Key budget · $40.00 of $100");
    expect(budgetLine({ ...base, gateway: { ...g, keySpendUsd: 120 } })).toBe("Key budget exhausted · $120 of $100");
  });
});

describe("GatewaySection", () => {
  it("renders the three figures, the model rows and what was not compared", () => {
    render(<GatewaySection report={base} />);
    expect(screen.getByTestId("usage-gateway-billed").textContent).toContain("100 requests");
    expect(screen.getByTestId("usage-gateway-ledger").textContent).toContain("100 calls");
    expect(screen.getByTestId("usage-gateway-models").textContent).toContain("claude-sonnet-5");
    expect(screen.queryByTestId("usage-gateway-budget")).toBeNull();
    expect(screen.queryByTestId("usage-gateway-unmatched")).toBeNull();
    expect(screen.getByTestId("usage-gateway").textContent).toContain("Not compared: local-llm.");
  });

  it("with only the key's running total, shows that and nothing per period", () => {
    render(<GatewaySection report={{ ...base, basis: "key", gatewayCostUsd: 12, byModel: [], note: "Only the key's running total was readable." }} />);
    expect(screen.queryByTestId("usage-gateway-billed")).toBeNull();
    expect(screen.getByTestId("usage-gateway").textContent).toContain("Key spend since its last reset");
    expect(screen.getByTestId("usage-gateway").textContent).toContain("$12.00");
    expect(screen.getByTestId("usage-gateway").textContent).toContain("Only the key's running total was readable.");
  });

  it("says it compares every mode when the page's Mode filter is on", () => {
    const { rerender } = render(<GatewaySection report={base} />);
    expect(screen.getByTestId("usage-gateway").textContent).not.toContain("every mode");
    rerender(<GatewaySection report={base} filtered />);
    expect(screen.getByTestId("usage-gateway").textContent).toContain("Compared against every mode");
  });

  it("carries the UTC-day caveat of the daily reading", () => {
    render(<GatewaySection report={{ ...base, basis: "daily", unmatchedRequests: null, unmatchedCostUsd: null, note: "The gateway reports whole UTC days." }} />);
    expect(screen.getByTestId("usage-gateway").textContent).toContain("whole UTC days");
    expect(screen.queryByTestId("usage-gateway-unmatched")).toBeNull();
  });
});
