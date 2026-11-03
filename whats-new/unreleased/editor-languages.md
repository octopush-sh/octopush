---
title: TypeScript generics no longer read as JSX
kind: improvement
area: app
steps:
  - open: mode/review
    target: review-editor
    caption: .ts files now parse as TypeScript without JSX, and more file types get highlighting.
---
In `.ts`, `.mts` and `.cts` files, generics like `<T>(x) => x` and `<Foo>expr` casts now read as TypeScript, not JSX. The editor and diff also highlight `.mdx`, `.jsonc`, `.vue`, `.svelte`, `.gradle`, `.groovy`, `.scala`, `.dart`, `.proto` and `.sass` files.
