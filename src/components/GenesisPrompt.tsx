import { useEffect, useState } from "react";
import { deriveProjectName, GENESIS_PROMISE } from "../lib/genesis";
import { saveAnthropicKey } from "../lib/providerKey";
import { shortModel } from "../lib/modelLabel";
import { crewProviderReady } from "../stores/firstRunStore";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import { Listbox } from "./controls/Listbox";

interface Props {
  /** While the project is being created — disables input + submit. */
  loading?: boolean;
  /** Fires with the prompt, the (editable, never-empty) derived name, and the
   *  chosen model (null = the crew's default). */
  onSubmit: (prompt: string, name: string, model: string | null) => void;
}

/**
 * The prompt-first genesis block — describe what you want to build; a crew
 * scaffolds it. Shared by the Welcome screen (pre-project) and the New-project
 * wizard's "From a prompt" type. A BLANK name override never wins (an empty name
 * would make the backend git-init the container dir itself).
 *
 * G4: the block owns the pre-flight — a model line (pick which Claude the crew
 * runs on) and, for a cold user with no key, an inline Anthropic-key field so
 * the whole gesture completes without a detour to Settings.
 */
export function GenesisPrompt({ loading = false, onSubmit }: Props) {
  const [prompt, setPrompt] = useState("");
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const effectiveName = nameOverride?.trim() ? nameOverride.trim() : deriveProjectName(prompt);
  const canGenesis = prompt.trim().length > 0;

  // Pre-flight state.
  const [ready, setReady] = useState<boolean | null>(null); // null = still checking
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null); // null = crew default
  const [keyValue, setKeyValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  async function refreshReady() {
    const ok = await crewProviderReady();
    setReady(ok);
    if (ok) {
      try {
        const all = await ipc.listModels();
        setModels(all.filter((m) => m.provider === "anthropic").map((m) => m.model.id));
      } catch {
        setModels([]);
      }
    }
  }

  useEffect(() => {
    void refreshReady();
  }, []);

  function submit() {
    if (!canGenesis || loading) return;
    onSubmit(prompt.trim(), effectiveName, model);
  }

  async function saveKey() {
    const trimmed = keyValue.trim();
    if (!trimmed || savingKey) return;
    setSavingKey(true);
    try {
      await saveAnthropicKey(trimmed);
      setKeyValue("");
      await refreshReady();
      pushToast({ level: "success", title: "Key saved", body: "Your crew is ready to work." });
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't save the key", body: String(e).split("\n")[0] });
    } finally {
      setSavingKey(false);
    }
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

      {/* Pre-flight: a cold user pastes a key inline; a ready user may pick a
          model. Geometry settles as `ready` resolves — a sub-100ms local check,
          so no ceremonial loading state. */}
      {ready === false && (
        <div className="octo-fade-in mt-3 flex items-center gap-2">
          <input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            aria-label="Anthropic API key"
            placeholder="Paste an Anthropic API key to wake the crew"
            className="min-w-0 flex-1 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus:border-octo-brass"
          />
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={!keyValue.trim() || savingKey}
            className="shrink-0 rounded-md px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition disabled:opacity-40"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {savingKey ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {ready === false && (
        <p className="mt-1.5 text-[11px] text-octo-mute">
          Stored locally in <span className="font-mono">~/.octopush</span> — never leaves your machine.
        </p>
      )}

      {ready && models.length > 0 && (
        <div className="octo-fade-in mt-3 flex items-center gap-2 font-mono text-[11px] text-octo-mute">
          <span>crew runs on</span>
          <div className="min-w-0 max-w-[220px]">
            <Listbox
              ariaLabel="Crew model"
              value={model ?? ""}
              onChange={(v) => setModel(v || null)}
              options={[
                { value: "", label: "the crew default" },
                ...models.map((m) => ({ value: m, label: shortModel(m) })),
              ]}
            />
          </div>
        </div>
      )}

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
