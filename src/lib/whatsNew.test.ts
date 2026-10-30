import { describe, expect, it } from "vitest";
import {
  buildTips,
  compareSemver,
  decideLaunch,
  parseChangeset,
  tipsForVersion,
  tipsInRange,
  toTip,
  versionLabel,
} from "./whatsNew";

const cs = (meta: string, body = "Body text.") => `---\n${meta}\n---\n${body}\n`;

describe("parseChangeset", () => {
  it("splits frontmatter and body", () => {
    const p = parseChangeset(cs("title: Hi\nkind: feature\narea: app", "Hello **there**."));
    expect(p?.meta).toEqual({ title: "Hi", kind: "feature", area: "app" });
    expect(p?.body).toBe("Hello **there**.");
  });
  it("returns null without frontmatter or with bad YAML", () => {
    expect(parseChangeset("no frontmatter")).toBeNull();
    expect(parseChangeset("---\n: : :\n  - [\n---\nx")).toBeNull();
    expect(parseChangeset("---\n- a\n- b\n---\nx")).toBeNull();
  });
  it("handles CRLF", () => {
    expect(parseChangeset("---\r\ntitle: A\r\n---\r\nB")?.body).toBe("B");
  });
});

describe("compareSemver", () => {
  it("orders numerically, not lexically", () => {
    expect(compareSemver("0.4.10", "0.4.9")).toBe(1);
    expect(compareSemver("0.4.9", "0.4.10")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("v0.4.88", "0.4.88")).toBe(0);
    expect(compareSemver("0.4.88-beta.1", "0.4.88")).toBe(0);
  });
});

describe("toTip", () => {
  it("keeps app features and improvements by default", () => {
    expect(toTip("/whats-new/0.4.89/a.md", cs("title: A\nkind: feature\narea: app"))?.title).toBe("A");
    expect(toTip("/whats-new/0.4.89/b.md", cs("title: B\nkind: improvement\narea: app"))).not.toBeNull();
  });
  it("drops fixes unless highlighted, and honours highlight: false", () => {
    expect(toTip("/whats-new/0.4.89/c.md", cs("title: C\nkind: fix\narea: app"))).toBeNull();
    expect(toTip("/whats-new/0.4.89/c.md", cs("title: C\nkind: fix\narea: app\nhighlight: true"))).not.toBeNull();
    expect(toTip("/whats-new/0.4.89/d.md", cs("title: D\nkind: feature\narea: app\nhighlight: false"))).toBeNull();
  });
  it("drops api/web entries, notes.md, README and non-version dirs", () => {
    expect(toTip("/whats-new/0.4.89/e.md", cs("title: E\nkind: feature\narea: api"))).toBeNull();
    expect(toTip("/whats-new/0.4.89/notes.md", "## Octopush 0.4.89")).toBeNull();
    expect(toTip("/whats-new/unreleased/README.md", "x")).toBeNull();
    expect(toTip("/whats-new/latest/f.md", cs("title: F\nkind: feature\narea: app"))).toBeNull();
  });
  it("parses steps and defaults action to none", () => {
    const t = toTip(
      "/whats-new/0.4.89/g.md",
      cs("title: G\nkind: feature\narea: app\nsteps:\n  - open: settings/about\n    target: about-whats-new\n    caption: Here.\n  - target: palette-input\n    caption: Type.\n    action: type\n    text: hi"),
    );
    expect(t?.steps).toEqual([
      { open: "settings/about", target: "about-whats-new", caption: "Here.", action: "none" },
      { target: "palette-input", caption: "Type.", action: "type", text: "hi" },
    ]);
  });
});

describe("buildTips", () => {
  const raws = {
    "/whats-new/0.4.10/z-fix.md": cs("title: Fix\nkind: fix\narea: app\nhighlight: true"),
    "/whats-new/0.4.10/a-feat.md": cs("title: Feat\nkind: feature\narea: app"),
    "/whats-new/0.4.9/imp.md": cs("title: Imp\nkind: improvement\narea: app"),
    "/whats-new/0.4.9/api.md": cs("title: Api\nkind: feature\narea: api"),
    "/whats-new/unreleased/next.md": cs("title: Next\nkind: feature\narea: app"),
  };
  const clips = { "/whats-new/0.4.10/a-feat.webm": "/assets/a-feat.webm" };
  const all = buildTips(raws, clips);

  it("groups by version, semver-sorted, unreleased last", () => {
    expect(all.map((v) => v.version)).toEqual(["0.4.9", "0.4.10", "unreleased"]);
  });
  it("orders features before fixes within a version and attaches clips", () => {
    expect(all[1].tips.map((t) => t.slug)).toEqual(["a-feat", "z-fix"]);
    expect(all[1].tips[0].clip).toBe("/assets/a-feat.webm");
    expect(all[1].tips[1].clip).toBeUndefined();
  });
  it("ranges are (from, to] and never include unreleased", () => {
    expect(tipsInRange(all, "0.4.8", "0.4.10").map((t) => t.slug)).toEqual(["imp", "a-feat", "z-fix"]);
    expect(tipsInRange(all, "0.4.9", "0.4.10").map((t) => t.slug)).toEqual(["a-feat", "z-fix"]);
    expect(tipsInRange(all, null, "99.0.0").some((t) => t.version === "unreleased")).toBe(false);
    expect(tipsForVersion(all, "0.4.9").map((t) => t.slug)).toEqual(["imp"]);
  });
  it("labels a version span", () => {
    expect(versionLabel(tipsInRange(all, "0.4.8", "0.4.10"))).toBe("v0.4.9 – v0.4.10");
    expect(versionLabel(tipsForVersion(all, "0.4.9"))).toBe("v0.4.9");
  });

  describe("decideLaunch", () => {
    it("fresh install: remember silently", () => {
      expect(decideLaunch(null, "0.4.10", all)).toEqual({ tips: [], markSeen: "0.4.10" });
    });
    it("upgrade across two versions: tips of both", () => {
      const d = decideLaunch("0.4.8", "0.4.10", all);
      expect(d.tips.map((t) => t.version)).toEqual(["0.4.9", "0.4.10", "0.4.10"]);
      expect(d.markSeen).toBe("0.4.10");
    });
    it("upgrade with no tips: nothing to open, still marks seen", () => {
      expect(decideLaunch("0.4.10", "0.4.11", all)).toEqual({ tips: [], markSeen: "0.4.11" });
    });
    it("same version or downgrade: nothing", () => {
      expect(decideLaunch("0.4.10", "0.4.10", all)).toEqual({ tips: [], markSeen: null });
      expect(decideLaunch("0.4.10", "0.4.9", all)).toEqual({ tips: [], markSeen: null });
    });
  });
});
