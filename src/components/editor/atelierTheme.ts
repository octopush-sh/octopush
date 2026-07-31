/**
 * Atelier in Onyx & Brass — CodeMirror 6 theme.
 *
 * Octopush supports runtime theme switching (see stores/themeStore.ts), which
 * repaints the app by writing the design tokens as CSS variables on :root.
 * CodeMirror's theme() API, however, takes a plain JS object — it can't read
 * `var(--…)`. So instead of hardcoding hex, we resolve the live token values
 * from the document at build time and rebuild the extension whenever the theme
 * changes (EditorPane reconfigures a compartment on the `octo:theme` event).
 *
 * The static hex below are fallbacks only — used when a token is absent
 * (first paint before themeStore runs, or non-DOM test environments).
 */

import { EditorView } from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { isDarkBackground } from "../../lib/contrast";

// ── Static fallbacks (canonical Onyx & Brass) ─────────────────────
const FALLBACK = {
  onyx:       "#0c0a08",
  panel:      "#14110d",
  hairline:   "#2a2419",
  brass:      "#d4a574",
  ivory:      "#f4ecdb",
  sage:       "#95897a",
  mute:       "#6d6354",
  rouge:      "#d18b8b",
  verdigris:  "#8fc9a8",
  brassGhost: "rgba(212, 165, 116, 0.08)",
  brassFaint: "rgba(212, 165, 116, 0.04)",
  brassGlow:  "rgba(212, 165, 116, 0.12)",
  // Find-in-file match tokens — see the block comment in styles.css. The wash
  // alpha is solved per theme by themeStore; these are the atelier answer.
  match:           "rgba(212, 165, 116, 0.235)",
  matchRing:       "rgba(212, 165, 116, 0.47)",
  matchInk:        "#f4ecdb",
  matchCurrent:    "#d4a574",
  matchCurrentInk: "#0c0a08",
} as const;

export interface EditorTokens {
  onyx: string;
  panel: string;
  hairline: string;
  brass: string;
  ivory: string;
  sage: string;
  mute: string;
  rouge: string;
  verdigris: string;
  brassGhost: string;
  brassFaint: string;
  brassGlow: string;
  /** Wash behind every search match — alpha solved per theme. */
  match: string;
  /** 1px ring that bounds a match against the wash. */
  matchRing: string;
  /** Forced foreground for matched text, so a hit in a dim comment stays
   *  as legible as one in body text. */
  matchInk: string;
  /** Solid fill for the current match — an inverted seal, not a wash. */
  matchCurrent: string;
  /** Foreground on top of `matchCurrent` (the theme's own background). */
  matchCurrentInk: string;
}

/** Read one CSS custom property off :root, falling back when it's empty
 *  (no document, or the token hasn't been written yet). */
function readVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || !document.documentElement) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Resolve the live editor tokens from the active Octopush theme. */
export function resolveEditorTokens(): EditorTokens {
  return {
    onyx:       readVar("--color-octo-onyx", FALLBACK.onyx),
    panel:      readVar("--color-octo-panel", FALLBACK.panel),
    hairline:   readVar("--color-octo-hairline", FALLBACK.hairline),
    brass:      readVar("--color-octo-brass", FALLBACK.brass),
    ivory:      readVar("--color-octo-ivory", FALLBACK.ivory),
    sage:       readVar("--color-octo-sage", FALLBACK.sage),
    mute:       readVar("--color-octo-mute", FALLBACK.mute),
    rouge:      readVar("--color-octo-rouge", FALLBACK.rouge),
    verdigris:  readVar("--color-octo-verdigris", FALLBACK.verdigris),
    brassGhost: readVar("--brass-ghost", FALLBACK.brassGhost),
    brassFaint: readVar("--brass-faint", FALLBACK.brassFaint),
    brassGlow:  readVar("--brass-glow", FALLBACK.brassGlow),
    match:           readVar("--octo-match", FALLBACK.match),
    matchRing:       readVar("--octo-match-ring", FALLBACK.matchRing),
    matchInk:        readVar("--octo-match-ink", FALLBACK.matchInk),
    matchCurrent:    readVar("--octo-match-current", FALLBACK.matchCurrent),
    matchCurrentInk: readVar("--octo-match-current-ink", FALLBACK.matchCurrentInk),
  };
}

const MONO_STACK =
  '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace';

// ── Editor view theme spec ────────────────────────────────────────

