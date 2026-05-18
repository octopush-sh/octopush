# Persist Chat Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist chat error messages as `role="error"` rows in `chat_messages` so they survive app relaunch and are shown chronologically in the chat timeline.

**Architecture:** When the agentic loop fails in `chat_engine.rs`, insert a `role="error"` row into the DB via `insert_and_emit_message` (same path assistant/tool rows use). On the frontend, the `ConversationItem` union gains an `"error"` kind; the existing `ErrorBlock` component renders it. The `errorByWs` transient slice is retained for the in-flight error banner but errors are also written into `messagesByWs` so they survive relaunch. The `ChatMessage` role type is widened from a literal union to `string` where needed; `ChatMessage.role` in `types.ts` is widened to accept `"error"`.

**Tech Stack:** Rust (rusqlite, tauri, chrono), TypeScript (React 19, Zustand, Vitest, @testing-library/react)

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/chat_engine.rs` | Call `insert_and_emit_message` on error before propagating |
| `src-tauri/src/tests.rs` | Add `load_messages_includes_error_rows` test in `workspace_tests` |
| `src/lib/types.ts` | Widen `ChatMessage.role` to include `"error"` |
| `src/stores/chatStore.ts` | Add `"error"` kind to `ConversationItem`; write error to `messagesByWs` in `send`; emit live error event to `messagesByWs` from listener |
| `src/components/ChatView.tsx` | Render `{ kind: "error" }` items from timeline using `ErrorBlock` |
| `src/components/ChatView.test.tsx` | Add test: error row in history renders ErrorBlock |
| `src/stores/chatStore.test.ts` | Add test: error event writes to messagesByWs |

---

## Task 1: Backend — persist error rows on agentic loop failure

**Files:**
- Modify: `src-tauri/src/chat_engine.rs` (lines 593–596, the two error return paths)

### Context

`send_agentic` returns `AppResult<()>`. There are two failure modes:

1. Early return from `resolve_provider` — but this happens before the user message is even persisted, so there's nothing to persist yet (the user message INSERT at line 351 hasn't run). This error propagates up through `commands.rs::send_chat_message` as a regular Tauri error and the frontend catches it in the `.catch` of `ipc.sendChatMessage` → `errorByWs`.

2. The `provider.complete(...)` call at line 436 — `?` propagates immediately out of the loop. The user message IS already persisted.

3. The max-iterations sentinel at line 593: `Err(AppError::Other(...))`.

For cases 2 and 3, we want to persist an error row. The cleanest approach: wrap the inner agentic loop in an inner function or use a `match` at the call site in `send_agentic`. The simpler approach that matches the existing code style: add a helper function that runs the loop and returns `AppResult<()>`, then in `send_agentic` match its result and persist if `Err`.

Actually, the simplest approach that requires the least restructuring: use a closure/block to capture the loop result, then persist on error.

- [ ] **Step 1: Write the failing test** (Rust)

Add this test to `src-tauri/src/tests.rs` inside the existing `workspace_tests` mod (after the `update_workspace_customization_clears_with_none` test):

```rust
#[test]
fn insert_and_list_error_message() {
    let db = test_db();
    db.insert_project("proj-err", "Test Project", "/tmp/proj-err")
        .unwrap();
    db.insert_workspace("ws-err", "proj-err", "ws", "", "main", None, "")
        .unwrap();

    db.insert_chat_message("ws-err", "user", "hello", None, None, None, None)
        .unwrap();
    db.insert_chat_message(
        "ws-err",
        "error",
        "401 unauthorized — API key not configured",
        None,
        None,
        None,
        None,
    )
    .unwrap();

    let messages = db.list_chat_messages("ws-err").unwrap();
    assert_eq!(messages.len(), 2);
    assert!(
        messages.iter().any(|m| m.role == "error"),
        "expected a row with role=error, got: {:?}",
        messages.iter().map(|m| &m.role).collect::<Vec<_>>()
    );
    let err_msg = messages.iter().find(|m| m.role == "error").unwrap();
    assert!(err_msg.content.contains("401 unauthorized"));
}
```

- [ ] **Step 2: Run the test to confirm it compiles and passes** (the DB has no role filter, so this should pass already)

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test insert_and_list_error_message -- --nocapture
```

Expected: `test workspace_tests::insert_and_list_error_message ... ok`

This test should pass without code changes — it confirms `list_chat_messages` does NOT filter by role. If it fails, check `db.rs::list_chat_messages` for a `WHERE role != 'error'` clause and remove it.

- [ ] **Step 3: Restructure `send_agentic` to capture the loop result and persist error**

In `src-tauri/src/chat_engine.rs`, find the `send_agentic` method. The user message INSERT is at the top (lines ~351–357). The agentic loop starts at line ~426. Currently the whole method has `?` propagation throughout.

