import { Command } from "cmdk";
import { useEffect, useState, useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import type { ModelWithProvider, SessionTemplate } from "../lib/types";
import { useThemeStore } from "../stores/themeStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { useEditorPrefs } from "../stores/editorPrefsStore";
import { useBlameStore } from "../stores/blameStore";
import { ModalShell } from "./ModalShell";

interface Props {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onToggleTokens: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNewSession,
  onToggleTokens,
}: Props) {
  const { sessions, activeId, select, kill } = useSessionStore();
  const refresh = useSessionStore((s) => s.refresh);
  const [models, setModels] = useState<ModelWithProvider[]>([]);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const { themes, apply: applyTheme } = useThemeStore();
  const editorWrap = useEditorPrefs((s) => s.wrap);
  const editorFontSize = useEditorPrefs((s) => s.fontSize);
  const editorTabWidth = useEditorPrefs((s) => s.tabWidth);
  const editorLineNumbers = useEditorPrefs((s) => s.lineNumbers);
  const blameOn = useBlameStore((s) => s.enabled);

  useEffect(() => {
    if (open) {
      ipc.listModels().then(setModels).catch(() => {});
      ipc.listTemplates().then(setTemplates).catch(() => {});
    }
  }, [open]);

  const run = useCallback(
    (fn: () => void | Promise<void>) => {
      onClose();
      fn();
    },
    [onClose],
  );

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[18vh]" ariaLabel="Command palette">
      <div
        className="w-[560px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow:
            "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
        }}
      >
        <Command loop className="overflow-hidden rounded-xl">
          <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
            <span className="font-mono text-[11px] text-octo-brass">⌘ K</span>
            <Command.Input
              autoFocus
              placeholder="Type a command, or search…"
              className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:text-octo-mute"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:border-octo-brass hover:text-octo-brass"
            >
              ESC
            </button>
          </div>

          <Command.List className="max-h-[380px] overflow-y-auto py-2">
            <Command.Empty className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
              Nothing matches.
            </Command.Empty>

            {/* Sessions */}
            <Group heading="Sessions">
              <Item glyph="+" label="New session" shortcut="⌘T" onSelect={() => run(onNewSession)} />
              {sessions.map((s) => (
                <Item
                  key={s.id}
                  glyph={s.name.charAt(0).toUpperCase() || "?"}
                  label={`Switch to ${s.name}`}
                  detail={s.agent.model}
                  onSelect={() => run(() => select(s.id))}
                />
              ))}
              {activeSession && (
                <Item
                  glyph="×"
                  label={`Kill ${activeSession.name}`}
                  onSelect={() =>
                    run(async () => {
                      await kill(activeSession.id);
                    })
                  }
                />
              )}
            </Group>

            {/* Models */}
            <Group heading="Models">
              {models.map((m) => (
                <Item
                  key={m.model.id}
                  glyph="◇"
                  label={`Model: ${m.model.displayName}`}
                  detail={`${m.provider} · $${m.model.inputCostPerM}/M in`}
                  onSelect={() =>
                    run(async () => {
                      if (activeId) {
                        const result = await ipc.switchAgent(activeId, m.model.id);
                        await refresh();
                        pushToast({
                          level: result.appliedToPty ? "success" : "info",
                          title: `Model → ${m.model.displayName}`,
                          body: result.message,
                        });
                      }
                    })
                  }
                />
              ))}
            </Group>

            {/* Templates */}
            {templates.length > 0 && (
              <Group heading="Templates">
                {templates.map((t) => (
                  <Item
                    key={t.name}
                    glyph="❦"
                    label={`Template: ${t.name}`}
                    detail={t.projectRoot}
                    onSelect={() => run(onNewSession)}
                  />
                ))}
              </Group>
            )}

            {/* Actions */}
            <Group heading="Actions">
              <Item
                glyph="↺"
                label="Check for updates"
                onSelect={() =>
                  run(async () => {
                    const store = useUpdaterStore.getState();
                    await store.checkForUpdates(true);
                    const next = useUpdaterStore.getState();
                    if (next.phase === "no-update") {
                      pushToast({
                        level: "success",
                        title: "Up to date",
                        body: next.currentVersion
                          ? `You're on v${next.currentVersion} — no newer release available.`
                          : "No newer release available.",
                      });
                    } else if (next.phase === "available" && next.update) {
                      pushToast({
                        level: "info",
                        title: `Octopush ${next.update.version} is ready`,
                        body: "Use the toast in the corner or Settings → About to install.",
                      });
                    } else if (next.phase === "error" && next.error) {
                      pushToast({
                        level: "error",
                        title: "Update check failed",
                        body: next.error,
                      });
                    }
                  })
                }
              />
              <Item
                glyph="&"
                label="Open Settings · Usage"
                shortcut="⌘⇧T"
                onSelect={() => run(onToggleTokens)}
              />
              {activeSession && (
                <Item
                  glyph="◷"
                  label="Set token budget"
                  onSelect={() =>
                    run(async () => {
                      const input = prompt("Token budget (e.g. 100000):");
                      if (input) {
                        const budget = parseInt(input.replace(/[^0-9]/g, ""), 10);
                        if (!isNaN(budget) && activeId) {
                          await ipc.setTokenBudget(activeId, budget);
                          await refresh();
                        }
                      }
                    })
                  }
                />
              )}
              {activeSession && (
                <>
                  <Item
                    glyph="↓"
                    label="Export session (JSON)"
                    onSelect={() =>
                      run(async () => {
                        const json = await ipc.exportSessionJson(activeSession.id);
                        downloadFile(`${activeSession.name}.json`, json, "application/json");
                      })
                    }
                  />
                  <Item
                    glyph="↓"
                    label="Export session (CSV)"
                    onSelect={() =>
                      run(async () => {
                        const csv = await ipc.exportSessionCsv(activeSession.id);
                        downloadFile(`${activeSession.name}.csv`, csv, "text/csv");
                      })
                    }
                  />
                </>
              )}
            </Group>

            {/* Editor */}
            <Group heading="Editor">
              <Item
                glyph="¶"
                label={`Toggle word wrap — ${editorWrap ? "on" : "off"}`}
                onSelect={() => run(() => useEditorPrefs.getState().toggleWrap())}
              />
              <Item
                glyph="+"
                label="Increase font size"
                detail={`${editorFontSize}px`}
                onSelect={() => run(() => useEditorPrefs.getState().bumpFontSize(1))}
              />
              <Item
                glyph="−"
                label="Decrease font size"
                detail={`${editorFontSize}px`}
                onSelect={() => run(() => useEditorPrefs.getState().bumpFontSize(-1))}
              />
              <Item
                glyph="⌶"
                label={`Cycle tab width — ${editorTabWidth} spaces`}
                onSelect={() => run(() => useEditorPrefs.getState().cycleTabWidth())}
              />
              <Item
                glyph="#"
                label={`Toggle line numbers — ${editorLineNumbers ? "on" : "off"}`}
                onSelect={() => run(() => useEditorPrefs.getState().toggleLineNumbers())}
              />
              <Item
                glyph="@"
                label={`Toggle blame — ${blameOn ? "on" : "off"}`}
                onSelect={() => run(() => useBlameStore.getState().toggle())}
              />
            </Group>

            {/* Themes */}
            {themes.length > 0 && (
              <Group heading="Themes">
                {themes.map((t) => (
                  <Item
                    key={t.name}
                    glyph="◐"
                    label={`Theme: ${t.name}`}
                    detail={t.accent}
                    onSelect={() => run(() => applyTheme(t))}
                  />
                ))}
              </Group>
            )}
          </Command.List>
        </Command>
      </div>
    </ModalShell>
  );
}

