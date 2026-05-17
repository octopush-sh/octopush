import { useEffect, useState } from "react";
import { BrassRule } from "./BrassRule";
import { useProjectStore } from "../stores/projectStore";
import type { ProjectInfo } from "../lib/types";

interface Props {
  onNewProject: () => void;
}

export function WelcomeScreen({ onNewProject }: Props) {
  const { open, loadRecent, recent, loading, error } = useProjectStore();
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathValue, setPathValue] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

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
      {/* Mark */}
      <div
        aria-hidden
        className="relative flex h-14 w-14 items-center justify-center rounded-full font-serif italic text-[26px] text-octo-brass"
        style={{ border: "1px solid var(--brass-dim)" }}
      >
        O
        <span
          className="absolute -inset-2 rounded-full"
          style={{ border: "1px solid rgba(212, 165, 116, 0.15)" }}
        />
      </div>

      {/* Logo */}
      <h1 className="mt-6 font-serif italic text-[32px] leading-[1.05] tracking-[-0.01em] text-octo-ivory">
        Octopus<span className="px-1.5 text-octo-brass">&amp;</span>you
      </h1>

      {/* Tagline */}
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.35em] text-octo-mute">
        eight arms · one mind
      </div>

      {/* Brass rule */}
      <BrassRule className="my-6 w-7" />

      {/* Primary CTA */}
      <button
        type="button"
        onClick={onNewProject}
        className="rounded-md px-5 py-2.5 font-serif italic text-[14px] text-octo-brass transition"
        style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
      >
        Begin a new study
      </button>

      {/* Or — open existing */}
      <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
        or
      </div>

      {/* Drop / open path */}
      {!showPathInput ? (
        <div className="mt-3 text-center text-[12px] leading-[1.6] text-octo-sage">
          <span>Drop a folder, or </span>
          <button
            type="button"
            onClick={handleOpenClick}
            className="font-serif italic text-octo-ivory underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
          >
            open one from disk
          </button>
        </div>
      ) : (
        <div className="mt-3 flex w-72 items-center gap-2">
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
          className="mt-4 max-w-md rounded-md px-3 py-2 text-[12px] text-octo-rouge"
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

      {/* Recent projects */}
      {recent.length > 0 && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
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
                    className="flex h-7 w-7 items-center justify-center rounded-md font-serif italic text-[14px] text-octo-brass"
                    style={{
                      background: "var(--brass-ghost)",
                      border: "1px solid var(--brass-dim)",
                    }}
                  >
                    {project.name.charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="font-serif italic text-[13px] text-octo-ivory">
                    {project.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
