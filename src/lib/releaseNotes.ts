// Release notes for the INSTALLED version, shown in Settings › About.
//
// Two sources, first hit wins:
// 1. the notes bundled at build time (`whats-new/<version>/notes.md`, written
//    by `scripts/whats-new.mjs collect` — docs/WHATS-NEW.md §5);
// 2. the manifest notes of the update the user installed from the app,
//    remembered just before install (per-Mac convenience; may be absent).

const STORAGE_KEY = "octo.updater.installedNotes";

const BUNDLED: Record<string, string> = import.meta.glob("/whats-new/*/notes.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** `/whats-new/1.4.0/notes.md` → `1.4.0`. */
function versionOf(path: string): string | null {
  const m = /\/whats-new\/([^/]+)\/notes\.md$/.exec(path);
  return m ? m[1] : null;
}

export function bundledNotes(version: string): string | null {
  for (const [path, text] of Object.entries(BUNDLED)) {
    if (versionOf(path) === version && typeof text === "string" && text.trim()) return text;
  }
  return null;
}

export function rememberInstalledNotes(version: string, notes: string | null): void {
  if (!notes?.trim()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version, notes }));
  } catch {
    /* storage unavailable — About simply shows no notes */
  }
}

function rememberedNotes(version: string): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; notes?: unknown };
    return parsed.version === version && typeof parsed.notes === "string" ? parsed.notes : null;
  } catch {
    return null;
  }
}

/** The notes for `version`, or null when none are known. */
export function installedNotes(version: string | null): string | null {
  if (!version) return null;
  return bundledNotes(version) ?? rememberedNotes(version);
}
