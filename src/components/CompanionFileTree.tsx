import { useState, useEffect, useCallback, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { DirectoryEntry } from "../lib/types";
import { fileIcon } from "../lib/fileIcons";
import { useReviewPrefs } from "../stores/reviewPrefsStore";

interface Props {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
  onFileClick?: (absPath: string) => void;
}

type ChildState = DirectoryEntry[] | "loading" | "error";

export function CompanionFileTree({ rootPath, rootLabel, changedPaths, onFileClick }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([rootPath]));
  const [children, setChildren] = useState<Record<string, ChildState>>({});
  const showIgnored = useReviewPrefs((s) => !!s.showIgnoredFiles[rootPath]);
  const toggleShowIgnored = useReviewPrefs((s) => s.toggleShowIgnored);
  const genRef = useRef(0);

  const fetchChildren = useCallback(
    async (path: string, opts?: { force?: boolean }) => {
      if (!opts?.force && children[path] && children[path] !== "error") return; // already cached
      const gen = genRef.current;
      setChildren((prev) => ({ ...prev, [path]: "loading" }));
      try {
        const entries = await ipc.readDirectory(path, showIgnored);
        if (genRef.current !== gen) return; // toggle flipped mid-flight; discard
        setChildren((prev) => ({ ...prev, [path]: entries }));
      } catch {
        if (genRef.current !== gen) return;
        setChildren((prev) => ({ ...prev, [path]: "error" }));
      }
    },
    [children, showIgnored],
  );

  // (Re)load on mount, on workspace switch, and when the show-ignored toggle
  // flips: bump the generation (discarding in-flight responses), drop the
  // cache, and force-refetch every expanded folder.
  useEffect(() => {
    genRef.current += 1;
    setChildren({});
    const toFetch = new Set(expanded);
    toFetch.add(rootPath); // a freshly-switched workspace root may not be in `expanded` yet
    for (const p of toFetch) {
      void fetchChildren(p, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, showIgnored]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          fetchChildren(path);
        }
        return next;
      });
    },
    [fetchChildren],
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* Eyebrow — same height & padding as the canvas toolbar and the
          left rail's CHANGES eyebrow so the three top bars form one row. */}
      <h3 className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Files
        <button
          type="button"
          aria-label="Show ignored files"
          aria-pressed={showIgnored}
          title={showIgnored ? "Hide ignored files" : "Show ignored files"}
          onClick={() => toggleShowIgnored(rootPath)}
          className="rounded-sm p-1 transition-colors duration-[220ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {showIgnored ? (
            <Eye size={12} className="text-octo-brass" />
          ) : (
            <EyeOff size={12} className="text-octo-mute" />
          )}
        </button>
      </h3>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <TreeNode
          path={rootPath}
          label={rootLabel}
          isDir={true}
          isIgnored={false}
          depth={0}
          isRoot={true}
          expanded={expanded}
          children={children}
          changedPaths={changedPaths}
          onToggle={toggleExpand}
          onFileClick={onFileClick}
        />
      </div>
    </section>
  );
}

interface TreeNodeProps {
  path: string;
  label: string;
  isDir: boolean;
  isIgnored: boolean;
  depth: number;
  isRoot: boolean;
  expanded: Set<string>;
  children: Record<string, ChildState>;
  changedPaths: Set<string>;
  onToggle: (path: string) => void;
  onFileClick?: (absPath: string) => void;
}

/** Returns the label color class for a file/folder based on state and depth. */
function depthColorClass(depth: number, isChanged: boolean, isIgnored: boolean): string {
  if (isChanged) return "text-octo-ivory";
  if (isIgnored) return "text-octo-mute";
  if (depth >= 4) return "text-octo-mute";
  return "text-octo-sage";
}

