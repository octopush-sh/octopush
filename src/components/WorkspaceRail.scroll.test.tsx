/**
 * #846 — the rail scrolls the active workspace into view: once per newly
 * active id (also when its row renders after the id is set, as when a project
 * is opened), `block: "nearest"` so a visible row never moves, smooth unless
 * the user prefers reduced motion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { WorkspaceRail, type ProjectGroup } from "./WorkspaceRail";
import type { Workspace } from "../lib/types";

const ws = (id: string, name: string): Workspace => ({
  id, projectId: "p", name, task: "", branch: name, worktreePath: null, setupScript: "",
  status: "active", createdAt: "2026-11-01T00:00:00Z", lastActive: "2026-11-01T00:00:00Z",
  glyph: null, tint: null, linkedIssueKey: null, fromBranch: null,
});

const scroll = vi.fn();
const original = Element.prototype.scrollIntoView;
let reduced = false;

beforeEach(() => {
  scroll.mockClear();
  reduced = false;
  Element.prototype.scrollIntoView = function (this: Element, opts?: ScrollIntoViewOptions | boolean) {
    scroll(this, opts);
  };
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: reduced && q.includes("reduce"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  Element.prototype.scrollIntoView = original;
  vi.restoreAllMocks();
  localStorage.removeItem("railProjectCollapsed");
});

const one: ProjectGroup[] = [{ id: "p1", name: "octopush", workspaces: [ws("a", "Alpha"), ws("b", "Beta")] }];
const rail = (projects: ProjectGroup[], active: string | null, isCollapsed = false) => (
  <WorkspaceRail projects={projects} activeWorkspaceId={active} onSelect={vi.fn()} onCustomize={vi.fn()} isCollapsed={isCollapsed} />
);

describe("WorkspaceRail · scroll the active workspace into view (#846)", () => {
  it("scrolls the active row calmly, nearest, and only once per activation", () => {
    const { rerender } = render(rail(one, "a"));
    expect(scroll).toHaveBeenCalledTimes(1);
    const [el, opts] = scroll.mock.calls[0];
    expect((el as HTMLElement).getAttribute("aria-label")).toBe("Alpha");
    expect(opts).toMatchObject({ block: "nearest", behavior: "smooth" });

    rerender(rail([...one], "a")); // a refresh of the same rows: no scroll
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(rail(one, "b"));
    expect(scroll).toHaveBeenCalledTimes(2);
    expect((scroll.mock.calls[1][0] as HTMLElement).getAttribute("aria-label")).toBe("Beta");
  });

  it("scrolls to a newly opened project's workspace once its row renders", () => {
    const { rerender } = render(rail(one, "new"));
    expect(scroll).not.toHaveBeenCalled();
    const opened: ProjectGroup[] = [...one, { id: "p2", name: "fresh", workspaces: [ws("new", "main")] }];
    rerender(rail(opened, "new"));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.calls[0][0] as HTMLElement).getAttribute("aria-label")).toBe("main");
  });

  it("jumps without animation under reduced motion", () => {
    reduced = true;
    render(rail(one, "a"));
    expect(scroll.mock.calls[0][1]).toMatchObject({ behavior: "auto" });
  });

  it("works in the collapsed rail too", () => {
    render(rail(one, "b", true));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.calls[0][0] as HTMLElement).getAttribute("aria-current")).toBe("location");
  });
});
