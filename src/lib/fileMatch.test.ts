import { describe, expect, it } from "vitest";
import {
  compileGlob,
  createMatchJob,
  expandBraces,
  MAX_GLOB_LENGTH,
  MAX_POSITION,
  foldCase,
  MATCH_CHUNK,
  matchFiles,
  normalizeQuery,
  parseQuery,
  prepareFiles,
} from "./fileMatch";

const FILES = [
  "README.md",
  "pom.xml",
  "src/main/java/com/acme/service/UserService.java",
  "src/main/java/com/acme/service/OrderService.java",
  "src/main/java/com/acme/Foo.java",
  "src/test/java/com/acme/service/UserServiceTest.kt",
  "src/components/EditorPane.tsx",
  "src/components/Pane.tsx",
  "src/components/editor/deep/pin.ts",
  "src/lib/ipc.ts",
  "src/x/index.ts",
  "docs/service/Main.md",
];
const PREPARED = prepareFiles(FILES);
const WS = "/Users/me/acme";

const find = (q: string, boost: string[] = []) =>
  matchFiles(PREPARED, parseQuery(q, WS), boost).map((m) => m.path);

describe("fileMatch — globs", () => {
  it("*.java matches file names anywhere in the tree", () => {
    expect(find("*.java").sort()).toEqual([
      "src/main/java/com/acme/Foo.java",
      "src/main/java/com/acme/service/OrderService.java",
      "src/main/java/com/acme/service/UserService.java",
    ]);
  });

  it("a glob with a slash matches the whole path; **/ spans zero or more dirs", () => {
    expect(find("src/**/*.ts").sort()).toEqual(["src/components/editor/deep/pin.ts", "src/lib/ipc.ts", "src/x/index.ts"]);
    expect(find("src/*.ts")).toEqual([]);
    expect(find("src/**/User*")).toEqual([
      "src/main/java/com/acme/service/UserService.java",
      "src/test/java/com/acme/service/UserServiceTest.kt",
    ]);
  });

  it("supports ? and [] classes; capitals make it case-sensitive", () => {
    expect(find("User*Test.kt")).toEqual(["src/test/java/com/acme/service/UserServiceTest.kt"]);
    expect(find("user*test.KT")).toEqual([]);
    expect(find("p?m.xml")).toEqual(["pom.xml"]);
    expect(find("[FP]*.*").sort()).toEqual([
      "src/components/Pane.tsx",
      "src/main/java/com/acme/Foo.java",
    ]);
    expect(compileGlob("[!a]b", true)("cb")).toBe(true);
    expect(compileGlob("[!a]b", true)("ab")).toBe(false);
  });

  it("never throws on a backwards range: it matches nothing, as in bash", () => {
    for (const q of ["[z-a]", "[b-a].ts", "[9-0]*", "src/[z-a]/**"]) {
      expect(() => parseQuery(q)).not.toThrow();
      expect(() => find(q)).not.toThrow();
      expect(find(q)).toEqual([]);
    }
    // The rest of the class still counts.
    expect(compileGlob("[z-ap]om.xml", true)("pom.xml")).toBe(true);
  });

  it("treats unclosed or odd classes sensibly, without throwing", () => {
    for (const q of ["[", "[abc", "src/[", "[]", "[!]", "[^", "*[", "[a-", "[a-]x", "[]]", "\\[x]"]) {
      expect(() => find(q)).not.toThrow();
    }
    expect(compileGlob("[abc", true)("[abc")).toBe(true);
    expect(compileGlob("a[", true)("a[")).toBe(true);
    // `]` first in the class is a member; `-` at either end is literal.
    expect(compileGlob("[]a]", true)("]")).toBe(true);
    expect(compileGlob("[!]a]", true)("b")).toBe(true);
    expect(compileGlob("[!]a]", true)("]")).toBe(false);
    expect(compileGlob("[a-]", true)("-")).toBe(true);
    // A class never matches `/`, even negated.
    expect(compileGlob("a[!x]b", true)("a/b")).toBe(false);
  });

  it("**/ matches zero or more directories; ** alone crosses /", () => {
    const g = compileGlob("src/**/*.ts", true);
    expect(g("src/a.ts")).toBe(true);
    expect(g("src/a/b/c.ts")).toBe(true);
    expect(g("srca.ts")).toBe(false);
    expect(compileGlob("a**b", true)("a/x/b")).toBe(true);
    expect(compileGlob("a*b", true)("a/b")).toBe(false);
    expect(compileGlob("**", true)("")).toBe(true);
    expect(compileGlob("***.ts", true)("a/b.ts")).toBe(true);
  });

  it("agrees with a reference regex on random globs, short and long", () => {
    // The old regex translation, kept here as the spec (valid globs only).
    const reference = (glob: string) => {
      let re = "";
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*") {
          let run = 1;
          while (glob[i + 1] === "*") run++, i++;
          if (run >= 2 && glob[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else re += run >= 2 ? ".*" : "[^/]*";
        } else if (c === "?") re += "[^/]";
        else if (c === "[") {
          const close = glob.indexOf("]", i);
          const body = glob.slice(i + 1, close);
          re += body[0] === "!" ? `[^/${body.slice(1)}]` : `[${body}]`;
          i = close;
        } else re += c;
      }
      return new RegExp(`^${re}$`);
    };
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const PIECES = ["a", "b", "/", "*", "**", "**/", "?", "[ab]", "[!a]", "[a-b]"];
    for (let round = 0; round < 600; round++) {
      const len = round < 500 ? 1 + rand(6) : 31 + rand(10);
      let glob = "";
      for (let k = 0; k < len; k++) glob += PIECES[rand(PIECES.length)];
      const ours = compileGlob(glob, true);
      const re = reference(glob);
      for (let t = 0; t < 20; t++) {
        let subject = "";
        const n = rand(round < 500 ? 9 : 40);
        for (let k = 0; k < n; k++) subject += "ab/c"[rand(4)];
        expect([glob, subject, ours(subject)]).toEqual([glob, subject, re.test(subject)]);
      }
    }
  });

  it("treats regex metacharacters literally", () => {
    expect(compileGlob("a.b+(c)*", true)("a.b+(c)d")).toBe(true);
    expect(compileGlob("a.b*", true)("axb")).toBe(false);
  });

  it("\\ makes the next character literal, in and out of classes", () => {
    expect(parseQuery("\\*.ts").kind).toBe("glob");
    expect(compileGlob("\\*.ts", true)("*.ts")).toBe(true);
    expect(compileGlob("\\*.ts", true)("a.ts")).toBe(false);
    expect(compileGlob("a\\?", true)("a?")).toBe(true);
    expect(compileGlob("a\\?", true)("ab")).toBe(false);
    expect(compileGlob("\\[x]", true)("[x]")).toBe(true);
    expect(compileGlob("\\[x]", true)("x")).toBe(false);
    expect(compileGlob("\\{a,b}", true)("{a,b}")).toBe(true);
    expect(compileGlob("\\\\", true)("\\")).toBe(true);
    // A trailing `\` is itself.
    expect(compileGlob("a\\", true)("a\\")).toBe(true);
    // In a class: an escaped `]` or `-` is a member.
    expect(compileGlob("[\\]]", true)("]")).toBe(true);
    expect(compileGlob("[a\\-c]", true)("-")).toBe(true);
    expect(compileGlob("[a\\-c]", true)("b")).toBe(false);
    const files = prepareFiles(["src/*.ts", "src/a.ts"]);
    expect(matchFiles(files, parseQuery("\\*.ts")).map((m) => m.path)).toEqual(["src/*.ts"]);
  });

  it("expands {a,b} braces, nested, and each alternative picks name or path", () => {
    expect(find("*.{ts,tsx}").sort()).toEqual([
      "src/components/EditorPane.tsx",
      "src/components/Pane.tsx",
      "src/components/editor/deep/pin.ts",
      "src/lib/ipc.ts",
      "src/x/index.ts",
    ]);
    expect(parseQuery("{Foo,Pane}.*").kind).toBe("glob");
    expect(find("{Foo,Pane}.{java,tsx}").sort()).toEqual(["src/components/Pane.tsx", "src/main/java/com/acme/Foo.java"]);
    expect(find("{src/lib/*,README}.{ts,md}").sort()).toEqual(["README.md", "src/lib/ipc.ts"]);
    expect(expandBraces("a{b,{c,d}e}f")).toEqual(["abf", "acef", "adef"]);
    expect(expandBraces("{,x}.ts")).toEqual([".ts", "x.ts"]);
    // No comma, unclosed, or escaped: literal, as in bash.
    expect(expandBraces("{a}{b,c")).toEqual(["{a}{b,c"]);
    expect(expandBraces("\\{a,b}")).toEqual(["\\{a,b}"]);
    expect(parseQuery("{id}").kind).toBe("fuzzy");
    expect(compileGlob("[{]x", true)("{x")).toBe(true);
  });

  it("caps brace expansion: past the limit the query is fuzzy text", () => {
    expect(expandBraces("{a,b}".repeat(5))).toHaveLength(32);
    expect(expandBraces("{a,b}".repeat(6))).toBeNull();
    expect(expandBraces("{a,b}".repeat(40))).toBeNull();
    expect(parseQuery("*{a,b}".repeat(6)).kind).toBe("fuzzy");
    // 8 alternatives of ~200 characters: over the total length.
    expect(expandBraces("{a,b,c,d,e,f,g,h}" + "x".repeat(200))).toBeNull();
  });

  it("? and classes take a whole astral character", () => {
    expect(compileGlob("?.ts", true)("😀.ts")).toBe(true);
    expect(compileGlob("??.ts", true)("😀.ts")).toBe(false);
    expect(compileGlob("[😀😃].ts", true)("😃.ts")).toBe(true);
    expect(compileGlob("[!😀].ts", true)("😃.ts")).toBe(true);
    expect(compileGlob("[!😀].ts", true)("😀.ts")).toBe(false);
    expect(compileGlob("[😀-😆]", true)("😃")).toBe(true);
    expect(compileGlob("*😀", true)("a😀")).toBe(true);
    expect(compileGlob("😀*", true)("😀b")).toBe(true);
    expect(compileGlob("a?b", true)("a😀b")).toBe(true);
    expect(compileGlob("a?b", true)("a\ud83db")).toBe(true); // a lone surrogate is one character
    // One code point, not one grapheme: a skin-toned emoji is two code points.
    expect(compileGlob("?.md", true)("👍🏽.md")).toBe(false);
    expect(compileGlob("??.md", true)("👍🏽.md")).toBe(true);
    expect(matchFiles(prepareFiles(["docs/😀.md", "docs/ab.md"]), parseQuery("?.md")).map((m) => m.path)).toEqual([
      "docs/😀.md",
    ]);
  });
});

