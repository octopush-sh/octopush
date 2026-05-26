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

  if (!isOpen) {
    return (
      <div className="h-full w-full">
        {children}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full gap-0"
    >
      {/* Left column: Canvas */}
      <div style={{ width: `${splitRatio}%` }} className="h-full overflow-hidden">
        {children}
      </div>

      {/* Divider */}
      <div
        ref={dividerRef}
        onMouseDown={handleMouseDown}
        className="w-[1px] bg-octo-hairline cursor-col-resize hover:bg-octo-brass transition-colors"
        aria-hidden
      />

      {/* Right column: Scratchpad */}
      <div style={{ width: `${100 - splitRatio}%` }} className="h-full overflow-hidden">
        <ScratchpadEditor />
      </div>
    </div>
  );
}
