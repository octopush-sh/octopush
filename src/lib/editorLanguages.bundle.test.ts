// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { build, type Rolldown } from "vite";

/**
 * Bundle check: builds the real app (`index.html`, with the project's
 * `vite.config.ts`, as `npm run build` does) and reads the output. What a
 * window loads at startup is the entry chunk plus its root — `App` for the
 * main window, `QuickViewApp` for a Quick View — and every chunk those import
 * statically. No grammar may be in there: each is a lazy chunk of its own,
 * fetched by `editorLanguages.ts` the first time a file in that language
 * shows. One static import of a grammar package anywhere in the app would
 * pull it back in, and this fails.
 */
const ROOT = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const GRAMMAR = /node_modules[\\/](@codemirror[\\/](lang-[a-z]+|legacy-modes)|@lezer[\\/](?!common|highlight|lr)[a-z]+)[\\/]/;
/** The roots `main.tsx` loads for each kind of window. */
const ROOTS = [/[\\/]src[\\/]App\.tsx$/, /[\\/]src[\\/]quickview[\\/]QuickViewApp\.tsx$/];

type Chunk = Rolldown.OutputChunk;
let chunks: Chunk[] = [];
let startup: Chunk[] = [];

/** `c` and every chunk it imports statically, transitively. */
function staticGraph(c: Chunk, byName: Map<string, Chunk>, seen = new Set<string>()): Set<string> {
  if (seen.has(c.fileName)) return seen;
  seen.add(c.fileName);
  for (const dep of c.imports) { const d = byName.get(dep); if (d) staticGraph(d, byName, seen); }
  return seen;
}

beforeAll(async () => {
  const result = await build({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    mode: "production",
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  chunks = outputs.flatMap((o) => o.output).filter((f): f is Chunk => f.type === "chunk");

  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const roots = chunks.filter((c) =>
    c.isEntry || ROOTS.some((r) => c.facadeModuleId != null && r.test(c.facadeModuleId)));
  const seen = new Set<string>();
  roots.forEach((c) => staticGraph(c, byName, seen));
  startup = chunks.filter((c) => seen.has(c.fileName));
}, 300_000);

const has = (cs: Chunk[], pkg: string) =>
  cs.some((c) => c.moduleIds.some((id) => id.includes(`/${pkg}/`) || id.includes(`\\${pkg.replace("/", "\\")}\\`)));

describe("app bundle: language grammars", () => {
  it("finds the entry and both window roots", () => {
    expect(chunks.some((c) => c.isEntry)).toBe(true);
    for (const r of ROOTS) {
      expect(chunks.some((c) => c.facadeModuleId != null && r.test(c.facadeModuleId)), String(r)).toBe(true);
    }
  });

  it("loads no grammar at startup", () => {
    const eager = [...new Set(startup.flatMap((c) => c.moduleIds).filter((id) => GRAMMAR.test(id)))];
    expect(eager).toEqual([]);
  });

  it("ships every grammar as a lazy chunk", () => {
    const lazy = chunks.filter((c) => !startup.includes(c));
    for (const pkg of [
      "lang-javascript", "lang-rust", "lang-python", "lang-java", "lang-json", "lang-markdown",
      "lang-html", "lang-css", "lang-xml", "lang-yaml", "lang-go", "lang-cpp", "lang-sql",
      "lang-sass", "lang-php", "legacy-modes",
    ]) {
      expect(has(lazy, `@codemirror/${pkg}`), pkg).toBe(true);
    }
    // Go and C++ don't share a chunk: opening a .go file fetches no C++.
    const chunkOf = (pkg: string) => lazy.find((c) => has([c], `@lezer/${pkg}`));
    expect(chunkOf("go")).toBeDefined();
    expect(chunkOf("go")).not.toBe(chunkOf("cpp"));
  });
});
