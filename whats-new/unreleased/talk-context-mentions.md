---
title: Hand Talk line ranges, folders, session output and the diff
kind: feature
area: app
highlight: true
steps:
  - open: mode/review
    target: review-editor-ask-talk
    caption: Select lines in the editor, then hand them to Talk as a range.
  - open: mode/talk
    target: talk-context-chip
    caption: Each @ shows here as a chip with its token count. The × takes it out.
  - target: talk-composer-estimate
    caption: The chips count toward the estimate before you send.
---
Talk's `@` now takes `@path#L10-40`, `@folder/` (its files and sizes), `@session:name` (the last
200 lines a Run session shows) and `@diff`. Each one shows as a removable chip with its token
estimate. In Review, select some lines and choose **Ask Talk about this**.
