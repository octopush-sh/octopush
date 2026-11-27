---
title: Usage says when your organization sets Claude Code's rates
kind: improvement
area: app
steps:
  - open: settings/usage
    target: usage-managed-pricing
    caption: Finished Claude Code stages use your organization's rates; the rest uses list prices.
---
When your organization's managed Claude Code settings set its own rates (`modelPricing`),
Settings › Usage now says so. Finished Claude Code stages and their `--max-budget-usd` cap use
those rates, while Talk, stopped stages and the savings baseline use list prices, so totals can mix the two.