/** Build the CodeMirror theme spec from a set of resolved tokens. The custom
 *  EditorSearch overlay replaces CodeMirror's native panel, but the `.cm-panels`
 *  / `.cm-panel.cm-search` rules are kept so the built-in panel still reads as
 *  Atelier if it is ever surfaced (e.g. go-to-line). */
export function makeEditorThemeSpec(t: EditorTokens): Record<string, Record<string, string>> {
  return {
    "&": {
      color: t.ivory,
      backgroundColor: t.onyx,
      fontSize: "13px",
      fontFamily: MONO_STACK,
    },

    ".cm-content": {
      caretColor: t.brass,
      padding: "8px 0",
    },

    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: t.brass,
      borderLeftWidth: "2px",
    },

    // The long first selector is deliberate. CodeMirror's light base theme ships
    // `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
    // at five classes, which outranks a plain `&.cm-focused .cm-selectionBackground`
    // — so once `dark` follows the theme (below), vellum's focused selection would
    // fall through to the library's lavender instead of the Atelier token. Matching
    // that shape ties the specificity, and ours is applied later, so ours wins.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: t.brassGhost,
      },

    ".cm-gutters": {
      backgroundColor: t.panel,
      color: t.mute,
      border: "none",
      borderRight: `1px solid ${t.hairline}`,
    },

    ".cm-activeLineGutter": {
      backgroundColor: t.brassFaint,
    },

    ".cm-activeLine": {
      backgroundColor: t.brassFaint,
    },

    ".cm-lineNumbers .cm-gutterElement": {
      paddingRight: "12px",
      paddingLeft: "8px",
      minWidth: "32px",
    },

    ".cm-foldGutter .cm-gutterElement": {
      color: t.mute,
    },

    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: t.brassGlow,
    },

    ".cm-tooltip": {
      backgroundColor: t.panel,
      border: `1px solid ${t.hairline}`,
      color: t.ivory,
    },

    // ── Search / go-to-line panel (Atelier) ─────────────────────────
    ".cm-panels": {
      backgroundColor: t.panel,
      color: t.ivory,
      borderTop: `1px solid ${t.hairline}`,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${t.hairline}`,
      borderTop: "none",
    },
    ".cm-panel.cm-search": {
      padding: "6px 8px",
      fontFamily: MONO_STACK,
      fontSize: "11px",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search input[type=text]": {
      backgroundColor: t.onyx,
      color: t.ivory,
      border: `1px solid ${t.hairline}`,
      borderRadius: "4px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panel.cm-search input:focus": {
      borderColor: t.brass,
    },
    ".cm-panel.cm-search .cm-button": {
      backgroundColor: "transparent",
      backgroundImage: "none",
      color: t.sage,
      border: `1px solid ${t.hairline}`,
      borderRadius: "4px",
      padding: "2px 8px",
    },
    ".cm-panel.cm-search .cm-button:hover": {
      color: t.ivory,
      borderColor: t.brass,
    },
    ".cm-panel.cm-search label": {
      color: t.mute,
      fontSize: "11px",
    },
    ".cm-panel.cm-search .cm-textfield:focus": {
      borderColor: t.brass,
    },
    // ── Find-in-file matches ────────────────────────────────────────
    // Every match gets the solved wash plus a ring; the CURRENT match is an
    // inverted seal — solid accent with the background colour as ink — so the
    // two are separated by weight rather than by a few points of alpha.
    //
    // The `span` half of each selector is load-bearing. A match is a mark
    // decoration that can nest either side of a syntax-highlight span, and
    // `color` inherits — so setting it only on `.cm-searchMatch` loses to a
    // syntax span nested inside it. Painting the descendants too makes the ink
    // win regardless of which way CodeMirror nested them.
    // A match that crosses syntax-token boundaries stays ONE element, so the
    // ring closes around the whole thing: CodeMirror's ContentBuilder reuses an
    // already-open mark across segments when that mark is the OUTER one
    // (`ensureMarks`), and at `searchMatchHighlight`'s low precedence the match
    // is outer — verified in a real engine, where `root = document` produced a
    // single .cm-searchMatch wrapping three syntax spans.
    //
    // A MULTI-LINE match does fragment, one element per line, because lines are
    // separate DOM parents — so each line gets its own closed box. That reads
    // correctly (a marked region, line by line) and is only reachable by typing
    // an escaped newline into the find field. If the precedence above ever
    // changes so the match nests INSIDE the syntax spans, cross-token matches
    // would fragment too and the seams would look wrong; switch to
    // horizontal-only edges (`inset 0 ±1px 0`, no radius) if that happens.
    ".cm-searchMatch": {
      backgroundColor: t.match,
      borderRadius: "2px",
      boxShadow: `inset 0 0 0 1px ${t.matchRing}`,
    },
    ".cm-searchMatch, .cm-searchMatch span": {
      color: t.matchInk,
    },
    // Must stay after the two rules above: equal specificity, later wins.
    ".cm-searchMatch-selected": {
      backgroundColor: t.matchCurrent,
      boxShadow: "none",
    },
    ".cm-searchMatch-selected, .cm-searchMatch-selected span": {
      color: t.matchCurrentInk,
    },
    ".cm-panel button[name=close]": {
      color: t.mute,
    },
    ".cm-panel button[name=close]:hover": {
      color: t.ivory,
    },

    ".cm-scroller": {
      fontFamily: MONO_STACK,
    },
  };
}

/** Static spec built from the fallback palette — kept as a named export so
 *  unit tests can assert the themed selectors without a live DOM. */
export const editorThemeSpec = makeEditorThemeSpec(FALLBACK);

// ── Syntax highlighting ───────────────────────────────────────────

function makeHighlightStyle(t: EditorTokens): HighlightStyle {
  return HighlightStyle.define([
    // Keywords: brass
    { tag: tags.keyword,            color: t.brass, fontWeight: "500" },
    { tag: tags.controlKeyword,     color: t.brass },
    { tag: tags.definitionKeyword,  color: t.brass },
    { tag: tags.moduleKeyword,      color: t.brass },
    { tag: tags.operatorKeyword,    color: t.brass },

    // Strings: sage
    { tag: tags.string,             color: t.sage },
    { tag: tags.special(tags.string), color: t.sage },
    { tag: tags.regexp,             color: t.sage },
    { tag: tags.escape,             color: t.sage },

    // Numbers: rouge (distinctive)
    { tag: tags.number,             color: t.rouge },
    { tag: tags.integer,            color: t.rouge },
    { tag: tags.float,              color: t.rouge },

    // Comments: mute (upright — no cursive type anywhere in the app)
    { tag: tags.comment,            color: t.mute },
    { tag: tags.lineComment,        color: t.mute },
    { tag: tags.blockComment,       color: t.mute },

    // Functions: ivory
    { tag: tags.function(tags.variableName), color: t.ivory },
    { tag: tags.function(tags.propertyName), color: t.ivory },

    // Types / classes: brass
    { tag: tags.typeName,           color: t.brass },
    { tag: tags.className,          color: t.brass },
    { tag: tags.namespace,          color: t.brass },
    { tag: tags.definition(tags.typeName), color: t.brass },

    // Operators & punctuation: sage
    { tag: tags.operator,           color: t.sage },
    { tag: tags.punctuation,        color: t.sage },
    { tag: tags.separator,          color: t.sage },
    { tag: tags.bracket,            color: t.sage },

    // HTML tags: brass
    { tag: tags.tagName,            color: t.brass },
    { tag: tags.angleBracket,       color: t.sage },

    // HTML attributes: sage
    { tag: tags.attributeName,      color: t.sage },
    { tag: tags.attributeValue,     color: t.sage },

    // Variables / properties: ivory (base)
    { tag: tags.variableName,       color: t.ivory },
    { tag: tags.propertyName,       color: t.ivory },

    // Boolean / null / undefined: brass
    { tag: tags.bool,               color: t.brass },
    { tag: tags.null,               color: t.mute },

    // Headings (Markdown): brass
    { tag: tags.heading,            color: t.brass, fontWeight: "600" },

    // Links (Markdown): sage
    { tag: tags.link,               color: t.sage },

    // Special / meta: mute
    { tag: tags.meta,               color: t.mute },
    { tag: tags.processingInstruction, color: t.mute },
  ]);
}

// ── Exported extensions ───────────────────────────────────────────

/** Build a fresh combined extension (editor theme + syntax highlighting) from
 *  the CURRENTLY active Octopush theme tokens. Call this again — and reconfigure
 *  the editor's theme compartment — whenever the theme changes.
 *
 *  `dark` follows the resolved background rather than being hardcoded: it was
 *  `true` unconditionally, which handed CodeMirror's dark-mode defaults to the
 *  vellum light theme. */
export function buildEditorTheme(): Extension {
  const t = resolveEditorTokens();
  return [
    EditorView.theme(makeEditorThemeSpec(t), { dark: isDarkBackground(t.onyx) }),
    syntaxHighlighting(makeHighlightStyle(t)),
  ];
}
