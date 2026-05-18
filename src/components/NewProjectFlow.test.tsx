/**
 * Tests for the reworked NewProjectFlow:
 *  - Step I shows three TypeCards; Clone is now selectable
 *  - Picking Clone advances to Step II with a URL field (not name-first)
 *  - URL auto-populates the name field
 *  - Manual name edit detaches from URL parsing
 *  - AuthRequired error shows credential panel
 *  - Credential submit calls cloneProject with creds; if Remember, also saveGitCredentials
 *  - Progress bar updates with new { phase, percent, current, total } payload shape
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ─── Mocks — must be declared before the component is imported ───────────────

// Capture registered event listeners so tests can fire them manually.
type ListenerCallback = (event: { payload: unknown }) => void;
const registeredListeners: Map<string, ListenerCallback> = new Map();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation((eventName: string, cb: ListenerCallback) => {
    registeredListeners.set(eventName, cb);
    return Promise.resolve(() => {
      registeredListeners.delete(eventName);
    });
  }),
}));

const cloneProjectMock = vi.fn();
const createMock = vi.fn().mockResolvedValue(undefined);
const saveGitCredentialsMock = vi.fn().mockResolvedValue(undefined);
const getSettingsMock = vi.fn().mockResolvedValue({
  providerKeys: {},
  providerBaseUrls: {},
  gitCredentials: {},
});

vi.mock("../lib/ipc", () => ({
  ipc: {
    cloneProject: cloneProjectMock,
    saveGitCredentials: saveGitCredentialsMock,
    getSettings: getSettingsMock,
  },
}));

// Minimal projectStore mock — expose create + error + loading
vi.mock("../stores/projectStore", async () => {
  const { create: zustandCreate } = await import("zustand");
  const useProjectStore = zustandCreate(() => ({
    create: createMock,
    loading: false,
    error: null,
    current: null,
    recent: [],
  }));
  return { useProjectStore };
});

// Dynamic import AFTER mocks
const { NewProjectFlow } = await import("./NewProjectFlow");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function render_flow() {
  const onBack = vi.fn();
  const utils = render(<NewProjectFlow onBack={onBack} />);
  return { ...utils, onBack };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("NewProjectFlow — Step I (type selection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneProjectMock.mockReset();
    getSettingsMock.mockResolvedValue({
      providerKeys: {},
      providerBaseUrls: {},
      gitCredentials: {},
    });
  });

  it("renders three TypeCards on Step I", () => {
    render_flow();
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.getByText("Clone")).toBeInTheDocument();
    expect(screen.getByText("Template")).toBeInTheDocument();
  });

  it("Clone card is selectable (not disabled)", () => {
    render_flow();
    const cloneCard = screen.getByRole("button", { name: /clone/i });
    expect(cloneCard).not.toBeDisabled();
  });

  it("Template card is disabled", () => {
    render_flow();
    // The Template button is disabled
    const templateCard = screen.getByRole("button", { name: /template/i });
    expect(templateCard).toBeDisabled();
  });

  it("clicking Clone advances to Step II with URL field", async () => {
    render_flow();
    const cloneBtn = screen.getByRole("button", { name: /clone/i });
    fireEvent.click(cloneBtn);

    await waitFor(() => {
      expect(screen.getByText("REPOSITORY URL")).toBeInTheDocument();
    });
    expect(screen.getByText("STEP II · OF II")).toBeInTheDocument();
  });

  it("clicking Empty advances to Step II with project name field", async () => {
    render_flow();
    const emptyBtn = screen.getByRole("button", { name: /empty/i });
    fireEvent.click(emptyBtn);

    await waitFor(() => {
      expect(screen.getByText("PROJECT NAME")).toBeInTheDocument();
    });
    expect(screen.getByText(/bring it to life/i)).toBeInTheDocument();
  });
});

describe("NewProjectFlow — Step II Clone: URL auto-detection", () => {
  function goToCloneStep() {
    render_flow();
    fireEvent.click(screen.getByRole("button", { name: /clone/i }));
  }

  it("typing a GitHub URL populates the name field with the repo name", async () => {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/project name/i) as HTMLInputElement;
      expect(nameInput.value).toBe("Hello-World");
    });
  });

  it("detects host and shows host glyph next to URL input", async () => {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    await waitFor(() => {
      expect(screen.getByText(/§ github\.com/i)).toBeInTheDocument();
    });
  });

  it("manually editing name detaches it from URL parsing", async () => {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    // Let auto-detection fire
    const nameInput = await screen.findByLabelText(/project name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Hello-World");

    // Manually override
    fireEvent.change(nameInput, { target: { value: "my-custom-name" } });
    expect(nameInput.value).toBe("my-custom-name");

    // Changing URL should NOT overwrite the manual name
    fireEvent.change(urlInput, { target: { value: "https://github.com/someone/other-repo.git" } });
    await waitFor(() => {
      expect(nameInput.value).toBe("my-custom-name");
    });
  });

  it("Clone & open button is disabled when URL is invalid", async () => {
    goToCloneStep();
    const cloneBtn = await screen.findByRole("button", { name: /clone & open/i });
    expect(cloneBtn).toBeDisabled();
  });

  it("Clone & open button is enabled when URL is valid and name is set", async () => {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clone & open/i })).not.toBeDisabled();
    });
  });
});

describe("NewProjectFlow — AuthRequired error flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneProjectMock.mockReset();
    saveGitCredentialsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      providerKeys: {},
      providerBaseUrls: {},
      gitCredentials: {},
    });
    saveGitCredentialsMock.mockResolvedValue(undefined);
  });

  function goToCloneStep() {
    render_flow();
    fireEvent.click(screen.getByRole("button", { name: /clone/i }));
  }

  async function fillAndClone() {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/private.git" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clone & open/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clone & open/i }));
    });
  }

  it("shows credential panel when cloneProject rejects with AuthRequired", async () => {
    cloneProjectMock.mockRejectedValueOnce(
      JSON.stringify({ kind: "AuthRequired", host: "github.com" }),
    );

    await fillAndClone();

    await waitFor(() => {
      expect(screen.getByText(/private repository/i)).toBeInTheDocument();
      expect(screen.getByText(/sign in to github\.com/i)).toBeInTheDocument();
    });
    expect(screen.getByText("USERNAME")).toBeInTheDocument();
    expect(screen.getByText("PERSONAL ACCESS TOKEN")).toBeInTheDocument();
  });

  it("Try again calls cloneProject with credentials", async () => {
    cloneProjectMock
      .mockRejectedValueOnce(
        JSON.stringify({ kind: "AuthRequired", host: "github.com" }),
      )
      .mockResolvedValueOnce({ id: "proj-1", name: "private", path: "/tmp/private" });

    await fillAndClone();

    // Wait for auth panel
    await waitFor(() => screen.getByText(/USERNAME/));

    // Fill credentials
    const usernameInput = screen.getByLabelText(/username/i) as HTMLInputElement;
    const tokenInput = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    fireEvent.change(usernameInput, { target: { value: "octocat" } });
    fireEvent.change(tokenInput, { target: { value: "ghp_secret" } });

    // Click Try again
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    await waitFor(() => {
      expect(cloneProjectMock).toHaveBeenCalledTimes(2);
      const secondCall = cloneProjectMock.mock.calls[1][0];
      expect(secondCall.credentials).toEqual({ username: "octocat", token: "ghp_secret" });
    });
  });

  it("saves credentials when Remember is checked and clone succeeds", async () => {
    cloneProjectMock
      .mockRejectedValueOnce(
        JSON.stringify({ kind: "AuthRequired", host: "github.com" }),
      )
      .mockResolvedValueOnce({ id: "proj-1", name: "private", path: "/tmp/private" });

    await fillAndClone();

    await waitFor(() => screen.getByText(/USERNAME/));

    const usernameInput = screen.getByLabelText(/username/i) as HTMLInputElement;
    const tokenInput = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    fireEvent.change(usernameInput, { target: { value: "octocat" } });
    fireEvent.change(tokenInput, { target: { value: "ghp_secret" } });

    // Remember is checked by default
    const rememberCheckbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(rememberCheckbox.checked).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    await waitFor(() => {
      expect(saveGitCredentialsMock).toHaveBeenCalledWith(
        "github.com",
        "octocat",
        "ghp_secret",
      );
    });
  });

  it("does NOT save credentials when Remember is unchecked", async () => {
    cloneProjectMock
      .mockRejectedValueOnce(
        JSON.stringify({ kind: "AuthRequired", host: "github.com" }),
      )
      .mockResolvedValueOnce({ id: "proj-1", name: "private", path: "/tmp/private" });

    await fillAndClone();

    await waitFor(() => screen.getByText(/USERNAME/));

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText(/personal access token/i), { target: { value: "tok" } });

    // Uncheck Remember
    fireEvent.click(screen.getByRole("checkbox"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    await waitFor(() => {
      expect(cloneProjectMock).toHaveBeenCalledTimes(2);
    });
    expect(saveGitCredentialsMock).not.toHaveBeenCalled();
  });
});

describe("NewProjectFlow — SshKeyMissing error flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneProjectMock.mockReset();
    saveGitCredentialsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      providerKeys: {},
      providerBaseUrls: {},
      gitCredentials: {},
    });
  });

  function goToCloneStep() {
    render_flow();
    fireEvent.click(screen.getByRole("button", { name: /clone/i }));
  }

  async function fillSshAndClone() {
    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "git@github.com:octocat/private.git" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clone & open/i })).not.toBeDisabled();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clone & open/i }));
    });
  }

  it("shows SSH panel with ssh-add snippet when cloneProject rejects with SshKeyMissing", async () => {
    cloneProjectMock.mockRejectedValueOnce(
      JSON.stringify({ kind: "SshKeyMissing", host: "github.com" }),
    );

    await fillSshAndClone();

    // The panel heading contains "SSH KEY · github.com" — match it exactly via the mono eyebrow element
    await waitFor(() => {
      expect(screen.getByText(/SSH KEY · github\.com/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/ssh-add ~\/.ssh\/id_ed25519/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to https/i })).toBeInTheDocument();
  });

  it("does NOT show the HTTPS credential panel for SshKeyMissing", async () => {
    cloneProjectMock.mockRejectedValueOnce(
      JSON.stringify({ kind: "SshKeyMissing", host: "github.com" }),
    );

    await fillSshAndClone();

    await waitFor(() => {
      expect(screen.getByText(/SSH KEY · github\.com/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("PERSONAL ACCESS TOKEN")).not.toBeInTheDocument();
  });

  it("Switch to HTTPS converts the URL and dismisses the SSH panel", async () => {
    cloneProjectMock.mockRejectedValueOnce(
      JSON.stringify({ kind: "SshKeyMissing", host: "github.com" }),
    );

    await fillSshAndClone();

    await waitFor(() => {
      expect(screen.getByText(/SSH KEY · github\.com/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /switch to https/i }));
    });

    await waitFor(() => {
      expect(screen.queryByText(/SSH KEY · github\.com/i)).not.toBeInTheDocument();
    });

    const urlInput = screen.getByPlaceholderText(/paste a git remote url/i) as HTMLInputElement;
    expect(urlInput.value).toBe("https://github.com/octocat/private.git");
  });
});

describe("NewProjectFlow — clone progress bar (new payload shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloneProjectMock.mockReset();
    registeredListeners.clear();
    getSettingsMock.mockResolvedValue({
      providerKeys: {},
      providerBaseUrls: {},
      gitCredentials: {},
    });
  });

  function goToCloneStep() {
    render_flow();
    fireEvent.click(screen.getByRole("button", { name: /clone/i }));
  }

  it("progress bar appears while cloning and shows phase · current/total · percent% label", async () => {
    // Clone never resolves during this test — we just want to observe progress UI.
    cloneProjectMock.mockReturnValue(new Promise(() => {}));

    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clone & open/i })).not.toBeDisabled();
    });

    // Start cloning (don't await — it never resolves).
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /clone & open/i }));
    });

    // Wait for the listener to be registered.
    await waitFor(() => {
      expect(registeredListeners.has("clone://progress")).toBe(true);
    });

    // Fire a progress event with the new payload shape.
    await act(async () => {
      const listener = registeredListeners.get("clone://progress");
      listener?.({
        payload: { phase: "Receiving objects", percent: 47, current: 118, total: 250 },
      });
    });

    // Progress label should be visible.
    await waitFor(() => {
      expect(screen.getByText(/Receiving objects/)).toBeInTheDocument();
      expect(screen.getByText(/118\/250/)).toBeInTheDocument();
      expect(screen.getByText(/47%/)).toBeInTheDocument();
    });
  });

  it("progress bar width matches percent from event", async () => {
    cloneProjectMock.mockReturnValue(new Promise(() => {}));

    goToCloneStep();
    const urlInput = await screen.findByPlaceholderText(/paste a git remote url/i);
    fireEvent.change(urlInput, { target: { value: "https://github.com/octocat/Hello-World.git" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clone & open/i })).not.toBeDisabled();
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /clone & open/i }));
    });

    await waitFor(() => {
      expect(registeredListeners.has("clone://progress")).toBe(true);
    });

    await act(async () => {
      const listener = registeredListeners.get("clone://progress");
      listener?.({
        payload: { phase: "Resolving deltas", percent: 100, current: 50, total: 50 },
      });
    });

    // The brass fill bar should have width: 100%
    await waitFor(() => {
      // Find the inner fill div — it's the child of the rounded overflow container.
      const bars = document.querySelectorAll('[style*="width"]');
      const fillBar = Array.from(bars).find(
        (el) => (el as HTMLElement).style.width === "100%",
      );
      expect(fillBar).toBeTruthy();
    });
  });
});
