---
title: Setup scripts now run when a mission is created
kind: fix
area: app
highlight: true
steps:
  - target: mission-setup-script
    caption: The commands here run in the new worktree when the mission is created.
  - open: mode/run
    target: run-setup-session
    caption: They run in a setup terminal. A failure is marked here and never blocks the mission.
---
The setup script from the new-mission wizard now actually runs: a **setup** terminal opens in the new worktree with its output and exit code, and a failure offers **Open the setup terminal**. Reused workspaces never re-run it, and a Routine's fresh worktree runs the project's script before its crew.