function Group({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Group
      heading={heading}
      className="px-1 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[8px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.3em] [&_[cmdk-group-heading]]:text-octo-brass"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  glyph,
  label,
  detail,
  shortcut,
  onSelect,
}: {
  glyph: string;
  label: string;
  detail?: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="group mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] text-octo-sage aria-selected:text-octo-ivory"
      style={
        {
          // Tailwind aria-selected variant doesn't reach inline style; use a CSS variable
          // here so the rule below can pick it up via `aria-selected="true"` attribute.
        }
      }
    >
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded font-serif text-[12px] text-octo-mute group-aria-selected:text-octo-brass"
        style={{
          border: "1px solid var(--color-octo-hairline)",
        }}
      >
        {glyph}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {detail && (
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
          {detail}
        </span>
      )}
      {shortcut && (
        <kbd className="shrink-0 rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] tracking-[0.05em] text-octo-mute">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

// CSS for aria-selected highlight (overrides Tailwind ordering and applies a
// brass-ghost background to the currently focused item).
const _styleInject = `
[cmdk-item][aria-selected="true"] {
  background: var(--brass-ghost);
}
[cmdk-item][aria-selected="true"] > span:first-child {
  border-color: var(--brass-dim);
}
`;
if (typeof document !== "undefined" && !document.getElementById("cmdk-brass-styles")) {
  const el = document.createElement("style");
  el.id = "cmdk-brass-styles";
  el.textContent = _styleInject;
  document.head.appendChild(el);
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
