---
title: Group projects into sections of the rail
kind: feature
area: app
scenario: rail-project-groups
steps:
  - target: rail-section-header
    caption: A project group is a section of the rail. Click its name to fold it; right-click to rename, tint, move or ungroup.
  - target: rail-section-projects
    caption: Its projects keep their own lines and missions. A project with no tint of its own takes the group's on its hexagon.
  - target: rail-search
    caption: The filter finds project groups by name too, and a group hit keeps all its projects.
    action: type
    text: client
---
To group projects, right-click a project and choose **Move to group › New group…**: the new group already holds that project, under a foldable, optionally tinted heading. Drag a project by its grip onto a group to add it as the group's last project, or out of the group to take it out. The project menu's mission-group action now reads **New mission group**.
