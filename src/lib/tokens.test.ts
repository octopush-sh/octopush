import { describe, it, expect } from "vitest";
import { tokens, fonts, ease, dur } from "./tokens";

describe("design tokens — Onyx & Brass", () => {
  it("exports the canonical color tokens with spec hex values", () => {
    expect(tokens.onyx).toBe("#0c0a08");
    expect(tokens.panel).toBe("#14110d");
    expect(tokens.panel2).toBe("#1a160f");
    expect(tokens.hairline).toBe("#2a2419");
    expect(tokens.brass).toBe("#d4a574");
    expect(tokens.brassHi).toBe("#e8c39a");
    expect(tokens.ivory).toBe("#f4ecdb");
    expect(tokens.sage).toBe("#95897a");
    expect(tokens.mute).toBe("#6d6354");
    expect(tokens.verdigris).toBe("#8fc9a8");
    expect(tokens.rouge).toBe("#d18b8b");
    // Warning is amber — deliberately NOT the brass hex.
    expect(tokens.warning).toBe("#dfae4a");
    expect(tokens.warning).not.toBe(tokens.brass);
  });

  it("exposes brass alpha utilities", () => {
    expect(tokens.brassDim).toBe("rgba(212, 165, 116, 0.4)");
    expect(tokens.brassGhost).toBe("rgba(212, 165, 116, 0.08)");
  });

  it("declares the three type families", () => {
    expect(fonts.serif).toContain("Spectral");
    expect(fonts.sans).toContain("-apple-system");
    expect(fonts.mono).toContain("JetBrains Mono");
  });

  it("exposes the Atelier easing curve", () => {
    expect(ease.octo).toBe("cubic-bezier(0.2, 0.8, 0.3, 1)");
  });

  it("exposes motion durations in milliseconds", () => {
    expect(dur.quick).toBe(220);
    expect(dur.standard).toBe(280);
    expect(dur.slow).toBe(320);
    expect(dur.reveal).toBe(600);
  });
});
