// Settings → Integrations → Issue tracking. A master-detail over the supported
// trackers: pick a provider on the left, configure its connection and per-project
// links on the right. Jira and Epiku (read-only, #1127) are wired; Linear and
// Azure DevOps are shown as upcoming so the layout is honestly built to scale
// (linking depends on the tracker, so project links live inside the tracker's
// own detail, not beside it).
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { tourId } from "../../lib/tour/ids";
import type { EpikuConfigView, ProjectInfo } from "../../lib/types";
import { pushToast } from "../Toasts";
import { MidTruncate } from "../primitives/MidTruncate";
import { SectionLabel } from "./shared";

// Sentinel shown in the API-token field when a saved token is loaded; if the
// user submits without editing the field we substitute the original token so
// the bullets aren't persisted as the actual credential.
const MASKED_TOKEN_PLACEHOLDER = "••••••••••••••••";

type TrackerId = "jira" | "epiku" | "linear" | "azure";

interface Tracker {
  id: TrackerId;
  name: string;
  available: boolean;
}

const TRACKERS: Tracker[] = [
  { id: "jira", name: "Jira", available: true },
  { id: "epiku", name: "Epiku", available: true },
  { id: "linear", name: "Linear", available: false },
  { id: "azure", name: "Azure DevOps", available: false },
];

