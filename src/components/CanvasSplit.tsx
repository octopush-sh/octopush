import { useState, useRef } from "react";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { ScratchpadEditor } from "./ScratchpadEditor";

interface Props {
  children: React.ReactNode;
}

export function CanvasSplit({ children }: Props) {
  const isOpen = useScratchpadStore((s) => s.isOpen);
  const [splitRatio, setSplitRatio] = useState(50); // 0-100, percent for left column
  const dividerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = () => {
    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const newRatio = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
      setSplitRatio(newRatio);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  // CRITICAL FIX: Always render in the same DOM structure to prevent
  // remounting children (which was causing terminal input duplication).
  // Use display: none to hide scratchpad instead of conditional rendering.
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full gap-0"
      style={{
        display: "flex",
      }}
    >
      {/* Left column: Canvas - ALWAYS rendered to prevent remounting */}
      <div
        style={{
          width: isOpen ? `${splitRatio}%` : "100%",
          height: "100%",
          overflow: "hidden",
          transition: isOpen ? "width 200ms ease-out" : "width 200ms ease-out",
        }}
      >
        {children}
      </div>

      {/* Divider - only show when scratchpad is open */}
      {isOpen && (
        <div
          ref={dividerRef}
          onMouseDown={handleMouseDown}
          className="w-[1px] bg-octo-hairline cursor-col-resize hover:bg-octo-brass transition-colors"
          aria-hidden
        />
      )}

      {/* Right column: Scratchpad - always in DOM but hidden when closed */}
      <div
        style={{
          width: isOpen ? `${100 - splitRatio}%` : "0%",
          height: "100%",
          overflow: "hidden",
          transition: "width 200ms ease-out",
          visibility: isOpen ? "visible" : "hidden",
        }}
      >
        <ScratchpadEditor />
      </div>
    </div>
  );
}
