import { useState } from "react";
import { TINTS, TINT_NAMES } from "../lib/monogram";
import type { TintName } from "../lib/types";

interface Props {
  currentName: string;
  currentTint: TintName;
  onCustomized: (name: string, tint: TintName) => void;
  onCancel: () => void;
}

export function ProjectCustomizeMenu({
  currentName,
  currentTint,
  onCustomized,
  onCancel,
}: Props) {
  const [name, setName] = useState(currentName);
  const [tint, setTint] = useState<TintName>(currentTint);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCustomized(name.trim(), tint);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-[260px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl"
      aria-label="Customize project"
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Customize
      </div>

      <label htmlFor="name-input" className="mt-3 block font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        Name
      </label>
      <input
        id="name-input"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mt-1 w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-serif text-[18px] text-octo-ivory outline-none focus:border-octo-brass"
        placeholder="Project name"
      />

      <div className="mt-3 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        Tint
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1.5">
        {TINT_NAMES.map((tintName) => {
          const tintValue = TINTS[tintName];
          const selected = tintName === tint;
          return (
            <button
              key={tintName}
              type="button"
              onClick={() => setTint(tintName)}
              title={tintName}
              aria-label={tintName}
              aria-pressed={selected}
              className="h-7 w-7 rounded-md border transition"
              style={{
                background: tintValue.bg,
                borderColor: selected ? tintValue.accent : "transparent",
                outline: selected ? `1px solid ${tintValue.accent}` : "none",
                outlineOffset: "1px",
              }}
            >
              <span className="font-serif" style={{ color: tintValue.accent }}>•</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md px-3 py-1.5 font-serif text-[12px] text-octo-brass disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 font-sans text-[12px] text-octo-mute hover:text-octo-sage"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
