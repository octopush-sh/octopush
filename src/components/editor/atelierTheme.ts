/**
 * Atelier in Onyx & Brass — CodeMirror 6 theme.
 *
 * Hex values mirror the CSS variables defined in src/styles.css @theme block
 * and tokens.ts. Inline hex is intentional here: CodeMirror's theme() API
 * takes a JS object, not CSS variables; reading CSS variables at runtime would
 * require document access and complicate SSR/test environments.
 */

import { EditorView } from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

// ── Token mirrors ─────────────────────────────────────────────────
const ONYX    = "#0c0a08";
const PANEL   = "#14110d";
const HAIRLINE = "#2a2419";
const BRASS   = "#d4a574";
const IVORY   = "#f4ecdb";
const SAGE    = "#95897a";
const MUTE    = "#6d6354";
const ROUGE   = "#d18b8b";
const BRASS_GHOST = "rgba(212, 165, 116, 0.08)";
const BRASS_FAINT = "rgba(212, 165, 116, 0.04)";

// ── Editor view theme ─────────────────────────────────────────────

const atelierEditorTheme = EditorView.theme(
  {
    "&": {
      color: IVORY,
      backgroundColor: ONYX,
      fontSize: "13px",
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    },

    ".cm-content": {
      caretColor: BRASS,
      padding: "8px 0",
    },

    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: BRASS,
      borderLeftWidth: "2px",
    },

    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: BRASS_GHOST,
    },

    ".cm-gutters": {
      backgroundColor: PANEL,
      color: MUTE,
      border: "none",
      borderRight: `1px solid ${HAIRLINE}`,
    },

    ".cm-activeLineGutter": {
      backgroundColor: BRASS_FAINT,
    },

    ".cm-activeLine": {
      backgroundColor: BRASS_FAINT,
    },

    ".cm-lineNumbers .cm-gutterElement": {
      paddingRight: "12px",
      paddingLeft: "8px",
      minWidth: "32px",
    },

    ".cm-foldGutter .cm-gutterElement": {
      color: MUTE,
    },

    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(212, 165, 116, 0.15)",
    },

    ".cm-tooltip": {
      backgroundColor: PANEL,
      border: `1px solid ${HAIRLINE}`,
      color: IVORY,
    },

    // ── Search / go-to-line panel (Atelier) ─────────────────────────
    ".cm-panels": {
      backgroundColor: PANEL,
      color: IVORY,
      borderTop: `1px solid ${HAIRLINE}`,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${HAIRLINE}`,
      borderTop: "none",
    },
    ".cm-panel.cm-search": {
      padding: "6px 8px",
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: "11px",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search input[type=text]": {
      backgroundColor: ONYX,
      color: IVORY,
      border: `1px solid ${HAIRLINE}`,
      borderRadius: "4px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panel.cm-search input:focus": {
      borderColor: BRASS,
    },
    ".cm-panel.cm-search .cm-button": {
      backgroundColor: "transparent",
      backgroundImage: "none",
      color: SAGE,
      border: `1px solid ${HAIRLINE}`,
      borderRadius: "4px",
      padding: "2px 8px",
    },
    ".cm-panel.cm-search .cm-button:hover": {
      color: IVORY,
      borderColor: BRASS,
    },
    ".cm-panel.cm-search label": {
      color: MUTE,
      fontSize: "11px",
    },
    ".cm-panel.cm-search .cm-textfield:focus": {
      borderColor: BRASS,
    },
    ".cm-searchMatch": {
      backgroundColor: BRASS_GHOST,
      outline: `1px solid ${HAIRLINE}`,
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "rgba(212, 165, 116, 0.22)",
    },
    ".cm-panel button[name=close]": {
      color: MUTE,
    },
    ".cm-panel button[name=close]:hover": {
      color: IVORY,
    },

    ".cm-scroller": {
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
    },
  },
  { dark: true },
);

// ── Syntax highlighting ───────────────────────────────────────────

const atelierHighlightStyle = HighlightStyle.define([
  // Keywords: brass
  { tag: tags.keyword,            color: BRASS, fontWeight: "500" },
  { tag: tags.controlKeyword,     color: BRASS },
  { tag: tags.definitionKeyword,  color: BRASS },
  { tag: tags.moduleKeyword,      color: BRASS },
  { tag: tags.operatorKeyword,    color: BRASS },

  // Strings: sage
  { tag: tags.string,             color: SAGE },
  { tag: tags.special(tags.string), color: SAGE },
  { tag: tags.regexp,             color: SAGE },
  { tag: tags.escape,             color: SAGE },

  // Numbers: rouge (distinctive)
  { tag: tags.number,             color: ROUGE },
  { tag: tags.integer,            color: ROUGE },
  { tag: tags.float,              color: ROUGE },

  // Comments: mute (upright — no cursive type anywhere in the app)
  { tag: tags.comment,            color: MUTE },
  { tag: tags.lineComment,        color: MUTE },
  { tag: tags.blockComment,       color: MUTE },

  // Functions: ivory
  { tag: tags.function(tags.variableName), color: IVORY },
  { tag: tags.function(tags.propertyName), color: IVORY },

  // Types / classes: brass
  { tag: tags.typeName,           color: BRASS },
  { tag: tags.className,          color: BRASS },
  { tag: tags.namespace,          color: BRASS },
  { tag: tags.definition(tags.typeName), color: BRASS },

  // Operators & punctuation: sage
  { tag: tags.operator,           color: SAGE },
  { tag: tags.punctuation,        color: SAGE },
  { tag: tags.separator,          color: SAGE },
  { tag: tags.bracket,            color: SAGE },

  // HTML tags: brass
  { tag: tags.tagName,            color: BRASS },
  { tag: tags.angleBracket,       color: SAGE },

  // HTML attributes: sage
  { tag: tags.attributeName,      color: SAGE },
  { tag: tags.attributeValue,     color: SAGE },

  // Variables / properties: ivory (base)
  { tag: tags.variableName,       color: IVORY },
  { tag: tags.propertyName,       color: IVORY },

  // Boolean / null / undefined: brass
  { tag: tags.bool,               color: BRASS },
  { tag: tags.null,               color: MUTE },

  // Headings (Markdown): brass
  { tag: tags.heading,            color: BRASS, fontWeight: "600" },

  // Links (Markdown): sage
  { tag: tags.link,               color: SAGE },

  // Special / meta: mute
  { tag: tags.meta,               color: MUTE },
  { tag: tags.processingInstruction, color: MUTE },
]);

// ── Exported extension ────────────────────────────────────────────

/** Combined CodeMirror extension: Atelier editor theme + syntax highlighting. */
export const atelierTheme: Extension = [
  atelierEditorTheme,
  syntaxHighlighting(atelierHighlightStyle),
];
