## Octopush 0.4.136

### Improvements

- **Moving projects between groups is steadier** — A project moved into or out of a group lands in its place at once, and a move that fails puts your rail back and says so. Empty groups can be moved with Move up and Move down, and Escape on a new group's name undoes the group.
- **Open a group's menu from the keyboard in the slim rail** — In the collapsed rail, ⇧F10 or the context-menu key on a mission group's chevron now opens the group's menu beside it, and Escape returns the focus to the chevron.

### Fixes

- **Closing a session that waits on you asks first** — Closing a Run session now asks first when Claude Code waits on you in it, even if it prints nothing, as it does on a permission prompt. On the narrowest mode band the session line keeps its ⌘⌥K list button instead of disappearing, and the mode labels collapse without a lag.
- **Receded stage cards read unknown and tiny costs in full** — In a Direct run, a receded stage card reads "unreported" instead of a cut-off "usage not report…", and a cost under a cent reads `<$0.01`, not `$0.00`. When the token pair steps aside, its tooltip reads millions as `1.24M`, and screen readers still hear the full figures.
- **Moving several missions to a group is all or nothing** — **Move N missions to group** now moves the whole selection in one step: if the move is refused, every mission stays where it was and you see one message, not one per mission.
- **Rail groups keep their folds and colours more faithfully** — Opening a project after a launch with none now unfolds the group holding its mission. A tall project can be moved down past a short one from the keyboard, and a bone or smoke group's chevron and guide stay visible on the light theme. A move refused right after another no longer shows the earlier one undone.
