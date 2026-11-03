import type { Extension } from "@codemirror/state";
import { StreamLanguage, type Language, type LanguageSupport, type StreamParser } from "@codemirror/language";
import type { LangId } from "./editorLang";

/**
 * CodeMirror language support for a `LangId` (see `editorLang.ts`). Shared by
 * the Review editor, Quick View and the Review diff. Languages without a
 * first-party Lezer package use `@codemirror/legacy-modes` stream parsers —
 * highlighting only, which is all a viewer/editor needs. Unknown → plain text.
 *
 * Every grammar is its own chunk, fetched by a dynamic `import()` the first
 * time a file in that language is shown: none of them is in the initial
 * bundle. Callers install what `loadedLanguageSupport` already has and
 * reconfigure once `loadLanguageSupport` resolves.
 */
interface Grammar {
  /** What the editor installs: the full `LanguageSupport` where there is one. */
  support: Extension;
  /** The bare parser, for the Review diff. */
  language: Language;
}

const lezer = (s: LanguageSupport): Grammar => ({ support: s, language: s.language });
const stream = <T>(parser: StreamParser<T>): Grammar => {
  const l = StreamLanguage.define(parser);
  return { support: l, language: l };
};

/** LangIds with no loader of their own: plain text, and C (read with the C++
 *  grammar, see `keyOf`). */
type NoLoader = "plaintext" | "c";

/** One loader per LangId that has a grammar — exhaustive, so a LangId added
 *  without a loader fails the build. Each `import()` names its module
 *  literally so the bundler can split it out. */
const LOADERS: Record<Exclude<LangId, NoLoader>, () => Promise<Grammar>> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => lezer(m.javascript())),
  jsx:        () => import("@codemirror/lang-javascript").then((m) => lezer(m.javascript({ jsx: true }))),
  typescript: () => import("@codemirror/lang-javascript").then((m) => lezer(m.javascript({ typescript: true }))),
  tsx:        () => import("@codemirror/lang-javascript").then((m) => lezer(m.javascript({ typescript: true, jsx: true }))),
  rust:       () => import("@codemirror/lang-rust").then((m) => lezer(m.rust())),
  python:     () => import("@codemirror/lang-python").then((m) => lezer(m.python())),
  java:       () => import("@codemirror/lang-java").then((m) => lezer(m.java())),
  json:       () => import("@codemirror/lang-json").then((m) => lezer(m.json())),
  markdown:   () => import("@codemirror/lang-markdown").then((m) => lezer(m.markdown())),
  html:       () => import("@codemirror/lang-html").then((m) => lezer(m.html())),
  css:        () => import("@codemirror/lang-css").then((m) => lezer(m.css())),
  xml:        () => import("@codemirror/lang-xml").then((m) => lezer(m.xml())),
  yaml:       () => import("@codemirror/lang-yaml").then((m) => lezer(m.yaml())),
  go:         () => import("@codemirror/lang-go").then((m) => lezer(m.go())),
  // One grammar reads both C and C++ (C is, near enough, a subset): `c` is
  // looked up as `cpp`, see `keyOf`.
  cpp:        () => import("@codemirror/lang-cpp").then((m) => lezer(m.cpp())),
  sql:        () => import("@codemirror/lang-sql").then((m) => lezer(m.sql())),
  sass:       () => import("@codemirror/lang-sass").then((m) => lezer(m.sass({ indented: true }))),
  scss:       () => import("@codemirror/lang-sass").then((m) => lezer(m.sass())),
  php:        () => import("@codemirror/lang-php").then((m) => lezer(m.php())),
  shell:      () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  toml:       () => import("@codemirror/legacy-modes/mode/toml").then((m) => stream(m.toml)),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => stream(m.dockerFile)),
  properties: () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  ruby:       () => import("@codemirror/legacy-modes/mode/ruby").then((m) => stream(m.ruby)),
  swift:      () => import("@codemirror/legacy-modes/mode/swift").then((m) => stream(m.swift)),
  csharp:     () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.csharp)),
  kotlin:     () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.kotlin)),
  scala:      () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.scala)),
  dart:       () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.dart)),
  groovy:     () => import("@codemirror/legacy-modes/mode/groovy").then((m) => stream(m.groovy)),
  protobuf:   () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => stream(m.protobuf)),
  lua:        () => import("@codemirror/legacy-modes/mode/lua").then((m) => stream(m.lua)),
};

/** Every LangId with a grammar to load (`c` included). */
export const GRAMMAR_LANGS: readonly LangId[] = [...(Object.keys(LOADERS) as LangId[]), "c"];

const keyOf = (lang: LangId): LangId => (lang === "c" ? "cpp" : lang);

const loaderOf = (key: LangId): (() => Promise<Grammar>) | undefined =>
  key in LOADERS ? LOADERS[key as keyof typeof LOADERS] : undefined;

/** Memoised loads, one per LangId, and the grammars that have landed. */
const pending = new Map<LangId, Promise<Grammar | null>>();
const loaded = new Map<LangId, Grammar | null>();

function loadGrammar(lang: LangId): Promise<Grammar | null> {
  const key = keyOf(lang);
  const known = pending.get(key);
  if (known) return known;
  const load = loaderOf(key);
  if (!load) {
    // Plain text: nothing to fetch, and known synchronously from now on.
    loaded.set(key, null);
    const none = Promise.resolve(null);
    pending.set(key, none);
    return none;
  }
  const p = load().then(
    (g) => { loaded.set(key, g); return g; },
    (e) => {
      // A chunk that failed to fetch can be asked for again; until then the
      // file reads as plain text.
      pending.delete(key);
      console.warn(`Could not load the ${key} grammar`, e);
      return null;
    },
  );
  pending.set(key, p);
  return p;
}

/** The editor extension for `lang`, loading its grammar on first use.
 *  Plain text (or a failed load) → no extension. */
export function loadLanguageSupport(lang: LangId): Promise<Extension> {
  return loadGrammar(lang).then((g) => g?.support ?? []);
}

/** The bare `Language` (parser only) for `lang`, loading it on first use —
 *  the same set the editor highlights, so the Review diff can't fall behind
 *  it. Plain text → null. */
export function loadLanguage(lang: LangId): Promise<Language | null> {
  return loadGrammar(lang).then((g) => g?.language ?? null);
}

/** The editor extension, if it has already loaded; undefined while not yet. */
export function loadedLanguageSupport(lang: LangId): Extension | undefined {
  const key = keyOf(lang);
  if (!loaded.has(key)) return loaderOf(key) ? undefined : [];
  return loaded.get(key)?.support ?? [];
}

/** The `Language`, if it has already loaded (null for plain text); undefined
 *  while not yet. Never starts a load. */
export function loadedLanguage(lang: LangId): Language | null | undefined {
  const key = keyOf(lang);
  if (!loaded.has(key)) return loaderOf(key) ? undefined : null;
  return loaded.get(key)?.language ?? null;
}
