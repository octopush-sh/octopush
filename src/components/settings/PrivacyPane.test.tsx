/**
 * Settings → Privacy — the outbound-traffic statement must be exactly true:
 * sync is named as opt-in, account/updater/integration traffic is disclosed,
 * and the old "only to providers you configure" claim is gone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const getSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    saveSettings: (...args: unknown[]) => saveSettings(...args),
  },
}));

import {
  PrivacyPane,
  OUTBOUND,
  AGENT_CLI_NOTE,
  PATH_CHIP_CLASS,
  QUIET_ENV,
  QUIET_LABEL,
  QUIET_OFF_NOTE,
} from "./PrivacyPane";

const BASE_SETTINGS = { providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} };

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({ ...BASE_SETTINGS });
  saveSettings.mockReset().mockResolvedValue(undefined);
});

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

/** The owner-approved copy (#703), verbatim — a change here is a privacy-copy
 *  change and needs the owner's approval first. */
const APPROVED_HELP =
  "Crew stages and Routines start Claude Code with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. Claude Code then skips its auto-updates, telemetry, error reporting, release notes and availability checks. Features that need feature-flag fetching, such as Remote Control, don't work in those sessions. Your model requests to Anthropic still go out as usual. Run terminals are not affected.";
const APPROVED_OFF_NOTE =
  "When this is off, Claude Code in crew stages and Routines can also make its own nonessential calls (auto-update checks, telemetry, error reports), as described in Claude Code's documentation.";

describe("PrivacyPane — Quiet Claude Code (#703)", () => {
  const toggle = () => screen.getByTestId("quiet-claude-code-switch");

  it("is off when nothing is saved, with the approved label, helper and off sentence", async () => {
    await act(async () => {
      render(<PrivacyPane />);
    });
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle()).toHaveAccessibleName("Quiet Claude Code in crews and Routines");
    expect(QUIET_LABEL).toBe("Quiet Claude Code in crews and Routines");
    const row = document.querySelector('[data-tour="settings-quiet-claude-code"]');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent(QUIET_LABEL + APPROVED_HELP, { normalizeWhitespace: false });
    expect(QUIET_OFF_NOTE).toBe(APPROVED_OFF_NOTE);
    expect(screen.getByTestId("privacy-quiet-off-note")).toHaveTextContent(APPROVED_OFF_NOTE, {
      normalizeWhitespace: false,
    });
  });

  it("sets the variable as an ivory code chip, never brass", async () => {
    await act(async () => {
      render(<PrivacyPane />);
    });
    const chip = screen.getByText(QUIET_ENV);
    expect(QUIET_ENV).toBe("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    expect(chip.tagName).toBe("CODE");
    expect(chip).toHaveClass(...PATH_CHIP_CLASS.split(" "));
    expect(chip).not.toHaveClass("text-octo-brass");
  });

  it("places the off sentence right under the toggle, after the outbound statement", async () => {
    await act(async () => {
      render(<PrivacyPane />);
    });
    const agentCli = screen.getByTestId("privacy-agent-cli");
    const row = document.querySelector('[data-tour="settings-quiet-claude-code"]')!;
    const note = screen.getByTestId("privacy-quiet-off-note");
    expect(agentCli.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.nextElementSibling).toBe(note);
  });

  it("reads a saved true as on", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, quietClaudeCode: true });
    await act(async () => {
      render(<PrivacyPane />);
    });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
  });

  it("turning it on saves quietClaudeCode with the other fields intact", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, editorCommand: "cursor" });
    await act(async () => {
      render(<PrivacyPane />);
    });
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ editorCommand: "cursor", quietClaudeCode: true }),
    );
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });

  it("turning it off saves false", async () => {
    getSettings.mockResolvedValue({ ...BASE_SETTINGS, quietClaudeCode: true });
    await act(async () => {
      render(<PrivacyPane />);
    });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ quietClaudeCode: false }));
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("puts the switch back when the save fails", async () => {
    saveSettings.mockRejectedValue(new Error("settings.json couldn't be read"));
    await act(async () => {
      render(<PrivacyPane />);
    });
    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));
  });
});
