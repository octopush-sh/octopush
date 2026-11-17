import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecretGuardDialog } from "./SecretGuardDialog";
import type { SecretFinding } from "../lib/secretGuard";

const f = (line: number): SecretFinding => ({ file: "src/a.ts", line, rule: "github-token", kind: "GitHub token", yours: false });

describe("SecretGuardDialog", () => {
  it("defaults to Leave it out; Escape leaves it out; the override is explicit", () => {
    const onLeaveOut = vi.fn();
    const onOverride = vi.fn();
    render(<SecretGuardDialog action="commit" findings={[f(3)]} onLeaveOut={onLeaveOut} onOverride={onOverride} />);
    expect(screen.getByText("This change adds what looks like a GitHub token in src/a.ts:3.")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Leave it out" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onLeaveOut).toHaveBeenCalledTimes(1);
    expect(onOverride).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Commit regardless" }));
    expect(onOverride).toHaveBeenCalledTimes(1);
  });

  it("lists several findings, capped, and names your own key", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map(f);
    many[0] = { ...many[0], kind: "your Anthropic API key", yours: true, rule: "your-credential" };
    render(<SecretGuardDialog action="pr" findings={many} onLeaveOut={() => {}} onOverride={() => {}} />);
    expect(screen.getByText("This pull request adds 7 things that look like secrets.")).toBeInTheDocument();
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
    expect(screen.getByText(/matches a key you saved in Octopush/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it regardless" })).toBeInTheDocument();
  });
});
