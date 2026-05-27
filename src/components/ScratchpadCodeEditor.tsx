import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { useRef } from "react";

const EDITOR_STYLES = {
  fontFamily: "'JetBrains Mono', 'Courier New', monospace",
  fontSize: "12px",
  lineHeight: "1.5",
  letterSpacing: "0px",
  tabSize: 2,
} as const;

export function ScratchpadCodeEditor() {
  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const tabs = useScratchpadStore((s) => s.tabs);
  const setContent = useScratchpadStore((s) => s.setContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-octo-onyx">
        <p className="text-octo-mute">No tab selected</p>
      </div>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (activeTabId) {
      const newValue = e.target.value;
      setContent(activeTabId, newValue);
    }
  };

  // Get highlighted code
  let highlightedCode = activeTab.content;
  if (activeTab.language !== "plaintext" && activeTab.content) {
    try {
      const highlighted = hljs.highlight(activeTab.content, {
        language: activeTab.language,
        ignoreIllegals: true,
      });
      highlightedCode = highlighted.value;
    } catch {
      highlightedCode = activeTab.content;
    }
  }

  return (
    <div className="h-full w-full bg-octo-onyx overflow-hidden flex flex-col">
      {/* Empty state placeholder */}
      {!activeTab.content && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <p className="font-serif italic text-[14px] text-octo-brass text-center px-4">
            Paste code here, or start typing…
          </p>
        </div>
      )}

      {/* Container with both textarea and display layer */}
      <div className="relative flex-1 overflow-hidden">
        {/* Textarea for editing (positioned absolutely, invisible text) */}
        <textarea
          ref={textareaRef}
          value={activeTab.content}
          onChange={handleChange}
          className="absolute inset-0 w-full h-full bg-transparent resize-none focus:outline-none"
          style={{
            ...EDITOR_STYLES,
            padding: "16px",
            color: "transparent",
            WebkitTextFillColor: "transparent",
            caretColor: "var(--color-octo-brass)",
            zIndex: 20,
            margin: 0,
            border: "none",
            boxSizing: "border-box",
          } as React.CSSProperties}
          spellCheck="false"
          wrap="off"
        />

        {/* Syntax highlighted display layer (no interaction, behind textarea) */}
        <div
          className="absolute inset-0 w-full h-full overflow-auto"
          style={{
            ...EDITOR_STYLES,
            padding: "16px",
            margin: 0,
            boxSizing: "border-box",
            zIndex: 0,
            pointerEvents: "none",
            whiteSpace: "pre",
            overflowWrap: "normal",
          } as React.CSSProperties}
        >
          <pre
            className="m-0 p-0"
            style={{
              ...EDITOR_STYLES,
              margin: 0,
              padding: 0,
            }}
          >
            <code
              className={`hljs language-${activeTab.language}`}
              dangerouslySetInnerHTML={{ __html: highlightedCode }}
            />
          </pre>
        </div>
      </div>
    </div>
  );
}
