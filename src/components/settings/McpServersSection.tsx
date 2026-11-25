import { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Loader2,
  Check,
  AlertTriangle,
  RefreshCw,
  Pencil,
  ChevronRight,
  Copy,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { McpFailure, McpServerConfig } from "../../lib/types";
import { tourId } from "../../lib/tour/ids";
import { copyToClipboard } from "../../lib/clipboard";
import { pushToast } from "../Toasts";
import { Reveal } from "../primitives/Reveal";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "reconnecting" }
  | { kind: "ok"; tools: number; reconnected: boolean }
  | { kind: "error"; failure: McpFailure };

/** The add/edit form's fields, as typed. */
interface Draft {
  name: string;
  command: string;
  argsText: string;
  envText: string;
}

/** Which form is open: adding a server, or editing the one named `original`. */
type FormState = { mode: "add" } | { mode: "edit"; original: string };

const EMPTY_DRAFT: Draft = { name: "", command: "", argsText: "", envText: "" };

const inputClass =
  "w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass";
const labelClass =
  "mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute";
const iconButtonClass =
  "flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-40";

/** Parse a "KEY=value" textarea into an env map (blank/##-comment lines skipped). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

/** A saved server as the form's fields (the inverse of `parseEnv` and the
 *  one-arg-per-line split). */
