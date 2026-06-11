/**
 * GitOpsMenu — the quiet "Branches & more" menu in the ChangesPanel header
 * (G7 slices IV/V). One GitBranch icon button opens a MenuSurface with:
 * current-branch header → local branch list (click to switch; the current
 * one is checked; a branch checked out in another workspace errors friendly
 * — workspaces are worktrees) → create branch → stash push / stash browser
 * → clean untracked (confirm-gated, danger-styled).
 *
 * Reset / cherry-pick / tag live contextually in the HistoryModal's commit
 * rows instead — they act on a specific commit, not on the workspace.
 */

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Check, Eraser, GitBranch, Loader2, Plus, Trash2 } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { StashInfo } from "../lib/ipc";
import { formatRelTime } from "../lib/relTime";
import { pushToast } from "./Toasts";
import { MenuSurface } from "./MenuSurface";
import { MENU_DANGER, MENU_HEADER, MENU_ITEM, MENU_SEP } from "../lib/menuStyles";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileNameDialog } from "./FileNameDialog";

interface Props {
  projectPath: string;
  /** Current branch name, or null (detached / not a repo yet). */
  branch: string | null;
  /** Working tree has any change — enables "Stash changes…". */
  dirty: boolean;
  /** Count of untracked files — gates "Clean untracked…". */
  untrackedCount: number;
  /** Called after any successful mutation so the parent refreshes status. */
  onChanged: () => void;
}

type DialogKind = null | "createBranch" | "stashMessage" | "stashes" | "clean";

function validateRefName(kind: string): (name: string) => string | null {
  return (name: string) => {
    if (name === "") return `${kind} name is required.`;
    if (/\s/.test(name)) return `${kind} names cannot contain spaces.`;
    if (name.startsWith("-")) return `${kind} names cannot start with a dash.`;
    if (name.includes("..")) return `${kind} names cannot contain "..".`;
    return null;
  };
}

