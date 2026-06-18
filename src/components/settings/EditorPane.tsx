// Settings → Editor — code-editor preferences: word wrap, font size, tab width,
// line numbers, and the external "Open in editor" command. Split out of General
// so behavior and editor concerns no longer share a pane.
import { useEffect, useState } from "react";
import { useEditorPrefs, FONT_MIN, FONT_MAX, TAB_WIDTHS } from "../../stores/editorPrefsStore";
import { ipc } from "../../lib/ipc";
import type { EditorChoice } from "../../lib/types";
import { SegmentedControl } from "../controls/SegmentedControl";
import { Stepper } from "../controls/Stepper";
import { PaneHeader, SectionLabel, ToggleRow } from "./shared";

export function EditorPane() {
  const wrap = useEditorPrefs((s) => s.wrap);
  const setWrap = useEditorPrefs((s) => s.setWrap);
  const lineNumbers = useEditorPrefs((s) => s.lineNumbers);
  const setLineNumbers = useEditorPrefs((s) => s.setLineNumbers);

  return (
    <>
      <PaneHeader
        eyebrow="Editor"
        title="How code reads."
        subtitle="Typography and layout for the built-in editor, plus the command used to open files in your editor of choice."
      />

      <div className="max-w-[640px] space-y-4">
        <SectionLabel>Editor</SectionLabel>
        <ToggleRow
          testId="editor-wrap"
          label="Word wrap"
          description="Wrap long lines to the editor width instead of scrolling horizontally."
          checked={wrap}
          onChange={setWrap}
        />
        <FontSizeRow />
        <TabWidthRow />
        <ToggleRow
          testId="editor-linenumbers"
          label="Line numbers"
          description="Show line numbers in the editor gutter."
          checked={lineNumbers}
          onChange={setLineNumbers}
        />
        <EditorCommandRow />
      </div>
    </>
  );
}

function ControlRow({ label, description, children }: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-serif text-[14px] leading-tight text-octo-ivory">{label}</div>
        <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function FontSizeRow() {
  const fontSize = useEditorPrefs((s) => s.fontSize);
  const setFontSize = useEditorPrefs((s) => s.setFontSize);
  return (
    <ControlRow label="Font size" description={`Editor text size in pixels, from ${FONT_MIN} to ${FONT_MAX}.`}>
      <Stepper
        value={fontSize}
        min={FONT_MIN}
        max={FONT_MAX}
        onChange={setFontSize}
        ariaLabel="Editor font size"
      />
    </ControlRow>
  );
}

function TabWidthRow() {
  const tabWidth = useEditorPrefs((s) => s.tabWidth);
  const setTabWidth = useEditorPrefs((s) => s.setTabWidth);
  return (
    <ControlRow label="Tab width" description="Spaces per indentation level.">
      <SegmentedControl
        ariaLabel="Tab width"
        value={String(tabWidth)}
        onChange={(v) => setTabWidth(Number(v))}
        options={TAB_WIDTHS.map((w) => ({ value: String(w), label: String(w) }))}
      />
    </ControlRow>
  );
}

function EditorCommandRow() {
  const [cmd, setCmd] = useState("");
  const [detected, setDetected] = useState<EditorChoice[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc.getSettings().then((s) => setCmd(s.editorCommand ?? "")).catch(() => {});
    ipc.detectEditors().then(setDetected).catch(() => {});
  }, []);

  async function persist() {
    const s = await ipc.getSettings();
    await ipc.saveSettings({ ...s, editorCommand: cmd.trim() || null });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <label htmlFor="editor-command-input" className="block font-serif text-[14px] leading-tight text-octo-ivory">
        Editor command
      </label>
      <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
        Used by "Open in editor" in the rail. Leave empty to auto-detect.
        {detected.length > 0 && ` Detected: ${detected.map((e) => e.name).join(", ")}.`}
      </div>
      <input
        id="editor-command-input"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onBlur={persist}
        placeholder={detected[0]?.command ?? "code"}
        spellCheck={false}
        className="mt-2 w-full rounded-md px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none"
        style={{ background: "var(--color-octo-onyx)", border: "1px solid var(--color-octo-hairline)" }}
      />
      {saved && <div className="mt-1 font-mono text-[10px] text-octo-verdigris">Saved</div>}
    </div>
  );
}
