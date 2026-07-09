// Settings — the shell. Owns the overlay, the grouped left nav, and the pane
// router. Each pane lives in its own focused module under ./settings.
import { useEffect, useState } from "react";
import {
  SETTINGS_GROUPS,
  SETTINGS_TAB_LABELS,
  type SettingsTab,
} from "../lib/settingsTabs";
import { GeneralPane } from "./settings/GeneralPane";
import { EditorPane } from "./settings/EditorPane";
import { ModelsPane } from "./settings/ModelsPane";
import { AppearancePane } from "./settings/AppearancePane";
import { UsagePane } from "./settings/UsagePane";
import { ShortcutsPane } from "./settings/ShortcutsPane";
import { PrivacyPane } from "./settings/PrivacyPane";
import { IntegrationsPane } from "./settings/IntegrationsPane";
import { AboutPane } from "./settings/AboutPane";
import { AccountPane } from "./settings/AccountPane";
import { OverlayRoom, RoomClose } from "./primitives/OverlayRoom";

interface Props {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
  onIssueTrackerConfigSaved?: () => void;
}

export function Settings({ open, initialTab = "general", onClose, onIssueTrackerConfigSaved }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // When (re)opened, jump to the requested tab.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  if (!open) return null;

  return (
    <OverlayRoom onClose={onClose} ariaLabel="Settings">
      {/* Header */}
      <header className="flex items-baseline gap-4 border-b border-octo-hairline px-8 py-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
          Preferences
        </span>
        <h1 className="font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Octopus</h1>
        <RoomClose onClose={onClose} label="Close settings" />
      </header>

      {/* Body: grouped nav + pane */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="flex w-[200px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-octo-hairline px-3 py-6">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
                {group.label}
              </div>
              {group.tabs.map((t) => (
                <TabButton
                  key={t}
                  label={SETTINGS_TAB_LABELS[t]}
                  active={tab === t}
                  onClick={() => setTab(t)}
                />
              ))}
            </div>
          ))}
        </aside>

        {/* Pane — keyed so the active pane crossfades when the tab changes, and
            scroll resets to top on switch. */}
        <main key={tab} className="octo-fade-in flex-1 overflow-y-auto px-10 py-8">
          {tab === "general" && <GeneralPane />}
          {tab === "editor" && <EditorPane />}
          {tab === "models" && <ModelsPane />}
          {tab === "appearance" && <AppearancePane />}
          {tab === "usage" && <UsagePane />}
          {tab === "shortcuts" && <ShortcutsPane />}
          {tab === "privacy" && <PrivacyPane />}
          {tab === "integrations" && <IntegrationsPane onConfigSaved={onIssueTrackerConfigSaved} />}
          {tab === "account" && <AccountPane />}
          {tab === "about" && <AboutPane />}
        </main>
      </div>
    </OverlayRoom>
  );
}

function TabButton({ label, active, onClick }: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="mb-0.5 flex w-full items-baseline rounded-md px-3 py-1.5 text-left transition"
      style={
        active
          ? { background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }
          : { border: "1px solid transparent" }
      }
    >
      <span
        className={
          active
            ? "font-serif text-[14px] text-octo-brass"
            : "font-sans text-[13px] text-octo-sage hover:text-octo-ivory"
        }
      >
        {label}
      </span>
    </button>
  );
}
