import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  GENESIS_CTA_INK_PRIMED,
  GENESIS_CTA_INK_RECEDED,
  GENESIS_LINK_CLASS,
  GenesisPrompt,
} from "./GenesisPrompt";
import { composite, contrastRatio, hexToRgb } from "../lib/contrast";
// `?raw`, as in lib/themePalette.drift.test.ts: the real palettes, not a copy.
import themeRs from "../../src-tauri/src/theme.rs?raw";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn(),
    getSettings: vi.fn(),
    saveProviders: vi.fn(),
    saveSettings: vi.fn(),
    getDefaultProviders: vi.fn(),
    listModels: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
const m = {
  listProviders: vi.mocked(ipc.listProviders),
  getSettings: vi.mocked(ipc.getSettings),
  saveProviders: vi.mocked(ipc.saveProviders),
  saveSettings: vi.mocked(ipc.saveSettings),
  getDefaultProviders: vi.mocked(ipc.getDefaultProviders),
  listModels: vi.mocked(ipc.listModels),
};

const anthropic = (enabled: boolean) => ({
  name: "anthropic", apiBase: "", apiKeyEnv: "", models: [], enabled, protocol: "anthropic", local: false,
});

function settings(key?: string) {
  return { providerKeys: key ? { anthropic: key } : {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.saveProviders.mockResolvedValue(undefined);
  m.saveSettings.mockResolvedValue(undefined);
  m.listModels.mockResolvedValue([
    { provider: "anthropic", model: { id: "claude-opus-4-8" } },
    { provider: "anthropic", model: { id: "claude-sonnet-4-6" } },
    { provider: "openai", model: { id: "gpt-5" } },
  ] as never);
});

describe("GenesisPrompt pre-flight", () => {
  it("a cold user (no key) sees the inline key field; saving it goes through the shared provider path", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    render(<GenesisPrompt onSubmit={vi.fn()} />);
    const field = await screen.findByLabelText("Anthropic API key");
    fireEvent.change(field, { target: { value: "sk-ant-xxx" } });
    // Once saved, crewProviderReady re-check must see the enabled provider + key.
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    fireEvent.click(screen.getByText("Wake the crew"));
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    // Enabled anthropic persisted + the key merged into settings.
    expect(m.saveProviders.mock.calls[0][0].find((p) => p.name === "anthropic")?.enabled).toBe(true);
    expect(m.saveSettings.mock.calls[0][0].providerKeys.anthropic).toBe("sk-ant-xxx");
    // The key field goes away once ready.
    await waitFor(() =>
      expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument(),
    );
  });

  it("a cold user who typed a key but pressed the CTA gets it saved BEFORE genesis proceeds", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    await screen.findByLabelText("Anthropic API key");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-yyy" } });
    // After the save the re-check should be ready.
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-yyy"));
    // Press the CTA WITHOUT clicking "Wake the crew" — the key must persist first.
    fireEvent.click(screen.getByText("Set a crew on it"));
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Order: key saved, THEN genesis proceeds (no Settings detour).
    expect(m.saveSettings.mock.calls[0][0].providerKeys.anthropic).toBe("sk-ant-yyy");
  });

  it("a cold user with NO key still proceeds (the honest Settings fallback path)", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    await screen.findByLabelText("Anthropic API key");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.click(screen.getByText("Set a crew on it"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(m.saveProviders).not.toHaveBeenCalled(); // nothing to save
  });

  it("a cold user gets ONE primary CTA, in the ceremonial recipe in every state (#758)", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    render(<GenesisPrompt onSubmit={vi.fn()} onSketch={vi.fn()} />);
    await screen.findByLabelText("Anthropic API key");
    // Exactly one action button beside the field and the brief (the sketch link aside).
    const buttons = () =>
      screen.getAllByRole("button").filter((b) => !/think it through first/i.test(b.textContent ?? ""));
    expect(buttons()).toHaveLength(1);
    const cta = buttons()[0];
    expect(cta).toHaveTextContent("Set a crew on it");
    // The frame is the same in every state; only the ink moves.
    const frame = ["font-serif", "border-[var(--brass-dim)]", "bg-[var(--brass-ghost)]"];
    // Receded: sage at rest (AA, #818), brass/50 only while disabled.
    const receded = () => {
      expect(cta).toHaveClass(...frame, "text-octo-sage", "disabled:text-octo-brass/50");
      expect(cta).not.toHaveClass("text-octo-brass");
      expect(cta).not.toHaveAttribute("data-primed");
    };
    const primed = () => {
      expect(cta).toHaveClass(...frame, "text-octo-brass");
      expect(cta).not.toHaveClass("text-octo-sage");
      expect(cta).toHaveAttribute("data-primed", "true");
    };
    // Disabled with nothing to do: the frame, receded ink. No opacity on the
    // whole button (#585).
    expect(cta).toBeDisabled();
    receded();
    expect(cta.className).not.toMatch(/uppercase|font-mono|(^|\s)(disabled:)?opacity/);

    // A brief without a key: the honest fallback stays clickable, but receded.
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    expect(cta).toBeEnabled();
    receded();

    // Brief + a typed key: full brass ink.
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-zzz" } });
    expect(buttons()).toHaveLength(1);
    expect(cta).toHaveTextContent("Set a crew on it");
    primed();
  });

  it("with a stored key, a brief alone gives the CTA full brass ink", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    render(<GenesisPrompt onSubmit={vi.fn()} />);
    await screen.findByLabelText("Crew model");
    const cta = screen.getByRole("button", { name: "Set a crew on it" });
    expect(cta).toHaveClass("text-octo-sage"); // no brief yet
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    expect(cta).toHaveClass("border-[var(--brass-dim)]", "bg-[var(--brass-ghost)]", "text-octo-brass");
    expect(cta).not.toHaveClass("text-octo-sage");
  });

  it("a disabled genesis link drops to mute ink", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    render(<GenesisPrompt onSubmit={vi.fn()} onSketch={vi.fn()} />);
    await screen.findByLabelText("Crew model");
    const link = screen.getByRole("button", { name: /think it through first/i });
    expect(link).toBeDisabled(); // no brief yet
    expect(link).toHaveClass("text-octo-sage", "disabled:text-octo-mute", "disabled:hover:text-octo-mute");
    expect(GENESIS_LINK_CLASS).not.toMatch(/disabled:hover:text-octo-sage/);
  });

  it("every secondary route shares one ink and one underline (#758)", () => {
    expect(GENESIS_LINK_CLASS).toMatch(/(^|\s)text-octo-sage(\s|$)/);
    expect(GENESIS_LINK_CLASS).toMatch(/hover:text-octo-ivory/);
    expect(GENESIS_LINK_CLASS).not.toMatch(/(^|\s)text-octo-ivory(\s|$)|opacity/);
  });

  it("with a key but no brief, the same CTA reads 'Wake the crew' and only saves the key", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    await screen.findByLabelText("Anthropic API key");
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-zzz" } });
    const cta = screen.getByRole("button", { name: "Wake the crew" });
    expect(cta).toHaveClass("bg-[var(--brass-ghost)]", "text-octo-brass");
    expect(cta).toHaveAttribute("data-primed", "true");
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-zzz"));
    fireEvent.click(cta);
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Set a crew on it" })).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("host links share one quiet line with 'or think it through first'", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    render(
      <GenesisPrompt
        onSubmit={vi.fn()}
        onSketch={vi.fn()}
        links={[<button key="a" type="button">Begin a new study</button>]}
      />,
    );
    const sketch = screen.getByRole("button", { name: /think it through first/i });
    const study = screen.getByRole("button", { name: "Begin a new study" });
    expect(sketch.parentElement).toBe(study.parentElement);
    await screen.findByLabelText("Crew model");
  });

  it("'or think it through first' reads as a link, like its siblings", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    render(<GenesisPrompt onSubmit={vi.fn()} onSketch={vi.fn()} />);
    const link = screen.getByRole("button", { name: /think it through first/i });
    expect(link).toHaveClass("underline", "text-octo-sage");
    expect(link).not.toHaveClass("text-octo-mute", "text-octo-ivory");
    await screen.findByLabelText("Crew model");
  });

  it("a ready user can pick a model, which is passed to onSubmit", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    // Model picker appears (anthropic models only).
    await screen.findByLabelText("Crew model");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.click(screen.getByText("Set a crew on it"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Default (no explicit pick) → null model.
    expect(onSubmit.mock.calls[0][2]).toBeNull();
  });
});

