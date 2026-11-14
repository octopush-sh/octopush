import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./RunsTray", () => ({ RunsTray: () => null }));
vi.mock("../hooks/useEntitlement", () => ({
  useEntitlement: () => ({ hasFeature: () => true }),
}));
vi.mock("../hooks/useMascotState", () => ({
  useMascotState: () => ({ state: "idle", label: "Octopush is idle" }),
}));

import { AppTopBar, projectNameFits } from "./AppTopBar";

function renderBar(projectName: string | null) {
  return render(
    <AppTopBar
      onOpenSettings={vi.fn()}
      onToggleScratchpad={vi.fn()}
      onOpenMissionControl={vi.fn()}
      projectName={projectName}
    />,
  );
}

describe("AppTopBar project name", () => {
  it("fits a name by its mono character count", () => {
    expect(projectNameFits("x".repeat(22))).toBe(true);
    expect(projectNameFits("x".repeat(23))).toBe(false);
  });

  it("renders a name that fits whole", () => {
    renderBar("octopush");
    const name = screen.getByTitle("Project · octopush");
    expect(name).toHaveTextContent("octopush");
    expect(name).toHaveClass("truncate");
    expect(name.querySelector(".octo-midtrunc")).toBeNull();
  });

  it("middle-truncates a long name so its distinguishing tail survives (E1)", () => {
    const long = "octopush-enterprise-monorepo";
    renderBar(long);
    const name = screen.getByTitle(`Project · ${long}`);
    // A definite width for the MidTruncate box, never end-truncation.
    expect(name).toHaveClass("flex", "w-[180px]", "min-w-0");
    expect(name).not.toHaveClass("truncate");
    expect(name.querySelector(".octo-midtrunc-tail")).toHaveTextContent("ise-monorepo");
    expect(name).toHaveTextContent(long);
  });
});
