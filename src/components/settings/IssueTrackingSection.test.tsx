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

  it("keeps \"Save changes\" as the one brass CTA; the link save is a ghost button", async () => {
    const { container } = render(<IssueTrackingSection />);
    const link = await screen.findByRole("button", { name: "Save the link for octopush" });
    expect(link.className).toContain("border-octo-hairline");
    expect(link.className).toContain("text-octo-sage");
    expect(link.className).not.toContain("text-octo-brass");

    const brassButtons = [...container.querySelectorAll("button.font-serif.text-octo-brass")];
    expect(brassButtons.map((b) => b.textContent)).toEqual(["Save changes"]);
  });
});
