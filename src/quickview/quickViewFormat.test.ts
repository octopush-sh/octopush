import { describe, it, expect } from "vitest";
import {
  defaultLayout,
  fileName,
  formatJson,
  hasPreview,
  parseDelimited,
  quickViewKind,
  relativeTo,
} from "./quickViewFormat";

describe("quickViewKind", () => {
  it.each([
    ["/a/README.md", "markdown"],
    ["/a/doc.MDX", "markdown"],
    ["/a/package.json", "json"],
    ["/a/tsconfig.jsonc", "json"],
    ["/a/data.csv", "csv"],
    ["/a/data.tsv", "tsv"],
    ["/a/icon.svg", "svg"],
    ["/a/index.html", "html"],
    ["/a/main.rs", "code"],
    ["/a/Makefile", "code"],
  ])("%s → %s", (path, kind) => {
    expect(quickViewKind(path)).toBe(kind);
  });

  it("opens rendered kinds in preview and the rest in source", () => {
    expect(hasPreview("markdown")).toBe(true);
    expect(hasPreview("json")).toBe(false);
    expect(defaultLayout("csv")).toBe("preview");
    expect(defaultLayout("code")).toBe("source");
  });
});

describe("formatJson", () => {
  it("pretty-prints and keeps a trailing newline", () => {
    expect(formatJson('{"a":1,"b":[1,2]}\n')).toEqual({
      ok: true,
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n',
    });
  });

  it("reports parse errors instead of dropping content", () => {
    const r = formatJson("{ // comment\n}");
    expect(r.ok).toBe(false);
  });
});

describe("parseDelimited", () => {
  it("splits simple rows", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    expect(parseDelimited('name,note\r\n"Doe, J","said ""hi""\nthen left"', ",")).toEqual([
      ["name", "note"],
      ["Doe, J", 'said "hi"\nthen left'],
    ]);
  });

  it("parses tabs and keeps empty fields", () => {
    expect(parseDelimited("a\t\tc", "\t")).toEqual([["a", "", "c"]]);
  });

  it("returns no rows for empty input", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });
});

describe("paths", () => {
  it("relativizes inside a root only", () => {
    expect(relativeTo("/code/app", "/code/app/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/code/app/", "/code/app/a.ts")).toBe("a.ts");
    expect(relativeTo("/code/app", "/code/application/a.ts")).toBe("/code/application/a.ts");
  });

  it("takes the file name", () => {
    expect(fileName("/a/b/c.md")).toBe("c.md");
    expect(fileName("C:\\x\\y.txt")).toBe("y.txt");
  });
});
