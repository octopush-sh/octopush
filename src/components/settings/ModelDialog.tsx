// Add/edit a single model — a focused ModalShell dialog instead of an inline,
// permanently-expanded form (no more nested boxes). Preserves the non-edited
// fields of an existing model so editing cost/context never drops capabilities.
import { useState } from "react";
import type { ModelInfo } from "../../lib/types";
import { ModalShell } from "../ModalShell";

export function ModelDialog({
  providerName,
  initial,
  takenIds = [],
  onSubmit,
  onClose,
}: {
  providerName: string;
  initial?: ModelInfo;
  /** Ids already used by other models in this provider — rejected as duplicates. */
  takenIds?: string[];
  onSubmit: (m: ModelInfo) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.displayName ?? "");
  const [inC, setInC] = useState(String(initial?.inputCostPerM ?? 0));
  const [outC, setOutC] = useState(String(initial?.outputCostPerM ?? 0));
  const [ctx, setCtx] = useState(String(initial?.maxContext ?? 200000));
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    const trimmed = id.trim();
    if (!trimmed) {
      setErr("Model id is required");
      return;
    }
    if (takenIds.includes(trimmed)) {
      setErr("A model with that id already exists");
      return;
    }
    onSubmit({
      ...(initial ?? {
        cacheReadCostPerM: 0,
        cacheCreationCostPerM: 0,
        supportsVision: false,
        supportsTools: true,
        tags: [],
      }),
      id: id.trim(),
      displayName: name.trim() || id.trim(),
      inputCostPerM: Number(inC) || 0,
      outputCostPerM: Number(outC) || 0,
      maxContext: Number(ctx) || 200000,
    });
  }

  return (
    <ModalShell onClose={onClose} ariaLabel={initial ? "Edit model" : "Add model"}>
      <div className="w-[420px] rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          {initial ? "Edit model" : "Add model"}
        </div>
        <div className="mb-4 font-serif text-[15px] text-octo-ivory">{providerName}</div>

        <div className="space-y-3">
          <DialogField label="Model ID">
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="model id (e.g. claude-3-5-sonnet-20241022)"
              autoFocus
              className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
            />
          </DialogField>

          <DialogField label="Display name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="display name (optional)"
              className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
            />
          </DialogField>

          <div className="flex gap-2">
            <DialogField label="Cost in /M" className="flex-1">
              <input
                type="number" min="0" step="0.01" value={inC}
                onChange={(e) => setInC(e.target.value)} placeholder="0"
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
            </DialogField>
            <DialogField label="Cost out /M" className="flex-1">
              <input
                type="number" min="0" step="0.01" value={outC}
                onChange={(e) => setOutC(e.target.value)} placeholder="0"
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
            </DialogField>
            <DialogField label="Context" className="flex-1">
              <input
                type="number" min="0" step="1000" value={ctx}
                onChange={(e) => setCtx(e.target.value)} placeholder="200000"
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
            </DialogField>
          </div>

          {err && <div className="font-mono text-[10px] text-octo-rouge">{err}</div>}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            className="rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {initial ? "Save model" : "Add model"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-octo-mute transition hover:text-octo-sage"
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function DialogField({ label, className = "", children }: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">{label}</div>
      {children}
    </div>
  );
}
