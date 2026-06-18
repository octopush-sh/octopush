// Settings → Appearance — the theme picker. Each card renders a live preview
// built from the theme's real palette; the card is the swatch, so no hex caption.
import { Check } from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";
import type { ThemeConfig } from "../../lib/types";
import { PaneHeader, SectionLabel } from "./shared";

export function AppearancePane() {
  const { themes, theme: current, apply } = useThemeStore();

  return (
    <>
      <PaneHeader
        eyebrow="Appearance"
        title="A palette to live in."
        subtitle="Octopush ships with Atelier (Onyx & Brass). Legacy themes remain available for power users."
      />

      <SectionLabel>Theme</SectionLabel>
      <div className="grid max-w-[680px] grid-cols-2 gap-3">
        {themes.map((t) => (
          <ThemeCard
            key={t.name}
            theme={t}
            active={current?.name === t.name}
            onSelect={() => apply(t)}
          />
        ))}
      </div>
    </>
  );
}

function ThemeCard({ theme, active, onSelect }: {
  theme: ThemeConfig;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="group flex flex-col gap-3 rounded-lg p-3 text-left transition-[transform,border-color,background] duration-[180ms] hover:-translate-y-px"
      style={{
        border: active ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)",
        background: active ? "var(--brass-ghost)" : "transparent",
      }}
    >
      {/* Live preview built from the theme's own tokens. */}
      <div
        className="relative h-16 overflow-hidden rounded-md"
        style={{ background: theme.bg, border: `1px solid ${theme.border}` }}
        aria-hidden
      >
        {/* a panel band */}
        <div className="absolute inset-x-2 top-2 h-3 rounded-sm" style={{ background: theme.panel }} />
        {/* a row of palette dots: accent · text · sage */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full" style={{ background: theme.accent }} />
          <span className="h-3 w-3 rounded-full" style={{ background: theme.text }} />
          <span className="h-3 w-3 rounded-full" style={{ background: theme.textDim }} />
        </div>
        {/* a brass underline accent — the signature, mirrors the active rule */}
        <div className="absolute bottom-2 right-2 h-[3px] w-7 rounded-full" style={{ background: theme.accent }} />
      </div>

      <div className="flex items-center justify-between">
        <span className={`font-serif text-[14px] ${active ? "text-octo-brass" : "text-octo-ivory"}`}>
          {theme.name}
        </span>
        {active && (
          <span className="octo-pop-in text-octo-brass" aria-label="Active theme">
            <Check size={14} />
          </span>
        )}
      </div>
    </button>
  );
}
