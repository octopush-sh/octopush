import { describe, it, expect } from "vitest";
import {
  sandboxOnBody,
  sameSpec,
  setupInstallCommands,
  setupInstallWarning,
  shareRows,
  shareSummary,
  shareToasts,
  specFromRows,
} from "./shareWithMissions";

describe("shareRows", () => {
  it("lists links then copies, checked only where the project already shares them", () => {
    const rows = shareRows({
      saved: { link: [".venv"], copy: [] },
      available: { link: ["node_modules", ".venv"], copy: [".env", ".env.local"] },
    });
    expect(rows).toEqual([
      { kind: "link", name: "node_modules", checked: false },
      { kind: "link", name: ".venv", checked: true },
      { kind: "copy", name: ".env", checked: false },
      { kind: "copy", name: ".env.local", checked: false },
    ]);
  });

  it("keeps a shared entry the checkout no longer has, so it can be turned off", () => {
    const rows = shareRows({ saved: { link: [], copy: [".env"] }, available: { link: [], copy: [] } });
    expect(rows).toEqual([{ kind: "copy", name: ".env", checked: true }]);
    expect(specFromRows(rows.map((r) => ({ ...r, checked: false })))).toEqual({ link: [], copy: [] });
  });
});

describe("specFromRows / sameSpec", () => {
  it("round-trips the checked rows", () => {
    const spec = { link: ["node_modules"], copy: [".env"] };
    const rows = shareRows({ saved: spec, available: { link: ["node_modules"], copy: [".env", ".env.local"] } });
    expect(specFromRows(rows)).toEqual(spec);
    expect(sameSpec(specFromRows(rows), spec)).toBe(true);
    expect(sameSpec(spec, { link: [], copy: [".env"] })).toBe(false);
  });
});

describe("shareSummary / shareToasts", () => {
  const outcome = { linked: ["node_modules"], copied: [".env"], skipped: [] };

  it("reads like the setup line", () => {
    expect(shareSummary(outcome)).toBe("linked node_modules · copied .env");
    expect(shareSummary({ linked: [], copied: [], skipped: ["x"] })).toBeNull();
    expect(shareSummary(null)).toBeNull();
  });

  it("leaves the summary to the setup terminal when there is one", () => {
    expect(shareToasts(outcome, true)).toEqual([]);
    expect(shareToasts(outcome, false)).toEqual([
      { level: "info", title: "Shared with the new mission", body: "linked node_modules · copied .env" },
    ]);
    expect(shareToasts(undefined, false)).toEqual([]);
  });

  it("always says what was left out", () => {
    const toasts = shareToasts(
      { linked: [], copied: [".env"], skipped: ["node_modules: not linked in a sandboxed mission"] },
      true,
    );
    expect(toasts).toEqual([
      { level: "warning", title: "Some entries weren't shared", body: "node_modules: not linked in a sandboxed mission" },
    ]);
  });
});

describe("sandboxOnBody", () => {
  it("names the links the sandbox removed, and stays plain when there were none", () => {
    expect(sandboxOnBody(undefined)).toBe("Agent writes are now confined to the workspace.");
    expect(sandboxOnBody({ unlinked: [] })).toBe("Agent writes are now confined to the workspace.");
    expect(sandboxOnBody({ unlinked: ["node_modules"] })).toBe(
      "Agent writes are now confined to the workspace. Removed the link to the main checkout's node_modules; install inside this mission if it needs it.",
    );
    expect(sandboxOnBody({ unlinked: ["node_modules", ".venv"] })).toContain(
      "node_modules, .venv; install inside this mission if it needs them.",
    );
  });

  it("says which copied env files left the worktree and which stayed because they changed", () => {
    expect(sandboxOnBody({ uncopied: [".env"] })).toBe(
      "Agent writes are now confined to the workspace. Removed the copied .env from this mission's worktree.",
    );
    expect(sandboxOnBody({ unlinked: ["node_modules"], uncopied: [".env"], keptCopies: [".env.local"] })).toBe(
      "Agent writes are now confined to the workspace. Removed the link to the main checkout's node_modules; install inside this mission if it needs it. Removed the copied .env from this mission's worktree. .env.local was changed in this mission, so it stays: its agents can still read it.",
    );
    expect(sandboxOnBody({ keptCopies: [".env", ".env.local"] })).toContain(
      ".env, .env.local were changed in this mission, so they stay: its agents can still read them.",
    );
  });
});

describe("setupInstallCommands / setupInstallWarning", () => {
  it("finds the install and clean commands a setup script runs", () => {
    for (const [script, cmd] of [
      ["npm ci", "npm ci"],
      ["cd web && npm install --no-audit", "npm install"],
      ["pnpm install --frozen-lockfile", "pnpm install"],
      ["yarn", "yarn"],
      ["yarn install --immutable", "yarn install"],
      ["yarn && yarn build", "yarn"],
      ["python -m pip install -r requirements.txt", "pip install"],
      ["rm -rf node_modules", "rm -rf node_modules"],
      ["rm -rf dist ./node_modules && npm ci", "rm -rf dist ./node_modules"],
      ["rm -fr .venv", "rm -fr .venv"],
    ] as const) {
      expect(setupInstallCommands(script), script).toContain(cmd);
    }
    expect(setupInstallCommands("npm ci\nnpm   ci\npip install -e .")).toEqual(["npm ci", "pip install"]);
  });

  it("stays quiet for scripts that neither install nor clean", () => {
    for (const script of [
      "",
      "# npm ci",
      "npm run build",
      "yarn build",
      "yarn test --watch",
      "cp .env.example .env.test",
      "rm -rf dist",
      "echo node_modules",
      "rm -rf dist && ls node_modules",
      "make setup",
    ]) {
      expect(setupInstallCommands(script), script).toEqual([]);
    }
  });

  it("warns only when a dependency folder is linked", () => {
    expect(setupInstallWarning("npm ci", [])).toBeNull();
    expect(setupInstallWarning("npm run build", ["node_modules"])).toBeNull();
    expect(setupInstallWarning("npm ci", ["node_modules"])).toBe(
      "This setup script runs npm ci. With node_modules linked, that changes the main checkout's folder, for the main checkout and for every other mission.",
    );
    expect(setupInstallWarning("rm -rf node_modules\npip install -r r.txt", ["node_modules", ".venv"])).toBe(
      "This setup script runs rm -rf node_modules, pip install. With node_modules, .venv linked, that changes the main checkout's folders, for the main checkout and for every other mission.",
    );
  });
});
