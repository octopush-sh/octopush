/** GithubIssuePicker — honest preflight states + pick flow. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const githubShipReadinessMock = vi.fn();
const listGithubIssuesMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    githubShipReadiness: githubShipReadinessMock,
    listGithubIssues: listGithubIssuesMock,
  },
}));

const { GithubIssuePicker } = await import("./GithubIssuePicker");

beforeEach(() => {
  githubShipReadinessMock.mockReset();
  listGithubIssuesMock.mockReset();
});

describe("GithubIssuePicker", () => {
  it("no GitHub remote → honest dead end, issues never fetched", async () => {
    githubShipReadinessMock.mockResolvedValue({ githubRemote: false, ghAuthenticated: false });
    render(<GithubIssuePicker workspacePath="/w" onPick={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no GitHub remote/)).toBeTruthy());
    expect(listGithubIssuesMock).not.toHaveBeenCalled();
  });

  it("gh not signed in → points at gh auth login", async () => {
    githubShipReadinessMock.mockResolvedValue({ githubRemote: true, ghAuthenticated: false });
    render(<GithubIssuePicker workspacePath="/w" onPick={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/gh auth login/)).toBeTruthy());
    expect(listGithubIssuesMock).not.toHaveBeenCalled();
  });

  it("ready → lists, filters, and picks an issue", async () => {
    githubShipReadinessMock.mockResolvedValue({ githubRemote: true, ghAuthenticated: true });
    listGithubIssuesMock.mockResolvedValue([
      { number: 42, title: "Add CSV export", body: "detail", url: "u" },
      { number: 7, title: "Fix login flake", body: "", url: "u2" },
    ]);
    const onPick = vi.fn();
    render(<GithubIssuePicker workspacePath="/w" onPick={onPick} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Add CSV export")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter issues"), { target: { value: "csv" } });
    expect(screen.queryByText("Fix login flake")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Add CSV export/ }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42, title: "Add CSV export" }),
    );
  });
});
