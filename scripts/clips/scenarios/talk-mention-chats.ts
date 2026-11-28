// `talk-mention-chats` — `default`, with a second, older conversation in the
// active workspace ("Auth refactor": one ask and its answer) and a definition
// of `parseToken` in `src/lib/tokens.ts`. Typing `@chat:` in Talk's composer
// lists that conversation under Conversations; typing `@parseToken` finds the
// definition (a whole-word search hit, then its lines) under Definitions.
import type { Scenario } from "./types";
import type { LineRangeResult, ipc } from "../../../src/lib/ipc";
import type { ChatMessage, ChatThread, DirectoryEntry, SearchHit } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { EARLIER, THREAD, MESSAGES } = DEFAULT_FIXTURES;
const WS = THREAD.workspaceId;

// Older than the open conversation, so `default`'s thread stays the active one
// (the store opens the first thread listed).
const AUTH_THREAD: ChatThread = {
  id: "th-auth",
  workspaceId: WS,
  title: "Auth refactor",
  createdAt: "2026-10-27T09:40:00Z",
  updatedAt: EARLIER,
};

const AUTH_ASK = "Move the bearer-token parsing out of the request handler into its own module.";
const AUTH_ANSWER =
  "Done. `parseToken` now lives in `src/lib/tokens.ts` and returns `null` when the header holds no bearer token; " +
  "the handler calls it and answers 401 on `null`.";

const AUTH_MESSAGES: ChatMessage[] = [
  {
    id: 101, workspaceId: WS, role: "user", model: null, inputTokens: null, outputTokens: null, costUsd: null,
    createdAt: AUTH_THREAD.createdAt, content: AUTH_ASK,
  },
  {
    id: 102, workspaceId: WS, role: "assistant", model: "claude-sonnet-4-6", inputTokens: 2_480, outputTokens: 162, costUsd: 0.0099,
    createdAt: EARLIER, content: AUTH_ANSWER,
  },
];

type ThreadDigest = Awaited<ReturnType<typeof ipc.chatThreadDigest>>;
const NO_DIGEST: ThreadDigest = { summary: null, asks: [], lastAnswer: null };

// ─── The definition `@parseToken` finds ──────────────────────────────────
const TOKENS_PATH = "src/lib/tokens.ts";
const TOKENS_TS = [
  "// Bearer tokens read from request headers.",
  "export interface Token {",
  '  scheme: "bearer";',
  "  value: string;",
  "}",
  "",
  'const PREFIX = "Bearer ";',
  "",
  "/** The token in an `Authorization` header, or null when it holds none. */",
  "export function parseToken(raw: string): Token | null {",
  "  if (!raw.startsWith(PREFIX)) return null;",
  "  const value = raw.slice(PREFIX.length).trim();",
  '  return value ? { scheme: "bearer", value } : null;',
  "}",
];
const DEFINED_AT = TOKENS_TS.findIndex((l) => l.startsWith("export function parseToken")) + 1;

// A whole-word search returns every mention; only the definition reads as one.
const HITS: SearchHit[] = [
  { file: TOKENS_PATH, line: DEFINED_AT, col: 17, preview: TOKENS_TS[DEFINED_AT - 1] },
  { file: "src/App.tsx", line: 31, col: 17, preview: '  const token = parseToken(headers.authorization ?? "");' },
];

const FILES = [...(defaultScenario.commands.list_workspace_files as string[]), TOKENS_PATH];

const readDirectory = defaultScenario.commands.read_directory as (a: Record<string, unknown>) => DirectoryEntry[];

export const talkMentionChats: Scenario = {
  ...defaultScenario,
  name: "talk-mention-chats",
  description: "`default` with an older conversation (\"Auth refactor\") in the active workspace and a `parseToken` definition in `src/lib/tokens.ts`, for Talk's @ popover.",
  commands: {
    ...defaultScenario.commands,
    list_chat_threads: (a) => (a.workspaceId === WS ? [THREAD, AUTH_THREAD] : []),
    list_chat_messages: (a) => (a.threadId === THREAD.id ? MESSAGES : a.threadId === AUTH_THREAD.id ? AUTH_MESSAGES : []),
    // Read-only, and only for a conversation of the workspace asked about.
    chat_thread_digest: (a): ThreadDigest =>
      a.workspaceId === WS && a.threadId === AUTH_THREAD.id
        ? { summary: null, asks: [AUTH_ASK], lastAnswer: AUTH_ANSWER }
        : NO_DIGEST,
    list_workspace_files: FILES,
    // Review's tree shows the new file too.
    read_directory: (a): DirectoryEntry[] => {
      const entries = readDirectory(a);
      const root = String(a.path ?? "").replace(/\/$/, "");
      if (root.endsWith("/src") && !root.endsWith("src-tauri/src")) {
        const lib: DirectoryEntry = { name: "lib", path: `${root}/lib`, isDir: true, isIgnored: false };
        return [...entries.filter((e) => e.isDir), lib, ...entries.filter((e) => !e.isDir)];
      }
      if (root.endsWith("/src/lib")) return [{ name: "tokens.ts", path: `${root}/tokens.ts`, isDir: false, isIgnored: false }];
      return entries;
    },
    search_workspace_text: (a) => (a.query === "parseToken" ? HITS : []),
    read_file_lines: (a): LineRangeResult | null => {
      if (!String(a.path).endsWith(`/${TOKENS_PATH}`)) return null;
      const start = Math.max(1, Number(a.start));
      const end = Math.min(TOKENS_TS.length, Number(a.end));
      return { kind: "text", content: TOKENS_TS.slice(start - 1, end).join("\n"), start, end, total: TOKENS_TS.length, cut: false };
    },
  },
};
