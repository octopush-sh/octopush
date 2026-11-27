import { useEffect, type RefObject } from "react";
import { isModalOpen } from "../ModalShell";
import { useChatStore } from "../../stores/chatStore";

/** An open popover, menu or listbox anywhere on screen: its own Escape comes first. */
const OPEN_POPUP = '[role="menu"], [role="listbox"], [role="dialog"]';

/**
 * Whether this Escape stops Talk's running turn. Only a bare, fresh Escape
 * nothing closer has used (a popover, a focused approval card), with no
 * dialog, menu or listbox open, outside a code editor or terminal (Talk's
 * terminal seat keeps its Escape), and with the focus in Talk: inside
 * `root`, or on nothing (the composer is disabled while a turn runs, so its
 * focus falls to the body). `active`: Talk is the mode on screen. Pure but
 * for reading the document.
 */
export function escStopsTurn(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented" | "isComposing" | "target">,
  root: Element | null,
  active: boolean,
): boolean {
  if (!active || !root || e.key !== "Escape") return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.isComposing || e.defaultPrevented) return false;
  if (isModalOpen() || document.querySelector(OPEN_POPUP)) return false;
  if (e.target instanceof Element && e.target.closest(".cm-editor, .xterm")) return false;
  const focus = document.activeElement;
  return !focus || focus === document.body || root.contains(focus);
}

/** Esc stops the running turn of the conversation Talk shows (`escStopsTurn`). */
export function useEscStopsTurn(root: RefObject<HTMLElement | null>, workspaceId: string, active: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chat = useChatStore.getState();
      if (!chat.getStreaming(workspaceId) || !escStopsTurn(e, root.current, active)) return;
      e.preventDefault();
      chat.stop(workspaceId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root, workspaceId, active]);
}
