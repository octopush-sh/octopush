---
title: Sync names library items it couldn't store
kind: improvement
area: app
highlight: false
steps:
  - open: settings/account
    target: settings-account-sync-library-unsent
    caption: A pipeline or role the sync service refused stays unsent, named here with the reason.
    action: none
---
Library sync now names any pipeline or role the sync service refused, and why (for example, over the 64,000-byte limit), and keeps it unsent. Run history pulls every page, so all your synced runs show up, and later library pulls ask only for what changed.
