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

describe("Claude Code card — CLI version", () => {
  it("shows the version and an amber update row with the reason when below the floor", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.307", floor: "2.1.314", belowFloor: true });
    const { container } = render(<IntegrationsPane />);
    const row = await screen.findByTestId("claude-cli-update");
    expect(row.textContent).toContain("Update Claude Code (2.1.314 or newer recommended)");
    expect(row.textContent).toContain("wrong token usage");
    expect(container.querySelector('[data-tour="settings-claude-cli-version"]')?.textContent).toContain("2.1.307");
  });

  it("shows only the version when it is current", async () => {
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    const { container } = render(<IntegrationsPane />);
    await waitFor(() =>
      expect(container.querySelector('[data-tour="settings-claude-cli-version"]')?.textContent).toContain("2.1.316"),
    );
    expect(screen.queryByTestId("claude-cli-update")).not.toBeInTheDocument();
  });

  it("shows nothing when the CLI isn't found", async () => {
    cliVersionMock.mockResolvedValue({ version: null, floor: "2.1.314", belowFloor: false });
    const { container } = render(<IntegrationsPane />);
    await waitFor(() => expect(cliVersionMock).toHaveBeenCalled());
    expect(container.querySelector('[data-tour="settings-claude-cli-version"]')).toBeNull();
    expect(screen.queryByTestId("claude-cli-update")).not.toBeInTheDocument();
  });
});
