import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const getMcpConfig = vi.fn();
const testMcpServer = vi.fn();
const reconnectMcpServer = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getMcpConfig: () => getMcpConfig(),
    saveMcpConfig: vi.fn().mockResolvedValue(undefined),
    testMcpServer: (...a: unknown[]) => testMcpServer(...a),
    reconnectMcpServer: (...a: unknown[]) => reconnectMcpServer(...a),
  },
}));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));

const { McpServersSection, parseEnv } = await import("./McpServersSection");

describe("parseEnv", () => {
  it("parses KEY=value lines and skips blanks/comments", () => {
    expect(parseEnv("A=1\n\n# comment\nB=two=three")).toEqual({ A: "1", B: "two=three" });
  });
});

describe("McpServersSection", () => {
  beforeEach(() => {
    getMcpConfig.mockReset();
    testMcpServer.mockReset();
    reconnectMcpServer.mockReset();
  });

  it("lists configured servers and a Test action", async () => {
    getMcpConfig.mockResolvedValue({
      github: { command: "npx", args: ["-y", "@x/server-github"], env: {} },
    });
    render(<McpServersSection />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText(/npx -y @x\/server-github/)).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
  });

  it("a successful test shows the tool count", async () => {
    getMcpConfig.mockResolvedValue({ fs: { command: "bash", args: [], env: {} } });
    testMcpServer.mockResolvedValue([{ server: "fs", name: "read", namespaced: "mcp__fs__read", description: "" }]);
    render(<McpServersSection />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByText("Test"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Connected · 1 tool/)).toBeInTheDocument();
  });

  it("Reconnect restarts the server for Talk and reports the smoke test", async () => {
    const fs = { command: "bash", args: ["server.sh"], env: {} };
    getMcpConfig.mockResolvedValue({ fs, github: { command: "npx", args: [], env: {} } });
    let answer: (tools: unknown[]) => void = () => {};
    reconnectMcpServer.mockReturnValue(new Promise((r) => { answer = r; }));
    const { container } = render(<McpServersSection />);
    await act(async () => { await Promise.resolve(); });

    const button = screen.getByRole("button", { name: "Reconnect fs" });
    expect(button).toHaveAttribute("title", expect.stringMatching(/^Reconnect/));
    // The first row's button is the tour anchor, and only it.
    expect(container.querySelectorAll('[data-tour="settings-mcp-reconnect"]')).toHaveLength(1);
    expect(container.querySelector('[data-tour="settings-mcp-reconnect"]')).toBe(button);

    fireEvent.click(button);
    expect(reconnectMcpServer).toHaveBeenCalledWith("fs", fs);
    expect(testMcpServer).not.toHaveBeenCalled();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(screen.getAllByText("Test")[0].closest("button")).toBeDisabled();

    await act(async () => { answer([{ server: "fs", name: "read", namespaced: "mcp__fs__read", description: "" }]); });
    expect(screen.getByText(/Reconnected · 1 tool/)).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it("a failed reconnect shows its error", async () => {
    getMcpConfig.mockResolvedValue({ fs: { command: "bash", args: [], env: {} } });
    reconnectMcpServer.mockRejectedValue("spawn bash: not found");
    render(<McpServersSection />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect fs" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("spawn bash: not found")).toBeInTheDocument();
  });
});
