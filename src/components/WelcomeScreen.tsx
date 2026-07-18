import { useEffect, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import type { ProjectInfo } from "../lib/types";
import { OctoMark } from "./icons/OctoMark";
import { GenesisPrompt } from "./GenesisPrompt";

interface Props {
  onNewProject: () => void;
  /** Prompt genesis: describe what to build → a project is born + a crew is
   *  staged. `name` is the (editable) derived slug. */
  onGenesis: (prompt: string, name: string, model: string | null) => void;
}

export function WelcomeScreen({ onNewProject, onGenesis }: Props) {
  const { open, loadRecent, recent, loading, error, closed, loadClosed } = useProjectStore();
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathValue, setPathValue] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    loadRecent();
    loadClosed();
  }, [loadRecent, loadClosed]);

  function handleOpenClick() {
    setShowPathInput(true);
    setPathValue("");
  }

  function handleConfirmPath() {
    const trimmed = pathValue.trim();
    if (!trimmed) return;
    open(trimmed);
  }

  function handlePathKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirmPath();
    if (e.key === "Escape") {
      setShowPathInput(false);
      setPathValue("");
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.items);
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          const path = (file as File & { path?: string }).path;
          if (path) {
            open(path);
            return;
          }
        }
      }
    }
    setShowPathInput(true);
  }

  return (
    <div
      data-tauri-drag-region
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex h-full w-full flex-col items-center justify-center bg-octo-bg px-6"
      style={{
        background:
          "radial-gradient(ellipse at center top, rgba(212,165,116,0.06), transparent 55%), var(--color-octo-onyx)",
      }}
    >
      {/* Mark — The Octo, idling. Matches the app icon; rendered as SVG so
          it sharps at every DPI without a separate asset. */}
      <OctoMark size={116} state="idle" />

      {/* Wordmark */}
      <h1 className="brand-wordmark mt-6 text-[32px] leading-[1.05] text-octo-ivory">
        Octopush
      </h1>

      {/* Tagline */}
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.35em] text-octo-mute">
        an atelier for agentic developers
      </div>

      {/* ⊕ Genesis — describe what you want to build; a crew scaffolds it.
          The project is born from the prompt (intent before the repo). */}
      <div className="mt-8 w-full max-w-[560px]">
        <GenesisPrompt loading={loading} onSubmit={(p, n, model) => onGenesis(p, n, model)} />
      </div>

      {/* Or — start from a repo instead (project-first, unchanged). */}
      <div className="mt-6 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
        or
      </div>

      {/* Begin a new study · drop / open path */}
      {!showPathInput ? (
        <div className="mt-3 text-center text-[12px] leading-[1.6] text-octo-sage">
          <button
            type="button"
            onClick={onNewProject}
            className="font-serif text-octo-ivory underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
          >
            Begin a new study
          </button>
          <span>, drop a folder, or </span>
          <button
            type="button"
            onClick={handleOpenClick}
            className="font-serif text-octo-ivory underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
          >
            open one from disk
          </button>
        </div>
      ) : (
        <div className="mt-3 flex w-72 items-center gap-2 octo-fade-in">
          <input
            autoFocus
            value={pathValue}
            onChange={(e) => setPathValue(e.target.value)}
            onKeyDown={handlePathKeyDown}
            placeholder="/path/to/project"
            className="min-w-0 flex-1 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
          />
          <button
            type="button"
            onClick={handleConfirmPath}
            disabled={!pathValue.trim() || loading}
            className="rounded-md px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass disabled:opacity-40"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => { setShowPathInput(false); setPathValue(""); }}
            className="px-2 py-2 text-[12px] text-octo-mute hover:text-octo-sage"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="mt-4 max-w-md rounded-md px-3 py-2 text-[12px] text-octo-rouge octo-fade-in"
          style={{ borderLeft: "1px solid var(--color-octo-rouge)", background: "rgba(209, 139, 139, 0.08)" }}
        >
          {error}
        </div>
      )}

      {/* Dropzone hint when dragging */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-8 rounded-2xl"
          style={{ border: "1px dashed var(--brass-dim)", background: "rgba(212, 165, 116, 0.04)" }}
        />
      )}

      {/* Recent + Recently closed, stacked at the foot */}
      {(recent.length > 0 || closed.length > 0) && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-5 octo-rise-in">
          {recent.length > 0 && (
            <div>
              <div className="mb-3 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                Recent
              </div>
              <ul className="flex items-stretch gap-3">
                {recent.slice(0, 5).map((project: ProjectInfo) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => open(project.path)}
                      className="flex items-center gap-2.5 rounded-md px-3 py-2 transition hover:bg-octo-panel"
                      title={project.path}
                    >
                      <span
                        className="flex h-7 w-7 items-center justify-center rounded-md font-serif text-[14px] text-octo-brass"
                        style={{
                          background: "var(--brass-ghost)",
                          border: "1px solid var(--brass-dim)",
                        }}
                      >
                        {project.name.charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="font-serif text-[13px] text-octo-ivory">
                        {project.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <div className="mb-2 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                ⟲ Recently closed
              </div>
              <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                {closed.slice(0, 5).map((project: ProjectInfo) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => open(project.path)}
                      className="font-mono text-[11px] text-octo-sage transition hover:text-octo-brass"
                      title={`Reopen ${project.path}`}
                    >
                      {project.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
