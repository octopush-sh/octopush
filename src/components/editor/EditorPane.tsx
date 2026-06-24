// Re-export from the top-level component so that:
// (a) the EditorWithPreview import path "./EditorPane" resolves correctly, and
// (b) Vitest's vi.mock("./EditorPane", ...) can intercept it in tests.
export { EditorPane } from "../EditorPane";
