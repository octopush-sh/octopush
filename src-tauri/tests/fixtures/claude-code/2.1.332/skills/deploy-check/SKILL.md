---
name: deploy-check
description: Check the branch before a deploy.
---
Branch: !`git branch --show-current`

```!
git status --short
```

Say whether the branch is clean enough to deploy.
