---
title: See when two workspaces change the same files
kind: feature
area: app
highlight: true
steps:
  - target: rail-collision
    caption: This workspace and another one in the project change the same files. Hover for which.
    action: hover
  - open: mission-control
    target: mission-control-card-collision
    caption: Crews in flight show the overlap on their card, so you can land one lane first.
  - open: mode/review
    target: review-companion-collision
    caption: Review says when the branch will conflict, with a jump to the other workspace.
---
Octopush now notices when two live workspaces of a project change the same files, before the merge does. An amber mark means a file overlap, rouge means the branches will conflict. It only warns and never blocks anything.
