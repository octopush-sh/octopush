import { useEffect, useRef, useState } from "react";
import { findActiveMention, rankFiles, applyMention } from "../../lib/mentions";
import { MentionPopover } from "../chat/MentionPopover";
import { SlashMenu } from "../chat/SlashMenu";
import { ipc } from "../../lib/ipc";
import type { SkillMeta } from "../../lib/types";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Worktree root — the source of both the file catalog and the skills. */
  workspacePath: string;
  placeholder?: string;
  /** ⌘⏎ / Ctrl+⏎ while no popover is open. */
  onSubmit?: () => void;
  className?: string;
  rows?: number;
  autoFocus?: boolean;
  "aria-label"?: string;
}

/** DIRECT's brief and role instructions, with the two references TALK's
 *  composer has: `@file` over the worktree catalog and `/skill` over the
 *  project ∪ user skills.
 *
 *  Both stay in the text as written. A `@path` is a pointer the agents resolve
 *  with their own read tools, and a `/slug` is resolved backend-side when the
 *  stage runs (`skills::referenced_skills`) — so what the director sees in the
 *  brief is exactly what the crew is handed, and a reference typed by hand
 *  behaves the same as one picked from the menu. */
export function RichPromptTextarea({
  value,
  onChange,
  workspacePath,
  placeholder,
  onSubmit,
  className = "",
  rows = 4,
  autoFocus,
  "aria-label": ariaLabel,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // ── @file ──
  const [files, setFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; caret: number } | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  // ── /skill ──
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [slashItems, setSlashItems] = useState<SkillMeta[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // Caret to restore after an insertion re-renders the textarea.
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ipc
      .listWorkspaceFiles(workspacePath)
      .then((paths) => !cancelled && setFiles(paths))
      .catch(() => {});
    void ipc
      .listSkills(workspacePath)
      .then((s) => !cancelled && setSkills(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  // The catalogs load async. If they land AFTER the caret is already sitting
  // in a reference — the common case, since typing `@` is faster than the
  // first read of a worktree — recompute, or the list would stay empty until
  // the next keystroke.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    // Read the text off the element, not the prop: this effect fires whenever a
    // catalog lands, which can be several renders after the one it closed over
    // — using the captured `value` would recompute against stale text and shut
    // a list the user had just opened.
    refresh(ta.value, ta.selectionStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogs only
  }, [skills, files]);

  useEffect(() => {
    if (pendingCaret.current == null) return;
    const ta = ref.current;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  }, [value]);

  function closeAll() {
    setMention(null);
    setMentionItems([]);
    setMentionIndex(0);
    setSlashOpen(false);
    setSlashItems([]);
    setSlashIndex(0);
  }

  /** Recompute both popovers from the text and caret. */
  function refresh(next: string, caret: number) {
    // The `/skill` word under the caret — unlike TALK, a brief is prose, so a
    // slash anywhere may start a reference, not only at position 0.
    const upto = next.slice(0, caret);
    const slashAt = upto.lastIndexOf("/");
    const wordStart = Math.max(upto.lastIndexOf(" "), upto.lastIndexOf("\n")) + 1;
    if (slashAt === wordStart && slashAt !== -1) {
      const q = upto.slice(slashAt + 1).toLowerCase();
      const items = q ? skills.filter((s) => s.name.toLowerCase().includes(q)) : skills;
      setMention(null);
      setMentionItems([]);
      setSlashOpen(true);
      setSlashItems(items);
      setSlashIndex(0);
      return;
    }
    setSlashOpen(false);
    setSlashItems([]);

    const m = findActiveMention(next, caret);
    if (!m) {
      setMention(null);
      setMentionItems([]);
      return;
    }
    setMention({ ...m, caret });
    setMentionItems(rankFiles(files, m.query));
    setMentionIndex(0);
  }

  function selectMention(path: string) {
    if (!mention) return;
    const { text, caret } = applyMention(value, mention.start, mention.caret, path);
    pendingCaret.current = caret;
    onChange(text);
    closeAll();
  }

  function selectSkill(skill: SkillMeta) {
    const ta = ref.current;
    const caret = ta?.selectionStart ?? value.length;
    const upto = value.slice(0, caret);
    const slashAt = upto.lastIndexOf("/");
    if (slashAt === -1) return;
    const inserted = `/${skill.name} `;
    const text = value.slice(0, slashAt) + inserted + value.slice(caret);
    pendingCaret.current = slashAt + inserted.length;
    onChange(text);
    closeAll();
  }

  const popoverOpen = slashOpen ? slashItems.length > 0 : mentionItems.length > 0;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popoverOpen) {
      const size = slashOpen ? slashItems.length : mentionItems.length;
      const setIndex = slashOpen ? setSlashIndex : setMentionIndex;
      const index = slashOpen ? slashIndex : mentionIndex;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((index + 1) % size);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((index - 1 + size) % size);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (slashOpen) selectSkill(slashItems[slashIndex]);
        else selectMention(mentionItems[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAll();
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative">
      {/* Both open DOWNWARD here: the brief sits mid-canvas inside a
          scrolling launcher, and upward overflow is clipped by that ancestor
          rather than scrolled to — the active row would be the first thing
          cut off. TALK keeps the upward default (its composer is at the
          bottom of the screen).
          `slashItems.length > 0` is a guard, not a nicety: SlashMenu renders a
          "No skills found" panel on an empty list, and since `popoverOpen` is
          false there, Escape would not dismiss it — typing `/usr/local` mid-
          brief would leave it stuck until the caret left the token. */}
      {slashOpen && slashItems.length > 0 ? (
        <SlashMenu
          items={slashItems}
          activeIndex={slashIndex}
          onSelect={selectSkill}
          onHover={setSlashIndex}
          placement="down"
        />
      ) : (
        !slashOpen && (
          <MentionPopover
            items={mentionItems}
            activeIndex={mentionIndex}
            onSelect={selectMention}
            onHover={setMentionIndex}
            placement="down"
          />
        )
      )}
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart)}
        onKeyUp={(e) => {
          // Arrow/Home/End move the caret without changing the text, which can
          // move it out of (or into) a reference.
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
            refresh(value, e.currentTarget.selectionStart);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Let a click on a popover row land before the list unmounts.
          window.setTimeout(closeAll, 120);
        }}
        className={className}
      />
    </div>
  );
}