function TreeNode({
  path,
  label,
  isDir,
  isIgnored,
  depth,
  isRoot,
  expanded,
  children,
  changedPaths,
  onToggle,
  onFileClick,
}: TreeNodeProps) {
  const isExpanded = expanded.has(path);
  const isChanged = !isDir && changedPaths.has(path);
  const Icon = !isDir ? fileIcon(label) : null;

  return (
    <div>
      {/* Row */}
      <div
        className="group relative flex cursor-pointer items-center gap-1 rounded-sm py-1 pr-1 transition-colors duration-[220ms]"
        style={{
          paddingLeft: `${depth * 14 + 4}px`,
          background: "transparent",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--brass-ghost)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
        onClick={() => {
          if (isDir) {
            onToggle(path);
          } else if (onFileClick) {
            onFileClick(path);
          }
        }}
        data-testid={!isDir ? `file-row-${path}` : undefined}
      >
        {/* Indent guides — one 1px hairline per depth level */}
        {depth > 0 && (
          <IndentGuides depth={depth} />
        )}

        {/* Chevron (dirs) or dot indicator (files) */}
        {isDir ? (
          <span
            className="shrink-0 font-mono text-[9px] group-hover:text-octo-brass"
            data-testid={isExpanded ? "chevron-expanded" : "chevron-collapsed"}
            style={{
              color: isExpanded ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              display: "inline-block",
              transition: "transform 220ms cubic-bezier(0.2,0.8,0.3,1), color 220ms",
            }}
          >
            ▶
          </span>
        ) : isChanged ? (
          <span
            className="inline-flex w-3 shrink-0 items-center justify-center font-mono text-[10px]"
            style={{ color: "var(--color-octo-brass)" }}
          >
            ●
          </span>
        ) : (
          Icon && (
            <Icon
              size={12}
              aria-hidden="true"
              className="shrink-0"
              style={{ color: "var(--color-octo-mute)", opacity: isIgnored ? 0.6 : 1 }}
            />
          )
        )}

        {/* § glyph for folders (quiet brand mark, not for root) */}
        {isDir && !isRoot && (
          <span
            aria-hidden="true"
            className="shrink-0 font-mono text-[10px]"
            style={{ color: "rgba(212, 165, 116, 0.4)" }}
          >
            §
          </span>
        )}

        {/* Label */}
        {isRoot ? (
          <span
            className="min-w-0 truncate font-serif text-[13px] text-octo-ivory"
          >
            {label}
          </span>
        ) : (
          <span
            className={`min-w-0 truncate font-mono text-[11px] ${depthColorClass(depth, isChanged, isIgnored)}`}
          >
            {label}
          </span>
        )}
      </div>

      {/* Children (only if dir + expanded) */}
      {isDir && isExpanded && (
        <div>
          {(() => {
            const state = children[path];
            if (!state || state === "loading") {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  loading…
                </div>
              );
            }
            if (state === "error") {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-rouge"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  error reading directory.
                </div>
              );
            }
            if (state.length === 0) {
              return (
                <div
                  className="py-[2px] font-serif text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  empty.
                </div>
              );
            }
            return state.map((entry) => (
              <TreeNode
                key={entry.path}
                path={entry.path}
                label={entry.name}
                isDir={entry.isDir}
                isIgnored={entry.isIgnored}
                depth={depth + 1}
                isRoot={false}
                expanded={expanded}
                children={children}
                changedPaths={changedPaths}
                onToggle={onToggle}
                onFileClick={onFileClick}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Renders vertical indent guide lines, one per depth level.
 * Ancestor guides are rendered at low opacity (~20%) to recede;
 * the current row's own guide (last one) is highlighted at ~50% using brass-dim.
 */
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => {
        const isCurrentLevel = i === depth - 1;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 border-l"
            style={{
              left: `${i * 14 + 10}px`,
              borderColor: isCurrentLevel
                ? "rgba(212, 165, 116, 0.5)" // current row's guide: brass-dim at ~50%
                : "var(--color-octo-hairline)", // ancestor guides: hairline at ~20% via rgba
              opacity: isCurrentLevel ? 1 : 0.2,
            }}
          />
        );
      })}
    </>
  );
}
