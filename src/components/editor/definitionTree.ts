/**
 * What the syntax tree says about an identifier, for go-to-definition.
 *
 * `symbolIndex.ts` reads one line at a time because the workspace tier only
 * has search previews. In the open file we can do better where the language
 * has a real Lezer grammar (JavaScript/TypeScript, Java, Rust, Python, Go,
 * C/C++): the parser already knows which token is a keyword and which
 * identifier is the one being declared. This module answers exactly those two
 * questions, and answers "unknown" whenever the tree can't — a stream-mode
 * language (C#, Kotlin, …), a document not parsed that far, or a node it
 * doesn't know. Callers then fall back to the line heuristic. C and C++ get
 * the keyword answer only: their declarators nest too many ways for the site
 * check to veto a candidate safely. C parses with the C++ grammar, so the
 * C++-only keywords are names there.
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { JS_DIALECTS, type LangId } from "../../lib/editorLang";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree["resolveInner"]>;

/** Languages whose grammar names the declarations `classifySite` looks for. */
const SITE_LANGS = new Set<string>([...JS_DIALECTS, ...(["java", "rust", "python", "go"] satisfies LangId[])]);

/** Languages whose grammar names the keywords `classifyClick` looks for. */
const TREE_LANGS = new Set<string>([...SITE_LANGS, ...(["c", "cpp"] satisfies LangId[])]);

export function hasDefinitionTree(lang: string | undefined): boolean {
  return !!lang && TREE_LANGS.has(lang);
}

/** How long a go-to-definition may wait for the parser to reach a position. */
const PARSE_BUDGET_MS = 50;

/** Every Lezer grammar we load names its keyword tokens after their text
 *  (`kw<"static">` is a node called `static`); these are the type keywords
 *  and literals that get a node of their own instead: Java and C/C++'s
 *  `PrimitiveType`, JavaScript/Java's `BooleanLiteral`, Python/Rust's
 *  `Boolean`, Go's `Bool` and `Nil`, and C/C++'s `True`/`False`, `TypeSize`
 *  (`unsigned`, `long`), `Access` (`public`) and `VirtualSpecifier`
 *  (`override`, `final`). */
const TYPE_KEYWORD_NODES = new Set([
  "PrimitiveType", "BooleanLiteral", "Boolean", "Bool", "Nil", "True", "False",
  "TypeSize", "Access", "VirtualSpecifier",
]);

/** TypeScript's primitive types are plain `TypeName`s in its grammar. */
const TS_PRIMITIVES = new Set([
  "boolean", "any", "string", "number", "unknown", "never", "void", "object",
  "bigint", "symbol", "undefined", "null",
]);

/** The grammars' identifier nodes. One of these can share its text with its
 *  node name — a Java class called `Definition`, a Rust type called
 *  `TypeIdentifier` — and is still a name, never a keyword. */
const IDENTIFIER_NODES = new Set([
  "Identifier", "Definition", "TypeName", "TypeIdentifier", "FieldIdentifier",
  "BoundIdentifier", "ScopeIdentifier", "VariableName", "VariableDefinition",
  "PropertyName", "PropertyDefinition", "PrivatePropertyName",
  "PrivatePropertyDefinition", "TypeDefinition", "LabelName", "Label",
  "DefName", "FieldName", "NamespaceIdentifier", "StatementIdentifier",
]);

/** Go's predeclared types and `iota` are plain `TypeName`s and
 *  `VariableName`s in its grammar; `nil` only extends an identifier, so the
 *  parser may keep it as a `VariableName` too. */
const GO_PREDECLARED = new Set([
  "bool", "byte", "rune", "int", "int8", "int16", "int32", "int64", "uint",
  "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64",
  "complex64", "complex128", "string", "iota", "nil",
]);

/** C is parsed with the C++ grammar, so these words still get keyword nodes
 *  in a `.c` file (`private` even gets an `Access` node). C doesn't reserve
 *  them: `dev->class` and `struct node *new` are ordinary C names. `bool`,
 *  `true` and `false` stay keywords; C23 reserves them too. */
const CPP_ONLY_KEYWORDS = new Set([
  "alignas", "alignof", "asm", "catch", "class", "concept", "consteval", "constexpr",
  "constinit", "const_cast", "co_await", "co_return", "co_yield", "decltype",
  "delete", "dynamic_cast", "explicit", "export", "final", "friend", "module",
  "mutable", "namespace", "new", "noexcept", "nullptr", "operator", "override",
  "private", "protected", "public", "reinterpret_cast", "requires",
  "static_assert", "static_cast", "template", "this", "thread_local", "throw",
  "try", "typeid", "typename", "using", "virtual",
]);