Replace the entire body of `send_agentic` from the line `// ─── Agentic loop ─────────────────────────────────────────` through the final `Err(AppError::Other(...))` with a block that captures the result:

Find this at the end of `send_agentic` (around line 593):

```rust
        Err(AppError::Other(format!(
            "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
        )))
    }
}
```

Replace the entire bottom of `send_agentic` — specifically, wrap the section starting from the agentic loop through the end in a result-capture block. Here is the **complete replacement for `send_agentic`** (only the bottom half changes; the top half through `let tools = build_llm_tools();` and `let mut total_input/output` is untouched):

Find this exact block (the agentic loop sentinel at the very end of `send_agentic`):

```rust
        Err(AppError::Other(format!(
            "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
        )))
    }
}
```

Replace it with:

```rust
        let loop_err = AppError::Other(format!(
            "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
        ));
        // Persist the error so it survives a relaunch.
        let error_text = format!("{loop_err}");
        if let Err(persist_err) = self.insert_and_emit_message(
            &app,
            &request.workspace_id,
            "error",
            &error_text,
            None, None, None, None,
        ) {
            tracing::error!(error = %persist_err, "failed to persist error message");
        }
        Err(loop_err)
    }
}
```

Also, find the `?` that propagates provider errors (the `provider.complete(...)` call, line ~436):

```rust
            let response = provider
                .complete(&api_base, api_key.as_deref(), &llm_req, &self.client)
                .await?;
```

Change it to capture errors and persist before returning:

```rust
            let response = match provider
                .complete(&api_base, api_key.as_deref(), &llm_req, &self.client)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let error_text = format!("{e}");
                    if let Err(persist_err) = self.insert_and_emit_message(
                        &app,
                        &request.workspace_id,
                        "error",
                        &error_text,
                        None, None, None, None,
                    ) {
                        tracing::error!(error = %persist_err, "failed to persist error message");
                    }
                    return Err(e);
                }
            };
```

- [ ] **Step 4: Run the Rust test suite to confirm no regressions**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test
```

Expected: all tests pass including `insert_and_list_error_message`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src-tauri/src/chat_engine.rs src-tauri/src/tests.rs
git commit -m "feat(chat/backend): persist error rows to DB on agentic loop failure"
```

---

## Task 2: Frontend types — widen `ChatMessage.role`

**Files:**
- Modify: `src/lib/types.ts` (line 143)

The current `ChatMessage` interface has `role: "user" | "assistant"`. We need to add `"error"` and `"tool"` (tool is already handled implicitly via `as "user" | "assistant"` casts in test files; widening to `string` is the simplest and most future-proof approach).

- [ ] **Step 1: Widen the role type**

In `src/lib/types.ts`, find:

```typescript
export interface ChatMessage {
  id: number;
  workspaceId: string;
  role: "user" | "assistant";
```

Replace with:

```typescript
export interface ChatMessage {
  id: number;
  workspaceId: string;
  role: "user" | "assistant" | "tool" | "error";
```

- [ ] **Step 2: Remove `as "user" | "assistant"` casts in test files** (they were workarounds for the narrow type)

In `src/components/ChatView.test.tsx`, find all occurrences of `role: "tool" as "user" | "assistant"` and replace with `role: "tool"`.

There are 4 occurrences (lines ~84, 234, 243, 252 approximately). Use search-and-replace:

```
role: "tool" as "user" | "assistant"
```
→
```
role: "tool"
```

In `src/stores/chatStore.test.ts` — same search (no occurrences expected, but verify).

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/lib/types.ts src/components/ChatView.test.tsx
git commit -m "refactor(types): widen ChatMessage.role to include tool and error roles"
```

---

## Task 3: Frontend store — add `"error"` kind to ConversationItem and emit to messagesByWs

**Files:**
- Modify: `src/stores/chatStore.ts`

Two changes:
1. Add `{ kind: "error"; message: ChatMessage }` to the `ConversationItem` union.
2. In `getTimeline`, add a branch for `role === "error"` that emits `{ kind: "error", message: msg }`.
3. In `send`'s catch block, also write the error into `messagesByWs` as a synthetic `ChatMessage` — BUT actually, this is NOT needed if the backend now emits `chat://message-added` with `role="error"`. The live event listener already appends all messages to `messagesByWs`. So the only change in `send` is retaining the existing `errorByWs` write for the transient banner (no change needed there).

- [ ] **Step 1: Extend `ConversationItem` and `getTimeline` in chatStore**

In `src/stores/chatStore.ts`, find:

```typescript
/** A display item in the conversation — either a regular message or a tool execution. */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; tool: ToolExecution; id: number };
```

Replace with:

```typescript
/** A display item in the conversation — either a regular message, tool execution, or persisted error. */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; tool: ToolExecution; id: number }
  | { kind: "error"; message: ChatMessage };
```

