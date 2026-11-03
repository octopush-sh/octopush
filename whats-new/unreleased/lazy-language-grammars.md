---
title: Language grammars load when you first need them
kind: improvement
area: app
highlight: false
---
Syntax grammars for the Review editor, Quick View, the Review diff and the Scratchpad are no longer part of the app's startup bundle. Each one loads the first time a file in that language opens, and is ready immediately after that.
