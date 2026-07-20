import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { OctoStatus, roleForActivity } from "./OctoStatus";
import type { LiveTool } from "../../stores/chatStore";

const tool = (toolName: string, done = false): LiveTool =>
  ({ callId: "c1", toolName, toolInput: {}, startedAt: "", done }) as LiveTool;

const base = {
  workspaceId: "ws-1",
  streaming: false,
  hasError: false,
  wasStopped: false,
  streamBuffer: "",
  liveTools: [] as LiveTool[],
  approvals: 0,
};

describe("roleForActivity", () => {
  it("approval beats everything", () => {
    const r = roleForActivity({ approvals: 1, liveTools: [tool("Bash")], streamBuffer: "x" });
    expect(r.key).toBe("wait");
    expect(r.label).toBe("Waiting for you");
  });
  it("maps tool families", () => {
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Read")], streamBuffer: "" }).key).toBe("read");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Grep")], streamBuffer: "" }).key).toBe("search");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Edit")], streamBuffer: "" }).key).toBe("edit");
    expect(roleForActivity({ approvals: 0, liveTools: [tool("Bash")], streamBuffer: "" }).key).toBe("run");
  });
  it("uses the newest not-done tool; done tools are ignored", () => {
    const r = roleForActivity({
      approvals: 0,
      liveTools: [tool("Read"), tool("Bash", true)],
      streamBuffer: "",
    });
    expect(r.key).toBe("read");
  });
  it("unknown tools fall back to Working… with the think body", () => {
    const r = roleForActivity({ approvals: 0, liveTools: [tool("FrobnicateX")], streamBuffer: "" });
    expect(r.key).toBe("work");
    expect(r.label).toBe("Working…");
    expect(r.bodyClass).toBe("octo-mascot--working");
  });
  it("buffer → write; nothing → think", () => {
    expect(roleForActivity({ approvals: 0, liveTools: [], streamBuffer: "hola" }).key).toBe("write");
    expect(roleForActivity({ approvals: 0, liveTools: [], streamBuffer: "" }).key).toBe("think");
  });
});

describe("OctoStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders nothing when idle", () => {
    const { container } = render(<OctoStatus {...base} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the role label and body class while streaming", () => {
    const { container, getByText } = render(
      <OctoStatus {...base} streaming liveTools={[tool("Grep")]} />,
    );
    expect(getByText("Searching…")).toBeTruthy();
    expect(container.querySelector(".octo-mascot--search")).not.toBeNull();
  });

  it("waiting label renders in brass", () => {
    const { getByText } = render(<OctoStatus {...base} streaming approvals={2} />);
    expect(getByText("Waiting for you").className).toContain("text-octo-brass");
  });

  it("plays the ✓ beat then unmounts when streaming ends cleanly", () => {
    const { container, rerender } = render(<OctoStatus {...base} streaming streamBuffer="x" />);
    rerender(<OctoStatus {...base} />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).not.toBeNull();
    act(() => vi.advanceTimersByTime(800));
    expect(container.firstChild).toBeNull();
  });

  it("skips the beat on error — just leaves", () => {
    const { container, rerender } = render(<OctoStatus {...base} streaming streamBuffer="x" />);
    rerender(<OctoStatus {...base} hasError />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(container.firstChild).toBeNull();
  });

  it("skips the beat when the user stopped the turn", () => {
    const { container, rerender } = render(<OctoStatus {...base} streaming streamBuffer="x" />);
    rerender(<OctoStatus {...base} wasStopped />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(container.firstChild).toBeNull();
  });

  it("switching workspace never plays a phantom beat — it hard-resets", () => {
    const { container, rerender } = render(<OctoStatus {...base} streaming streamBuffer="x" />);
    // Same render cycle delivers the new workspace id AND its idle state.
    rerender(<OctoStatus {...base} workspaceId="ws-2" />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("switching into a streaming workspace shows live immediately", () => {
    const { container, rerender } = render(<OctoStatus {...base} streaming streamBuffer="x" />);
    rerender(<OctoStatus {...base} workspaceId="ws-2" streaming liveTools={[tool("Read")]} />);
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    expect(container.querySelector(".octo-mascot--read")).not.toBeNull();
  });

  it("a role that flickers away and back within the crossfade never strands the label invisible", () => {
    // Chained Bash commands: Running… → (tool ends) Thinking… → (next command
    // starts <200ms later) Running…. The label must remain visible.
    const { getByText, rerender } = render(
      <OctoStatus {...base} streaming liveTools={[tool("Bash")]} />,
    );
    expect(getByText("Running…").className).toContain("opacity-100");
    rerender(<OctoStatus {...base} streaming liveTools={[]} />); // swap to Thinking… begins
    act(() => vi.advanceTimersByTime(80)); // …but the next command lands mid-swap
    rerender(<OctoStatus {...base} streaming liveTools={[tool("Bash")]} />);
    act(() => vi.advanceTimersByTime(400)); // give any pending swap time to settle
    expect(getByText("Running…").className).toContain("opacity-100");
  });
});
