/**
 * Long names in the Command Palette's Workspaces and Groups rows (#873): every
 * line is middle-truncated inside a box with a definite width, and once a
 * pass cuts it, its head ends on its own ellipsis — never held at clip.
 */
import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Group, Workspace } from "../lib/types";
import type { ProjectGroup } from "./WorkspaceRail";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ipc: {
    listModels: vi.fn().mockResolvedValue([]),
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

import { CommandPalette } from "./CommandPalette";
import { useRunsStore } from "../stores/runsStore";
import { useGroupsStore } from "../stores/groupsStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { writable: true, configurable: true, value: ResizeObserverMock });
const originalScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

// The stress fixture's shape: a long project name, a long branch, a long group.
const PROJECT = "octopush-enterprise-monorepo-with-a-very-long-name";
const ws = (id: string, name: string, branch: string, groupId: string | null = null): Workspace => ({
  id, projectId: "p1", name, task: "", branch, worktreePath: null, setupScript: "", status: "active",
  createdAt: "2026-11-10T10:00:00Z", lastActive: "2026-11-10T10:00:00Z", glyph: null, tint: null,
  linkedIssueKey: null, fromBranch: null, groupId,
});
const GROUPS: Group[] = [
  { id: "mg1", scope: "workspace", projectId: "p1", name: "Fixes for the enterprise monorepo's billing pipeline", tint: null, sortOrder: 0, createdAt: "2026-11-10T09:00:00Z" },
];
const projects: ProjectGroup[] = [
  {
    id: "p1",
    name: PROJECT,
    workspaces: [
      ws("w1", "Refactor the settlement ledger reconciliation job", "feature/settlement-ledger-reconciliation-rewrite"),
      ws("w2", "Stream partial invoices to the warehouse exporter", "feature/stream-partial-invoices", "mg1"),
    ],
  },
];

const GLYPH = 7;
const ROOM = 80;
const realRangeRect = Range.prototype.getBoundingClientRect;
let frames: FrameRequestCallback[] = [];
const flushFrames = () => {
  for (let i = 0; i < 10 && frames.length; i++) {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
  }
};

async function renderPalette() {
  await act(async () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onNewSession={vi.fn()}
        onToggleTokens={vi.fn()}
        projects={projects}
        runningByWs={{}}
        onSelectWorkspace={vi.fn()}
        onRevealGroup={vi.fn()}
      />,
    );
  });
  act(flushFrames);
}

const boxesIn = (tour: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${tour}"] .octo-midtrunc`));

describe("CommandPalette · long names keep their ellipsis (#873)", () => {
  beforeEach(() => {
    frames = [];
    useRunsStore.setState({ runsByWs: {}, statusSince: {} });
    useGroupsStore.setState({ groups: GROUPS, loaded: true });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    // Every head has 80px of room; every glyph is 7px wide.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("octo-midtrunc-head") ? ROOM : 0;
      return { left: 0, right: width, top: 0, bottom: 0, width, height: 0 } as DOMRect;
    });
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const w = (this.endOffset - this.startOffset) * GLYPH;
      return { left: 0, right: w, top: 0, bottom: 0, width: w, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Range.prototype.getBoundingClientRect = realRangeRect;
  });

  it("cuts every Workspaces and Groups line on the head's own ellipsis, never held at clip", async () => {
    await renderPalette();
    const boxes = [...boxesIn("palette-workspaces"), ...boxesIn("palette-groups")];
    // Name and meta line of two workspace rows and one group row.
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      const head = box.querySelector<HTMLElement>(":scope > .octo-midtrunc-head")!;
      expect(box).toHaveAttribute("data-elided");
      expect(box).not.toHaveAttribute("data-measuring");
      // The stylesheet's `text-overflow: ellipsis` applies: no inline hold left.
      expect(head.style.textOverflow).toBe("");
      expect(head.style.maxWidth).toMatch(/px$/);
    }
    // The meta line the audit flagged, head and pinned tail.
    const meta = document.querySelector<HTMLElement>(`[data-tour="palette-workspaces"] [title^="${PROJECT} · feature/settlement"]`)!;
    expect(meta.querySelector(".octo-midtrunc-head")!.textContent).toMatch(new RegExp(`^${PROJECT} · `));
    expect(meta.querySelector(".octo-midtrunc-tail")!.textContent!.length).toBe(16);
  });

  it("gives every line a definite width to elide into", async () => {
    await renderPalette();
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="palette-workspace"], [data-testid="palette-group"]');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // The text column grows into the row the glyph and dot leave…
      const column = row.querySelector<HTMLElement>(":scope > span.flex-col")!;
      expect(column.className.split(" ")).toEqual(expect.arrayContaining(["flex", "min-w-0", "flex-1", "flex-col"]));
      expect(column.children).toHaveLength(2);
      for (const line of column.children) {
        // …each line is a stretched flex box carrying the full text in a title…
        expect(line.className.split(" ")).toEqual(expect.arrayContaining(["flex", "min-w-0"]));
        expect(line.getAttribute("title")).toBeTruthy();
        // …and the MidTruncate box fills it, so it is never sized from its own text.
        const box = line.firstElementChild as HTMLElement;
        expect(box.classList.contains("octo-midtrunc")).toBe(true);
        expect(box.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
        expect(line.children).toHaveLength(1);
      }
    }
  });
});