export function draftFrom(name: string, cfg: McpServerConfig): Draft {
  return {
    name,
    command: cfg.command,
    argsText: cfg.args.join("\n"),
    envText: Object.entries(cfg.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

/** A Test/Reconnect rejection as a failure to show. The backend sends a
 *  classified `McpFailure`; anything else (an IPC error) is its own text. */
export function mcpFailureFrom(e: unknown): McpFailure {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (o["kind"] === "McpFailure" && typeof o["summary"] === "string") {
      return {
        summary: o["summary"],
        hint: typeof o["hint"] === "string" ? o["hint"] : null,
        detail: typeof o["detail"] === "string" ? o["detail"] : "",
      };
    }
  }
  const text = (e instanceof Error ? e.message : String(e)).trim();
  return { summary: text.split("\n")[0] || "The server failed to connect.", hint: null, detail: text };
}

/**
 * Settings UI for the stdio MCP servers Octopush connects to (their tools show
 * up in the TALK chat). Reads/writes `~/.claude/mcp.json` (a save restarts
 * every server whose entry changed for Talk) and offers per row a "Test
 * connection" that spawns the server and lists its tools, a Reconnect that
 * also drops Talk's cached connection, so its next call starts afresh, and an
 * Edit that reopens the form on the saved entry. One form is open at a time.
 *
 * A failed Test or Reconnect shows the backend's classified failure
 * (`McpFailure`): a summary and hint, with the redacted output behind a
 * "Details" disclosure that can be selected and copied.
 *
 * Remote servers need a stdio bridge — use `npx mcp-remote <url>` as the
 * command. Project-level `.claude/mcp.json` in a repo is also honored at
 * runtime but is edited in the repo, not here.
 */
export function McpServersSection() {
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  useEffect(() => {
    // Defensive: tolerate environments where the ipc method is absent.
    Promise.resolve(ipc.getMcpConfig?.())
      .then((cfg) => setServers(cfg ?? {}))
      .catch((e) => pushToast({ level: "error", title: "Couldn't load MCP config", body: String(e) }))
      .finally(() => setLoaded(true));
  }, []);

  async function persist(next: Record<string, McpServerConfig>) {
    setServers(next);
    try {
      await ipc.saveMcpConfig(next);
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    }
  }

  function closeForm() {
    setForm(null);
    setDraft(EMPTY_DRAFT);
  }

  function openAdd() {
    setDraft(EMPTY_DRAFT);
    setForm({ mode: "add" });
  }

  function openEdit(key: string) {
    const cfg = servers[key];
    if (!cfg) return;
    setDraft(draftFrom(key, cfg));
    setForm({ mode: "edit", original: key });
  }

  /** Add the drafted server, or replace the edited one (a rename drops the
   *  old name). The save resets every changed entry for Talk. */
  async function saveForm() {
    if (!form) return;
    const key = draft.name.trim();
    const original = form.mode === "edit" ? form.original : null;
    if (!key || !draft.command.trim() || (key !== original && servers[key])) return;
    const config: McpServerConfig = {
      // Keep any field the form doesn't show.
      ...(original ? servers[original] : {}),
      command: draft.command.trim(),
      args: draft.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
      env: parseEnv(draft.envText),
    };
    const next = { ...servers };
    if (original) delete next[original];
    next[key] = config;
    // An old result no longer describes the saved entry.
    setTests((s) => {
      const t = { ...s };
      if (original) delete t[original];
      delete t[key];
      return t;
    });
    closeForm();
    await persist(next);
  }

  async function removeServer(key: string) {
    const next = { ...servers };
    delete next[key];
    await persist(next);
  }

  async function testServer(key: string) {
    const config = servers[key];
    if (!config) return;
    setTests((s) => ({ ...s, [key]: { kind: "testing" } }));
    try {
      const tools = await ipc.testMcpServer(key, config);
      setTests((s) => ({ ...s, [key]: { kind: "ok", tools: tools.length, reconnected: false } }));
    } catch (e) {
      setTests((s) => ({ ...s, [key]: { kind: "error", failure: mcpFailureFrom(e) } }));
    }
  }

  async function reconnectServer(key: string) {
    const config = servers[key];
    if (!config) return;
    setTests((s) => ({ ...s, [key]: { kind: "reconnecting" } }));
    try {
      const tools = await ipc.reconnectMcpServer(key, config);
      setTests((s) => ({ ...s, [key]: { kind: "ok", tools: tools.length, reconnected: true } }));
    } catch (e) {
      setTests((s) => ({ ...s, [key]: { kind: "error", failure: mcpFailureFrom(e) } }));
    }
  }

  if (!loaded) return null;

  const entries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  const formFor = (mode: FormState) => (
    <ServerForm
      draft={draft}
      onChange={setDraft}
      original={mode.mode === "edit" ? mode.original : null}
      taken={(name) => name !== (mode.mode === "edit" ? mode.original : null) && !!servers[name]}
      onSave={() => void saveForm()}
      onCancel={closeForm}
    />
  );

  return (
    <div className="mt-10">
      <SectionLabel>MCP Servers</SectionLabel>
      <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
        Local (stdio) Model Context Protocol servers whose tools become available
        to Talk. For a remote/OAuth server use a bridge as the
        command — <span className="font-mono text-octo-sage">npx mcp-remote &lt;url&gt;</span>.
      </p>

      <div className="space-y-2">
        {entries.length === 0 && (
          <p className="text-[12px] text-octo-mute">No MCP servers configured.</p>
        )}
        {entries.map(([key, cfg], i) => {
          if (form?.mode === "edit" && form.original === key) {
            return <div key={key}>{formFor(form)}</div>;
          }
          const test = tests[key] ?? { kind: "idle" };
          const busy = test.kind === "testing" || test.kind === "reconnecting";
          return (
            <div key={key} className="rounded-md border border-octo-hairline bg-octo-panel px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[12px] text-octo-brass">{key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-mute">
                  {cfg.command} {cfg.args.join(" ")}
                </span>
                <button
                  type="button"
                  onClick={() => testServer(key)}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded border border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:border-[var(--brass-dim)] hover:text-octo-brass disabled:opacity-40"
                >
                  {test.kind === "testing" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : null}
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => reconnectServer(key)}
                  disabled={busy}
                  aria-label={`Reconnect ${key}`}
                  title="Reconnect: restart Talk's connection to this server, then test it"
                  data-tour={i === 0 ? tourId("settings-mcp-reconnect") : undefined}
                  className={iconButtonClass}
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(key)}
                  disabled={form !== null}
                  aria-label={`Edit ${key}`}
                  title="Edit server"
                  data-tour={i === 0 ? tourId("settings-mcp-edit") : undefined}
                  className={iconButtonClass}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => removeServer(key)}
                  aria-label={`Remove ${key}`}
                  title="Remove server"
                  className="flex items-center justify-center rounded p-1 text-octo-mute transition-colors hover:text-octo-rouge"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {test.kind === "reconnecting" && (
                <div className="octo-fade-in mt-1.5 text-[11px] text-octo-mute">Reconnecting…</div>
              )}
              {test.kind === "ok" && (
                <div className="octo-fade-in mt-1.5 flex items-center gap-1.5 text-[11px] text-octo-verdigris">
                  <Check size={12} />{" "}
                  {`${test.reconnected ? "Reconnected" : "Connected"} · ${test.tools} tool${test.tools === 1 ? "" : "s"}`}
                </div>
              )}
              {test.kind === "error" && <FailureLine failure={test.failure} />}
            </div>
          );
        })}
      </div>

      {form?.mode === "add" ? (
        <div className="mt-3">{formFor(form)}</div>
      ) : (
        <button
          type="button"
          onClick={openAdd}
          disabled={form !== null}
          className="mt-3 flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:border-[var(--brass-dim)] hover:text-octo-brass disabled:opacity-40"
        >
          <Plus size={12} /> Add MCP server
        </button>
      )}
    </div>
  );
}

