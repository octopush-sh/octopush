import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { ModalShell } from "../ModalShell";
import { useChatStore } from "../../stores/chatStore";
import { escStopsTurn, useEscStopsTurn } from "./talkEscape";
import { ApprovalCard } from "./ApprovalCard";

function Talk({ active = true, children }: { active?: boolean; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscStopsTurn(ref, "ws-1", active);
  return (
    <div ref={ref} data-testid="talk">
      <button type="button" data-testid="talk-button">Copy</button>
      {children}
    </div>
  );
}

const stop = vi.fn();
const original = useChatStore.getState();

beforeEach(() => {
  stop.mockReset();
  useChatStore.setState({ stop, getStreaming: () => true });
});
afterEach(() => {
  cleanup();
  useChatStore.setState({ stop: original.stop, getStreaming: original.getStreaming });
});

const esc = (target: Element = document.body, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: "Escape", ...init });

describe("Esc stops the running Talk turn", () => {
  it("stops it with the focus in Talk, or on nothing", () => {
    const { getByTestId } = render(<Talk />);
    const button = getByTestId("talk-button");
    button.focus();
    esc(button);
    expect(stop).toHaveBeenCalledWith("ws-1");
    button.blur();
    esc(document.body);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("does nothing with no turn running, or while Talk isn't on screen", () => {
    useChatStore.setState({ getStreaming: () => false });
    const { unmount } = render(<Talk />);
    esc();
    expect(stop).not.toHaveBeenCalled();
    unmount();
    useChatStore.setState({ getStreaming: () => true });
    render(<Talk active={false} />);
    esc();
    expect(stop).not.toHaveBeenCalled();
  });

  it("leaves the focus elsewhere alone (the rail, the Companion)", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    render(<Talk />);
    outside.focus();
    esc(outside);
    expect(stop).not.toHaveBeenCalled();
    outside.remove();
  });

  it("yields to an open ModalShell", () => {
    render(
      <>
        <Talk />
        <ModalShell onClose={() => {}} ariaLabel="A dialog">
          <p>dialog</p>
        </ModalShell>
      </>,
    );
    esc();
    expect(stop).not.toHaveBeenCalled();
  });

  it("yields to an open popover or menu", () => {
    for (const role of ["listbox", "menu", "dialog"]) {
      const { unmount } = render(
        <Talk>
          <div role={role}>popover</div>
        </Talk>,
      );
      esc();
      unmount();
    }
    expect(stop).not.toHaveBeenCalled();
  });

  it("yields to a focused editor or terminal, and to a key something closer used", () => {
    const { getByTestId } = render(
      <Talk>
        <div className="cm-editor"><div data-testid="cm" tabIndex={0} /></div>
        <div className="xterm"><textarea data-testid="xterm" /></div>
        <div
          data-testid="card"
          tabIndex={0}
          onKeyDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </Talk>,
    );
    for (const id of ["cm", "xterm", "card"]) {
      const el = getByTestId(id);
      el.focus();
      esc(el);
    }
    expect(stop).not.toHaveBeenCalled();
  });

  it("with an approval card focused, Esc denies the card and never stops the turn", () => {
    const onRespond = vi.fn();
    const approval = { callId: "c1", threadId: "t", command: "git push --force", reason: "force-push" };
    const { getByRole } = render(
      <Talk>
        <ApprovalCard approval={approval} onRespond={onRespond} />
      </Talk>,
    );
    const card = getByRole("group", { name: "Approval needed: git push --force" });
    card.focus();
    esc(card);
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenLastCalledWith("deny");
    expect(stop).not.toHaveBeenCalled();

    // A button inside the card keeps its own keys: no answer, and no stop.
    const approve = getByRole("button", { name: "Approve" });
    approve.focus();
    esc(approve);
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("takes only a bare, fresh Escape", () => {
    render(<Talk />);
    esc(document.body, { shiftKey: true });
    esc(document.body, { metaKey: true });
    esc(document.body, { repeat: true });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("escStopsTurn", () => {
  const key = (over: Partial<KeyboardEvent> = {}) =>
    ({
      key: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      repeat: false, defaultPrevented: false, isComposing: false, target: document.body, ...over,
    }) as KeyboardEvent;

  it("needs a Talk root and Talk on screen", () => {
    const root = document.createElement("div");
    expect(escStopsTurn(key(), root, true)).toBe(true);
    expect(escStopsTurn(key(), null, true)).toBe(false);
    expect(escStopsTurn(key(), root, false)).toBe(false);
    expect(escStopsTurn(key({ isComposing: true }), root, true)).toBe(false);
    expect(escStopsTurn(key({ defaultPrevented: true }), root, true)).toBe(false);
  });

  it("never with the key or the focus on an approval card", () => {
    const root = document.createElement("div");
    const card = document.createElement("div");
    card.setAttribute("data-approval-card", "");
    card.tabIndex = 0;
    const inside = document.createElement("button");
    card.appendChild(inside);
    root.appendChild(card);
    document.body.appendChild(root);
    expect(escStopsTurn(key({ target: root }), root, true)).toBe(true);
    expect(escStopsTurn(key({ target: card }), root, true)).toBe(false);
    inside.focus();
    expect(escStopsTurn(key({ target: document.body }), root, true)).toBe(false);
    root.remove();
  });
});
