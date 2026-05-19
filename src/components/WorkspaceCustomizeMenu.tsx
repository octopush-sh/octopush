import { useState, useEffect } from "react";
import { TINTS, TINT_NAMES } from "../lib/monogram";
import type { TintName } from "../lib/types";

interface Props {
  /** Existing glyph, or null if using default first letter. */
  initialGlyph: string | null;
  /** Existing tint, or null if using brass default. */
  initialTint: TintName | null;
  /** The default glyph (first letter of the workspace name). */
  defaultGlyph: string;
  /**
   * Submit handler. Glyph is null when the input matches the default
   * (so we don't persist redundant customization).
   */
  onSubmit: (glyph: string | null, tint: TintName | null) => void;
  onCancel: () => void;
}

export function WorkspaceCustomizeMenu({
  initialGlyph,
  initialTint,
  defaultGlyph,
  onSubmit,
  onCancel,
}: Props) {
  const [glyph, setGlyph] = useState<string>(initialGlyph ?? defaultGlyph);
  const [tint, setTint] = useState<TintName>(initialTint ?? "brass");

  useEffect(() => {
    setGlyph(initialGlyph ?? defaultGlyph);
  }, [initialGlyph, defaultGlyph]);

  useEffect(() => {
    setTint(initialTint ?? "brass");
  }, [initialTint]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = glyph.trim().charAt(0) || defaultGlyph;
    const glyphOut = normalized === defaultGlyph ? null : normalized;
    const tintOut = tint === "brass" && initialTint === null ? null : tint;
    onSubmit(glyphOut, tintOut);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-[260px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl"
      aria-label="Customize workspace"
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Customize
      </div>

      <label htmlFor="glyph-input" className="mt-3 block font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        Glyph
      </label>
      <input
        id="glyph-input"
        value={glyph}
        onChange={(e) => setGlyph(e.target.value)}
        maxLength={2}
        className="mt-1 w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-serif text-[18px] text-octo-ivory outline-none focus:border-octo-brass"
      />

      <div className="mt-3 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
        Tint
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1.5">
        {TINT_NAMES.map((name) => {
          const t = TINTS[name];
          const selected = name === tint;
          return (
            <button
              key={name}
              type="button"
              onClick={() => setTint(name)}
              title={name}
              aria-label={name}
              aria-pressed={selected}
              className="h-7 w-7 rounded-md border transition"
              style={{
                background: t.bg,
                borderColor: selected ? t.accent : "transparent",
                outline: selected ? `1px solid ${t.accent}` : "none",
                outlineOffset: "1px",
              }}
            >
              <span className="font-serif" style={{ color: t.accent }}>•</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md px-3 py-1.5 font-serif text-[12px] text-octo-brass"
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
