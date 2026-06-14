import { useCallback, useRef, useState } from "react";
import { copyToClipboard } from "../lib/clipboard";

/**
 * Copy text to the clipboard with a transient `copied` flag for inline
 * feedback (no toast). Shared by the message Copy affordance and the tool-card
 * Copy button so the timing/behavior stays in one place.
 *
 * Empty/whitespace text is a no-op. The flag auto-resets after `resetMs`.
 */
export function useCopyFeedback(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      void copyToClipboard(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}
