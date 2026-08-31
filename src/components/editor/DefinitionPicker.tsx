/**
 * Definition picker — shown when workspace search finds more than one
 * plausible declaration of a symbol and none of them clearly wins.
 *
 * Without a language server the ranking in `lib/definitionSearch.ts` can be
 * confident (one candidate, or one that beats the rest by a full tier) or it
 * can be genuinely unsure. This surface is what "unsure" looks like: the
 * reader picks, in one keystroke, instead of being dropped somewhere plausible
 * and having to work out where they landed.
 */

import { Command } from "cmdk";
import { useEffect, useRef } from "react";
import type { DefinitionCandidate } from "../../lib/definitionSearch";
import { ModalShell } from "../ModalShell";

interface Props {
  /** The symbol the reader asked about — shown so the list has a subject. */
  symbol: string;
  candidates: DefinitionCandidate[];
  onPick: (candidate: DefinitionCandidate) => void;
  onClose: () => void;
}

export function DefinitionPicker({ symbol, candidates, onPick, onClose }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[16vh]" ariaLabel="Go to definition">
      <div
        className="w-[620px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow: "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px var(--brass-faint)",
        }}
      >
        <Command loop shouldFilter={false} className="overflow-hidden rounded-xl">
          <div className="flex items-baseline gap-3 border-b border-octo-hairline px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
              Definitions
            </span>
            <span className="truncate font-mono text-[13px] text-octo-ivory">{symbol}</span>
            <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
              {candidates.length} candidates
            </span>
          </div>
          <Command.List
            ref={listRef}
            className="max-h-[380px] overflow-y-auto py-2"
            // cmdk owns arrow/Enter once something inside has focus.
            tabIndex={-1}
          >
            {candidates.map((c) => (
              <Command.Item
                key={`${c.file}:${c.line}`}
                value={`${c.file}:${c.line}`}
                onSelect={() => onPick(c)}
                className="mx-1 flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-1.5 text-[12.5px] text-octo-sage aria-selected:text-octo-ivory"
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-[12px] text-octo-ivory">
                    {c.file}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass">
                    :{c.line}
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] leading-[1.5] text-octo-sage">
                  {c.preview}
                </div>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </ModalShell>
  );
}
