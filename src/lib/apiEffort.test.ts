import { describe, expect, it } from "vitest";
import { apiEffortOffTitle, EFFORT_OFF_TITLE } from "./apiEffort";

describe("apiEffortOffTitle", () => {
  it("keeps the plain Off copy off GPT-6", () => {
    for (const m of ["claude-sonnet-5-5", "gpt-5", "o3-mini", "gpt-4o"]) {
      expect(apiEffortOffTitle(m)).toBe(EFFORT_OFF_TITLE);
    }
  });

  it("says Off is effort none on the GPT-6 models that accept it", () => {
    for (const m of ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "GPT-6-Sol", "gpt-6-sol-2026-08-01", "openai/gpt-6-luna"]) {
      expect(apiEffortOffTitle(m)).toMatch(/^No reasoning \(effort none on OpenAI/);
    }
  });

  it("says Off keeps medium where OpenAI has no off level", () => {
    for (const m of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-solar", "gpt-6-sol-pro", "gpt-6-luna-2026-08"]) {
      expect(apiEffortOffTitle(m)).toBe("OpenAI has no off level for this model, so it reasons at its default: medium");
    }
  });
});
