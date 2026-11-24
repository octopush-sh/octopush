import { describe, it, expect } from "vitest";
import { parseKeyPhrase } from "./parseKeyPhrase";

describe("parseKeyPhrase", () => {
  it("splits a plain sentence + body", () => {
    const r = parseKeyPhrase("Because skipRefreshCheck is true. The flag was meant for tests only.");
    expect(r.keyPhrase).toBe("Because skipRefreshCheck is true.");
    expect(r.body).toBe("The flag was meant for tests only.");
  });

  it("works with ? and ! terminators", () => {
    expect(parseKeyPhrase("What if we ditched the cache? It seems redundant.").keyPhrase)
      .toBe("What if we ditched the cache?");
    expect(parseKeyPhrase("Done! All tests pass.").keyPhrase)
      .toBe("Done!");
  });

  it("preserves inline code in the key phrase", () => {
    const r = parseKeyPhrase("Because `skipRefreshCheck` is true. Body here.");
    expect(r.keyPhrase).toBe("Because `skipRefreshCheck` is true.");
    expect(r.body).toBe("Body here.");
  });

  it("returns null keyPhrase when content starts with a fenced code block", () => {
    const r = parseKeyPhrase("```ts\nconst x = 1;\n```\nThe code above…");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("```ts\nconst x = 1;\n```\nThe code above…");
  });

  it("returns null keyPhrase when content starts with a heading", () => {
    const r = parseKeyPhrase("# Plan\n\nFirst step is…");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("# Plan\n\nFirst step is…");
  });

  it("returns null keyPhrase when content starts with a list", () => {
    const r = parseKeyPhrase("- First item\n- Second item");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("- First item\n- Second item");
  });

  it("returns null when there is no body after the key phrase", () => {
    const r = parseKeyPhrase("All done.");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("All done.");
  });

  it("returns null when the lead sentence is too long (over 160 chars)", () => {
    const long = "This is a very long lead sentence that exceeds the threshold for what looks like a punchy display phrase and would render awkwardly large on the screen if treated as a heading, so we skip the parse.";
    const r = parseKeyPhrase(long + " Body content.");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe(long + " Body content.");
  });

  it("trims surrounding whitespace from both parts", () => {
    const r = parseKeyPhrase("  Hello there.    Second sentence.   ");
    expect(r.keyPhrase).toBe("Hello there.");
    expect(r.body).toBe("Second sentence.");
  });

  it("handles content with no terminator (returns null key phrase)", () => {
    const r = parseKeyPhrase("Just a fragment without punctuation");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("Just a fragment without punctuation");
  });

  it("recognises punctuation followed by a streaming cursor block", () => {
    const r = parseKeyPhrase("Found it. Looking at the file now▊");
    expect(r.keyPhrase).toBe("Found it.");
    expect(r.body).toBe("Looking at the file now▊");
  });
});

