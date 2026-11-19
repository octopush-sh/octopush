---
title: Group a project's missions in the rail
kind: feature
area: app
scenario: rail-groups
steps:
  - target: rail-group-header
    caption: A group is a folder inside a project. Click its header to fold it; right-click to rename, tint or ungroup.
  - target: rail-group-members
    caption: Its missions sit indented beside a guide that ends with the group, so the next loose mission is easy to tell apart.
  - target: rail-search
    caption: The filter finds groups by name too, and a group hit keeps all its missions.
    action: type
    text: vulner
---
Right-click a mission and choose **Move to group › New group…** to file related missions under one foldable, optionally tinted header; dragging a mission onto a header adds it too. A group keeps its place among the other missions and stays when it is emptied, until you remove it.
