import { useState, useEffect, useCallback } from "react";
import { ipc } from "../lib/ipc";
import type { DirectoryEntry } from "../lib/types";

interface Props {
  rootPath: string;
  rootLabel: string;
  changedPaths: Set<string>;
}

type ChildState = DirectoryEntry[] | "loading" | "error";

export function CompanionFileTree({ rootPath, rootLabel, changedPaths }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([rootPath]));
  const [children, setChildren] = useState<Record<string, ChildState>>({});

  const fetchChildren = useCallback(
    async (path: string) => {
      if (children[path] && children[path] !== "error") return; // already cached
      setChildren((prev) => ({ ...prev, [path]: "loading" }));
      try {
        const entries = await ipc.readDirectory(path);
        setChildren((prev) => ({ ...prev, [path]: entries }));
      } catch {
        setChildren((prev) => ({ ...prev, [path]: "error" }));
      }
    },
    [children],
  );

  // Eagerly load root on mount.
  useEffect(() => {
    fetchChildren(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

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
    <section>
      {/* Eyebrow header */}
      <h3 className="border-b border-octo-hairline pb-2 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        FILES
      </h3>

      <div className="mt-2 overflow-y-auto">
        <TreeNode
          path={rootPath}
          label={rootLabel}
          isDir={true}
          depth={0}
          isRoot={true}
          expanded={expanded}
          children={children}
          changedPaths={changedPaths}
          onToggle={toggleExpand}
        />
      </div>
    </section>
  );
}

interface TreeNodeProps {
  path: string;
  label: string;
  isDir: boolean;
  depth: number;
  isRoot: boolean;
  expanded: Set<string>;
  children: Record<string, ChildState>;
  changedPaths: Set<string>;
  onToggle: (path: string) => void;
}

function TreeNode({
  path,
  label,
  isDir,
  depth,
  isRoot,
  expanded,
  children,
  changedPaths,
  onToggle,
}: TreeNodeProps) {
  const isExpanded = expanded.has(path);
  const isChanged = !isDir && changedPaths.has(path);

  return (
    <div>
      {/* Row */}
      <div
        className="group relative flex cursor-pointer items-center gap-1 rounded-sm py-[2px] pr-1 transition-colors duration-[220ms]"
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
          if (isDir) onToggle(path);
        }}
        data-testid={!isDir ? `file-row-${path}` : undefined}
      >
        {/* Indent guides — one 1px hairline per depth level */}
        {depth > 0 && (
          <IndentGuides depth={depth} />
        )}

        {/* Chevron or dot indicator */}
        {isDir ? (
          <span
            className="shrink-0 font-mono text-[9px] transition-colors duration-[220ms]"
            style={{
              color: isExpanded || isRoot ? "var(--color-octo-brass)" : "var(--color-octo-sage)",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              display: "inline-block",
              transition: "transform 220ms cubic-bezier(0.2,0.8,0.3,1), color 220ms",
            }}
          >
            ▶
          </span>
        ) : (
          <span
            className="shrink-0 font-mono text-[10px]"
            style={{
              color: isChanged ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
            }}
          >
            {isChanged ? "●" : "◦"}
          </span>
        )}

        {/* Label */}
        {isRoot ? (
          <span
            className="min-w-0 truncate font-serif italic text-[13px] text-octo-ivory"
          >
            {label}
          </span>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-[11px]"
            style={{
              color: isChanged ? "var(--color-octo-ivory)" : "var(--color-octo-sage)",
            }}
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
                  className="py-[2px] font-serif italic text-[11px] text-octo-mute"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  loading…
                </div>
              );
            }
            if (state === "error") {
              return (
                <div
                  className="py-[2px] font-serif italic text-[11px] text-octo-rouge"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
                >
                  error reading directory.
                </div>
              );
            }
            if (state.length === 0) {
              return (
                <div
                  className="py-[2px] font-serif italic text-[11px] text-octo-mute"
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
                depth={depth + 1}
                isRoot={false}
                expanded={expanded}
                children={children}
                changedPaths={changedPaths}
                onToggle={onToggle}
              />
            ));
          })()}
        </div>
      )}
    </div>
  );
}

function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 border-l"
          style={{
            left: `${i * 14 + 10}px`,
            borderColor: "rgba(212, 165, 116, 0.4)", // --brass-dim
          }}
        />
      ))}
    </>
  );
}
