/** Settings › Models — brass marks the selection only; the add actions are ghost buttons. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn(async () => [
      {
        name: "anthropic", apiBase: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", enabled: true, protocol: "anthropic", local: false,
        models: [
          { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", inputCostPerM: 3, outputCostPerM: 15, maxContext: 200000 },
          { id: "claude-haiku-5-5", displayName: "Haiku 5.5", inputCostPerM: 1, outputCostPerM: 5, maxContext: 200000 },
        ],
      },
      { name: "openai", apiBase: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", models: [], enabled: true, protocol: "openai-compatible", local: false },
    ]),
    getSettings: vi.fn(async () => ({})),
  },
}));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));
vi.mock("./ModelTiersSection", () => ({ ModelTiersSection: () => <div /> }));

const { ModelsPane } = await import("./ModelsPane");

describe("ModelsPane — brass budget", () => {
  it("renders the add actions as ghost buttons, keeping brass on the selected provider", async () => {
    const { container } = render(<ModelsPane />);
    const selected = await screen.findByRole("button", { pressed: true });
    expect(selected.querySelector(".text-octo-brass")).not.toBeNull();

    for (const id of ["settings-models-add-provider", "settings-models-add-model"]) {
      const btn = container.querySelector(`[data-tour="${id}"]`) as HTMLElement;
      expect(btn).not.toBeNull();
      expect(btn.className).toContain("font-serif");
      expect(btn.className).toContain("border-octo-border-strong");
      expect(btn.className).not.toContain("border-octo-hairline");
      expect(btn.className).toContain("text-octo-sage");
      expect(btn.className).not.toContain("text-octo-brass");
      expect(btn.style.background).toBe("");
    }
  });
});

describe("ModelsPane — model rows", () => {
  it("lists models as plain rows on one hairline, with no frame per row", async () => {
    const { container } = render(<ModelsPane />);
    await screen.findByText("claude-sonnet-5-5");
    const list = container.querySelector('[data-tour="settings-models-list"]') as HTMLElement;
    expect(list.className).toContain("divide-y");
    expect(list.className).toContain("divide-octo-hairline");
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).not.toMatch(/(^|\s)(border|rounded-md|bg-octo-onyx)(\s|$)/);
      expect(row.className).not.toContain("border-octo-hairline");
    }
  });

  it("renders edit and remove as borderless quiet icon buttons, shown on hover or focus", async () => {
    render(<ModelsPane />);
    const edit = await screen.findByRole("button", { name: "Edit model claude-sonnet-5-5" });
    const remove = screen.getByRole("button", { name: "Remove model claude-sonnet-5-5" });
    for (const btn of [edit, remove]) {
      expect(btn).toHaveAttribute("title", btn.getAttribute("aria-label"));
      expect(btn.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(btn.className).not.toContain("border-octo-hairline");
      expect(btn.className).toContain("text-octo-mute");
      expect(btn.className).toContain("hover:bg-[var(--brass-ghost)]");
      expect(btn.querySelector("svg")?.getAttribute("width")).toBe("12");
    }
    const actions = edit.closest('[data-testid="model-row-actions"]') as HTMLElement;
    expect(actions.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(actions.className).toContain("group-hover:opacity-100");
    expect(actions.className).toContain("focus-within:opacity-100");
    expect(actions.closest("li")?.className).toMatch(/(^|\s)group(\s|$)/);
  });
});
