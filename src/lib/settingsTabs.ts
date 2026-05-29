// Settings tab identifiers — shared between Settings.tsx (renders tabs) and
// App.tsx (decides which tab to open via keyboard / palette).

export type SettingsTab =
  | "general"
  | "models"
  | "appearance"
  | "usage"
  | "shortcuts"
  | "privacy"
  | "integrations"
  | "about";

export const SETTINGS_TABS: SettingsTab[] = [
  "general",
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
  models: "Models & Providers",
  appearance: "Appearance",
  usage: "Usage",
  shortcuts: "Shortcuts",
  privacy: "Privacy",
  integrations: "Integrations",
  about: "About",
};
