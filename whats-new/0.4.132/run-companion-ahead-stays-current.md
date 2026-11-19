---
title: Run's commits-ahead count keeps up with every commit
kind: fix
area: app
---
The Run Companion's "N commits ahead" line now updates after a commit, reset or merge that happened while Octopush was hidden or between two polls. A `claude -p --continue` run from an agent's own terminal no longer hides that session's Context.
