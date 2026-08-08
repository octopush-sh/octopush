import { useState } from "react";

interface Props {
  title: string;
  label: string;
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Minimal single-field rename modal — used for workspace rename (§5.2). */
export function RenameDialog({ title, label, initialValue, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-[300px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl"
      aria-label={title}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        {title}
      </div>
      <label htmlFor="rename-input" className="mt-3 block font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </label>
      <input
        id="rename-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        className="mt-1 w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-sans text-[14px] text-octo-ivory outline-none focus:border-octo-brass"
      />
      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={!trimmed}
          className="rounded-md px-3 py-1.5 font-serif text-[12px] text-octo-brass disabled:opacity-40"
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
