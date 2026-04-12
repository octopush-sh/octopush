import { Command } from "cmdk";
import { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Zap,
  Gauge,
  XCircle,
  FileText,
  Coins,
  Download,
  LayoutTemplate,
  Palette,
} from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import type { ModelWithProvider, SessionTemplate } from "../lib/types";
import { useThemeStore } from "../stores/themeStore";

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[20vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-[540px]">
        <Command
          className="rounded-xl border border-octo-border bg-octo-panel shadow-2xl"
          loop
        >
          <Command.Input
            placeholder="Type a command..."
            className="w-full border-b border-octo-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-zinc-600"
            autoFocus
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-4 py-6 text-center text-sm text-zinc-500">
              No results found.
            </Command.Empty>

            {/* Session actions */}
            <Command.Group
              heading="Sessions"
              className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
            >
              <PaletteItem
                icon={<Plus size={14} />}
                label="New session"
                shortcut="⌘T"
                onSelect={() => run(onNewSession)}
              />
              {sessions.map((s) => (
                <PaletteItem
                  key={s.id}
                  icon={
                    <span className="text-xs">{s.icon}</span>
                  }
                  label={`Switch to ${s.name}`}
                  detail={s.agent.model}
                  onSelect={() => run(() => select(s.id))}
                />
              ))}
              {activeSession && (
                <PaletteItem
                  icon={<XCircle size={14} />}
                  label={`Kill ${activeSession.name}`}
                  onSelect={() =>
                    run(async () => {
                      await kill(activeSession.id);
                    })
                  }
                />
              )}
            </Command.Group>

            {/* Model actions */}
            <Command.Group
              heading="Models"
              className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
            >
              {models.map((m) => (
                <PaletteItem
                  key={m.model.id}
                  icon={<Zap size={14} />}
                  label={`Model: ${m.model.displayName}`}
                  detail={`${m.provider} • $${m.model.inputCostPerM}/M in`}
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
            </Command.Group>

            {/* Templates */}
            {templates.length > 0 && (
              <Command.Group
                heading="Templates"
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
              >
                {templates.map((t) => (
                  <PaletteItem
                    key={t.name}
                    icon={<LayoutTemplate size={14} />}
                    label={`Template: ${t.name}`}
                    detail={t.projectRoot}
                    onSelect={() => run(onNewSession)}
                  />
                ))}
              </Command.Group>
            )}

            {/* Utility actions */}
            <Command.Group
              heading="Tools"
              className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
            >
              <PaletteItem
                icon={<Coins size={14} />}
                label="Toggle token dashboard"
                shortcut="⌘⇧T"
                onSelect={() => run(onToggleTokens)}
              />
              {activeSession && (
                <PaletteItem
                  icon={<Gauge size={14} />}
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
              <PaletteItem
                icon={<FileText size={14} />}
                label="View session recap"
                onSelect={() =>
                  run(async () => {
                    if (activeId) {
                      const report = await ipc.getTokenReport(activeId);
                      alert(
                        `Session report:\nInput: ${report.totalInput}\nOutput: ${report.totalOutput}\nCost: $${report.totalCostUsd.toFixed(2)}`,
                      );
                    }
                  })
                }
              />
              {activeSession && (
                <>
                  <PaletteItem
                    icon={<Download size={14} />}
                    label="Export session (JSON)"
                    onSelect={() =>
                      run(async () => {
                        const json = await ipc.exportSessionJson(activeSession.id);
                        downloadFile(`${activeSession.name}.json`, json, "application/json");
                      })
                    }
                  />
                  <PaletteItem
                    icon={<Download size={14} />}
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
            </Command.Group>

            {/* Theme picker */}
            {themes.length > 0 && (
              <Command.Group
                heading="Themes"
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
              >
                {themes.map((t) => (
                  <PaletteItem
                    key={t.name}
                    icon={<Palette size={14} />}
                    label={`Theme: ${t.name}`}
                    onSelect={() => run(() => applyTheme(t))}
                  />
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
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

function PaletteItem({
  icon,
  label,
  detail,
  shortcut,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-300 aria-selected:bg-octo-accent/10 aria-selected:text-zinc-100"
    >
      <span className="shrink-0 text-zinc-500">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {detail && (
        <span className="shrink-0 text-[10px] text-zinc-600">{detail}</span>
      )}
      {shortcut && (
        <kbd className="shrink-0 rounded border border-octo-border bg-octo-bg px-1.5 py-0.5 text-[10px] text-zinc-500">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}
