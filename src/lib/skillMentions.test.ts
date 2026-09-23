import { describe, it, expect } from "vitest";
import {
  applySkillMention,
  extractSkillMentions,
  findActiveSkillMention,
  skillTokens,
  splitBySkillTokens,
} from "./skillMentions";

const known = ["code-review", "release", "write-tests"];

describe("findActiveSkillMention", () => {
  it("opens on a / at line start or after whitespace, with the query up to the caret", () => {
    expect(findActiveSkillMention("/co", 3)).toEqual({ query: "co", start: 0 });
    expect(findActiveSkillMention("run /rel and", 8)).toEqual({ query: "rel", start: 4 });
    expect(findActiveSkillMention("line one\n/w", 11)).toEqual({ query: "w", start: 9 });
    expect(findActiveSkillMention("(/code", 6)).toEqual({ query: "code", start: 1 });
  });

  it("never treats a path segment or a finished token as a trigger", () => {
    expect(findActiveSkillMention("src/lib", 7)).toBeNull();
    expect(findActiveSkillMention("/release ", 9)).toBeNull();
    expect(findActiveSkillMention("no slash", 8)).toBeNull();
  });
});

describe("applySkillMention", () => {
  it("replaces the typed query with the name and a trailing space, caret after it", () => {
    expect(applySkillMention("run /rel now", 4, 8, "release")).toEqual({ text: "run /release  now", caret: 13 });
    expect(applySkillMention("/c", 0, 2, "code-review")).toEqual({ text: "/code-review ", caret: 13 });
  });
});

describe("skillTokens / extractSkillMentions", () => {
  it("finds every standalone known token, in order, deduped for extraction", () => {
    const text = "run /code-review then /release; also /code-review again";
    expect(skillTokens(text, known).map((t) => [t.name, t.start, t.end])).toEqual([
      ["code-review", 4, 16],
      ["release", 22, 30],
      ["code-review", 37, 49],
    ]);
    expect(extractSkillMentions(text, known)).toEqual(["code-review", "release"]);
  });

  it("ignores unknown names, path segments, and longer words", () => {
    expect(extractSkillMentions("see src/release and /release-notes and /unknown", known)).toEqual([]);
    expect(extractSkillMentions("and/or /release.", known)).toEqual(["release"]);
    expect(extractSkillMentions("/release", [])).toEqual([]);
  });

  it("splits a text into runs and tokens for rendering", () => {
    expect(splitBySkillTokens("do /release now", known)).toEqual([
      { kind: "text", text: "do " },
      { kind: "skill", name: "release", text: "/release" },
      { kind: "text", text: " now" },
    ]);
    expect(splitBySkillTokens("plain", known)).toEqual([{ kind: "text", text: "plain" }]);
  });
});
