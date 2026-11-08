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

  it("notes CONDUCTOR_PORT only when the script reads it", () => {
    expect(conductorSourceLine("npm run dev -- --port $CONDUCTOR_PORT")).toBe(
      "From .conductor/settings.toml · edit before it runs · CONDUCTOR_PORT isn't set in Octopush",
    );
    expect(conductorSourceLine('cp "$CONDUCTOR_ROOT_PATH/.env" .env')).not.toContain("CONDUCTOR_PORT");
    expect(conductorSourceLine("echo $CONDUCTOR_PORTS")).not.toContain("CONDUCTOR_PORT");
  });
});
