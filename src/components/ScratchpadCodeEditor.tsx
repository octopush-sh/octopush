import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { useRef } from "react";

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

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (activeTabId) {
      setContent(activeTabId, e.target.value);
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
    <div className="h-full w-full bg-octo-onyx overflow-hidden flex flex-col relative">
      {/* Empty state placeholder */}
      {!activeTab.content && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <p className="font-serif italic text-[14px] text-octo-brass text-center px-4">
            Paste code here, or start typing…
          </p>
        </div>
      )}

      {/* Syntax highlighted display (ONLY rendering layer) */}
      <pre
        className="absolute inset-0 w-full h-full m-0 overflow-auto pointer-events-none text-octo-ivory"
        style={{
          fontFamily: "'JetBrains Mono', 'Courier New', monospace",
          fontSize: "12px",
          lineHeight: "1.5",
          letterSpacing: "0px",
          padding: "16px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          zIndex: 0,
        }}
      >
        <code
          className={`hljs language-${activeTab.language}`}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </pre>

      {/* Textarea for input capture (positioned on top, text invisible) */}
      <textarea
        ref={textareaRef}
        value={activeTab.content}
        onChange={handleTextareaChange}
        className="absolute inset-0 w-full h-full resize-none focus:outline-none"
        style={{
          fontFamily: "'JetBrains Mono', 'Courier New', monospace",
          fontSize: "12px",
          lineHeight: "1.5",
          letterSpacing: "0px",
          padding: "16px",
          margin: 0,
          border: "none",
          boxSizing: "border-box",
          backgroundColor: "transparent",
          color: "transparent",
          WebkitTextFillColor: "transparent",
          caretColor: "var(--color-octo-brass)",
          zIndex: 10,
          resize: "none",
        }}
        spellCheck="false"
        wrap="off"
      />
    </div>
  );
}
