## Octopush 0.4.98

### Improvements

- **Review diffs colour every language, in context** — The Review diff now highlights every language the editor does, Go, Kotlin, Shell, C, C++, C#, Swift, Ruby, SQL, Lua, TOML and Dockerfile included. Lines are coloured in the context of the whole file, so doc comments and multi-line strings no longer read as code, and changed words keep their colours.
- **⌘P globs take braces and escapes** — ⌘P globs now expand braces (`*.{ts,tsx}`) and take `\` escapes (`\*.ts`), and `?` takes a whole character, including emoji such as 😀 that need two UTF-16 units. A glob longer than 256 characters is matched as plain fuzzy text, so a pasted pattern can't stall the finder.
- **⌘P finds files by glob, name and file:line** — The ⌘P file finder understands globs (`*.java`, `src/**/*.ts`), ranks file-name and camel-case matches first (`edpn` finds `EditorPane.tsx`), takes several words (`user service`) and opens `Foo.java:42` at line 42. It ranks in small slices, so typing never waits on a 20,000-file workspace.

### Fixes

- **Go to definition jumps to names, not the types before them** — ⌘-click in Review no longer treats the type in front of a declaration as the thing declared: `Integer` no longer jumps to a method that returns `Integer`. Keywords like `const` or `int` skip the workspace search and say so, and Java fields, annotated methods, C# properties, C typedefs and declarations split after their return type now resolve.
- **One broken panel no longer blanks the whole window** — If a panel crashes, only that panel shows an error card, with **Try again** to reload it. The rest of Octopush keeps working. If the whole window fails, you get a recovery screen with **Reload Octopush** and **Copy error details** instead of a blank window.
- **The sandbox also guards git hardlinks and remotes** — A sandboxed stage can no longer hardlink the repo's git config or a hook to write through the link, plant a legacy remote in `.git/remotes` or `.git/branches`, or swap the parent of a hooks dir that `core.hooksPath` puts in the temp dir or `~/.cache`.

### Maintenance

cycle: re-run CI that only lost its macOS runner before building or reviewing (#443)
