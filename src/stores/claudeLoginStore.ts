import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc, type ClaudeLoginExpiry } from "../lib/ipc";
import { LOGIN_EVENT } from "../lib/claudeLogin";

/** When the claude.ai sign-in ends (`get_claude_login`), re-read whenever a
 *  stage reports it. Detached runs write it from the worker, so the note
 *  also reloads each time it mounts. */
interface ClaudeLoginState {
  login: ClaudeLoginExpiry | null;
  load: () => Promise<void>;
}

export const useClaudeLoginStore = create<ClaudeLoginState>((set) => ({
  login: null,
  load: async () => {
    try {
      const l = await ipc.getClaudeLogin();
      set({ login: l && typeof l.expiresAt === "number" ? l : null });
    } catch {
      // Nothing known is nothing shown.
    }
  },
}));

// Deferred and guarded: outside Tauri (tests, the clip harness) there is no
// event bus, and the note just keeps its last loaded state.
void Promise.resolve()
  .then(() => listen(LOGIN_EVENT, () => void useClaudeLoginStore.getState().load()))
  .catch(() => {});
