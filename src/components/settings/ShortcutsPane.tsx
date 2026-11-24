// Settings → Shortcuts — a read-only reference of every keybinding.
import { MODES, MODE_LABELS, MODE_SHORTCUTS } from "../../lib/modes";
import { tourId } from "../../lib/tour/ids";
import { PaneHeader, SectionLabel } from "./shared";

export function ShortcutsPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Shortcuts"
        title="The grammar of the keyboard."
        subtitle="A reference of every keybinding Octopush respects."
      />

      <div>
        <ShortcutGroup title="Navigation">
          <Shortcut keys="⌘1 … ⌘9" desc="Switch to workspace N" />
          {/* In switcher order, from the same table as its tooltips. */}
          {MODES.map((m, i) => (
            <Shortcut
              key={m}
              keys={MODE_SHORTCUTS[m]}
              desc={`${MODE_LABELS[m]} mode`}
              tour={i === 0 ? tourId("settings-shortcuts-modes") : undefined}
            />
          ))}
          <Shortcut keys="⌘⇧M" desc="Mission Control" />
          <Shortcut keys="⌘⇧L" desc="Logbook Room" />
          <Shortcut keys={"⌘\\"} desc="Toggle companion" />
        </ShortcutGroup>

        <ShortcutGroup title="Actions">
          <Shortcut keys="⌘K" desc="Command palette" />
          <Shortcut keys="⌘N" desc="New workspace" />
          <Shortcut keys="⌘," desc="Open Settings" />
          <Shortcut keys="⌘⇧T" desc="Open Settings · Usage" />
        </ShortcutGroup>

        <ShortcutGroup title="Rail">
          <Shortcut keys="⌘⌥G" desc="Move the focused mission or project to a group" />
          <Shortcut keys="⇧F10" desc="Open the focused row's menu" />
          <Shortcut keys="⌘-click · ⇧-click" desc="Select several missions of one project" />
          <Shortcut keys="Esc" desc="Clear the selection" />
        </ShortcutGroup>

        <ShortcutGroup title="Chat">
          <Shortcut keys="↵" desc="Send message" />
          <Shortcut keys="⇧↵" desc="New line in message" />
        </ShortcutGroup>
      </div>
    </>
  );
}

function ShortcutGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <SectionLabel>{title}</SectionLabel>
      <ul className="divide-y divide-octo-hairline rounded-md border border-octo-hairline bg-octo-panel">
        {children}
      </ul>
    </div>
  );
}

function Shortcut({ keys, desc, tour }: { keys: string; desc: string; tour?: string }) {
  return (
    <li data-tour={tour} className="flex items-baseline justify-between px-4 py-2.5">
      <span className="text-[13px] text-octo-sage">{desc}</span>
      <kbd className="rounded border border-octo-hairline bg-octo-onyx px-2 py-0.5 font-mono text-[10px] text-octo-mute">
        {keys}
      </kbd>
    </li>
  );
}
