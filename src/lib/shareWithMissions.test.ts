import { describe, it, expect } from "vitest";
import { sameSpec, shareRows, shareSummary, shareToasts, specFromRows } from "./shareWithMissions";

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