export function GitOpsMenu({ projectPath, branch, dirty, untrackedCount, onChanged }: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);

  async function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAt({ x: rect.left, y: rect.bottom + 4 });
    try {
      const list = await ipc.listBranches(projectPath);
      setBranches(list.local);
    } catch {
      setBranches(branch ? [branch] : []);
    }
  }

  async function switchTo(name: string) {
    setMenuAt(null);
    if (name === branch) return;
    setBusy(true);
    try {
      await ipc.switchBranch(projectPath, name);
      pushToast({ level: "success", title: "Switched branch", body: name });
      onChanged();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't switch branch", body: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function createBranch(name: string) {
    setDialog(null);
    if (!branch) return;
    setBusy(true);
    try {
      await ipc.createAndSwitchBranch(projectPath, name, branch);
      pushToast({ level: "success", title: "Branch created", body: `${name} — off ${branch}` });
      onChanged();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't create branch", body: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function stashWith(message: string) {
    setDialog(null);
    setBusy(true);
    try {
      await ipc.stashPush(projectPath, message);
      pushToast({ level: "success", title: "Changes stashed", body: message || undefined });
      onChanged();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't stash changes", body: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmClean() {
    setDialog(null);
    setBusy(true);
    try {
      const removed = await ipc.cleanUntracked(projectPath);
      pushToast({
        level: "success",
        title: "Cleaned untracked files",
        body: `Removed ${removed.length} item${removed.length !== 1 ? "s" : ""}.`,
      });
      onChanged();
    } catch (e) {
      pushToast({ level: "error", title: "Clean failed", body: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => void openMenu(e)}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        title="Branches & more"
        aria-label="Branches & more"
        className="flex items-center justify-center rounded p-1 text-octo-sage transition-colors hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
      </button>

      {menuAt && (
        <MenuSurface x={menuAt.x} y={menuAt.y} ariaLabel="Branches & more" onDismiss={() => setMenuAt(null)} widthClass="w-[248px]">
          <div className={MENU_HEADER} title={branch ?? undefined}>
            {branch ?? "no branch"}
          </div>
          <div className="max-h-[36vh] overflow-y-auto">
            {branches.map((b) => (
              <button
                key={b}
                type="button"
                role="menuitem"
                title={b === branch ? `${b} — current branch` : `Switch to ${b}`}
                onClick={() => void switchTo(b)}
                className={`${MENU_ITEM} ${b === branch ? "text-octo-brass" : ""}`}
              >
                <span className="flex w-3 shrink-0 items-center justify-center">
                  {b === branch && <Check size={12} className="text-octo-brass" />}
                </span>
                <span className="truncate">{b}</span>
              </button>
            ))}
          </div>
          {branch && (
            <button
              type="button"
              role="menuitem"
              title={`Create a new branch off ${branch} and switch to it`}
              onClick={() => {
                setMenuAt(null);
                setDialog("createBranch");
              }}
              className={MENU_ITEM}
            >
              <Plus size={12} className="shrink-0" />
              Create branch…
            </button>
          )}
          <div role="separator" className={MENU_SEP} />
          <button
            type="button"
            role="menuitem"
            disabled={!dirty}
            title={dirty ? "Stash the working tree (untracked included)" : "Nothing to stash — the working tree is clean"}
            onClick={() => {
              setMenuAt(null);
              setDialog("stashMessage");
            }}
            className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Archive size={12} className="shrink-0" />
            Stash changes…
          </button>
          <button
            type="button"
            role="menuitem"
            title="Browse, pop or drop stashed changes"
            onClick={() => {
              setMenuAt(null);
              setDialog("stashes");
            }}
            className={MENU_ITEM}
          >
            <ArchiveRestore size={12} className="shrink-0" />
            Stashes…
          </button>
          <div role="separator" className={MENU_SEP} />
          <button
            type="button"
            role="menuitem"
            disabled={untrackedCount === 0}
            title={
              untrackedCount === 0
                ? "No untracked files to clean"
                : `Delete ${untrackedCount} untracked file${untrackedCount !== 1 ? "s" : ""} (git clean -fd)`
            }
            onClick={() => {
              setMenuAt(null);
              setDialog("clean");
            }}
            className={`${MENU_DANGER} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Eraser size={12} className="shrink-0" />
            Clean untracked…
          </button>
        </MenuSurface>
      )}

      {dialog === "createBranch" && (
        <FileNameDialog
          title="New branch"
          label="Branch name"
          confirmLabel="Create"
          validate={validateRefName("Branch")}
          onSubmit={(name) => void createBranch(name)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "stashMessage" && (
        <FileNameDialog
          title="Stash changes"
          label="Stash message"
          confirmLabel="Stash"
          validate={() => null}
          onSubmit={(msg) => void stashWith(msg)}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "stashes" && (
        <StashesModal projectPath={projectPath} onChanged={onChanged} onClose={() => setDialog(null)} />
      )}

      {dialog === "clean" && (
        <ConfirmDialog
          title="Clean untracked files"
          body={`Permanently delete ${untrackedCount} untracked file${untrackedCount !== 1 ? "s" : ""} and any untracked directories (git clean -fd)? This can't be undone.`}
          destructiveLabel="Clean"
          cancelLabel="Cancel"
          onConfirm={confirmClean}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  );
}

// ─── Stash browser ─────────────────────────────────────────────────

function StashesModal({
  projectPath,
  onChanged,
  onClose,
}: {
  projectPath: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [stashes, setStashes] = useState<StashInfo[] | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<StashInfo | null>(null);

  async function reload() {
    try {
      setStashes(await ipc.stashList(projectPath));
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't load stashes", body: String(e) });
      setStashes([]);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  async function pop(s: StashInfo) {
    setBusyIndex(s.index);
    try {
      await ipc.stashPop(projectPath, s.index);
      pushToast({ level: "success", title: "Stash popped", body: s.message });
      onChanged();
      await reload();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't pop the stash", body: String(e) });
      onChanged(); // a conflicted apply still changes the tree
      await reload();
    } finally {
      setBusyIndex(null);
    }
  }

  async function confirmDrop() {
    const s = dropTarget;
    setDropTarget(null);
    if (!s) return;
    setBusyIndex(s.index);
    try {
      await ipc.stashDrop(projectPath, s.index);
      pushToast({ level: "success", title: "Stash dropped", body: s.message });
      await reload();
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't drop the stash", body: String(e) });
    } finally {
      setBusyIndex(null);
    }
  }

  return (
    <>
      <ModalShell onClose={onClose} ariaLabel="Stashes" panelClassName="w-[480px] max-w-[92vw]">
        <div className="flex max-h-[60vh] flex-col overflow-hidden rounded-lg border border-octo-hairline bg-octo-panel">
          <header className="flex h-11 shrink-0 items-center gap-3 border-b border-octo-hairline px-4">
            <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Stashes</span>
            {stashes !== null && stashes.length > 0 && (
              <span className="font-mono text-[10px] text-octo-mute">{stashes.length}</span>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {stashes === null ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={14} className="animate-spin text-octo-mute" />
              </div>
            ) : stashes.length === 0 ? (
              <div className="px-4 py-8 text-center font-serif text-[13px] text-octo-mute">
                Nothing stashed away.
              </div>
            ) : (
              <ul>
                {stashes.map((s) => (
                  <li
                    key={s.index}
                    className="octo-rise-in group flex items-center gap-2 border-b border-octo-hairline/60 px-4 py-2 last:border-b-0 hover:bg-octo-panel-2"
                  >
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: "var(--brass-dim)" }}>
                      {`{${s.index}}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-octo-ivory" title={s.message}>
                      {s.message}
                    </span>
                    <span className="shrink-0 font-mono text-[9.5px] text-octo-mute">
                      {formatRelTime(s.timestampMs)}
                    </span>
                    <button
                      type="button"
                      disabled={busyIndex !== null}
                      title="Pop — apply this stash and remove it from the stack"
                      aria-label={`Pop stash ${s.index}`}
                      onClick={() => void pop(s)}
                      className="shrink-0 rounded p-1 text-octo-sage transition-colors hover:text-octo-brass disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                    >
                      {busyIndex === s.index ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <ArchiveRestore size={12} />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={busyIndex !== null}
                      title="Drop — discard this stash without applying it"
                      aria-label={`Drop stash ${s.index}`}
                      onClick={() => setDropTarget(s)}
                      className="shrink-0 rounded p-1 text-octo-sage transition-colors hover:text-octo-rouge disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ModalShell>

      {dropTarget && (
        <ConfirmDialog
          title="Drop stash"
          body={`Discard "${dropTarget.message}" without applying it? This can't be undone.`}
          destructiveLabel="Drop"
          cancelLabel="Cancel"
          onConfirm={confirmDrop}
          onCancel={() => setDropTarget(null)}
        />
      )}
    </>
  );
}
