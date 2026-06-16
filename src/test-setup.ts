import "@testing-library/jest-dom";
import { setArchetypes } from "./components/builder/graph";
import type { Role } from "./lib/ipc";

// Seed the archetype LOADED cache so graph + stageMeta functions produce
// real labels in tests (no Tauri IPC available; rolesStore.load() can't run).
const TEST_SEED_ROLES: Role[] = [
  { key: "plan", label: "Plan", description: "", promptBody: "", artifactKind: "plan", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 4000, tokenEstOut: 1500, isBuiltin: true },
  { key: "plan_review", label: "Plan review", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: true, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "implement", label: "Implement", description: "", promptBody: "", artifactKind: "diff", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 12000, tokenEstOut: 6000, isBuiltin: true },
  { key: "code_review", label: "Code review", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: true, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "test", label: "Tests", description: "", promptBody: "", artifactKind: "tests", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 6000, tokenEstOut: 2000, isBuiltin: true },
  { key: "repro", label: "Reproduce", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "fix", label: "Fix", description: "", promptBody: "", artifactKind: "diff", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 12000, tokenEstOut: 6000, isBuiltin: true },
  { key: "verify", label: "Verify", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: true, defaultTools: ["read_file", "list_files", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "critique", label: "Critique", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: true, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "refine", label: "Refine", description: "", promptBody: "", artifactKind: "plan", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 4000, tokenEstOut: 1500, isBuiltin: true },
];
setArchetypes(TEST_SEED_ROLES);

// Also seed the rolesStore state so stageMeta.labelForRole / stageTitle work.
import { useRolesStore } from "./stores/rolesStore";
useRolesStore.setState({ roles: TEST_SEED_ROLES, loaded: true });

// jsdom lacks a few browser APIs that components (and @xyflow/react) reach for.
// Provide minimal, well-behaved stubs so component tests can mount.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserver;
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof globalThis.matchMedia;
}
