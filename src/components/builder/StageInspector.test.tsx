import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";

// ModelPicker (rendered by the escalate-model control) fetches providers on
// mount — stub it so these tests don't reach real Tauri IPC.
const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../../lib/ipc");
  return {
    ...actual,
    ipc: { ...actual.ipc, listProviders: vi.fn().mockResolvedValue([]), claudeCliVersion: cliVersionMock },
  };
});

const { StageInspector } = await import("./StageInspector");
const { newStageData } = await import("./graph");
const { resetClaudeCliVersionCache } = await import("../../lib/claudeCli");

beforeEach(() => {
  resetClaudeCliVersionCache();
  cliVersionMock.mockReset();
  cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
});
import type { StageNode, StageNodeData } from "./graph";

function mkNode(over: Partial<StageNodeData>): StageNode {
  return { id: "n1", type: "stage", position: { x: 0, y: 0 }, data: { ...newStageData("implement"), ...over } };
}

const noopLoop = { target: null, max: 2, mode: "gated" as const };

function renderInspector(over: Partial<StageNodeData>, onPatch = vi.fn()) {
  render(
    <StageInspector
      node={mkNode(over)}
      ancestors={[]}
      loop={noopLoop}
      onPatch={onPatch}
      onSetLoop={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onPatch;
}

describe("StageInspector — escalate on failure", () => {
  it("shows '— none —' when no escalation model is set", () => {
    renderInspector({ escalateModel: null });
    expect(screen.getByText("— none —")).toBeTruthy();
  });

  it("clears the escalation model back to none", () => {
    const onPatch = renderInspector({ escalateModel: "claude-opus-4-6" });
    fireEvent.click(screen.getByLabelText("Clear escalation model"));
    expect(onPatch).toHaveBeenCalledWith({ escalateModel: null });
  });

  it("round-trips the escalate effort on an API stage", () => {
    const onPatch = renderInspector({ substrate: "api", escalateEffort: null });
    fireEvent.click(screen.getByRole("button", { name: /escalate on failure/i }));
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    fireEvent.click(within(group).getByText("High"));
    expect(onPatch).toHaveBeenCalledWith({ escalateEffort: "high" });
  });

  it("reflects the active escalate effort", () => {
    renderInspector({ substrate: "api", escalateEffort: "max" });
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    expect(within(group).getByText("Max").getAttribute("aria-checked")).toBe("true");
  });

  it("enables the escalate effort on a Claude Code CLI stage", () => {
    const onPatch = renderInspector({ substrate: "cli", agentModel: "claude-sonnet-5-5" });
    fireEvent.click(screen.getByRole("button", { name: /escalate on failure/i }));
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    expect(group.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(within(group).getByText("Max"));
    expect(onPatch).toHaveBeenCalledWith({ escalateEffort: "max" });
  });

  it("disables the escalate effort on a Codex CLI stage", () => {
    renderInspector({ substrate: "cli", agentModel: "gpt-5-codex" });
    fireEvent.click(screen.getByRole("button", { name: /escalate on failure/i }));
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
  });

  it("judges the escalate effort on the escalation model", () => {
    renderInspector({ substrate: "cli", agentModel: "claude-sonnet-5-5", escalateModel: "gpt-5" });
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("StageInspector — reasoning on CLI stages", () => {
  it("passes a Claude Code stage's effort, with Auto for the CLI's default", () => {
    const onPatch = renderInspector({ substrate: "cli", agentModel: "claude-opus-5-5", effort: null });
    const group = screen.getByRole("radiogroup", { name: "Reasoning effort" });
    expect(group.getAttribute("aria-disabled")).not.toBe("true");
    expect(within(group).getByText("Auto").getAttribute("aria-checked")).toBe("true");
    expect(within(group).queryByText("Off")).toBeNull();
    fireEvent.click(within(group).getByText("High"));
    expect(onPatch).toHaveBeenCalledWith({ effort: "high" });
  });

  it("keeps Off on an API stage", () => {
    renderInspector({ substrate: "api", effort: null });
    const group = screen.getByRole("radiogroup", { name: "Reasoning effort" });
    expect(within(group).getByText("Off").getAttribute("aria-checked")).toBe("true");
  });

  it("disables reasoning on a Codex stage and says why", () => {
    renderInspector({ substrate: "cli", agentModel: "gpt-5-codex" });
    const group = screen.getByRole("radiogroup", { name: "Reasoning effort" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText("Codex manages its own reasoning.")[0].closest("[aria-hidden='true']")).toBeNull();
    // No Claude Code default applies on Codex, so no Auto segment or its tooltip.
    expect(within(group).queryByText("Auto")).toBeNull();
    expect(within(group).getByText("Off")).toBeTruthy();
    expect(group.querySelector("[title=\"Claude Code's own default effort for this model\"]")).toBeNull();
  });

  it("hides reasoning on a Claude Code older than the floor, folding the hint in", async () => {
    const hint = "Update Claude Code (2.1.314 or newer) to set reasoning on this stage.";
    cliVersionMock.mockResolvedValue({ version: "2.1.307", floor: "2.1.314", belowFloor: true });
    renderInspector({ substrate: "cli", agentModel: "claude-opus-5-5" });
    // Mounted from the start inside a Reveal, so it folds in rather than appearing.
    await waitFor(() => expect(screen.getAllByText(hint)[0].closest("[aria-hidden='true']")).toBeNull());
    const group = screen.getByRole("radiogroup", { name: "Reasoning effort", hidden: true });
    expect(group.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("keeps the old-CLI hint folded away on a current Claude Code", async () => {
    renderInspector({ substrate: "cli", agentModel: "claude-opus-5-5" });
    await waitFor(() => expect(cliVersionMock).toHaveBeenCalled());
    const hint = screen.getAllByText(/to set reasoning on this stage\./)[0];
    expect(hint.closest("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("StageInspector — escalation disclosure", () => {
  it("collapses escalation by default on an unconfigured stage", () => {
    renderInspector({ escalateModel: null, escalateEffort: null });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens when the stage already has an escalation model", () => {
    renderInspector({ escalateModel: "claude-opus-4-6" });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles open on click", () => {
    renderInspector({ escalateModel: null, escalateEffort: null });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
