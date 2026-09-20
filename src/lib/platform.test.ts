import { afterEach, describe, expect, it } from "vitest";
import { isMac, modKeyLabel } from "./platform";

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

function setPlatform(value: string) {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

afterEach(() => {
  // jsdom defines `platform` on the prototype; drop the instance override.
  delete (navigator as unknown as { platform?: string }).platform;
  if (original) Object.defineProperty(Navigator.prototype, "platform", original);
});

describe("platform", () => {
  it("names ⌘ on a Mac", () => {
    setPlatform("MacIntel");
    expect(isMac()).toBe(true);
    expect(modKeyLabel()).toBe("⌘");
  });

  it("names Ctrl+ everywhere else", () => {
    setPlatform("Linux x86_64");
    expect(isMac()).toBe(false);
    expect(modKeyLabel()).toBe("Ctrl+");
    setPlatform("Win32");
    expect(modKeyLabel()).toBe("Ctrl+");
  });
});
