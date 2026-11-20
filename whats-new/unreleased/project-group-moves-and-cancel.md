---
title: Moving projects between groups is steadier
kind: improvement
area: app
highlight: true
scenario: rail-project-groups
steps:
  - target: rail-section-projects
    caption: A project dropped into a group lands in its place at once.
  - target: rail-section-header
    caption: A group's menu holds Move up and Move down, empty groups included.
---
A project moved into or out of a group lands in its place at once, and a move that fails puts your
rail back and says so. Empty groups can be moved with Move up and Move down, and Escape on a new
group's name undoes the group.
