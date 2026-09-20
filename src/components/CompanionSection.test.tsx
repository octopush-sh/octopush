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