/** Rust's primitive types are plain `TypeIdentifier`s in its grammar. */
const RUST_PRIMITIVES = new Set([
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128",
  "usize", "f32", "f64", "bool", "char", "str",
]);

export type ClickVerdict = "keyword" | "identifier" | "unknown";
export type SiteVerdict = "declaration" | "other" | "unknown";

function treeFor(state: EditorState, upTo: number): Tree {
  return ensureSyntaxTree(state, upTo, PARSE_BUDGET_MS) ?? syntaxTree(state);
}

/** The node that spans exactly `from`–`to`, or null. */
function nodeAt(tree: Tree, from: number, to: number): SyntaxNode | null {
  const node = tree.resolveInner(from, 1);
  return node.from === from && node.to === to ? node : null;
}

/**
 * Is the clicked word a keyword or a type keyword? A keyword never starts a
 * workspace search; there is nothing in the workspace that declares `static`.
 */
export function classifyClick(
  state: EditorState,
  lang: string | undefined,
  range: { name: string; from: number; to: number },
): ClickVerdict {
  if (!hasDefinitionTree(lang)) return "unknown";
  const node = nodeAt(treeFor(state, range.to), range.from, range.to);
  if (!node) return "unknown";
  if (lang === "rust" && node.name === "TypeIdentifier" && RUST_PRIMITIVES.has(range.name)) {
    return "keyword";
  }
  if (JS_DIALECTS.has(lang ?? "") && node.name === "TypeName" && TS_PRIMITIVES.has(range.name)) {
    return "keyword";
  }
  if (
    lang === "go" &&
    (node.name === "TypeName" || node.name === "VariableName") &&
    GO_PREDECLARED.has(range.name)
  ) {
    return "keyword";
  }
  if (IDENTIFIER_NODES.has(node.name)) return "identifier";
  if (lang === "c" && CPP_ONLY_KEYWORDS.has(range.name)) return "identifier";
  if (node.name === range.name || TYPE_KEYWORD_NODES.has(node.name)) return "keyword";
  return "identifier";
}

/** Rust items whose `TypeIdentifier` child is the name they declare. */
const RUST_TYPE_ITEMS = new Set([
  "StructItem", "UnionItem", "EnumItem", "TypeItem", "TraitItem", "AssociatedType",
]);

/** Go nodes whose `FieldName` child is the name they declare. */
const GO_FIELD_DECLS = new Set(["MethodDecl", "FieldDecl", "MethodElem"]);

function declaresName(lang: string, node: SyntaxNode): boolean {
  const parent = node.parent?.name ?? "";
  switch (JS_DIALECTS.has(lang) ? "javascript" : lang) {
    case "java":
      return node.name === "Definition";
    case "javascript":
      return (
        node.name === "VariableDefinition" ||
        node.name === "TypeDefinition" ||
        node.name === "PropertyDefinition" ||
        node.name === "PrivatePropertyDefinition"
      );
    case "rust":
      return (
        node.name === "BoundIdentifier" ||
        (node.name === "TypeIdentifier" && RUST_TYPE_ITEMS.has(parent)) ||
        (node.name === "Identifier" && parent === "EnumVariant") ||
        (node.name === "FieldIdentifier" && parent === "FieldDeclaration")
      );
    case "python": {
      if (node.name !== "VariableName") return false;
      if (parent === "FunctionDefinition" || parent === "ClassDefinition") return true;
      if (parent !== "AssignStatement") return false;
      // Only the target, never the value: `total = count` declares `total`.
      const op = node.parent!.getChild("AssignOp") ?? node.parent!.getChild("TypeDef");
      return !!op && node.to <= op.from;
    }
    case "go":
      // `DefName` is every name a declaration introduces: func, type, var,
      // const, `:=`, parameters. Methods and struct fields use `FieldName`.
      return (
        node.name === "DefName" ||
        (node.name === "FieldName" && GO_FIELD_DECLS.has(parent))
      );
    default:
      return false;
  }
}

/**
 * Is the candidate at `from`–`to` really where the name is declared? The line
 * heuristic proposes; the tree confirms or vetoes. `run = 5` in a JavaScript
 * file reads as a binding on its own line, but the tree knows it re-assigns a
 * name declared elsewhere.
 */
export function classifySite(
  state: EditorState,
  lang: string | undefined,
  range: { from: number; to: number },
): SiteVerdict {
  if (!lang || !SITE_LANGS.has(lang)) return "unknown";
  const node = nodeAt(treeFor(state, range.to), range.from, range.to);
  if (!node) return "unknown";
  return declaresName(lang, node) ? "declaration" : "other";
}
