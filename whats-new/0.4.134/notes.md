## Octopush 0.4.134

### Fixes

- **Settings › About says when it last checked only once** — Settings › About no longer repeats when it last looked for updates: the "Checked" note beside the status line is the one place it shows. Its two reference links now share one plain voice.
- **Receded stage cards keep their figures on one line** — In a Direct run, a receded stage card's position, cost and tokens no longer wrap onto a second line. Large token counts read compactly (`↑18k`), and when they still don't fit, the token pair steps aside and stays in the line's tooltip. An unknown cost reads "unpriced" or "usage not reported", never $0.00.
