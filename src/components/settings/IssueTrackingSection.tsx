// Settings → Integrations → Issue tracking. A master-detail over the supported
// trackers: pick a provider on the left, configure its connection and per-project
// links on the right. Only Jira is wired today; Linear and Azure DevOps are shown
// as upcoming so the layout is honestly built to scale (linking depends on the
// tracker, so project links live inside the tracker's own detail, not beside it).
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { ProjectInfo } from "../../lib/types";
import { pushToast } from "../Toasts";
import { SectionLabel } from "./shared";

// Sentinel shown in the API-token field when a saved token is loaded; if the
// user submits without editing the field we substitute the original token so
// the bullets aren't persisted as the actual credential.
const MASKED_TOKEN_PLACEHOLDER = "••••••••••••••••";

type TrackerId = "jira" | "linear" | "azure";

interface Tracker {
  id: TrackerId;
  name: string;
  available: boolean;
}

const TRACKERS: Tracker[] = [
  { id: "jira", name: "Jira", available: true },
  { id: "linear", name: "Linear", available: false },
  { id: "azure", name: "Azure DevOps", available: false },
];

export function IssueTrackingSection({ onConfigSaved }: { onConfigSaved?: () => void }) {
  const [selected, setSelected] = useState<TrackerId>("jira");
  // Whether Jira has a saved connection — drives the status dot honestly, so an
  // unconfigured tracker doesn't read as connected. Seeded from the saved config
  // and updated when the detail saves.
  const [jiraConnected, setJiraConnected] = useState(false);

  useEffect(() => {
    ipc.getIssueTrackerConfig()
      .then((cfg) => setJiraConnected(!!(cfg?.baseUrl && cfg?.apiToken)))
      .catch(() => { /* leave as not-connected */ });
  }, []);

  return (
    <div className="max-w-[820px]">
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
              connected={t.id === "jira" && jiraConnected}
              onSelect={t.available ? () => setSelected(t.id) : undefined}
            />
          ))}
        </div>

        {/* Detail — dispatched on the selection so adding a real tracker later
            can't silently render Jira's form under another tracker's name. */}
        <div className="min-w-0">
          {selected === "jira" ? (
            <JiraDetail onConfigSaved={onConfigSaved} onConnectedChange={setJiraConnected} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TrackerListItem({ tracker, active, connected, onSelect }: {
  tracker: Tracker;
  active: boolean;
  connected: boolean;
  onSelect?: () => void;
}) {
  const disabled = !tracker.available;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
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
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-3">
                <div className="w-[160px] shrink-0 truncate text-[13px] text-octo-ivory" title={p.name}>{p.name}</div>
                <input
                  type="text"
                  value={mapDrafts[p.id] ?? ""}
                  onChange={(e) => setMapDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder="Project key"
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => void saveMapping(p.id)}
                  disabled={mapSaving[p.id]}
                  aria-label={`Save link for ${p.name}`}
                  className="inline-flex min-w-[88px] items-center justify-center gap-1.5 rounded-md px-3 py-2 font-serif text-[12px] text-octo-brass transition-colors disabled:opacity-50"
                  style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
                >
                  {mapSaved[p.id] ? <Check size={12} /> : null}
                  {mapSaved[p.id] ? "Saved" : mapSaving[p.id] ? "Saving…" : "Save"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">{label}</div>
      {children}
    </div>
  );
}
