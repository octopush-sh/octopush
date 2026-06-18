/**
 * Tests for the Settings → Integrations pane (Issue Tracker section).
 * Asserts that the section renders, prefills from ipc.getIssueTrackerConfig,
 * and calls ipc.saveIssueTrackerConfig with user-entered values on save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ─── IPC mocks ────────────────────────────────────────────────────────

const getIssueTrackerConfigMock = vi.fn().mockResolvedValue(null);
const saveIssueTrackerConfigMock = vi.fn().mockResolvedValue(undefined);
const listRecentProjectsMock = vi.fn().mockResolvedValue([]);
const updateProjectJiraKeyMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/ipc", () => ({
  ipc: {
    getIssueTrackerConfig: getIssueTrackerConfigMock,
    saveIssueTrackerConfig: saveIssueTrackerConfigMock,
    listRecentProjects: listRecentProjectsMock,
    updateProjectJiraKey: updateProjectJiraKeyMock,
    // stub the rest so Settings doesn't throw on other panes mounting
    listProviders: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    saveProviders: vi.fn().mockResolvedValue(undefined),
    getDefaultProviders: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    refreshPricing: vi.fn().mockResolvedValue({ modelsUpdated: 0, modelsTotal: 0, fetchedAt: "" }),
    // Coding Agents card (ClaudeCodeCard) probes the MCP connection on mount.
    mcpConnectionStatus: vi.fn().mockResolvedValue({
      registered: false,
      claudeFound: false,
      manualCommand: "claude mcp add octopush -s user -- /path/to/octopush-mcp",
      binaryPath: null,
    }),
    connectClaudeCode: vi.fn().mockResolvedValue({ ok: true, registered: true, message: "", binaryPath: null }),
  },
}));

// stub issuesStore.load so the fire-and-forget in handleSave doesn't blow up
vi.mock("../stores/issuesStore", () => ({
  useIssuesStore: Object.assign(
    vi.fn(() => ({ issues: null, loading: false, error: null, load: vi.fn() })),
    { getState: () => ({ load: vi.fn() }) },
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────

async function renderIntegrationsPane(onSaved = vi.fn()) {
  const { Settings } = await import("./Settings");
  let rendered: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <Settings open initialTab="integrations" onClose={vi.fn()} onIssueTrackerConfigSaved={onSaved} />
    );
  });
  return rendered!;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("Settings — Integrations / Issue Tracker section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIssueTrackerConfigMock.mockResolvedValue(null);
    saveIssueTrackerConfigMock.mockResolvedValue(undefined);
    listRecentProjectsMock.mockResolvedValue([]);
    updateProjectJiraKeyMock.mockResolvedValue(undefined);
  });

  it("renders the Issue Tracker section with all three fields and a save button", async () => {
    await renderIntegrationsPane();
    expect(screen.getByPlaceholderText(/atlassian\.net/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/you@/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/api token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });

  it("the API token input is a password field with a Show/Hide toggle", async () => {
    await renderIntegrationsPane();
    const tokenInput = screen.getByPlaceholderText(/api token/i);
    expect(tokenInput).toHaveAttribute("type", "password");

    const showBtn = screen.getByRole("button", { name: /^show$/i });
    await act(async () => { fireEvent.click(showBtn); });
    expect(tokenInput).toHaveAttribute("type", "text");

    const hideBtn = screen.getByRole("button", { name: /^hide$/i });
    await act(async () => { fireEvent.click(hideBtn); });
    expect(tokenInput).toHaveAttribute("type", "password");
  });

  it("pre-fills fields with masked token when config already exists", async () => {
    getIssueTrackerConfigMock.mockResolvedValue({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "secret-token-abc",
    });
    await renderIntegrationsPane();

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/atlassian\.net/i) as HTMLInputElement).value).toBe(
        "https://acme.atlassian.net",
      );
      expect((screen.getByPlaceholderText(/you@/i) as HTMLInputElement).value).toBe("dev@acme.com");
      // Token is masked with bullet dots, not the raw value
      expect((screen.getByPlaceholderText(/api token/i) as HTMLInputElement).value).toMatch(/^•+$/);
    });
  });

  it("calls ipc.saveIssueTrackerConfig with the entered values on save", async () => {
    await renderIntegrationsPane();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/atlassian\.net/i), {
        target: { value: "https://my-org.atlassian.net" },
      });
      fireEvent.change(screen.getByPlaceholderText(/you@/i), {
        target: { value: "alice@my-org.com" },
      });
      fireEvent.change(screen.getByPlaceholderText(/api token/i), {
        target: { value: "my-api-token" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(saveIssueTrackerConfigMock).toHaveBeenCalledTimes(1);
      expect(saveIssueTrackerConfigMock).toHaveBeenCalledWith({
        baseUrl: "https://my-org.atlassian.net",
        email: "alice@my-org.com",
        apiToken: "my-api-token",
      });
    });
  });

  it("preserves the original token on save when the masked field is untouched", async () => {
    getIssueTrackerConfigMock.mockResolvedValue({
      baseUrl: "https://acme.atlassian.net",
      email: "dev@acme.com",
      apiToken: "real-secret-token",
    });
    await renderIntegrationsPane();

    // Wait for prefill so the masked token is loaded into the field.
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/api token/i) as HTMLInputElement).value).toMatch(/^•+$/);
    });

    // Edit only the email; do NOT touch the token field.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/you@/i), {
        target: { value: "alice@acme.com" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(saveIssueTrackerConfigMock).toHaveBeenCalledTimes(1);
      expect(saveIssueTrackerConfigMock).toHaveBeenCalledWith({
        baseUrl: "https://acme.atlassian.net",
        email: "alice@acme.com",
        apiToken: "real-secret-token",
      });
    });
  });

  it("calls onIssueTrackerConfigSaved callback after a successful save", async () => {
    const onSaved = vi.fn();
    await renderIntegrationsPane(onSaved);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it("shows checkmark on button after successful save", async () => {
    await renderIntegrationsPane();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /saved/i })).toBeInTheDocument();
    });
  });

  it("renders a Project links row per Octopush Project with the saved jiraProjectKey", async () => {
    listRecentProjectsMock.mockResolvedValue([
      { id: "p1", name: "Octopush", path: "/p1", jiraProjectKey: "CLPNSNS" },
      { id: "p2", name: "Sandbox",  path: "/p2", jiraProjectKey: null },
    ]);

    await renderIntegrationsPane();

    expect(await screen.findByText(/project links/i)).toBeInTheDocument();
    expect(screen.getByText("Octopush")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();

    const inputs = screen.getAllByPlaceholderText(/project key/i) as HTMLInputElement[];
    expect(inputs[0].value).toBe("CLPNSNS");
    expect(inputs[1].value).toBe("");
  });

  it("saving a Project links row calls updateProjectJiraKey with the right args", async () => {
    listRecentProjectsMock.mockResolvedValue([
      { id: "p1", name: "Octopush", path: "/p1", jiraProjectKey: "CLPNSNS" },
      { id: "p2", name: "Sandbox",  path: "/p2", jiraProjectKey: null },
    ]);

    await renderIntegrationsPane();

    await screen.findByText(/project links/i);

    const inputs = screen.getAllByPlaceholderText(/project key/i) as HTMLInputElement[];
    await act(async () => {
      fireEvent.change(inputs[1], { target: { value: "SANDBOX" } });
    });

    const saveButtons = screen.getAllByRole("button", { name: /save link/i });
    await act(async () => {
      fireEvent.click(saveButtons[1]);
    });

    await waitFor(() => {
      expect(updateProjectJiraKeyMock).toHaveBeenCalledWith("p2", "SANDBOX");
    });
  });

  it("shows Linear and Azure DevOps as upcoming (disabled) trackers", async () => {
    await renderIntegrationsPane();
    expect(screen.getByRole("button", { name: /linear/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /azure devops/i })).toBeDisabled();
    // Jira is the selectable, active tracker.
    expect(screen.getByRole("button", { name: /^jira/i })).toHaveAttribute("aria-pressed", "true");
  });
});
