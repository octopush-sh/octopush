// The demo's Pro user must hold exactly the feature keys the Rust core grants
// Pro. When the fixture drifted (`history_sync` instead of `history.sync`), the
// nightly screenshots showed a "Pro" user with locked Sync rows (#561).
import { describe, expect, it } from "vitest";
import { defaultScenario } from "../../scripts/clips/scenarios/default";
import type { Entitlement } from "../lib/ipc";
import entitlementRs from "../../src-tauri/src/entitlement.rs?raw";

function rustFeatureKeys(): string[] {
  const mod = entitlementRs.match(/pub mod feature \{([\s\S]*?)\n\}/);
  if (!mod) throw new Error("pub mod feature not found in entitlement.rs");
  return [...mod[1].matchAll(/pub const \w+: &str = "([^"]+)";/g)].map((m) => m[1]);
}

describe("clip fixtures — entitlement", () => {
  it("the default scenario's Pro features equal the Rust feature keys", () => {
    const rust = rustFeatureKeys();
    expect(rust.length).toBeGreaterThan(0);
    const ent = defaultScenario.commands.get_entitlement as Entitlement;
    expect(ent.plan).toBe("pro");
    expect([...ent.features].sort()).toEqual([...rust].sort());
  });
});
