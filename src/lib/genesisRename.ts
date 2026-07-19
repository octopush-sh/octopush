import { listen } from "@tauri-apps/api/event";
import { RUN_EVENTS, ipc, type Run } from "./ipc";
import { deriveProjectName } from "./genesis";
import { pushToast } from "../components/Toasts";
import { useProjectStore } from "../stores/projectStore";

// Post-build rename (genesis G6): once a prompt-born project's FIRST crew ships,
// the project knows what it built — the anonymous heuristic slug can become the
// real thing. One quiet, one-shot suggestion; never automatic, never on a
// project-first project.

const RENAME_MODEL = "claude-haiku-4-5";
const NAME_SYSTEM =
  "You name software projects. Given a build brief, reply with ONLY a short " +
  "kebab-case project name of 1-3 words (lowercase, hyphens, no punctuation, no " +
  "explanation). Example: 'a CLI to track daily tasks in JSON' -> 'task-tracker'.";

let initialized = false;
const lastStatus = new Map<string, string>();
// Guards against a duplicate offer while the async name-generation is in flight
// for a workspace (two quick completions before the backend one-shot marker set).
const offering = new Set<string>();

/** Normalize an AI-suggested name to a safe kebab slug, PRESERVING hyphens
 *  (unlike `deriveProjectName`, which is prompt-oriented and strips them). */
function slugifyName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Suggest a project name from the brief via a brief BYOK call; fall back to the
 *  local heuristic slug if the call fails or returns junk. */
async function suggestName(prompt: string, workspaceId: string): Promise<string> {
  try {
    const res = await ipc.aiComplete(RENAME_MODEL, NAME_SYSTEM, prompt, {
      maxTokens: 24,
      workspaceId,
    });
    const cleaned = slugifyName(res.text);
    if (cleaned) return cleaned;
  } catch {
    /* fall through */
  }
  return deriveProjectName(prompt);
}

/** Exported for tests. The core: given a completed run, offer a one-shot rename
 *  if its project is a genesis candidate. */
export async function maybeOffer(run: Run): Promise<void> {
  const wsId = run.workspaceId;
  if (offering.has(wsId)) return;
  offering.add(wsId);
  try {
    const candidate = await ipc.genesisRenameCandidate(wsId);
    if (!candidate) return; // not a genesis project, or already offered
    const suggested = await suggestName(candidate.prompt, wsId);
    // Mark offered NOW (accept or dismiss both retire it) so it never repeats.
    await ipc.markGenesisRenamed(candidate.projectId);
    pushToast({
      level: "info",
      title: "Name this project?",
      body: `Your crew built it. Rename it to "${suggested}"?`,
      timeout: 15000,
      action: {
        label: `Rename to ${suggested}`,
        onClick: () => {
          void ipc
            .updateProjectCustomization(candidate.projectId, suggested, null)
            .then(() => {
              // Reflect the rename in the open project + recent list.
              const cur = useProjectStore.getState().current;
              if (cur?.id === candidate.projectId) {
                useProjectStore.setState({ current: { ...cur, name: suggested } });
              }
              void useProjectStore.getState().loadRecent();
            })
            .catch(() => pushToast({ level: "error", title: "Couldn't rename the project" }));
        },
      },
    });
  } catch {
    /* best-effort — a rename suggestion never disrupts the run */
  } finally {
    offering.delete(wsId);
  }
}

/** Wire the run-completion listener once (App calls this on mount; idempotent). */
export function initGenesisRename(): void {
  if (initialized) return;
  initialized = true;
  void listen<{ runId: string; run: Run }>(RUN_EVENTS.stageUpdate, (ev) => {
    const run = ev.payload.run;
    const prev = lastStatus.get(run.id);
    lastStatus.set(run.id, run.status);
    if (lastStatus.size > 1000) lastStatus.clear();
    // The first time this run reaches completed.
    if (prev !== "completed" && run.status === "completed") {
      void maybeOffer(run);
    }
  });
}

/** Test hook. */
export function __resetGenesisRenameForTests(): void {
  lastStatus.clear();
  offering.clear();
  initialized = false;
}
