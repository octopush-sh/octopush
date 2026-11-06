import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ClaudeLoginExpiry } from "../lib/ipc";
import { WARN_DAYS, loginDay, loginNote } from "../lib/claudeLogin";

const getClaudeLogin = vi.fn();
vi.mock("../lib/ipc", () => ({ ipc: { getClaudeLogin: () => getClaudeLogin() } }));
const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: () => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => {});
  }),
}));

const { ClaudeLoginNote } = await import("./ClaudeLoginNote");
const { useClaudeLoginStore } = await import("../stores/claudeLoginStore");

const DAY = 86_400;
const nowSecs = () => Math.floor(Date.now() / 1000);
const login = (inDays: number): ClaudeLoginExpiry => ({
  expiresAt: nowSecs() + Math.round(inDays * DAY),
  seenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
});

beforeEach(() => {
  getClaudeLogin.mockReset().mockResolvedValue(null);
  useClaudeLoginStore.setState({ login: null });
});

describe("loginNote", () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const at = (days: number): ClaudeLoginExpiry => ({ expiresAt: now / 1000 + days * DAY, seenAt: "2026-11-06T00:00:00Z" });

  it("is silent with nothing reported or more than ten days left", () => {
    expect(loginNote(null, now)).toBeNull();
    expect(loginNote(at(WARN_DAYS + 1), now)).toBeNull();
  });

  it("warns within ten days and says when it ended", () => {
    expect(loginNote(at(WARN_DAYS), now)?.tone).toBe("soon");
    const soon = loginNote(at(3), now)!;
    expect(soon.text).toBe(`Your Claude sign-in ends ${loginDay(at(3).expiresAt)} · sign in again so overnight crews keep running`);
    const ended = loginNote(at(-1), now)!;
    expect(ended.tone).toBe("ended");
    expect(ended.text).toMatch(/^Your Claude sign-in ended \d{1,2} [A-Z][a-z]{2} · CLI stages and Routines can't run/);
  });

  it("formats the day like the Readiness row", () => {
    expect(loginDay(Date.UTC(2026, 11, 12, 12) / 1000)).toBe("12 Dec");
  });
});

describe("ClaudeLoginNote", () => {
  it("renders nothing until a stage reported a sign-in end", async () => {
    const { container } = await act(async () => render(<ClaudeLoginNote tourId="x" />));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the end is more than ten days away", async () => {
    getClaudeLogin.mockResolvedValue(login(30));
    const { container } = await act(async () => render(<ClaudeLoginNote tourId="x" />));
    expect(getClaudeLogin).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an amber note with the sign-in command below the threshold", async () => {
    getClaudeLogin.mockResolvedValue(login(4));
    render(<ClaudeLoginNote tourId="routines-login-expiry" />);
    const note = await screen.findByTestId("claude-login-note");
    expect(note.className).toContain("text-octo-warning");
    expect(note.getAttribute("data-tour")).toBe("routines-login-expiry");
    expect(note.textContent).toMatch(/Your Claude sign-in ends .* · claude auth login$/);
    expect(note.getAttribute("title")).toBe("From the last Claude Code run, as of 2 h ago");
  });

  it("turns rouge once the sign-in has ended", async () => {
    getClaudeLogin.mockResolvedValue(login(-2));
    render(<ClaudeLoginNote tourId="x" />);
    const note = await screen.findByTestId("claude-login-note");
    expect(note.className).toContain("text-octo-rouge");
    expect(note.getAttribute("data-tone")).toBe("ended");
  });

  it("hides an ended note once an Anthropic key is set, like Readiness", async () => {
    getClaudeLogin.mockResolvedValue(login(-2));
    render(<ClaudeLoginNote tourId="x" />);
    await screen.findByTestId("claude-login-note");
    // With a key, `get_claude_login` answers null (`claude_login::shown`).
    getClaudeLogin.mockResolvedValue(null);
    await act(async () => useClaudeLoginStore.getState().load());
    expect(screen.queryByTestId("claude-login-note")).toBeNull();
  });

  it("reloads when a stage reports a new date, and a failed read shows nothing", async () => {
    getClaudeLogin.mockResolvedValue(login(4));
    render(<ClaudeLoginNote tourId="x" />);
    await screen.findByTestId("claude-login-note");
    // Signed in again: the next stage reports a later end.
    getClaudeLogin.mockResolvedValue(login(90));
    await act(async () => listeners.get("claude-login://updated")?.());
    expect(screen.queryByTestId("claude-login-note")).toBeNull();

    act(() => useClaudeLoginStore.setState({ login: null }));
    getClaudeLogin.mockRejectedValue(new Error("db locked"));
    await act(async () => useClaudeLoginStore.getState().load());
    expect(useClaudeLoginStore.getState().login).toBeNull();
  });
});
