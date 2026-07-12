import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
import { useMascotState } from "./useMascotState";
import { useAttentionStore } from "../stores/attentionStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";

describe("useMascotState", () => {
  beforeEach(() => {
    useAttentionStore.setState({ flagsByWs: {} });
    useChatStore.setState({ streamingByWs: {} });
    useRunsStore.setState({ runsByWs: {} });
  });

  it("is idle when nothing is happening", () => {
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("idle");
  });

  it("is working when a chat is streaming", () => {
    useChatStore.setState({ streamingByWs: { ws1: true } });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("working");
    expect(result.current.label).toContain("working");
  });

  it("is working when a Direct run is active", () => {
    useRunsStore.setState({
      runsByWs: { ws1: [{ status: "running" } as never] },
    });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("working");
  });

  it("blocked (needs you) beats working", () => {
    useChatStore.setState({ streamingByWs: { ws1: true } });
    useAttentionStore.setState({
      flagsByWs: { ws2: { kind: "chat", at: Date.now() } },
    });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("blocked");
    expect(result.current.label).toContain("need");
  });

  it("a paused Direct run counts as needs-you, not working", () => {
    useRunsStore.setState({
      runsByWs: { ws1: [{ status: "paused" } as never] },
    });
    const { result } = renderHook(() => useMascotState());
    expect(result.current.state).toBe("blocked");
  });
});
