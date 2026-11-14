/** Settings › Models — brass marks the selection only; the add actions are ghost buttons. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn(async () => [
      { name: "anthropic", apiBase: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", models: [], enabled: true, protocol: "anthropic", local: false },
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
      expect(btn.className).toContain("border-octo-hairline");
      expect(btn.className).toContain("text-octo-sage");
      expect(btn.className).not.toContain("text-octo-brass");
      expect(btn.style.background).toBe("");
    }
  });
});
