import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { OctoStatus, roleForActivity } from "./OctoStatus";
import type { LiveTool } from "../../stores/chatStore";

const tool = (toolName: string, done = false): LiveTool =>
  ({ callId: "c1", toolName, toolInput: {}, startedAt: "", done }) as LiveTool;

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
    const { container } = render(
      <OctoStatus streaming={false} hasError={false} streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the role label and body class while streaming", () => {
    const { container, getByText } = render(
      <OctoStatus streaming hasError={false} streamBuffer="" liveTools={[tool("Grep")]} approvals={0} />,
    );
    expect(getByText("Searching…")).toBeTruthy();
    expect(container.querySelector(".octo-mascot--search")).not.toBeNull();
  });

  it("waiting label renders in brass", () => {
    const { getByText } = render(
      <OctoStatus streaming hasError={false} streamBuffer="" liveTools={[]} approvals={2} />,
    );
    expect(getByText("Waiting for you").className).toContain("text-octo-brass");
  });

  it("plays the ✓ beat then unmounts when streaming ends cleanly", () => {
    const { container, rerender } = render(
      <OctoStatus streaming hasError={false} streamBuffer="x" liveTools={[]} approvals={0} />,
    );
    rerender(
      <OctoStatus streaming={false} hasError={false} streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.querySelector(".octo-mascot--pushed-beat")).not.toBeNull();
    act(() => vi.advanceTimersByTime(800));
    expect(container.firstChild).toBeNull();
  });

  it("skips the beat on error — just leaves", () => {
    const { container, rerender } = render(
      <OctoStatus streaming hasError={false} streamBuffer="x" liveTools={[]} approvals={0} />,
    );
    rerender(
      <OctoStatus streaming={false} hasError streamBuffer="" liveTools={[]} approvals={0} />,
    );
    expect(container.querySelector(".octo-mascot--pushed-beat")).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(container.firstChild).toBeNull();
  });
});
