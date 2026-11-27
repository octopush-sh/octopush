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
  AGENT_CLI_LEAD_IN,
  LEAD_IN_CLASS,
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
      "A webhook URL you set in Notify me elsewhere, only if you turn it on or send a test",
      "the project's name and the mission's title (the start of its task)",
      "never code, diffs, the crew's questions or agent output",
      "Jira",
      "Epiku",
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

/** The data inventory as it reads on screen, verbatim. A change here is a
 *  privacy-copy change and needs the owner's approval first (#875 changed
 *  the layout only; #964's webhook line is the PM's honest-copy decision, for
 *  the owner to approve at merge). */
const APPROVED_INVENTORY = [
  "Stored on this Mac: projects, workspaces, chats, tool executions, Direct runs, token usage — in ~/Library/Application Support/octopush/octopush.db. Runs and custom pipelines leave it only if you turn on sync.",
  "API keys: stored in ~/.octopush/settings.json. MCP servers you add in Settings: ~/.claude/mcp.json. A Token sign-in, an OAuth client secret, the values you mark Keep in Keychain and your Epiku token go to the macOS Keychain, and mcp-remote keeps a browser sign-in in ~/.mcp-auth. A project's own .claude/mcp.json stays as written; its servers start only once you approve them, and the approvals stay in octopush.db. Your account session lives in the macOS Keychain too.",
  "Outbound traffic, only to:" +
    "AI providers you configure — Anthropic, OpenAI-compatible endpoints, local models." +
    "Clerk for sign-in and Dodo Payments for checkout, when you use your account." +
    "Octopush's sync service, only if you turn on sync in Account." +
    "A webhook URL you set in Notify me elsewhere, only if you turn it on or send a test — a fixed label, the project's name and the mission's title (the start of its task), never code, diffs, the crew's questions or agent output." +
    "Integrations you connect — Jira, Epiku, GitHub, a LiteLLM gateway, MCP servers — and your git remotes." +
    "Update checks — octopush.sh/update/latest.json and GitHub releases." +
    "LiteLLM's public pricing table on GitHub, when you refresh pricing.",
  "No analytics, no telemetry.",
  "Agent CLIs Octopush launches for you (Claude Code, Codex) talk to their own services and follow their own telemetry policies.",
];

describe("PrivacyPane — the data inventory is a real list (#875)", () => {
  const items = () =>
    Array.from(screen.getByTestId("privacy-inventory").children) as HTMLElement[];

  it("renders the inventory word for word, with no hand-typed marker", () => {
    render(<PrivacyPane />);
    const list = screen.getByTestId("privacy-inventory");
    expect(items().map((li) => li.textContent)).toEqual(APPROVED_INVENTORY);
    expect(list.textContent).not.toContain("·");
    expect(OUTBOUND.join("")).toBe(APPROVED_INVENTORY[2].slice("Outbound traffic, only to:".length));
    expect(AGENT_CLI_NOTE).toBe(APPROVED_INVENTORY[4]);
  });

  it("gives every item the same native marker and a hanging indent", () => {
    render(<PrivacyPane />);
    const list = screen.getByTestId("privacy-inventory");
    expect(list.tagName).toBe("UL");
    expect(list).toHaveClass("list-disc", "pl-4");
    expect(list).not.toHaveClass("list-inside");
    expect(items()).toHaveLength(5);
    for (const li of items()) expect(li.tagName).toBe("LI");
  });

  it("opens every item with a serif lead-in", () => {
    render(<PrivacyPane />);
    const leads = items().map((li) => li.firstElementChild as HTMLElement);
    for (const lead of leads) {
      expect(lead.tagName).toBe("SPAN");
      expect(lead).toHaveClass(...LEAD_IN_CLASS.split(" "));
      // The lead-in is the very start of the item: nothing comes before it.
      expect(lead.previousSibling).toBeNull();
    }
    expect(leads.map((l) => l.textContent)).toEqual([
      "Stored on this Mac:",
      "API keys:",
      "Outbound traffic, only to:",
      "No analytics, no telemetry.",
      AGENT_CLI_LEAD_IN,
    ]);
    // The last lead-in is the sentence's own opening words, not added copy.
    expect(AGENT_CLI_NOTE.startsWith(`${AGENT_CLI_LEAD_IN} `)).toBe(true);
  });

  it("nests the outbound destinations one level in, with the same marker", () => {
    render(<PrivacyPane />);
    const outbound = screen.getByTestId("privacy-outbound");
    expect(outbound.tagName).toBe("UL");
    expect(outbound).toHaveClass("list-disc", "pl-4");
    expect(outbound).not.toHaveClass("list-inside");
    expect(outbound.parentElement).toBe(items()[2]);
    expect(Array.from(outbound.children).map((li) => li.tagName)).toEqual(OUTBOUND.map(() => "LI"));
    expect(Array.from(outbound.children).map((li) => li.textContent)).toEqual([...OUTBOUND]);
  });

  it("starts the note under the toggle at the content column", () => {
    render(<PrivacyPane />);
    const note = screen.getByTestId("privacy-quiet-off-note");
    expect(note.className).not.toMatch(/(^|\s)(p|m)[xlrse]?-/);
  });
});

describe("PrivacyPane — inline paths (#560)", () => {
  it("sets file paths in ivory mono on the code chip, never brass", () => {
    const { container } = render(<PrivacyPane />);
    for (const path of [
      "~/Library/Application Support/octopush/octopush.db",
      "~/.octopush/settings.json",
      "~/.claude/mcp.json",
      "~/.mcp-auth",
      ".claude/mcp.json",
    ]) {
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