describe("fileMatch — fuzzy", () => {
  it("an exact file name ranks first", () => {
    expect(find("Pane.tsx")[0]).toBe("src/components/Pane.tsx");
  });

  it("matches camel-case initials (edpn → EditorPane)", () => {
    expect(find("edpn")[0]).toBe("src/components/EditorPane.tsx");
  });

  it("space-separated terms must all match", () => {
    expect(find("user service")).toEqual([
      "src/main/java/com/acme/service/UserService.java",
      "src/test/java/com/acme/service/UserServiceTest.kt",
    ]);
    expect(find("user nothinglikethis")).toEqual([]);
  });

  it("a file named exactly the query (stem or full name) ranks first", () => {
    const files = prepareFiles([
      "src/main/java/com/acme/repo/UserRepo.java",
      "src/main/java/com/acme/service/UserService.java",
      "src/main/java/com/acme/domain/model/User.java",
    ]);
    const top = (q: string) => matchFiles(files, parseQuery(q))[0].path;
    expect(top("user")).toBe("src/main/java/com/acme/domain/model/User.java");
    expect(top("User.java")).toBe("src/main/java/com/acme/domain/model/User.java");
    expect(top("userrepo")).toBe("src/main/java/com/acme/repo/UserRepo.java");
  });

  it("a file-name match beats a directory match", () => {
    const ranked = find("service");
    expect(ranked.indexOf("src/main/java/com/acme/service/OrderService.java")).toBeLessThan(
      ranked.indexOf("docs/service/Main.md"),
    );
  });

  it("ties go to boosted paths (open tabs, recent files)", () => {
    expect(find("", ["src/lib/ipc.ts"])[0]).toBe("src/lib/ipc.ts");
    // Same score for both — the boost decides.
    const both = matchFiles(
      prepareFiles(["a/Foo.java", "b/Foo.java"]),
      parseQuery("foo"),
      ["b/Foo.java"],
    );
    expect(both.map((m) => m.path)).toEqual(["b/Foo.java", "a/Foo.java"]);
  });
});

