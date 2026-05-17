import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceCustomizeMenu } from "./WorkspaceCustomizeMenu";

describe("WorkspaceCustomizeMenu", () => {
  function defaults() {
    return {
      initialGlyph: null as string | null,
      initialTint: null as
        | "brass" | "verdigris" | "rouge" | "indigo" | "lavender" | "smoke" | "bone"
        | null,
      defaultGlyph: "A",
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
  }

  it("renders 7 tint preset buttons", () => {
    render(<WorkspaceCustomizeMenu {...defaults()} />);
    expect(screen.getByRole("button", { name: /brass/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verdigris/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rouge/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /indigo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lavender/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /smoke/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bone/i })).toBeInTheDocument();
  });

  it("prefills the glyph input with the initial glyph or default", () => {
    const { rerender } = render(
      <WorkspaceCustomizeMenu {...defaults()} initialGlyph={null} defaultGlyph="X" />,
    );
    expect(screen.getByLabelText(/glyph/i)).toHaveValue("X");

    rerender(<WorkspaceCustomizeMenu {...defaults()} initialGlyph="§" defaultGlyph="X" />);
    expect(screen.getByLabelText(/glyph/i)).toHaveValue("§");
  });

  it("calls onSubmit with null glyph when input matches default, and chosen tint", () => {
    const onSubmit = vi.fn();
    render(
      <WorkspaceCustomizeMenu
        {...defaults()}
        onSubmit={onSubmit}
        initialGlyph={null}
        defaultGlyph="A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /verdigris/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith(null, "verdigris");
  });

  it("returns the user-typed glyph when it differs from default", () => {
    const onSubmit = vi.fn();
    render(
      <WorkspaceCustomizeMenu
        {...defaults()}
        onSubmit={onSubmit}
        initialGlyph={null}
        defaultGlyph="A"
      />,
    );
    const input = screen.getByLabelText(/glyph/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "§" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith("§", null);
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<WorkspaceCustomizeMenu {...defaults()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
