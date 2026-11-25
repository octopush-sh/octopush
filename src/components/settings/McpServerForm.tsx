// The MCP server add/edit form: a local command, or a remote URL that the
// backend reaches through the mcp-remote bridge it builds from these choices.
import { useState } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import { SegmentedControl } from "../controls/SegmentedControl";
import { Reveal } from "../primitives/Reveal";
import { FadeSwap } from "../primitives/FadeSwap";
import {
  draftComplete,
  draftProblem,
  looksSecret,
  type Draft,
  type HeaderRow,
  type RemoteAuth,
  type RemoteTransport,
  type ServerType,
} from "./mcpDraft";

export const inputClass =
  "w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass";
const labelClass = "mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute";
export const iconButtonClass =
  "flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-40";
const ghostButtonClass =
  "rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-ivory disabled:opacity-40";
const disclosureClass =
  "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory";

const TYPES: { value: ServerType; label: string; title: string }[] = [
  { value: "local", label: "Local command", title: "A command Octopush runs on this Mac" },
  { value: "remote", label: "Remote URL", title: "A server Octopush reaches over HTTP through mcp-remote" },
];
const SIGN_INS: { value: RemoteAuth; label: string; title: string }[] = [
  { value: "oauth", label: "Browser (OAuth)", title: "mcp-remote opens your browser to sign in" },
  { value: "token", label: "Token", title: "Sends Authorization: Bearer <token>" },
  { value: "headers", label: "Custom headers", title: "Sends the headers you list" },
];
const TRANSPORTS: { value: RemoteTransport; label: string; title: string }[] = [
  { value: "auto", label: "Automatic", title: "HTTP first, then SSE if the server needs it" },
  { value: "http-only", label: "HTTP only", title: "Streamable HTTP only" },
  { value: "sse-only", label: "SSE only", title: "Server-sent events only" },
];

/** The add/edit form. `original` is the edited server's saved name (null
 *  when adding); `taken` says whether a name belongs to another server.
 *  `onClearSignIn` is offered only for a saved Browser (OAuth) server. */
export function McpServerForm({
  draft,
  onChange,
  original,
  taken,
  onSave,
  onCancel,
  onClearSignIn,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  original: string | null;
  taken: (name: string) => boolean;
  onSave: () => void;
  onCancel: () => void;
  onClearSignIn?: () => void;
}) {
  const name = draft.name.trim();
  const duplicate = !!name && taken(name);
  const problem = duplicate ? "name already exists" : draftProblem(draft);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <div
      className="octo-fade-in space-y-3 rounded-md border border-octo-hairline bg-octo-panel p-3"
      aria-label={original ? `Edit ${original}` : "Add an MCP server"}
      role="group"
    >
      <div data-tour="settings-mcp-type">
        <SegmentedControl options={TYPES} value={draft.type} onChange={(type) => set({ type })} ariaLabel="Server type" />
      </div>
      <div>
        <div className={labelClass}>Name</div>
        <input
          className={inputClass}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder={draft.type === "remote" ? "example-remote" : "github"}
          aria-label="Name"
        />
      </div>

      <FadeSwap swapKey={draft.type} className="space-y-3">
        {draft.type === "local" ? <LocalFields draft={draft} set={set} /> : <RemoteFields draft={draft} set={set} />}
      </FadeSwap>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!draftComplete(draft) || !!problem}
          title={duplicate ? "A server with this name already exists" : undefined}
          className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition-colors disabled:opacity-40"
        >
          {original ? "Save changes" : "Add server"}
        </button>
        {problem && <span className="font-mono text-[10px] text-octo-rouge">{problem}</span>}
        <button type="button" onClick={onCancel} className={ghostButtonClass}>
          Cancel
        </button>
        {onClearSignIn && (
          <button
            type="button"
            onClick={onClearSignIn}
            title="Forget the browser sign-in saved for this server; its next connection signs in again"
            className={`ml-auto ${ghostButtonClass}`}
          >
            Clear sign-in
          </button>
        )}
      </div>
    </div>
  );
}

type Patch = (patch: Partial<Draft>) => void;

function LocalFields({ draft, set }: { draft: Draft; set: Patch }) {
  return (
    <>
      <div>
        <div className={labelClass}>Command</div>
        <input
          className={inputClass}
          value={draft.command}
          onChange={(e) => set({ command: e.target.value })}
          placeholder="npx"
          aria-label="Command"
        />
      </div>
      <div>
        <div className={labelClass}>Args (one per line)</div>
        <textarea
          className={`${inputClass} h-20 resize-none`}
          value={draft.argsText}
          onChange={(e) => set({ argsText: e.target.value })}
          placeholder={"-y\n@modelcontextprotocol/server-github"}
          aria-label="Args"
        />
      </div>
      <div>
        <div className={labelClass}>Env (KEY=value, one per line)</div>
        <textarea
          className={`${inputClass} h-16 resize-none`}
          value={draft.envText}
          onChange={(e) => set({ envText: e.target.value })}
          placeholder="GITHUB_TOKEN=ghp_…"
          aria-label="Env"
        />
      </div>
    </>
  );
}

