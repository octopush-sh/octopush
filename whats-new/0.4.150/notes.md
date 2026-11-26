## Octopush 0.4.150

### Improvements

- **A plan limit that already reset no longer stalls a crew** — When Claude Code reports a plan limit that has already reset, the crew resumes once without using one of its three automatic resumes. If it happens again, the crew waits for you and says to update to Claude Code 2.1.332, which fixes it. Readiness now recommends that release.

### Fixes

- **The rail's search placeholder fits its line** — The rail's search placeholder no longer breaks off mid-word beside the state filter and **+**. It now reads "Find a project or mission", and it still matches group names; hover it for the full phrase.
- **The Settings nav stays put when you switch tabs** — The rows in the Settings nav no longer move by a pixel or two as you switch tabs. The active tab keeps the same sans label and height as the others and is marked only by its brass ground and border.
