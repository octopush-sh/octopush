import { describe, it, expect } from "vitest";
import { highlightTree, type Highlighter } from "@lezer/highlight";
import { type LangId } from "./editorLang";
import { GRAMMAR_LANGS, loadLanguage } from "./editorLanguages";
import { diffClassStyle, highlightLines } from "./diffSyntax";
import { makeHighlightStyle, resolveEditorTokens } from "../components/editor/atelierTheme";

/**
 * Tag coverage: every tag a supported language emits on a realistic file must
 * have a rule in the syntax palette (`syntaxPalette.ts`). A tag with no rule
 * renders as plain text — which is how Go, Kotlin and Shell came to look
 * uncoloured. Each fixture exercises keywords, types, functions (call and
 * definition), strings, numbers/constants, comments, annotations and
 * properties where the language has them.
 */
const FIXTURES: Record<Exclude<LangId, "plaintext">, string> = {
  javascript: `// c\n/* b */\nimport { a } from "m";\nclass A extends B { #p = 1; static m() { return this.#p ?? null; } }\nexport async function f(x, ...r) {\n  const o = { k: 1.5, "s": \`t\${x}\`, [x]: /re+/g, b: true, u: undefined };\n  for (let i = 0; i < 2; i++) o.k += i;\n  label: while (!x) break label;\n  return await g?.(o.k) instanceof A || typeof x === "y";\n}\n`,
  jsx: `const C = (p) => <div className="a" onClick={() => f(1)}>{p.x}<B.c /></div>;\n`,
  typescript: `// c\ninterface I<T> { a: T; readonly b?: number }\ntype U = "a" | 1 | null;\nenum E { A = 1 }\n@dec() class K implements I<string> { private x: number = 0; constructor(public y: boolean) {} get z(): void {} }\nnamespace N { export declare const v: unknown; }\nfunction f<T extends object>(a: T, b?: keyof T): asserts a is T { return; }\nlet n = <any>a as never satisfies I<1>;\n`,
  tsx: `const C: React.FC<{ x: number }> = ({ x }) => <a href="h" data-x={x as number}>{x}</a>;\n`,
  rust: `// c\n/// doc\n#[derive(Debug)]\npub struct S<'a> { pub f: &'a str, n: u32 }\nimpl<'a> S<'a> { pub fn new(f: &'a str) -> Self { Self { f, n: 0x1f } } }\nenum E { A(i64), B }\nconst C: f64 = 1.5e3;\nfn main() {\n  let mut v = vec![1, 2];\n  println!("{} {}", 'c', b"b");\n  if let Some(x) = v.pop() { v.push(x as i32 + 1); }\n  match true { true => (), false => unreachable!() }\n  let r = r"raw"; let _ = std::mem::take(&mut v); loop { break; }\n}\n`,
  python: `# c\nimport os\nfrom a import b as c\n@decorator(1)\nclass K(Base):\n    """doc"""\n    x: int = 0\n    def m(self, *a, **k) -> None:\n        return super().m(f"{a!r}", b'b', 1.5j, None, True)\nasync def g():\n    await h(lambda y: y ** 2 if y else -y)\n    with open("p") as f: pass\n    global q; nonlocal_ = [i for i in range(3)]\n    print(os.path)\n`,
  java: `// c\n/** @param x doc */\npackage p;\nimport java.util.List;\n@Deprecated\npublic class A<T> extends B implements C {\n  private static final int N = 0x10;\n  @Override public String toString() { return "s" + 'c' + 1.5f + null; }\n  A(int x) { super(); this.n = x; }\n  void m(List<String> l) { for (var s : l) System.out.println(s.length()); if (l instanceof Object && true) throw new RuntimeException(); }\n  enum E { A, B }\n  interface I { default void f() {} }\n  @interface Ann { int v() default 1; }\n}\n`,
  json: `{ "a": 1, "b": [true, false, null], "c": { "d": "e", "f": -1.5e3 } }\n`,
  markdown: `# Title\n\n## Sub\n\nSome *em* and **strong** and ~~del~~ and \`code\` and [link](http://x.y "t") <http://a.b>.\n\n> quote\n\n- item\n1. one\n\n\`\`\`\ncode\n\`\`\`\n\n---\n\n![img](i.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n`,
  html: `<!DOCTYPE html>\n<!-- c -->\n<html lang="en"><head><style>a { color: red; }</style><script>let x = 1;</script></head>\n<body class="b" hidden>&amp; text<br/></body></html>\n`,
  css: `/* c */\n@media (min-width: 10px) { .a > #b:hover::before, div[x="y"] { color: #fff !important; margin: 1px calc(2em - 3%); --v: 1; content: "s"; font-family: Foo, serif; transform: rotate(1deg); } }\n@import url("x.css");\n@keyframes k { from { opacity: 0 } }\n`,
  sass: `// c\n$v: 1px\n@mixin m($a)\n  color: $a\n.a\n  &:hover\n    @include m(red)\n    width: calc(100% - #{$v})\n`,
  scss: `// c\n$v: 1px;\n@mixin m($a) { color: $a; }\n.a { &:hover { @include m(red); width: calc(100% - #{$v}); } %p { x: y } @extend %p; }\n@function f($x) { @return $x * 2; }\n`,
  xml: `<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE r>\n<r a="b"><![CDATA[x]]><c>&amp; t</c></r>\n`,
  yaml: `# c\n%YAML 1.2\n---\nkey: value\nn: 1.5\nb: true\nnull_: ~\nlist:\n  - "q"\n  - 'r'\nanchor: &a { x: 1 }\nref: *a\ntag: !!str s\nblock: |\n  text\n...\n`,
  go: `// c\npackage main\nimport "fmt"\ntype T struct { N int \`json:"n"\` }\ntype I interface { M() error }\nfunc (t *T) M() error { return nil }\nfunc main() {\n  x := []int{1, 2}\n  fmt.Println("s", 'r', 1.5, true, x[0], len(x))\n  for i := range x { if i > 0 { continue } }\n  go func() {}()\n  ch := make(chan int); ch <- 1; defer close(ch)\nL:\n  goto L\n}\n`,
  cpp: `// c\n#include <vector>\n#define N 1\nnamespace a { template<typename T> class K : public B { public: K() = default; virtual ~K(); int f(int x) const override { return x + N; } }; }\nint main() { auto s = "s"; char c = 'c'; bool b = nullptr == 0 && true; std::vector<int> v{1}; v.push_back(2.5f); return 0; }\n`,
  c: `/* c */\n#include <stdio.h>\nstruct S { int x; };\ntypedef unsigned long u;\nint main(void) { struct S s = { .x = 1 }; printf("%d\\n", s.x); return 'a'; }\n`,
  sql: `-- c\nSELECT a.id, COUNT(*) AS n, 'x' FROM t a WHERE a.v > 1.5 AND b IS NULL GROUP BY a.id;\nCREATE TABLE t (id INT PRIMARY KEY, s VARCHAR(10) DEFAULT TRUE);\n`,
  php: `<?php\n// c\nnamespace N;\nuse A\\B;\n#[Attr]\nclass K extends B { const C = 1; private ?int $x = null; public function f(array $a): string { return "s{$this->x}" . 'q' . strlen($a[0]) . self::C . 1.5 . true; } }\n$v = new K(); echo $v->f([]);\n?>\n`,
  shell: `#!/bin/bash\n# c\nFOO=bar\necho "$FOO \${FOO} $(date)" 'q' > /dev/null 2>&1\nif [ -f x ]; then cd /tmp; fi\nf() { local n=1; return $n; }\nfor i in 1 2; do printf '%s' "$i"; done\ncat <<EOF\nhere\nEOF\n`,
  toml: `# c\n[table]\nkey = "v"\nn = 1.5\nb = true\nd = 1979-05-27\narr = [1, 'two']\n[[aot]]\nx = { y = 1 }\n`,
  dockerfile: `# c\nFROM node:20 AS build\nARG V=1\nENV A="b"\nRUN echo "hi" && \\\n  npm ci\nCOPY --from=build /a /b\nCMD ["node", "x.js"]\n`,
  properties: `# c\n! c2\n[section]\nkey=value\nother : v\n`,
  ruby: `# c\nrequire "x"\nmodule M\n  class K < B\n    attr_reader :a\n    @@c = 1\n    def initialize(x, *r, &b)\n      @x = x; $g = nil\n      puts "s#{x}", 'q', :sym, 1.5, true, /re/\n      [1, 2].each { |i| yield i }\n    end\n  end\nend\n`,
  swift: `// c\nimport Foundation\n@objc protocol P { func m() -> Int }\nstruct S: P { var x: Int = 0x1; let s = "t\\(x)"; func m() -> Int { return x } }\nclass K { private(set) var n: Double? = nil; init() { print(true, 1.5) } }\nenum E { case a, b }\n`,
  csharp: `// c\nusing System;\nnamespace N { [Serializable] public class K<T> : B { private int x = 1; public string F(T a) { var s = $"x{a}"; return s + 'c' + @"v" + null + true + 1.5m; } } }\n`,
  kotlin: `// c\npackage p\nimport a.B\n@Suppress("x")\ndata class K(val x: Int = 1) : B() {\n  override fun toString(): String = "s\${x} $x" + 'c' + 1.5 + null + true\n  fun f(l: List<String>) { l.forEach { println(it.length) } }\n  companion object { const val N = 0x10 }\n}\n`,
  scala: `// c\npackage p\nimport a.B\n@deprecated\ncase class K(x: Int = 1) extends B {\n  override def toString: String = s"s$x" + 'c' + 1.5 + null + true\n  def f(l: List[String]): Unit = l.foreach(println)\n}\nobject O { val n = 0x10; lazy val m = 'sym }\n`,
  dart: `// c\nimport 'package:a/b.dart';\n@override\nclass K extends B { final int x = 1; String f(List<String> l) { return "s\${x} $x" + 'c' + 1.5.toString() + null.toString() + true.toString(); } }\nvoid main() async { await Future.value(1); }\n`,
  groovy: `// c\nimport a.B\n@Grab('x')\nclass K extends B { def x = 1; String f(List l) { return "s\${x}" + 'c' + 1.5 + null + true + /re/ } }\nprintln new K().f([])\n`,
  protobuf: `// c\nsyntax = "proto3";\npackage p;\nimport "x.proto";\nmessage M { int32 id = 1; repeated string s = 2; map<string, M> m = 3; oneof o { bool b = 4; } }\nenum E { A = 0; }\nservice S { rpc F(M) returns (M); }\n`,
  lua: `-- c\n--[[ b ]]\nlocal t = { k = 1.5, "s", [[long]] }\nfunction t.f(a, ...) return a and nil or true end\nfor i = 1, 2 do print(#t, i) end\nlocal m = setmetatable({}, { __index = t })\n`,
};

