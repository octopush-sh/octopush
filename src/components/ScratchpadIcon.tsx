import { useScratchpadStore } from "../stores/scratchpadStore";

interface Props {
  onClick: () => void;
}

export function ScratchpadIcon({ onClick }: Props) {
  const isOpen = useScratchpadStore((s) => s.isOpen);

  return (
    <button
      type="button"
      onClick={onClick}
      title={isOpen ? "Close scratchpad" : "Open scratchpad"}
      aria-label={isOpen ? "Close scratchpad" : "Open scratchpad"}
      className="flex items-center justify-center h-8 w-8 rounded transition-colors hover:bg-[var(--brass-ghost)]"
      style={{
        color: "var(--color-octo-brass)",
        opacity: isOpen ? 1 : 0.2,
      }}
    >
      <span className="font-mono text-[14px]">≡</span>
    </button>
  );
}
