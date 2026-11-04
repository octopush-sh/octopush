import { describe, it, expect } from "vitest";
import { loadLanguage } from "./editorLanguages";

/**
 * The Java annotation rule in `editorLanguages.ts` (`JAVA_RULES`) names node
 * paths of `@lezer/java`. A grammar update that renames them would leave
 * annotations plain without failing anything else, so pin the shape here.
 */
describe("Java annotation selectors", () => {
  it("annotations parse as MarkerAnnotation / Annotation over an Identifier", async () => {
    const java = await loadLanguage("java");
    const tree = java!.parser.parse("@Override @SuppressWarnings(\"x\") class A {}").toString();
    expect(tree).toContain("MarkerAnnotation(Identifier)");
    expect(tree).toMatch(/Annotation\(Identifier,AnnotationArgumentList/);
  });
});
