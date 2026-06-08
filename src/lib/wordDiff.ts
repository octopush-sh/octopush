export interface WordSegment { kind: "equal" | "add" | "del"; text: string; }

const TOKEN_RE = /(\s+|\w+|[^\s\w]+)/g;
const MAX_TOKENS = 400;

function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

/** LCS over two token arrays; returns aligned add/del/equal segments per side. */
export function wordDiff(oldText: string, newText: string): { old: WordSegment[]; new: WordSegment[] } {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return { old: [{ kind: "equal", text: oldText }], new: [{ kind: "equal", text: newText }] };
  }
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const oldSegs: WordSegment[] = [], newSegs: WordSegment[] = [];
  const push = (segs: WordSegment[], kind: WordSegment["kind"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text; else segs.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { push(oldSegs, "equal", a[i]); push(newSegs, "equal", b[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(oldSegs, "del", a[i]); i++; }
    else { push(newSegs, "add", b[j]); j++; }
  }
  while (i < m) push(oldSegs, "del", a[i++]);
  while (j < n) push(newSegs, "add", b[j++]);
  return { old: oldSegs, new: newSegs };
}
