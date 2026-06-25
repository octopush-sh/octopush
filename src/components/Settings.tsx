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
import { isModalOpen } from "./ModalShell";

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

  // Esc closes Settings. Registered in the capture phase and consuming the event
  // so it never reaches the webview/OS — otherwise, in a maximized (macOS
  // full-screen) window, Escape would exit full-screen instead of closing
  // Settings. Defers to any ModalShell dialog stacked on top, which runs its own
  // Escape handler (e.g. the add-model dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isModalOpen()) return; // a dialog on top handles its own Escape
      // Always consume the event so a maximized (macOS full-screen) window
      // never exits full-screen on Escape.
      e.preventDefault();
      // If focus is in a field, let that field's own Escape run (e.g. cancel an
      // inline edit) and leave Settings open — don't hijack it.
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-octo-bg"
      data-tauri-drag-region
      style={{
        // --brass-faint is the accent at 4% alpha, re-derived per theme by
        // themeStore — so the wash follows the active palette instead of
        // staying Atelier-brass under a legacy theme.
        background:
          "radial-gradient(ellipse at 20% 10%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 border-b border-octo-hairline px-8 py-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
          Preferences
        </span>
        <h1 className="font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Octopus</h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="ml-auto rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute hover:text-octo-brass"
        >
          ESC · CLOSE
        </button>
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
    </div>
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
