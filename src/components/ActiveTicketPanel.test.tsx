import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActiveTicketPanel } from "./ActiveTicketPanel";
import type { Issue } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: {
    openFileInSystem: vi.fn(),
    updateWorkspaceLink: vi.fn(),
    getIssue: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
const openFileInSystemMock = vi.mocked(ipc.openFileInSystem);
const updateWorkspaceLinkMock = vi.mocked(ipc.updateWorkspaceLink);

const issue: Issue = {
  key: "CLPNSNS-92",
  summary: "Consumir el servicio de notificaciones del backend",
  statusName: "In Progress",
  statusCategory: "inProgress",
  issueType: "Story",
  priority: "High",
  url: "https://acme.atlassian.net/browse/CLPNSNS-92",
  parentKey: "EPIC-1",
};

beforeEach(() => { vi.clearAllMocks(); });

describe("ActiveTicketPanel", () => {
  it("linked state: shows key + status + summary + meta + open-in-Jira", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-92", source: "detected" }}
        activeIssue={issue}
        candidates={[issue]}
        projectKey="CLPNSNS"
        workspaceId="w1"
      />,
    );
    expect(screen.getByText("CLPNSNS-92")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText(/notificaciones/i)).toBeInTheDocument();
    expect(screen.getByText(/STORY · HIGH/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open in jira/i }));
    expect(openFileInSystemMock).toHaveBeenCalledWith(issue.url);
  });

  it("unlinked state: shows two affordances and 'No usar' triggers dismiss", async () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "unlinked" }}
        activeIssue={null}
        candidates={[]}
        projectKey={null}
        workspaceId="w1"
      />,
    );
    expect(screen.getByText(/sin ticket vinculado/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /vincular/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /no usar ticket aqu/i }));
    await waitFor(() => {
      expect(updateWorkspaceLinkMock).toHaveBeenCalledWith("w1", null, true);
    });
  });

  it("'Vincular →' swaps the unlinked body for the picker", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "unlinked" }}
        activeIssue={null}
        candidates={[issue]}
        projectKey="CLPNSNS"
        workspaceId="w1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /vincular/i }));
    expect(screen.getByPlaceholderText(/busca por clave o resumen/i)).toBeInTheDocument();
  });

  it("dismissed state: shows the eyebrow + a compact 'Vincular' resurface row", () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "dismissed" }}
        activeIssue={null}
        candidates={[]}
        projectKey={null}
        workspaceId="w1"
      />,
    );
    expect(screen.getByText(/active ticket/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ vincular ticket/i })).toBeInTheDocument();
  });

  it("linked but activeIssue is null: shows error card with Desvincular", async () => {
    render(
      <ActiveTicketPanel
        state={{ kind: "linked", key: "CLPNSNS-X", source: "manual" }}
        activeIssue={null}
        candidates={[]}
        projectKey="CLPNSNS"
        workspaceId="w1"
      />,
    );
    expect(screen.getByText(/no se pudo cargar/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /desvincular/i }));
    await waitFor(() => {
      expect(updateWorkspaceLinkMock).toHaveBeenCalledWith("w1", null, false);
    });
  });
});