/** Every tag set the highlighter sees while `lang` paints `doc`, with no
 *  rule in `style`. */
async function unstyledTags(lang: LangId, doc: string, style: Highlighter): Promise<string[]> {
  const language = await loadLanguage(lang);
  expect(language, `${lang} must load a grammar`).not.toBeNull();
  const missing = new Set<string>();
  const probe: Highlighter = {
    style(tags) {
      const cls = style.style(tags);
      // Opaque rules (`Attributes!`) reach here with no tags: nothing to style.
      if (cls == null && tags.length) missing.add(tags.map(String).join(" "));
      return cls;
    },
    scope: style.scope,
  };
  highlightTree(language!.parser.parse(doc), probe, () => {});
  return [...missing].sort();
}

describe("syntax palette tag coverage", () => {
  it("has a fixture for every language with a grammar", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...GRAMMAR_LANGS].sort());
  });

  const editorStyle = makeHighlightStyle(resolveEditorTokens());

  for (const lang of GRAMMAR_LANGS as Exclude<LangId, "plaintext">[]) {
    it(`${lang}: every emitted tag has an editor rule and a diff class`, async () => {
      expect(await unstyledTags(lang, FIXTURES[lang], editorStyle), "editor").toEqual([]);
      expect(await unstyledTags(lang, FIXTURES[lang], diffClassStyle), "diff").toEqual([]);
    });
  }
});

