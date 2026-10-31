## Octopush 0.4.90

### Improvements

- **A newer terminal engine** — The terminal runs on xterm.js 6. Option+←/→ still jump by word in zsh and bash, and the scrollbar is now a thin overlay in your theme's colours that fades when you're not scrolling.

### Fixes

- **Compromised eMudhra CA keys are refused** — Requests to AI providers, gateways, sign-in, Jira and GitHub now refuse certificates from the eight eMudhra intermediate CAs compromised in October 2026, on top of your Mac's trust store. These connections now need TLS 1.2 or newer with modern cipher suites; a self-hosted gateway or proxy that offers only older ones will fail with a clear error.
- **Routine conditions find your tools and report errors** — A routine's fire condition now runs with your login shell's PATH (Homebrew, nvm, `~/.local/bin`). Exit 1 still means "condition not met"; any other exit shows as **condition error** with the last lines of its stderr, so a broken check no longer looks like nothing to do.

### Maintenance

build(deps): bump vite to 8.3 (supersedes #262) (#332) · build(deps): bump reqwest to 0.13 (supersedes #260) (#333) · Audit fixtures: a file tree for Review (#330) · Continuous cycle: builder every 2 h, reviewer between, betas twice a day (#329) · Visual audit: summary notices on the run page (#323) · Visual audit: a second pass in the system Safari (the app's own WebKit) (#322) · Audit fixtures: consistent live runs, terminals that start (#321) · Nightly visual audit in WebKit: layout checks and a design review (#314)
