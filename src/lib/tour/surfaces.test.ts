import { describe, expect, it, vi } from "vitest";
import { NAVIGATE_EVENT, SURFACES, openSurface, type NavigateDetail } from "./surfaces";
import { SETTINGS_TABS } from "../settingsTabs";

function capture(fn: () => void): NavigateDetail[] {
  const seen: NavigateDetail[] = [];
  const h = (e: Event) => seen.push((e as CustomEvent<NavigateDetail>).detail);
  window.addEventListener(NAVIGATE_EVENT, h);
  try {
    fn();
  } finally {
    window.removeEventListener(NAVIGATE_EVENT, h);
  }
  return seen;
}

describe("tour surfaces", () => {
  it("registers every settings tab and every mode", () => {
    for (const t of SETTINGS_TABS) expect(SURFACES[`settings/${t}`]).toBeTypeOf("function");
    for (const m of ["talk", "run", "review", "direct"]) expect(SURFACES[`mode/${m}`]).toBeTypeOf("function");
  });

  it("dispatches a navigate event the app can act on", () => {
    expect(capture(() => openSurface("settings/about"))).toEqual([{ kind: "settings", tab: "about" }]);
    expect(capture(() => openSurface("mode/direct"))).toEqual([{ kind: "mode", mode: "direct" }]);
    expect(capture(() => openSurface("palette"))).toEqual([{ kind: "palette" }]);
  });

  it("returns false for an unknown surface and dispatches nothing", () => {
    const spy = vi.fn();
    window.addEventListener(NAVIGATE_EVENT, spy);
    expect(openSurface("settings/nowhere")).toBe(false);
    window.removeEventListener(NAVIGATE_EVENT, spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