export function IssueTrackingSection({ onConfigSaved }: { onConfigSaved?: () => void }) {
  const [selected, setSelected] = useState<TrackerId>("jira");
  // Whether Jira has a saved connection — drives the status dot honestly, so an
  // unconfigured tracker doesn't read as connected. Seeded from the saved config
  // and updated when the detail saves.
  const [jiraConnected, setJiraConnected] = useState(false);
  // Epiku reads as connected only once a read of its project answered.
  const epiku = useEpikuConnection();

  useEffect(() => {
    ipc.getIssueTrackerConfig()
      .then((cfg) => setJiraConnected(!!(cfg?.baseUrl && cfg?.apiToken)))
      .catch(() => { /* leave as not-connected */ });
  }, []);

  return (
    <div>
      <SectionLabel>Issue tracking</SectionLabel>
      <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
        Connect a tracker so Octopush can surface your backlog and the ticket chip, and link each
        project to it.
      </p>

      <div className="grid grid-cols-[190px_1fr] gap-5">
        {/* Master — tracker list */}
        <div className="flex flex-col gap-1">
          {TRACKERS.map((t) => (
            <TrackerListItem
              key={t.id}
              tracker={t}
              active={selected === t.id}
              connected={t.id === "jira" ? jiraConnected : t.id === "epiku" && epiku.status.kind === "connected"}
              onSelect={t.available ? () => setSelected(t.id) : undefined}
              dataTour={t.id === "epiku" ? tourId("settings-integrations-epiku") : undefined}
            />
          ))}
        </div>

        {/* Detail — dispatched on the selection so adding a real tracker later
            can't silently render Jira's form under another tracker's name. */}
        <div className="min-w-0">
          {selected === "jira" ? (
            <JiraDetail onConfigSaved={onConfigSaved} onConnectedChange={setJiraConnected} />
          ) : selected === "epiku" ? (
            // Remounted when a saved connection appears or goes, so the form
            // starts from it.
            <EpikuDetail key={epiku.config ? "saved" : "new"} connection={epiku} onConfigSaved={onConfigSaved} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TrackerListItem({ tracker, active, connected, onSelect, dataTour }: {
  tracker: Tracker;
  active: boolean;
  connected: boolean;
  onSelect?: () => void;
  dataTour?: string;
}) {
  const disabled = !tracker.available;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      data-tour={dataTour}
      title={disabled ? `${tracker.name} — coming soon` : connected ? `${tracker.name} — connected` : undefined}
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors duration-[180ms] ${
        disabled ? "cursor-default" : ""
      }`}
      style={{
        background: active ? "var(--brass-ghost)" : "transparent",
        border: active ? "1px solid var(--brass-dim)" : "1px solid transparent",
      }}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: connected ? "var(--color-octo-verdigris)" : "var(--color-octo-hairline)" }}
      />
      <span
        className={`flex-1 truncate font-serif text-[14px] ${
          disabled ? "text-octo-mute" : active ? "text-octo-brass" : "text-octo-ivory"
        }`}
      >
        {tracker.name}
      </span>
      {disabled && (
        <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.2em] text-octo-mute">Soon</span>
      )}
    </button>
  );
}

function JiraDetail({ onConfigSaved, onConnectedChange }: {
  onConfigSaved?: () => void;
  onConnectedChange?: (connected: boolean) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const originalTokenRef = useRef("");

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [mapDrafts, setMapDrafts] = useState<Record<string, string>>({});
  const [mapSaving, setMapSaving] = useState<Record<string, boolean>>({});
  const [mapSaved, setMapSaved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    ipc.getIssueTrackerConfig()
      .then((cfg) => {
        if (cfg) {
          setBaseUrl(cfg.baseUrl ?? "");
          setEmail(cfg.email ?? "");
          if (cfg.apiToken) {
            originalTokenRef.current = cfg.apiToken;
            setApiToken(MASKED_TOKEN_PLACEHOLDER);
          }
        }
      })
      .catch(() => { /* quiet — the form still renders empty */ });
  }, []);

  useEffect(() => {
    ipc.listRecentProjects()
      .then((rows) => {
        setProjects(rows);
        const drafts: Record<string, string> = {};
        for (const p of rows) drafts[p.id] = p.jiraProjectKey ?? "";
        setMapDrafts(drafts);
      })
      .catch(() => { /* quiet — connection section still renders */ });
  }, []);

  async function saveMapping(projectId: string) {
    const value = (mapDrafts[projectId] ?? "").trim();
    setMapSaving((s) => ({ ...s, [projectId]: true }));
    try {
      await ipc.updateProjectJiraKey(projectId, value === "" ? null : value);
      setMapSaved((s) => ({ ...s, [projectId]: true }));
      setTimeout(() => setMapSaved((s) => ({ ...s, [projectId]: false })), 2000);
    } catch (e) {
      pushToast({ level: "error", title: "Save link failed", body: String(e) });
    } finally {
      setMapSaving((s) => ({ ...s, [projectId]: false }));
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const tokenToSave =
        apiToken === MASKED_TOKEN_PLACEHOLDER ? originalTokenRef.current : apiToken;
      await ipc.saveIssueTrackerConfig({ baseUrl, email, apiToken: tokenToSave });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onConnectedChange?.(!!(baseUrl.trim() && tokenToSave));
      onConfigSaved?.();
      // Fire-and-forget: refresh the backlog immediately so the RUN Companion
      // populates without waiting for a re-mount.
      const { useIssuesStore } = await import("../../stores/issuesStore");
      useIssuesStore.getState().load();
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="octo-fade-in">
      <div className="flex items-baseline gap-2.5">
        <h3 className="font-serif text-[17px] text-octo-ivory">Jira</h3>
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Cloud</span>
      </div>
      <p className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
        Read-only access for the backlog and ticket chip. The token lives on this machine in
        ~/.octopush/settings.json.
      </p>

      {/* Connection */}
      <div className="mt-4 space-y-3">
        <Field label="Base URL">
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-company.atlassian.net"
            className={inputClass}
          />
        </Field>
        <Field label="Email">
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@your-company.com"
            className={inputClass}
          />
        </Field>
        <Field label="API token">
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="API token"
              className={`${inputClass} pr-12`}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        <div className="pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex min-w-[140px] items-center justify-center gap-1.5 rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {saved && <Check size={13} />}
            {saved ? "Saved" : saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Project links */}
      <div className="mt-6">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">Project links</div>
        <p className="mb-3 text-[12px] leading-[1.55] text-octo-sage">
          Map each project to its Jira project key. Empty = inferred from the workspace branch.
        </p>
        {projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-octo-hairline px-3 py-4 text-center font-serif text-[12px] text-octo-mute">
            No projects opened yet.
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3">
                {/* The name takes the width the key input leaves (a definite
                    `flex-1 min-w-0` box) and is MIDDLE-truncated: sibling projects
                    share their head (`octopush-enterprise-…`), so the tail is what
                    tells the rows apart (design-system E1). The wrapper must be a
                    FLEX box: as a block, the inline-flex MidTruncate box is sized
                    from its own unbreakable text, spills under the key input and
                    is hard-cut with no ellipsis (#757). */}
                <div
                  className="flex min-w-0 flex-1 text-[13px] text-octo-ivory"
                  title={p.name}
                  data-tour={i === 0 ? tourId("settings-integrations-project-link") : undefined}
                >
                  <MidTruncate text={p.name} />
                </div>
                <div className="w-[200px] min-w-[96px] shrink">
                  <input
                    type="text"
                    value={mapDrafts[p.id] ?? ""}
                    onChange={(e) => setMapDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                    placeholder="Project key"
                    className={inputClass}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveMapping(p.id)}
                  disabled={mapSaving[p.id]}
                  aria-label={`Save the link for ${p.name}`}
                  className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md border border-octo-border-strong px-3 py-2 font-serif text-[12px] text-octo-sage transition-colors hover:text-octo-ivory disabled:opacity-50"
                >
                  {mapSaved[p.id] ? <Check size={12} /> : null}
                  {mapSaved[p.id] ? "Saved" : mapSaving[p.id] ? "Saving…" : "Save the link"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type EpikuStatus =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "connected"; stories: number }
  | { kind: "failed"; reason: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^other: /, "");

/** The saved Epiku connection and its "Connected" gate: one read of the
 *  project's stories with the kept token (`check_epiku_connection`). */
function useEpikuConnection() {
  const [config, setConfig] = useState<EpikuConfigView | null>(null);
  const [status, setStatus] = useState<EpikuStatus>({ kind: "none" });
  async function check() {
    setStatus({ kind: "checking" });
    try {
      setStatus({ kind: "connected", stories: await ipc.checkEpikuConnection() });
    } catch (e) {
      setStatus({ kind: "failed", reason: errorText(e) });
    }
  }
  useEffect(() => {
    ipc.getEpikuConfig()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg?.hasToken) void check();
      })
      .catch(() => { /* leave as not set up */ });
  }, []);
  return { config, setConfig, status, setStatus, check };
}

function EpikuDetail({ connection, onConfigSaved }: {
  connection: ReturnType<typeof useEpikuConnection>;
  onConfigSaved?: () => void;
}) {
  const { config, setConfig, status, setStatus, check } = connection;
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [project, setProject] = useState(config?.project ?? "");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  async function afterChange() {
    onConfigSaved?.();
    const { useIssuesStore } = await import("../../stores/issuesStore");
    const issues = useIssuesStore.getState();
    await issues.setProject(issues.projectId);
    void issues.load();
  }

  async function handleSave() {
    setSaving(true);
    try {
      const view = await ipc.saveEpikuConfig(baseUrl, project, token.trim() === "" ? null : token);
      setConfig(view);
      setBaseUrl(view.baseUrl);
      setToken("");
      await check();
      await afterChange();
    } catch (e) {
      pushToast({ level: "error", title: "Epiku wasn't saved", body: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleForget() {
    try {
      await ipc.removeEpikuConfig();
      setConfig(null);
      setStatus({ kind: "none" });
      await afterChange();
    } catch (e) {
      pushToast({ level: "error", title: "Epiku wasn't removed", body: errorText(e) });
    }
  }

  return (
    <div className="octo-fade-in">
      <div className="flex items-baseline gap-2.5">
        <h3 className="font-serif text-[17px] text-octo-ivory">Epiku</h3>
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Read-only</span>
      </div>
      <p className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
        Octopush reads the project&apos;s stories for the backlog and the ticket chip, and never writes to
        Epiku. Requests carry only the token, the project id and a story or epic id. The token is kept in
        the macOS Keychain.
      </p>

      <div className="mt-4 space-y-3">
        <Field label="Base URL">
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://epiku.your-domain.com"
            className={inputClass}
          />
        </Field>
        <Field label="Project">
          <input
            type="text"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="your-project"
            className={inputClass}
          />
        </Field>
        <Field label="Token">
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={config?.hasToken ? "Kept in the Keychain. Leave blank to keep it" : "Epiku token"}
              aria-label="Epiku token"
              className={`${inputClass} pr-12`}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        <div
          data-tour="settings-epiku-status"
          aria-live="polite"
          className={`min-h-[16px] font-mono text-[10px] ${
            status.kind === "connected" ? "text-octo-verdigris" : status.kind === "failed" ? "text-octo-rouge" : "text-octo-mute"
          }`}
        >
          {status.kind === "connected" && `Connected · ${status.stories} ${status.stories === 1 ? "story" : "stories"}`}
          {status.kind === "checking" && "Checking the connection…"}
          {status.kind === "failed" && `Not connected: ${status.reason}`}
          {status.kind === "none" && "Not connected yet."}
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex min-w-[140px] items-center justify-center gap-1.5 rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {saving ? "Connecting…" : "Save and connect"}
          </button>
          {config && (
            <button
              type="button"
              onClick={() => void handleForget()}
              className="octo-fade-in rounded-md border border-octo-border-strong px-3 py-2 font-serif text-[12px] text-octo-sage transition-colors hover:text-octo-ivory"
            >
              Forget this connection
            </button>
          )}
        </div>
        <p className="text-[12px] leading-[1.55] text-octo-mute">
          A project reads Epiku once you choose it in the project&apos;s menu, under Issue tracking.
        </p>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">{label}</div>
      {children}
    </div>
  );
}
