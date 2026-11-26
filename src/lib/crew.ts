import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ipc, type CrewPreview } from "./ipc";
import { copyToClipboard } from "./clipboard";
import { pushToast } from "../components/Toasts";
import { useCrewImportStore } from "../stores/crewImportStore";
import type { ProviderConfig } from "./types";

/** Matches Rust `crew::MAX_CREW_BYTES`. */
export const MAX_CREW_BYTES = 512 * 1024;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Export crew…: the native save dialog, then a toast naming the file. */
export async function exportCrewFile(pipelineId: string): Promise<void> {
  try {
    const path = await ipc.saveCrewFile(pipelineId);
    if (path) pushToast({ level: "success", title: "Crew exported", body: path });
  } catch (e) {
    pushToast({ level: "error", title: "Couldn't export the crew", body: errorText(e) });
  }
}

export async function copyCrewJson(pipelineId: string): Promise<void> {
  try {
    await copyToClipboard(await ipc.exportCrew(pipelineId), "Crew copied as JSON");
  } catch (e) {
    pushToast({ level: "error", title: "Couldn't copy the crew", body: errorText(e) });
  }
}

/** Pick a crew file and open the review sheet on it. */
export async function pickCrewFile(): Promise<void> {
  let path: string | null = null;
  try {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Octopush crew", extensions: ["json"] }],
    });
    path = typeof picked === "string" ? picked : null;
  } catch {
    return; // dialog cancelled / unavailable
  }
  if (!path) return;
  try {
    const text = await ipc.readCrewFile(path);
    useCrewImportStore.getState().show(text, path.split("/").pop() ?? path);
  } catch (e) {
    pushToast({ level: "error", title: "Couldn't read that file", body: errorText(e) });
  }
}

/** The dropped JSON file, if the drag carries one. */
function droppedJson(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  return Array.from(dt.files).find((f) => f.name.toLowerCase().endsWith(".json")) ?? null;
}

/** True while a drag carries files (so a drop target can accept it). */
export function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/** Drop handler for the launcher and the builder: a dropped `.octocrew.json`
 *  opens the review sheet. Returns false when the drop isn't a JSON file, so
 *  the caller can handle it its own way. */
export function openDroppedCrew(e: React.DragEvent): boolean {
  const file = droppedJson(e.dataTransfer);
  if (!file) return false;
  e.preventDefault();
  if (file.size > MAX_CREW_BYTES) {
    pushToast({ level: "error", title: "That file is too large to be a crew." });
    return true;
  }
  void file
    .text()
    .then((text) => useCrewImportStore.getState().show(text, file.name))
    .catch((err) => pushToast({ level: "error", title: "Couldn't read that file", body: errorText(err) }));
  return true;
}

/** Every model id the catalog's enabled providers list. */
export function catalogModelIds(providers: ProviderConfig[]): Set<string> {
  const ids = new Set<string>();
  for (const p of providers) {
    if (!p.enabled) continue;
    for (const m of p.models) ids.add(m.id);
  }
  return ids;
}

export interface ModelFlag {
  model: string;
  notInCatalog: boolean;
  unpriced: boolean;
}

/** The crew's models that need a look: absent from the catalog, or ones the
 *  app can't price (never shown as free — they stay "unpriced"). In stage
 *  order, each once. */
export function flaggedModels(preview: CrewPreview, catalog: Set<string>): ModelFlag[] {
  const out = new Map<string, ModelFlag>();
  const note = (model: string, unpriced: boolean) => {
    const notInCatalog = !catalog.has(model);
    if (!notInCatalog && !unpriced) return;
    const prev = out.get(model);
    out.set(model, { model, notInCatalog, unpriced: unpriced || (prev?.unpriced ?? false) });
  };
  for (const s of preview.stages) {
    note(s.agentModel, s.unpricedModel);
    if (s.escalateModel) note(s.escalateModel, s.unpricedEscalate);
  }
  return Array.from(out.values());
}

export function modelFlagText(f: ModelFlag): string {
  return [f.notInCatalog && "not in your catalog", f.unpriced && "unpriced"].filter(Boolean).join(" · ");
}

/** Tools that change things, called out on the sheet. */
export const POWER_TOOLS = new Set(["run_command", "write_file", "edit_file"]);

type StagePreview = CrewPreview["stages"][number];

/** A CLI stage's real power, in place of a tool list the CLI never applies:
 *  Claude Code runs with every permission granted, Codex in its
 *  workspace-write sandbox (or its read-only one for a read-only review).
 *  Null on API. */
export function cliShellLine(s: StagePreview): string | null {
  if (s.cliDialect === "claude") return "Full shell · Claude Code (all permissions)";
  if (s.cliDialect === "codex") return s.readOnly ? "Shell · Codex (read-only sandbox)" : "Full shell · Codex (workspace-write sandbox)";
  return null;
}

/** `Loops back to stage 2 · auto · up to ×3`, or null without a loop. */
export function loopLine(s: StagePreview): string | null {
  if (s.loopTargetPosition === null) return null;
  return [`Loops back to stage ${s.loopTargetPosition + 1}`, s.loopMode, `up to ×${s.loopMaxIterations}`]
    .filter(Boolean)
    .join(" · ");
}

/** `escalates to claude-opus-4-6 · effort max`, or null without a policy. */
export function escalationLine(s: StagePreview): string | null {
  if (!s.escalateModel && !s.escalateEffort) return null;
  return [s.escalateModel ? `escalates to ${s.escalateModel}` : "escalates", s.escalateEffort && `effort ${s.escalateEffort}`]
    .filter(Boolean)
    .join(" · ");
}
