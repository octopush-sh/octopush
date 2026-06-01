import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyProjectState } from "./EmptyProjectState";

describe("EmptyProjectState", () => {
  it("renders the 'pick another project from the rail' hint and no Switch project button", () => {
    render(<EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} />);
    expect(screen.getByText(/pick another project from the rail/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch project/i })).not.toBeInTheDocument();
  });
});
