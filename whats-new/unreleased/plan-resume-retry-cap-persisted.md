---
title: Failed plan resumes hand over reliably
kind: fix
area: app
---
When an automatic resume after a Claude plan limit keeps failing to start, the run now waits for you after 10 tries in total, even if the app restarts or a background worker shares the retries. Acting on the run yourself starts the count over.
