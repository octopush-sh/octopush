// "Share with new missions" (#961): the step-3 list of what a fresh worktree
// borrows from the main checkout, and how its outcome is reported.
// Backend: src-tauri/src/worktree_share.rs.

import type { ShareOptions, ShareOutcome, ShareSpec } from "./types";

export interface ShareRow {
  kind: "link" | "copy";
  name: string;
  checked: boolean;
}

/** One row per entry the main checkout offers or the project already shares
 *  (links first), checked when it is shared. Nothing is checked until the user
 *  opts in. */
export function shareRows(options: ShareOptions): ShareRow[] {
  const rows: ShareRow[] = [];
  for (const kind of ["link", "copy"] as const) {
    const saved = options.saved[kind];
    const names = [...options.available[kind], ...saved.filter((n) => !options.available[kind].includes(n))];
    for (const name of names) rows.push({ kind, name, checked: saved.includes(name) });
  }
  return rows;
}

/** The spec the checked rows describe. */
export function specFromRows(rows: ShareRow[]): ShareSpec {
  const pick = (kind: ShareRow["kind"]) => rows.filter((r) => r.kind === kind && r.checked).map((r) => r.name);
  return { link: pick("link"), copy: pick("copy") };
}

export function sameSpec(a: ShareSpec, b: ShareSpec): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((n, i) => n === y[i]);
  return eq(a.link, b.link) && eq(a.copy, b.copy);
}

/** `linked node_modules · copied .env`, or null — the setup line's wording
 *  (mirrors `ShareOutcome::summary`). */
export function shareSummary(o: ShareOutcome | null | undefined): string | null {
  if (!o) return null;
  const parts: string[] = [];
  if (o.linked.length) parts.push(`linked ${o.linked.join(", ")}`);
  if (o.copied.length) parts.push(`copied ${o.copied.join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

export interface ShareToast {
  level: "info" | "warning";
  title: string;
  body: string;
}

/** What to tell the user once the mission exists. With a setup terminal the
 *  shared entries already show on its first line, so only what was left out is
 *  raised; without one, a quiet info toast says what was shared. */
export function shareToasts(o: ShareOutcome | null | undefined, hasSetupTerminal: boolean): ShareToast[] {
  if (!o) return [];
  const out: ShareToast[] = [];
  const summary = shareSummary(o);
  if (summary && !hasSetupTerminal) {
    out.push({ level: "info", title: "Shared with the new mission", body: summary });
  }
  if (o.skipped.length) {
    out.push({ level: "warning", title: "Some entries weren't shared", body: o.skipped.join("; ") });
  }
  return out;
}

/** The "Sandbox enabled" toast's body. Turning the sandbox on removes the
 *  folders linked from the main checkout (`unlinked`), which the sandbox
 *  couldn't read or write through. */
export function sandboxOnBody(unlinked: string[] | undefined): string {
  const base = "Agent writes are now confined to the workspace.";
  if (!unlinked?.length) return base;
  const many = unlinked.length > 1;
  return `${base} Removed the link${many ? "s" : ""} to the main checkout's ${unlinked.join(", ")}; install inside this mission if it needs ${many ? "them" : "it"}.`;
}
