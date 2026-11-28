import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineTicketPicker } from "./InlineTicketPicker";
import type { Issue } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: { getIssue: vi.fn() },
}));

import { ipc } from "../lib/ipc";
const getIssueMock = vi.mocked(ipc.getIssue);

function issue(key: string, summary: string, statusCategory: Issue["statusCategory"] = "todo"): Issue {
  return {
    key, summary,
    statusName: statusCategory === "inProgress" ? "In Progress" : "To Do",
    statusCategory, issueType: "Story", priority: null,
    url: "https://x/browse/" + key, parentKey: null,
    subtask: false,
    hierarchyLevel: 0,
  };
}

const SAMPLE: Issue[] = [
  issue("CLPNSNS-92", "Consumir notificaciones", "inProgress"),
  issue("CLPNSNS-105", "Diseñar bandeja"),
  issue("CLPNSNS-110", "Push para móvil"),
  issue("OTHER-7", "Algo más"),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InlineTicketPicker", () => {
  it("renders results filtered by query within the project scope by default", () => {
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Default scope is the project; type "notif" -> only CLPNSNS-92 matches.
    fireEvent.change(screen.getByPlaceholderText(/search by key/i), { target: { value: "notif" } });
    expect(screen.getByText("CLPNSNS-92")).toBeInTheDocument();
    expect(screen.queryByText("OTHER-7")).not.toBeInTheDocument();
  });

  it("scope toggle 'All' includes other-project matches", () => {
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    fireEvent.change(screen.getByPlaceholderText(/search by key/i), { target: { value: "algo" } });
    expect(screen.getByText("OTHER-7")).toBeInTheDocument();
  });

  it("Enter picks the highlighted (first) row", () => {
    const onPick = vi.fn();
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/search by key/i), { target: { value: "" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/search by key/i), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("CLPNSNS-92");
  });

  it("ArrowDown then Enter picks the second row", () => {
    const onPick = vi.fn();
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText(/search by key/i), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByPlaceholderText(/search by key/i), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("CLPNSNS-105");
  });

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText(/search by key/i), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the exact-key fallback when query matches the regex and no results match", async () => {
    getIssueMock.mockResolvedValue(issue("CLPNSNS-555", "Recién creado"));
    const onPick = vi.fn();
    render(
      <InlineTicketPicker
        candidates={SAMPLE}
        projectKey="CLPNSNS"
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/search by key/i), { target: { value: "CLPNSNS-555" } });
    // The fallback row shows the key and a USE → affordance.
    const useBtn = await screen.findByRole("button", { name: /use clpnsns-555/i });
    fireEvent.click(useBtn);
    await waitFor(() => {
      expect(getIssueMock).toHaveBeenCalledWith("CLPNSNS-555", null);
      expect(onPick).toHaveBeenCalledWith("CLPNSNS-555");
    });
  });

  it("speaks of an Epiku project's open stories, not of assigned tickets (#1283)", () => {
    const stories = [issue("ST-1.1", "Sample story")];
    render(<InlineTicketPicker candidates={stories} projectKey={null} projectId="p1" tracker="epiku" onPick={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search by key/i);
    fireEvent.change(input, { target: { value: "nothing like it" } });
    expect(screen.getByText("No matches in the project's open stories.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "ST-1.2" } });
    expect(screen.getByText("(not in the open stories — verified on link)")).toBeInTheDocument();
    expect(screen.queryByText(/assigned/)).not.toBeInTheDocument();
  });
});
