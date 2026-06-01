import { useEffect, useMemo, useRef, useState } from "react";
import type { Issue, StatusCategory } from "../lib/types";
import { ipc } from "../lib/ipc";

const STATUS_DOT: Record<StatusCategory, string> = {
  todo: "text-octo-mute",
  inProgress: "text-state-blue",
  done: "text-octo-verdigris",
  unknown: "text-octo-sage",
};

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

interface Props {
  candidates: Issue[];
  projectKey: string | null;
  onPick: (key: string) => void;
  onCancel: () => void;
}

export function InlineTicketPicker({ candidates, projectKey, onPick, onCancel }: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "all">(projectKey ? "project" : "all");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const scoped =
      scope === "project" && projectKey
        ? candidates.filter((i) => i.key.startsWith(projectKey + "-"))
        : candidates;
    if (!query) return scoped.slice(0, 8);
    const q = query.toLowerCase();
    return scoped
      .filter((i) => i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, scope, projectKey, query]);

  useEffect(() => { setHighlight(0); }, [query, scope]);

  const showFallback = results.length === 0 && KEY_RE.test(query);

  async function pickFallback() {
    try {
      await ipc.getIssue(query);
      onPick(query);
    } catch {
      // Quiet — surface remains the picker; user can clear and retry.
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (showFallback) { void pickFallback(); return; }
      const picked = results[highlight];
      if (picked) onPick(picked.key);
    }
  }

  return (
    <div
      className="rounded-r p-3"
      style={{ background: "var(--brass-ghost)", borderLeft: "1px solid var(--brass-dim)" }}
    >
      {/* Scope toggle */}
      <div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
        <span>Scope:</span>
        <button
          type="button"
          onClick={() => setScope("project")}
          className={`rounded-full border px-2 py-[2px] ${
            scope === "project"
              ? "border-octo-brass text-octo-brass"
              : "border-octo-hairline text-octo-mute"
          }`}
          style={scope === "project" ? { background: "var(--brass-ghost)" } : undefined}
          disabled={!projectKey}
          title={projectKey ?? ""}
        >
          {projectKey ?? "—"}
        </button>
        <button
          type="button"
          onClick={() => setScope("all")}
          className={`rounded-full border px-2 py-[2px] ${
            scope === "all"
              ? "border-octo-brass text-octo-brass"
              : "border-octo-hairline text-octo-mute"
          }`}
          style={scope === "all" ? { background: "var(--brass-ghost)" } : undefined}
        >
          All
        </button>
      </div>

      {/* Input */}
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-octo-brass">
          ⟶
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="search by key or summary…"
          className="w-full rounded border border-octo-hairline bg-octo-onyx py-1 pl-7 pr-12 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
        />
        <button
          type="button"
          onClick={onCancel}
          className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
        >
          ESC
        </button>
      </div>

      {/* Hints */}
      <div className="mt-1 flex gap-3 font-mono text-[9px] tracking-[0.1em] text-octo-mute">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>ESC cancel</span>
      </div>

      {/* Results */}
      <div className="mt-2 border-t border-octo-hairline pt-1">
        {results.map((r, idx) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onPick(r.key)}
            onMouseEnter={() => setHighlight(idx)}
            className="flex w-full items-center gap-2 rounded px-1 py-[5px] text-left"
            style={idx === highlight ? { background: "var(--brass-glow)" } : undefined}
          >
            <span
              aria-hidden
              className={`h-[6px] w-[6px] rounded-full ${STATUS_DOT[r.statusCategory]}`}
              style={{ background: "currentColor" }}
            />
            <span className="font-mono text-[11px] text-octo-brass">{r.key}</span>
            <span className="flex-1 truncate text-[12px] text-octo-sage">{r.summary}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-octo-mute">{r.statusName}</span>
          </button>
        ))}

        {showFallback && (
          <div className="mt-1 border-t border-dashed border-octo-hairline pt-2">
            <button
              type="button"
              onClick={() => void pickFallback()}
              aria-label={`Use ${query}`}
              className="flex w-full items-center gap-2 rounded px-1 py-[5px] text-left"
              style={{ background: "var(--brass-glow)" }}
            >
              <span
                aria-hidden
                className="h-[6px] w-[6px] rounded-full text-octo-mute"
                style={{ background: "currentColor" }}
              />
              <span className="font-mono text-[11px] text-octo-brass">{query}</span>
              <span className="flex-1 truncate text-[12px] text-octo-sage">
                (not assigned to you — verified on link)
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass">USE →</span>
            </button>
          </div>
        )}

        {results.length === 0 && !showFallback && (
          <p className="px-1 py-1 font-mono text-[10px] tracking-[0.1em] text-octo-mute">
            No matches in your assigned tickets.
          </p>
        )}
      </div>
    </div>
  );
}
