/**
 * RoleEditor — Design B: conversational, prompt-as-hero.
 *
 * The large serif prompt textarea is the visual center.
 * Settings orbit it as an editable natural-language brief
 * with click-to-edit chip controls.
 *
 * Built-in roles are treated as forks: new key + isBuiltin=false.
 */
import { useRef, useState } from "react";
import { ipc, type Role } from "../lib/ipc";
import { ModalShell } from "./ModalShell";
import { MenuSurface } from "./MenuSurface";
import { MENU_ITEM, MENU_HEADER } from "../lib/menuStyles";

// ─── Key derivation ───────────────────────────────────────────────────────────

/** Derives a stable role key from a display name.
 *  Lowercases, turns non-alphanumeric runs to `_`, collapses repeats, trims `_`. */
export function deriveRoleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ArtifactKind = Role["artifactKind"];
type Environment = Role["environment"];
type Substrate = Role["defaultSubstrate"];

const TOOL_KEYS = ["read_file", "list_files", "write_file", "run_command"] as const;
type ToolKey = (typeof TOOL_KEYS)[number];

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  plan: "plan",
  review: "review",
  diff: "diff",
  tests: "tests",
  note: "note",
};

// ─── Chip menu ───────────────────────────────────────────────────────────────

interface ChipMenuProps {
  label: string;
  /** Amber coloring for Action environment context */
  warn?: boolean;
  /** Menu content builder — receives a close() fn */
  menu: (close: () => void) => React.ReactNode;
}

function ChipMenu({ label, warn, menu }: ChipMenuProps) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.bottom + 4 });
  };
  const close = () => setAnchor(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={open}
        className={[
          "inline-block cursor-pointer rounded px-0.5 transition-colors duration-[150ms]",
          warn
            ? "border-b border-octo-warning text-octo-warning hover:bg-[var(--warning-ghost)]"
            : "border-b border-[var(--brass-dim)] text-octo-brass hover:bg-[var(--brass-ghost)]",
        ].join(" ")}
      >
        {label}
        <span className="ml-0.5 font-mono text-[9px] text-octo-mute">▾</span>
      </button>
      {anchor && (
        <MenuSurface
          x={anchor.x}
          y={anchor.y}
          ariaLabel={`Change ${label}`}
          onDismiss={close}
          widthClass="w-[180px]"
        >
          {menu(close)}
        </MenuSurface>
      )}
    </>
  );
}

// ─── Default state factory ────────────────────────────────────────────────────

