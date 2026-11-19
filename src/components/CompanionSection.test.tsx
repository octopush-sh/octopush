/**
 * The Companion's one section chrome: an eyebrow that folds its body, a
 * remembered open/closed state, an optional action on the bar.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CompanionSection } from "./CompanionSection";

beforeEach(() => {
  localStorage.clear();
});

describe("CompanionSection", () => {
  it("folds and unfolds its body from the eyebrow, keeping the action reachable", () => {
    render(
      <CompanionSection title="Chats" count={3} action={<button type="button">add</button>}>
        <div>body</div>
      </CompanionSection>,
    );
    const fold = screen.getByRole("button", { name: /chats/i });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(fold).toHaveTextContent("· 3");
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("body").closest("[inert]")).not.toBeNull();
    expect(screen.getByText("add")).toBeInTheDocument();
  });

  it("puts what the section is about at the right of the eyebrow, inside the fold control", () => {
    const { rerender } = render(
      <CompanionSection title="Changes" meta="3 files · +84 −12">
        <div>body</div>
      </CompanionSection>,
    );
    const fold = screen.getByRole("button", { name: /changes/i });
    const meta = screen.getByTestId("companion-section-meta");
    expect(fold).toContainElement(meta);
    expect(meta).toHaveTextContent("3 files · +84 −12");
    // The meta is the part that gives way; it keeps its own case.
    expect(meta.className).toContain("truncate");
    expect(meta.className).toContain("normal-case");
    rerender(
      <CompanionSection title="Changes" meta={null}>
        <div>body</div>
      </CompanionSection>,
    );
    expect(screen.queryByTestId("companion-section-meta")).toBeNull();
  });

  it("remembers the folded state under its storage key", () => {
    const { unmount } = render(
      <CompanionSection title="Conversation" storageKey="conversation">
        <div>body</div>
      </CompanionSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /conversation/i }));
    unmount();
    render(
      <CompanionSection title="Conversation" storageKey="conversation">
        <div>body</div>
      </CompanionSection>,
    );
    expect(screen.getByRole("button", { name: /conversation/i })).toHaveAttribute("aria-expanded", "false");
  });
});