describe("fileMatch — positions and normalisation", () => {
  it("Foo.java:42 opens Foo.java at line 42", () => {
    const q = parseQuery("Foo.java:42");
    expect(q).toMatchObject({ kind: "fuzzy", text: "Foo.java", line: 42 });
    expect(q.col).toBeUndefined();
    expect(find("Foo.java:42")[0]).toBe("src/main/java/com/acme/Foo.java");
  });

  it("parses :line:col", () => {
    expect(parseQuery("UserService.java:42:7")).toMatchObject({ text: "UserService.java", line: 42, col: 7 });
  });

  it("clamps a huge :line or :col to MAX_POSITION", () => {
    expect(parseQuery("foo:99999999999999999999")).toMatchObject({ text: "foo", line: MAX_POSITION });
    expect(parseQuery("foo:3:99999999999999999999")).toMatchObject({ line: 3, col: MAX_POSITION });
    expect(parseQuery(`foo:${MAX_POSITION}`).line).toBe(MAX_POSITION);
    expect(parseQuery("foo:0").line).toBe(1);
  });

  it("./src/x matches like src/x", () => {
    expect(normalizeQuery("./src/x")).toBe("src/x");
    expect(find("./src/x")[0]).toBe("src/x/index.ts");
  });

  it("an absolute path inside the workspace matches its relative file", () => {
    expect(normalizeQuery(`${WS}/src/lib/ipc.ts`, WS)).toBe("src/lib/ipc.ts");
    expect(find(`${WS}/src/lib/ipc.ts:3`)[0]).toBe("src/lib/ipc.ts");
    expect(parseQuery(`${WS}/src/main/java/com/acme/Foo.java`, WS).kind).toBe("fuzzy");
  });

  it("a bare :42 or :42:7 is the empty query, not line 42 of whatever ranks first", () => {
    for (const q of [":42", ":42:7", " :3 ", ":"]) {
      const parsed = parseQuery(q);
      expect(parsed.kind).toBe("empty");
      expect(parsed.line).toBeUndefined();
      expect(parsed.col).toBeUndefined();
    }
  });

  it("a trailing colon typed on the way to :line keeps the matches", () => {
    expect(parseQuery("index.ts:")).toMatchObject({ kind: "fuzzy", text: "index.ts" });
    expect(parseQuery("index.ts:").line).toBeUndefined();
    expect(parseQuery("index.ts:42:")).toMatchObject({ text: "index.ts", line: 42 });
    expect(parseQuery("index.ts:42:").col).toBeUndefined();
    expect(find("index.ts:")).toEqual(find("index.ts"));
    expect(find("index.ts:")[0]).toBe("src/x/index.ts");
    expect(find("*.ts:")).toEqual(find("*.ts"));
  });

  it("an empty query lists every file", () => {
    expect(find("  ")).toHaveLength(FILES.length);
  });
});

