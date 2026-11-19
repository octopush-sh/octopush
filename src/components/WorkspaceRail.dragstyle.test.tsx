/**
 * A dragged block of the rail's top level is MOVED, never scaled. dnd-kit
 * hands a sortable item a transform with `scaleX`/`scaleY` set to the size of
 * whatever it is over (a group's header over a short project: `scaleY` 0.45;
 * over a taller group: 1.5). Written to the element as it comes, that squashes
 * or stretches the block and pulls it away from the pointer. The rail writes
 * the translation alone, for a project and for a project group.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { Group } from "../lib/types";

/** What `useSortable` is made to answer for an id, over its real answer. */
const forced = vi.hoisted(() => ({ byId: {} as Record<string, object> }));
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...original,
    useSortable: (args: Parameters<typeof original.useSortable>[0]) => ({
      ...original.useSortable(args),
      ...forced.byId[String(args.id)],
    }),
  };
});

/** What the drag is made to look like to `useDndContext`, over its real answer. */
const drag = vi.hoisted(() => ({ context: {} as object }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@dnd-kit/core")>();
  return { ...original, useDndContext: () => ({ ...original.useDndContext(), ...drag.context }) };
});

import { WorkspaceRail, type ProjectGroup } from "./WorkspaceRail";
import { sectionDragId } from "../lib/railGroups";
import { DRAGGED_BLOCK } from "../lib/railDnd";
import { LIFTED_GROUND } from "../lib/menuStyles";
import { useGroupsStore } from "../stores/groupsStore";

const CLIENT: Group = {
  id: "g-client",
  scope: "project",
  projectId: null,
  name: "Client work",
  tint: null,
  sortOrder: 0,
  createdAt: "2026-11-01T00:00:00Z",
};
const PROJECTS: ProjectGroup[] = [
  { id: "dotfiles", name: "dotfiles", workspaces: [] },
  { id: "acme-api", name: "acme-api", groupId: CLIENT.id, workspaces: [] },
  { id: "acme-web", name: "acme-web", groupId: CLIENT.id, workspaces: [] },
];

const rail = () =>
  render(
    <WorkspaceRail
      projects={PROJECTS}
      activeWorkspaceId={null}
      onSelect={vi.fn()}
      onCustomize={vi.fn()}
      isCollapsed={false}
      onReorderProjects={vi.fn()}
    />,
  );
const projectEl = (id: string) => document.querySelector<HTMLElement>(`[data-rail-project="${id}"]`)!;
const sectionEl = () => document.querySelector<HTMLElement>(`[data-rail-section="${CLIENT.id}"]`)!;

beforeEach(() => {
  forced.byId = {};
  drag.context = {};
  useGroupsStore.setState({ groups: [CLIENT], loaded: true });
});
afterEach(() => useGroupsStore.setState({ groups: [], loaded: false }));

describe("the inline transform of a dragged block", () => {
  it("a project group dragged over a short project is translated, not squashed", () => {
    forced.byId[sectionDragId(CLIENT.id)] = {
      isDragging: true,
      transform: { x: 0, y: -437, scaleX: 1, scaleY: 0.4465 },
    };
    rail();
    expect(sectionEl().style.transform).toBe("translate3d(0px, -437px, 0px)");
    expect(sectionEl().style.transform).not.toMatch(/scale/);
  });

  it("a project group dragged over a taller group is translated, not stretched", () => {
    forced.byId[sectionDragId(CLIENT.id)] = {
      isDragging: true,
      transform: { x: 0, y: 212, scaleX: 1, scaleY: 1.502 },
    };
    rail();
    expect(sectionEl().style.transform).toBe("translate3d(0px, 212px, 0px)");
  });

  it("a project is translated only: the dragged one, and one making room for it", () => {
    forced.byId["acme-web"] = { isDragging: true, transform: { x: 2, y: -96, scaleX: 1, scaleY: 2.3 } };
    forced.byId["acme-api"] = { transform: { x: 0, y: 124, scaleX: 1, scaleY: 0.43 } };
    rail();
    expect(projectEl("acme-web").style.transform).toBe("translate3d(2px, -96px, 0px)");
    expect(projectEl("acme-api").style.transform).toBe("translate3d(0px, 124px, 0px)");
    for (const id of ["acme-web", "acme-api"]) expect(projectEl(id).style.transform).not.toMatch(/scale/);
  });

  it("a block at rest carries no transform", () => {
    rail();
    expect(sectionEl().style.transform).toBe("");
    expect(projectEl("dotfiles").style.transform).toBe("");
  });
});

