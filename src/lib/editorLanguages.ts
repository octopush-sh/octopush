import type { Extension } from "@codemirror/state";
import { StreamLanguage, type Language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { go } from "@codemirror/legacy-modes/mode/go";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { c, cpp, csharp, kotlin, scala, dart } from "@codemirror/legacy-modes/mode/clike";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import type { LangId } from "./editorLang";

/** `@codemirror/lang-javascript` options per JS/TS dialect. */
const JS_OPTIONS = {
  javascript: {},
  jsx: { jsx: true },
  typescript: { typescript: true },
  tsx: { typescript: true, jsx: true },
} as const;

/**
 * CodeMirror language support for a `LangId` (see `editorLang.ts`). Shared by
 * the Review editor and Quick View. Languages without a first-party Lezer
 * package use `@codemirror/legacy-modes` stream parsers — highlighting only,
 * which is all a viewer/editor needs. Unknown → no extension (plain text).
 */
export function languageSupport(lang: LangId): Extension {
  switch (lang) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":        return javascript(JS_OPTIONS[lang]);
    case "rust":       return rust();
    case "python":     return python();
    case "java":       return java();
    case "json":       return json();
    case "markdown":   return markdown();
    case "html":       return html();
    case "css":        return css();
    case "xml":        return xml();
    case "yaml":       return yaml();
    default:           return languageFor(lang) ?? [];
  }
}

/** Memoised parsers — constructed once per LangId. */
const languages = new Map<LangId, Language | null>();

/**
 * The bare `Language` (parser only) for a `LangId` — the same set the editor
 * highlights, so the Review diff can't fall behind it. Unknown → null.
 */
export function languageFor(lang: LangId): Language | null {
  if (languages.has(lang)) return languages.get(lang)!;
  let l: Language | null;
  switch (lang) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":        l = javascript(JS_OPTIONS[lang]).language; break;
    case "rust":       l = rust().language; break;
    case "python":     l = python().language; break;
    case "java":       l = java().language; break;
    case "json":       l = json().language; break;
    case "markdown":   l = markdown().language; break;
    case "html":       l = html().language; break;
    case "css":        l = css().language; break;
    case "xml":        l = xml().language; break;
    case "yaml":       l = yaml().language; break;
    case "sass":       l = StreamLanguage.define(sass); break;
    case "shell":      l = StreamLanguage.define(shell); break;
    case "toml":       l = StreamLanguage.define(toml); break;
    case "go":         l = StreamLanguage.define(go); break;
    case "sql":        l = StreamLanguage.define(standardSQL); break;
    case "dockerfile": l = StreamLanguage.define(dockerFile); break;
    case "properties": l = StreamLanguage.define(properties); break;
    case "ruby":       l = StreamLanguage.define(ruby); break;
    case "swift":      l = StreamLanguage.define(swift); break;
    case "c":          l = StreamLanguage.define(c); break;
    case "cpp":        l = StreamLanguage.define(cpp); break;
    case "csharp":     l = StreamLanguage.define(csharp); break;
    case "kotlin":     l = StreamLanguage.define(kotlin); break;
    case "scala":      l = StreamLanguage.define(scala); break;
    case "groovy":     l = StreamLanguage.define(groovy); break;
    case "dart":       l = StreamLanguage.define(dart); break;
    case "protobuf":   l = StreamLanguage.define(protobuf); break;
    case "lua":        l = StreamLanguage.define(lua); break;
    default:           l = null;
  }
  languages.set(lang, l);
  return l;
}
