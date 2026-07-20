/** The Rust core serializes `AppError::BudgetExceeded` as a structured object
 *  `{ kind: "BudgetExceeded", scope, spent, limit }` (other errors are plain
 *  strings). Returns the details when a thrown value is that error, else `null`.
 *  Used to turn a backend budget block into the override affordance. */
export interface BudgetExceededInfo {
  scope: string;
  spent: number;
  limit: number;
}

export function isBudgetExceeded(err: unknown): BudgetExceededInfo | null {
  let obj: unknown = err;
  if (typeof err === "string") {
    try {
      obj = JSON.parse(err);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === "object" && (obj as Record<string, unknown>).kind === "BudgetExceeded") {
    const e = obj as Record<string, unknown>;
    if (typeof e.scope === "string" && typeof e.spent === "number" && typeof e.limit === "number") {
      return { scope: e.scope, spent: e.spent, limit: e.limit };
    }
  }
  return null;
}