describe("fileMatch — unicode", () => {
  it("folds case without changing the length, so indices stay aligned", () => {
    expect(foldCase("İstanbul/User.ts")).toHaveLength("İstanbul/User.ts".length);
    expect(foldCase("İstanbul/User.ts")).toBe("İstanbul/user.ts");
    expect(foldCase("ÉCOLE")).toBe("école");
  });

  it("a cased character whose lower case is longer (İ) doesn't shift scores", () => {
    const [dotted, plain] = matchFiles(prepareFiles(["src/İ/User.ts", "src/I/User.ts"]), parseQuery("user"));
    expect(dotted.score).toBe(plain.score);
    // The exact-name bonus lands too: the name is found where it really is.
    const exact = matchFiles(prepareFiles(["İİİİ/User.ts", "İİİİ/UserX.ts"]), parseQuery("user"));
    expect(exact[0].path).toBe("İİİİ/User.ts");
    expect(exact[0].score).toBeGreaterThan(exact[1].score);
    expect(matchFiles(prepareFiles(["İİ/a.ts"]), parseQuery("İİ/*.ts")).map((m) => m.path)).toEqual(["İİ/a.ts"]);
  });

  it("matches NFD paths with NFC queries and the other way round, reporting the listed path", () => {
    const nfd = "docs/Cafe\u0301.md";
    const nfc = "docs/Caf\u00e9.md";
    expect(matchFiles(prepareFiles([nfd]), parseQuery("caf\u00e9")).map((m) => m.path)).toEqual([nfd]);
    expect(matchFiles(prepareFiles([nfc]), parseQuery("cafe\u0301")).map((m) => m.path)).toEqual([nfc]);
    expect(matchFiles(prepareFiles([nfd]), parseQuery("caf?.md")).map((m) => m.path)).toEqual([nfd]);
    // Same score either way.
    const a = matchFiles(prepareFiles([nfd]), parseQuery("café"))[0].score;
    const b = matchFiles(prepareFiles([nfc]), parseQuery("café"))[0].score;
    expect(a).toBe(b);
  });
});

