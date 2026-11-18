import { Fragment, useEffect, useState, type ReactNode } from "react";
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
  /** "Think it through first": open the Sketchbook with this prompt instead of
   *  building. A secondary action; omit to hide it. */
  onSketch?: (prompt: string) => void;
  /** Extra secondary routes (links styled with `GENESIS_LINK_CLASS`), shown on
   *  the same quiet line as "or think it through first". */
  links?: ReactNode[];
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
export function GenesisPrompt({ loading = false, onSubmit, onSketch, links = [] }: Props) {
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

  /** Persist an Anthropic key + re-check readiness. Returns true on success.
   *  Shared by the explicit Save button and the submit-with-a-typed-key path. */
  async function saveKey(): Promise<boolean> {
    const trimmed = keyValue.trim();
    if (!trimmed || savingKey) return false;
    setSavingKey(true);
    try {
      await saveAnthropicKey(trimmed);
      setKeyValue("");
      await refreshReady();
      pushToast({ level: "success", title: "Key saved", body: "Your crew is ready to work." });
      return true;
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't save the key", body: String(e).split("\n")[0] });
      return false;
    } finally {
      setSavingKey(false);
    }
  }

  // One primary CTA for the whole block. With a key typed but no brief yet it
  // saves the key ("Wake the crew"); otherwise it sets the crew on the brief.
  const hasTypedKey = keyValue.trim().length > 0;
  const wakeOnly = ready === false && hasTypedKey && !canGenesis;
  // Full brass ink only when the CTA can act with confidence: a brief plus a
  // stored or typed key, or a key alone to save ("Wake the crew"). A brief
  // with no key stays clickable (the honest Settings fallback) but receded.
  const primed = wakeOnly || (canGenesis && (ready !== false || hasTypedKey));

  const secondary: ReactNode[] = [];
  if (onSketch) {
    secondary.push(
      <button
        type="button"
        onClick={() => canGenesis && onSketch(prompt.trim())}
        disabled={!canGenesis}
        data-tour="genesis-sketch"
        title={canGenesis ? undefined : "Describe it above first"}
        className={GENESIS_LINK_CLASS}
      >
        or think it through first
      </button>,
    );
  }
  secondary.push(...links);

  async function submit() {
    if (!canGenesis || loading || savingKey) return;
    // A cold user who typed a key but pressed Enter/the CTA (rather than "Save")
    // gets it persisted first, so the whole gesture completes without the
    // Settings·Models detour. A user who typed NO key still proceeds — the crew
    // is staged and the (honest) Settings fallback fires, since a keyless crew
    // genuinely can't run.
    if (ready === false && keyValue.trim()) {
      const saved = await saveKey();
      if (!saved) return; // a bad key surfaced a toast — don't launch on a failure
    }
    onSubmit(prompt.trim(), effectiveName, model);
  }

  return (
    <div className="w-full">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        disabled={loading}
        placeholder="Describe what you want to build…"
        className="w-full resize-none rounded-lg border border-octo-border-strong bg-octo-onyx px-4 py-3 text-[13px] leading-[1.5] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute focus:border-octo-brass disabled:opacity-60"
      />
      <p className="mt-2 text-[12px] leading-[1.4] text-octo-sage">{GENESIS_PROMISE}</p>

      {/* Pre-flight: a cold user pastes a key inline; a ready user may pick a
          model. Geometry settles as `ready` resolves — a sub-100ms local check,
          so no ceremonial loading state. */}
      {ready === false && (
        <div className="octo-fade-in mt-3">
          {/* No button of its own: the one primary CTA below saves the key
              (and reads "Wake the crew" while there is a key but no brief). */}
          <input
            type="password"
            data-tour="genesis-key-save"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            aria-label="Anthropic API key"
            placeholder="Paste an Anthropic API key to wake the crew"
            className="w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus:border-octo-brass"
          />
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
        {/* The block's one primary CTA, always in the ceremonial frame
            (brass-dim border, brass-ghost fill, serif) so it leads the footer
            in every state — a ghost outline in sage made it the faintest
            thing on the screen (#758). Only the ink changes: full brass once
            it can act with confidence, receded otherwise: sage for a brief
            with no key (still clickable), brass/50 when disabled with
            nothing to do. */}
        <button
          type="button"
          data-tour="genesis-begin"
          onClick={() => void (wakeOnly ? saveKey() : submit())}
          disabled={!(canGenesis || wakeOnly) || loading || savingKey}
          data-primed={primed ? "true" : undefined}
          className={`${GENESIS_CTA_CLASS} ${primed ? GENESIS_CTA_INK_PRIMED : GENESIS_CTA_INK_RECEDED}`}
        >
          {savingKey ? "Waking the crew…" : wakeOnly ? "Wake the crew" : "Set a crew on it"}
        </button>
      </div>

      {/* Secondary routes, one quiet line under the primary: think it through
          first (the Sketchbook — no build yet), then whatever the host adds. */}
      {secondary.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-x-2 text-[12px] text-octo-mute">
          {secondary.map((node, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden>·</span>}
              {node}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** The genesis block's one primary CTA: the ceremonial frame (design-system
 *  §4) in every state. The ink is one of the two below. No opacity on the
 *  whole button, which read as the screen being off (#585). */
export const GENESIS_CTA_CLASS =
  "shrink-0 rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[14px] transition-colors duration-[180ms] disabled:cursor-default";
/** Brief plus a stored or typed key, or "Wake the crew": full brass. */
export const GENESIS_CTA_INK_PRIMED = "text-octo-brass hover:text-octo-brass-hi";
/** Nothing to do yet (disabled), or a brief with no key (clickable, the honest
 *  Settings fallback): the frame stays, the ink recedes. Enabled, it recedes to
 *  sage, which clears AA on the brass-ghost frame in every theme; no brass
 *  alpha does (brass/70 is 2.7:1 on Vellum, #818). Disabled, it drops further
 *  to brass/50, which reads as unavailable and is exempt as an inactive control. */
export const GENESIS_CTA_INK_RECEDED =
  "text-octo-sage hover:text-octo-brass disabled:text-octo-brass/50 disabled:hover:text-octo-brass/50";

/** The quiet link style shared by every secondary route under the genesis CTA:
 *  one ink (sage, ivory on hover) and one underline for all of them, so none
 *  outshouts the primary (#758). A disabled route drops to mute ink, so it
 *  reads as unavailable; its `title` says why. */
export const GENESIS_LINK_CLASS =
  "font-serif text-[12px] text-octo-sage underline decoration-octo-brass/40 underline-offset-2 transition-colors duration-[180ms] hover:text-octo-ivory hover:decoration-octo-brass disabled:cursor-default disabled:text-octo-mute disabled:hover:text-octo-mute disabled:hover:decoration-octo-brass/40";