- [ ] **Step 2: Update `getTimeline` to handle `role === "error"`**

In `src/stores/chatStore.ts`, find the `getTimeline` function body:

```typescript
    getTimeline: (workspaceId) => {
      const msgs = get().messagesByWs[workspaceId];
      if (!msgs || msgs.length === 0) return EMPTY_TIMELINE;
      const items: ConversationItem[] = [];
      for (const msg of msgs) {
        const role = msg.role as string;
        if (role === "tool") {
          try {
            const tool: ToolExecution = JSON.parse(msg.content);
            items.push({ kind: "tool", tool, id: msg.id });
          } catch {
            items.push({ kind: "message", message: msg });
          }
        } else {
          items.push({ kind: "message", message: msg });
        }
      }
      return items;
    },
```

Replace with:

```typescript
    getTimeline: (workspaceId) => {
      const msgs = get().messagesByWs[workspaceId];
      if (!msgs || msgs.length === 0) return EMPTY_TIMELINE;
      const items: ConversationItem[] = [];
      for (const msg of msgs) {
        const role = msg.role as string;
        if (role === "tool") {
          try {
            const tool: ToolExecution = JSON.parse(msg.content);
            items.push({ kind: "tool", tool, id: msg.id });
          } catch {
            items.push({ kind: "message", message: msg });
          }
        } else if (role === "error") {
          items.push({ kind: "error", message: msg });
        } else {
          items.push({ kind: "message", message: msg });
        }
      }
      return items;
    },
```

Also apply the same change to the **duplicate `timeline` useMemo** in `ChatView.tsx` (lines 33–49), which mirrors `getTimeline`. (Done in Task 4.)

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/stores/chatStore.ts
git commit -m "feat(chat/store): add error kind to ConversationItem and timeline"
```

---

## Task 4: Frontend render — wire ErrorBlock to `kind === "error"` in timeline

**Files:**
- Modify: `src/components/ChatView.tsx`

Two changes:
1. The `timeline` useMemo in ChatView mirrors `getTimeline`. Add the `role === "error"` branch there too.
2. In the render section, handle `item.kind === "error"` items by rendering `<ErrorBlock>`.

- [ ] **Step 1: Add `role === "error"` branch to the local `timeline` useMemo**

In `src/components/ChatView.tsx`, find:

```typescript
  const timeline = useMemo<ConversationItem[]>(() => {
    const items: ConversationItem[] = [];
    for (const msg of messages) {
      const role = msg.role as string;
      if (role === "tool") {
        try {
          const tool: ToolExecution = JSON.parse(msg.content);
          items.push({ kind: "tool", tool, id: msg.id });
        } catch {
          items.push({ kind: "message", message: msg });
        }
      } else {
        items.push({ kind: "message", message: msg });
      }
    }
    return items;
  }, [messages]);
```

Replace with:

```typescript
  const timeline = useMemo<ConversationItem[]>(() => {
    const items: ConversationItem[] = [];
    for (const msg of messages) {
      const role = msg.role as string;
      if (role === "tool") {
        try {
          const tool: ToolExecution = JSON.parse(msg.content);
          items.push({ kind: "tool", tool, id: msg.id });
        } catch {
          items.push({ kind: "message", message: msg });
        }
      } else if (role === "error") {
        items.push({ kind: "error", message: msg });
      } else {
        items.push({ kind: "message", message: msg });
      }
    }
    return items;
  }, [messages]);
```

- [ ] **Step 2: Add `kind === "error"` case to the timeline render**

In `src/components/ChatView.tsx`, find the timeline render section:

```typescript
            {timeline.map((item) =>
              item.kind === "tool" ? (
                <ToolCallCard
                  key={`tool-${item.id}`}
                  tool={item.tool}
                  workspacePath={workspacePath}
                />
              ) : (
                <ChatMessage key={item.message.id} message={item.message} />
              ),
            )}
```

Replace with:

```typescript
            {timeline.map((item) => {
              if (item.kind === "tool") {
                return (
                  <ToolCallCard
                    key={`tool-${item.id}`}
                    tool={item.tool}
                    workspacePath={workspacePath}
                  />
                );
              }
              if (item.kind === "error") {
                return (
                  <ErrorBlock
                    key={`error-${item.message.id}`}
                    error={item.message.content}
                    onConfigureApiKey={
                      onOpenSettings
                        ? () => {
                            onOpenSettings();
                          }
                        : null
                    }
                  />
                );
              }
              return <ChatMessage key={item.message.id} message={item.message} />;
            })}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/ChatView.tsx
