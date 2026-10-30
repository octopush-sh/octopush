#!/usr/bin/env node
// AGENTS.md must mirror CLAUDE.md (for tools that read AGENTS.md: Codex,
// Copilot CLI, Gemini CLI…). Only the third line — each file's own "what this
// file is" sentence — may differ. Exits 1 with a diff hint when they drift.
import { readFileSync } from "node:fs";

const body = (path) => {
  const lines = readFileSync(path, "utf8").replace(/\r\n/g, "\n").split("\n");
  lines.splice(2, 1);
  return lines;
};
const a = body("CLAUDE.md");
const b = body("AGENTS.md");
const n = Math.max(a.length, b.length);
for (let i = 0; i < n; i++) {
  if (a[i] !== b[i]) {
    const line = i >= 2 ? i + 2 : i + 1; // original 1-based line number
    console.error(`AGENTS.md has drifted from CLAUDE.md at line ${line}:`);
    console.error(`  CLAUDE.md: ${JSON.stringify(a[i] ?? "<missing>")}`);
    console.error(`  AGENTS.md: ${JSON.stringify(b[i] ?? "<missing>")}`);
    console.error("Copy CLAUDE.md over AGENTS.md (keeping AGENTS.md's line 3).");
    process.exit(1);
  }
}
console.log("AGENTS.md mirrors CLAUDE.md ✓");