/** The class the diff gives the first token whose text includes `needle` on
 *  any line of `doc`. */
async function classOf(lang: LangId, doc: string, needle: string): Promise<string | undefined> {
  await loadLanguage(lang);
  return highlightLines(doc.split("\n"), lang).flat().find((t) => t.text.includes(needle))?.cls;
}

describe("syntax kinds read apart", () => {
  it.each<[LangId, string, string, string]>([
    // Java: annotations, declarations, calls, types, constants.
    ["java", "@Override public String toString() { return null; }", "Override", "tok-meta"],
    ["java", "@SuppressWarnings(\"x\") class A {}", "SuppressWarnings", "tok-meta"],
    ["java", "class A { void m() { foo(1); } }", "foo", "tok-fn"],
    ["java", "class A { String s; }", "String", "tok-type"],
    ["java", "class A { boolean b = true; }", "true", "tok-num"],
    ["java", "class A { int n = 42; }", "42", "tok-num"],
    ["java", "class A { String s = \"x\"; }", "\"x\"", "tok-str"],
    ["java", "// note\nclass A {}", "// note", "tok-cmt"],
    ["java", "class A { void m() { this.n = 1; } }", "this", "tok-kw"],
    // Go: calls and function declarations, types, fields.
    ["go", "package m\nfunc main() { run(1) }", "run", "tok-fn"],
    ["go", "package m\nfunc greet() {}", "greet", "tok-fn"],
    ["go", "package m\nvar s String", "String", "tok-type"],
    ["go", "package m\nfunc f() { x := t.field }", "field", "tok-prop"],
    ["go", "package m\nvar x = 42", "42", "tok-num"],
    // Rust: macros take the macro ink, not the call ink.
    ["rust", "fn main() { println!(\"x\"); }", "println", "tok-meta"],
    ["rust", "fn main() { run(1); }", "run", "tok-fn"],
    ["rust", "#[derive(Debug)]\nstruct S;", "derive", "tok-meta tok-var"],
    // Legacy modes: builtin, def, qualifier, meta, atom, variable-2.
    ["shell", "echo hi", "echo", "tok-fn"],
    ["shell", "FOO=1", "FOO", "tok-num"],
    ["kotlin", "fun main() { run(1) }", "run", "tok-fn"],
    ["kotlin", "@Suppress(\"x\") class K", "@Suppress", "tok-meta"],
    ["kotlin", "val x = true", "true", "tok-num"],
    ["swift", "func greet() {}", "greet", "tok-fn"],
    ["ruby", "def greet\nend", "greet", "tok-fn"],
    ["ruby", "x = :sym", ":sym", "tok-num"],
    ["lua", "print(1)", "print", "tok-fn"],
  ])("%s: %j → %s is %s", async (lang, doc, needle, cls) => {
    expect(await classOf(lang, doc, needle)).toBe(cls);
  });
});
