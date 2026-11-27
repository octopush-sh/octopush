import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getIssueTrackerConfig: vi.fn(async () => null),
    listRecentProjects: vi.fn(async () => [{ id: "p1", name: "octopush", jiraProjectKey: null }]),
    updateProjectJiraKey: vi.fn(async () => {}),
    saveIssueTrackerConfig: vi.fn(async () => {}),
    getEpikuConfig: vi.fn(async (): Promise<unknown> => null),
    saveEpikuConfig: vi.fn(async (baseUrl: string, project: string) => ({ baseUrl, project, hasToken: true })),
    removeEpikuConfig: vi.fn(async () => {}),
    checkEpikuConnection: vi.fn(async (): Promise<number> => 2),
    listMyIssues: vi.fn(async () => []),
  },
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));

import { IssueTrackingSection } from "./IssueTrackingSection";

describe("IssueTrackingSection — project links", () => {
  it("words each row's save as a phrase, not a bare \"Save\"", async () => {
    render(<IssueTrackingSection />);
    const btn = await screen.findByRole("button", { name: "Save the link for octopush" });
    expect(btn).toHaveTextContent(/^Save the link$/);
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("keeps \"Save changes\" as the one brass CTA; the link save is a ghost button", async () => {
    const { container } = render(<IssueTrackingSection />);
    const link = await screen.findByRole("button", { name: "Save the link for octopush" });
    expect(link.className).toContain("border-octo-border-strong");
    expect(link.className).not.toContain("border-octo-hairline");
    expect(link.className).toContain("text-octo-sage");
    expect(link.className).not.toContain("text-octo-brass");

    const brassButtons = [...container.querySelectorAll("button.font-serif.text-octo-brass")];
    expect(brassButtons.map((b) => b.textContent)).toEqual(["Save changes"]);
  });
});

describe("IssueTrackingSection — Epiku", () => {
  const view = { baseUrl: "https://epiku.example.com", project: "sample-project", hasToken: true };

  it("saves the connection and says Connected only once the project's read answered", async () => {
    render(<IssueTrackingSection />);
    fireEvent.click(screen.getByRole("button", { name: "Epiku" }));
    expect(screen.getByText("Not connected yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("https://epiku.your-domain.com"), { target: { value: view.baseUrl } });
    fireEvent.change(screen.getByPlaceholderText("your-project"), { target: { value: view.project } });
    fireEvent.change(screen.getByLabelText("Epiku token"), { target: { value: "epk_sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByText("Connected · 2 stories")).toBeInTheDocument();
    expect(ipcMock.saveEpikuConfig).toHaveBeenCalledWith(view.baseUrl, view.project, "epk_sample");
    expect(screen.getByLabelText("Epiku token")).toHaveValue("");
  });

  it("checks a saved connection on open, says why it failed, and keeps the saved token on a blank save", async () => {
    ipcMock.getEpikuConfig.mockResolvedValueOnce(view);
    ipcMock.checkEpikuConnection.mockRejectedValueOnce("other: Epiku rejected the token.");
    render(<IssueTrackingSection />);
    fireEvent.click(screen.getByRole("button", { name: "Epiku" }));
    expect(await screen.findByText("Not connected: Epiku rejected the token.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("your-project")).toHaveValue("sample-project");
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    expect(await screen.findByText("Connected · 2 stories")).toBeInTheDocument();
    expect(ipcMock.saveEpikuConfig).toHaveBeenLastCalledWith(view.baseUrl, view.project, null);
  });
});
