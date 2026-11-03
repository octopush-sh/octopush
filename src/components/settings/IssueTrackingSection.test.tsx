import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getIssueTrackerConfig: vi.fn(async () => null),
    listRecentProjects: vi.fn(async () => [{ id: "p1", name: "octopush", jiraProjectKey: null }]),
    updateProjectJiraKey: vi.fn(async () => {}),
    saveIssueTrackerConfig: vi.fn(async () => {}),
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
});
