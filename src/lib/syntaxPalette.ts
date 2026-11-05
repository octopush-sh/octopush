import { tags as t, type Tag } from "@lezer/highlight";

/**
 * The syntax palette — which kind every highlighting tag belongs to, and which
 * ink each kind is painted in. One table feeds both highlighters, so the
 * Review diff colours exactly what the editor colours:
 *
 * - `components/editor/atelierTheme.ts` turns it into inline colours from the
 *   live theme tokens (CodeMirror's theme API can't read `var(--…)`);
 * - `lib/diffSyntax.ts` turns it into `.tok-*` classes, styled in styles.css.
 *
 * Only palette inks, no new hues (design-system spec, "Syntax"). Brass stays
 * on keywords alone; types moved to state-blue so the accent stays surgical.
 * Comments are mute and upright — quieter than text, never italic.
 */
export type SyntaxKind =
  | "keyword"
  | "type"
  | "function"
  | "string"
  | "constant"
  | "meta"
  | "property"
  | "plain"
  | "comment"
  | "punctuation"
  | "heading"
  | "strong"
  | "invalid";

/** A palette ink, named as `EditorTokens` names it. */
export type SyntaxInk =
  | "brass"
  | "stateBlue"
  | "verdigris"
  | "sage"
  | "statePurple"
  | "warning"
  | "ivory"
  | "mute"
  | "rouge";

export interface SyntaxKindStyle {
  ink: SyntaxInk;
  /** The Review diff's class for this kind (styles.css, `.tok-*`). */
  cls: string;
  fontWeight?: string;
}

export const SYNTAX_KINDS: Record<SyntaxKind, SyntaxKindStyle> = {
  keyword:     { ink: "brass",       cls: "tok-kw" },
  type:        { ink: "stateBlue",   cls: "tok-type" },
  function:    { ink: "statePurple", cls: "tok-fn" },
  // Strings and comments are the two quiet kinds that sit side by side most
  // often; sage reads too close to mute (on Vellum, #6d5e4b vs #6f5f4a), so
  // strings take verdigris and sage goes to the sparser numbers and constants.
  string:      { ink: "verdigris",   cls: "tok-str" },
  constant:    { ink: "sage",        cls: "tok-num" },
  // Amber is the warning ink; annotations, decorators and macros are rare
  // enough in a file that it still reads as an exception, not as a theme.
  meta:        { ink: "warning",     cls: "tok-meta" },
  property:    { ink: "ivory",       cls: "tok-prop" },
  plain:       { ink: "ivory",       cls: "tok-var" },
  comment:     { ink: "mute",        cls: "tok-cmt" },
  punctuation: { ink: "mute",        cls: "tok-punct" },
  heading:     { ink: "brass",       cls: "tok-kw", fontWeight: "600" },
  strong:      { ink: "ivory",       cls: "tok-var", fontWeight: "600" },
  invalid:     { ink: "rouge",       cls: "tok-invalid" },
};

/**
 * Tag → kind. A tag with modifiers falls back to its base here (CodeMirror
 * matches `definition(variableName)` against a `variableName` rule), and a
 * sub-tag to its parent (`lineComment` → `comment`), so the more specific
 * entries only exist where the kind differs from the fallback.
 *
 * Every tag a supported language emits must resolve to a rule:
 * `syntaxPalette.coverage.test.ts` parses a fixture per language and fails on
 * any tag left unstyled.
 */
export const SYNTAX_RULES: ReadonlyArray<{ tag: Tag | readonly Tag[]; kind: SyntaxKind }> = [
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self],
    kind: "keyword",
  },

  { tag: [t.typeName, t.className, t.namespace, t.tagName], kind: "type" },

  // Calls and definitions alike. `standard(variableName)` is a builtin
  // (`echo`, `print`): stream modes tag them so, and they read as calls.
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.variableName)],
    kind: "function",
  },

  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.attributeValue, t.url, t.link, t.monospace], kind: "string" },

  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.variableName), t.special(t.variableName)],
    kind: "constant",
  },

  // Annotations, decorators and macros (Rust's `println!` is a macro, not a call).
  { tag: [t.meta, t.annotation, t.documentMeta, t.macroName], kind: "meta" },

  { tag: [t.propertyName, t.attributeName], kind: "property" },

  // `name` is the bare identifier SQL and PHP emit; it is also the parent of
  // every named tag, so it only catches names no rule above claims.
  { tag: [t.name, t.variableName, t.labelName, t.operator, t.content, t.emphasis, t.strikethrough, t.quote, t.list], kind: "plain" },

  { tag: t.comment, kind: "comment" },

  // Structure, not content: brackets, separators, the `.` of a member access
  // and Markdown's marks (`#`, `*`, `` ` ``), which are processing instructions.
  {
    tag: [t.punctuation, t.separator, t.bracket, t.angleBracket, t.derefOperator, t.processingInstruction],
    kind: "punctuation",
  },

  { tag: t.heading, kind: "heading" },
  { tag: t.strong, kind: "strong" },
  { tag: t.invalid, kind: "invalid" },
];
