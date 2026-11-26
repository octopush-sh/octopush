/**
 * Tests for the Appearance theme picker: cards render from the theme list with
 * title-case names, legacy themes sit in their own group, the
 * active theme is marked, selecting a card applies it, and the card carries no
 * hex caption (the swatch is the preview — Minimalism doctrine).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ThemeConfig } from "../../lib/types";
import { useThemeStore } from "../../stores/themeStore";
import { AppearancePane } from "./AppearancePane";

function theme(name: string, accent: string): ThemeConfig {
  return {
    name,
    bg: "#0c0a08", panel: "#14110d", panel2: "#1a160f", border: "#2a2419",
    accent, accentDim: "#e8c39a",
    text: "#f4ecdb", textDim: "#95897a", textMuted: "#8c7f6c",
    success: "#8fc9a8", warning: "#dfae4a", danger: "#d18b8b",
  } as ThemeConfig;
}

// Ids exactly as theme.rs ships them — lowercase, hyphenated.
const ATELIER = theme("atelier", "#d4a574");
const VELLUM = theme("vellum", "#b08968");
const PORCELAIN = theme("porcelain-indigo", "#d4a5b8");
const MIDNIGHT = theme("midnight", "#58a6ff");
const SOLARIZED = theme("solarized-dark", "#268bd2");

const applyMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  useThemeStore.setState({ themes: [ATELIER, VELLUM], theme: ATELIER, apply: applyMock });
});

describe("AppearancePane — theme cards", () => {
  it("renders a card per theme, named in title case", () => {
    render(<AppearancePane />);
    expect(screen.getByText("Atelier")).toBeInTheDocument();
    expect(screen.getByText("Vellum")).toBeInTheDocument();
    expect(screen.queryByText("atelier")).not.toBeInTheDocument();
  });

  it("lists legacy themes in their own group and says so in the lead", () => {
    useThemeStore.setState({ themes: [ATELIER, PORCELAIN, MIDNIGHT, SOLARIZED] });
    const { container } = render(<AppearancePane />);
    const legacy = container.querySelector('[data-tour="settings-appearance-legacy"]')!;
    expect(legacy).not.toBeNull();
    expect(within(legacy as HTMLElement).getByText("Midnight")).toBeInTheDocument();
    expect(within(legacy as HTMLElement).getByText("Solarized Dark")).toBeInTheDocument();
    expect(within(legacy as HTMLElement).queryByText("Atelier")).not.toBeInTheDocument();
    expect(screen.getByText("Porcelain & Indigo")).toBeInTheDocument();
    expect(screen.getByText(/legacy themes are listed below/i)).toBeInTheDocument();
  });

  it("does not mention legacy themes when none are listed", () => {
    const { container } = render(<AppearancePane />);
    expect(container.querySelector('[data-tour="settings-appearance-legacy"]')).toBeNull();
    expect(screen.queryByText(/legacy/i)).not.toBeInTheDocument();
  });

  it("selecting a legacy card applies it", () => {
    useThemeStore.setState({ themes: [ATELIER, MIDNIGHT] });
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole("button", { name: /Midnight/ }));
    expect(applyMock).toHaveBeenCalledWith(MIDNIGHT);
  });

  it("marks the active theme and not the others", () => {
    render(<AppearancePane />);
    expect(screen.getByRole("button", { name: /Atelier/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Vellum/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("selecting a card applies that theme", () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole("button", { name: /Vellum/ }));
    expect(applyMock).toHaveBeenCalledWith(VELLUM);
  });

  it("does not print a hex accent caption", () => {
    render(<AppearancePane />);
    expect(screen.queryByText(/accent #/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/#d4a574/i)).not.toBeInTheDocument();
  });
});
