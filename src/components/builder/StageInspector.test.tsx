import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// ModelPicker (rendered by the escalate-model control) fetches providers on
// mount — stub it so these tests don't reach real Tauri IPC.
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../../lib/ipc");
  return { ...actual, ipc: { ...actual.ipc, listProviders: vi.fn().mockResolvedValue([]) } };
});

const { StageInspector } = await import("./StageInspector");
const { newStageData } = await import("./graph");
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

  it("disables the escalate-effort control for a CLI stage (effort is API-only)", () => {
    renderInspector({ substrate: "cli" });
    fireEvent.click(screen.getByRole("button", { name: /escalate on failure/i }));
    const group = screen.getByRole("radiogroup", { name: "Escalation effort" });
    expect(group.getAttribute("aria-disabled")).toBe("true");
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
