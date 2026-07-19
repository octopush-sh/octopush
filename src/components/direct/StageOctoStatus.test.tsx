import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { StageOctoStatus, roleForStage } from "./StageOctoStatus";
import type { LiveEntry, RunStage } from "../../lib/ipc";

const text = (t: string): LiveEntry => ({ kind: "text", text: t });
const toolE = (tool: string): LiveEntry => ({ kind: "tool", tool, hint: "" });
const result = (): LiveEntry => ({ kind: "tool_result", ok: true, detail: "" });

const stage = (status: RunStage["status"]): RunStage =>
  ({ id: 7, status }) as unknown as RunStage;

describe("roleForStage", () => {
  it("awaiting_checkpoint always waits, whatever the journal says", () => {
    expect(roleForStage([toolE("Bash")], "awaiting_checkpoint").key).toBe("wait");
  });
  it("acts the newest journal entry: tool families, prose, thought", () => {
    expect(roleForStage([toolE("Read")], "running").key).toBe("read");
    expect(roleForStage([toolE("Grep")], "running").key).toBe("search");
    expect(roleForStage([toolE("Bash")], "running").key).toBe("run");
    expect(roleForStage([text("planning the fix")], "running").key).toBe("write");
    expect(roleForStage([toolE("Read"), result()], "running").key).toBe("think");
    expect(roleForStage([], "running").key).toBe("think");
  });
  it("unknown tools fall back to Working…", () => {
    expect(roleForStage([toolE("Sorcery")], "running").label).toBe("Working…");
  });
});

describe("StageOctoStatus", () => {
  it("renders nothing for a pending stage", () => {
    const { container } = render(<StageOctoStatus stage={stage("pending")} entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
  it("narrates a running stage from its journal", () => {
    const { container, getByText } = render(
      <StageOctoStatus stage={stage("running")} entries={[toolE("Grep")]} />,
    );
    expect(getByText("Searching…")).toBeTruthy();
    expect(container.querySelector(".octo-mascot--search")).not.toBeNull();
  });
  it("a failed stage leaves without the ✓ beat", () => {
    const { container, rerender } = render(
      <StageOctoStatus stage={stage("running")} entries={[]} />,
    );
    rerender(<StageOctoStatus stage={stage("failed")} entries={[]} />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
  });
  it("a done stage earns the ✓ beat", () => {
    const { container, rerender } = render(
      <StageOctoStatus stage={stage("running")} entries={[]} />,
    );
    rerender(<StageOctoStatus stage={stage("done")} entries={[]} />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).not.toBeNull();
  });
});
