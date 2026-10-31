// Run with: node --test scripts/whats-new.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, parseChangeset, renderNotes } from "./whats-new.mjs";

const ctx = { targets: new Set(["settings-account-sync"]), surfaces: new Set(["settings/account"]) };
const ok = `---
title: Run history syncs only if you turn it on
kind: feature
area: app
steps:
  - open: settings/account
    target: settings-account-sync
    caption: Turn it on here.
---
Cloud sync is now opt-in.`;

test("a valid changeset passes", () => {
  assert.deepEqual(validate("/x/run-history-opt-in.md", ok, ctx), []);
});

test("unknown targets, surfaces, keys and enums are reported", () => {
  const bad = ok
    .replace("settings-account-sync", "missing-target")
    .replace("settings/account", "settings/nowhere")
    .replace("kind: feature", "kind: epic\nmood: happy");
  const errs = validate("/x/Bad_Slug.md", bad, ctx).join("\n");
  assert.match(errs, /slug/);
  assert.match(errs, /no element has data-tour="missing-target"/);
  assert.match(errs, /not a registered surface/);
  assert.match(errs, /kind must be/);
  assert.match(errs, /unknown key "mood"/);
});

test("steps are app-only, type needs text, limits enforced", () => {
  const s = `---\ntitle: x\nkind: fix\narea: web\nsteps:\n  - target: settings-account-sync\n    caption: c\n    action: type\n---\nbody`;
  const errs = validate("/x/a.md", s, ctx).join("\n");
  assert.match(errs, /only allowed for area: app/);
  assert.match(errs, /text is required/);
  assert.match(validate("/x/a.md", `---\ntitle: ${"t".repeat(61)}\nkind: fix\narea: app\n---\nb`, ctx).join(), /max 60/);
  assert.match(validate("/x/a.md", `---\ntitle: t\nkind: fix\narea: app\n---\n`, ctx).join(), /body/);
});

test("missing frontmatter is an error, not a crash", () => {
  assert.match(validate("/x/a.md", "just text", ctx).join(), /frontmatter/);
  assert.throws(() => parseChangeset("nope"));
});

test("notes group by kind, mark non-app areas and list maintenance PRs", () => {
  const md = renderNotes("0.4.90", [
    { meta: { kind: "fix", area: "app", title: "Fixed A" }, body: "a" },
    { meta: { kind: "feature", area: "app", title: "New B" }, body: "b\nline" },
    { meta: { kind: "improvement", area: "web", title: "Site C" }, body: "c" },
  ], [{ number: 7, title: "Bump vite" }]);
  assert.match(md, /^## Octopush 0\.4\.90/);
  assert.ok(md.indexOf("### Features") < md.indexOf("### Improvements") && md.indexOf("### Improvements") < md.indexOf("### Fixes"));
  assert.match(md, /\*\*New B\*\* — b line/);
  assert.match(md, /Site C\*\* _\(website\)_/);
  assert.match(md, /### Maintenance\n\nBump vite \(#7\)/);
  assert.match(renderNotes("1.0.0", [], []), /Maintenance release\./);
});
