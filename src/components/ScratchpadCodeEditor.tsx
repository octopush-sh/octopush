import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { useEffect, useRef } from "react";

export function ScratchpadCodeEditor() {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const tabs = useScratchpadStore((s) => s.tabs);
  const setContent = useScratchpadStore((s) => s.setContent);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    console.log(`[ScratchpadCodeEditor] render #${renderCountRef.current}:`, {
      activeTabId,
      tabCount: tabs.length,
      activeTabContentLength: activeTab?.content.length,
      activeTabContentPreview: activeTab?.content.substring(0, 50),
    });
  });

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
      const eventKey = `onChange_${Date.now()}_${Math.random()}`;

      console.log(`[ScratchpadCodeEditor] onChange START [${eventKey}]:`, {
        activeTabId,
        newValueLength: newValue.length,
        newValue: newValue.substring(0, 100),
        currentActiveTab: activeTab?.content.substring(0, 50),
        currentActiveTabLength: activeTab?.content.length,
      });

      // Verify the new value doesn't have accidental duplication
      const duplicateCharCount = newValue.split('').filter((char, idx, arr) => {
        return idx > 0 && arr[idx - 1] === char;
      }).length;

      console.log(`[ScratchpadCodeEditor] onChange char analysis:`, {
        eventKey,
        totalChars: newValue.length,
        consecutiveDuplicates: duplicateCharCount,
        uniqueChars: new Set(newValue.split('')).size,
      });

      setContent(activeTabId, newValue);

      console.log(`[ScratchpadCodeEditor] onChange END [${eventKey}]: setContent called`);
    } else {
      console.warn(`[ScratchpadCodeEditor] onChange but activeTabId is falsy:`, { activeTabId });
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
      // Fallback to plain text if highlighting fails
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

      {/* Textarea for editing (text invisible, only input) */}
      <textarea
        value={activeTab.content}
        onChange={handleChange}
        className="absolute inset-0 w-full h-full bg-transparent resize-none focus:outline-none z-20"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: "12px",
          lineHeight: 1.5,
          padding: "16px",
          color: "transparent",
          caretColor: "var(--color-octo-brass)",
        }}
        spellCheck="false"
        wrap="off"
      />

      {/* Syntax highlighted code display (read-only, behind textarea) */}
      <pre
        className="absolute inset-0 w-full h-full bg-octo-onyx text-octo-ivory overflow-auto pointer-events-none m-0"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: "12px",
          lineHeight: 1.5,
          padding: "16px",
        }}
      >
        <code
          className={`hljs language-${activeTab.language}`}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </pre>
    </div>
  );
}