function RemoteFields({ draft, set }: { draft: Draft; set: Patch }) {
  // Advanced starts open when it holds something.
  const [advanced, setAdvanced] = useState(
    () => !!draft.clientId || draft.transport !== "auto" || !!draft.extraArgsText.trim(),
  );
  return (
    <>
      <div>
        <div className={labelClass}>URL</div>
        <input
          className={inputClass}
          value={draft.url}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://mcp.example.com/mcp"
          aria-label="URL"
          spellCheck={false}
        />
      </div>
      <div>
        <div className={labelClass}>Sign-in</div>
        <SegmentedControl options={SIGN_INS} value={draft.auth} onChange={(auth) => set({ auth })} ariaLabel="Sign-in" />
      </div>
      <FadeSwap swapKey={draft.auth}>
        {draft.auth === "oauth" && (
          <p className="text-[11px] leading-[1.5] text-octo-mute">
            The first connection opens your browser to sign in; mcp-remote keeps the sign-in in ~/.mcp-auth.
          </p>
        )}
        {draft.auth === "token" && (
          <div>
            <div className={labelClass}>Token</div>
            <input
              type="password"
              autoComplete="off"
              className={inputClass}
              value={draft.token}
              onChange={(e) => set({ token: e.target.value })}
              placeholder="Paste the token"
              aria-label="Token"
            />
            <p className="mt-1 text-[11px] text-octo-mute">Sent as Authorization: Bearer &lt;token&gt;.</p>
          </div>
        )}
        {draft.auth === "headers" && <HeaderRows rows={draft.headers} onChange={(headers) => set({ headers })} />}
      </FadeSwap>
      <div>
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)} className={disclosureClass}>
          <ChevronRight
            size={12}
            aria-hidden
            className={`transition-transform duration-[var(--dur-quick)] ease-[var(--ease-octo)] ${advanced ? "rotate-90" : ""}`}
          />
          Advanced
        </button>
        <Reveal open={advanced}>
          <div className="space-y-3 pt-2">
            {draft.auth === "oauth" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className={labelClass}>OAuth client ID</div>
                  <input
                    className={inputClass}
                    value={draft.clientId}
                    onChange={(e) => set({ clientId: e.target.value })}
                    placeholder="For a server without automatic sign-in"
                    aria-label="OAuth client ID"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <div className={labelClass}>OAuth client secret</div>
                  <input
                    type="password"
                    autoComplete="off"
                    className={inputClass}
                    value={draft.clientSecret}
                    onChange={(e) => set({ clientSecret: e.target.value })}
                    placeholder="Only if one was issued"
                    aria-label="OAuth client secret"
                    disabled={!draft.clientId.trim()}
                  />
                </div>
              </div>
            )}
            <div>
              <div className={labelClass}>Transport</div>
              <SegmentedControl
                options={TRANSPORTS}
                value={draft.transport}
                onChange={(transport) => set({ transport })}
                ariaLabel="Transport"
              />
            </div>
            <div>
              <div className={labelClass}>Extra arguments (one per line)</div>
              <textarea
                className={`${inputClass} h-16 resize-none`}
                value={draft.extraArgsText}
                onChange={(e) => set({ extraArgsText: e.target.value })}
                placeholder={"--enable-proxy\n--resource\nhttps://api.example.com"}
                aria-label="Extra arguments"
                spellCheck={false}
              />
              <p className="mt-1 text-[11px] text-octo-mute">Added to the mcp-remote command line as written.</p>
            </div>
          </div>
        </Reveal>
      </div>
    </>
  );
}

function HeaderRows({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const update = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      <div className={labelClass}>Headers</div>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="octo-rise-in flex items-center gap-2">
            <div className="w-2/5 shrink-0">
              <input
                className={inputClass}
                value={row.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="X-Api-Key"
                aria-label={`Header ${i + 1} name`}
                spellCheck={false}
              />
            </div>
            <input
              // A value under a secret-looking name (Authorization, X-Api-Key, Cookie…) is masked.
              type={looksSecret(row.name) ? "password" : "text"}
              autoComplete="off"
              className={inputClass}
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder="value"
              aria-label={`Header ${i + 1} value`}
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ name: "", value: "" }])}
              aria-label={`Remove header ${i + 1}`}
              title="Remove header"
              className={iconButtonClass}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
        className={`mt-2 ${disclosureClass}`}
      >
        <Plus size={12} aria-hidden /> Add a header
      </button>
    </div>
  );
}
