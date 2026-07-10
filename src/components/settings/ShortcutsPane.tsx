// Settings → Shortcuts — a read-only reference of every keybinding.
import { PaneHeader, SectionLabel } from "./shared";

export function ShortcutsPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Shortcuts"
        title="The grammar of the keyboard."
        subtitle="A reference of every keybinding Octopush respects."
      />

      <div className="max-w-[640px]">
        <ShortcutGroup title="Navigation">
          <Shortcut keys="⌘1 … ⌘9" desc="Switch to workspace N" />
          <Shortcut keys="⌘⇧1" desc="Talk mode" />
          <Shortcut keys="⌘⇧2" desc="Run mode" />
          <Shortcut keys="⌘⇧3" desc="Review mode" />
          <Shortcut keys="⌘⇧D" desc="Direct mode" />
          <Shortcut keys="⌘⇧M" desc="Mission Control" />
          <Shortcut keys="⌘\\" desc="Toggle companion" />
        </ShortcutGroup>

        <ShortcutGroup title="Actions">
          <Shortcut keys="⌘K" desc="Command palette" />
          <Shortcut keys="⌘N" desc="New workspace" />
          <Shortcut keys="⌘," desc="Open Settings" />
          <Shortcut keys="⌘⇧T" desc="Open Settings · Usage" />
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

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <li className="flex items-baseline justify-between px-4 py-2.5">
      <span className="text-[13px] text-octo-sage">{desc}</span>
      <kbd className="rounded border border-octo-hairline bg-octo-onyx px-2 py-0.5 font-mono text-[10px] text-octo-brass">
        {keys}
      </kbd>
    </li>
  );
}
