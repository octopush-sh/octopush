import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecretGuardDialog } from "./SecretGuardDialog";
import type { SecretFinding, SecretRefusal } from "../lib/secretGuard";

const f = (line: number): SecretFinding => ({ file: "src/a.ts", line, rule: "github-token", kind: "GitHub token", yours: false });
const refusal = (findings: SecretFinding[], over: Partial<SecretRefusal> = {}): SecretRefusal => ({
  findings, total: findings.length, partial: false, fingerprint: "fp", ...over,
});

describe("SecretGuardDialog", () => {
  it("defaults to Leave it out; Escape leaves it out; the override is explicit", () => {
    const onLeaveOut = vi.fn();
    const onOverride = vi.fn();
    render(<SecretGuardDialog action="commit" refusal={refusal([f(3)])} onLeaveOut={onLeaveOut} onOverride={onOverride} />);
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
    render(<SecretGuardDialog action="pr" refusal={refusal(many)} onLeaveOut={() => {}} onOverride={() => {}} />);
    expect(screen.getByText("This pull request adds 7 things that look like secrets.")).toBeInTheDocument();
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
    expect(screen.getByText(/matches a key you saved in Octopush/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open it regardless" })).toBeInTheDocument();
  });

  it("counts past the cap and says when the scan stopped early", () => {
    render(<SecretGuardDialog action="push" refusal={refusal([f(1), f(2)], { total: 60, partial: true })} onLeaveOut={() => {}} onOverride={() => {}} />);
    expect(screen.getByText("This push adds 60 things that look like secrets.")).toBeInTheDocument();
    expect(screen.getByText("and 58 more")).toBeInTheDocument();
    expect(screen.getByText("Scanned the first 16 MB; the rest wasn't checked.")).toBeInTheDocument();
  });

  it("asks even with nothing found when the scan was partial", () => {
    render(<SecretGuardDialog action="commit" refusal={refusal([], { partial: true })} onLeaveOut={() => {}} onOverride={() => {}} />);
    expect(screen.getByText("This change is too large to check in full.")).toBeInTheDocument();
    expect(screen.getByText("Scanned the first 16 MB; the rest wasn't checked.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit regardless" })).toBeInTheDocument();
  });
});