describe("a project dragged out of its group stays in sight", () => {
  const fold = () => document.querySelector<HTMLElement>('[data-testid="rail-section-fold"]')!;
  const clips = () => [fold(), fold().firstElementChild as HTMLElement].map((el) => el.className);

  it("the group clips its fold at rest (the collapse needs it)", () => {
    rail();
    for (const className of clips()) {
      expect(className).toMatch(/overflow-hidden/);
      expect(className).not.toMatch(/overflow-visible/);
    }
  });

  it("while one of its own projects is dragged, the clipping is lifted and the block paints on top", () => {
    forced.byId["acme-web"] = { isDragging: true, transform: null };
    drag.context = { active: { id: "acme-web", data: { current: { type: "project", sectionId: CLIENT.id } } }, over: null };
    rail();
    for (const className of clips()) {
      expect(className).toMatch(/overflow-visible/);
      expect(className).not.toMatch(/overflow-hidden/);
    }
    expect(projectEl("acme-web")).toHaveAttribute("data-dragging", "true");
    expect(projectEl("acme-api")).not.toHaveAttribute("data-dragging");
    // The group itself is raised: its filled entrance animation makes it a
    // stacking context, which would hold the project's z-10 inside it and let
    // every later block paint over the dragged project.
    expect(sectionEl().className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "z-10"]));
    // It is not the dragged surface itself.
    expect(sectionEl().className).not.toMatch(/bg-octo-panel/);
  });

  it("another group's project, or a loose one, lifts nothing here", () => {
    drag.context = { active: { id: "dotfiles", data: { current: { type: "project", sectionId: null } } }, over: null };
    rail();
    for (const className of clips()) expect(className).toMatch(/overflow-hidden/);
    expect(sectionEl().className).not.toMatch(/z-10/);
  });

});

describe("a dragged block is an opaque, lifted surface", () => {
  const classes = (el: HTMLElement) => el.className.split(/\s+/);
  const surface = DRAGGED_BLOCK.split(" ");

  it("is drawn from tokens: the panel ground and the menus' lift, a hairline ring, above what it passes", () => {
    // The panel token is opaque in every theme (Vellum's is cream, not a dark
    // slab), and it is the menus' own ground, so the two cannot drift apart.
    expect(surface).toEqual(expect.arrayContaining(["bg-octo-panel", "ring-1", "ring-octo-hairline", "relative", "z-10"]));
    expect(DRAGGED_BLOCK).toContain(LIFTED_GROUND);
    // No literal colour, and never the recessing panel-2.
    expect(DRAGGED_BLOCK).not.toMatch(/#[0-9a-f]{3,8}|rgb|panel-2/i);
  });

  it("a dragged project wears it at full opacity; the others do not", () => {
    forced.byId["acme-web"] = { isDragging: true, transform: { x: 0, y: 30, scaleX: 1, scaleY: 1 } };
    rail();
    expect(classes(projectEl("acme-web"))).toEqual(expect.arrayContaining(surface));
    expect(projectEl("acme-web").style.opacity).toBe("");
    for (const id of ["acme-api", "dotfiles"]) {
      expect(classes(projectEl(id))).not.toContain("bg-octo-panel");
      expect(classes(projectEl(id))).not.toContain("z-10");
    }
  });

  it("a dragged project group wears it at full opacity", () => {
    forced.byId[sectionDragId(CLIENT.id)] = { isDragging: true, transform: { x: 0, y: 40, scaleX: 1, scaleY: 1 } };
    rail();
    expect(classes(sectionEl())).toEqual(expect.arrayContaining(surface));
    expect(sectionEl().style.opacity).toBe("");
    expect(sectionEl()).toHaveAttribute("data-dragging", "true");
  });

  it("nothing wears it at rest", () => {
    rail();
    for (const el of [sectionEl(), projectEl("dotfiles"), projectEl("acme-api")]) {
      expect(classes(el)).not.toContain("bg-octo-panel");
      expect(el.style.opacity).toBe("");
    }
  });
});
