import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorBreadcrumb } from "./EditorBreadcrumb";

const ROOT = "/repo/wt/feature";

describe("EditorBreadcrumb", () => {
  it("renders nothing when no file is open", () => {
    const { container } = render(<EditorBreadcrumb path={null} rootPath={ROOT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the path relative to the worktree root, filename last", () => {
    render(<EditorBreadcrumb path={`${ROOT}/src/components/ReviewCanvas.tsx`} rootPath={ROOT} />);
    const nav = screen.getByRole("navigation", { name: /file location/i });
    expect(nav).toHaveTextContent("src");
    expect(nav).toHaveTextContent("components");
    expect(nav).toHaveTextContent("ReviewCanvas.tsx");
    // The root itself is not repeated in the trail.
    expect(nav.textContent).not.toContain("/repo/wt");
  });

  it("falls back to the absolute path for a file outside the worktree", () => {
    render(<EditorBreadcrumb path="/etc/hosts" rootPath={ROOT} />);
    expect(screen.getByRole("navigation", { name: /file location/i })).toHaveTextContent("hosts");
  });

  it("reveals the open file on demand — never on its own", () => {
    const onReveal = vi.fn();
    const path = `${ROOT}/src/lib/modeMeta.ts`;
    render(<EditorBreadcrumb path={path} rootPath={ROOT} onReveal={onReveal} />);
    expect(onReveal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /reveal in the file tree/i }));
    expect(onReveal).toHaveBeenCalledWith(path);
  });

  it("omits the reveal control when no tree is listening", () => {
    render(<EditorBreadcrumb path={`${ROOT}/a.ts`} rootPath={ROOT} />);
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });
});
