// Fixtures shared by several scenarios.
import type { ThemeConfig } from "../../../src/lib/types";

/** The built-in "atelier" theme exactly as `get_theme` returns it (values
 *  mirror src-tauri/src/theme.rs — this is backend data, not UI styling). */
export const ATELIER: ThemeConfig = {
  name: "atelier",
  bg: "#0c0a08",
  panel: "#14110d",
  panel2: "#1a160f",
  border: "#2a2419",
  borderStrong: "#786747",
  accent: "#d4a574",
  accentDim: "#e8c39a",
  success: "#8fc9a8",
  warning: "#dfae4a",
  danger: "#d18b8b",
  text: "#f4ecdb",
  textDim: "#95897a",
  textMuted: "#8c7f6c",
  terminalBg: "#0c0a08",
};

/** A fixed clock so recordings are reproducible. */
export const NOW = "2026-10-28T15:00:00Z";
