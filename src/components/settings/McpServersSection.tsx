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
  Globe,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { McpFailure, McpServerConfig } from "../../lib/types";
import { tourId } from "../../lib/tour/ids";
import { copyToClipboard } from "../../lib/clipboard";
import { pushToast } from "../Toasts";
import { Reveal } from "../primitives/Reveal";
import { McpServerForm, iconButtonClass } from "./McpServerForm";
import { configFromDraft, draftFrom, emptyDraft, type Draft } from "./mcpDraft";

export { parseEnv, draftFrom } from "./mcpDraft";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "reconnecting" }
  | { kind: "ok"; tools: number; reconnected: boolean }
  | { kind: "error"; failure: McpFailure };

/** Which form is open: adding a server, or editing the one named `original`. */
type FormState = { mode: "add" } | { mode: "edit"; original: string };

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
 * Settings UI for the MCP servers Octopush connects to (their tools show up
 * in the TALK chat): a local command, or a remote URL the backend reaches
 * through the mcp-remote bridge it builds (`mcp::remote`). Reads/writes
 * `~/.claude/mcp.json` (a save restarts every server whose entry changed for
 * Talk) and offers per row a "Test connection" that spawns the server and
 * lists its tools, a Reconnect that also drops Talk's cached connection, so
 * its next call starts afresh, and an Edit that reopens the form on the saved
 * entry. One form is open at a time.
 *
 * A failed Test or Reconnect shows the backend's classified failure
 * (`McpFailure`): a summary and hint, with the redacted output behind a
 * "Details" disclosure that can be selected and copied.
 *
 * Project-level `.claude/mcp.json` in a repo is also honored at runtime but
 * is edited in the repo, not here.
 */
export function McpServersSection() {
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

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
      // The entries as saved: a remote entry's bridge is built by the backend.
      const saved = await ipc.saveMcpConfig(next);
      if (saved) setServers(saved);
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    }
  }

  function closeForm() {
    setForm(null);
    setDraft(emptyDraft());
  }

  function openAdd() {
    setDraft(emptyDraft());
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
    if (!key || (key !== original && servers[key])) return;
    // Keeps any field the form doesn't show.
    const config = configFromDraft(draft, original ? servers[original] : undefined);
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

  async function clearSignIn(key: string) {
    const config = servers[key];
    if (!config) return;
    try {
      const removed = await ipc.clearMcpSignIn(key, config);
      pushToast(
        removed > 0
          ? { level: "success", title: "Sign-in cleared", body: "The next connection opens your browser to sign in again." }
          : { level: "info", title: "No saved sign-in for this server" },
      );
    } catch (e) {
      pushToast({ level: "error", title: "Couldn't clear the sign-in", body: String(e) });
    }
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
  const formFor = (mode: FormState) => {
    const original = mode.mode === "edit" ? mode.original : null;
    const oauth = original !== null && servers[original]?.remote?.auth === "oauth";
    return (
      <McpServerForm
        draft={draft}
        onChange={setDraft}
        original={original}
        taken={(name) => name !== original && !!servers[name]}
        onSave={() => void saveForm()}
        onCancel={closeForm}
        onClearSignIn={oauth && original ? () => void clearSignIn(original) : undefined}
      />
    );
  };

  return (
    <div className="mt-10">
      <SectionLabel>MCP Servers</SectionLabel>
      <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
        Model Context Protocol servers whose tools become available to Talk: a
        local command Octopush runs, or a remote URL it reaches through{" "}
        <span className="font-mono text-octo-sage">mcp-remote</span>, which npx
        fetches the first time (Node required).
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
                {cfg.remote ? (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[11px] text-octo-mute">
                    <span title="Remote server" className="flex shrink-0 items-center">
                      <Globe size={11} aria-label="Remote server" />
                    </span>
                    <span className="truncate" title={cfg.remote.url}>{cfg.remote.url}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-mute">
                    {cfg.command} {cfg.args.join(" ")}
                  </span>
                )}
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
          data-tour="settings-mcp-add"
          className="mt-3 flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:border-[var(--brass-dim)] hover:text-octo-brass disabled:opacity-40"
        >
          <Plus size={12} /> Add MCP server
        </button>
      )}
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
