import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JiraTicketPickerModal } from "./JiraTicketPickerModal";
import type { Issue } from "../lib/types";

// Mock InlineTicketPicker to isolate modal shell behavior
vi.mock("./InlineTicketPicker", () => ({
  InlineTicketPicker: ({
    onPick,
    onCancel,
  }: {
    onPick: (key: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="picker">
      <button type="button" onClick={() => onPick("PROJ-42")}>
        Pick PROJ-42
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    getIssue: vi.fn(),
  },
}));

const issue: Issue = {
  key: "PROJ-42",
  summary: "Test issue",
  statusName: "In Progress",
  statusCategory: "inProgress",
  issueType: "Story",
  priority: "High",
  url: "https://example.atlassian.net/browse/PROJ-42",
  parentKey: null,
};

describe("JiraTicketPickerModal", () => {
  it("renders the modal with title and picker visible", () => {
    render(
      <JiraTicketPickerModal
        candidates={[issue]}
        projectKey="PROJ"
        title="Link Jira ticket"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Link Jira ticket")).toBeInTheDocument();
    expect(screen.getByTestId("picker")).toBeInTheDocument();
  });

  it("clicking the ESC button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <JiraTicketPickerModal
        candidates={[]}
        projectKey={null}
        title="Change Jira ticket"
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onPick from the inner picker bubbles up to the modal's onPick prop", () => {
    const onPick = vi.fn();
    render(
      <JiraTicketPickerModal
        candidates={[issue]}
        projectKey="PROJ"
        title="Link Jira ticket"
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Pick PROJ-42"));
    expect(onPick).toHaveBeenCalledWith("PROJ-42");
  });
});
