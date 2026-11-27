import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

const getMcpConfig = vi.fn();
const saveMcpConfig = vi.fn();
const testMcpServer = vi.fn();
const reconnectMcpServer = vi.fn();
const clearMcpSignIn = vi.fn();
const listMcpTrust = vi.fn();
const revokeMcpTrust = vi.fn();
const copyToClipboard = vi.fn();
const pushToast = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getMcpConfig: () => getMcpConfig(),
    saveMcpConfig: (...a: unknown[]) => saveMcpConfig(...a),
    testMcpServer: (...a: unknown[]) => testMcpServer(...a),
    reconnectMcpServer: (...a: unknown[]) => reconnectMcpServer(...a),
    clearMcpSignIn: (...a: unknown[]) => clearMcpSignIn(...a),
    listMcpTrust: () => listMcpTrust(),
    revokeMcpTrust: (...a: unknown[]) => revokeMcpTrust(...a),
  },
}));
vi.mock("../../lib/clipboard", () => ({ copyToClipboard: (...a: unknown[]) => copyToClipboard(...a) }));
vi.mock("../Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));

const { McpServersSection, draftFrom, mcpFailureFrom } = await import("./McpServersSection");

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

describe("draftFrom", () => {
  it("reads a local entry's fields", () => {
    const cfg = { command: "npx", args: ["-y", "example-server"], env: { A: "1", B: "two=three" } };
    const d = draftFrom("example", cfg);
    expect(d).toMatchObject({ name: "example", type: "local", command: "npx", argsText: "-y\nexample-server" });
    expect(d.env.map((r) => [r.name, r.value, r.secret])).toEqual([["A", "1", false], ["B", "two=three", false]]);
  });
});

describe("mcpFailureFrom", () => {
  it("reads the backend's classified failure", () => {
    expect(mcpFailureFrom({ kind: "McpFailure", message: "s", summary: "s", hint: "h", detail: "d" }))
      .toEqual({ summary: "s", hint: "h", detail: "d" });
    expect(mcpFailureFrom({ kind: "McpFailure", summary: "s", hint: null, detail: "d" }).hint).toBeNull();
  });

  it("falls back to the text of any other error", () => {
    expect(mcpFailureFrom("spawn bash: not found\nmore")).toEqual({
      summary: "spawn bash: not found",
      hint: null,
      detail: "spawn bash: not found\nmore",
    });
    expect(mcpFailureFrom(new Error("boom")).summary).toBe("boom");
  });
});

describe("McpServersSection", () => {
  beforeEach(() => {
    getMcpConfig.mockReset();
    saveMcpConfig.mockReset().mockResolvedValue(undefined);
    testMcpServer.mockReset();
    reconnectMcpServer.mockReset();
    copyToClipboard.mockReset().mockResolvedValue(true);
    clearMcpSignIn.mockReset();
    pushToast.mockReset();
  });

  it("lists configured servers and a Test action", async () => {
    getMcpConfig.mockResolvedValue({
      github: { command: "npx", args: ["-y", "@x/server-github"], env: {} },
    });
    render(<McpServersSection />);
    await settle();
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText(/npx -y @x\/server-github/)).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
  });

  it("a successful test shows the tool count", async () => {
    getMcpConfig.mockResolvedValue({ fs: { command: "bash", args: [], env: {} } });
    testMcpServer.mockResolvedValue([{ server: "fs", name: "read", namespaced: "mcp__fs__read", description: "" }]);
    render(<McpServersSection />);
    await settle();
    fireEvent.click(screen.getByText("Test"));
    await settle();
    expect(screen.getByText(/Connected · 1 tool/)).toBeInTheDocument();
  });

  it("Reconnect restarts the server for Talk and reports the smoke test", async () => {
    const fs = { command: "bash", args: ["server.sh"], env: {} };
    getMcpConfig.mockResolvedValue({ fs, github: { command: "npx", args: [], env: {} } });
    let answer: (tools: unknown[]) => void = () => {};
    reconnectMcpServer.mockReturnValue(new Promise((r) => { answer = r; }));
    const { container } = render(<McpServersSection />);
    await settle();

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
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect fs" }));
    await settle();
    expect(screen.getAllByText("spawn bash: not found")[0]).toBeInTheDocument();
  });

  describe("a failed test", () => {
    const detail =
      "MCP server closed the connection\n[123] Connecting to remote server: https://mcp.example.com/mcp\n" +
      "[123] Fatal error: Error: Dynamic Client Registration rejected (HTTP 404): Not Found";
    const failure = {
      kind: "McpFailure",
      message: "This server doesn't support automatic sign-in.",
      summary: "This server doesn't support automatic sign-in.",
      hint: "Use a token, or the OAuth client ID its admins give you.",
      detail,
    };

    async function failTest() {
      getMcpConfig.mockResolvedValue({ "example-remote": { command: "npx", args: ["-y", "mcp-remote"], env: {} } });
      testMcpServer.mockRejectedValue(failure);
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Test"));
      await settle();
    }

    it("shows the summary and hint, with the output folded under Details", async () => {
      await failTest();
      expect(screen.getByText(failure.summary)).toBeInTheDocument();
      expect(screen.getByText(failure.hint)).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: "Details" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const pre = screen.getByTestId("mcp-failure-detail");
      expect(pre.textContent).toBe(detail);
      // Folded: hidden from assistive tech and inert.
      expect(pre.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("button", { name: "Copy the full output" })).toBeNull();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(pre.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
      // Selectable (the body is user-select: none), scrollable, wrapped.
      expect(pre).toHaveClass("octo-selectable", "overflow-auto", "whitespace-pre-wrap");
      expect(pre.className).not.toMatch(/break-all/);
    });

    it("the summary and hint are selectable", async () => {
      await failTest();
      const summary = screen.getByText(failure.summary);
      expect(summary.closest(".octo-selectable")).not.toBeNull();
      expect(screen.getByText(failure.hint).closest(".octo-selectable")).toBe(summary.closest(".octo-selectable"));
    });

    it("Copy puts the full output on the clipboard", async () => {
      await failTest();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const copy = screen.getByRole("button", { name: "Copy the full output" });
      expect(copy).toHaveAttribute("title", "Copy the full output");
      fireEvent.click(copy);
      expect(copyToClipboard).toHaveBeenCalledWith(detail, "Output copied");
    });
  });

  describe("editing a server", () => {
    const github = { command: "npx", args: ["-y", "@x/server-github"], env: { GITHUB_TOKEN: "ghp_x" } };
    const fs = { command: "bash", args: ["server.sh"], env: {} };

    async function openEdit() {
      getMcpConfig.mockResolvedValue({ github, fs });
      const view = render(<McpServersSection />);
      await settle();
      const edit = screen.getByRole("button", { name: "Edit fs" });
      expect(edit).toHaveAttribute("title", "Edit server");
      // The first row's (sorted, fs) pencil is the tour anchor, and only it.
      expect(view.container.querySelectorAll('[data-tour="settings-mcp-edit"]')).toHaveLength(1);
      expect(view.container.querySelector('[data-tour="settings-mcp-edit"]')).toBe(edit);
      fireEvent.click(edit);
      return { view, form: screen.getByRole("group", { name: "Edit fs" }) };
    }

    it("opens the form prefilled, one server at a time", async () => {
      const { form } = await openEdit();
      expect(within(form).getByLabelText("Name")).toHaveValue("fs");
      expect(within(form).getByLabelText("Command")).toHaveValue("bash");
      expect(within(form).getByLabelText("Args")).toHaveValue("server.sh");
      // The edited row's buttons give way to the form; the others can't open a second one.
      expect(screen.queryByRole("button", { name: "Edit fs" })).toBeNull();
      expect(screen.getByRole("button", { name: "Edit github" })).toBeDisabled();
      expect(screen.getByText("Add MCP server").closest("button")).toBeDisabled();
    });

    it("prefills env as rows; a plain value that looks secret is kept in the Keychain from the next save", async () => {
      getMcpConfig.mockResolvedValue({ github });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit github" }));
      expect(screen.getByLabelText("Variable 1 name")).toHaveValue("GITHUB_TOKEN");
      const value = screen.getByLabelText("Variable 1 value");
      expect(value).toHaveValue("ghp_x");
      expect(value).toHaveAttribute("type", "password");
      const keep = screen.getByRole("switch", { name: "Keep variable 1 in Keychain" });
      expect(keep).toHaveAttribute("aria-checked", "true");
      expect(keep).toHaveAttribute("title", "Keep in Keychain");
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        { github: { ...github, env: { GITHUB_TOKEN: "" }, secret_env: ["GITHUB_TOKEN"], plain_env: [] } },
        { github: { GITHUB_TOKEN: "ghp_x" } },
        {},
      );
    });

    it("a saved secret shows as saved and stays saved unless a new value is typed", async () => {
      const saved = { command: "uvx", args: [], env: { API_KEY: "", LOG: "debug" }, secret_env: ["API_KEY"] };
      getMcpConfig.mockResolvedValue({ example: saved });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example" }));
      const value = screen.getByLabelText("Variable 1 value");
      expect(screen.getByLabelText("Variable 1 name")).toHaveValue("API_KEY");
      expect(value).toHaveValue("");
      expect(value).toHaveAttribute("placeholder", "•••• saved");
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenLastCalledWith(
        { example: { ...saved, plain_env: [] } },
        { example: {} },
        {},
      );
      // A new value goes apart from the entry.
      fireEvent.click(screen.getByRole("button", { name: "Edit example" }));
      fireEvent.change(screen.getByLabelText("Variable 1 value"), { target: { value: "k-new" } });
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenLastCalledWith(
        { example: { ...saved, plain_env: [] } },
        { example: { API_KEY: "k-new" } },
        {},
      );
    });

    it("turning Keep in Keychain off on a saved value asks for the value first", async () => {
      const saved = { command: "uvx", args: [], env: { API_KEY: "" }, secret_env: ["API_KEY"] };
      getMcpConfig.mockResolvedValue({ example: saved });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example" }));
      fireEvent.click(screen.getByRole("switch", { name: "Keep variable 1 in Keychain" }));
      expect(screen.getByText("type the value to store it in plain text")).toBeInTheDocument();
      expect(screen.getByText("Save changes").closest("button")).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Variable 1 value"), { target: { value: "k-plain" } });
      expect(screen.queryByText("type the value to store it in plain text")).toBeNull();
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        { example: { ...saved, env: { API_KEY: "k-plain" }, secret_env: [], plain_env: ["API_KEY"] } },
        { example: {} },
        {},
      );
    });

    it("a failed save shows what is really saved, not the half-done list", async () => {
      const legacy = { command: "uvx", args: [], env: { API_KEY: "k-plain" } };
      getMcpConfig.mockResolvedValue({ example: legacy });
      saveMcpConfig.mockRejectedValue("couldn't save it to the Keychain: denied");
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example" }));
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      await settle();
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Save failed" }));
      expect(getMcpConfig).toHaveBeenCalledTimes(2);
      // Reopened, the value is still the plain one the file holds, not "•••• saved".
      fireEvent.click(screen.getByRole("button", { name: "Edit example" }));
      expect(screen.getByLabelText("Variable 1 value")).toHaveValue("k-plain");
    });

    it("Keep in Keychain follows a new variable's name until it's set, and a plain one stays in the file", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      fireEvent.click(screen.getByText("Add a variable"));
      fireEvent.change(screen.getByLabelText("Variable 1 name"), { target: { value: "AUTH_MODE" } });
      const keep = screen.getByRole("switch", { name: "Keep variable 1 in Keychain" });
      expect(keep).toHaveAttribute("aria-checked", "true");
      // A secret needs a value before it can be saved.
      expect(screen.getByText("Save changes").closest("button")).toBeDisabled();
      fireEvent.click(keep);
      expect(keep).toHaveAttribute("aria-checked", "false");
      fireEvent.change(screen.getByLabelText("Variable 1 value"), { target: { value: "basic" } });
      expect(screen.getByLabelText("Variable 1 value")).toHaveAttribute("type", "text");
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        { fs: { ...fs, env: { AUTH_MODE: "basic" }, secret_env: [], plain_env: ["AUTH_MODE"] } },
        { fs: {} },
        {},
      );
    });

    it("saving replaces the entry through the save path", async () => {
      const { form } = await openEdit();
      fireEvent.change(within(form).getByLabelText("Args"), { target: { value: "server.sh\n--verbose" } });
      fireEvent.click(within(form).getByText("Add a variable"));
      fireEvent.change(within(form).getByLabelText("Variable 1 name"), { target: { value: "LOG" } });
      fireEvent.change(within(form).getByLabelText("Variable 1 value"), { target: { value: "debug" } });
      fireEvent.click(within(form).getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        {
          github,
          fs: { command: "bash", args: ["server.sh", "--verbose"], env: { LOG: "debug" }, secret_env: [], plain_env: [] },
        },
        { fs: {} },
        {},
      );
      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.getByText(/bash server.sh --verbose/)).toBeInTheDocument();
    });

    it("a rename drops the old name, and can't take another server's", async () => {
      const { form } = await openEdit();
      const name = within(form).getByLabelText("Name");
      fireEvent.change(name, { target: { value: "github" } });
      expect(within(form).getByText("name already exists")).toBeInTheDocument();
      expect(within(form).getByText("Save changes").closest("button")).toBeDisabled();

      fireEvent.change(name, { target: { value: "files" } });
      expect(within(form).queryByText("name already exists")).toBeNull();
      fireEvent.click(within(form).getByText("Save changes"));
      await settle();
      // The rename travels with the save, so the Keychain items move too.
      expect(saveMcpConfig).toHaveBeenCalledWith(
        { github, files: { ...fs, secret_env: [], plain_env: [] } },
        { files: {} },
        { files: "fs" },
      );
      expect(screen.getByText("files")).toBeInTheDocument();
      expect(screen.queryByText("fs")).toBeNull();
    });

    it("keeping its own name isn't a duplicate", async () => {
      const { form } = await openEdit();
      expect(within(form).queryByText("name already exists")).toBeNull();
      expect(within(form).getByText("Save changes").closest("button")).not.toBeDisabled();
    });

    it("Cancel restores the saved entry", async () => {
      const { form } = await openEdit();
      fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "zsh" } });
      fireEvent.click(within(form).getByText("Cancel"));
      expect(saveMcpConfig).not.toHaveBeenCalled();
      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.getByText(/bash server.sh/)).toBeInTheDocument();
      // Reopening shows the saved values, not the abandoned draft.
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      expect(screen.getByLabelText("Command")).toHaveValue("bash");
    });

    it("a test still running can't be overtaken by an edit, and its result is dropped once the entry is gone", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      let answer: (tools: unknown[]) => void = () => {};
      testMcpServer.mockReturnValue(new Promise((r) => { answer = r; }));
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Test"));
      // Start Test, then Edit: Edit waits for the test.
      const edit = screen.getByRole("button", { name: "Edit fs" });
      expect(edit).toBeDisabled();
      fireEvent.click(edit);
      expect(screen.queryByRole("group")).toBeNull();

      // The entry goes and comes back with another command while the old
      // test runs; the old test's answer describes neither.
      fireEvent.click(screen.getByRole("button", { name: "Remove fs" }));
      await settle();
      fireEvent.click(screen.getByText("Add MCP server"));
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "fs" } });
      fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "uvx" } });
      fireEvent.click(within(form).getByText("Add server"));
      await settle();
      await act(async () => {
        answer([{ server: "fs", name: "a", namespaced: "mcp__fs__a", description: "" }, { server: "fs", name: "b", namespaced: "mcp__fs__b", description: "" }]);
      });
      expect(screen.queryByText(/Connected/)).toBeNull();
      expect(screen.getByRole("button", { name: "Edit fs" })).not.toBeDisabled();
    });

    it("a Reconnect still running drops its result once its entry was removed", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      let answer: (tools: unknown[]) => void = () => {};
      reconnectMcpServer.mockReturnValue(new Promise((r) => { answer = r; }));
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Reconnect fs" }));
      expect(screen.getByRole("button", { name: "Edit fs" })).toBeDisabled();
      // Remove bumps the generation; the same name comes back with another command.
      fireEvent.click(screen.getByRole("button", { name: "Remove fs" }));
      await settle();
      expect(saveMcpConfig).toHaveBeenLastCalledWith({}, {}, {});
      fireEvent.click(screen.getByText("Add MCP server"));
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "fs" } });
      fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "uvx" } });
      fireEvent.click(within(form).getByText("Add server"));
      await settle();
      await act(async () => {
        answer([{ server: "fs", name: "a", namespaced: "mcp__fs__a", description: "" }]);
      });
      expect(screen.queryByText(/Reconnected/)).toBeNull();
      expect(screen.getByRole("button", { name: "Reconnect fs" })).not.toBeDisabled();
    });

    it("a Reconnect that finishes on the same entry still shows its result", async () => {
      getMcpConfig.mockResolvedValue({ fs, github });
      let answer: (tools: unknown[]) => void = () => {};
      reconnectMcpServer.mockReturnValue(new Promise((r) => { answer = r; }));
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Reconnect fs" }));
      // Removing another server leaves this one's generation alone.
      fireEvent.click(screen.getByRole("button", { name: "Remove github" }));
      await settle();
      await act(async () => {
        answer([{ server: "fs", name: "a", namespaced: "mcp__fs__a", description: "" }]);
      });
      expect(screen.getByText(/Reconnected · 1 tool/)).toBeInTheDocument();
    });

    it("saving an edit keeps the keys the form doesn't show", async () => {
      const withExtras = { ...fs, cwd: "/repo", type: "stdio", disabled: false };
      getMcpConfig.mockResolvedValue({ fs: withExtras });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      fireEvent.change(screen.getByLabelText("Args"), { target: { value: "server.sh\n--verbose" } });
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        { fs: { ...withExtras, args: ["server.sh", "--verbose"], secret_env: [], plain_env: [] } },
        { fs: {} },
        {},
      );
    });

    it("shows the entries the backend saved, and only the latest save's", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      const answers: Array<(saved: Record<string, unknown>) => void> = [];
      saveMcpConfig.mockImplementation(() => new Promise((r) => { answers.push(r); }));
      render(<McpServersSection />);
      await settle();
      // Save 1: Args changed.
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      fireEvent.change(screen.getByLabelText("Args"), { target: { value: "one.sh" } });
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      // Save 2, before save 1 answers.
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      fireEvent.change(screen.getByLabelText("Args"), { target: { value: "two.sh" } });
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(answers).toHaveLength(2);
      // The backend answers save 2 first, with its own resolved command, then save 1 late.
      await act(async () => { answers[1]({ fs: { command: "/opt/homebrew/bin/bash", args: ["two.sh"], env: {} } }); });
      expect(screen.getByText("/opt/homebrew/bin/bash two.sh")).toBeInTheDocument();
      await act(async () => { answers[0]({ fs: { command: "/opt/homebrew/bin/bash", args: ["one.sh"], env: {} } }); });
      expect(screen.getByText("/opt/homebrew/bin/bash two.sh")).toBeInTheDocument();
      expect(screen.queryByText(/one\.sh/)).toBeNull();
    });

    it("a duplicate check that a prototype key can't fool", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Add MCP server"));
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "constructor" } });
      fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "uvx" } });
      expect(within(form).queryByText("name already exists")).toBeNull();
      expect(within(form).getByText("Add server").closest("button")).not.toBeDisabled();
    });

    it("an old test result is dropped once the entry is saved", async () => {
      getMcpConfig.mockResolvedValue({ fs });
      testMcpServer.mockRejectedValue({ kind: "McpFailure", summary: "The server exited before it answered.", hint: null, detail: "x" });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Test"));
      await settle();
      expect(screen.getByText("The server exited before it answered.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Edit fs" }));
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      expect(screen.queryByText("The server exited before it answered.")).toBeNull();
    });
  });

  it("adding a server still works and keeps the duplicate guard", async () => {
    getMcpConfig.mockResolvedValue({ fs: { command: "bash", args: [], env: {} } });
    render(<McpServersSection />);
    await settle();
    fireEvent.click(screen.getByText("Add MCP server"));
    const form = screen.getByRole("group", { name: "Add an MCP server" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "fs" } });
    fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "uvx" } });
    expect(within(form).getByText("name already exists")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "example" } });
    fireEvent.click(within(form).getByText("Add server"));
    await settle();
    expect(saveMcpConfig).toHaveBeenCalledWith(
      {
        fs: { command: "bash", args: [], env: {} },
        example: { command: "uvx", args: [], env: {}, secret_env: [], plain_env: [] },
      },
      { example: {} },
      {},
    );
  });

  describe("remote servers", () => {
    const URL = "https://mcp.example.com/mcp";
    const saved = {
      command: "/opt/homebrew/bin/npx",
      args: ["-y", "mcp-remote", URL],
      env: {},
      remote: { url: URL, auth: "oauth" as const, transport: "auto" as const },
    };

    it("a row shows the URL, not the bridge's command line", async () => {
      getMcpConfig.mockResolvedValue({ "example-remote": saved });
      render(<McpServersSection />);
      await settle();
      expect(screen.getByText(URL)).toHaveAttribute("title", URL);
      expect(screen.getByLabelText("Remote server").closest("[title]")).toHaveAttribute("title", "Remote server");
      expect(screen.queryByText(/-y mcp-remote/)).toBeNull();
    });

    it("adds a server by URL, and shows what the backend saved", async () => {
      getMcpConfig.mockResolvedValue({});
      saveMcpConfig.mockImplementation(async (servers: Record<string, unknown>) => ({
        ...servers,
        "example-remote": saved,
      }));
      const { container } = render(<McpServersSection />);
      await settle();
      const add = screen.getByText("Add MCP server").closest("button")!;
      expect(container.querySelector('[data-tour="settings-mcp-add"]')).toBe(add);
      fireEvent.click(add);
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      expect(container.querySelector('[data-tour="settings-mcp-type"]')).not.toBeNull();
      fireEvent.click(within(form).getByRole("radio", { name: "Remote URL" }));
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "example-remote" } });
      const url = await within(form).findByLabelText("URL");
      fireEvent.change(url, { target: { value: "http://mcp.example.com/mcp" } });
      expect(within(form).getByText(/https:\/\/ URL/)).toBeInTheDocument();
      expect(within(form).getByText("Add server").closest("button")).toBeDisabled();
      fireEvent.change(url, { target: { value: URL } });
      // Browser (OAuth) is the default sign-in.
      expect(within(form).getByRole("radio", { name: "Browser (OAuth)" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(within(form).getByText("Add server"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        {
          "example-remote": {
            command: "npx",
            args: [],
            env: {},
            secret_env: [],
            plain_env: [],
            remote: { url: URL, auth: "oauth", transport: "auto" },
          },
        },
        { "example-remote": {} },
        {},
      );
      expect(screen.getByText(URL)).toBeInTheDocument();
    });

    it("a token sign-in is masked and goes to the Keychain, never into the entry", async () => {
      getMcpConfig.mockResolvedValue({});
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Add MCP server"));
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      fireEvent.click(within(form).getByRole("radio", { name: "Remote URL" }));
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "example-remote" } });
      fireEvent.change(await within(form).findByLabelText("URL"), { target: { value: URL } });
      fireEvent.click(within(form).getByRole("radio", { name: "Token" }));
      const token = await within(form).findByLabelText("Token");
      expect(token).toHaveAttribute("type", "password");
      expect(within(form).getByText("Add server").closest("button")).toBeDisabled();
      fireEvent.change(token, { target: { value: "tok-123" } });
      fireEvent.click(within(form).getByText("Add server"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        {
          "example-remote": {
            command: "npx",
            args: [],
            env: { OCTOPUSH_MCP_H_AUTHORIZATION: "" },
            secret_env: ["OCTOPUSH_MCP_H_AUTHORIZATION"],
            plain_env: [],
            remote: { url: URL, auth: "token", transport: "auto" },
          },
        },
        { "example-remote": { OCTOPUSH_MCP_H_AUTHORIZATION: "tok-123" } },
        {},
      );
      expect(JSON.stringify(saveMcpConfig.mock.calls[0][0])).not.toContain("tok-123");
    });

    it("custom headers and the advanced choices", async () => {
      getMcpConfig.mockResolvedValue({});
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByText("Add MCP server"));
      const form = screen.getByRole("group", { name: "Add an MCP server" });
      fireEvent.click(within(form).getByRole("radio", { name: "Remote URL" }));
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "example-remote" } });
      fireEvent.change(await within(form).findByLabelText("URL"), { target: { value: URL } });
      fireEvent.click(within(form).getByRole("radio", { name: "Custom headers" }));
      fireEvent.change(await within(form).findByLabelText("Header 1 name"), { target: { value: "X-Api-Key" } });
      // A header that looks secret is kept in the Keychain, and masked.
      expect(within(form).getByRole("switch", { name: "Keep header 1 in Keychain" })).toHaveAttribute("aria-checked", "true");
      expect(within(form).getByLabelText("Header 1 value")).toHaveAttribute("type", "password");
      fireEvent.change(within(form).getByLabelText("Header 1 value"), { target: { value: "k" } });
      fireEvent.click(within(form).getByText("Add a header"));
      fireEvent.change(within(form).getByLabelText("Header 2 name"), { target: { value: "x_api_key" } });
      expect(within(form).getByText("each header once")).toBeInTheDocument();
      fireEvent.click(within(form).getByRole("button", { name: "Remove header 2" }));
      expect(within(form).getByRole("button", { name: "Remove header 1" })).toHaveAttribute("title", "Remove header");
      const advanced = within(form).getByRole("button", { name: "Advanced" });
      expect(advanced).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(advanced);
      fireEvent.click(within(form).getByRole("radio", { name: "SSE only" }));
      fireEvent.click(within(form).getByText("Add server"));
      await settle();
      expect(saveMcpConfig).toHaveBeenCalledWith(
        {
          "example-remote": {
            command: "npx",
            args: [],
            env: { OCTOPUSH_MCP_H_X_API_KEY: "" },
            secret_env: ["OCTOPUSH_MCP_H_X_API_KEY"],
            plain_env: [],
            remote: { url: URL, auth: "headers", transport: "sse-only", header_names: ["X-Api-Key"] },
          },
        },
        { "example-remote": { OCTOPUSH_MCP_H_X_API_KEY: "k" } },
        {},
      );
    });

    it("Edit reopens a remote server's choices, and offers Clear sign-in for a browser sign-in", async () => {
      const withClient = { ...saved, remote: { ...saved.remote, client_id: "client-abc", transport: "http-only" as const } };
      getMcpConfig.mockResolvedValue({ "example-remote": withClient });
      clearMcpSignIn.mockResolvedValue(2);
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example-remote" }));
      const form = screen.getByRole("group", { name: "Edit example-remote" });
      expect(within(form).getByRole("radio", { name: "Remote URL" })).toHaveAttribute("aria-checked", "true");
      expect(within(form).getByLabelText("URL")).toHaveValue(URL);
      // Advanced opens on its own when it holds something.
      expect(within(form).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
      expect(within(form).getByLabelText("OAuth client ID")).toHaveValue("client-abc");
      expect(within(form).getByRole("radio", { name: "HTTP only" })).toHaveAttribute("aria-checked", "true");

      const clear = within(form).getByText("Clear sign-in");
      expect(clear).toHaveAttribute("title", expect.stringMatching(/browser sign-in/));
      fireEvent.click(clear);
      await settle();
      expect(clearMcpSignIn).toHaveBeenCalledWith("example-remote", withClient);
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "success", title: "Sign-in cleared" }));
      expect(saveMcpConfig).not.toHaveBeenCalled();
    });

    it("no Clear sign-in for a token server or while adding", async () => {
      getMcpConfig.mockResolvedValue({
        "example-remote": { ...saved, env: { OCTOPUSH_MCP_H_AUTHORIZATION: "Bearer tok-123" }, remote: { ...saved.remote, auth: "token" as const } },
      });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example-remote" }));
      const form = screen.getByRole("group", { name: "Edit example-remote" });
      expect(within(form).getByLabelText("Token")).toHaveValue("tok-123");
      expect(within(form).queryByText("Clear sign-in")).toBeNull();
    });

    it("a saved client secret can be forgotten, keeping the client id", async () => {
      const withSecret = {
        ...saved,
        env: { OCTOPUSH_MCP_CLIENT_SECRET: "" },
        secret_env: ["OCTOPUSH_MCP_CLIENT_SECRET"],
        remote: { ...saved.remote, client_id: "client-abc" },
      };
      getMcpConfig.mockResolvedValue({ "example-remote": withSecret });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example-remote" }));
      expect(screen.getByLabelText("OAuth client secret")).toHaveAttribute("placeholder", "•••• saved");
      const forget = screen.getByRole("button", { name: "Forget the saved client secret" });
      expect(forget).toHaveAttribute("title", expect.stringMatching(/client ID stays/));
      fireEvent.click(forget);
      expect(screen.getByLabelText("OAuth client secret")).toHaveAttribute("placeholder", "Only if one was issued");
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      const [servers, secrets] = saveMcpConfig.mock.calls[0];
      expect(servers["example-remote"].remote.client_id).toBe("client-abc");
      expect(servers["example-remote"].secret_env).toEqual([]);
      expect(servers["example-remote"].env).toEqual({});
      expect(secrets).toEqual({ "example-remote": {} });
    });

    it("a saved token reads as saved and needn't be typed again", async () => {
      const tokenServer = {
        ...saved,
        env: { OCTOPUSH_MCP_H_AUTHORIZATION: "" },
        secret_env: ["OCTOPUSH_MCP_H_AUTHORIZATION"],
        remote: { ...saved.remote, auth: "token" as const },
      };
      getMcpConfig.mockResolvedValue({ "example-remote": tokenServer });
      render(<McpServersSection />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Edit example-remote" }));
      const token = screen.getByLabelText("Token");
      expect(token).toHaveValue("");
      expect(token).toHaveAttribute("placeholder", "•••• saved");
      fireEvent.click(screen.getByText("Save changes"));
      await settle();
      const [servers, secrets] = saveMcpConfig.mock.calls[0];
      expect(servers["example-remote"].secret_env).toEqual(["OCTOPUSH_MCP_H_AUTHORIZATION"]);
      expect(secrets).toEqual({ "example-remote": {} });
    });
  });
});

describe("McpServersSection trust (#1243)", () => {
  it("lists what each server is trusted with, a project's own server too, and revokes a line at once", async () => {
    getMcpConfig.mockReset().mockResolvedValue({ "sample-server": { command: "sample", args: [] } });
    listMcpTrust.mockReset().mockResolvedValue([
      { server: "sample-server", all: true, tools: ["post_report"] },
      { server: "project-server", all: false, tools: ["create_note"] },
    ]);
    revokeMcpTrust.mockReset().mockResolvedValue([{ server: "sample-server", all: true, tools: [] }, { server: "project-server", all: false, tools: ["create_note"] }]);
    render(<McpServersSection />);
    await settle();
    await settle();
    expect(screen.getByText("every tool (one it marks destructive still asks)")).toBeInTheDocument();
    expect(screen.getByText("post_report")).toBeInTheDocument();
    expect(screen.getByText("create_note")).toBeInTheDocument();
    expect(screen.getByText(/not configured here/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke post_report" }));
    });
    expect(revokeMcpTrust).toHaveBeenCalledWith("sample-server", "post_report");
    expect(screen.queryByText("post_report")).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke the trust in sample-server" })).toBeInTheDocument();
  });
});
