/**
 * Tests for the Appearance theme picker: cards render from the theme list, the
 * active theme is marked, selecting a card applies it, and the card carries no
 * hex caption (the swatch is the preview — Minimalism doctrine).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ThemeConfig } from "../../lib/types";
import { useThemeStore } from "../../stores/themeStore";
import { AppearancePane } from "./AppearancePane";

function theme(name: string, accent: string): ThemeConfig {
  return {
    name,
    bg: "#0c0a08", panel: "#14110d", panel2: "#1a160f", border: "#2a2419",
    accent, accentDim: "#e8c39a",
    text: "#f4ecdb", textDim: "#95897a", textMuted: "#6d6354",
    success: "#8fc9a8", warning: "#dfae4a", danger: "#d18b8b",
  } as ThemeConfig;
}

const ATELIER = theme("Atelier", "#d4a574");
const VELLUM = theme("Vellum", "#b08968");

const applyMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  useThemeStore.setState({ themes: [ATELIER, VELLUM], theme: ATELIER, apply: applyMock });
});

describe("AppearancePane — theme cards", () => {
  it("renders a card per theme", () => {
    render(<AppearancePane />);
    expect(screen.getByText("Atelier")).toBeInTheDocument();
    expect(screen.getByText("Vellum")).toBeInTheDocument();
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
