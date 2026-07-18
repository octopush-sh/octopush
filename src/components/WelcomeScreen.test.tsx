import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";
import { useProjectStore } from "../stores/projectStore";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listRecentProjects: vi.fn().mockResolvedValue([]),
    listClosedProjects: vi.fn().mockResolvedValue([]),
  },
}));

const PROMPT = /Describe what you want to build/i;

beforeEach(() => {
  useProjectStore.setState({ recent: [], closed: [], loading: false, error: null });
});

describe("WelcomeScreen — prompt genesis", () => {
  it("falls back to the derived slug when the name field is cleared (never empty)", () => {
    const onGenesis = vi.fn();
    render(<WelcomeScreen onNewProject={vi.fn()} onGenesis={onGenesis} />);
    fireEvent.change(screen.getByPlaceholderText(PROMPT), {
      target: { value: "Build me an iOS app to track my daily tasks" },
    });
    // Clear the editable derived-name field — the backend would git-init the
    // container dir on an empty name, so the UI must not submit "".
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Set a crew on it"));
    expect(onGenesis).toHaveBeenCalledTimes(1);
    const [prompt, name] = onGenesis.mock.calls[0];
    expect(prompt).toBe("Build me an iOS app to track my daily tasks");
    expect(name).toBe("ios-track-daily-tasks");
  });

  it("Enter submits a non-empty prompt; a blank prompt is a no-op", () => {
    const onGenesis = vi.fn();
    render(<WelcomeScreen onNewProject={vi.fn()} onGenesis={onGenesis} />);
    const textarea = screen.getByPlaceholderText(PROMPT);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onGenesis).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "a todo cli" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onGenesis).toHaveBeenCalledTimes(1);
  });

  it("disables the prompt while a project is being created", () => {
    useProjectStore.setState({ loading: true });
    render(<WelcomeScreen onNewProject={vi.fn()} onGenesis={vi.fn()} />);
    expect(screen.getByPlaceholderText(PROMPT)).toBeDisabled();
  });

  it("still offers the project-first route (Begin a new study)", () => {
    const onNewProject = vi.fn();
    render(<WelcomeScreen onNewProject={onNewProject} onGenesis={vi.fn()} />);
    fireEvent.click(screen.getByText("Begin a new study"));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
