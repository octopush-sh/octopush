/**
 * Settings → Privacy — the outbound-traffic statement must be exactly true:
 * sync is named as opt-in, account/updater/integration traffic is disclosed,
 * and the old "only to providers you configure" claim is gone.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrivacyPane, OUTBOUND } from "./PrivacyPane";

describe("PrivacyPane", () => {
  it("lists every outbound destination", () => {
    render(<PrivacyPane />);
    const list = screen.getByTestId("privacy-outbound");
    const text = list.textContent ?? "";
    expect(list.querySelectorAll("li")).toHaveLength(OUTBOUND.length);
    for (const needle of [
      "Anthropic",
      "OpenAI-compatible",
      "local models",
      "Clerk",
      "Dodo Payments",
      "Octopush's sync service, only if you turn on sync",
      "Jira",
      "GitHub",
      "LiteLLM gateway",
      "MCP servers",
      "git remotes",
      "octopush.sh/update/latest.json",
      "GitHub releases",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("keeps the no-analytics promise and drops the stale providers-only claim", () => {
    const { container } = render(<PrivacyPane />);
    expect(screen.getByText("No analytics, no telemetry.")).toBeInTheDocument();
    expect(container.textContent).not.toContain("only to providers you configure");
    expect(container.textContent).toContain("leave it only if you turn on sync");
  });
});
