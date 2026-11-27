import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatMessage } from "./types";

vi.mock("./ipc", () => ({
  ipc: { generateChatTitle: vi.fn() },
}));

const { ipc } = await import("./ipc");
const { cleanGeneratedTitle, isAutoTitle, requestChatTitle, titleRequest, TITLE_TIMEOUT_MS } = await import("./chatTitleGen");
const { deriveChatTitle } = await import("./chatTitle");

const generate = vi.mocked(ipc.generateChatTitle);

let nextId = 1;
function msg(role: ChatMessage["role"], content: string, model: string | null = null): ChatMessage {
  return {
    id: nextId++,
    workspaceId: "ws-1",
    role,
    content,
    model,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: "2026-11-27T10:00:00Z",
  };
}

const thread = (ask: string, answer = "Here is what I found.") => [msg("user", ask), msg("assistant", answer, "claude-opus-5-5")];

describe("titleRequest", () => {
  it("sends the tidied ask and the first 1,500 characters of the answer", () => {
    const req = titleRequest(thread("/ship-ticket @src/a.ts fix the login\n```\ncode\n```", "x".repeat(4000)))!;
    expect(req.prompt).toContain("fix the login");
    expect(req.prompt).not.toContain("/ship-ticket");
    expect(req.prompt).not.toContain("@src/a.ts");
    expect(req.prompt).not.toContain("code");
    expect(req.prompt).toContain("x".repeat(1500));
    expect(req.prompt).not.toContain("x".repeat(1501));
    expect(req.key).toBeNull();
    expect(req.system).toMatch(/language the developer wrote in/);
  });

  it("asks for the ticket key first when the ask names one", () => {
    const req = titleRequest(thread("/ship-ticket https://acme.atlassian.net/browse/GUIDE-123"))!;
    expect(req.key).toBe("GUIDE-123");
    expect(req.system).toContain('start the title with "GUIDE-123 · "');
  });

  it("has nothing to send before an answer", () => {
    expect(titleRequest([msg("user", "hi")])).toBeNull();
    expect(titleRequest([])).toBeNull();
  });
});

describe("cleanGeneratedTitle", () => {
  it("takes the first line, without a label, quotes or trailing period", () => {
    expect(cleanGeneratedTitle('Title: "Fix the login redirect."\nBecause…', null)).toBe("Fix the login redirect");
    expect(cleanGeneratedTitle("“Arreglar el inicio de sesión”", null)).toBe("Arreglar el inicio de sesión");
  });

  it("keeps at most six words", () => {
    expect(cleanGeneratedTitle("one two three four five six seven eight", null)).toBe("one two three four five six");
  });

  it("leads with the ticket key, once", () => {
    expect(cleanGeneratedTitle("Waive virtualenv findings", "GUIDE-123")).toBe("GUIDE-123 · Waive virtualenv findings");
    expect(cleanGeneratedTitle("GUIDE-123 · Waive virtualenv findings", "GUIDE-123")).toBe("GUIDE-123 · Waive virtualenv findings");
    expect(cleanGeneratedTitle("GUIDE-123: Waive virtualenv findings.", "GUIDE-123")).toBe("GUIDE-123 · Waive virtualenv findings");
  });

  it("gives nothing back for an empty reply", () => {
    expect(cleanGeneratedTitle('  ""  ', null)).toBeNull();
    expect(cleanGeneratedTitle("GUIDE-123", "GUIDE-123")).toBeNull();
  });
});

describe("isAutoTitle", () => {
  it("is true for the placeholder and the derived title only", () => {
    const msgs = thread("/ship-ticket https://acme.atlassian.net/browse/GUIDE-123");
    expect(isAutoTitle("New conversation", msgs)).toBe(true);
    expect(isAutoTitle(deriveChatTitle(msgs), msgs)).toBe(true);
    // Renamed, or a fork's title: never replaced on its own.
    expect(isAutoTitle("My release notes", msgs)).toBe(false);
    expect(isAutoTitle("GUIDE-123 · fork", msgs)).toBe(false);
  });
});

describe("requestChatTitle", () => {
  const args = (messages: ChatMessage[]) => ({ threadId: "t1", workspaceId: "ws-1", model: "claude-opus-5-5", messages });

  beforeEach(() => generate.mockReset());
  afterEach(() => vi.useRealTimers());

  it("returns the cleaned title", async () => {
    generate.mockResolvedValue({ text: "Waive virtualenv findings.", model: "claude-haiku-5-5", costUsd: 0.0004 });
    const msgs = thread("/ship-ticket https://acme.atlassian.net/browse/GUIDE-123");
    expect(await requestChatTitle(args(msgs))).toBe("GUIDE-123 · Waive virtualenv findings");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t1", workspaceId: "ws-1", model: "claude-opus-5-5" }),
    );
  });

  it("falls back (null) with no fast tier, on a failure, or after 10 s", async () => {
    generate.mockResolvedValueOnce(null);
    expect(await requestChatTitle(args(thread("fix it")))).toBeNull();

    generate.mockRejectedValueOnce(new Error("provider down"));
    expect(await requestChatTitle(args(thread("fix it")))).toBeNull();

    vi.useFakeTimers();
    generate.mockReturnValueOnce(new Promise(() => {}));
    const late = requestChatTitle(args(thread("fix it")));
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS);
    expect(await late).toBeNull();
    expect(TITLE_TIMEOUT_MS).toBe(10_000);
  });

  it("doesn't call before there is an answer", async () => {
    expect(await requestChatTitle(args([msg("user", "hi")]))).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});
