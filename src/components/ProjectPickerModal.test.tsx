import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPickerModal } from "./ProjectPickerModal";
import type { ProjectInfo } from "../lib/types";

const candidates: ProjectInfo[] = [
  { id: "p1", name: "Alpha Project", path: "/home/user/alpha", jiraProjectKey: "ALP", pinned: false },
  { id: "p2", name: "Beta Project", path: "/home/user/beta", jiraProjectKey: "BET", pinned: false },
];

describe("ProjectPickerModal", () => {
  it("renders all candidate projects", () => {
    render(
      <ProjectPickerModal
        candidates={candidates}
        title="Select a project"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
    expect(screen.getByText("Beta Project")).toBeInTheDocument();
    expect(screen.getByText("/home/user/alpha")).toBeInTheDocument();
    expect(screen.getByText("/home/user/beta")).toBeInTheDocument();
  });

  it("clicking a row calls onPick with the project id", () => {
    const onPick = vi.fn();
    render(
      <ProjectPickerModal
        candidates={candidates}
        title="Select a project"
        onPick={onPick}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Alpha Project"));
    expect(onPick).toHaveBeenCalledWith("p1");
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <ProjectPickerModal
        candidates={candidates}
        title="Select a project"
        onPick={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
