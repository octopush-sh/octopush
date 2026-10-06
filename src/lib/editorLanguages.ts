import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
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
import { c, cpp, csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import type { LangId } from "./editorLang";

/**
 * CodeMirror language support for a `LangId` (see `editorLang.ts`). Shared by
 * the Review editor and Quick View. Languages without a first-party Lezer
 * package use `@codemirror/legacy-modes` stream parsers — highlighting only,
 * which is all a viewer/editor needs. Unknown → no extension (plain text).
 */
export function languageSupport(lang: LangId): Extension {
  switch (lang) {
    case "javascript": return javascript({ typescript: true, jsx: true });
    case "rust":       return rust();
    case "python":     return python();
    case "java":       return java();
    case "json":       return json();
    case "markdown":   return markdown();
    case "html":       return html();
    case "css":        return css();
    case "xml":        return xml();
    case "yaml":       return yaml();
    case "shell":      return StreamLanguage.define(shell);
    case "toml":       return StreamLanguage.define(toml);
    case "go":         return StreamLanguage.define(go);
    case "sql":        return StreamLanguage.define(standardSQL);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "properties": return StreamLanguage.define(properties);
    case "ruby":       return StreamLanguage.define(ruby);
    case "swift":      return StreamLanguage.define(swift);
    case "c":          return StreamLanguage.define(c);
    case "cpp":        return StreamLanguage.define(cpp);
    case "csharp":     return StreamLanguage.define(csharp);
    case "kotlin":     return StreamLanguage.define(kotlin);
    case "lua":        return StreamLanguage.define(lua);
    default:           return [];
  }
}
