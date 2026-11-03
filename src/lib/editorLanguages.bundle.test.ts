// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { build, type Rolldown } from "vite";

/**
 * Bundle check: builds `editorLanguages.ts` with Vite (as the app build does)
 * and reads the output. The grammars must be lazy chunks of their own, never
 * in what loads with the module, and the module itself stays small.
 *
 * CodeMirror's core (state, view, language, autocomplete) and Lezer's runtime
 * are external: the app loads them for the editor anyway, so they would only
 * blur the number this guards.
 */
const CORE = /^@codemirror\/(state|view|language|autocomplete|lint|commands|search)$|^@lezer\/(common|highlight|lr)$/;
const GRAMMAR = /node_modules[\\/](@codemirror[\\/](lang-[a-z]+|legacy-modes)|@lezer[\\/](?!common|highlight|lr)[a-z]+)[\\/]/;

/** What `import "./editorLanguages"` may cost, minified. */
const ENTRY_BUDGET_BYTES = 8 * 1024;

type Chunk = Rolldown.OutputChunk;
let chunks: Chunk[] = [];
let initial: Chunk[] = [];

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      rolldownOptions: {
        input: decodeURIComponent(new URL("./editorLanguages.ts", import.meta.url).pathname),
        external: (id: string) => CORE.test(id),
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  chunks = outputs.flatMap((o) => o.output).filter((f): f is Chunk => f.type === "chunk");

  // The entry and every chunk it imports statically: what loads with it.
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const visit = (c: Chunk) => {
    if (seen.has(c.fileName)) return;
    seen.add(c.fileName);
    for (const dep of c.imports) { const d = byName.get(dep); if (d) visit(d); }
  };
  chunks.filter((c) => c.isEntry).forEach(visit);
  initial = chunks.filter((c) => seen.has(c.fileName));
}, 120_000);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const bytes = (cs: Chunk[]) => cs.reduce((n, c) => n + new TextEncoder().encode(c.code).length, 0);

describe("editorLanguages bundle", () => {
  it("loads no grammar with the module", () => {
    expect(initial.length).toBeGreaterThan(0);
    const eager = initial.flatMap((c) => c.moduleIds).filter((id) => GRAMMAR.test(id));
    expect(eager).toEqual([]);
  });

  it("splits each grammar into a lazy chunk", () => {
    const lazy = chunks.filter((c) => !initial.includes(c));
    const lazyIds = lazy.flatMap((c) => c.moduleIds);
    for (const pkg of ["lang-javascript", "lang-go", "lang-cpp", "lang-sql", "lang-sass", "lang-php", "legacy-modes"]) {
      expect(lazyIds.some((id) => id.includes(`@codemirror/${pkg}/`) || id.includes(`@codemirror\\${pkg}\\`)), pkg).toBe(true);
    }
    // Go and SQL don't share a chunk: opening a .go file fetches no SQL.
    const chunkOf = (pkg: string) => lazy.find((c) => c.moduleIds.some((id) => id.includes(`@lezer/${pkg}/`) || id.includes(`@lezer\\${pkg}\\`)));
    expect(chunkOf("go")).toBeDefined();
    expect(chunkOf("go")).not.toBe(chunkOf("cpp"));
  });

  it(`keeps the module under ${kb(ENTRY_BUDGET_BYTES)}`, () => {
    const size = bytes(initial);
    const grammars = bytes(chunks.filter((c) => !initial.includes(c)));
    expect(size, `entry ${kb(size)}, grammars ${kb(grammars)} (lazy)`).toBeLessThan(ENTRY_BUDGET_BYTES);
    // Sanity: the grammars really are the bulk the split keeps off the start.
    expect(grammars).toBeGreaterThan(size * 10);
  });
});
