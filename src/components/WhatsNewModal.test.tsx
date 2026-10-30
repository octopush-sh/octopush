import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsNewModal, parseInline } from "./WhatsNewModal";
import { TourOverlay, placeBubble } from "./TourOverlay";
import { useWhatsNewStore } from "../stores/whatsNewStore";
import { useTourStore } from "../stores/tourStore";
import { playTour, stopTour } from "../lib/tour/runner";
import type { Tip } from "../lib/whatsNew";

vi.mock("../lib/ipc", () => ({ ipc: { openFileInSystem: vi.fn(async () => {}) } }));
import { ipc } from "../lib/ipc";

const tip = (slug: string, extra: Partial<Tip> = {}): Tip => ({
  slug,
  version: "0.4.90",
  title: `Title ${slug}`,
  kind: "feature",
  body: `Body ${slug}`,
  steps: [],
  ...extra,
});

const setReducedMotion = (on: boolean) => {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes("reduce"),
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  setReducedMotion(false);
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 40, y: 40, top: 40, left: 40, right: 140, bottom: 70, width: 100, height: 30, toJSON() {} } as DOMRect;
  };
});
afterEach(() => {
  act(() => {
    stopTour();
    useWhatsNewStore.getState().close();
  });
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

describe("parseInline", () => {
  it("parses bold, code and http links; leaves the rest literal", () => {
    expect(parseInline("Turn on **Sync** in `settings.json`, see [docs](https://octopush.sh). [x](javascript:alert)")).toEqual([
      { kind: "text", text: "Turn on " },
      { kind: "bold", text: "Sync" },
      { kind: "text", text: " in " },
      { kind: "code", text: "settings.json" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "docs", href: "https://octopush.sh" },
      { kind: "text", text: ". [x](javascript:alert)" },
    ]);
  });
});

describe("WhatsNewModal", () => {
  it("pages with Next / Back and the arrow keys, Done closes", () => {
    render(<WhatsNewModal />);
    act(() => useWhatsNewStore.getState().open([tip("a"), tip("b"), tip("c")]));
    expect(screen.getByText("What's new")).toBeInTheDocument();
    expect(screen.getByText("Title a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Title b")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Title c")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Title b")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Title a")).toBeInTheDocument();
    act(() => useWhatsNewStore.getState().goTo(2));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(useWhatsNewStore.getState().phase).toBe("closed");
    expect(screen.queryByText("What's new")).toBeNull();
  });

  it("renders the body's inline Markdown and opens links in the browser", () => {
    render(<WhatsNewModal />);
    act(() => useWhatsNewStore.getState().open([tip("a", { body: "See **this** and [docs](https://octopush.sh/docs)." })]));
    expect(screen.getByText("this").tagName).toBe("STRONG");
    fireEvent.click(screen.getByText("docs"));
    expect(ipc.openFileInSystem).toHaveBeenCalledWith("https://octopush.sh/docs");
  });

  it("shows the version span and per-page StageDots", () => {
    render(<WhatsNewModal />);
    act(() => useWhatsNewStore.getState().open([tip("a", { version: "0.4.89" }), tip("b")]));
    expect(screen.getByText("v0.4.89 – v0.4.90")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-dot]")).toHaveLength(2);
  });

  it("Show me appears only with steps, runs the tour, then returns at the next tip", async () => {
    const target = document.createElement("button");
    target.setAttribute("data-tour", "about-whats-new");
    document.body.appendChild(target);
    render(
      <>
        <WhatsNewModal />
        <TourOverlay />
      </>,
    );
    act(() =>
      useWhatsNewStore.getState().open([
        tip("a", { steps: [{ target: "about-whats-new", caption: "Reopen it here." }] }),
        tip("b"),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    await waitFor(() => expect(screen.getByText("Reopen it here.")).toBeInTheDocument());
    expect(useWhatsNewStore.getState().phase).toBe("touring");
    expect(screen.queryByText("Title a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByText("Title b")).toBeInTheDocument());
    expect(useWhatsNewStore.getState().phase).toBe("modal");
    expect(screen.queryByRole("button", { name: "Show me" })).toBeNull();
    target.remove();
  });

  it("autoplays the clip, but not under reduced motion (play control instead)", () => {
    const { unmount } = render(<WhatsNewModal />);
    act(() => useWhatsNewStore.getState().open([tip("a", { clip: "/clip.webm" })]));
    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(screen.queryByRole("button", { name: "Play demo" })).toBeNull();
    unmount();
    act(() => useWhatsNewStore.getState().close());

    setReducedMotion(true);
    render(<WhatsNewModal />);
    act(() => useWhatsNewStore.getState().open([tip("a", { clip: "/clip.webm" })]));
    expect(document.querySelector("video")!.autoplay).toBe(false);
    expect(screen.getByRole("button", { name: "Play demo" })).toBeInTheDocument();
  });
});

describe("TourOverlay", () => {
  it("spotlights the target, Escape closes the tour and stops the event", async () => {
    const target = document.createElement("button");
    target.setAttribute("data-tour", "x");
    document.body.appendChild(target);
    const below = vi.fn();
    window.addEventListener("keydown", below);
    render(<TourOverlay />);
    let done = false;
    act(() => {
      void playTour([{ target: "x", caption: "Look here." }]).then(() => (done = true));
    });
    await waitFor(() => expect(screen.getByText("Look here.")).toBeInTheDocument());
    expect(screen.getByTestId("tour-spot")).toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Done");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(done).toBe(true));
    expect(useTourStore.getState().active).toBe(false);
    expect(below).not.toHaveBeenCalled();
    window.removeEventListener("keydown", below);
    target.remove();
  });

  it("hides the controls in record mode", async () => {
    const target = document.createElement("button");
    target.setAttribute("data-tour", "y");
    document.body.appendChild(target);
    render(<TourOverlay />);
    act(() => void playTour([{ target: "y", caption: "Recording." }], { mode: "record", stepMs: 5000 }));
    await waitFor(() => expect(screen.getByText("Recording.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    target.remove();
  });
});

describe("placeBubble", () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 300, height: 100 };
  it("goes below when it fits, above near the bottom edge", () => {
    expect(placeBubble({ top: 100, left: 100, width: 50, height: 20 }, size, vp).side).toBe("below");
    expect(placeBubble({ top: 740, left: 100, width: 50, height: 20 }, size, vp).side).toBe("above");
  });
  it("clamps horizontally inside the viewport", () => {
    expect(placeBubble({ top: 100, left: 980, width: 20, height: 20 }, size, vp).left).toBe(1000 - 300 - 12);
    expect(placeBubble({ top: 100, left: 0, width: 20, height: 20 }, size, vp).left).toBe(12);
  });
});