function defaultRole(): Role {
  return {
    key: "",
    label: "",
    description: "",
    promptBody: "",
    artifactKind: "note",
    environment: "worktree",
    canLoop: false,
    defaultTools: ["read_file", "list_files"],
    defaultSubstrate: "api",
    defaultCheckpoint: false,
    tokenEstIn: 4000,
    tokenEstOut: 1000,
    isBuiltin: false,
  };
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /** When set, pre-fills the editor. Built-ins are forked (fresh key, isBuiltin=false). */
  initial?: Role;
  onSaved: (r: Role) => void;
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RoleEditor({ initial, onSaved, onClose }: Props) {
  // Fork built-ins: start from their values but strip the built-in flag and
  // derive a fresh key so saving never mutates the original.
  const init: Role = initial
    ? { ...initial, isBuiltin: false, key: initial.isBuiltin ? "" : initial.key }
    : defaultRole();

  const [label, setLabel] = useState(init.label);
  const [key, setKey] = useState(init.key);
  const [promptBody, setPromptBody] = useState(init.promptBody);
  const [artifactKind, setArtifactKind] = useState<ArtifactKind>(init.artifactKind);
  const [environment, setEnvironment] = useState<Environment>(init.environment);
  const [canLoop, setCanLoop] = useState(init.canLoop);
  const [tools, setTools] = useState<Set<ToolKey>>(new Set(init.defaultTools as ToolKey[]));
  const [substrate, setSubstrate] = useState<Substrate>(init.defaultSubstrate);
  const [checkpoint, setCheckpoint] = useState(init.defaultCheckpoint);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the user edits the label, auto-derive the key (unless they've
  // manually set a custom key that differs — in which case leave it alone).
  const [keyManual, setKeyManual] = useState(!!init.key);

  const handleLabelChange = (next: string) => {
    setLabel(next);
    if (!keyManual) {
      setKey(deriveRoleKey(next));
    }
  };

  const handleKeyChange = (next: string) => {
    setKey(next);
    setKeyManual(true);
  };

  const selectEnvironment = (env: Environment) => {
    setEnvironment(env);
    if (env === "action") {
      setCheckpoint(true);
      setSubstrate("cli");
    }
  };

  const toggleTool = (tool: ToolKey) => {
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) {
        next.delete(tool);
      } else {
        next.add(tool);
      }
      return next;
    });
  };

  const isAction = environment === "action";

  // Natural-language brief helper text
  const toolsLabel = (() => {
    const t = [...tools];
    if (t.length === 0) return "no tools";
    if (t.includes("write_file") && t.includes("run_command")) return "full tools";
    if (t.includes("run_command")) return "read + run tools";
    if (t.includes("write_file")) return "read + write tools";
    return "read-only tools";
  })();

  const canSave = label.trim().length > 0 && key.trim().length > 0 && promptBody.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const role: Role = {
        key: key.trim(),
        label: label.trim(),
        description: "",
        promptBody: promptBody.trim(),
        artifactKind,
        environment,
        canLoop,
        defaultTools: [...tools],
        defaultSubstrate: substrate,
        defaultCheckpoint: checkpoint,
        tokenEstIn: init.tokenEstIn,
        tokenEstOut: init.tokenEstOut,
        isBuiltin: false,
      };
      const saved = await ipc.saveRole(role);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      ariaLabel="Role editor"
      panelClassName="w-full max-w-[600px]"
      closeOnBackdrop={false}
    >
      <div className="octo-modal-enter flex flex-col rounded-[14px] border border-[var(--brass-dim)] bg-octo-panel shadow-2xl">

        {/* ── Top bar: name + key + environment flip ─────────────────── */}
        <div className="flex items-center gap-2.5 px-[18px] pt-[14px]">
          {/* Inline-editable name */}
          <input
            type="text"
            value={label}
            onChange={(e) => handleLabelChange(e.target.value)}
            placeholder="Role name"
            aria-label="Role name"
            autoFocus
            className="min-w-[60px] flex-1 border-b border-transparent bg-transparent pb-0.5 font-serif text-[22px] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:text-octo-mute hover:border-[var(--brass-dim)] focus:border-[var(--brass-dim)]"
          />

          {/* Derived key display */}
          <span className="shrink-0 font-mono text-[10px] text-octo-mute">
            · key{" "}
            <input
              type="text"
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              aria-label="Role key"
              title="Unique identifier (auto-derived from name)"
              className="inline w-[120px] border-b border-transparent bg-transparent font-mono text-[10px] text-octo-brass outline-none transition-colors duration-[150ms] hover:border-[var(--brass-dim)] focus:border-[var(--brass-dim)]"
            />
          </span>

          {/* Environment flip */}
          <div className="flex shrink-0 overflow-hidden rounded-[7px] border border-octo-hairline">
            <button
              type="button"
              onClick={() => selectEnvironment("worktree")}
              className={[
                "border-r border-octo-hairline px-[10px] py-[5px] font-mono text-[10px] transition-colors duration-[150ms]",
                !isAction ? "bg-[var(--brass-ghost)] text-octo-brass" : "bg-transparent text-octo-sage hover:text-octo-ivory",
              ].join(" ")}
            >
              Worktree
            </button>
            <button
              type="button"
              onClick={() => selectEnvironment("action")}
              className={[
                "px-[10px] py-[5px] font-mono text-[10px] transition-colors duration-[150ms]",
                isAction ? "bg-[var(--warning-ghost)] text-octo-warning" : "bg-transparent text-octo-sage hover:text-octo-ivory",
              ].join(" ")}
            >
              Action
            </button>
          </div>
        </div>

        {/* ── Hero prompt ────────────────────────────────────────────── */}
        <div className="px-[18px] pb-[6px] pt-[16px]">
          <textarea
            value={promptBody}
            onChange={(e) => setPromptBody(e.target.value)}
            placeholder="Describe this role's job. The agent reads this as its core instruction."
            aria-label="Role prompt"
            rows={5}
            className="w-full resize-none border-none bg-transparent font-serif text-[17px] leading-relaxed text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
        </div>

        {/* ── Brief ("Octopus reads your role as...") ─────────────────── */}
        <div className="mx-[18px] border-t border-octo-hairline pb-[4px] pt-[13px]">
          <p className="mb-[9px] font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute">
            Octopus reads your role as
          </p>
          <p className="text-[14px] leading-[2.0] text-octo-sage">
            {isAction ? (
              <>
                An{" "}
                <ChipMenu
                  label="Action"
                  warn
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Environment</p>
                      {(["worktree", "action"] as const).map((env) => (
                        <button
                          key={env}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { selectEnvironment(env); close(); }}
                        >
                          {env === environment && <span className="text-octo-brass">✓ </span>}
                          {env}
                        </button>
                      ))}
                    </>
                  )}
                />{" "}
                role that may{" "}
                <ChipMenu
                  label="commit, push & release"
                  warn
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Tools</p>
                      {TOOL_KEYS.map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { toggleTool(t); close(); }}
                        >
                          {tools.has(t) && <span className="text-octo-brass">✓ </span>}
                          {t}
                        </button>
                      ))}
                    </>
                  )}
                />
                , runs on{" "}
                <ChipMenu
                  label={substrate.toUpperCase()}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Substrate</p>
                      {(["api", "cli"] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setSubstrate(s); close(); }}
                        >
                          {s === substrate && <span className="text-octo-brass">✓ </span>}
                          {s.toUpperCase()}
                        </button>
                      ))}
                    </>
                  )}
                />
                , and{" "}
                <ChipMenu
                  label={checkpoint ? "pauses for approval" : "runs unattended"}
                  warn
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Checkpoint</p>
                      {([true, false] as const).map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setCheckpoint(v); close(); }}
                        >
                          {v === checkpoint && <span className="text-octo-brass">✓ </span>}
                          {v ? "pause for approval" : "run unattended"}
                        </button>
                      ))}
                    </>
                  )}
                />{" "}
                before it runs. Produces a{" "}
                <ChipMenu
                  label={ARTIFACT_LABELS[artifactKind]}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Artifact kind</p>
                      {(["plan", "review", "diff", "tests", "note"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setArtifactKind(k); close(); }}
                        >
                          {k === artifactKind && <span className="text-octo-brass">✓ </span>}
                          {k}
                        </button>
                      ))}
                    </>
                  )}
                />
                .
              </>
            ) : (
              <>
                A{" "}
                <ChipMenu
                  label={ARTIFACT_LABELS[artifactKind]}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Artifact kind</p>
                      {(["plan", "review", "diff", "tests", "note"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setArtifactKind(k); close(); }}
                        >
                          {k === artifactKind && <span className="text-octo-brass">✓ </span>}
                          {k}
                        </button>
                      ))}
                    </>
                  )}
                />{" "}
                role that works in the{" "}
                <ChipMenu
                  label="worktree"
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Environment</p>
                      {(["worktree", "action"] as const).map((env) => (
                        <button
                          key={env}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { selectEnvironment(env); close(); }}
                        >
                          {env === environment && <span className="text-octo-brass">✓ </span>}
                          {env}
                        </button>
                      ))}
                    </>
                  )}
                />
                , uses{" "}
                <ChipMenu
                  label={toolsLabel}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Default tools</p>
                      {TOOL_KEYS.map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => toggleTool(t)}
                        >
                          {tools.has(t) ? (
                            <span className="text-octo-brass">✓ </span>
                          ) : (
                            <span className="opacity-0">✓ </span>
                          )}
                          {t}
                          {t === "run_command" && !tools.has(t) && (
                            <span className="ml-auto font-mono text-[9px] text-octo-mute">click to add</span>
                          )}
                        </button>
                      ))}
                      <div className="h-px bg-octo-hairline" />
                      <button
                        type="button"
                        role="menuitem"
                        className={MENU_ITEM}
                        onClick={() => close()}
                      >
                        Done
                      </button>
                    </>
                  )}
                />
                , and{" "}
                <ChipMenu
                  label={canLoop ? "loops back" : "runs once"}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Loop behavior</p>
                      {([true, false] as const).map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setCanLoop(v); close(); }}
                        >
                          {v === canLoop && <span className="text-octo-brass">✓ </span>}
                          {v ? "can loop back when it finds problems" : "runs once and finishes"}
                        </button>
                      ))}
                    </>
                  )}
                />{" "}
                when it finds problems. Runs on{" "}
                <ChipMenu
                  label={substrate.toUpperCase()}
                  menu={(close) => (
                    <>
                      <p className={MENU_HEADER}>Substrate</p>
                      {(["api", "cli"] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM}
                          onClick={() => { setSubstrate(s); close(); }}
                        >
                          {s === substrate && <span className="text-octo-brass">✓ </span>}
                          {s.toUpperCase()}
                        </button>
                      ))}
                    </>
                  )}
                />
                .
              </>
            )}
          </p>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="mt-[10px] flex items-center gap-[10px] border-t border-octo-hairline px-[18px] py-[14px]">
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className="rounded-lg border border-octo-brass bg-transparent px-[15px] py-[8px] font-serif text-[14px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save role"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-octo-hairline bg-transparent px-[13px] py-[8px] font-mono text-[12px] text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage"
          >
            Cancel
          </button>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-octo-mute">global library · reusable anywhere</span>
        </div>

        {error && (
          <p className="mx-[18px] mb-[12px] font-mono text-[11px] text-octo-rouge">{error}</p>
        )}
      </div>
    </ModalShell>
  );
}
