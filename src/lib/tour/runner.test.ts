import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playTour, stopTour, tourBack, tourNext, waitForTarget, performAction } from "./runner";
import { NAVIGATE_EVENT } from "./surfaces";
import { installTourBridge, shouldInstallTourBridge } from "./bridge";
import { useTourStore } from "../../stores/tourStore";

// jsdom has no layout: give every element a box unless it is marked hidden.
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const hidden = this.hasAttribute("data-hidden");
    return { x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 40, width: hidden ? 0 : 100, height: hidden ? 0 : 30, toJSON() {} } as DOMRect;
  };
});
afterEach(() => {
  stopTour();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  document.body.innerHTML = "";
});

function add(id: string, tag = "button") {
  const el = document.createElement(tag);
  el.setAttribute("data-tour", id);
  document.body.appendChild(el);
  return el;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, ms = 500) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("waitForTarget", () => {
  it("resolves when the target appears later", async () => {
    const p = waitForTarget("late", 500);
    setTimeout(() => add("late"), 20);
    expect(await p).not.toBeNull();
  });
  it("resolves null when it never becomes visible", async () => {
    add("ghost").setAttribute("data-hidden", "");
    expect(await waitForTarget("ghost", 40)).toBeNull();
  });
});

describe("playTour (interactive)", () => {
  it("skips a step whose target is missing", async () => {
    add("b");
    const done = playTour(
      [
        { target: "missing", caption: "A" },
        { target: "b", caption: "B" },
      ],
      { waitMs: 30 },
    );
    await until(() => useTourStore.getState().target !== null);
    expect(useTourStore.getState().index).toBe(1);
    tourNext();
    await done;
    expect(useTourStore.getState().active).toBe(false);
  });

  it("opens the step's surface before looking for the target", async () => {
    const seen: unknown[] = [];
    const onNav = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      add("about-whats-new");
    };
    window.addEventListener(NAVIGATE_EVENT, onNav);
    try {
      void playTour([{ open: "settings/about", target: "about-whats-new", caption: "Here" }], { waitMs: 200 });
      await until(() => useTourStore.getState().target !== null);
      expect(seen).toEqual([{ kind: "settings", tab: "about" }]);
    } finally {
      window.removeEventListener(NAVIGATE_EVENT, onNav);
    }
  });

  it("never performs actions in interactive mode", async () => {
    const el = add("btn");
    const onClick = vi.fn();
    el.addEventListener("click", onClick);
    void playTour([{ target: "btn", caption: "x", action: "click" }], { waitMs: 50, stepMs: 10 });
    await until(() => useTourStore.getState().target !== null);
    await new Promise((r) => setTimeout(r, 40));
    expect(onClick).not.toHaveBeenCalled();
    expect(useTourStore.getState().active).toBe(true);
  });

  it("Back returns to the previous step; Back on the first stays put", async () => {
    add("a");
    add("b");
    void playTour([{ target: "a", caption: "A" }, { target: "b", caption: "B" }], { waitMs: 30 });
    await until(() => useTourStore.getState().target !== null);
    tourBack();
    await flush();
    expect(useTourStore.getState().index).toBe(0);
    tourNext();
    await until(() => useTourStore.getState().index === 1 && useTourStore.getState().target !== null);
    tourBack();
    await until(() => useTourStore.getState().index === 0 && useTourStore.getState().target !== null);
  });

  it("stopTour resolves the play promise", async () => {
    add("a");
    const done = playTour([{ target: "a", caption: "A" }], { waitMs: 30 });
    await until(() => useTourStore.getState().target !== null);
    stopTour();
    await expect(done).resolves.toBe(1);
    expect(useTourStore.getState()).toMatchObject({ active: false, target: null, steps: [] });
  });
});

describe("playTour (record)", () => {
  it("auto-advances and performs click / type / hover", async () => {
    const btn = add("btn");
    const input = add("field", "input") as HTMLInputElement;
    const hov = add("hov", "div");
    const onClick = vi.fn();
    const onInput = vi.fn();
    const onOver = vi.fn();
    btn.addEventListener("click", onClick);
    input.addEventListener("input", onInput);
    hov.addEventListener("mouseover", onOver);
    await playTour(
      [
        { target: "btn", caption: "Click", action: "click" },
        { target: "field", caption: "Type", action: "type", text: "hello" },
        { target: "hov", caption: "Hover", action: "hover" },
        { target: "nothing", caption: "Skipped" },
      ],
      { mode: "record", stepMs: 10, waitMs: 20 },
    );
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("hello");
    expect(onInput).toHaveBeenCalled();
    expect(onOver).toHaveBeenCalled();
    expect(useTourStore.getState().active).toBe(false);
  });

  it("type falls back to a field inside the target", () => {
    const wrap = add("wrap", "div");
    const ta = document.createElement("textarea");
    wrap.appendChild(ta);
    performAction({ target: "wrap", caption: "", action: "type", text: "brief" }, wrap);
    expect(ta.value).toBe("brief");
  });
});

describe("__octoTour bridge", () => {
  it("installs only in dev or with ?octo-record=1", () => {
    expect(shouldInstallTourBridge(false, "")).toBe(false);
    expect(shouldInstallTourBridge(false, "?octo-record=1")).toBe(true);
    expect(shouldInstallTourBridge(true, "")).toBe(true);
    delete window.__octoTour;
    expect(installTourBridge(false, "")).toBe(false);
    expect(window.__octoTour).toBeUndefined();
    expect(installTourBridge(false, "?octo-record=1")).toBe(true);
    expect(typeof (window as Window).__octoTour?.play).toBe("function");
  });

  it("play() runs a record-mode tour and resolves", async () => {
    installTourBridge(true, "");
    const btn = add("btn");
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    await window.__octoTour!.play([{ target: "btn", caption: "c", action: "click" }], { mode: "record", stepMs: 10 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("playTour — counting and concurrent seeks", () => {
  it("resolves with the number of steps actually shown", async () => {
    add("b");
    const done = playTour(
      [
        { target: "missing", caption: "A" },
        { target: "b", caption: "B" },
      ],
      { waitMs: 20 },
    );
    await until(() => useTourStore.getState().target !== null);
    tourNext();
    expect(await done).toBe(1);
    expect(await playTour([{ target: "nowhere", caption: "x" }], { waitMs: 10 })).toBe(0);
  });

  it("a Next pressed while a step is still loading wins over the older seek", async () => {
    add("a");
    const done = playTour(
      [
        { target: "a", caption: "A" },
        { target: "slow", caption: "B" },
        { target: "c", caption: "C" },
      ],
      { waitMs: 200 },
    );
    await until(() => useTourStore.getState().target !== null);
    tourNext(); // starts waiting for "slow"
    await flush();
    tourNext(); // user presses → again before it appears: jump to "c"
    add("c");
    await until(() => useTourStore.getState().index === 2 && useTourStore.getState().target !== null);
    add("slow"); // the old seek wakes up — it must not take over
    await new Promise((r) => setTimeout(r, 60));
    expect(useTourStore.getState().index).toBe(2);
    stopTour();
    await done;
  });
});
