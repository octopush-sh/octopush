// Settings tab identifiers — shared between Settings.tsx (renders tabs) and
// App.tsx (decides which tab to open via keyboard / palette).

export type SettingsTab =
  | "general"
  | "editor"
  | "models"
  | "appearance"
  | "usage"
  | "shortcuts"
  | "privacy"
  | "integrations"
  | "about";

export const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "editor",
  "models",
  "appearance",
  "usage",
  "shortcuts",
  "privacy",
  "integrations",
  "about",
];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  editor: "Editor",
  models: "Models",
  appearance: "Appearance",
  usage: "Usage",
  shortcuts: "Shortcuts",
  privacy: "Privacy",
  integrations: "Integrations",
  about: "About",
};

// Grouped navigation — the structural fix. Each group is a category eyebrow over
// its items, replacing the old flat list. Order here is render order.
export interface SettingsGroup {
  label: string;
  tabs: SettingsTab[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { label: "Setup", tabs: ["general", "editor"] },
  { label: "Intelligence", tabs: ["models", "usage"] },
  { label: "Connections", tabs: ["integrations"] },
  { label: "App", tabs: ["appearance", "shortcuts", "privacy", "about"] },
];
