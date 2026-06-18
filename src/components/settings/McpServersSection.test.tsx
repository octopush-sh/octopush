import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const getMcpConfig = vi.fn();
const testMcpServer = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getMcpConfig: () => getMcpConfig(),
    saveMcpConfig: vi.fn().mockResolvedValue(undefined),
    testMcpServer: (...a: unknown[]) => testMcpServer(...a),
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
});
