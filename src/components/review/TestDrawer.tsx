import { X } from "lucide-react";
import type { TestRunResult } from "../../lib/types";

export function TestDrawer({ result, onClose }: { result: TestRunResult; onClose: () => void }) {
  const isPass = result.exitCode === 0;
  return (
    <div className="octo-rise-in border-t border-octo-hairline bg-octo-bg">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="font-mono text-xs font-semibold text-octo-ivory">Test output</span>
        <span className={["ml-1 rounded px-2 py-0.5 font-mono text-[10px] font-semibold",
          isPass ? "bg-octo-success/20 text-octo-success" : "bg-octo-danger/20 text-octo-danger"].join(" ")}>
          exit {result.exitCode}
        </span>
        <button onClick={onClose} aria-label="Dismiss" title="Dismiss (Esc)"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass">
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 select-text overflow-y-auto px-4 pb-3">
        {result.stdout && <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-ivory">{result.stdout}</pre>}
        {result.stderr && <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-rouge/80">{result.stderr}</pre>}
        {!result.stdout && !result.stderr && <p className="text-xs text-octo-mute">(no output)</p>}
      </div>
    </div>
  );
}
