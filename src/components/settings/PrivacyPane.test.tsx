/**
 * Settings → Privacy — the outbound-traffic statement must be exactly true:
 * sync is named as opt-in, account/updater/integration traffic is disclosed,
 * and the old "only to providers you configure" claim is gone.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrivacyPane, OUTBOUND, AGENT_CLI_NOTE, PATH_CHIP_CLASS } from "./PrivacyPane";

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

  it("says work leaves only with sync on, and that agent CLIs have their own policies", () => {
    render(<PrivacyPane />);
    expect(
      screen.getByText(/^Your work stays on this Mac, unless you turn on sync\. /),
    ).toBeInTheDocument();
    expect(screen.getByTestId("privacy-agent-cli")).toHaveTextContent(AGENT_CLI_NOTE);
    expect(AGENT_CLI_NOTE).toContain("Claude Code");
    expect(AGENT_CLI_NOTE).toContain("Codex");
  });
});

describe("PrivacyPane — inline paths (#560)", () => {
  it("sets file paths in ivory mono on the code chip, never brass", () => {
    const { container } = render(<PrivacyPane />);
    for (const path of ["~/Library/Application Support/octopush/octopush.db", "~/.octopush/settings.json"]) {
      const chip = screen.getByText(path);
      expect(chip.tagName).toBe("CODE");
      expect(chip).toHaveClass(...PATH_CHIP_CLASS.split(" "));
      expect(chip).not.toHaveClass("text-octo-brass");
    }
    // Brass survives only on the eyebrow.
    expect(Array.from(container.querySelectorAll(".text-octo-brass")).map((e) => e.textContent)).toEqual(["Privacy"]);
  });
});
