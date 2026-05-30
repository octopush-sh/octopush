interface Props {
  count: number;
  onOpen: () => void;
}

export function ElsewhereFooter({ count, onOpen }: Props) {
  if (count <= 0) return null;
  return (
    <div className="border-b border-octo-hairline px-3 py-2">
      <button
        type="button"
        onClick={onOpen}
        className="font-mono text-[10px] tracking-[0.1em] text-octo-mute hover:text-octo-brass"
      >
        ↳ {count} tickets in-progress en otros proyectos
      </button>
    </div>
  );
}
