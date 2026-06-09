import { ipc } from "../lib/ipc";
import { formatBytes } from "../lib/formatBytes";
import type { BinaryReason } from "../stores/editorStore";

interface Props {
  path: string;
  size: number;
  reason: BinaryReason;
}

const BTN =
  "rounded px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-octo-brass transition-colors hover:bg-octo-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

export function EditorBinaryPane({ path, size, reason }: Props) {
  const name = path.split("/").pop() ?? path;
  const message =
    reason === "unsupportedEncoding"
      ? "Unsupported text encoding — this file can't be edited as text."
      : "This file can't be edited as text.";

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        § Binary
      </span>
      <span className="font-mono text-[13px] text-octo-ivory">{name}</span>
      <span className="font-mono text-[11px] text-octo-mute">{formatBytes(size)}</span>
      <p className="max-w-sm text-[12px] text-octo-sage">{message}</p>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className={BTN}
          style={{ border: "1px solid var(--brass-dim)" }}
          onClick={() => ipc.revealInFinder(path)}
        >
          Reveal in Finder
        </button>
        <button
          type="button"
          className={BTN}
          style={{ border: "1px solid var(--brass-dim)" }}
          onClick={() => ipc.openFileInSystem(path)}
        >
          Open in system
        </button>
      </div>
    </div>
  );
}
