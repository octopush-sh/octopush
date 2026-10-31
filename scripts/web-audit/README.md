# Web audit

Finds defects on the public website (octopush-web, octopush.sh) before
visitors do: the same idea as the app's [visual audit](../visual-audit/README.md),
run against the built site. Runs nightly in `web-audit.yml`; no agent.

## How it works

1. The workflow checks out octopush-web's `main` (what merging publishes) with
   a `contents: read` installation token of the "Octopush Cycle" GitHub App,
   minted in a separate job (`scripts/routines/app-token.mjs`), revokes it and
   checks it is dead, then `npm ci --ignore-scripts && npm run build`. That job
   references no secret: the build is the website's own code. Findings and
   screenshots (3 days, none of the legal pages) go to an artifact; a third job
   on a fresh runner files them.
2. `audit.mjs` serves `dist/` on a local port and opens every page (every
   `.html` in `dist/`, without Pagefind's or Astro's assets) in Playwright
   **Chromium** at 1440×900, 1024×700 and 390×844, takes a screenshot and runs
   the app audit's layout checks (`../visual-audit/checks.mjs`) and the website
   checks below inside the page. Links and anchors are checked from the built
   HTML.
3. Findings are merged into one entry per defect (fingerprint = check +
   element, so a header bug on twenty pages is one issue) and written to
   `<out>/findings.json`.
4. `../visual-audit/file.mjs --repo octopush-sh/octopush-web` files them in
   octopush-web as `visual` issues (`bug` too for links, meta and placeholder
   copy), with the app audit's caps: at most 5 new a night, at most 10 open,
   the first 2 `ready` for the web builder, fixed-and-back → reopened as
   `needs-owner`, closed as *not planned* → never refiled. A defect seen only on
   human-only pages (legal, Free vs Pro) is filed as `proposal`, never `ready`.

| Check | Catches |
|---|---|
| `offscreen-x` | Text, an image or a control running past the window's right edge — even when the page hides the overflow (then it's just cut off). The mobile check |
| `page-scroll-x` | The window scrolls sideways |
| `placeholder-text` | Visible `[screenshot`, `TODO` or `Lorem` |
| `retired-glyph` | `§`, `✦`, or `⟶` outside a link or button (CLAUDE.md rule 5) |
| `italic-text` | Text drawn in an italic or oblique face |
| `missing-meta` | No `<title>`, meta description, `og:title`, `og:description` or `og:image` (pages marked `noindex` are skipped) |
| `broken-link` | An internal link (relative, root-relative or on octopush.sh) to a page or file that isn't in `dist/` and isn't a `vercel.json` route |
| `missing-anchor` | A `#fragment` with no matching `id` on the target page (`#_top` is Starlight's and always fine) |
| `text-escapes`, `text-overlap`, `text-cut`, `unlabeled-control` | As in the app audit |

Hidden things don't count: `display: none`, `visibility: hidden`, zero
opacity, `aria-hidden`, clipped to nothing (skip links, screen-reader labels)
or inside a closed `<details>`. Mark a region that is meant to break these
rules with `data-audit-ignore`.

## Run it

```bash
npm i -g playwright && npx playwright install chromium   # once
cd ../octopush-web && npm ci && npm run build && cd -
NODE_PATH="$(npm root -g)" node scripts/web-audit/audit.mjs --site ../octopush-web
NODE_PATH="$(npm root -g)" node scripts/web-audit/audit.mjs --site ../octopush-web --page /,/docs/ --sizes 390x844
node scripts/visual-audit/file.mjs --repo octopush-sh/octopush-web .web-audit/findings.json --dry-run
```

`--offline` blocks every request except the local server (fonts fall back, so
layout can differ from production). Screenshots land in `.web-audit/shots/`.
Exit code: 0 clean, 1 findings, 2 the audit itself failed.
