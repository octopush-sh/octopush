## Octopush 0.4.132

### Features

- **Group projects into sections of the rail** — To group projects, right-click a project and choose **Move to group › New group…**: the new group already holds that project, under a foldable heading. Drag a project by its grip onto a group to add it last, or out of the group to take it out; while you drag, it says **Into** or **Out of** the group. The project menu's mission-group action now reads **New mission group**.

### Fixes

- **Shortened names draw a real ellipsis on macOS** — A long name shortened in the middle (the project name in the top bar, rail rows, branches, file paths) now ends its first half with the text's own ellipsis. Before, macOS clipped the text and drew the `…` separately. The `…` still sits right against the end of the name.
- **Run's commits-ahead count keeps up with every commit** — The Run Companion's "N commits ahead" line now updates after a commit, reset or merge that happened while Octopush was hidden or between two polls. A `claude -p --continue` run from an agent's own terminal no longer hides that session's Context.