describe("fileMatch — performance", () => {
  // 20k paths shaped like a real Java tree.
  const big = prepareFiles(
    Array.from({ length: 20_000 }, (_, i) =>
      `src/main/java/com/acme/module${i % 97}/pkg${i % 13}/Thing${i}Service.java`,
    ),
  );

  const QUERIES = ["", "java", "tsvc", "*.java", "module4 thing"];

  it("a job run one unit per step gives the same ranking as matchFiles", () => {
    for (const q of QUERIES) {
      const parsed = parseQuery(q);
      const job = createMatchJob(big, parsed, ["src/main/java/com/acme/module5/pkg5/Thing5Service.java"]);
      let steps = 0;
      // A deadline in the past: exactly one unit per step.
      while (!job.step(-Infinity)) steps++;
      // 20,000 / MATCH_CHUNK chunks to score, then the merges.
      expect(steps).toBeGreaterThanOrEqual(Math.ceil(big.length / MATCH_CHUNK));
      expect(job.result()).toEqual(
        matchFiles(big, parsed, ["src/main/java/com/acme/module5/pkg5/Thing5Service.java"]),
      );
    }
  });

  it("no single unit of work over 20,000 paths takes more than a frame (16 ms)", () => {
    for (const q of QUERIES) {
      const parsed = parseQuery(q);
      matchFiles(big, parsed); // warm up
      const job = createMatchJob(big, parsed);
      let worst = 0;
      let finished = false;
      while (!finished) {
        const t0 = performance.now();
        finished = job.step(-Infinity);
        worst = Math.max(worst, performance.now() - t0);
      }
      expect(job.result().length).toBeGreaterThan(0);
      expect(worst).toBeLessThan(16);
    }
  });

  it("pathological globs stay linear: all of them over 20,000 60-char paths in < 200 ms", () => {
    // Backtracking regexes took 55 ms and 272 ms *per file* on the first two.
    // 60-char paths whose 40-char file names are almost all `a`.
    const paths = Array.from({ length: 20_000 }, (_, i) =>
      `src/${"a".repeat(15)}/${(String(i) + "a".repeat(40)).slice(0, 40)}`,
    );
    expect(paths.every((p) => p.length === 60)).toBe(true);
    const files = prepareFiles(paths);
    const patterns = [
      "**a**a**a**a**a**/x",
      "*a*a*a*a*a*a*b",
      "**a**a**a**a**a**a**a**a**b",
      "*?*?*?*?*?*?*b",
      // A class tail gets past the literal-tail shortcut, so the automaton
      // reads every character.
      "*a*a*a*a*a*a*[b]",
      "**a**a**a**a**a**/[x]",
      // Over 30 states: several words per state set.
      "*a".repeat(20) + "[b]",
    ];
    const parsed = patterns.map((q) => parseQuery(q));
    for (const q of parsed) matchFiles(files, q); // warm up
    const t0 = performance.now();
    for (const q of parsed) expect(matchFiles(files, q)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("a glob over MAX_GLOB_LENGTH is fuzzy text; one at the limit stays fast", () => {
    const pasted = "**/".repeat(1000) + "*.ts";
    expect(parseQuery(pasted).kind).toBe("fuzzy");
    const atLimit = "**/".repeat((MAX_GLOB_LENGTH - 4) / 3) + "*.ts";
    expect(atLimit).toHaveLength(MAX_GLOB_LENGTH);
    expect(parseQuery(atLimit).kind).toBe("glob");
    expect(parseQuery(atLimit + "x").kind).toBe("fuzzy");
    // Paths that end in .ts, so the literal-tail shortcut can't reject them.
    const files = prepareFiles(
      Array.from({ length: 20_000 }, (_, i) => `src/a${i % 7}/b${i % 5}/c/d/e/f/g/file${i}.ts`),
    );
    const parsed = parseQuery(atLimit);
    matchFiles(files, parsed); // warm up
    const t0 = performance.now();
    expect(matchFiles(files, parsed)).toHaveLength(20_000);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("step works until its deadline, then yields", () => {
    const job = createMatchJob(big, parseQuery("java"));
    const t0 = performance.now();
    const finished = job.step(t0 + 1);
    // Either it finished, or it stopped soon after the deadline (one unit).
    if (!finished) expect(performance.now() - t0).toBeLessThan(17);
    expect(job.step(Infinity)).toBe(true);
    expect(job.result()).toEqual(matchFiles(big, parseQuery("java")));
  });
});
