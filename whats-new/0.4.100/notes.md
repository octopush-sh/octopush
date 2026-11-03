## Octopush 0.4.100

### Improvements

- **Direct stages run without fast mode** — Direct stages now run Claude Code with fast mode off, so a stage costs the standard rate of the model it was routed to. Claude Code notifications, such as "Fast mode disabled · usage credits exhausted", now show in the stage journal.
- **TypeScript generics no longer read as JSX** — In `.ts`, `.mts` and `.cts` files, generics like `<T>(x) => x` and `<Foo>expr` casts now read as TypeScript, not JSX. The editor and diff also highlight `.mdx`, `.jsonc`, `.vue`, `.svelte`, `.gradle`, `.groovy`, `.scala`, `.dart`, `.proto` and `.sass` files.
- **Full grammars for Go, C, C++, SQL, Sass and PHP** — Go, C, C++, SQL, Sass and SCSS now use full grammars, and `.php` files are highlighted for the first time. That brings code folding and sharper diff colours, and ⌘-click on a Go or C++ keyword says it is part of the language. A `.h` file opens as C++ when the workspace has C++ sources.
- **Settings buttons now read as phrases** — Settings › Models now offers **Connect another provider** and **Bring in another model**, and About offers **Look for a newer version**, worded as phrases rather than labels. Each Jira project link's button now reads **Save the link**.

### Fixes

- **The open chat stands out in the Chats list** — In the Companion's Chats list, only the conversation open in the canvas gets the boxed, filled style now. Hovering another row shows a light wash, so two rows never look selected at once.
- **Fast-mode turns in Run are priced at the fast-mode rate** — Claude Code fast-mode turns on Opus 5 and Opus 4.8 now cost $10/$50 per million tokens in Usage, twice the standard rate. Before, they showed at the standard rate, about half their real cost. Fast mode on any other model shows as **unpriced**.
- **Calmer keybinding chips in Settings › Shortcuts** — The keybinding chips in Settings › Shortcuts are now quiet mono chips instead of brass, so the page eyebrow and the selected nav item stand out again.

### Maintenance

deps: CodeMirror grammars for Go, C/C++, SQL, Sass and PHP (for #437) (#457)
