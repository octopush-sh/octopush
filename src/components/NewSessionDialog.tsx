import { useState, useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_ROOT = "~";

const ICONS = ["🐙", "🏦", "🔧", "🧠", "📊", "🚀", "🛠️", "⚡", "🔬", "🎯"];
const COLORS = [
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#60a5fa",
  "#c084fc",
  "#f472b6",
];

export function NewSessionDialog({ open, onClose }: Props) {
  const create = useSessionStore((s) => s.create);
  const [name, setName] = useState("");
  const [projectRoot, setProjectRoot] = useState(DEFAULT_ROOT);
  const [icon, setIcon] = useState(ICONS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setProjectRoot(DEFAULT_ROOT);
      setIcon(ICONS[0]);
      setColor(COLORS[0]);
      setTagsInput("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const expanded = projectRoot.startsWith("~/")
        ? projectRoot // backend doesn't expand ~; leave as-is for Phase 1
        : projectRoot;
      await create({
        name: name.trim(),
        projectRoot: expanded,
        icon,
        color,
        tags: tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[440px] rounded-xl border border-octo-border bg-octo-panel p-6 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold tracking-tight">
          New session
        </h2>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">
            Name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="salda-backend-refactor"
            className="w-full rounded-md border border-octo-border bg-octo-bg px-3 py-2 text-sm font-mono outline-none focus:border-octo-accent"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">
            Project root
          </span>
          <input
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            placeholder="/Users/you/projects/xxx"
            className="w-full rounded-md border border-octo-border bg-octo-bg px-3 py-2 text-sm font-mono outline-none focus:border-octo-accent"
          />
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">
              Icon
            </div>
            <div className="flex flex-wrap gap-1">
              {ICONS.map((i) => (
                <button
                  type="button"
                  key={i}
                  onClick={() => setIcon(i)}
                  className={`h-8 w-8 rounded-md border text-lg transition ${
                    icon === i
                      ? "border-octo-accent bg-octo-accent/10"
                      : "border-octo-border hover:border-zinc-600"
                  }`}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">
              Color
            </div>
            <div className="flex flex-wrap gap-1">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={`h-8 w-8 rounded-md border transition ${
                    color === c ? "border-white" : "border-transparent"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">
            Tags <span className="text-zinc-600">(comma-separated)</span>
          </span>
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="backend, refactor"
            className="w-full rounded-md border border-octo-border bg-octo-bg px-3 py-2 text-sm outline-none focus:border-octo-accent"
          />
        </label>

        {error && (
          <div className="mb-3 rounded-md border border-octo-danger/40 bg-octo-danger/10 px-3 py-2 text-xs text-octo-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-octo-accent px-4 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-octo-accent-dim disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
