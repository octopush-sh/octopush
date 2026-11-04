---
title: A stage that finished on a full disk keeps its work
kind: fix
area: app
---
When Claude Code finishes a stage but can't save its session (a full disk or quota), the stage now says so and shows the free space, instead of reporting the agent's own summary as the error. The result is kept, so you can accept it once space is free, and the run no longer retries it on a stronger model.
