import { useEditorPrefs } from "../stores/editorPrefsStore";

interface Props {
  line: number;
  col: number;
  selectionCount: number;
  lang: string;
  /** Disk changed (or file deleted) under unsaved local edits. */
  diskStale?: boolean;
}

const SEG =
  "flex h-full items-center gap-1.5 px-2.5 font-mono text-[10.5px] text-octo-mute";
const CLICK =
  "transition-colors hover:bg-octo-panel hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass";

export function EditorStatusBar({ line, col, selectionCount, lang, diskStale }: Props) {
  const wrap = useEditorPrefs((s) => s.wrap);
  const lineNumbers = useEditorPrefs((s) => s.lineNumbers);
  const tabWidth = useEditorPrefs((s) => s.tabWidth);
  const fontSize = useEditorPrefs((s) => s.fontSize);
  const toggleWrap = useEditorPrefs((s) => s.toggleWrap);
  const toggleLineNumbers = useEditorPrefs((s) => s.toggleLineNumbers);
  const cycleTabWidth = useEditorPrefs((s) => s.cycleTabWidth);
  const bumpFontSize = useEditorPrefs((s) => s.bumpFontSize);

  return (
    <div className="flex h-[26px] shrink-0 items-stretch border-t border-octo-hairline bg-octo-onyx">
      <div className={SEG}>
        <span className="h-[5px] w-[5px] rounded-full bg-octo-brass" />
        <span className="text-octo-brass">{lang}</span>
      </div>

      <div className={SEG}>
        Ln <span className="text-octo-sage">{line}</span>,{" "}
        Col <span className="text-octo-sage">{col}</span>
      </div>

      {selectionCount > 1 && (
        <div className={`${SEG} text-octo-brass`}>{selectionCount} selections</div>
      )}

      {diskStale && (
        <div
          className={`${SEG} octo-pop-in text-octo-rouge`}
          data-testid="statusbar-disk-stale"
          title="This file changed on disk while you have unsaved edits. Saving will ask whether to overwrite your version or reload from disk."
        >
          <span className="h-[5px] w-[5px] rounded-full bg-octo-rouge" />
          disk changed
        </div>
      )}

      <div className="ml-auto flex items-stretch">
        <button
          type="button"
          data-testid="statusbar-indent"
          onClick={cycleTabWidth}
          className={`${SEG} ${CLICK}`}
        >
          Spaces: <span className="text-octo-sage">{tabWidth}</span>
        </button>
        <button
          type="button"
          data-testid="statusbar-wrap"
          onClick={toggleWrap}
          className={`${SEG} ${CLICK}`}
        >
          Wrap{" "}
          <span className={wrap ? "text-octo-brass" : "text-octo-mute"}>
            {wrap ? "on" : "off"}
          </span>
        </button>
        <button
          type="button"
          data-testid="statusbar-linenumbers"
          onClick={toggleLineNumbers}
          className={`${SEG} ${CLICK}`}
        >
          Ln#{" "}
          <span className={lineNumbers ? "text-octo-brass" : "text-octo-mute"}>
            {lineNumbers ? "on" : "off"}
          </span>
        </button>
        <div className={SEG}>
          <button
            type="button"
            data-testid="statusbar-font-dec"
            onClick={() => bumpFontSize(-1)}
            className={`px-1 ${CLICK}`}
            aria-label="Decrease font size"
          >
            −
          </button>
          <span>
            Aa <span className="text-octo-sage">{fontSize}</span>
          </span>
          <button
            type="button"
            data-testid="statusbar-font-inc"
            onClick={() => bumpFontSize(1)}
            className={`px-1 ${CLICK}`}
            aria-label="Increase font size"
          >
            ＋
          </button>
        </div>
      </div>
    </div>
  );
}