describe("GenesisPrompt CTA contrast (#818)", () => {
  /** One built-in theme's colours, read from theme.rs (the drift gate in
   *  lib/themePalette.drift.test.ts keeps that literal list in one shape). */
  function theme(name: string): Record<string, string> {
    const start = themeRs.indexOf(`name: "${name}".into(),`);
    expect(start, `${name} must exist in theme.rs`).toBeGreaterThan(-1);
    const block = themeRs.slice(start, themeRs.indexOf("},", start));
    return Object.fromEntries(
      [...block.matchAll(/^\s*([a-z_0-9]+): "(#[0-9a-fA-F]{6})"\.into\(\),/gm)].map((x) => [x[1], x[2]]),
    );
  }
  const FIELD: Record<string, string> = { brass: "accent", sage: "text_dim", mute: "text_muted", ivory: "text" };
  /** The resting (unprefixed) `text-octo-<token>[/alpha]` of an ink constant. */
  function restingInk(ink: string): { token: string; alpha: number } {
    const m = ink.match(/(?:^|\s)text-octo-([a-z]+)(?:\/(\d+))?(?=\s|$)/);
    expect(m, `a resting ink in "${ink}"`).not.toBeNull();
    return { token: m![1], alpha: m![2] ? Number(m![2]) / 100 : 1 };
  }

  for (const name of ["atelier", "vellum"]) {
    for (const [label, ink] of [
      ["receded (a brief, no key)", GENESIS_CTA_INK_RECEDED],
      ["primed", GENESIS_CTA_INK_PRIMED],
    ] as const) {
      it(`the enabled ${label} ink clears AA on the brass-ghost frame in ${name}`, () => {
        const t = theme(name);
        const accent = hexToRgb(t.accent)!;
        const { token, alpha } = restingInk(ink);
        // Welcome sits on the canvas ground, New project on a panel.
        for (const ground of [t.bg, t.panel]) {
          const frame = composite(accent, 0.08, hexToRgb(ground)!); // --brass-ghost
          const text = composite(hexToRgb(t[FIELD[token]])!, alpha, frame);
          expect(contrastRatio(text, frame), `${token}/${alpha} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("disabled stays visibly different from the enabled receded ink", () => {
    const disabled = GENESIS_CTA_INK_RECEDED.match(/(?:^|\s)disabled:text-octo-([a-z]+(?:\/\d+)?)(?=\s|$)/);
    expect(disabled).not.toBeNull();
    const { token, alpha } = restingInk(GENESIS_CTA_INK_RECEDED);
    expect(disabled![1]).not.toBe(alpha === 1 ? token : `${token}/${alpha * 100}`);
  });
});