/** The add/edit form. `original` is the edited server's saved name (null
 *  when adding); `taken` says whether a name belongs to another server. */
function ServerForm({
  draft,
  onChange,
  original,
  taken,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  original: string | null;
  taken: (name: string) => boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const name = draft.name.trim();
  const duplicate = !!name && taken(name);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <div
      className="octo-fade-in space-y-3 rounded-md border border-octo-hairline bg-octo-panel p-3"
      aria-label={original ? `Edit ${original}` : "Add an MCP server"}
      role="group"
    >
      <div>
        <div className={labelClass}>Name</div>
        <input
          className={inputClass}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="github"
          aria-label="Name"
        />
      </div>
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!name || !draft.command.trim() || duplicate}
          title={duplicate ? "A server with this name already exists" : undefined}
          className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition-colors disabled:opacity-40"
        >
          {original ? "Save changes" : "Add server"}
        </button>
        {duplicate && (
          <span className="font-mono text-[10px] text-octo-rouge">name already exists</span>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-ivory"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A failed Test/Reconnect: the summary and hint, then the full redacted
 *  output behind "Details", selectable, scrollable and copyable. It mounts
 *  afresh (details folded) with each result, since a run in flight hides it. */
function FailureLine({ failure }: { failure: McpFailure }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="octo-fade-in mt-1.5 text-[11px] leading-[1.5]">
      <div className="flex items-start gap-1.5 text-octo-rouge">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
        <div className="octo-selectable min-w-0">
          <div>{failure.summary}</div>
          {failure.hint && <div>{failure.hint}</div>}
        </div>
      </div>
      {failure.detail && (
        <div className="mt-1 pl-[18px]">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory"
          >
            <ChevronRight
              size={12}
              aria-hidden
              className={`transition-transform duration-[var(--dur-quick)] ease-[var(--ease-octo)] ${open ? "rotate-90" : ""}`}
            />
            Details
          </button>
          <Reveal open={open}>
            <div className="relative pt-1.5">
              <pre
                data-testid="mcp-failure-detail"
                className="octo-selectable max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-octo-onyx py-2 pl-3 pr-8 font-mono text-[11px] leading-[1.55] text-octo-sage"
              >
                {failure.detail}
              </pre>
              <button
                type="button"
                onClick={() => void copyToClipboard(failure.detail, "Output copied")}
                aria-label="Copy the full output"
                title="Copy the full output"
                className={`absolute right-1.5 top-3 ${iconButtonClass}`}
              >
                <Copy size={12} />
              </button>
            </div>
          </Reveal>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
      {children}
    </h2>
  );
}
