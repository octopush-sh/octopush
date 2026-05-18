interface Props {
  tokensUsed: number;
  tokensLimit: number;
  unstaged: number;
  toolCalls: number;
}

export function CompanionContext({ tokensUsed, tokensLimit, unstaged, toolCalls }: Props) {
  const pct = tokensLimit > 0 ? Math.min(100, (tokensUsed / tokensLimit) * 100) : 0;

  return (
    <section>
      <h3 className="border-b border-octo-hairline pb-2 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Context
      </h3>
      <div className="mt-2 space-y-1.5 text-[11px] text-octo-sage">
        <Row label="tokens" value={`${formatThousands(tokensUsed)} / ${formatThousands(tokensLimit)}`} brass />
        <div
          className="h-[3px] rounded-sm"
          style={{ background: "var(--color-octo-hairline)" }}
        >
          <div
            className="h-full rounded-sm"
            style={{ width: `${pct}%`, background: "var(--color-octo-brass)" }}
          />
        </div>
        <Row label="unstaged" value={String(unstaged)} />
        <Row label="tool calls" value={String(toolCalls)} />
      </div>
    </section>
  );
}

function Row({ label, value, brass }: { label: string; value: string; brass?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span>{label}</span>
      <span className={`font-mono text-[10px] ${brass ? "text-octo-brass" : "text-octo-ivory"}`}>
        {value}
      </span>
    </div>
  );
}

function formatThousands(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
