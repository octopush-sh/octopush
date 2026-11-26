import { useEffect, useState } from "react";
import type { ModelRetirement } from "../lib/ipc";
import { loadModelRetirements } from "../lib/modelRetirement";

/** The retiring models among `models` (`[]` until the backend answers, or
 *  when it can't). Re-asks only when the set of ids changes. */
export function useModelRetirements(models: string[]): ModelRetirement[] {
  const key = [...models].sort().join("\n");
  const [found, setFound] = useState<ModelRetirement[]>([]);
  useEffect(() => {
    if (!key) {
      setFound([]);
      return;
    }
    let alive = true;
    void loadModelRetirements(key.split("\n")).then((r) => { if (alive) setFound(r); });
    return () => { alive = false; };
  }, [key]);
  return found;
}
