// Display names for the built-in themes. The backend's `name` is an id
// (`porcelain-indigo`, `solarized-dark`), never copy — the picker used to print
// it verbatim, so the brand theme read "atelier" beside prose saying "Atelier".

/** Pre-redesign palettes (`theme.rs` "Legacy themes"), shown in their own group. */
export const LEGACY_THEMES: ReadonlySet<string> = new Set(["dark", "midnight", "solarized-dark"]);

const LABELS: Record<string, string> = {
  "porcelain-indigo": "Porcelain & Indigo",
};

/** Title-case label for a theme id. A hand-written `~/.octopush/theme.json` can
 *  carry any name, so unknown ids title-case per word instead of erroring. */
export function themeLabel(name: string): string {
  const known = LABELS[name];
  if (known) return known;
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function isLegacyTheme(name: string): boolean {
  return LEGACY_THEMES.has(name);
}
