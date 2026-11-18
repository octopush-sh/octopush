import type { ModelWithProvider } from "./types";

/** How many models ⌘K shows before anything is typed (#850). */
export const MODEL_PREVIEW = 3;

/**
 * The ⌘K Models group's rows. With a query every model is offered, so cmdk's
 * filter finds any of them exactly as before. With no query the group is a
 * short preview — the active session's model first, then the catalogue's
 * order — so a long model list never pushes Workspaces and Actions down;
 * `hidden` is how many the "Show all models" row would reveal.
 */
export function paletteModels(
  models: ModelWithProvider[],
  query: string,
  expanded: boolean,
  activeModelId?: string | null,
): { shown: ModelWithProvider[]; hidden: number } {
  if (query.trim() !== "" || expanded || models.length <= MODEL_PREVIEW) {
    return { shown: models, hidden: 0 };
  }
  const active = activeModelId ? models.find((m) => m.model.id === activeModelId) : undefined;
  const ordered = active ? [active, ...models.filter((m) => m !== active)] : models;
  return { shown: ordered.slice(0, MODEL_PREVIEW), hidden: models.length - MODEL_PREVIEW };
}
