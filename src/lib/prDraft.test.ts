import { describe, it, expect } from "vitest";
import {
  PR_SYSTEM,
  buildPrPrompt,
  diffPaths,
  issueRef,
  parsePrDraft,
  provenanceSummary,
  provenanceTurns,
} from "./prDraft";
import type { FileEdit } from "./types";

const edit = (id: number, filePath: string, messageId: number | null, createdAt: string): FileEdit => ({
  id,
  workspaceId: "ws",
  filePath,
  toolName: "Edit",
  messageId,
  createdAt,
});

describe("prDraft", () => {
  it("asks for the template to be filled and forbids invented provenance", () => {
    expect(PR_SYSTEM).toMatch(/fill in that template/i);
    expect(PR_SYSTEM).toMatch(/never invent/i);
  });

  it("maps linked tickets: GitHub issues close, Jira keys prefix", () => {
    expect(issueRef("42")).toEqual({ closes: "#42" });
    expect(issueRef("#42")).toEqual({ closes: "#42" });
    expect(issueRef("acme/app#7")).toEqual({ closes: "acme/app#7" });
    expect(issueRef("OCTO-12")).toEqual({ titlePrefix: "OCTO-12" });
    expect(issueRef(null)).toEqual({});
  });

  it("adds Closes #N and the Jira prefix once, never twice", () => {
    expect(parsePrDraft("Add export\n\n## Summary\nDone.", "42")).toEqual({
      title: "Add export",
      body: "Closes #42\n\n## Summary\nDone.",
    });
    expect(parsePrDraft("Add export\n\nFixes #42", "#42").body).toBe("Fixes #42");
    expect(parsePrDraft("Add export\n\nbody", "OCTO-3").title).toBe("OCTO-3: Add export");
    expect(parsePrDraft("OCTO-3 Add export\n\nbody", "OCTO-3").title).toBe("OCTO-3 Add export");
  });

  it("strips a fenced reply and a heading/Title: marker from the title line", () => {
    expect(parsePrDraft("```markdown\n# Title: Add it\n\nBody\n```")).toEqual({ title: "Add it", body: "Body" });
  });

  it("groups provenance by turn for the branch's files, newest first", () => {
    const edits = [
      edit(1, "src/a.ts", 10, "2026-11-01T10:00:00Z"),
      edit(2, "/abs/src/b.ts", 11, "2026-11-01T11:00:00Z"),
      edit(3, "src/a.ts", 11, "2026-11-01T11:00:00Z"),
      edit(4, "src/untouched.ts", 12, "2026-11-01T12:00:00Z"),
      edit(5, "src/a.ts", null, "2026-11-01T12:00:00Z"),
    ];
    const paths = diffPaths("diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/src/b.ts b/src/b.ts\n");
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    const turns = provenanceTurns(edits, paths);
    expect(turns).toEqual([
      { messageId: 11, files: ["/abs/src/b.ts", "src/a.ts"] },
      { messageId: 10, files: ["src/a.ts"] },
    ]);
    const summary = provenanceSummary(turns.map((t, i) => ({ ...t, model: i === 0 ? "claude-opus-4-1" : null })));
    expect(summary).toContain("2 agent turns");
    expect(summary).toContain("- claude-opus-4-1: b.ts, a.ts");
    expect(summary).toContain("- unknown model: a.ts");
    expect(provenanceSummary([])).toBe("");
  });

  it("builds a prompt with the template, provenance and a capped diff", () => {
    const p = buildPrPrompt({
      diff: "x".repeat(13000),
      commits: ["Add b"],
      template: "## Checklist\n- [ ] Tests",
      task: "Export CSV",
      issueKey: "42",
      provenance: "1 agent turn shaped this change",
    });
    expect(p).toContain("Task:\nExport CSV");
    expect(p).toContain("- Add b");
    expect(p).toContain("1 agent turn shaped this change");
    expect(p).toContain("template to fill in:\n## Checklist");
    expect(p).toContain("diff truncated");
    expect(p.length).toBeLessThan(13000);
    expect(buildPrPrompt({ diff: "d", commits: [], template: null })).toMatch(/no agent edits were tracked/);
  });
});
