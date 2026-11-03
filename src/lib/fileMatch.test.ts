import { describe, expect, it } from "vitest";
import {
  createMatchJob,
  globToRegExp,
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
    expect(globToRegExp("[!a]b", true).test("cb")).toBe(true);
    expect(globToRegExp("[!a]b", true).test("ab")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globToRegExp("a.b+(c)*", true).test("a.b+(c)d")).toBe(true);
    expect(globToRegExp("a.b*", true).test("axb")).toBe(false);
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

  it("./src/x matches like src/x", () => {
    expect(normalizeQuery("./src/x")).toBe("src/x");
    expect(find("./src/x")[0]).toBe("src/x/index.ts");
  });

  it("an absolute path inside the workspace matches its relative file", () => {
    expect(normalizeQuery(`${WS}/src/lib/ipc.ts`, WS)).toBe("src/lib/ipc.ts");
    expect(find(`${WS}/src/lib/ipc.ts:3`)[0]).toBe("src/lib/ipc.ts");
    expect(parseQuery(`${WS}/src/main/java/com/acme/Foo.java`, WS).kind).toBe("fuzzy");
  });

  it("an empty query lists every file", () => {
    expect(find("  ")).toHaveLength(FILES.length);
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
