/**
 * ErrorBoundary — a render or effect error in one surface shows that surface's
 * fallback, siblings stay mounted, Try again remounts the surface, and the
 * root variant shows the recovery screen instead of a blank window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const copyToClipboard = vi.fn();
vi.mock("../lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));
const reloadWindow = vi.fn();
vi.mock("../lib/errorReport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/errorReport")>()),
  reloadWindow: () => reloadWindow(),
}));

const { ErrorBoundary } = await import("./ErrorBoundary");
const { formatErrorDetails, toError } = await import("../lib/errorReport");

/** Throws while `crash.on` is set; counts its mounts. */
const crash = { on: false, mounts: 0 };
function Bomb({ label = "bomb" }: { label?: string }) {
  useEffect(() => {
    crash.mounts += 1;
  }, []);
  if (crash.on) throw new Error("Invalid regular expression: /[z-a]/: Range out of order");
  return <div>{label} content</div>;
}

/** Throws from an effect, the way a store subscription or a matcher can. */
function EffectBomb() {
  useEffect(() => {
    if (crash.on) throw new Error("effect blew up");
  }, []);
  return <div>effect content</div>;
}

/** A sibling with its own state, to prove it is never remounted. */
function Sibling() {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      sibling {n}
    </button>
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  crash.on = false;
  crash.mounts = 0;
  copyToClipboard.mockReset().mockResolvedValue(true);
  reloadWindow.mockReset();
  // React reports caught errors to console.error as well; keep the output quiet.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("ErrorBoundary (panel)", () => {
  it("contains a render error: the card shows, siblings stay mounted, the error is logged", () => {
    crash.on = true;
    render(
      <>
        <Sibling />
        <ErrorBoundary surface="Talk">
          <Bomb />
        </ErrorBoundary>
        <ErrorBoundary surface="Review">
          <div>review content</div>
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByTestId("panel-error-card")).toHaveTextContent("This panel hit an error.");
    expect(screen.getByTestId("panel-error-card")).toHaveTextContent("Talk");
    // The card does not show the raw error text.
    expect(screen.queryByText(/Range out of order/)).toBeNull();
    expect(screen.getByText("review content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sibling 0" }));
    expect(screen.getByRole("button", { name: "sibling 1" })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[octopush] Talk hit a render error:",
      expect.objectContaining({ message: expect.stringContaining("[z-a]") }),
      expect.any(String),
    );
  });

  it("Try again remounts the surface without touching its siblings", () => {
    crash.on = true;
    render(
      <>
        <Sibling />
        <ErrorBoundary surface="Run">
          <Bomb />
        </ErrorBoundary>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "sibling 0" }));
    const mountsBefore = crash.mounts;
    crash.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("bomb content")).toBeInTheDocument();
    expect(screen.queryByTestId("panel-error-card")).toBeNull();
    expect(crash.mounts).toBe(mountsBefore + 1);
    expect(screen.getByRole("button", { name: "sibling 1" })).toBeInTheDocument();
  });

  it("catches errors thrown from effects", () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Direct">
        <EffectBomb />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("panel-error-card")).toBeInTheDocument();
  });

  it("clears the error when resetKey changes (e.g. switching workspace)", () => {
    crash.on = true;
    const { rerender } = render(
      <ErrorBoundary surface="Review" resetKey="ws-1">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("panel-error-card")).toBeInTheDocument();
    crash.on = false;
    rerender(
      <ErrorBoundary surface="Review" resetKey="ws-2">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("bomb content")).toBeInTheDocument();
  });

  it("compact shows a single icon button that retries", () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Companion" compact>
        <Bomb />
      </ErrorBoundary>,
    );
    const button = screen.getByTestId("panel-error-compact");
    expect(button).toHaveAttribute("title", "Companion hit an error · Try again");
    crash.on = false;
    fireEvent.click(button);
    expect(screen.getByText("bomb content")).toBeInTheDocument();
  });

  it("Copy error details copies the surface, message and stacks", async () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Talk">
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    const text = copyToClipboard.mock.calls[0][0] as string;
    expect(text).toContain("Surface: Talk");
    expect(text).toContain("Range out of order");
    expect(text).toContain("Component stack:");
    expect(text).toContain("Bomb");
  });
});

describe("ErrorBoundary (overlay)", () => {
  it("shows the card in a dialog; Close dismisses the surface and resets", () => {
    crash.on = true;
    const onDismiss = vi.fn();
    render(
      <>
        <Sibling />
        <ErrorBoundary surface="Command palette" variant="overlay" onDismiss={onDismiss}>
          <Bomb label="palette" />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Command palette hit an error" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sibling 0" })).toBeInTheDocument();
    crash.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("palette content")).toBeInTheDocument();
  });

  it("Escape dismisses like Close", () => {
    crash.on = true;
    const onDismiss = vi.fn();
    render(
      <ErrorBoundary surface="Settings" variant="overlay" onDismiss={onDismiss}>
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Try again remounts the dialog's surface", () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Pull request" variant="overlay" onDismiss={() => {}}>
        <Bomb label="composer" />
      </ErrorBoundary>,
    );
    crash.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("composer content")).toBeInTheDocument();
  });
});

describe("ErrorBoundary (root)", () => {
  it("renders the recovery screen instead of a blank window", () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Octopush" variant="root">
        <Bomb />
      </ErrorBoundary>,
    );
    const screenEl = screen.getByTestId("root-error-screen");
    expect(screenEl).toHaveTextContent("Octopush hit an unexpected error.");
    expect(screenEl).toHaveClass("octo-fade-in");
    fireEvent.click(screen.getByRole("button", { name: "Reload Octopush" }));
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  it("an error caught by a surface boundary never reaches the root", () => {
    crash.on = true;
    render(
      <ErrorBoundary surface="Octopush" variant="root">
        <Sibling />
        <ErrorBoundary surface="Talk">
          <Bomb />
        </ErrorBoundary>
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId("root-error-screen")).toBeNull();
    expect(screen.getByTestId("panel-error-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sibling 0" })).toBeInTheDocument();
  });

  it("shows Copy failed when the clipboard write fails", async () => {
    copyToClipboard.mockResolvedValue(false);
    crash.on = true;
    render(
      <ErrorBoundary surface="Octopush" variant="root">
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument());
  });
});

describe("errorReport", () => {
  it("normalises thrown non-Errors", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError(42).message).toBe("42");
    const e = new TypeError("x");
    expect(toError(e)).toBe(e);
  });

  it("formats details with the surface, time and error line", () => {
    const text = formatErrorDetails("Review", "plain string", "\n    at Foo", new Date("2026-11-03T10:00:00Z"));
    expect(text).toContain("Surface: Review");
    expect(text).toContain("Time: 2026-11-03T10:00:00.000Z");
    expect(text).toContain("Error: Error: plain string");
    expect(text).toContain("Component stack:\nat Foo");
  });
});
