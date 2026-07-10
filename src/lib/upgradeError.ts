import type { UpgradeInfo } from "../stores/upgradeStore";

/** The Rust core serializes `AppError::UpgradeRequired` as a structured object
 *  `{ kind: "UpgradeRequired", feature, used, limit }` (other errors are plain
 *  strings). Returns the info when an unknown thrown value is that error, else
 *  `null`. */
export function isUpgradeRequired(err: unknown): UpgradeInfo | null {
  let obj: unknown = err;
  if (typeof err === "string") {
    try {
      obj = JSON.parse(err);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === "object" && (obj as Record<string, unknown>).kind === "UpgradeRequired") {
    const e = obj as Record<string, unknown>;
    if (typeof e.feature === "string" && typeof e.used === "number" && typeof e.limit === "number") {
      return { feature: e.feature, used: e.used, limit: e.limit };
    }
  }
  return null;
}
