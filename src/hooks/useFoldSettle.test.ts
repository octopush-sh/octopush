import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TransitionEvent } from "react";
import { FOLD_SETTLE_FALLBACK_MS, SETTLED_FRAMES, useFoldSettle } from "./useFoldSettle";
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore";
import { useTerminalSlotsStore } from "../stores/terminalSlotsStore";

const settling = () => useTerminalLayoutStore.getState().settling;

function setup(mode = "run", strip = false) {
  return renderHook(({ mode, strip }: { mode: string; strip: boolean }) => useFoldSettle(mode, strip), {
    initialProps: { mode, strip },
  });
}

/** A `transitionend` on the gliding element itself. */
function glideEnd(propertyName = "width", own = true) {
  const el = document.createElement("div");
  return { target: own ? el : document.createElement("span"), currentTarget: el, propertyName } as unknown as TransitionEvent<HTMLElement>;
}

/** Enough animation frames for the slots to have kept still. */
const frames = () => act(() => void vi.advanceTimersByTime(16 * (SETTLED_FRAMES + 2)));
/** One animation frame. */
const frame = () => act(() => void vi.advanceTimersByTime(16));
/** A slot moving, as one does while the canvas's new width is published. */
const move = (width: number) =>
  act(() =>
    useTerminalSlotsStore.getState().publish("k", {
      mode: "run",
      terminalId: "t",
      rect: { left: 0, top: 0, width, height: 100 },
    }),
  );

describe("useFoldSettle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    useTerminalLayoutStore.setState({ settling: false, resizing: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    useTerminalLayoutStore.setState({ settling: false });
  });

  it("holds the PTYs from a mode switch that folds the Companion until its width glide ends", () => {
    const { result, rerender } = setup("run", false);
    expect(settling()).toBe(false);
    rerender({ mode: "talk", strip: true });
    expect(settling()).toBe(true);
    // A child's transition, or another property, is not the glide's end.
    act(() => result.current(glideEnd("width", false)));
    act(() => result.current(glideEnd("opacity")));
    frames();
    expect(settling()).toBe(true);
    act(() => result.current(glideEnd()));
    expect(settling()).toBe(true);
    frames();
    expect(settling()).toBe(false);
  });

  it("after the glide, waits for the slots to keep still before it lets go", () => {
    const { result, rerender } = setup("talk", true);
    rerender({ mode: "run", strip: false });
    act(() => result.current(glideEnd()));
    // The slots publish the new width over the next frames: still held.
    for (const w of [700, 650, 612]) {
      frame();
      move(w);
    }
    frame();
    expect(settling()).toBe(true);
    frames();
    expect(settling()).toBe(false);
  });

  it("releases on its own when the glide's end never arrives", () => {
    const { rerender } = setup("talk", true);
    rerender({ mode: "run", strip: false });
    expect(settling()).toBe(true);
    act(() => void vi.advanceTimersByTime(FOLD_SETTLE_FALLBACK_MS));
    frames();
    expect(settling()).toBe(false);
  });

  it("does not hold without a fold change, or for a fold that is not a mode switch", () => {
    const { rerender } = setup("run", true);
    rerender({ mode: "talk", strip: true }); // Run's panes → Talk's seat: no glide
    expect(settling()).toBe(false);
    rerender({ mode: "talk", strip: false }); // ⌘\ in Talk: refit via layoutVersion
    expect(settling()).toBe(false);
  });

  it("a release from an earlier switch does not end a newer hold", () => {
    const { result, rerender } = setup("run", false);
    rerender({ mode: "talk", strip: true });
    act(() => result.current(glideEnd()));
    rerender({ mode: "run", strip: false });
    frames();
    expect(settling()).toBe(true);
    act(() => result.current(glideEnd()));
    frames();
    expect(settling()).toBe(false);
  });

  it("holds with reduced motion too, where the width still lands after the switch", () => {
    const orig = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      const { result, rerender } = setup("run", false);
      rerender({ mode: "talk", strip: true });
      expect(settling()).toBe(true);
      act(() => result.current(glideEnd()));
      frames();
      expect(settling()).toBe(false);
    } finally {
      window.matchMedia = orig;
    }
  });
});
