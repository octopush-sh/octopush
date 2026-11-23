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

/** What turning the sandbox on took back from a mission's worktree. */
export interface SandboxUnshared {
  /** Links to the main checkout's folders that were removed. */
  unlinked?: string[];
  /** Copied env files removed (still identical to the main checkout's). */
  uncopied?: string[];
  /** Copied env files left in place because they changed in the mission. */
  keptCopies?: string[];
}

/** The "Sandbox enabled" toast's body. Turning the sandbox on removes the
 *  folders linked from the main checkout (the sandbox couldn't read or write
 *  through them) and each copied env file that is still identical to the
 *  main checkout's; one edited in the mission stays and is named. */
export function sandboxOnBody(done: SandboxUnshared | undefined): string {
  const parts = ["Agent writes are now confined to the workspace."];
  const unlinked = done?.unlinked ?? [];
  const uncopied = done?.uncopied ?? [];
  const kept = done?.keptCopies ?? [];
  if (unlinked.length) {
    const many = unlinked.length > 1;
    parts.push(
      `Removed the link${many ? "s" : ""} to the main checkout's ${unlinked.join(", ")}; install inside this mission if it needs ${many ? "them" : "it"}.`,
    );
  }
  if (uncopied.length) {
    parts.push(`Removed the copied ${uncopied.join(", ")} from this mission's worktree.`);
  }
  if (kept.length) {
    const many = kept.length > 1;
    parts.push(
      `${kept.join(", ")} ${many ? "were" : "was"} changed in this mission, so ${many ? "they stay" : "it stays"}: its agents can still read ${many ? "them" : "it"}.`,
    );
  }
  return parts.join(" ");
}

/** The install and clean commands a setup script runs that would rewrite a
 *  linked dependency folder, which is the main checkout's own folder. Each
 *  is returned as written once (`npm ci`, `rm -rf node_modules`), in order;
 *  comment lines are ignored. Pure. */
export function setupInstallCommands(script: string): string[] {
  const patterns: RegExp[] = [
    /\bnpm\s+(?:ci|install|i)\b/,
    /\bpnpm\s+(?:install|i)\b/,
    /\byarn(?:\s+install\b|(?=\s*(?:$|&&|\|\||;|--)))/,
    /\bbun\s+install\b/,
    /\bpip3?\s+install\b/,
    /\buv\s+(?:sync|pip\s+install)\b/,
    /\bpoetry\s+install\b/,
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(?:[^\s;&|]+\s+)*?(?:\.\/)?(?:node_modules|\.venv|venv)\b/,
  ];
  const found: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      const cmd = m[0].replace(/\s+/g, " ").trim();
      if (!found.includes(cmd)) found.push(cmd);
    }
  }
  return found;
}

/** The warning under the share list when a dependency folder is linked and
 *  the setup script installs or cleans; null when there is nothing to say. */
export function setupInstallWarning(script: string, linked: string[]): string | null {
  if (linked.length === 0) return null;
  const cmds = setupInstallCommands(script);
  if (cmds.length === 0) return null;
  const many = linked.length > 1;
  return `This setup script runs ${cmds.join(", ")}. With ${linked.join(", ")} linked, that changes the main checkout's ${many ? "folders" : "folder"}, for the main checkout and for every other mission.`;
}