describe("parseKeyPhrase — a terminator ends the lead only before whitespace", () => {
  it("never splits inside a URL (the reported bug)", () => {
    const text = "The PR is open: https://github.com/acme/api/pull/12";
    expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
  });

  it("doesn't elevate a lead that carries a URL, even a sentence that ends after it", () => {
    const text = "The PR is open at https://github.com/acme/api/pull/12. CI is running.";
    expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
    const query = "See https://example.com/search?q=a.b! for more. It lists them.";
    expect(parseKeyPhrase(query).keyPhrase).toBeNull();
  });

  it("treats www., mailto:, an email and a domain with a path as URLs", () => {
    for (const text of [
      "Docs live at www.example.com now. Read them first.",
      "Write to mailto:team@example.com today. They answer fast.",
      "Ping dev@example.com for access. They own the repo.",
      "It's pushed to github.com/acme/api today. Review when you can.",
    ]) {
      expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
    }
  });

  it("splits after a domain without a path, which renders as plain text", () => {
    const r = parseKeyPhrase("I pinged example.com and it answered. Latency is fine.");
    expect(r.keyPhrase).toBe("I pinged example.com and it answered.");
    expect(r.body).toBe("Latency is fine.");
  });

  it("never splits inside a version or a number", () => {
    const r = parseKeyPhrase("Bumped the app to v0.4.141 and the SDK to 3.5. Tests pass.");
    expect(r.keyPhrase).toBe("Bumped the app to v0.4.141 and the SDK to 3.5.");
    expect(r.body).toBe("Tests pass.");
    expect(parseKeyPhrase("It costs $3.50 per run, 12.5% less. Worth it.").keyPhrase)
      .toBe("It costs $3.50 per run, 12.5% less.");
  });

  it("splits after a version that ends the sentence", () => {
    const r = parseKeyPhrase("Bumped to v0.4.141. The changelog is updated.");
    expect(r.keyPhrase).toBe("Bumped to v0.4.141.");
    expect(r.body).toBe("The changelog is updated.");
  });

  it("never splits inside a file name", () => {
    const r = parseKeyPhrase("I updated index.ts and vite.config.ts to match. Both build.");
    expect(r.keyPhrase).toBe("I updated index.ts and vite.config.ts to match.");
    expect(r.body).toBe("Both build.");
    expect(parseKeyPhrase(".env is missing a key. Add it first.").keyPhrase)
      .toBe(".env is missing a key.");
  });

  it("never splits inside inline code, and keeps the code in the lead", () => {
    const r = parseKeyPhrase("Run `npm run build. && npm test` once more. It should pass.");
    expect(r.keyPhrase).toBe("Run `npm run build. && npm test` once more.");
    expect(r.body).toBe("It should pass.");
    const double = parseKeyPhrase("Use ``a ` b. c`` here. Then stop.");
    expect(double.keyPhrase).toBe("Use ``a ` b. c`` here.");
    expect(double.body).toBe("Then stop.");
  });

  it("doesn't elevate a URL even inside inline code", () => {
    const text = "Open `https://example.com/a` in the browser. It loads.";
    expect(parseKeyPhrase(text).keyPhrase).toBeNull();
  });

  it("keeps file names and underscores inside code in the lead", () => {
    const r = parseKeyPhrase("The bug is in `src/lib/parse_key.ts`. It drops the dot.");
    expect(r.keyPhrase).toBe("The bug is in `src/lib/parse_key.ts`.");
  });

  it("doesn't find a lead while a code span is still open", () => {
    const text = "Run `npm test. It fails";
    expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
  });

  it("never splits inside a markdown link, and never elevates one", () => {
    const text = "See [the guide. Part 2](https://example.com/a.b) for details. It covers setup.";
    expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
    const ref = "Read [the notes. All of them][notes] first. Then decide.";
    expect(parseKeyPhrase(ref)).toEqual({ keyPhrase: null, body: ref });
    const image = "Here is ![a chart. Big](chart.png) for you. It shows growth.";
    expect(parseKeyPhrase(image).keyPhrase).toBeNull();
  });

  it("doesn't split at common abbreviations", () => {
    const r = parseKeyPhrase("Use a fast tool, e.g. ripgrep, for the search. It's quicker.");
    expect(r.keyPhrase).toBe("Use a fast tool, e.g. ripgrep, for the search.");
    expect(r.body).toBe("It's quicker.");
    expect(parseKeyPhrase("Prefer the CLI, i.e. the binary on PATH. It's faster.").keyPhrase)
      .toBe("Prefer the CLI, i.e. the binary on PATH.");
    expect(parseKeyPhrase("Lint, format, etc. all pass now. Ready to ship.").keyPhrase)
      .toBe("Lint, format, etc. all pass now.");
    expect(parseKeyPhrase("It's Rust vs. Go here. Rust wins.").keyPhrase)
      .toBe("It's Rust vs. Go here.");
    expect(parseKeyPhrase("Use E.G. too. Fine.").keyPhrase).toBe("Use E.G. too.");
  });

  it("keeps closing quotes and parentheses with the sentence", () => {
    expect(parseKeyPhrase('He said "done." Then he left.').keyPhrase).toBe('He said "done."');
    expect(parseKeyPhrase("(It works now.) Ship it.").keyPhrase).toBe("(It works now.)");
  });

  it("keeps a run of terminators together", () => {
    const r = parseKeyPhrase("Really?! That's the cause. Fixing it.");
    expect(r.keyPhrase).toBe("Really?!");
    expect(r.body).toBe("That's the cause. Fixing it.");
  });

  it("handles Spanish opening punctuation", () => {
    const q = parseKeyPhrase("¿Quieres que abra el PR? Puedo hacerlo ahora.");
    expect(q.keyPhrase).toBe("¿Quieres que abra el PR?");
    expect(q.body).toBe("Puedo hacerlo ahora.");
    const e = parseKeyPhrase("¡Listo! Todas las pruebas pasan.");
    expect(e.keyPhrase).toBe("¡Listo!");
    expect(e.body).toBe("Todas las pruebas pasan.");
  });

  it("doesn't end the lead at an ellipsis", () => {
    const r = parseKeyPhrase("Hmm… let me check the config. It's in the root.");
    expect(r.keyPhrase).toBe("Hmm… let me check the config.");
    expect(r.body).toBe("It's in the root.");
    const dots = parseKeyPhrase("Wait... that's not it. The cache is fine.");
    expect(dots.keyPhrase).toBe("Wait... that's not it.");
    expect(dots.body).toBe("The cache is fine.");
    expect(parseKeyPhrase("Pensando…").keyPhrase).toBeNull();
  });

  it("splits at a line break after the lead", () => {
    const r = parseKeyPhrase("Found the cause.\nThe flag was never reset.\n\n- step one\n- step two");
    expect(r.keyPhrase).toBe("Found the cause.");
    expect(r.body).toBe("The flag was never reset.\n\n- step one\n- step two");
  });

  it("splits before a code block that follows the lead", () => {
    const r = parseKeyPhrase("Here's the fix.\n\n```ts\nconst x = 1.5;\n```");
    expect(r.keyPhrase).toBe("Here's the fix.");
    expect(r.body).toBe("```ts\nconst x = 1.5;\n```");
  });

  it("never reaches past the first line for a lead", () => {
    const text = "Here is the plan\nFirst, read the file. Then edit it.";
    expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
  });

  it("doesn't elevate a lead with emphasis, strikethrough or HTML", () => {
    for (const text of [
      "This is **important** to fix. Here is why.",
      "This is __important__ to fix. Here is why.",
      "This is *really* broken. Here is why.",
      "The snake_case name is wrong. Rename it.",
      "It took ~25 s~ 8 s. Much faster.",
      "Line one<br>line two. Body.",
      "Open <https://example.com> now. Body.",
      "[WIP] Still drafting. More soon.",
    ]) {
      expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
    }
  });

  it("still elevates a lead with one approximate tilde", () => {
    expect(parseKeyPhrase("The build takes ~3 minutes. Most of it is linking.").keyPhrase)
      .toBe("The build takes ~3 minutes.");
  });

  it("doesn't elevate punctuation alone", () => {
    expect(parseKeyPhrase("?! Then more text.").keyPhrase).toBeNull();
  });

  it("returns null for content opening with a quote, a + list, a 1) list or a table", () => {
    for (const text of ["> Quoted. Body.", "+ First item. Second.", "1) First. Second.", "| a | b |\n|---|---|"]) {
      expect(parseKeyPhrase(text)).toEqual({ keyPhrase: null, body: text });
    }
  });

  it("waits for whitespace before ending the lead while streaming", () => {
    expect(parseKeyPhrase("Bumped to v0.4.▊").keyPhrase).toBeNull();
    expect(parseKeyPhrase("The PR is open: https://github.▊").keyPhrase).toBeNull();
    const r = parseKeyPhrase("Found it. ▊");
    expect(r.keyPhrase).toBe("Found it.");
    expect(r.body).toBe("▊");
  });

  it("applies the 160-char cap to the lead found by the new rule", () => {
    const lead = "Bumped " + "v0.4.141, ".repeat(16) + "done.";
    expect(lead.length).toBeGreaterThan(160);
    expect(parseKeyPhrase(lead + " Body.").keyPhrase).toBeNull();
  });
});
