interface Props {
  count: number;
  onOpen: () => void;
}

export function ElsewhereFooter({ count, onOpen }: Props) {
  if (count <= 0) return null;
  return (
    // The whole row is the hit target. octo-rise-in: the count arrives async,
    // so the footer eases in instead of snapping the layout.
    <button
      type="button"
      onClick={onOpen}
      className="octo-rise-in flex w-full items-center gap-1.5 border-b border-octo-hairline px-3 py-2 text-left font-mono text-[10px] tracking-[0.1em] text-octo-mute transition-colors duration-[220ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
    >
      <span aria-hidden>↳</span>
      <span>
        <span className="octo-tabular">{count}</span>{" "}
        {count === 1 ? "ticket" : "tickets"} in-progress elsewhere
      </span>
    </button>
  );
}
