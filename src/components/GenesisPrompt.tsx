import { useState } from "react";
import { deriveProjectName, GENESIS_PROMISE } from "../lib/genesis";

interface Props {
  /** While the project is being created — disables input + submit. */
  loading?: boolean;
  /** Fires with the prompt and the (editable, never-empty) derived name. */
  onSubmit: (prompt: string, name: string) => void;
}

/**
 * The prompt-first genesis block — describe what you want to build; a crew
 * scaffolds it. Shared by the Welcome screen (pre-project) and the New-project
 * wizard's "From a prompt" type. A BLANK name override never wins (an empty name
 * would make the backend git-init the container dir itself).
 */
export function GenesisPrompt({ loading = false, onSubmit }: Props) {
  const [prompt, setPrompt] = useState("");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const effectiveName = nameOverride?.trim() ? nameOverride.trim() : deriveProjectName(prompt);
  const canGenesis = prompt.trim().length > 0;

  function submit() {
    if (!canGenesis || loading) return;
    onSubmit(prompt.trim(), effectiveName);
  }

  return (
    <div className="w-full">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        disabled={loading}
        placeholder="Describe what you want to build…"
        className="w-full resize-none rounded-lg border border-octo-hairline bg-octo-onyx px-4 py-3 text-[13px] leading-[1.5] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute focus:border-octo-brass disabled:opacity-60"
      />
      <p className="mt-2 text-[12px] leading-[1.4] text-octo-sage">{GENESIS_PROMISE}</p>
      <div className="mt-3 flex items-center justify-end gap-3">
        {canGenesis && (
          <div className="octo-fade-in flex min-w-0 flex-1 items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">
              project
            </span>
            <input
              value={effectiveName}
              onChange={(e) => setNameOverride(e.target.value)}
              aria-label="Project name"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-octo-sage outline-none transition-colors focus:text-octo-ivory"
            />
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canGenesis || loading}
          className="shrink-0 rounded-md px-4 py-2 font-serif text-[14px] text-octo-brass transition disabled:opacity-40"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Set a crew on it
        </button>
      </div>
    </div>
  );
}