git commit -m "feat(chat/ui): render persisted error rows via ErrorBlock in timeline"
```

---

## Task 5: Frontend tests

**Files:**
- Modify: `src/components/ChatView.test.tsx`
- Modify: `src/stores/chatStore.test.ts`

### ChatView test: error row renders ErrorBlock

- [ ] **Step 1: Add the test to `ChatView.test.tsx`**

Inside the `describe("ChatView — renders tool cards in the DOM", ...)` block, add a new test after the last existing test:

```typescript
  it("renders persisted error rows as ErrorBlock in the timeline", async () => {
    // Simulates a workspace loaded after relaunch where a prior turn failed.
    // The DB returned a role="error" row alongside the user message.
    const historicRows = [
      {
        id: 1,
        workspaceId: "ws-1",
        role: "user",
        content: "Tell me a secret.",
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: "2026-05-17T10:00:00Z",
      },
      {
        id: 2,
        workspaceId: "ws-1",
        role: "error",
        content: "Anthropic API key not configured. Open Settings · Models & Providers.",
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: "2026-05-17T10:00:01Z",
      },
    ];
    listChatMessagesMock.mockResolvedValueOnce(historicRows);

    render(<ChatView workspaceId="ws-1" workspacePath="/tmp" onOpenSettings={() => {}} />);
    // Wait for loadHistory to resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The error content should appear in the DOM via ErrorBlock.
    expect(screen.getByText(/API key not configured/i)).toBeInTheDocument();
    // The "Something went wrong." heading from ErrorBlock.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    // Since content includes "API key" and onOpenSettings is provided, the button appears.
    expect(screen.getByText(/Configure API key/i)).toBeInTheDocument();
    // User message still renders.
    expect(screen.getByText("Tell me a secret.")).toBeInTheDocument();
  });
```

### chatStore test: error event written to messagesByWs via live event

- [ ] **Step 2: Add the test to `chatStore.test.ts`**

Inside the `describe("chatStore — single workspace tool-card persistence", ...)` block, add after the last existing test:

```typescript
  it("error message received via chat://message-added is stored in messagesByWs", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "hi" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "error",
      content: "401 unauthorized — API key not configured",
    }));

    const messages = useChatStore.getState().getMessages("ws-1");
    expect(messages).toHaveLength(2);
    const errMsg = messages.find((m) => (m.role as string) === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toContain("API key not configured");
  });

  it("getTimeline emits an error kind for role=error messages", () => {
    emit("chat://message-added", makeMsg({ id: 1, role: "user", content: "go" }));
    emit("chat://message-added", makeMsg({
      id: 2,
      role: "error",
      content: "Network timeout",
    }));

    const timeline = useChatStore.getState().getTimeline("ws-1");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].kind).toBe("message");
    expect(timeline[1].kind).toBe("error");
    if (timeline[1].kind === "error") {
      expect(timeline[1].message.content).toBe("Network timeout");
    }
  });
```

- [ ] **Step 3: Run the frontend tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test
```

Expected: all tests pass (including the 2 new chatStore tests and 1 new ChatView test).

- [ ] **Step 4: Commit**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git add src/components/ChatView.test.tsx src/stores/chatStore.test.ts
git commit -m "test(chat): add tests for error row persistence and timeline rendering"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run frontend tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run Rust tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh/src-tauri && cargo test
```

Expected: all tests pass.

- [ ] **Step 4: Self-review checklist**

- [ ] Errors hit DB on failure with `role="error"` (both `provider.complete` failures and max-iterations sentinel)?
- [ ] `list_chat_messages` returns error rows without filtering?
- [ ] Frontend `getTimeline` / local `timeline` useMemo both handle `role === "error"` → `kind === "error"`?
- [ ] `ErrorBlock` renders from timeline items (not just from `errorByWs`) — errors survive relaunch?
- [ ] Hot path: `insert_and_emit_message` emits `chat://message-added` with `role="error"`, so the live session sees the error immediately in the scroll history?
- [ ] `errorByWs` transient banner still works (the `catch` in `send` still writes to `errorByWs`, giving the floating error banner while streaming)?
- [ ] `npm run typecheck` passes?
- [ ] All existing tests still pass?

---

## Design notes

**Dual tracking decision:** The `errorByWs` transient slice is KEPT. It powers the floating error banner at the bottom of the chat timeline (the one with the "Configure API key" button that appears during/immediately after a failed turn). The persisted `role="error"` row in `messagesByWs` powers the durable chronological record. Both are desirable: the banner gives immediate feedback in the active session; the persisted row survives relaunch.

**No `clearError` call on persisted errors:** The `clearError` action only clears `errorByWs`. It does not touch `messagesByWs`. This is correct — you should not be able to "dismiss" a persisted error from history.

**ErrorBlock in timeline vs banner:** When rendering a `kind === "error"` item from the timeline, the `onConfigureApiKey` handler does NOT call `clearError` (unlike the live banner handler at line 134–136 of `ChatView.tsx`) because there's nothing to clear in `errorByWs` for a historical error. The Settings modal still opens via `onOpenSettings`.
