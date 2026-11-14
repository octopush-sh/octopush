/** Settings › Integrations — the Claude Code card's installed-CLI version row. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", () => ({
  ipc: {
    mcpConnectionStatus: vi.fn().mockResolvedValue({
      registered: true,
      claudeFound: true,
      binaryFound: true,
      binaryPath: "/x/octopush-mcp",
      manualCommand: "claude mcp add octopush -s user -- /x/octopush-mcp",
    }),
    claudeCliVersion: cliVersionMock,
  },
}));
vi.mock("./IssueTrackingSection", () => ({ IssueTrackingSection: () => <div /> }));
vi.mock("./McpServersSection", () => ({ McpServersSection: () => <div /> }));

const { IntegrationsPane } = await import("./IntegrationsPane");
const { resetClaudeCliVersionCache } = await import("../../lib/claudeCli");

beforeEach(() => {
  resetClaudeCliVersionCache();
  cliVersionMock.mockReset();
});

const escapeFix = { version: "2.1.319", reason: "fixes a sandbox escape when creating a worktree" };

describe("Claude Code card — CLI version", () => {
  it("shows the version and an amber update row with the reason when below the floor", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.307", floor: "2.1.314", belowFloor: true });
    const { container } = render(<IntegrationsPane />);
    const row = await screen.findByTestId("claude-cli-update");
    expect(row.textContent).toContain("Update Claude Code (2.1.314 or newer recommended)");
    expect(row.textContent).toContain("wrong token usage");
    expect(container.querySelector('[data-tour="settings-claude-cli-version"]')?.textContent).toContain("2.1.307");
  });

  it("recommends the security fix over the floor when the floor still lacks it", async () => {
    cliVersionMock.mockResolvedValue({
      version: "2.1.307", floor: "2.1.314", belowFloor: true, securityFix: escapeFix, recommended: "2.1.319",
    });
    render(<IntegrationsPane />);
    const row = await screen.findByTestId("claude-cli-update");
    expect(row.textContent).toContain("Update Claude Code (2.1.319 or newer recommended)");
    expect(row.textContent).not.toContain("sandbox escape");
  });

  it("shows the security note, like Readiness and the launcher, at or above the floor", async () => {
    cliVersionMock.mockResolvedValue({
      version: "2.1.316", floor: "2.1.314", belowFloor: false, securityFix: escapeFix, recommended: "2.1.319",
    });
    const { container } = render(<IntegrationsPane />);
    const row = await screen.findByTestId("claude-cli-update");
    expect(row.getAttribute("data-tour")).toBe("settings-claude-cli-update");
    expect(row.textContent).toBe("Update Claude Code: 2.1.319 fixes a sandbox escape when creating a worktree");
    expect(container.querySelector('[data-tour="settings-claude-cli-version"]')?.textContent).toContain("2.1.316");
  });

  it("shows only the version when it is current", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    const { container } = render(<IntegrationsPane />);
    await waitFor(() =>
      expect(container.querySelector('[data-tour="settings-claude-cli-version"]')?.textContent).toContain("2.1.316"),
    );
    expect(screen.queryByTestId("claude-cli-update")).not.toBeInTheDocument();
  });

  it("draws Connect and Copy as ghost buttons, leaving the page's brass CTA to Jira's Save changes", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    const { container } = render(<IntegrationsPane />);
    const connect = await screen.findByRole("button", { name: "Reconnect to Claude Code" });
    const copy = screen.getByRole("button", { name: "Copy" });
    for (const btn of [connect, copy]) {
      expect(btn.className).toContain("border-octo-border-strong");
      expect(btn.className).not.toContain("border-octo-hairline");
      expect(btn.className).toContain("text-octo-sage");
      expect(btn.className).not.toContain("text-octo-brass");
    }
    expect(container.querySelector("button.text-octo-brass")).toBeNull();
  });

  it("shows nothing when the CLI isn't found", async () => {
    cliVersionMock.mockResolvedValue({ version: null, floor: "2.1.314", belowFloor: false });
    const { container } = render(<IntegrationsPane />);
    await waitFor(() => expect(cliVersionMock).toHaveBeenCalled());
    expect(container.querySelector('[data-tour="settings-claude-cli-version"]')).toBeNull();
    expect(screen.queryByTestId("claude-cli-update")).not.toBeInTheDocument();
  });
});
