## Octopush 0.4.119

### Improvements

- **The launcher says when a model needs a newer Claude Code** — The Direct launcher now warns when a Claude Code stage, or its escalation, uses a model this Mac's CLI is too old to start, such as Fable 5.2 before 2.1.321. The update note also recommends 2.1.321, which fixes a read-only Bash command running outside the sandbox without a prompt.

### Fixes

- **Crews with emoji like ⚠️ import again** — A crew whose names, prompts or stage instructions hold an emoji such as ⚠️, ✔️, ❤️ or 👩‍💻 now imports, on your Mac or a teammate's, instead of being refused for a hidden character. Stray or repeated selectors and joiners are still blocked.
- **Fable 5.2 runs now show their cost** — Claude Fable 5.2 is priced ($8 input, $0.20 cache hits and $40 output per million tokens) and joins the Anthropic models you can pick. Mythos 5.2 is priced too, so its usage counts. Spend that showed as unpriced is priced on the next launch.
- **Quitting no longer cuts a Claude sign-in refresh short** — If you quit Octopush while Readiness's **Check again** is still asking `claude auth status`, that command now finishes on its own instead of being stopped after 2 s, so a slow token refresh can't sign you out.
